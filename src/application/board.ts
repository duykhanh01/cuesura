/**
 * `task_board` (FR-005–FR-008, EC-005, R-02, R-06): one read for a list screen polled every second. An
 * unchanged watermark ends the read before any task is opened, so an idle session costs next to nothing.
 * Counts and the queue come from SQL. Only tasks still running are read for attention; a finished task's
 * state is read only while it is on the page being viewed, so the board does not slow down as they pile up.
 */
import { z } from 'zod';
import {
  TASK_STATUSES,
  TERMINAL_STATUSES,
  isTerminal,
  type TaskState,
  type TaskStatus,
} from '../domain/state.ts';
import { applyInPlace } from '../engine/evolve.ts';
import { effectUnknownDueAt, needsUser } from '../explain/needs-user.ts';
import { UuidSchema, type Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import type { Caller } from './authz.ts';
import type { AppError, QueuePauseReader } from './queries.ts';
import { BOARD_LIMIT } from './limits.ts';
import { queuePausedView } from '../explain/explain.ts';

export { BOARD_LIMIT };
export const ATTENTION_LIMIT = 200;
/** Entries remembered for `status_since`; losing them only makes the next read slower. */
const STATUS_SINCE_ENTRIES = 5_000;

const ACTIVE_STATUSES = TASK_STATUSES.filter((s) => !isTerminal(s));
const SCOPES = {
  active: ACTIVE_STATUSES,
  terminal: TERMINAL_STATUSES,
  all: TASK_STATUSES,
} as const;

const BoardSchema = z
  .object({
    kind: z.literal('task_board'),
    project: z.string().min(1).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    scope: z.enum(['active', 'terminal', 'all']).optional(),
    limit: z.number().int().min(1).max(BOARD_LIMIT).default(BOARD_LIMIT),
    cursor: UuidSchema.optional(),
    order: z.enum(['oldest', 'newest']).default('oldest'),
    if_changed_since: z.number().int().nonnegative().optional(),
  })
  .strict();

/** When a task entered its current status; `null` when the log cannot say. */
export type StatusSince = (s: TaskState) => number | null;

/**
 * Finds the newest event that changed the status and takes the time from the trigger that caused it:
 * events have no time of their own (R-06). Remembered per task and version, since a version never changes
 * its answer; a restart only makes the first read slower.
 */
export function statusSinceReader(store: Store): StatusSince {
  const known = new Map<string, { readonly version: number; readonly since: number | null }>();
  return (s) => {
    const cached = known.get(s.id);
    if (cached?.version === s.version) return cached.since;
    let state: TaskState | null = null;
    let dedupKey: string | null = null;
    for (const e of store.readEvents(s.id as Uuid)) {
      const before: TaskStatus | null = state?.status ?? null;
      state = applyInPlace(state, e);
      if (state.status !== before) dedupKey = e.causation.dedup_key;
    }
    const since = dedupKey === null ? null : store.triggerTime(dedupKey);
    if (known.size >= STATUS_SINCE_ENTRIES) known.clear();
    known.set(s.id, { version: s.version, since });
    return since;
  };
}

/** Earliest threshold of the `effect_unknown` waits at each store sequence, read once per sequence. */
const dueCache = new WeakMap<Store, { readonly watermark: number; readonly due: number | null }>();

/**
 * When the first `effect_unknown` wait reaches its threshold, past or future, at this store sequence.
 * `needs_user` of such a wait turns true with time alone, with no event to move the sequence (#249), so a
 * cache keyed on the sequence alone would keep the old answer.
 */
export function effectUnknownDue(
  store: Store,
  statusSince: StatusSince,
  watermark: number,
): number | null {
  const cached = dueCache.get(store);
  if (cached?.watermark === watermark) return cached.due;
  let due: number | null = null;
  for (const id of store.taskIdsByStatus(['WAITING'])) {
    const s = store.readTask(id as Uuid);
    const at = s === null ? null : effectUnknownDueAt(s, () => statusSince(s));
    if (at !== null && (due === null || at < due)) due = at;
  }
  dueCache.set(store, { watermark, due });
  return due;
}

function row(s: TaskState, since: StatusSince, now?: number): Record<string, unknown> {
  return {
    task_id: s.id,
    project: s.project,
    title: s.task.title,
    status: s.status,
    wait_code: s.wait?.detail.code ?? null,
    step: s.current_step,
    step_visits: s.step_visits,
    mode: s.run.mode,
    status_since: since(s),
    version: s.version,
    priority: s.task.priority,
    pr_ref: s.pr_ref,
    needs_user: needsUser(s, now, () => since(s)),
    paused: s.pause ?? null,
  };
}

export type BoardDeps = {
  readonly store: Store;
  readonly statusSince: StatusSince;
  readonly now?: () => number;
  readonly queuePause?: QueuePauseReader;
};

export function taskBoard(
  deps: BoardDeps,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
): Result<unknown, AppError> {
  const q = BoardSchema.safeParse(body);
  if (!q.success)
    return err({
      code: 'invalid_request',
      message: 'invalid task_board query',
      details: {
        issues: q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    });
  const { project, status, scope, limit, cursor, order, if_changed_since } = q.data;
  const { store, statusSince } = deps;
  const now = deps.now?.();
  const watermark = store.lastGlobalSeq();
  // A file outside the store, so the watermark does not move with it: sent with every reply (#256).
  const queuePaused = queuePausedView(deps.queuePause?.() ?? null, now ?? Date.now());
  // An overdue `effect_unknown` wait sends the board in full, so a client never keeps the old answer.
  if (if_changed_since === watermark) {
    const due = effectUnknownDue(store, statusSince, watermark);
    if (due === null || now === undefined || now < due)
      return ok({ unchanged: true, watermark, queue_paused: queuePaused });
  }

  const projects = project === undefined ? null : [project];
  // A status names what the caller wants to see; the default scope must not hide it.
  const inScope: readonly TaskStatus[] = SCOPES[scope ?? (status === undefined ? 'active' : 'all')];
  const statuses = status === undefined ? inScope : inScope.filter((x) => x === status);

  const page = store.taskPage({
    projects,
    statuses,
    ...(cursor === undefined ? {} : { after: cursor }),
    limit: limit + 1,
    order,
  });
  const items = page
    .slice(0, limit)
    .flatMap((id) => store.readTask(id as Uuid) ?? [])
    .map((s) => row(s, statusSince, now));

  const attention: Record<string, unknown>[] = [];
  let truncated = false;
  for (const id of store.taskPage({
    projects,
    statuses: ACTIVE_STATUSES,
    limit: Number.MAX_SAFE_INTEGER,
    order,
  })) {
    const s = store.readTask(id as Uuid);
    if (s === null || !needsUser(s, now, () => statusSince(s))) continue;
    if (attention.length === ATTENTION_LIMIT) {
      truncated = true;
      break;
    }
    attention.push(row(s, statusSince, now));
  }

  return ok({
    unchanged: false,
    watermark,
    counts: {
      by_status: store.countTasksByStatus({
        projects,
        statuses: status === undefined ? TASK_STATUSES : [status],
      }),
    },
    queue: { length: store.queueLength(null) },
    queue_paused: queuePaused,
    attention: { items: attention, truncated },
    items,
    next_cursor: page.length > limit ? (page[limit - 1] as string) : null,
  });
}
