/**
 * Inbox (T097, FR-024): the open questions of every live task the caller may read, straight from the
 * projected task state. Questions are durable facts of the task log, so the inbox is the same after a
 * daemon restart; no agent is kept alive to wait for the answer.
 */
import { z } from 'zod';
import type { TaskState } from '../domain/state.ts';
import { ok, err, type Result } from '../shared/result.ts';
import type { Uuid } from '../shared/brand.ts';
import type { Store } from '../store/index.ts';
import { authorize, type Caller } from './authz.ts';
import type { AppError } from './queries.ts';

/** Statuses a task can hold an open question in; a terminal task has none left to answer. */
const LIVE = ['PENDING', 'READY', 'RUNNING', 'WAITING'] as const;

export const INBOX_LIMIT = 100;

const InboxQuerySchema = z
  .object({
    kind: z.literal('inbox').optional(),
    project: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(INBOX_LIMIT).optional(),
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

/** `inbox` query: read role; tasks outside the caller's projects are left out, not reported. */
export function inbox(
  store: Store,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
  decider?: { readonly holds: (s: TaskState) => boolean },
): Result<{ items: InboxItem[]; truncated: boolean }, AppError> {
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
  const ids = q.data.task_id === undefined ? store.taskIdsByStatus(LIVE) : [q.data.task_id];
  const items: InboxItem[] = [];
  for (const id of ids) {
    const s = store.readTask(id as Uuid);
    // Both paths: a question of a finished or cancelled task can no longer be answered.
    if (s === null || !(LIVE as readonly string[]).includes(s.status)) continue;
    if (q.data.project !== undefined && s.project !== q.data.project) continue;
    const held = decider?.holds(s) === true;
    items.push(
      ...openQuestions(s).map((item) =>
        held && item.blocking ? { ...item, decider: true as const } : item,
      ),
    );
  }
  items.sort(
    (a, b) => a.task_id.localeCompare(b.task_id) || a.question_id.localeCompare(b.question_id),
  );
  const limit = q.data.limit ?? INBOX_LIMIT;
  return ok({ items: items.slice(0, limit), truncated: items.length > limit });
}
