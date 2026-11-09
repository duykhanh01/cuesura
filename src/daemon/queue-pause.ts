/**
 * `cusr queue pause` / `cusr queue resume` (issue #142): no task that has not started yet is queued for
 * or granted the execution slot; started tasks go on. The pause lives in one file of the data dir, so
 * it survives a restart without a store migration. A file that cannot be read is taken as paused, so
 * a damaged pause never lets new work start by accident.
 */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../shared/canonical-json.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Admitted } from '../application/commands.ts';
import type { Caller } from '../application/authz.ts';
import type { CommandInput } from '../application/commands.ts';
import type { AppError } from '../application/queries.ts';

export const QUEUE_PAUSE_FILE = 'queue-paused.json';

/** Request IDs remembered as applied; far more than any client retries after a crash. */
const APPLIED_KEPT = 256;

const QueuePauseSchema = z.object({ reason: z.string(), by: z.string(), at: z.number() }).strict();
export type QueuePause = z.infer<typeof QueuePauseSchema>;

const QueueStateSchema = z
  .object({ paused: QueuePauseSchema.nullable(), applied: z.array(z.string()) })
  .strict();
type QueueState = z.infer<typeof QueueStateSchema>;

function readState(dataDir: string): QueueState {
  let text: string;
  try {
    text = readFileSync(join(dataDir, QUEUE_PAUSE_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { paused: null, applied: [] };
    return {
      paused: { reason: `pause file unreadable: ${(e as Error).message}`, by: 'unknown', at: 0 },
      applied: [],
    };
  }
  try {
    const parsed = QueueStateSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // Falls through to the unreadable pause below.
  }
  return { paused: { reason: 'pause file malformed', by: 'unknown', at: 0 }, applied: [] };
}

/** The pause in force, or null when new tasks may start. */
export function readQueuePause(dataDir: string): QueuePause | null {
  return readState(dataDir).paused;
}

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** temp → fsync → rename → fsync directory, owner-only. */
function writeState(dataDir: string, state: QueueState): void {
  const file = join(dataDir, QUEUE_PAUSE_FILE);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${canonicalJson(state)}\n`, { mode: 0o600 });
  fsyncPath(tmp);
  renameSync(tmp, file);
  fsyncPath(dataDir);
}

export type QueueDeps = { readonly dataDir: string; readonly now: () => number };

type Handler = (
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
) => Promise<Result<unknown, AppError>>;

function fsError(e: unknown): AppError {
  return {
    code: 'write_failed',
    message: `queue pause file: ${(e as Error).message}`,
    details: {},
  };
}

/**
 * The file records the request IDs it applied, and is rewritten rather than removed: a request run
 * again after a crash before its ledger row completed finds its ID and changes nothing, so it never
 * undoes a later pause or resume. A second pause keeps the first one's reason, as `task pause` does;
 * `changed` tells the caller whether this request paused or resumed the queue (issue #260).
 */
export function queueCommands(deps: QueueDeps): { queue_pause: Handler; queue_resume: Handler } {
  const apply = (
    requestId: string,
    next: (current: QueuePause | null) => QueuePause | null,
  ): Promise<Result<unknown, AppError>> => {
    const state = readState(deps.dataDir);
    if (state.applied.includes(requestId))
      return Promise.resolve(ok({ changed: false, queue: { paused: state.paused } }));
    const paused = next(state.paused);
    try {
      writeState(deps.dataDir, {
        paused,
        applied: [...state.applied, requestId].slice(-APPLIED_KEPT),
      });
    } catch (e) {
      return Promise.resolve(err(fsError(e)));
    }
    return Promise.resolve(
      ok({ changed: (state.paused === null) !== (paused === null), queue: { paused } }),
    );
  };
  return {
    queue_pause: (admitted, input, caller) =>
      apply(
        admitted.record.request_id,
        (current) =>
          current ?? {
            reason: (input.payload as { reason: string }).reason,
            by: caller.grant.actor,
            at: deps.now(),
          },
      ),
    queue_resume: (admitted) => apply(admitted.record.request_id, () => null),
  };
}
