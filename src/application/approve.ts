/**
 * `task approve --kind escalation` (T103, FR-010/FR-028). Admission requires the operate role: the
 * assistant approves a rung the frozen ladder already allows, as it continues a task (#205).
 * The approval is the open escalation request of the task's current revision for exactly this step and
 * rung; the engine then checks it is still open and bound to the policy hash in force. Merge approval
 * and yolo are refused at admission as unsupported and never reach this service, and an approval
 * request of another kind is never granted here.
 */
import type { Approval } from '../domain/state.ts';
import type { Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import { acceptError, taskInProject } from './answer.ts';
import { authzContext, type Caller } from './authz.ts';
import type { Admitted, CommandInput } from './commands.ts';
import { decisionError } from './engine-verdict.ts';
import { taskView, type AppError } from './queries.ts';
import { submit } from './triage.ts';

export type ApproveDeps = {
  readonly store: Store;
  readonly now: () => number;
};

export function approveEscalation(
  deps: ApproveDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  return Promise.resolve(approveSync(deps, admitted, input, caller));
}

function approveSync(
  deps: ApproveDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Result<unknown, AppError> {
  const found = taskInProject(deps.store, input);
  if (!found.ok) return found;
  const s = found.value;
  const { step, rung } = input.payload as { step: string; rung: number };
  const matching = Object.values(s.approvals).filter(
    (a) =>
      a.kind === 'escalation' && a.step === step && a.rung === rung && a.revision === s.revision,
  );
  // The open one if any; else the newest, so a replay or a second request meets the engine's verdict.
  const target: Approval | undefined =
    matching.find((a) => a.status === 'requested' && !a.revoked) ?? matching.at(-1);
  if (target === undefined)
    return err({
      code: 'approval_not_found',
      message: 'no escalation request for this step and rung',
      details: { step, rung, revision: s.revision },
    });
  const r = submit(deps.store, {
    task_id: s.id,
    dedup_key: `cmd:${admitted.record.request_id}:approve`,
    trigger: { kind: 'approve', approval_request_id: target.id as Uuid },
    now: deps.now(),
    ids: admitted.record.assigned_ids,
    expected_version: input.expected_version as number,
    authz: authzContext(caller, deps.now()),
  });
  const after = deps.store.readTask(s.id as Uuid);
  if (!r.ok) return err(acceptError(r.error, after));
  const refused = decisionError(r.value.decision);
  if (refused !== null) return err(refused);
  return ok({
    approval_id: target.id,
    status: after?.approvals[target.id]?.status ?? null,
    policy_hash: target.policy_hash,
    task: after === null ? null : taskView(after),
  });
}
