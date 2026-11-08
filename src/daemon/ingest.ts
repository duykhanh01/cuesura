/**
 * Turning a handler's outcome into facts (T047, FR-006/010/014/026). Every handled effect yields, in
 * order, the receipt of its operation and the effect's own result; both are plain trigger envelopes
 * accepted through the store, which re-checks task version, completion and claims in its transaction.
 * Adapters only report outcomes here; nothing chooses a task status. Runner spools are ingested from the
 * committed cursor and acknowledged only after that commit (T087).
 */
import type { EffectStatus } from '../domain/effect.ts';
import type { Artifact, OperationOutcome, OperationStatus } from '../domain/runtime.ts';
import { TASK_STATUSES, type TaskState } from '../domain/state.ts';
import type { Usage } from '../domain/trigger.ts';
import { collectArtifacts } from '../runner/artifacts.ts';
import {
  ackThrough,
  readRecords,
  RUN_FILES,
  RunDir,
  RunnerFileError,
  type FileLimits,
  type IngestPosition,
} from '../runner/files.ts';
import { RunnerExitSchema } from '../runner/lifecycle.ts';
import { readLaunchMarker } from '../runner/operation-lock.ts';
import type { Redactor } from '../runner/redact.ts';
import type { Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import { runLocation } from './retention.ts';
import {
  computeRequestHash,
  MAX_ENVELOPE_IDS,
  TRIGGER_SCHEMA_VERSION,
  type Trigger,
  type TriggerEnvelope,
} from '../domain/trigger.ts';
import type { OperationClaim } from '../engine/runtime.ts';
import type { Effect } from '../domain/effect.ts';
import type { Uuid } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';

type IngestTrigger = Extract<Trigger, { kind: 'ingest_record' }>;

export type EffectOutcome =
  | { readonly outcome: 'succeeded'; readonly data: unknown }
  | {
      readonly outcome: 'failed';
      readonly data: {
        readonly failure_class: string;
        readonly message?: string;
        readonly signature?: string;
        /** Agent effects: false only when the harness provably never ran. */
        readonly invoked?: boolean;
        readonly usage?: Usage;
        readonly reset_at?: number;
        readonly session_ref?: string | null;
        /** Worker effects (T072): the tree the attempt left, or the change found before it. */
        readonly worktree_tree?: string;
        readonly worktree?: {
          readonly known: string;
          readonly observed: string;
        };
        /** The harness manifest in force differs from the task's; nothing was invoked. */
        readonly manifest?: {
          readonly harness: string;
          readonly known: string;
          readonly observed: string;
          /** The new manifest still meets what the task froze for (#249). */
          readonly compatible?: boolean;
        };
        /** The harness ran and its login was refused or expired. */
        readonly auth?: { readonly harness: string };
      };
    }
  | { readonly outcome: 'unknown'; readonly detail: string };

export type IngestContext = {
  readonly now: number;
  readonly started_at: number;
  readonly newId: () => string;
};

/** A fact for one task with a full pool of fresh IDs; the dedup key makes a repeat a duplicate. */
export function factEnvelope(
  taskId: string,
  dedupKey: string,
  trigger: Trigger,
  ctx: IngestContext,
): TriggerEnvelope {
  return {
    schema_version: TRIGGER_SCHEMA_VERSION,
    task_id: taskId as Uuid,
    dedup_key: dedupKey,
    request_hash: computeRequestHash({ task_id: taskId, trigger }),
    trigger,
    now: ctx.now as TriggerEnvelope['now'],
    ids: Array.from({ length: MAX_ENVELOPE_IDS }, () => ctx.newId() as Uuid),
  };
}

const OPERATION_OUTCOME: Record<'succeeded' | 'failed', OperationOutcome> = {
  succeeded: 'succeeded',
  failed: 'failed',
};

export type SpoolIngestDeps = {
  readonly store: Store;
  readonly dataDir: string;
  readonly redactor: Redactor;
  readonly limits?: FileLimits;
  readonly now: () => number;
  readonly newId: () => string;
  /** Records per `ingest_record`; one batch is one store transaction. */
  readonly batchRecords?: number;
  /** Live output is read from the spool by task_logs; only finalized runs enter the domain log. */
  readonly finalOnly?: boolean;
  /** In-memory validation position; never enters task.version or the event log. */
  readonly probeCursors?: Map<string, IngestPosition>;
};

export type SpoolIngestStatus =
  | 'up_to_date'
  | 'ingested'
  | 'no_run_dir'
  | 'unreadable'
  | 'write_failed'
  | 'rejected';

export type SpoolIngestReport = {
  readonly task_id: string;
  readonly operation_id: string;
  readonly status: SpoolIngestStatus;
  /** Records committed by this pass. */
  readonly records: number;
  /**
   * Partial tails left behind by a writer that died mid-record: in sealed segments, and in the last one
   * once exit.json is final.
   */
  readonly torn: number;
  /** Spool segments deleted after the committed cursor moved past them. */
  readonly acked: readonly string[];
  readonly detail?: string;
};

export const DEFAULT_INGEST_BATCH = 1_000;
const MAX_TRIGGER_ARTIFACTS = 16;

class SpoolReadError extends Error {}
function spoolIoError(e: unknown): boolean {
  return (
    e instanceof RunnerFileError ||
    /^E[A-Z0-9_]+$/.test(String((e as NodeJS.ErrnoException | null)?.code ?? ''))
  );
}
function readSpool<T>(read: () => T): T {
  try {
    return read();
  } catch (e) {
    if (!spoolIoError(e)) throw e;
    throw new SpoolReadError(e instanceof Error ? e.message : String(e));
  }
}

/** Effects whose result is final: nothing re-reads their run from the first record any more. */
const RESOLVED_EFFECTS: readonly EffectStatus[] = ['succeeded', 'failed', 'invalidated'];
const RESOLVED_OPERATIONS: readonly OperationStatus[] = ['finished', 'not_launched', 'lost'];

/**
 * Ingests what one operation's runner wrote past the committed cursor (FR-031, FR-036). Each batch of
 * complete records is one `ingest_record`: the event and the cursor commit in the same transaction, so a
 * crash keeps both or neither and the next pass re-reads from the committed cursor. Artifacts are
 * attached only once exit.json is final, since a live segment's digest still changes.
 *
 * ACK (deleting sealed segments behind the committed cursor) happens only after that commit and only
 * once the operation and its effect are resolved: until then a recovering harness may still re-read the
 * run from its first record.
 */
export function ingestOperationSpool(
  deps: SpoolIngestDeps,
  taskId: string,
  operationId: string,
): SpoolIngestReport {
  try {
    return ingestSpool(deps, taskId, operationId);
  } catch (e) {
    if (!(e instanceof SpoolReadError)) throw e;
    deps.probeCursors?.delete(operationId);
    return {
      task_id: taskId,
      operation_id: operationId,
      status: 'unreadable',
      records: 0,
      torn: 0,
      acked: [],
      detail: deps.redactor.text(e instanceof Error ? e.message : String(e)),
    };
  }
}

function ingestSpool(
  deps: SpoolIngestDeps,
  taskId: string,
  operationId: string,
): SpoolIngestReport {
  const base = { task_id: taskId, operation_id: operationId };
  const state = deps.store.readTask(taskId as Uuid);
  const op = state?.operations[operationId];
  if (state === null || op === undefined)
    return {
      ...base,
      status: 'rejected',
      records: 0,
      torn: 0,
      acked: [],
      detail: 'unknown operation',
    };
  let run: RunDir;
  let marker: ReturnType<typeof readLaunchMarker>;
  try {
    run = RunDir.open({
      dataDir: deps.dataDir,
      ...runLocation(op),
      redactor: deps.redactor,
      ...(deps.limits === undefined ? {} : { limits: deps.limits }),
      create: false,
    });
    marker = readLaunchMarker(run);
  } catch (e) {
    if (!spoolIoError(e)) throw e;
    return {
      ...base,
      status: e instanceof RunnerFileError && e.code === 'not_found' ? 'no_run_dir' : 'unreadable',
      records: 0,
      torn: 0,
      acked: [],
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  // Effects such as stop_attempt carry the attempt of the agent they act on, without launching a run of
  // their own. The directory's records are the launching operation's, not corrupt ones of this operation.
  if (marker.state === 'valid' && marker.value.operation_id !== op.id)
    return {
      ...base,
      status: 'no_run_dir',
      records: 0,
      torn: 0,
      acked: [],
      detail: `the run belongs to operation ${marker.value.operation_id}`,
    };

  let cursor: IngestPosition | null =
    op.cursor === null ? null : { operation_id: op.id, ...op.cursor };
  let status: SpoolIngestStatus = 'up_to_date';
  let records = 0;
  const torn = new Set<string>();
  let detail: string | undefined;
  // Once exit.json is final no writer will complete a partial last record: it is torn, not pending.
  const final =
    readSpool(() => run.readFinal(RUN_FILES.exit, RunnerExitSchema)).state === 'valid' ||
    RESOLVED_OPERATIONS.includes(op.status);
  if (deps.finalOnly && !final) {
    let checked = deps.probeCursors?.get(op.id) ?? cursor;
    for (;;) {
      const probe = readSpool(() =>
        readRecords(run, op.id, checked, {
          maxRecords: deps.batchRecords ?? DEFAULT_INGEST_BATCH,
        }),
      );
      if (!probe.ok) {
        deps.probeCursors?.delete(op.id);
        return {
          ...base,
          status: 'unreadable',
          records: 0,
          torn: 0,
          acked: [],
          detail: JSON.stringify(probe.error),
        };
      }
      if (probe.value.cursor !== null) {
        checked = probe.value.cursor;
        deps.probeCursors?.set(op.id, checked);
      }
      if (probe.value.records.length === 0) break;
    }
    return { ...base, status: 'up_to_date', records: 0, torn: 0, acked: [] };
  }
  deps.probeCursors?.delete(op.id);
  let artifacts = readSpool(() => pendingArtifacts(run, state, op.id));
  /** Accepts one `ingest_record`; false (with status and detail set) when the store did not take it. */
  const submit = (trigger: IngestTrigger, key: string): boolean => {
    const accepted = deps.store.accept(
      factEnvelope(taskId, key, trigger, {
        now: deps.now(),
        started_at: deps.now(),
        newId: deps.newId,
      }),
    );
    if (!accepted.ok) {
      status = accepted.error.code === 'write_failed' ? 'write_failed' : 'rejected';
      detail = JSON.stringify(accepted.error);
      return false;
    }
    if (accepted.value.decision.kind !== 'accepted') {
      status = 'rejected';
      detail = JSON.stringify(accepted.value.decision);
      return false;
    }
    return true;
  };
  let failed = false;
  for (;;) {
    const batch = readSpool(() =>
      readRecords(run, op.id, cursor, {
        maxRecords: deps.batchRecords ?? DEFAULT_INGEST_BATCH,
        final,
      }),
    );
    if (!batch.ok) {
      status = 'unreadable';
      detail = JSON.stringify(batch.error);
      failed = true;
      break;
    }
    for (const t of batch.value.torn) torn.add(`${t.generation}.${t.segment}.${t.byte_offset}`);
    const next = batch.value.cursor;
    if (batch.value.records.length === 0 || next === null) break;
    const pos = positionOf(next);
    if (
      !submit(
        {
          kind: 'ingest_record',
          operation_id: op.id as Uuid,
          cursor: pos,
          records: batch.value.records.length,
          digest: hashCanonical(batch.value.records),
          artifacts: artifacts.slice(0, MAX_TRIGGER_ARTIFACTS),
        },
        `op:${op.id}:ingest:${pos.generation}.${pos.segment}.${pos.byte_offset}`,
      )
    ) {
      failed = true;
      break;
    }
    records += batch.value.records.length;
    status = 'ingested';
    artifacts = artifacts.slice(MAX_TRIGGER_ARTIFACTS);
    cursor = next;
  }

  // Final artifacts left once the records are in (the log was ingested while the runner still ran, more
  // than one trigger holds, or the run never wrote a record) go in at the committed cursor, or with none,
  // before anything is acknowledged.
  while (!failed && artifacts.length > 0) {
    const chunk = artifacts.slice(0, MAX_TRIGGER_ARTIFACTS);
    if (
      !submit(
        {
          kind: 'ingest_record',
          operation_id: op.id as Uuid,
          cursor: cursor === null ? null : positionOf(cursor),
          records: 0,
          digest: hashCanonical([]),
          artifacts: chunk,
        },
        `op:${op.id}:artifacts:${hashCanonical(chunk.map((a) => [a.artifact_id, a.digest]))}`,
      )
    ) {
      failed = true;
      break;
    }
    if (status === 'up_to_date') status = 'ingested';
    artifacts = artifacts.slice(MAX_TRIGGER_ARTIFACTS);
  }

  // Nothing is deleted while a final file the store has not committed is still on disk.
  const fresh = deps.store.readTask(taskId as Uuid);
  const unacked =
    failed || fresh === null ? null : readSpool(() => pendingArtifacts(run, fresh, op.id));
  const acked: Result<string[], string> =
    unacked === null || unacked.length > 0
      ? { ok: true, value: [] }
      : ackResolved(deps, run, taskId, op.id);
  if (!acked.ok) {
    status = 'unreadable';
    detail = acked.error;
  } else if (!failed && unacked !== null && unacked.length > 0) {
    detail = `${unacked.length} final artifacts not committed; not acknowledged`;
  }
  return {
    ...base,
    status,
    records,
    torn: torn.size,
    acked: acked.ok ? acked.value : [],
    ...(detail === undefined ? {} : { detail }),
  };
}

function positionOf(c: IngestPosition): NonNullable<IngestTrigger['cursor']> {
  return {
    generation: c.generation,
    segment: c.segment,
    byte_offset: c.byte_offset,
    last_record_seq: c.last_record_seq,
  };
}

/** Final artifacts the store has not committed with exactly this digest yet. */
function pendingArtifacts(run: RunDir, state: TaskState, operationId: string): Artifact[] {
  if (run.readFinal(RUN_FILES.exit, RunnerExitSchema).state !== 'valid') return [];
  const arts = collectArtifacts(run, operationId);
  if (!arts.ok) return [];
  return arts.value.filter((a) => state.artifacts[a.artifact_id]?.digest !== a.digest);
}

/** ACK from the cursor as committed in the store, never from what this pass merely read. */
function ackResolved(
  deps: SpoolIngestDeps,
  run: RunDir,
  taskId: string,
  operationId: string,
): Result<string[], string> {
  const s = deps.store.readTask(taskId as Uuid);
  const op = s?.operations[operationId];
  if (s === null || op === undefined || op.cursor === null) return { ok: true, value: [] };
  const effect = s.effects[op.effect_id];
  if (
    !RESOLVED_OPERATIONS.includes(op.status) ||
    effect === undefined ||
    !RESOLVED_EFFECTS.includes(effect.status)
  )
    return { ok: true, value: [] };
  try {
    const r = ackThrough(run, op.id, { operation_id: op.id, ...op.cursor });
    return r.ok ? r : { ok: false, error: JSON.stringify(r.error) };
  } catch (e) {
    if (!spoolIoError(e)) throw e;
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** One ingest pass over every operation of every task (startup, before anything is scheduled). */
export function ingestAllSpools(deps: SpoolIngestDeps): SpoolIngestReport[] {
  const out: SpoolIngestReport[] = [];
  for (const id of deps.store.taskIdsByStatus(TASK_STATUSES)) {
    const s = deps.store.readTask(id as Uuid);
    if (s === null) continue;
    for (const op of Object.values(s.operations)) {
      const r = ingestOperationSpool(deps, id, op.id);
      out.push(r);
      // The store stopped accepting writes: later operations would fail the same way.
      if (r.status === 'write_failed') return out;
    }
  }
  return out;
}

/** Operation receipt then effect result; extra facts (observation, completion) go between them. */
export function resultEnvelopes(
  effect: Effect,
  op: OperationClaim,
  attemptId: string | null,
  r: EffectOutcome,
  ctx: IngestContext,
  extra: readonly Trigger[] = [],
): TriggerEnvelope[] {
  const receipt: Trigger =
    r.outcome === 'unknown'
      ? {
          kind: 'operation_result',
          operation_id: op.operation_id as Uuid,
          status: 'unknown',
          outcome: null,
          invocation_id: null,
          processes: [],
          started_at: ctx.started_at as never,
          finished_at: null,
          receipt_digest: hashCanonical({
            effect: effect.id,
            outcome: 'unknown',
            detail: r.detail,
          }),
        }
      : {
          kind: 'operation_result',
          operation_id: op.operation_id as Uuid,
          status: 'finished',
          outcome: OPERATION_OUTCOME[r.outcome],
          invocation_id: null,
          processes: [],
          started_at: ctx.started_at as never,
          finished_at: ctx.now as never,
          receipt_digest: hashCanonical({
            effect: effect.id,
            outcome: r.outcome,
            data: r.data,
          }),
        };
  const result: Trigger = {
    kind: 'effect_result',
    effect_id: effect.id as Uuid,
    ...(attemptId === null ? {} : { attempt_id: attemptId as Uuid }),
    outcome: r.outcome,
    ...(r.outcome === 'unknown' ? {} : { data: r.data }),
  };
  return [
    factEnvelope(effect.task_id, `op:${op.operation_id}:receipt`, receipt, ctx),
    ...extra.map((t, i) => factEnvelope(effect.task_id, `op:${op.operation_id}:fact:${i}`, t, ctx)),
    factEnvelope(effect.task_id, `effect:${effect.id}:result`, result, ctx),
  ];
}
