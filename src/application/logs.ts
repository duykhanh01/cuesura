/**
 * `task logs` (T114, FR-027.01/028/031). OutputIngested events authenticate the committed prefix; the
 * active worker's durable, redacted spool extends it without a domain write or version change. Final
 * ingestion keeps the same order. Rotation and restart do not change cursors, so a follower resumes with no
 * record repeated or lost. A batch whose files are gone (retention) or no longer match their digest is
 * reported as a gap of that size, never skipped silently.
 */
import { z } from 'zod';
import type { DomainEvent } from '../domain/event.ts';
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
  /** A question the decider may still answer itself is not the user's yet (`DeciderWatch.holds`). */
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

type OutputEvent = Extract<DomainEvent, { type: 'OutputIngested' }>;

function openRecords(deps: LogsDeps, op: TaskState['operations'][string]): LogRecord[] | string {
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

/** What a record weighs against `LOG_PAGE_BYTES`. */
const recordBytes = (r: LogRecord): number => JSON.stringify(r.data).length;

/**
 * The cursor a tail page starts after: as many of the last records as fit both `limit` and `LOG_PAGE_BYTES`,
 * or the page would stop short of the end. Only the attempt's records count when it is given; what precedes
 * them is read later, by `after`, as it would be otherwise. The last record is taken whatever its size, and
 * records that cannot be read weigh nothing, as in the page itself.
 */
function tailStart(
  s: TaskState,
  batches: readonly { readonly operation_id: string; readonly records: number }[],
  limit: number,
  attemptId: string | undefined,
  load: (id: string) => readonly LogRecord[] | string,
): number {
  const ends = new Map<string, number>();
  let end = 0;
  for (const b of batches) {
    ends.set(b.operation_id, (ends.get(b.operation_id) ?? 0) + b.records);
    end += b.records;
  }
  // Fewer records than a page: from the first of them, or past everything when there are none.
  let first = end;
  let taken = 0;
  let bytes = 0;
  for (const b of batches.toReversed()) {
    const start = end - b.records;
    const from = (ends.get(b.operation_id) ?? 0) - b.records;
    ends.set(b.operation_id, from);
    end = start;
    const mine =
      attemptId === undefined || (s.operations[b.operation_id]?.attempt_id ?? null) === attemptId;
    if (!mine || b.records === 0) continue;
    const loaded = load(b.operation_id);
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
  const events = deps.store
    .readEvents(s.id as Uuid)
    .filter((e): e is OutputEvent => e.type === 'OutputIngested');
  const batches = events.map((e) => e.payload);
  let diagnostic: {
    op: TaskState['operations'][string];
    reason: string;
  } | null = null;
  const workers = Object.values(s.operations).filter((o) => o.kind === 'agent');
  const active = workers.at(-1);
  if (active !== undefined && ['registered', 'running', 'unknown'].includes(active.status)) {
    // Do not expose B's uncommitted tail while A can still append records to the committed prefix.
    // Otherwise a later successful ingest of A would change the cursors already handed out for B.
    for (const previous of workers.slice(0, -1)) {
      if (previous.status === 'not_launched') continue;
      try {
        if (!['finished', 'lost'].includes(previous.status)) {
          diagnostic = {
            op: previous,
            reason: 'earlier worker is not resolved; live output waits for its ingestion',
          };
          break;
        }
        const run = RunDir.open({
          dataDir: deps.dataDir,
          ...runLocation(previous),
          redactor: deps.redactor,
          create: false,
        });
        const tail = readRecords(
          run,
          previous.id,
          previous.cursor === null ? null : { operation_id: previous.id, ...previous.cursor },
          { maxRecords: 1, final: true },
        );
        if (!tail.ok || tail.value.records.length > 0) {
          diagnostic = {
            op: previous,
            reason: tail.ok
              ? 'earlier worker has uncommitted output; later live output waits'
              : `earlier spool is unreadable: ${JSON.stringify(tail.error)}`,
          };
          break;
        }
      } catch (e) {
        diagnostic = {
          op: previous,
          reason: `earlier spool is unavailable: ${e instanceof Error ? e.message : String(e)}`,
        };
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
          diagnostic = {
            op: active,
            reason: `live spool is unreadable: ${JSON.stringify(live.error)}`,
          };
        else {
          cache.set(active.id, live.value.records);
          const committed = batches
            .filter((b) => b.operation_id === active.id)
            .reduce((n, b) => n + b.records, 0);
          const tail = live.value.records.slice(committed);
          if (tail.length > 0 && live.value.cursor !== null)
            batches.push({
              operation_id: active.id,
              records: tail.length,
              digest: hashCanonical(tail),
              cursor: { ...live.value.cursor },
            });
        }
      } catch (e) {
        if (!(e instanceof RunnerFileError && e.code === 'not_found'))
          diagnostic = {
            op: active,
            reason: `live spool is unreadable: ${e instanceof Error ? e.message : String(e)}`,
          };
      }
    }
  }
  for (const b of batches) total += b.records;
  const load = (id: string): readonly LogRecord[] | string => {
    let loaded = cache.get(id);
    if (loaded === undefined) {
      const op = s.operations[id];
      loaded = op === undefined ? 'operation unknown' : openRecords(deps, op);
      cache.set(id, loaded);
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
    ? tailStart(s, batches, q.data.limit, q.data.attempt_id, load)
    : q.data.after;
  let cursor = after;

  for (const b of batches) {
    const { operation_id: id, records: count, digest } = b;
    const from = offsets.get(id) ?? 0;
    offsets.set(id, from + count);
    const first = position + 1;
    position += count;
    if (position <= after) continue;
    if (out.length >= q.data.limit || bytes >= LOG_PAGE_BYTES) break;
    const op = s.operations[id];
    const attemptId = op?.attempt_id ?? null;
    // Another attempt's records are passed over, not hidden: the cursor still counts them, so it stays the
    // task's cursor and a reader can drop the filter and resume from the same place.
    if (q.data.attempt_id !== undefined && attemptId !== q.data.attempt_id) {
      cursor = position;
      continue;
    }
    const loaded = load(id);
    const batch = typeof loaded === 'string' ? null : loaded.slice(from, from + count);
    if (batch === null || hashCanonical(batch) !== digest) {
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
    const step = op?.attempt_id == null ? null : (s.attempts[op.attempt_id]?.step ?? null);
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
    cursor >= total &&
    out.length < q.data.limit &&
    bytes < LOG_PAGE_BYTES
  ) {
    // A transient gap has no known record count and must not consume/rewind the cursor. Once repaired,
    // the same --after resumes real records at their original positions.
    out.push({
      seq: Math.max(position, cursor) + 1,
      cursor,
      operation_id: diagnostic.op.id,
      attempt_id: diagnostic.op.attempt_id,
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
