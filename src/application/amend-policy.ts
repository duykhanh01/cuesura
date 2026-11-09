/**
 * `task amend-policy` (issue #105): after a task's quality loop ran out, the owner picks another model
 * for the waiting step and the task goes on from there, with its worktree, evidence and history. The
 * change is a `PolicyAmended` event carrying policy version + 1 and a new hash; nothing is rewritten.
 *
 * Two steps, so the owner sees what changes before it does: the `amend_policy_preview` query builds the
 * amended policy and returns its hash, and the `task_amend_policy` command (admin) rebuilds it and
 * submits it only when the hash is the one previewed. The new binding sits on the rung the step would
 * run next: inserted above the current rung when the step was raising, or in place of the current rung
 * when it was not (a step out of visits). The rung's state follows the escalation rules of the task's
 * profile in the user config: a model outside `allow_models` is refused, a tier above
 * `auto_up_to_tier` needs the usual escalation approval or is refused when `above: deny`.
 */
import { z } from 'zod';
import { validateConfig } from '../config/validate.ts';
import type { ModelInfo } from '../domain/config.ts';
import {
  bindingName,
  EFFORTS,
  type AuthzContext,
  type Binding,
  type Effort,
  type FrozenPolicy,
  type RungState,
} from '../domain/policy.ts';
import type { DetailCode, TaskState } from '../domain/state.ts';
import { continuable } from '../engine/continue.ts';
import { targetRung } from '../engine/escalation.ts';
import { stepVisitLimit } from '../engine/interpreter.ts';
import { proposeAmendment } from '../policy/amendment.ts';
import { computeFloorMaps, levelOf, rungState, type EscalationPolicy } from '../policy/ladder.ts';
import { HashSchema, UuidSchema, type Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import { acceptError, taskInProject } from './answer.ts';
import { authorize, authzContext, type Caller } from './authz.ts';
import type { Admitted, CommandInput } from './commands.ts';
import type { ConfirmDeps } from './confirm.ts';
import { decisionError } from './engine-verdict.ts';
import { taskView, type AppError } from './queries.ts';
import { submit } from './triage.ts';

export type ModelChange = { model: string; effort?: Effort | undefined; reason: string };

export type AmendPlan = {
  readonly policy: FrozenPolicy;
  readonly diff: {
    readonly step: string;
    readonly wait_code: DetailCode;
    readonly rung: number;
    readonly placement: 'insert' | 'replace';
    readonly from: string | null;
    readonly to: string;
    readonly state: RungState;
    readonly max_escalations?: { from: number | null; to: number };
    readonly extra_visits?: Record<string, { from: number; to: number }>;
  };
};

export type PlanError = {
  code: 'conflict' | 'invalid_request' | 'rejected';
  reason:
    | 'amend_not_applicable'
    | 'unknown_model'
    | 'model_denied'
    | 'unchanged'
    | 'not_effective'
    | 'invalid_policy';
  detail: string;
};

const fail = (code: PlanError['code'], reason: PlanError['reason'], detail: string) =>
  err<PlanError>({ code, reason, detail });

/**
 * Builds the amended policy for `change` from the task's state and current policy. Pure: the same
 * inputs give the same policy and hash, which is what binds a confirmation to its preview.
 */
export function planModelAmendment(input: {
  state: TaskState;
  current: FrozenPolicy;
  change: ModelChange;
  models: Record<string, ModelInfo>;
  escalation: EscalationPolicy;
  authz: AuthzContext;
}): Result<AmendPlan, PlanError> {
  const { state: s, current, change, models } = input;
  const waiting = continuable(s);
  if (waiting === null)
    return fail(
      'conflict',
      'amend_not_applicable',
      'the task is not waiting on ladder_exhausted, rung_denied, escalations_exhausted or loop_exhausted',
    );
  const { step, code } = waiting;
  const sp = current.steps[step];
  if (sp === undefined)
    return fail('conflict', 'amend_not_applicable', `step '${step}' runs no agent`);
  const info = models[change.model];
  if (info === undefined)
    return fail('invalid_request', 'unknown_model', `model '${change.model}' is not configured`);

  const cur = s.rungs.by_step[step] ?? 0;
  const target = targetRung(s, sp, step).rung;
  const insert = target > cur;
  const base = (sp.ladder[cur] ?? sp.ladder[sp.ladder.length - 1])!.binding;
  const binding: Binding = {
    ...base,
    harness: info.harness,
    model: change.model,
    model_id: info.id,
    effort: change.effort ?? base.effort,
  };
  const replaced = insert ? null : (sp.ladder[target]?.binding ?? null);
  if (replaced !== null && bindingName(replaced) === bindingName(binding))
    return fail(
      'invalid_request',
      'unchanged',
      `step '${step}' already runs ${bindingName(binding)}; use task continue to keep it`,
    );
  const level = levelOf(binding, models);
  // Rung 0 is auto only because the profile accepted it at freeze; an amended binding never is.
  const state = rungState(Math.max(target, 1), binding, level, input.escalation);
  if (state === 'denied')
    return fail(
      'rejected',
      'model_denied',
      `the profile denies ${bindingName(binding)} (allow_models or escalation.above: deny)`,
    );

  const ladder = [...sp.ladder];
  ladder.splice(target, insert ? 0 : 1, { binding, level, state });
  const steps = structuredClone(current.steps);
  steps[step] = { ...sp, ladder };
  const floors = computeFloorMaps(
    Object.fromEntries(Object.entries(steps).map(([n, x]) => [n, x.ladder])),
  );
  for (const [n, x] of Object.entries(steps)) x.floor_map = floors[n] ?? {};

  // Like `task continue`, every visited step keeps at least one round of quality tries.
  const limits = structuredClone(current.limits);
  const tries = current.limits.classes.quality_tries_per_rung;
  const visits: Record<string, { from: number; to: number }> = {};
  for (const [name, used] of Object.entries(s.step_visits)) {
    const limit = stepVisitLimit(current, s, name);
    if (limit === null || used + tries <= limit) continue;
    const from = limits.extra_visits[name] ?? 0;
    limits.extra_visits[name] = from + used + tries - limit;
    visits[name] = { from, to: limits.extra_visits[name] };
  }
  const esc = s.budget.escalations;
  let maxEscalations: { from: number | null; to: number } | undefined;
  if (insert && esc.limit !== null && esc.used >= esc.limit) {
    maxEscalations = { from: current.limits.max_escalations, to: esc.used + 1 };
    limits.max_escalations = esc.used + 1;
  }

  const diff: AmendPlan['diff'] = {
    step,
    wait_code: code,
    rung: target,
    placement: insert ? 'insert' : 'replace',
    from: replaced === null ? null : bindingName(replaced),
    to: bindingName(binding),
    state,
    ...(maxEscalations === undefined ? {} : { max_escalations: maxEscalations }),
    ...(Object.keys(visits).length === 0 ? {} : { extra_visits: visits }),
  };
  const amended = proposeAmendment({
    current,
    change: { steps, limits },
    reason: change.reason,
    authz: input.authz,
  });
  if (!amended.ok)
    return fail('invalid_request', 'invalid_policy', amended.error.detail ?? amended.error.code);
  // The floor may map past the new rung; then the amendment would not move the step at all.
  const next = amended.value.steps[step]!;
  if (targetRung(s, next, step).rung !== target)
    return fail(
      'conflict',
      'not_effective',
      `the task floor keeps step '${step}' above rung ${target}`,
    );
  return ok({ policy: amended.value, diff });
}

export type AmendDeps = {
  readonly store: Store;
  readonly now: () => number;
  readonly confirm: Pick<ConfirmDeps, 'configInputs'>;
};

const ChangeSchema = z
  .object({
    model: z.string().min(1).max(128),
    effort: z.enum(EFFORTS).optional(),
    reason: z.string().min(1).max(4_096),
  })
  .strict();

export const AmendPayloadSchema = ChangeSchema.extend({ policy_hash: HashSchema }).strict();

// The reason is not part of the policy, so it does not change the hash a preview returns.
const PreviewSchema = ChangeSchema.extend({
  kind: z.literal('amend_policy_preview'),
  task_id: UuidSchema,
  reason: z.string().min(1).max(4_096).optional(),
}).strict();

const configInvalid = (message: string, diagnostics: string[] = []): AppError => ({
  code: 'config_invalid',
  message,
  details: { diagnostics: diagnostics.slice(0, 20) },
});

/** Escalation rules and models come from the user config as it is now, the file that owns them. */
async function planFor(
  deps: AmendDeps,
  s: TaskState,
  change: ModelChange,
  authz: AuthzContext,
): Promise<Result<AmendPlan, AppError>> {
  const current =
    s.policy_ref === null
      ? null
      : deps.store.readPolicy(s.id as Uuid, s.policy_ref.revision, s.policy_ref.version);
  if (current === null)
    return err({
      code: 'conflict',
      message: 'the task has no frozen policy yet',
      details: { reason: 'amend_not_applicable' },
    });
  const { user, packs } = await deps.confirm.configInputs();
  const validated = validateConfig({ user, packs });
  if (!validated.ok)
    return err(
      configInvalid(
        'the user config is invalid',
        validated.error.map((d) => `${d.code}: ${d.message}`),
      ),
    );
  const { config } = validated.value;
  const profile = config.profiles[current.profile];
  if (profile === undefined)
    return err(configInvalid(`profile '${current.profile}' is no longer in the user config`));
  const plan = planModelAmendment({
    state: s,
    current,
    change,
    models: config.user.models,
    escalation: {
      auto_up_to_tier: profile.escalation.auto_up_to_tier,
      above: profile.escalation.above,
      allow_models: profile.allow_models,
    },
    authz,
  });
  if (!plan.ok)
    return err({
      code: plan.error.code,
      message: plan.error.detail,
      details: {
        reason: plan.error.reason,
        ...(plan.error.reason === 'unknown_model'
          ? { models: Object.keys(config.user.models).sort() }
          : {}),
      },
    });
  return plan;
}

function previewView(s: TaskState, plan: AmendPlan): Record<string, unknown> {
  return {
    task_id: s.id,
    version: s.version,
    policy_version: plan.policy.policy_version,
    policy_hash: plan.policy.policy_hash,
    change: plan.diff,
  };
}

/** `amend_policy_preview`: read-only, so an assistant may prepare the change the owner confirms. */
export async function amendPolicyPreview(
  deps: AmendDeps,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
): Promise<Result<unknown, AppError>> {
  const q = PreviewSchema.safeParse(body);
  if (!q.success)
    return err({
      code: 'invalid_request',
      message: 'task_id and model are required',
      details: { issues: q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
    });
  const s = deps.store.readTask(q.data.task_id);
  if (s === null || !authorize(caller, { role: 'read' }).ok)
    return err({ code: 'task_not_found', message: `no task ${q.data.task_id}`, details: {} });
  // The plan is built as an admin would submit it; the command itself still requires admin.
  const authz: AuthzContext = { ...authzContext(caller, deps.now()), roles: ['admin'] };
  const change = { ...q.data, reason: q.data.reason ?? 'preview' };
  const plan = await planFor(deps, s, change, authz);
  if (!plan.ok) return plan;
  return ok({
    ...previewView(s, plan.value),
    command:
      `cusr task amend-policy ${s.id} --model ${q.data.model}` +
      (q.data.effort === undefined ? '' : ` --effort ${q.data.effort}`) +
      ` --reason REASON --confirm ${plan.value.policy.policy_hash} --expected-version ${s.version}`,
  });
}

/**
 * After a crash between accepting the amendment and recording the command's result, the task already
 * runs the confirmed policy and no longer waits; resubmitting it lets the store replay the decision.
 */
function applied(
  store: Store,
  s: TaskState,
  payload: z.infer<typeof AmendPayloadSchema>,
): Result<AmendPlan, AppError> | null {
  if (s.policy_ref?.hash !== payload.policy_hash) return null;
  const event = store
    .readEvents(s.id as Uuid)
    .findLast((e) => e.type === 'PolicyAmended' && e.payload.policy_hash === payload.policy_hash);
  if (event?.type !== 'PolicyAmended') return null;
  return ok({
    policy: event.payload.policy,
    diff: event.payload.diff as AmendPlan['diff'],
  });
}

export async function amendPolicy(
  deps: AmendDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const found = taskInProject(deps.store, input);
  if (!found.ok) return found;
  const s = found.value;
  const payload = input.payload as z.infer<typeof AmendPayloadSchema>;
  const authz = authzContext(caller, deps.now());
  const plan = applied(deps.store, s, payload) ?? (await planFor(deps, s, payload, authz));
  if (!plan.ok) return plan;
  if (plan.value.policy.policy_hash !== payload.policy_hash)
    return err({
      code: 'conflict',
      message: 'the amendment differs from the preview; preview it again',
      details: {
        reason: 'policy_changed',
        expected: payload.policy_hash,
        actual: plan.value.policy.policy_hash,
      },
    });
  const r = submit(deps.store, {
    task_id: s.id,
    dedup_key: `cmd:${admitted.record.request_id}:amend`,
    trigger: {
      kind: 'amend',
      policy: plan.value.policy,
      diff: plan.value.diff,
      reason: payload.reason,
    },
    now: deps.now(),
    ids: admitted.record.assigned_ids,
    expected_version: input.expected_version as number,
    authz,
  });
  const after = deps.store.readTask(s.id as Uuid);
  if (!r.ok) return err(acceptError(r.error, after));
  const refused = decisionError(r.value.decision);
  if (refused !== null) return err(refused);
  return ok({
    ...previewView(s, plan.value),
    task: after === null ? null : taskView(after),
  });
}
