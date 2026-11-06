/**
 * `task pause` and `task resume` (issue #142). Admission requires the operate role; the engine checks the
 * task can still be paused (not ended, not cancelling, no merge proof) or is paused.
 */
import type { Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import type { Trigger } from '../domain/trigger.ts';
import { acceptError, taskInProject } from './answer.ts';
import { authzContext, type Caller } from './authz.ts';
import type { Admitted, CommandInput } from './commands.ts';
import { taskView, type AppError } from './queries.ts';
import { submit } from './triage.ts';

export type PauseDeps = {
  readonly store: Store;
  readonly now: () => number;
};

function submitOne(
  deps: PauseDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
  trigger: Extract<Trigger, { kind: 'pause' | 'unpause' }>,
): Promise<Result<unknown, AppError>> {
  const found = taskInProject(deps.store, input);
  if (!found.ok) return Promise.resolve(found);
  const s = found.value;
  const r = submit(deps.store, {
    task_id: s.id,
    dedup_key: `cmd:${admitted.record.request_id}:${trigger.kind}`,
    trigger,
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

export function pauseTask(
  deps: PauseDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const { reason, now } = input.payload as { reason: string; now?: boolean };
  return submitOne(deps, admitted, input, caller, {
    kind: 'pause',
    reason,
    ...(now === true ? { now } : {}),
  });
}

export function resumeTask(
  deps: PauseDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  return submitOne(deps, admitted, input, caller, { kind: 'unpause' });
}
