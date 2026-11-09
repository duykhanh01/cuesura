/**
 * `task_progress` (FR-011, FR-022): where a task stands in the graph it froze, built from committed data
 * only. `past` says a step ran, not that it passed; the outcome lives in its attempts and evidence. A step
 * the chosen mode leaves out is `not_required`, which a reader must never take for a step that passed.
 */
import { z } from 'zod';
import type { TaskState } from '../domain/state.ts';
import { isSpecialTarget, type Workflow } from '../domain/workflow.ts';
import { modeGraph, SOFTWARE_DEV } from '../engine/workflows/software-dev.ts';
import { needsUser } from '../explain/needs-user.ts';
import { UuidSchema, type Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import { authorize, type Caller } from './authz.ts';
import type { AppError } from './queries.ts';
import { badTaskId } from './task-id.ts';

const QuerySchema = z.object({ kind: z.literal('task_progress'), task_id: UuidSchema }).strict();

/** Depth first from the start, following outcomes in declared order: the straight path comes first. */
function walk(w: Workflow): string[] {
  const seen = new Set<string>();
  const visit = (name: string): void => {
    const step = w.steps[name];
    if (step === undefined || seen.has(name)) return;
    seen.add(name);
    for (const target of Object.values(step.next)) if (!isSpecialTarget(target)) visit(target);
  };
  visit(w.start);
  return [...seen];
}

const FULL_REVIEW_STEPS = walk(modeGraph(SOFTWARE_DEV, 'full-review'));

function stepsOf(s: TaskState, frozen: Workflow) {
  const reachable = walk(frozen);
  // Steps of the full graph the frozen one lacks are shown in place, as not required.
  const names =
    s.run.mode === null
      ? reachable
      : [...FULL_REVIEW_STEPS, ...reachable.filter((n) => !FULL_REVIEW_STEPS.includes(n))];
  return names.map((name) => {
    const visits = s.step_visits[name] ?? 0;
    return {
      name,
      state: !reachable.includes(name)
        ? 'not_required'
        : name === s.current_step
          ? 'current'
          : visits > 0
            ? 'past'
            : 'remaining',
      visits,
    };
  });
}

/** Prepare records where it put the worktree; the task itself only keeps the tree it saw there. */
function worktreePath(store: Store, s: TaskState): string | null {
  if (s.wait?.detail.code !== 'worktree_changed') return null;
  for (const mirror of Object.values(s.effects)) {
    if (
      mirror.kind !== 'prepare' ||
      mirror.revision !== s.revision ||
      mirror.status !== 'succeeded'
    )
      continue;
    const result = store.readEffect(mirror.id)?.result as
      | { readonly worktree_ref?: unknown }
      | undefined;
    const ref = result?.worktree_ref;
    if (typeof ref === 'string') return ref;
  }
  return null;
}

export function taskProgress(
  store: Store,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
  now?: number,
  statusSince?: (s: TaskState) => number | null,
): Result<unknown, AppError> {
  const q = QuerySchema.safeParse(body);
  if (!q.success) return err(badTaskId(body));
  const s = store.readTask(q.data.task_id);
  if (s === null || !authorize(caller, { role: 'read' }).ok)
    return err({
      code: 'task_not_found',
      message: `no task ${q.data.task_id}`,
      details: {},
    });
  const policy =
    s.policy_ref === null ? null : store.readPolicy(s.id as Uuid, s.policy_ref.revision);
  return ok({
    task_id: s.id,
    version: s.version,
    mode: s.run.mode,
    steps: policy === null ? null : stepsOf(s, policy.workflow),
    reason: policy === null ? 'not_frozen' : null,
    needs_user: needsUser(s, now, statusSince && (() => statusSince(s))),
    worktree_path: worktreePath(store, s),
  });
}
