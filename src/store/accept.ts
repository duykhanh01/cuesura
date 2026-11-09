import type { Database } from 'better-sqlite3';
import { canonicalJson } from '../shared/canonical-json.ts';
import { err, ok, type Result } from '../shared/result.ts';
import { EVENT_SCHEMA_VERSION, type DomainEvent, type DomainEventDraft } from '../domain/event.ts';
import type { TaskState, TaskStatus } from '../domain/state.ts';
import type { CanonicalTask } from '../domain/task.ts';
import {
  computeRequestHash,
  HUMAN_TRIGGERS,
  TriggerEnvelopeSchema,
  type RelatedFacts,
  type TriggerEnvelope,
} from '../domain/trigger.ts';
import { decide, type Decision } from '../engine/decide.ts';
import { applyInPlace } from '../engine/evolve.ts';
import { materialDigest } from '../engine/material.ts';
import { sameContent } from '../engine/revision.ts';
import type { CrashHook } from './crash.ts';
import {
  IdCollision,
  projectEffects,
  projectRuntime,
  projectTask,
  projectTimers,
  SlotConflict,
  sqliteSink,
} from './projector.ts';
import {
  loanActive,
  readExecutionFacts,
  readPolicy,
  readStateAt,
  readTask,
  readTaskStatus,
} from './read.ts';

export type AcceptOutcome = {
  dedup_key: string;
  /** true returns the original accepted result for an idempotent replay. */
  duplicate: boolean;
  decision: Decision;
  task_version: number | null;
  global_seq_range: [number, number] | null;
};

export type WriteFailure = {
  code: 'write_failed';
  cause: 'disk_full' | 'busy' | 'io_error';
};

export type AcceptError =
  | {
      code: 'conflict';
      reason: 'request_hash_mismatch' | 'stale_version' | 'id_collision' | 'slot_held';
    }
  | WriteFailure;

/** Map SQLite write failures to write_failed; rethrow programming errors. */
export function writeFailure(e: unknown): WriteFailure | null {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return null;
  if (code === 'SQLITE_FULL') return { code: 'write_failed', cause: 'disk_full' };
  if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
    return { code: 'write_failed', cause: 'busy' };
  if (code.startsWith('SQLITE_IOERR') || code === 'SQLITE_CANTOPEN' || code === 'SQLITE_READONLY')
    return { code: 'write_failed', cause: 'io_error' };
  return null;
}

export function rollback(db: Database): void {
  if (db.inTransaction) db.exec('ROLLBACK');
}

/**
 * Assign per-task seq and global_seq in commit order, evolving each event before projecting the
 * final state.
 */
export function appendEvents(
  db: Database,
  taskId: string,
  state: TaskState | null,
  drafts: readonly DomainEventDraft[],
  causation: { dedup_key: string | null; claim?: string },
): { state: TaskState | null; events: DomainEvent[] } {
  const ins = db.prepare(
    `INSERT INTO events (task_id, seq, type, revision, schema_version, actor, dedup_key, claim, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let s = state === null ? null : structuredClone(state);
  const events: DomainEvent[] = [];
  for (const d of drafts) {
    const seq = (s?.version ?? 0) + 1;
    const payloadJson = canonicalJson(d.payload);
    const r = ins.run(
      taskId,
      seq,
      d.type,
      d.revision,
      EVENT_SCHEMA_VERSION,
      d.actor,
      causation.dedup_key,
      causation.claim ?? null,
      payloadJson,
    );
    const ev = {
      ...d,
      payload: JSON.parse(payloadJson) as unknown,
      schema_version: EVENT_SCHEMA_VERSION,
      task_id: taskId,
      seq,
      global_seq: Number(r.lastInsertRowid),
      causation: causation.claim === undefined ? { dedup_key: causation.dedup_key } : causation,
    } as DomainEvent;
    events.push(ev);
    s = applyInPlace(s, structuredClone(ev));
  }
  return { state: s, events };
}

export function project(
  db: Database,
  events: readonly DomainEvent[],
  state: TaskState | null,
  crash: CrashHook,
): void {
  const sink = sqliteSink(db);
  if (state !== null && events.length > 0) projectTask(sink, events, state);
  crash('after_projection');
  if (state !== null && events.length > 0) projectEffects(sink, events, state);
  crash('after_effects');
  if (state !== null && events.length > 0) projectTimers(sink, events, state);
  crash('after_timers');
  projectRuntime(sink, events);
  crash('after_runtime');
}

/** Read related task facts inside the same transaction as decide. */
export function relatedFacts(
  db: Database,
  env: TriggerEnvelope,
  state: TaskState | null,
): RelatedFacts {
  const t = env.trigger;
  const incoming: CanonicalTask | null =
    t.kind === 'create_task' || t.kind === 'source_updated' ? t.task : null;
  const candidates = new Set<string>([
    ...(incoming?.depends_on ?? []),
    ...(state?.task.depends_on ?? []),
    ...(state?.source_drift?.task.depends_on ?? []),
  ]);
  const deps: Record<string, TaskStatus | 'missing'> = {};
  for (const d of [...candidates].sort()) deps[d] = readTaskStatus(db, d);

  const proposed =
    incoming?.depends_on ??
    (t.kind === 'drift_choice' ? state?.source_drift?.task.depends_on : undefined);
  const related: RelatedFacts = {
    deps,
    dependency_cycle: proposed !== undefined && reachesTask(db, env.task_id, proposed),
  };

  if (t.kind === 'grant_execution')
    related.execution = readExecutionFacts(
      db,
      t.started_only === true,
      t.lender_task_id,
      new Set(t.passed_over ?? []),
    );
  if (state?.execution.holding?.lender_task_id !== undefined)
    related.loan = { active: loanActive(db, env.task_id) };

  if (t.kind === 'adopt_pr') {
    const rows = db
      .prepare(
        `SELECT id FROM tasks
         WHERE lower(json_extract(state_json, '$.pr_ref')) = lower(?)
           AND status NOT IN ('DONE', 'FAILED', 'CANCELLED') AND id <> ?`,
      )
      .all(t.pr_ref, env.task_id) as { id: string }[];
    related.pr_holders = rows.map((r) => r.id);
  }

  const retryOf = incoming?.retry_of ?? null;
  if (t.kind === 'create_task' && retryOf !== null) related.retry_of = readTaskStatus(db, retryOf);

  if (t.kind === 'create_task') {
    const row = db
      .prepare('SELECT state_json FROM tasks WHERE project = ? AND source_key = ?')
      .get(t.task.project, t.task.source_key) as { state_json: string } | undefined;
    if (row !== undefined) {
      const other = JSON.parse(row.state_json) as TaskState;
      related.source_task = {
        task_id: other.id,
        same_content: sameContent(t.task, other.task),
      };
    }
  }
  return related;
}

function reachesTask(db: Database, target: string, from: readonly string[]): boolean {
  const next = db.prepare('SELECT depends_on FROM task_deps WHERE task_id = ?');
  const seen = new Set<string>();
  const stack = [...from];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const r of next.all(id) as { depends_on: string }[]) stack.push(r.depends_on);
  }
  return false;
}

/**
 * A person's command decided on version E still holds when nothing material changed after E
 * (issue #262): events that only move background work forward (CI polls, timers, observations,
 * ignored signals) do not make it stale. Daemon triggers decide on effects and timers too, so they
 * keep the exact match.
 */
function versionHolds(db: Database, env: TriggerEnvelope, state: TaskState | null): boolean {
  const expected = env.expected_version ?? 0;
  const current = state?.version ?? 0;
  if (expected === current) return true;
  if (state === null || expected === 0 || expected > current) return false;
  if (!HUMAN_TRIGGERS.includes(env.trigger.kind)) return false;
  const then = readStateAt(db, env.task_id, expected);
  return then !== null && materialDigest(then) === materialDigest(state);
}

/**
 * One synchronous BEGIN IMMEDIATE transaction: deduplicate, read, decide, append, project, commit.
 * Write failures roll back everything. Colliding IDs conflict; missing IDs must not record
 * deduplication.
 */
export function accept(
  db: Database,
  input: TriggerEnvelope,
  crash: CrashHook,
): Result<AcceptOutcome, AcceptError> {
  const parsed = TriggerEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    // Malformed envelopes have no trusted deduplication identity; write nothing.
    const key = (input as { dedup_key?: unknown } | null)?.dedup_key;
    return ok({
      dedup_key: typeof key === 'string' ? key : '',
      duplicate: false,
      decision: {
        kind: 'rejected',
        code: 'invalid_trigger',
        detail: {
          reason: 'envelope_schema',
          issues: parsed.error.issues.map((i) => ({
            path: i.path.map(String),
            message: i.message,
          })),
        },
      },
      task_version: null,
      global_seq_range: null,
    });
  }
  const env = parsed.data;
  const requestHash = computeRequestHash(env);

  let outcome: AcceptOutcome;
  try {
    db.exec('BEGIN IMMEDIATE');

    const prior = db
      .prepare('SELECT request_hash, outcome_json FROM accepted_triggers WHERE dedup_key = ?')
      .get(env.dedup_key) as { request_hash: string; outcome_json: string } | undefined;
    if (prior !== undefined) {
      rollback(db);
      if (prior.request_hash !== requestHash)
        return err({ code: 'conflict', reason: 'request_hash_mismatch' });
      return ok({
        ...(JSON.parse(prior.outcome_json) as AcceptOutcome),
        duplicate: true,
      });
    }
    crash('after_dedup');

    const state = readTask(db, env.task_id);
    if (env.expected_version !== undefined && !versionHolds(db, env, state)) {
      rollback(db);
      return err({ code: 'conflict', reason: 'stale_version' });
    }

    let decision: Decision;
    if (env.request_hash !== requestHash) {
      decision = {
        kind: 'rejected',
        code: 'invalid_trigger',
        detail: { reason: 'request_hash' },
      };
    } else {
      const ref = state?.policy_ref ?? null;
      const policy = ref === null ? null : readPolicy(db, env.task_id, ref.revision, ref.version);
      decision = decide({
        state,
        policy,
        envelope: env,
        related: relatedFacts(db, env, state),
      });
    }

    // ids is outside request_hash. Do not record deduplication on exhaustion so the same request can retry with enough IDs.

    if (decision.kind === 'rejected' && decision.code === 'id_pool_exhausted') {
      rollback(db);
      return ok({
        dedup_key: env.dedup_key,
        duplicate: false,
        decision,
        task_version: state?.version ?? null,
        global_seq_range: null,
      });
    }

    const drafts = decision.kind === 'accepted' ? decision.events : [];
    const { state: next, events } = appendEvents(db, env.task_id, state, drafts, {
      dedup_key: env.dedup_key,
    });
    crash('after_events');
    project(db, events, next, crash);

    const first = events[0];
    const last = events.at(-1);
    outcome = {
      dedup_key: env.dedup_key,
      duplicate: false,
      decision,
      task_version: next?.version ?? null,
      global_seq_range:
        first !== undefined && last !== undefined ? [first.global_seq, last.global_seq] : null,
    };
    db.prepare(
      `INSERT INTO accepted_triggers (dedup_key, request_hash, task_id, envelope_json, outcome_json, global_seq_from, global_seq_to)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      env.dedup_key,
      requestHash,
      env.task_id,
      canonicalJson(env),
      canonicalJson(outcome),
      first?.global_seq ?? null,
      last?.global_seq ?? null,
    );
    crash('before_commit');
    db.exec('COMMIT');
  } catch (e) {
    rollback(db);
    if (e instanceof IdCollision) return err({ code: 'conflict', reason: 'id_collision' });
    if (e instanceof SlotConflict) return err({ code: 'conflict', reason: 'slot_held' });
    const wf = writeFailure(e);
    if (wf !== null) return err(wf);
    throw e;
  }
  crash('after_commit');
  return ok(outcome);
}
