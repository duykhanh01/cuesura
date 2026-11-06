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
import { needsUser } from '../explain/needs-user.ts';
import { UuidSchema, type Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import type { Caller } from './authz.ts';
import type { AppError } from './queries.ts';

export const BOARD_LIMIT = 100;
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

function row(s: TaskState, since: StatusSince): Record<string, unknown> {
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
    needs_user: needsUser(s),
  };
}

export type BoardDeps = {
  readonly store: Store;
  readonly statusSince: StatusSince;
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
  const watermark = store.lastGlobalSeq();
  if (if_changed_since === watermark) return ok({ unchanged: true, watermark });

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
    .map((s) => row(s, statusSince));

  const attention: Record<string, unknown>[] = [];
  let truncated = false;
  for (const id of store.taskPage({
    projects,
    statuses: ACTIVE_STATUSES,
    limit: Number.MAX_SAFE_INTEGER,
    order,
  })) {
    const s = store.readTask(id as Uuid);
    if (s === null || !needsUser(s)) continue;
    if (attention.length === ATTENTION_LIMIT) {
      truncated = true;
      break;
    }
    attention.push(row(s, statusSince));
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
    attention: { items: attention, truncated },
    items,
    next_cursor: page.length > limit ? (page[limit - 1] as string) : null,
  });
}
