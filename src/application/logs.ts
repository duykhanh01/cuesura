/**
 * `task logs` (T114, FR-027.01/028/031). OutputIngested events authenticate the committed prefix; the
 * active worker's durable, redacted spool extends it without a domain write or version change. Final
 * ingestion keeps the same order. Rotation and restart do not change cursors, so a follower resumes with no
 * record repeated or lost. A batch whose files are gone (retention) or no longer match their digest is
 * reported as a gap of that size, never skipped silently. The runs of the task's deputy turns, recorded
 * outside the event log, are read from their spools and placed among the operations' output by when they
 * were recorded (`deputy_turn_runs`).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  DEPUTY_HOLDS,
  DEPUTY_RETRY,
  DEPUTY_SKIPS,
  DEPUTY_STEP,
  DEPUTY_WAITS,
} from '../domain/deputy.ts';
import type { TaskState } from '../domain/state.ts';
import {
  listSegments,
  readAllRecords,
  readRecords,
  recordFilesStamp,
  RunDir,
  RunnerFileError,
  type IngestPosition,
  type LogRecord,
  type ReadBatch,
  type ReadError,
} from '../runner/files.ts';
import { attemptModelIds } from './attempt-models.ts';
import { DEFAULT_INGEST_BATCH } from '../daemon/ingest.ts';
import { runLocation, TOMBSTONE_FILE } from '../daemon/retention.ts';
import { readLaunchMarker } from '../runner/operation-lock.ts';
import type { Redactor } from '../runner/redact.ts';
import { UuidSchema, type Uuid } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { DeputyTurn } from '../domain/deputy.ts';
import type { DeputyRun, RunCount } from '../store/deputy.ts';
import type { Store } from '../store/index.ts';
import { authorize, type Caller } from './authz.ts';
import type { AppError } from './queries.ts';
import { needsUser } from '../explain/needs-user.ts';
import type { StatusSince } from './board.ts';

export const LOG_PAGE_RECORDS = 200;
const LOG_PAGE_BYTES = 1024 * 1024;

export type LogsDeps = {
  readonly store: Store;
  readonly dataDir: string;
  readonly redactor: Redactor;
  /** Kept by the daemon across reads; without it every read parses each run's files whole. */
  readonly cache?: LogRecordCache;
  readonly now?: () => number;
  /** A question the decider may still answer itself is not the user's yet (`DeputyWatch.holds`). */
  readonly holds?: (s: TaskState) => boolean;
  /** When the task entered its status, for a wait recorded without its own start (`needsUser`). */
  readonly statusSince?: StatusSince;
};

/** Where the task stands, so a follower can stop when going on depends on the user (#257). */
export type LogsTaskState = {
  readonly status: TaskState['status'];
  readonly wait_code: string | null;
  readonly needs_user: boolean;
};

function taskStateOf(deps: LogsDeps, s: TaskState): LogsTaskState {
  const since = deps.statusSince;
  const needs =
    needsUser(s, deps.now?.(), since === undefined ? undefined : () => since(s)) &&
    deps.holds?.(s) !== true;
  return {
    status: s.status,
    wait_code: s.wait?.detail.code ?? (needs ? 'run_config_unconfirmed' : null),
    needs_user: needs,
  };
}

type Cached =
  | { readonly kind: 'all'; readonly stamp: string; readonly records: LogRecord[] }
  | {
      readonly kind: 'live';
      readonly first: string;
      readonly records: LogRecord[];
      readonly cursor: IngestPosition;
    };

/**
 * Records already parsed, by operation, so a follower polling once a second reads only what was appended
 * since, not the whole run each time. Bounded: the least recently read operations leave first.
 */
export class LogRecordCache {
  readonly #entries = new Map<string, Cached>();
  readonly #max: number;

  constructor(max = 16) {
    this.#max = max;
  }

  get(id: string): Cached | undefined {
    const hit = this.#entries.get(id);
    if (hit !== undefined) {
      this.#entries.delete(id);
      this.#entries.set(id, hit);
    }
    return hit;
  }

  set(id: string, value: Cached): void {
    this.#entries.delete(id);
    this.#entries.set(id, value);
    for (const key of this.#entries.keys()) {
      if (this.#entries.size <= this.#max) break;
      this.#entries.delete(key);
    }
  }
}

const LogsQuerySchema = z
  .object({
    kind: z.literal('task_logs'),
    task_id: UuidSchema,
    after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(LOG_PAGE_RECORDS).default(LOG_PAGE_RECORDS),
    attempt_id: UuidSchema.optional(),
    /** The last page instead of the one after `after`; the answer says where it started. */
    tail: z.boolean().default(false),
  })
  .strict();

/**
 * What ran a record's attempt, as persisted: the configured model ID (null when it was not kept, never guessed
 * from the alias), the alias binding of a worker attempt (`sonnet/medium`), the effort of a deputy run.
 */
export type LogModel = {
  readonly id: string | null;
  readonly binding: string | null;
  readonly effort: string | null;
};

export type LogEntry =
  | {
      readonly seq: number;
      readonly cursor: number;
      readonly operation_id: string;
      readonly attempt_id: string | null;
      readonly step: string | null;
      readonly model: LogModel | null;
      readonly at: string;
      readonly kind: string;
      readonly data: unknown;
    }
  | {
      readonly seq: number;
      readonly cursor: number;
      readonly operation_id: string;
      readonly attempt_id: string | null;
      readonly gap: { readonly records: number; readonly reason: string };
    };

type SpoolDeps = Pick<LogsDeps, 'dataDir' | 'redactor' | 'cache'>;

function openRecords(
  deps: SpoolDeps,
  op: { readonly id: string; readonly attempt_id: string | null },
): LogRecord[] | string {
  try {
    const run = RunDir.open({
      dataDir: deps.dataDir,
      ...runLocation(op),
      redactor: deps.redactor,
      create: false,
    });
    if (deps.cache === undefined) return readAllRecords(run);
    const stamp = recordFilesStamp(run);
    const hit = deps.cache.get(op.id);
    if (hit?.kind === 'all' && hit.stamp === stamp) return hit.records;
    const records = readAllRecords(run);
    deps.cache.set(op.id, { kind: 'all', stamp, records });
    return records;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * The live spool from its oldest segment, as `readRecords(run, id, null)` reads it. With a cache, only what
 * was appended after the last read is parsed; a spool whose oldest segment moved on is read whole again.
 */
function liveRecords(
  deps: LogsDeps,
  run: RunDir,
  id: string,
): Result<
  { readonly records: readonly LogRecord[]; readonly cursor: IngestPosition | null },
  ReadError
> {
  const cache = deps.cache;
  if (cache === undefined) return readRecords(run, id, null);
  const first = listSegments(run)[0]?.name ?? '';
  const hit = cache.get(id);
  let read: Result<ReadBatch, ReadError> | null = null;
  let records: LogRecord[] = [];
  if (hit?.kind === 'live' && hit.first === first) {
    const more = readRecords(run, id, hit.cursor);
    if (more.ok) {
      read = more;
      records =
        more.value.records.length === 0 ? hit.records : [...hit.records, ...more.value.records];
    }
  }
  if (read === null) {
    read = readRecords(run, id, null);
    if (!read.ok) return read;
    records = [...read.value.records];
  }
  const cursor = read.value.cursor;
  if (cursor !== null) cache.set(id, { kind: 'live', first, records, cursor });
  return ok({ records, cursor });
}

export { DEPUTY_STEP, DEPUTY_WAITS };

const LIVE_STATUSES: readonly string[] = ['registered', 'running', 'unknown'];

/** One stretch of the task's log: an ingest of an operation, a worker's live tail, or a deputy run. */
type Batch = {
  /** What `load` reads: an operation's id, or a deputy run's attempt. */
  readonly key: string;
  readonly operation_id: string;
  readonly attempt_id: string | null;
  readonly step: string | null;
  readonly model: LogModel | null;
  readonly records: number;
  /** Null for a deputy run, whose records no event commits. */
  readonly digest: string | null;
  /** A zero-record notice in place of records: output that will never be read. */
  readonly notice?: string;
  /** Records handed out from this batch raise the operation's published count, from `base` on. */
  readonly handsOp?: { readonly op: string; readonly base: number };
  /** Records handed out from this batch raise the unconfirmed deputy run's published count. */
  readonly handsRun?: DeputyRun;
  /** A zero-record mark: once a position past it is handed out, the operation keeps `count` places. */
  readonly seal?: { readonly op: string; readonly count: number };
};

type Placed = {
  readonly batch: Batch;
  readonly operation_id: string;
  /** The `OutputIngested` event of a committed batch; none for a live tail. */
  readonly seq?: number;
};

type Diagnostic = {
  readonly operation_id: string;
  readonly attempt_id: string | null;
  readonly reason: string;
};

const at = (op: TaskState['operations'][string], reason: string): Diagnostic => ({
  operation_id: op.id,
  attempt_id: op.attempt_id,
  reason,
});

function operationBatch(
  s: TaskState,
  models: ReadonlyMap<string, string>,
  id: string,
  records: number,
  digest: string,
): Batch {
  const attemptId = s.operations[id]?.attempt_id ?? null;
  const attempt = attemptId === null ? undefined : s.attempts[attemptId];
  return {
    key: id,
    operation_id: id,
    attempt_id: attemptId,
    step: attempt?.step ?? null,
    model:
      attempt === undefined
        ? null
        : { id: models.get(attempt.id) ?? null, binding: attempt.binding, effort: null },
    records,
    digest,
  };
}

/**
 * Why an operation may still add committed records. `pending`: its ingestion is still to come. `retry`: its
 * spool cannot be read now, and the daemon tries it again (an `unreadable` ingest), so more may come once it
 * can. `gone`: its run directory is gone, which the ingester never retries (`no_run_dir`): nothing more comes.
 * `broken`: its ended spool holds a record that does not parse as one of its own; the ingester reads the same
 * batch from the same cursor and fails the same way every time, so nothing more is committed. `readable` is
 * what precedes that record past the committed cursor: a live reader may already hold positions for it.
 */
type Unsettled =
  | { readonly reason: string; readonly kind: 'pending' | 'retry' | 'gone' }
  | { readonly reason: string; readonly kind: 'broken'; readonly readable: readonly LogRecord[] };

/** Nothing more will ever be committed for the operation. */
const final = (u: Unsettled | null): boolean =>
  u === null || u.kind === 'gone' || u.kind === 'broken';

/** The records from `from` up to the first one that cannot be read, one read at a time. */
function readableBefore(run: RunDir, id: string, from: IngestPosition | null): LogRecord[] {
  const out: LogRecord[] = [];
  let at = from;
  for (;;) {
    const one = readRecords(run, id, at, { maxRecords: 1, final: true });
    if (!one.ok || one.value.records.length === 0 || one.value.cursor === null) return out;
    out.push(...one.value.records);
    at = one.value.cursor;
  }
}

/**
 * Why an operation may still add committed records, or null when it never will. One that ended before it
 * wrote anything (e.g. blocked before invoking the model) has no run directory and nothing left to append.
 */
function unsettled(
  deps: LogsDeps,
  op: TaskState['operations'][string],
  committed: boolean,
): Unsettled | null {
  if (op.status === 'not_launched') return null;
  if (!['finished', 'lost'].includes(op.status))
    return {
      reason: 'earlier worker is not resolved; live output waits for its ingestion',
      kind: 'pending',
    };
  try {
    const run = RunDir.open({
      dataDir: deps.dataDir,
      ...runLocation(op),
      redactor: deps.redactor,
      create: false,
    });
    // As the ingester does: an operation such as stop_attempt shares the attempt of the run it acts on,
    // and that run's records are never its own.
    const marker = readLaunchMarker(run);
    if (marker.state === 'valid' && marker.value.operation_id !== op.id) return null;
    // The batch the ingester reads next, as it reads it: records it can commit, or the error it hits.
    const from = op.cursor === null ? null : { operation_id: op.id, ...op.cursor };
    // No segment at all, yet a committed cursor names one, and retention left no tombstone: the spool
    // was moved away, and may come back.
    if (
      from !== null &&
      listSegments(run).length === 0 &&
      !existsSync(join(run.dir, TOMBSTONE_FILE))
    )
      return { reason: 'earlier spool has no segment left', kind: 'retry' };
    const tail = readRecords(run, op.id, from, { maxRecords: DEFAULT_INGEST_BATCH, final: true });
    if (!tail.ok) {
      // A missing segment or offset may come back (a file moved away and restored): the daemon retries.
      if (tail.error.code !== 'corrupt_record')
        return {
          reason: `earlier spool is unreadable: ${JSON.stringify(tail.error)}`,
          kind: 'retry',
        };
      return {
        reason: `earlier spool is corrupt: ${JSON.stringify(tail.error)}`,
        kind: 'broken',
        readable: readableBefore(run, op.id, from),
      };
    }
    return tail.value.records.length > 0
      ? {
          reason: 'earlier worker has uncommitted output; later live output waits',
          kind: 'pending',
        }
      : null;
  } catch (e) {
    const gone = e instanceof RunnerFileError && e.code === 'not_found';
    if (gone && op.cursor === null && !committed) return null;
    return {
      reason: `earlier spool is unavailable: ${e instanceof Error ? e.message : String(e)}`,
      kind: gone ? 'gone' : 'retry',
    };
  }
}

/**
 * A deputy run's records by their place in it: record `seq` is at `seq - 1`, so a segment lost from the
 * spool leaves holes where its records were instead of moving the later ones down (no ingester keeps a
 * cursor for a deputy run). Null when the run has no directory (never launched, or nothing written yet).
 */
function deputyRecords(deps: SpoolDeps, attemptId: string): Spooled | null | string {
  try {
    RunDir.open({
      dataDir: deps.dataDir,
      kind: 'runs',
      id: attemptId,
      redactor: deps.redactor,
      create: false,
    });
  } catch (e) {
    if (e instanceof RunnerFileError && e.code === 'not_found') return null;
    return e instanceof Error ? e.message : String(e);
  }
  const records = openRecords(deps, { id: attemptId, attempt_id: attemptId });
  if (typeof records === 'string') return records;
  const placed: Spooled = Array.from({ length: records.at(-1)?.seq ?? 0 }, () => undefined);
  for (const r of records) if (r.seq >= 1 && r.seq <= placed.length) placed[r.seq - 1] = r;
  return placed;
}

/** Records by place; `undefined` where a record is no longer on disk. */
type Spooled = (LogRecord | undefined)[];

/**
 * What a deputy run wrote, for the daemon to keep when the run ends (`deputy_turn_runs.records`); a run
 * with no directory wrote nothing. Undefined when its spool cannot be read: the count stays unconfirmed.
 */
export function runCount(deps: SpoolDeps, attemptId: string): RunCount | undefined {
  const loaded = deputyRecords(deps, attemptId);
  if (typeof loaded === 'string') return undefined;
  const records = loaded ?? [];
  // A run missing some of its records has no digest to keep: what is there is read by place.
  return {
    records: records.length,
    digest: records.includes(undefined) ? null : hashCanonical(records),
  };
}

function stampOf(runs: readonly DeputyRun[], turn: DeputyTurn | null): string {
  return hashCanonical({
    runs: runs.map((r) => [r.attempt_id, r.live, r.mode]),
    turn: turn === null ? null : [turn.turn_id, turn.state, turn.attempt_id],
  });
}

/**
 * What the task's deputy runs and live turn are now, as one value: `task_logs` and `task_show` both carry it,
 * so a reader holding a `task_show` can tell from a log page whether that snapshot is still current.
 */
export function deputyStamp(store: Store, taskId: string): string {
  return stampOf(store.deputy.runsOf(taskId), store.deputy.runningTurn(taskId));
}

/** What a record weighs against `LOG_PAGE_BYTES`. */
const recordBytes = (r: LogRecord): number => JSON.stringify(r.data).length;

/**
 * The cursor a tail page starts after: as many of the last records as fit both `limit` and `LOG_PAGE_BYTES`,
 * or the page would stop short of the end. Only the attempt's records count when it is given; what precedes
 * them is read later, by `after`, as it would be otherwise. The last record is taken whatever its size, and
 * records that cannot be read weigh nothing, as in the page itself.
 */
function tailStart(
  batches: readonly Batch[],
  limit: number,
  attemptId: string | undefined,
  load: (id: string) => readonly (LogRecord | undefined)[] | string,
): number {
  const ends = new Map<string, number>();
  let end = 0;
  for (const b of batches) {
    ends.set(b.key, (ends.get(b.key) ?? 0) + b.records);
    end += b.records;
  }
  // Fewer records than a page: from the first of them, or past everything when there are none.
  let first = end;
  let taken = 0;
  let bytes = 0;
  for (const b of batches.toReversed()) {
    const start = end - b.records;
    const from = (ends.get(b.key) ?? 0) - b.records;
    ends.set(b.key, from);
    end = start;
    const mine = attemptId === undefined || b.attempt_id === attemptId;
    if (!mine || b.records === 0) continue;
    const loaded = load(b.key);
    for (let i = b.records - 1; i >= 0; i--) {
      const record = typeof loaded === 'string' ? undefined : loaded[from + i];
      const size = record === undefined ? 0 : recordBytes(record);
      if (taken === limit || (taken > 0 && bytes + size > LOG_PAGE_BYTES)) return first;
      bytes += size;
      taken += 1;
      first = start + i;
    }
  }
  return first;
}

/**
 * When the attempt's newest operation last wrote a record, live spool included; null when it wrote none or
 * its files cannot be read.
 */
export function lastOutputAt(deps: LogsDeps, s: TaskState, attemptId: string): number | null {
  const op = Object.values(s.operations)
    .filter((o) => o.attempt_id === attemptId)
    .at(-1);
  if (op === undefined) return null;
  const records = openRecords(deps, op);
  const at = typeof records === 'string' ? undefined : records.at(-1)?.at;
  const ms = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

export function taskLogs(
  deps: LogsDeps,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
): Result<unknown, AppError> {
  const q = LogsQuerySchema.safeParse(body);
  if (!q.success)
    return err({
      code: 'invalid_request',
      message: 'invalid task_logs query',
      details: {
        issues: q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    });
  const s = deps.store.readTask(q.data.task_id);
  if (s === null || !authorize(caller, { role: 'read' }).ok)
    return err({
      code: 'task_not_found',
      message: `no task ${q.data.task_id}`,
      details: {},
    });

  const out: LogEntry[] = [];
  let bytes = 0;
  let position = 0;
  let total = 0;
  const offsets = new Map<string, number>();
  const cache = new Map<string, readonly (LogRecord | undefined)[] | string>();
  const registeredAt = new Map<string, number>();
  const committed: Placed[] = [];
  const history = deps.store.readEvents(s.id as Uuid);
  const models = attemptModelIds(history);
  for (const e of history) {
    if (e.type === 'OperationRegistered') registeredAt.set(e.payload.operation_id, e.seq);
    else if (e.type === 'OutputIngested') {
      const { operation_id: id, records, digest } = e.payload;
      committed.push({
        batch: operationBatch(s, models, id, records, digest),
        operation_id: id,
        seq: e.seq,
      });
    }
  }
  const regOf = (id: string): number => registeredAt.get(id) ?? 0;
  const hasCommitted = (id: string): boolean => committed.some((c) => c.operation_id === id);
  const items = [...committed];
  const committedOf = (id: string): number =>
    committed.filter((c) => c.operation_id === id).reduce((n, c) => n + c.batch.records, 0);
  /** What each operation already has handed out, committed or not, and the places it keeps for good. */
  const issued = deps.store.deputy.publishedOutput(s.id);
  const issuedOf = (id: string): number => issued.get(id)?.records ?? 0;
  const sealOf = (id: string): number | null => issued.get(id)?.sealed ?? null;
  let diagnostic: Diagnostic | null = null;
  const workers = Object.values(s.operations).filter((o) => o.kind === 'agent');
  const active = workers.at(-1);
  if (active !== undefined && LIVE_STATUSES.includes(active.status)) {
    // Do not expose B's uncommitted tail while A can still append records to the committed prefix.
    // Otherwise a later successful ingest of A would change the cursors already handed out for B.
    for (const previous of workers.slice(0, -1)) {
      const held = unsettled(deps, previous, hasCommitted(previous.id));
      if (held !== null) {
        diagnostic = at(previous, held.reason);
        break;
      }
    }
    if (diagnostic === null) {
      try {
        const run = RunDir.open({
          dataDir: deps.dataDir,
          ...runLocation(active),
          redactor: deps.redactor,
          create: false,
        });
        const live = liveRecords(deps, run, active.id);
        if (!live.ok)
          diagnostic = at(active, `live spool is unreadable: ${JSON.stringify(live.error)}`);
        else {
          cache.set(active.id, live.value.records);
          const done = items
            .filter((c) => c.operation_id === active.id)
            .reduce((n, c) => n + c.batch.records, 0);
          const tail = live.value.records.slice(done);
          if (tail.length > 0 && live.value.cursor !== null) {
            items.push({
              batch: {
                ...operationBatch(s, models, active.id, tail.length, hashCanonical(tail)),
                handsOp: { op: active.id, base: done },
              },
              operation_id: active.id,
            });
          }
        }
      } catch (e) {
        if (!(e instanceof RunnerFileError && e.code === 'not_found'))
          diagnostic = at(
            active,
            `live spool is unreadable: ${e instanceof Error ? e.message : String(e)}`,
          );
      }
    }
  }

  // Deputy runs. A run goes after the output of every operation registered before it and before the
  // output of any registered later, so its place holds whenever their ingestion lands: the log is one
  // group of output per stretch between two runs, each in ingestion order. Until every operation before
  // a run is settled, or while the run itself may still write, what follows it waits.
  const runs = deps.store.deputy.runsOf(s.id);
  const groups: Batch[][] = runs.map(() => []);
  groups.push([]);
  /** The stretch between two runs an event falls in: before the first run recorded after it. */
  const groupAt = (seq: number): number => {
    const g = runs.findIndex((r) => seq <= r.after_seq);
    return g < 0 ? runs.length : g;
  };
  const groupOf = (id: string): number => groupAt(regOf(id));
  // An operation the log went on past keeps its sealed places; what it commits beyond them (its spool came
  // back) goes where it was committed, among the runs by when they were recorded, as output of an
  // operation registered then would: never under positions already handed out.
  const placed = new Map<string, number>();
  for (const item of items) {
    const id = item.operation_id;
    const seal = sealOf(id);
    const before = placed.get(id) ?? 0;
    placed.set(id, before + item.batch.records);
    const inside =
      seal === null ? item.batch.records : Math.max(0, Math.min(item.batch.records, seal - before));
    const g = groupOf(id);
    if (inside === item.batch.records) (groups[g] as Batch[]).push(item.batch);
    else {
      if (inside > 0) (groups[g] as Batch[]).push({ ...item.batch, records: inside, digest: null });
      (groups[groupAt(item.seq ?? Number.MAX_SAFE_INTEGER)] as Batch[]).push({
        ...item.batch,
        records: item.batch.records - inside,
        digest: null,
      });
    }
  }
  const settled = new Map<string, Unsettled | null>();
  const unsettledOf = (op: TaskState['operations'][string]): Unsettled | null => {
    let held = settled.get(op.id);
    if (held === undefined) {
      held = unsettled(deps, op, hasCommitted(op.id));
      settled.set(op.id, held);
    }
    return held;
  };
  /** After the operation's last batch in its group, or at the group's end when it has none there. */
  const placeAfter = (id: string, ...extra: Batch[]): void => {
    const group = groups[groupOf(id)] as Batch[];
    const last = group.findLastIndex((b) => b.operation_id === id);
    group.splice(last < 0 ? group.length : last + 1, 0, ...extra);
  };
  /** An operation's records past what was committed, read from its spool where they still are. */
  const tailBatches = (
    op: TaskState['operations'][string],
    readable: readonly LogRecord[],
    count: number,
    base: number,
  ): Batch[] => {
    const out: Batch[] = [];
    const shown = readable.slice(0, count);
    if (shown.length > 0) {
      cache.set(`${op.id}#tail`, shown);
      out.push({
        ...operationBatch(s, models, op.id, shown.length, hashCanonical(shown)),
        key: `${op.id}#tail`,
        handsOp: { op: op.id, base },
      });
    }
    if (count > shown.length) {
      cache.set(`${op.id}#lost`, 'output handed out before it was ingested can no longer be read');
      out.push({
        ...operationBatch(s, models, op.id, count - shown.length, ''),
        key: `${op.id}#lost`,
        digest: null,
        handsOp: { op: op.id, base: base + shown.length },
      });
    }
    return out;
  };
  /**
   * The places an operation keeps past its committed records where a deputy run goes on past it without
   * waiting for it: those a reader already holds (its live tail, or a seal), filled with what its spool
   * still holds; and while it ends its group, the rest of what its corrupt spool can still be read for.
   * Null for an operation the log waits for, or one with nothing past its committed records.
   */
  const keeps = new Map<string, { readonly count: number; readonly h: Unsettled | null }>();
  for (const op of Object.values(s.operations)) {
    if (op.id === active?.id && LIVE_STATUSES.includes(op.status)) continue;
    const g = groupOf(op.id);
    // Elsewhere the log waits for the operation, and a repaired spool is read where it is.
    if (g >= runs.length) continue;
    const done = committedOf(op.id);
    const seal = sealOf(op.id);
    const h = unsettledOf(op);
    let count: number;
    if (seal !== null) count = seal - done;
    else if (final(h)) {
      count = issuedOf(op.id) - done;
      const group = groups[g] as Batch[];
      const last = group.findLastIndex((b) => b.operation_id === op.id);
      // Records no reader holds a place for go only where nothing already placed comes after them.
      if (h?.kind === 'broken' && (last < 0 || last === group.length - 1))
        count = Math.max(count, h.readable.length);
    } else continue;
    if (count <= 0) continue;
    keeps.set(op.id, { count, h });
    placeAfter(op.id, ...tailBatches(op, h?.kind === 'broken' ? h.readable : [], count, done));
  }
  const batches: Batch[] = [];
  const skipped = new Set<string>();
  for (const [g, group] of groups.entries()) {
    batches.push(...group);
    const run = runs[g];
    if (run === undefined) break;
    const where = { operation_id: run.operation_id ?? run.attempt_id, attempt_id: run.attempt_id };
    let held: Unsettled | null = null;
    const passed: TaskState['operations'][string][] = [];
    for (const op of Object.values(s.operations)) {
      if (regOf(op.id) > run.after_seq) continue;
      // An operation that will never be ingested further (run directory gone, or spool corrupt for good)
      // does not hold the run: its records keep their places, and the run follows them. Nor does one that
      // keeps sealed places. One the daemon may still read waits.
      const h = unsettledOf(op);
      if (h?.kind === 'broken' || h?.kind === 'gone' || keeps.has(op.id)) passed.push(op);
      held = sealOf(op.id) !== null || final(h) ? null : h;
      if (held !== null) break;
    }
    if (held === null)
      for (const op of passed) {
        if (skipped.has(op.id)) continue;
        skipped.add(op.id);
        // Its places are fixed once the run, after them, is handed out.
        if (sealOf(op.id) === null)
          batches.push({
            key: op.id,
            operation_id: op.id,
            attempt_id: run.attempt_id,
            step: null,
            model: null,
            records: 0,
            digest: null,
            seal: { op: op.id, count: committedOf(op.id) + (keeps.get(op.id)?.count ?? 0) },
          });
        const h = unsettledOf(op);
        if (h?.kind !== 'broken') continue;
        // Under the run, so a reader sees it with the run's output; it moves no cursor.
        batches.push({
          key: op.id,
          operation_id: op.id,
          attempt_id: run.attempt_id,
          step: null,
          model: null,
          records: 0,
          digest: null,
          notice: `${DEPUTY_SKIPS}: ${h.reason}`,
        });
      }
    if (held !== null) {
      diagnostic ??= {
        ...where,
        reason: `${held.kind === 'retry' ? DEPUTY_RETRY : DEPUTY_WAITS}: ${held.reason}`,
      };
      break;
    }
    let records = run.records;
    if (records === null) {
      // Not confirmed when it ended (still running, or recorded before counts were kept): its spool says,
      // never less than the positions already handed out for it.
      const loaded = deputyRecords(deps, run.attempt_id);
      if (typeof loaded === 'string') {
        diagnostic ??= { ...where, reason: `deputy spool is unreadable: ${loaded}` };
        break;
      }
      if (loaded !== null) cache.set(run.attempt_id, loaded);
      records = Math.max(loaded?.length ?? 0, run.published ?? 0);
    }
    if (records > 0)
      batches.push({
        key: run.attempt_id,
        operation_id: where.operation_id,
        attempt_id: run.attempt_id,
        step: DEPUTY_STEP,
        model: { id: run.model_id, binding: null, effort: run.effort },
        records,
        digest: run.digest,
        ...(run.records === null ? { handsRun: run } : {}),
      });
    if (run.live) {
      // Its count still grows: nothing after it has a place yet.
      if (groups.slice(g + 1).some((later) => later.length > 0))
        diagnostic ??= { ...where, reason: DEPUTY_HOLDS };
      break;
    }
  }
  for (const b of batches) total += b.records;
  const deputyKeys = new Set(runs.map((r) => r.attempt_id));
  const load = (key: string): readonly (LogRecord | undefined)[] | string => {
    let loaded = cache.get(key);
    if (loaded === undefined) {
      const op = s.operations[key];
      if (op !== undefined) loaded = openRecords(deps, op);
      else if (deputyKeys.has(key))
        loaded = deputyRecords(deps, key) ?? 'the run directory is gone';
      else loaded = 'operation unknown';
      cache.set(key, loaded);
    }
    return loaded;
  };
  // Past the end only while every record is countable: a transient gap hides the live tail from `total`.
  if (!q.data.tail && diagnostic === null && q.data.after > total)
    return err({
      code: 'invalid_arguments',
      message: `cursor ${q.data.after} is past the last record (${total})`,
      details: {
        after: q.data.after,
        total,
        guidance: `Use --after ${total} or less, or --tail; a cursor is the next_cursor a page printed.`,
      },
    });
  const after = q.data.tail
    ? tailStart(batches, q.data.limit, q.data.attempt_id, load)
    : q.data.after;
  let cursor = after;
  // Notices move no cursor and so take no room of the page: else a page of one could hold only them.
  let notices = 0;
  const full = (): boolean => out.length - notices >= q.data.limit || bytes >= LOG_PAGE_BYTES;
  const notice = (b: Batch, at: number): void => {
    if (q.data.attempt_id !== undefined && b.attempt_id !== q.data.attempt_id) return;
    notices += 1;
    out.push({
      seq: at + 1,
      cursor: at,
      operation_id: b.operation_id,
      attempt_id: b.attempt_id,
      gap: { records: 0, reason: b.notice ?? '' },
    });
  };
  /** Where each batch the page reached starts, and where each seal mark stands. */
  const reached: { readonly b: Batch; readonly start: number }[] = [];
  /** A tail page that starts inside a run still says what the run went on past, before its records. */
  const owed = new Map<string, { readonly b: Batch; readonly at: number }[]>();

  for (const b of batches) {
    const { key, operation_id: id, attempt_id: attemptId, step, model, records: count, digest } = b;
    if (b.seal !== undefined) {
      reached.push({ b, start: position });
      continue;
    }
    if (b.notice !== undefined) {
      // Holds no place, like a wait: a reader at or before it is told, and its cursor stays put.
      if (position < after) {
        if (q.data.tail && attemptId !== null)
          owed.set(attemptId, [...(owed.get(attemptId) ?? []), { b, at: position }]);
        continue;
      }
      if (full()) break;
      notice(b, position);
      continue;
    }
    const from = offsets.get(key) ?? 0;
    offsets.set(key, from + count);
    const first = position + 1;
    reached.push({ b, start: position });
    position += count;
    if (position <= after) continue;
    const due = attemptId === null ? undefined : owed.get(attemptId);
    if (due !== undefined && attemptId !== null) {
      owed.delete(attemptId);
      for (const d of due) notice(d.b, d.at);
    }
    if (full()) break;
    // Another attempt's records are passed over, not hidden: the cursor still counts them, so it stays the
    // task's cursor and a reader can drop the filter and resume from the same place.
    if (q.data.attempt_id !== undefined && attemptId !== q.data.attempt_id) {
      cursor = position;
      continue;
    }
    const loaded = load(key);
    const sliced = typeof loaded === 'string' ? null : loaded.slice(from, from + count);
    // A deputy run is read by place: what its spool no longer holds is a hole, not a shorter run.
    const batch =
      sliced !== null && deputyKeys.has(key)
        ? Array.from({ length: count }, (_, i) => sliced[i])
        : sliced;
    const holes = batch?.filter((r) => r === undefined).length ?? 0;
    if (
      batch === null ||
      batch.length < count ||
      holes === count ||
      (holes === 0 && digest !== null && hashCanonical(batch) !== digest)
    ) {
      // Taken whole: a gap has no records to page through, and the cursor must still move past it.
      out.push({
        seq: position,
        cursor: position,
        operation_id: id,
        attempt_id: attemptId,
        gap: {
          records: position - Math.max(first - 1, after),
          reason:
            typeof loaded === 'string'
              ? `records unavailable: ${loaded}`
              : batch !== null && (batch.length < count || holes === count)
                ? 'records are no longer in the spool'
                : 'records no longer match the committed digest',
        },
      });
      cursor = position;
      continue;
    }
    for (let i = 0; i < batch.length; i++) {
      const r = batch[i];
      const seq = first + i;
      if (r === undefined) {
        // A stretch of records lost from the spool: one gap, at the place of its last record.
        let end = i;
        while (batch[end + 1] === undefined && end + 1 < batch.length) end++;
        i = end;
        const last = first + end;
        if (last <= after) continue;
        if (full()) break;
        out.push({
          seq: last,
          cursor: last,
          operation_id: id,
          attempt_id: attemptId,
          gap: {
            records: last - Math.max(seq - 1, after),
            reason: 'records are no longer in the spool',
          },
        });
        cursor = last;
        continue;
      }
      if (seq <= after) continue;
      if (full()) break;
      out.push({
        seq,
        cursor: seq,
        operation_id: id,
        attempt_id: attemptId,
        step,
        model,
        at: r.at,
        kind: r.kind,
        data: r.data,
      });
      bytes += recordBytes(r);
      cursor = seq;
    }
  }
  if (
    diagnostic !== null &&
    (q.data.attempt_id === undefined || diagnostic.attempt_id === q.data.attempt_id) &&
    cursor >= total &&
    !full()
  ) {
    // A transient gap has no known record count and must not consume/rewind the cursor. Once repaired,
    // the same --after resumes real records at their original positions.
    out.push({
      seq: Math.max(position, cursor) + 1,
      cursor,
      operation_id: diagnostic.operation_id,
      attempt_id: diagnostic.attempt_id,
      gap: { records: 0, reason: diagnostic.reason },
    });
  }
  try {
    // Only what this page handed out: the positions up to its cursor.
    const handed = (start: number, count: number): number =>
      Math.max(0, Math.min(count, cursor - start));
    const ops = new Map<string, number>();
    for (const { b, start } of reached) {
      if (b.seal !== undefined) {
        if (cursor > start && sealOf(b.seal.op) === null)
          deps.store.deputy.sealOutput(s.id, b.seal.op, b.seal.count);
        continue;
      }
      const n = handed(start, b.records);
      if (n === 0) continue;
      if (b.handsRun !== undefined && n > (b.handsRun.published ?? 0))
        deps.store.deputy.publishRun(b.handsRun.turn_id, b.handsRun.attempt_id, n);
      if (b.handsOp !== undefined)
        ops.set(b.handsOp.op, Math.max(ops.get(b.handsOp.op) ?? 0, b.handsOp.base + n));
    }
    for (const [id, records] of ops)
      if (records > issuedOf(id)) deps.store.deputy.publishOutput(s.id, id, records);
  } catch (e) {
    // A cursor into a run whose count is not kept could be lost with its spool: no page without it.
    return err({
      code: 'log_position_unsaved',
      message: 'could not keep the count of a running deputy run, so this page is not returned',
      details: { reason: e instanceof Error ? e.message : String(e) },
    });
  }
  const turn = deps.store.deputy.runningTurn(s.id);
  return ok({
    task_id: s.id,
    records: out,
    next_cursor: cursor,
    // A finished task whose committed records were all read, and no deputy turn of it that may still
    // write (running, or waiting to run again): a follower may stop here.
    complete: diagnostic === null && s.terminal !== null && cursor >= total && turn === null,
    // Changes when a deputy run starts or ends, or the live turn changes state. None of that moves the
    // task's version, so a reader that keeps the turn's state beside the log reads it again on this.
    deputy_stamp: stampOf(runs, turn),
    // Committed or live records past this page: a follower that is behind reads on at once.
    more: cursor < total,
    state: taskStateOf(deps, s),
    ...(q.data.tail ? { after } : {}),
  });
}
