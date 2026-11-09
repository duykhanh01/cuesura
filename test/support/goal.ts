import type { Plan, PlanUnit } from '../../src/domain/goal.ts';
import type { Reply, SeededDaemon } from './daemon-task.ts';

// Builders for goals and plans (007, lát D), on the fixture config's `acme` project.

/** The fixture user config's profile and coder (test/fixtures/configs/valid/user.yaml). */
export const UNIT_RUN = {
  profile: 'standard',
  mode: 'direct-pr' as const,
  reason: 'fits',
  worker: { harness: 'claude', model: 'sonnet', effort: 'medium' as const },
  reviewer: null,
};

export function planUnit(key: string, over: Partial<PlanUnit> = {}): PlanUnit {
  return {
    key,
    title: `Unit ${key}`,
    description: `Does ${key} for the user`,
    instructions: '',
    acceptance: [`${key} works`],
    scope: [`src/${key}`],
    depends_on: [],
    run_config: UNIT_RUN,
    ...over,
  };
}

export function goalPlan(units: PlanUnit[], over: Partial<Plan> = {}): Plan {
  return {
    schema_version: 1,
    summary: 'Export the report as CSV',
    scope: ['src'],
    non_goals: [],
    units,
    ...over,
  };
}

let n = 0;
export const goalRequestId = (): string =>
  `0192cccc-0000-7000-8000-${String(++n).padStart(12, '0')}`;

export type GoalCall = {
  readonly actor?: 'owner' | 'assistant' | 'deputy';
  readonly turn?: string | null;
  readonly lease?: string | null;
  readonly requestId?: string;
  readonly reason?: string;
};

/** One goal command over the socket. */
export function goalCommand(
  sd: SeededDaemon,
  kind: string,
  goalId: string | null,
  expected: number | null,
  payload: unknown,
  o: GoalCall = {},
): Promise<Reply> {
  return sd.command(
    o.actor ?? 'owner',
    {
      request_id: o.requestId ?? goalRequestId(),
      kind,
      project: kind === 'goal_add' ? 'acme' : null,
      task_id: null,
      goal_id: goalId,
      expected_version: expected,
      payload,
      ...(o.reason === undefined ? {} : { reason: o.reason }),
    },
    o.turn ?? null,
    o.lease === undefined ? null : o.lease,
  );
}

export type GoalView = {
  goal_id: string;
  status: string;
  version: number;
  plan_version: number;
  plan_hash: string | null;
  pending_amendment: { plan_hash: string; plan_version: number; affected: string[] } | null;
  units: Record<string, { task_id: string; status: string | null }>;
  parallel_groups?: string[][];
  amendment?: 'scope' | 'execution';
  affected?: string[];
};

export function resultOf(r: Reply): GoalView {
  if (r.envelope.ok !== true) throw new Error(JSON.stringify(r.envelope));
  return (r.envelope.data as { result: GoalView }).result;
}

/** add → propose → confirm as the owner; returns the confirmed goal. */
export async function confirmedGoal(sd: SeededDaemon, plan: Plan): Promise<GoalView> {
  const added = resultOf(
    await goalCommand(sd, 'goal_add', null, null, { request: 'Export CSV', base_branch: 'main' }),
  );
  const proposed = resultOf(
    await goalCommand(sd, 'goal_propose', added.goal_id, added.version, { plan, plan_version: 0 }),
  );
  return resultOf(
    await goalCommand(sd, 'goal_confirm', added.goal_id, proposed.version, {
      plan_hash: proposed.plan_hash,
    }),
  );
}
