/**
 * `task continue` (issue #101). Admission requires the operate role, so an assistant may keep a task
 * on its current model; the engine checks the task still waits on a continuable limit, and the ladder,
 * floor, budget and deadline stay as frozen.
 */
import type { Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import { acceptError, taskInProject } from './answer.ts';
import { authzContext, type Caller } from './authz.ts';
import type { Admitted, CommandInput } from './commands.ts';
import { decisionError } from './engine-verdict.ts';
import { taskView, type AppError } from './queries.ts';
import { submit } from './triage.ts';

export type ContinueDeps = {
  readonly store: Store;
  readonly now: () => number;
};

export function continueTask(
  deps: ContinueDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const found = taskInProject(deps.store, input);
  if (!found.ok) return Promise.resolve(found);
  const s = found.value;
  const r = submit(deps.store, {
    task_id: s.id,
    dedup_key: `cmd:${admitted.record.request_id}:continue`,
    trigger: { kind: 'continue' },
    now: deps.now(),
    ids: admitted.record.assigned_ids,
    expected_version: input.expected_version as number,
    authz: authzContext(caller, deps.now()),
  });
  const after = deps.store.readTask(s.id as Uuid);
  if (!r.ok) return Promise.resolve(err(acceptError(r.error, after)));
  const refused = decisionError(r.value.decision);
  if (refused !== null) return Promise.resolve(err(refused));
  return Promise.resolve(ok({ task: after === null ? null : taskView(after) }));
}
