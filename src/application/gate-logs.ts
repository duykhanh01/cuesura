/**
 * `task_gates` and `task_gate_log`: what each round of gates did and the output of one command, read by
 * byte offset. Logs live beside the effect's receipts, written once and redacted, so nothing here shares
 * the cursors of the agent log. A log that retention removed is a normal state, not an error.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { DomainEvent, EventPayloads } from '../domain/event.ts';
import type { TaskState } from '../domain/state.ts';
import { TOMBSTONE_FILE } from '../daemon/retention.ts';
import { COMMAND_LOG_DIR, COMMAND_RUNNING_FILE } from '../runner/commands.ts';
import { isSafeId } from '../runner/files.ts';
import { UuidSchema, type Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import { authorize, type Caller } from './authz.ts';
import type { AppError } from './queries.ts';

/** Most of one read: a client wanting a whole log pages through it. */
export const GATE_LOG_PAGE_BYTES = 1024 * 1024;
const GATE_LOG_MIN_BYTES = 1024;
const RUNNING_FILE_BYTES = 4096;

/** What `ref` may look like; it comes from an event, and is still a path handed to the filesystem. */
const LOG_REF = new RegExp(`^${COMMAND_LOG_DIR}/[A-Za-z0-9._-]+\\.log$`);

export type GateLogDeps = {
  readonly store: Pick<Store, 'readTask' | 'readEvents'>;
  readonly dataDir: string;
};

const TaskQuerySchema = z.object({ kind: z.literal('task_gates'), task_id: UuidSchema }).strict();

const LogQuerySchema = z
  .object({
    kind: z.literal('task_gate_log'),
    task_id: UuidSchema,
    gate: z.string().min(1),
    /** 1 for the first round of gates; the latest round that ran this gate when left out. */
    round: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
    /** The end of the log instead of `offset`, starting on a whole line. */
    tail: z.boolean().optional(),
    limit: z.number().int().min(GATE_LOG_MIN_BYTES).max(GATE_LOG_PAGE_BYTES).optional(),
  })
  .strict()
  .refine((q) => q.tail !== true || q.offset === undefined, {
    message: 'tail and offset cannot be used together',
  });

type Recorded = EventPayloads['GateResultRecorded'];
type GateRun = Recorded['results'][number];
type RoundEvent = Extract<DomainEvent, { type: 'GateResultRecorded' }>;

export type GateLogState = 'available' | 'expired' | 'missing';

/** Why a log cannot be read, once opening it failed: only a tombstone says it was there and went. */
function goneState(dataDir: string, effect: string): GateLogState {
  return isSafeId(effect) &&
    existsSync(join(dataDir, 'receipts', effect, COMMAND_LOG_DIR, TOMBSTONE_FILE))
    ? 'expired'
    : 'missing';
}

/**
 * A file of an effect as a descriptor, or null. Where the open really landed is checked after it, which
 * holds for every directory on the way and leaves no gap to swap one in. `O_NONBLOCK`: opening a FIFO
 * would otherwise wait for a writer, and hold the whole daemon.
 */
function openEffectFile(dataDir: string, effect: string, ref: string): number | null {
  if (!isSafeId(effect)) return null;
  try {
    const file = join(realpathSync(dataDir), 'receipts', effect, ref);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (fstatSync(fd).isFile() && readlinkSync(`/proc/self/fd/${String(fd)}`) === file) return fd;
    } catch {
      // Closed below, as for anything that is not the log.
    }
    closeSync(fd);
    return null;
  } catch {
    return null;
  }
}

const openLog = (dataDir: string, effect: string, ref: string): number | null =>
  LOG_REF.test(ref) ? openEffectFile(dataDir, effect, ref) : null;

const RunningSchema = z.object({
  gate: z.string(),
  role: z.string(),
  started_at: z.number(),
  last_output_at: z.number().nullable(),
});

/** The command of a gate effect in progress. A torn or absent file is the same as nothing running. */
function runningGate(dataDir: string, state: TaskState): z.infer<typeof RunningSchema> | null {
  const effect = Object.values(state.effects).find(
    (e) => e.kind === 'run_gates' && e.status === 'started',
  );
  if (effect === undefined) return null;
  const fd = openEffectFile(dataDir, effect.id, COMMAND_RUNNING_FILE);
  if (fd === null) return null;
  try {
    const buffer = Buffer.alloc(RUNNING_FILE_BYTES);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const parsed = RunningSchema.safeParse(JSON.parse(buffer.toString('utf8', 0, read)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function logState(dataDir: string, effect: string, run: GateRun): GateLogState {
  if (run.log === undefined) return 'missing';
  const fd = openLog(dataDir, effect, run.log.ref);
  if (fd === null) return goneState(dataDir, effect);
  closeSync(fd);
  return 'available';
}

const isContinuation = (byte: number): boolean => (byte & 0xc0) === 0x80;

/** Length of `b` without a character that the end of the read cut. */
function wholeCharacters(b: Buffer): number {
  for (let back = 1; back <= Math.min(4, b.length); back++) {
    const byte = b[b.length - back] as number;
    if (isContinuation(byte)) continue;
    const size = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return size > back ? b.length - back : b.length;
  }
  return b.length;
}

function followsLineEnd(fd: number, offset: number): boolean {
  const before = Buffer.alloc(1);
  readSync(fd, before, 0, 1, offset - 1);
  return before[0] === 0x0a;
}

export type GateLogPage = {
  readonly text: string;
  readonly offset: number;
  readonly next_offset: number;
  readonly size: number;
  readonly complete: boolean;
};

function readPage(fd: number, q: { offset: number; tail: boolean; limit: number }): GateLogPage {
  const size = fstatSync(fd).size;
  const wanted = q.tail ? Math.max(0, size - q.limit) : Math.min(q.offset, size);
  const buffer = Buffer.alloc(Math.min(q.limit, size - wanted));
  const read = readSync(fd, buffer, 0, buffer.length, wanted);
  let bytes = buffer.subarray(0, read);
  let offset = wanted;
  const drop = (count: number): void => {
    offset += count;
    bytes = bytes.subarray(count);
  };
  if (q.tail && offset > 0 && !followsLineEnd(fd, offset)) {
    const line = bytes.indexOf(0x0a);
    // A last line longer than the read has no start here, and its end is what the reader came for.
    if (line >= 0 && line + 1 < bytes.length) drop(line + 1);
  }
  let partial = 0;
  while (partial < 3 && isContinuation(bytes[partial] ?? 0)) partial += 1;
  drop(partial);
  const end = offset + bytes.length;
  if (end < size) bytes = bytes.subarray(0, wholeCharacters(bytes));
  const next = offset + bytes.length;
  return {
    text: bytes.toString('utf8'),
    offset,
    next_offset: next,
    size,
    complete: next >= size,
  };
}

const invalid = (message: string, issues: z.ZodError): Result<never, AppError> =>
  err({
    code: 'invalid_request',
    message,
    details: { issues: issues.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
  });

function rounds(store: GateLogDeps['store'], taskId: string): readonly RoundEvent[] {
  return store
    .readEvents(taskId as Uuid)
    .filter((e): e is RoundEvent => e.type === 'GateResultRecorded');
}

const unknownTask = (taskId: string): Result<never, AppError> =>
  err({ code: 'task_not_found', message: `no task ${taskId}`, details: {} });

export function taskGates(
  deps: GateLogDeps,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
): Result<unknown, AppError> {
  const q = TaskQuerySchema.safeParse(body);
  if (!q.success) return invalid('invalid task_gates query', q.error);
  const state = deps.store.readTask(q.data.task_id);
  if (state === null || !authorize(caller, { role: 'read' }).ok) return unknownTask(q.data.task_id);
  return ok({
    task_id: q.data.task_id,
    running: runningGate(deps.dataDir, state),
    rounds: rounds(deps.store, q.data.task_id).map(({ payload }, i) => ({
      round: i + 1,
      step: payload.step,
      visit: payload.visit,
      passed: payload.passed,
      gates: payload.results.map((run) => ({
        gate: run.gate,
        passed: run.passed,
        log: logState(deps.dataDir, payload.effect_id, run),
        ...(run.log === undefined
          ? {}
          : {
              bytes: run.log.bytes,
              truncated: run.log.truncated,
              ...(run.log.wall_ms === undefined ? {} : { wall_ms: run.log.wall_ms }),
            }),
      })),
    })),
  });
}

export function taskGateLog(
  deps: GateLogDeps,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
): Result<unknown, AppError> {
  const q = LogQuerySchema.safeParse(body);
  if (!q.success) return invalid('invalid task_gate_log query', q.error);
  const { task_id, gate, round, offset, tail, limit } = q.data;
  if (deps.store.readTask(task_id) === null || !authorize(caller, { role: 'read' }).ok)
    return unknownTask(task_id);

  const all = rounds(deps.store, task_id);
  const at =
    round === undefined
      ? all.findLastIndex((e) => e.payload.results.some((r) => r.gate === gate))
      : round - 1;
  const payload = all[at]?.payload;
  const run = payload?.results.find((r) => r.gate === gate);
  if (payload === undefined || run === undefined)
    return err({
      code: 'gate_not_found',
      message:
        round === undefined
          ? `task ${task_id} has not run a gate named ${JSON.stringify(gate)}`
          : `round ${String(round)} of task ${task_id} has no gate named ${JSON.stringify(gate)}`,
      // The gates that did run (in the asked round, or in any), so a mistyped name can be corrected.
      details: {
        gates: [
          ...new Set(
            (round === undefined ? all : all.slice(at, at + 1)).flatMap((e) =>
              e.payload.results.map((r) => r.gate),
            ),
          ),
        ],
      },
    });

  const facts = { task_id, gate, round: at + 1, passed: run.passed };
  const fd = run.log === undefined ? null : openLog(deps.dataDir, payload.effect_id, run.log.ref);
  if (fd === null)
    return ok({
      ...facts,
      state: run.log === undefined ? 'missing' : goneState(deps.dataDir, payload.effect_id),
    });
  try {
    return ok({
      ...facts,
      state: 'available',
      bytes: run.log?.bytes,
      truncated: run.log?.truncated,
      digest: run.log?.digest,
      ...readPage(fd, {
        offset: offset ?? 0,
        tail: tail === true,
        limit: limit ?? GATE_LOG_PAGE_BYTES,
      }),
    });
  } finally {
    closeSync(fd);
  }
}
