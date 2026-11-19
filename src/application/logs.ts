/**
 * `task logs` (T114, FR-027.01/028/031). OutputIngested events authenticate the committed prefix; the
 * active worker's durable, redacted spool extends it without a domain write or version change. Final
 * ingestion keeps the same order. Rotation and restart do not change cursors, so a follower resumes with no
 * record repeated or lost. A batch whose files are gone (retention) or no longer match their digest is
 * reported as a gap of that size, never skipped silently. The runs of the task's deputy turns, recorded
 * outside the event log, are read from their spools and placed among the operations' output by when they
 * were recorded (`deputy_turn_runs`).
 */
import { z } from 'zod';
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
import { runLocation } from '../daemon/retention.ts';
import type { Redactor } from '../runner/redact.ts';
import { UuidSchema, type Uuid } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';
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

export type LogEntry =
  | {
      readonly seq: number;
      readonly cursor: number;
      readonly operation_id: string;
      readonly attempt_id: string | null;
      readonly step: string | null;
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

function openRecords(
  deps: LogsDeps,
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

/** The step a deputy run's records show under: a turn is no step of the task. */
export const DEPUTY_STEP = 'deputy';

const LIVE_STATUSES: readonly string[] = ['registered', 'running', 'unknown'];

/** One stretch of the task's log: an ingest of an operation, a worker's live tail, or a deputy run. */
type Batch = {
  /** What `load` reads: an operation's id, or a deputy run's attempt. */
  readonly key: string;
  readonly operation_id: string;
  readonly attempt_id: string | null;
  readonly step: string | null;
  readonly records: number;
  /** Null for a deputy run, whose records no event commits. */
  readonly digest: string | null;
};

type Placed = { readonly batch: Batch; readonly operation_id: string };

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

function operationBatch(s: TaskState, id: string, records: number, digest: string): Batch {
  const attemptId = s.operations[id]?.attempt_id ?? null;
  return {
    key: id,
    operation_id: id,
    attempt_id: attemptId,
    step: attemptId === null ? null : (s.attempts[attemptId]?.step ?? null),
    records,
    digest,
  };
}

/**
 * Why an operation may still add committed records, or null when it never will. One that ended before it
 * wrote anything (e.g. blocked before invoking the model) has no run directory and nothing left to append.
 */
function unsettled(
  deps: LogsDeps,
  op: TaskState['operations'][string],
  committed: boolean,
): string | null {
  if (op.status === 'not_launched') return null;
  if (!['finished', 'lost'].includes(op.status))
    return 'earlier worker is not resolved; live output waits for its ingestion';
  try {
    const run = RunDir.open({
      dataDir: deps.dataDir,
      ...runLocation(op),
      redactor: deps.redactor,
      create: false,
    });
    const tail = readRecords(
      run,
      op.id,
      op.cursor === null ? null : { operation_id: op.id, ...op.cursor },
      { maxRecords: 1, final: true },
    );
    if (!tail.ok) return `earlier spool is unreadable: ${JSON.stringify(tail.error)}`;
    return tail.value.records.length > 0
      ? 'earlier worker has uncommitted output; later live output waits'
      : null;
  } catch (e) {
    if (e instanceof RunnerFileError && e.code === 'not_found' && op.cursor === null && !committed)
      return null;
    return `earlier spool is unavailable: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** A deputy run's records; null when it has no run directory (never launched, or nothing written yet). */
function deputyRecords(deps: LogsDeps, attemptId: string): LogRecord[] | null | string {
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
  return openRecords(deps, { id: attemptId, attempt_id: attemptId });
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
  load: (id: string) => readonly LogRecord[] | string,
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
  const cache = new Map<string, readonly LogRecord[] | string>();
  const registeredAt = new Map<string, number>();
  const committed: Placed[] = [];
  for (const e of deps.store.readEvents(s.id as Uuid)) {
    if (e.type === 'OperationRegistered') registeredAt.set(e.payload.operation_id, e.seq);
    else if (e.type === 'OutputIngested') {
      const { operation_id: id, records, digest } = e.payload;
      committed.push({ batch: operationBatch(s, id, records, digest), operation_id: id });
    }
  }
  const regOf = (id: string): number => registeredAt.get(id) ?? 0;
  const hasCommitted = (id: string): boolean => committed.some((c) => c.operation_id === id);
  const items = [...committed];
  let diagnostic: Diagnostic | null = null;
  const workers = Object.values(s.operations).filter((o) => o.kind === 'agent');
  const active = workers.at(-1);
  if (active !== undefined && LIVE_STATUSES.includes(active.status)) {
    // Do not expose B's uncommitted tail while A can still append records to the committed prefix.
    // Otherwise a later successful ingest of A would change the cursors already handed out for B.
    for (const previous of workers.slice(0, -1)) {
      const reason = unsettled(deps, previous, hasCommitted(previous.id));
      if (reason !== null) {
        diagnostic = at(previous, reason);
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
          if (tail.length > 0 && live.value.cursor !== null)
            items.push({
              batch: operationBatch(s, active.id, tail.length, hashCanonical(tail)),
              operation_id: active.id,
            });
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

  // Deputy runs. A run goes after the output of every operation registered before it and before
  // the output of any registered later, so its place holds whenever their ingestion lands. Until each of
  // those operations is settled, or while the run itself may still write, what follows it waits.
  const settled = new Map<string, string | null>();
  const unsettledOf = (op: TaskState['operations'][string]): string | null => {
    let reason = settled.get(op.id);
    if (reason === undefined) {
      reason = unsettled(deps, op, hasCommitted(op.id));
      settled.set(op.id, reason);
    }
    return reason;
  };
  const runs: { readonly index: number; readonly batch: Batch }[] = [];
  let cut = items.length;
  for (const run of deps.store.deputy.runsOf(s.id)) {
    const index = items.findLastIndex((c) => regOf(c.operation_id) <= run.after_seq) + 1;
    const where = {
      operation_id: run.operation_id ?? run.attempt_id,
      attempt_id: run.attempt_id,
    };
    let waits: string | null = null;
    for (const op of Object.values(s.operations)) {
      if (regOf(op.id) > run.after_seq) continue;
      waits = unsettledOf(op);
      if (waits !== null) break;
    }
    if (waits !== null) {
      cut = index;
      diagnostic ??= { ...where, reason: `deputy output waits for earlier output: ${waits}` };
      break;
    }
    const loaded = deputyRecords(deps, run.attempt_id);
    if (typeof loaded === 'string') {
      cut = index;
      diagnostic ??= { ...where, reason: `deputy spool is unreadable: ${loaded}` };
      break;
    }
    if (loaded !== null && loaded.length > 0) {
      cache.set(run.attempt_id, loaded);
      runs.push({
        index,
        batch: {
          key: run.attempt_id,
          operation_id: run.operation_id ?? loaded[0]?.operation_id ?? run.attempt_id,
          attempt_id: run.attempt_id,
          step: DEPUTY_STEP,
          records: loaded.length,
          digest: null,
        },
      });
    }
    if (run.live) {
      // Its count still grows: nothing after it has a place yet.
      cut = index;
      if (index < items.length)
        diagnostic ??= { ...where, reason: 'a deputy turn is running; later output waits for it' };
      break;
    }
  }
  const batches: Batch[] = [];
  let next = 0;
  for (let i = 0; i <= cut; i++) {
    for (let run = runs[next]; run?.index === i; run = runs[++next]) batches.push(run.batch);
    const item = items[i];
    if (i < cut && item !== undefined) batches.push(item.batch);
  }
  for (const b of batches) total += b.records;
  const load = (key: string): readonly LogRecord[] | string => {
    let loaded = cache.get(key);
    if (loaded === undefined) {
      const op = s.operations[key];
      loaded = op === undefined ? 'operation unknown' : openRecords(deps, op);
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

  for (const b of batches) {
    const { key, operation_id: id, attempt_id: attemptId, step, records: count, digest } = b;
    const from = offsets.get(key) ?? 0;
    offsets.set(key, from + count);
    const first = position + 1;
    position += count;
    if (position <= after) continue;
    if (out.length >= q.data.limit || bytes >= LOG_PAGE_BYTES) break;
    // Another attempt's records are passed over, not hidden: the cursor still counts them, so it stays the
    // task's cursor and a reader can drop the filter and resume from the same place.
    if (q.data.attempt_id !== undefined && attemptId !== q.data.attempt_id) {
      cursor = position;
      continue;
    }
    const loaded = load(key);
    const batch = typeof loaded === 'string' ? null : loaded.slice(from, from + count);
    if (batch === null || (digest !== null && hashCanonical(batch) !== digest)) {
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
              : 'records no longer match the committed digest',
        },
      });
      cursor = position;
      continue;
    }
    for (const [i, r] of batch.entries()) {
      const seq = first + i;
      if (seq <= after) continue;
      if (out.length >= q.data.limit || bytes >= LOG_PAGE_BYTES) break;
      out.push({
        seq,
        cursor: seq,
        operation_id: id,
        attempt_id: attemptId,
        step,
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
    out.length < q.data.limit &&
    bytes < LOG_PAGE_BYTES
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
  return ok({
    task_id: s.id,
    records: out,
    next_cursor: cursor,
    // A finished task whose committed records were all read: a follower may stop here.
    complete: diagnostic === null && s.terminal !== null && cursor >= total,
    // Committed or live records past this page: a follower that is behind reads on at once.
    more: cursor < total,
    state: taskStateOf(deps, s),
    ...(q.data.tail ? { after } : {}),
  });
}
