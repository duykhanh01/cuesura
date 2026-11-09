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
import type { Trigger } from '../domain/trigger.ts';
import { decisionError } from './engine-verdict.ts';
import { taskView, type AppError } from './queries.ts';
import { submit } from './triage.ts';

export type ContinueDeps = {
  readonly store: Store;
  readonly now: () => number;
};

function submitTrigger(
  deps: ContinueDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
  trigger: Trigger,
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
  const refused = decisionError(r.value.decision);
  if (refused !== null) return Promise.resolve(err(refused));
  return Promise.resolve(ok({ task: after === null ? null : taskView(after) }));
}

export function continueTask(
  deps: ContinueDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  return submitTrigger(deps, admitted, input, caller, { kind: 'continue' });
}

/** `task fail` (007, FR-032): the payload carries the reason the task ends with. */
export function failWaitingTask(
  deps: ContinueDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const { reason } = input.payload as { reason: string };
  return submitTrigger(deps, admitted, input, caller, { kind: 'fail', reason });
}

/** `task waive` (007, FR-045): the evidence is redacted before it is stored. */
export function waiveTask(
  deps: ContinueDeps & { readonly redact?: (text: string) => string },
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const p = input.payload as Extract<Trigger, { kind: 'waive' }>;
  return submitTrigger(deps, admitted, input, caller, {
    kind: 'waive',
    target: p.target,
    evidence: deps.redact?.(p.evidence) ?? p.evidence,
  });
}
