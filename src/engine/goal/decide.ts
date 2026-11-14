import {
  isGoalTerminal,
  type GoalEnvelope,
  type GoalEventDraft,
  type GoalState,
  type GoalStatus,
} from '../../domain/goal.ts';

export type GoalRejection = {
  readonly code: 'goal_exists' | 'goal_not_found' | 'goal_status' | 'plan_version' | 'plan_hash';
  readonly detail: Readonly<Record<string, unknown>>;
};

export type GoalDecision =
  | { readonly kind: 'accepted'; readonly events: GoalEventDraft[] }
  | { readonly kind: 'rejected'; readonly rejection: GoalRejection };

const accepted = (...events: GoalEventDraft[]): GoalDecision => ({ kind: 'accepted', events });
const rejected = (
  code: GoalRejection['code'],
  detail: Record<string, unknown> = {},
): GoalDecision => ({
  kind: 'rejected',
  rejection: { code, detail },
});

function statusIs(s: GoalState, allowed: readonly GoalStatus[]): GoalDecision | null {
  return allowed.includes(s.status)
    ? null
    : rejected('goal_status', { status: s.status, allowed: [...allowed] });
}

/** The goal aggregate's decision: pure over the current state and the envelope (R-21). */
export function decideGoal(state: GoalState | null, env: GoalEnvelope): GoalDecision {
  const t = env.trigger;
  const at = env.now;
  const by = env.actor;
  const reason = env.reason ?? null;
  if (t.kind === 'add') {
    if (state !== null) return rejected('goal_exists', { goal_id: state.id });
    return accepted({
      type: 'GoalAdded',
      actor: by,
      payload: {
        project: t.project,
        base_branch: t.base_branch,
        request: t.request,
        hints: t.hints,
        by,
        at,
      },
    });
  }
  if (state === null) return rejected('goal_not_found', { goal_id: env.goal_id });
  if (isGoalTerminal(state.status))
    return rejected('goal_status', { status: state.status, allowed: [] });
  switch (t.kind) {
    case 'revise':
      return accepted({ type: 'GoalRevised', actor: by, payload: { request: t.request, by, at } });
    case 'note':
      return accepted({
        type: 'GoalNoted',
        actor: by,
        payload: { text: t.text, kind: t.note_kind, by, at },
      });
    case 'propose': {
      const bad = statusIs(state, ['planning', 'awaiting_confirm']);
      if (bad !== null) return bad;
      if (t.plan_version !== state.plan_version)
        return rejected('plan_version', { current: state.plan_version });
      return accepted({
        type: 'PlanProposed',
        actor: by,
        payload: {
          plan: t.plan,
          plan_version: state.plan_version + 1,
          plan_hash: t.plan_hash,
          by,
          reason,
          at,
        },
      });
    }
    case 'amend': {
      const bad = statusIs(state, ['running', 'replan']);
      if (bad !== null) return bad;
      if (t.plan_version !== state.plan_version)
        return rejected('plan_version', { current: state.plan_version });
      const payload = {
        plan: t.plan,
        plan_version: state.plan_version + 1,
        plan_hash: t.plan_hash,
        affected: t.affected,
        by,
        reason,
        ...(t.amendment === 'execution' && t.units !== undefined && Object.keys(t.units).length > 0
          ? { units: t.units }
          : {}),
        at,
      };
      return accepted(
        t.amendment === 'execution'
          ? { type: 'PlanAmended', actor: by, payload }
          : { type: 'PlanAmendmentProposed', actor: by, payload },
      );
    }
    case 'confirm': {
      const pending = state.pending_amendment;
      const bad = statusIs(state, ['awaiting_confirm', 'amendment_pending']);
      if (bad !== null) return bad;
      const current =
        state.status === 'amendment_pending' && pending !== null
          ? pending.plan_hash
          : state.plan_hash;
      const version =
        state.status === 'amendment_pending' && pending !== null
          ? pending.plan_version
          : state.plan_version;
      if (t.plan_hash !== current) return rejected('plan_hash', { current });
      return accepted({
        type: 'PlanConfirmed',
        actor: by,
        payload: {
          plan_version: version,
          plan_hash: current,
          by,
          units: t.units,
          ...(t.branch === undefined || state.branch !== null ? {} : { branch: t.branch }),
          ...(t.final_task_id === undefined || state.final_task_id !== null
            ? {}
            : { final_task_id: t.final_task_id }),
          at,
        },
      });
    }
    case 'cancel':
      return accepted({
        type: 'GoalCancelled',
        actor: by,
        payload: { reason: t.reason, by, at },
      });
    case 'branch_created':
      if (state.branch === null || state.branch_created === true)
        return rejected('goal_status', { status: state.status, allowed: [] });
      return accepted({
        type: 'GoalBranchCreated',
        actor: by,
        payload: { branch: state.branch, sha: t.sha, at },
      });
    case 'replan': {
      const bad = statusIs(state, ['running']);
      if (bad !== null) return bad;
      return accepted({ type: 'GoalReplanNeeded', actor: by, payload: { reason: t.reason, at } });
    }
    case 'complete':
      return accepted({ type: 'GoalCompleted', actor: by, payload: { at } });
    case 'fail':
      return accepted({ type: 'GoalFailed', actor: by, payload: { reason: t.reason, at } });
  }
}
