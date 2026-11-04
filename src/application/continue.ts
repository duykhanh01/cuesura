/**
 * `task continue` (issue #101). Admission already required the admin role: keeping a task on its
 * current model after its quality loop ran out is a policy decision an assistant or worker token
 * cannot make. The engine checks the task still waits on a continuable limit.
 */
import type { Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import { acceptError, taskInProject } from './answer.ts';
import { authzContext, type Caller } from './authz.ts';
import type { Admitted, CommandInput } from './commands.ts';
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
  const d = r.value.decision;
  if (d.kind === 'rejected')
    return Promise.resolve(
      err({
        code: d.code,
        message: d.code,
        details: { reason: d.code, detail: d.detail ?? null },
      }),
    );
  return Promise.resolve(ok({ task: after === null ? null : taskView(after) }));
}
