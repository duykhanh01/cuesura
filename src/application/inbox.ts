/**
 * Inbox (T097, FR-024): the open questions of every live task the caller may read, straight from the
 * projected task state, and the tasks that wait on the user without a question (#256): a paused task,
 * an escalation, a config to fix. Both are durable facts of the task log, so the inbox is the same after
 * a daemon restart; no agent is kept alive to wait for the answer.
 */
import { z } from 'zod';
import { TASK_STATUSES, type TaskPause, type TaskState } from '../domain/state.ts';
import { allowedActions, answerCommand, type AllowedAction } from '../explain/allowed-actions.ts';
import { queuePausedView, type QueuePausedView } from '../explain/explain.ts';
import { needsUser } from '../explain/needs-user.ts';
import { ok, err, type Result } from '../shared/result.ts';
import { UuidSchema, type Uuid } from '../shared/brand.ts';
import type { Store } from '../store/index.ts';
import { authorize, type Caller } from './authz.ts';
import type { AppError, QueuePauseReader } from './queries.ts';
import { recheckTarget } from './recheck.ts';

/** Statuses a task can hold an open question in; a terminal task has none left to answer. */
const LIVE = ['PENDING', 'READY', 'RUNNING', 'WAITING'] as const;

export const INBOX_LIMIT = 100;

const InboxQuerySchema = z
  .object({
    kind: z.literal('inbox').optional(),
    project: z.string().min(1).optional(),
    task_id: UuidSchema.optional(),
    limit: z.number().int().min(1).max(INBOX_LIMIT).optional(),
    /** `next_after` of the previous page: the items after this `(task_id, question_id)` key. */
    after: z
      .string()
      .regex(/^[0-9a-f-]{36}:([0-9a-f-]{36})?$/)
      .optional(),
  })
  .strict();

export type InboxItem = {
  readonly question_id: string;
  readonly task_id: string;
  readonly project: string;
  readonly title: string;
  readonly revision: number;
  readonly step: string | null;
  readonly attempt_id: string | null;
  readonly body: string;
  /** What the question is waiting on: `true` while the task waits for exactly this answer. */
  readonly blocking: boolean;
  readonly wait_code: string | null;
  /** The version an `answer` command must send as `expected_version`. */
  readonly task_version: number;
  /** Set while the decider may still answer this question; a person's answer still wins. */
  readonly decider?: true;
};

/** Open questions of one task in the order they were asked; questions of an older revision never show. */
export function openQuestions(s: TaskState): InboxItem[] {
  return Object.values(s.questions)
    .filter((q) => q.status === 'open' && q.revision === s.revision)
    .map((q) => ({
      question_id: q.id,
      task_id: s.id,
      project: s.project,
      title: s.task.title,
      revision: q.revision,
      step: q.step,
      attempt_id: q.attempt_id,
      body: q.body,
      blocking: s.status === 'WAITING' && s.wait?.detail['question_id'] === q.id,
      wait_code: s.wait?.detail.code ?? null,
      task_version: s.version,
    }));
}

export type InboxEntry =
  | (InboxItem & { readonly kind: 'question'; readonly next: AllowedAction })
  | {
      readonly kind: 'wait';
      readonly question_id: null;
      readonly task_id: string;
      readonly project: string;
      readonly title: string;
      readonly revision: number;
      readonly step: string | null;
      readonly status: string;
      readonly wait_code: string;
      readonly task_version: number;
      readonly paused: TaskPause | null;
      /** The first way out `task explain` lists under allowed_actions; read the rest there. */
      readonly next: AllowedAction | null;
    };

export type InboxReply = {
  items: InboxEntry[];
  truncated: boolean;
  /** Pass as `after` to read the next page; null on the last one. */
  next_after: string | null;
  /** A paused queue holds every task that has not started, though none of them is listed here. */
  queue_paused: QueuePausedView | null;
};

export type InboxDeps = {
  readonly decider?: { readonly holds: (s: TaskState) => boolean };
  readonly now?: number;
  /** When the task entered its status, for a wait recorded without its own start (#249). */
  readonly statusSince?: (s: TaskState) => number | null;
  readonly queuePause?: QueuePauseReader;
  /** Projects the config declares; null when it cannot be read, and then no project is refused. */
  readonly projects?: readonly string[] | null;
};

const key = (e: { task_id: string; question_id: string | null }): string =>
  `${e.task_id}:${e.question_id ?? ''}`;

function answerAction(q: InboxItem): AllowedAction {
  return {
    action: 'answer',
    command: answerCommand(q.question_id, q.task_version),
    note: q.blocking
      ? 'The task waits for exactly this answer.'
      : 'The task does not wait on this question now; an answer is still recorded.',
    requires: 'operate',
  };
}

/**
 * The first way out `task explain` lists, with or without a command: skipping one without a command
 * (add acceptance criteria, fix the config) would offer what comes after it, often cancel.
 */
export function nextAction(s: TaskState, queuePaused: boolean): AllowedAction | null {
  return allowedActions(s, { recheckable: recheckTarget(s) !== null, queuePaused })[0] ?? null;
}

function entries(s: TaskState, deps: InboxDeps, queuePaused: boolean): InboxEntry[] {
  const held = deps.decider?.holds(s) === true;
  const questions: InboxEntry[] = openQuestions(s).map((item) => ({
    ...(held && item.blocking ? { ...item, decider: true as const } : item),
    kind: 'question',
    next: answerAction(item),
  }));
  if (
    questions.some((q) => q.kind === 'question' && q.blocking) ||
    !needsUser(s, deps.now, () => deps.statusSince?.(s) ?? null)
  )
    return questions;
  return [
    {
      kind: 'wait',
      question_id: null,
      task_id: s.id,
      project: s.project,
      title: s.task.title,
      revision: s.revision,
      step: s.current_step,
      status: s.status,
      wait_code: s.wait?.detail.code ?? 'run_config_unconfirmed',
      task_version: s.version,
      paused: s.pause ?? null,
      next: nextAction(s, queuePaused),
    },
    ...questions,
  ];
}

/** `inbox` query: read role; tasks outside the caller's projects are left out, not reported. */
export function inbox(
  store: Store,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
  deps: InboxDeps = {},
): Result<InboxReply, AppError> {
  const q = InboxQuerySchema.safeParse(body);
  if (!q.success)
    return err({
      code: 'invalid_request',
      message: 'invalid inbox query',
      details: {
        issues: q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    });
  const allowed = authorize(caller, { role: 'read' });
  if (!allowed.ok)
    return err({
      code: 'forbidden',
      message: 'inbox not readable',
      details: { ...allowed.error },
    });
  const { task_id, project, after } = q.data;
  // A typo in a filter must not read as "nothing waits".
  if (task_id !== undefined && store.readTask(task_id) === null)
    return err({ code: 'task_not_found', message: `no task ${task_id}`, details: {} });
  if (
    project !== undefined &&
    deps.projects != null &&
    !deps.projects.includes(project) &&
    store.taskPage({ projects: [project], statuses: [...TASK_STATUSES], limit: 1 }).length === 0
  )
    return err({
      code: 'not_found',
      message: `no project ${project}`,
      details: { projects: [...deps.projects].sort() },
    });
  const pause = queuePausedView(deps.queuePause?.() ?? null, deps.now ?? Date.now());
  const ids = task_id === undefined ? store.taskIdsByStatus(LIVE) : [task_id];
  const items: InboxEntry[] = [];
  for (const id of ids) {
    const s = store.readTask(id as Uuid);
    // Both paths: a question of a finished or cancelled task can no longer be answered.
    if (s === null || !(LIVE as readonly string[]).includes(s.status)) continue;
    if (project !== undefined && s.project !== project) continue;
    items.push(...entries(s, deps, pause !== null));
  }
  const page = items
    .filter((e) => after === undefined || key(e) > after)
    .sort((a, b) => key(a).localeCompare(key(b)));
  const limit = q.data.limit ?? INBOX_LIMIT;
  const shown = page.slice(0, limit);
  const truncated = page.length > limit;
  const last = shown.at(-1);
  return ok({
    items: shown,
    truncated,
    next_after: truncated && last !== undefined ? key(last) : null,
    queue_paused: pause,
  });
}
