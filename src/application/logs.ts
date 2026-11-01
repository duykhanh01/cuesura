/**
 * `task logs` (T114, FR-027.01/028/031). The stream is what the store committed: each `OutputIngested`
 * event names how many records of an operation it covers and their digest, so a record is served only
 * once it is ingested, and it was redacted before it reached the spool. The cursor counts committed
 * records in event order, which rotation and restart do not change, so a follower resumes with no
 * record repeated or lost. A batch whose files are gone (retention) or no longer match their digest is
 * reported as a gap of that size, never skipped silently.
 */
import { z } from 'zod';
import type { DomainEvent } from '../domain/event.ts';
import type { TaskState } from '../domain/state.ts';
import { readAllRecords, RunDir, type LogRecord } from '../runner/files.ts';
import { runLocation } from '../daemon/retention.ts';
import type { Redactor } from '../runner/redact.ts';
import { UuidSchema, type Uuid } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import { authorize, type Caller } from './authz.ts';
import type { AppError } from './queries.ts';

export const LOG_PAGE_RECORDS = 200;
const LOG_PAGE_BYTES = 1024 * 1024;

export type LogsDeps = {
  readonly store: Store;
  readonly dataDir: string;
  readonly redactor: Redactor;
};

const LogsQuerySchema = z
  .object({
    kind: z.literal('task_logs'),
    task_id: UuidSchema,
    after: z.number().int().nonnegative().default(0),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LOG_PAGE_RECORDS)
      .default(LOG_PAGE_RECORDS),
    attempt_id: UuidSchema.optional(),
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

function openRecords(
  deps: LogsDeps,
  op: TaskState['operations'][string],
): LogRecord[] | string {
  try {
    const run = RunDir.open({
      dataDir: deps.dataDir,
      ...runLocation(op),
      redactor: deps.redactor,
      create: false,
    });
    return readAllRecords(run);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
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
  if (s === null || !authorize(caller, { role: 'read', project: s.project }).ok)
    return err({
      code: 'task_not_found',
      message: `no task ${q.data.task_id}`,
      details: {},
    });

  const out: LogEntry[] = [];
  let bytes = 0;
  let cursor = q.data.after;
  let position = 0;
  let total = 0;
  const offsets = new Map<string, number>();
  const cache = new Map<string, LogRecord[] | string>();
  const events = deps.store
    .readEvents(s.id as Uuid)
    .filter((e): e is OutputEvent => e.type === 'OutputIngested');
  for (const e of events) total += e.payload.records;

  for (const e of events) {
    const { operation_id: id, records: count, digest } = e.payload;
    const from = offsets.get(id) ?? 0;
    offsets.set(id, from + count);
    const first = position + 1;
    position += count;
    if (position <= q.data.after) continue;
    if (out.length >= q.data.limit || bytes >= LOG_PAGE_BYTES) break;
    const op = s.operations[id];
    const attemptId = op?.attempt_id ?? null;
    // Another attempt's records are passed over, not hidden: the cursor still counts them, so it stays the
    // task's cursor and a reader can drop the filter and resume from the same place.
    if (q.data.attempt_id !== undefined && attemptId !== q.data.attempt_id) {
      cursor = position;
      continue;
    }
    let loaded = cache.get(id);
    if (loaded === undefined) {
      loaded = op === undefined ? 'operation unknown' : openRecords(deps, op);
      cache.set(id, loaded);
    }
    const batch =
      typeof loaded === 'string' ? null : loaded.slice(from, from + count);
    if (batch === null || hashCanonical(batch) !== digest) {
      // Taken whole: a gap has no records to page through, and the cursor must still move past it.
      out.push({
        seq: position,
        cursor: position,
        operation_id: id,
        attempt_id: attemptId,
        gap: {
          records: position - Math.max(first - 1, q.data.after),
          reason:
            typeof loaded === 'string'
              ? `records unavailable: ${loaded}`
              : 'records no longer match the committed digest',
        },
      });
      cursor = position;
      continue;
    }
    const step =
      op?.attempt_id == null ? null : (s.attempts[op.attempt_id]?.step ?? null);
    for (const [i, r] of batch.entries()) {
      const seq = first + i;
      if (seq <= q.data.after) continue;
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
      bytes += JSON.stringify(r.data).length;
      cursor = seq;
    }
  }
  return ok({
    task_id: s.id,
    records: out,
    next_cursor: cursor,
    // A finished task whose committed records were all read: a follower may stop here.
    complete: s.terminal !== null && cursor >= total,
  });
}
