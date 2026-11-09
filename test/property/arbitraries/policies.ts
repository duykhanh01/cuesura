import fc from 'fast-check';
import type { LadderStep } from '../../../src/domain/config.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import type { PolicyOptions, RoleSpec } from '../../support/builders.ts';

const LADDERS: LadderStep[][] = [
  [],
  [{ effort: 'high' }],
  [{ effort: 'high' }, { model: 'opus', effort: 'high' }],
  [{ add_context: ['repo_map'] }, { model: 'opus' }, { model: 'opus', effort: 'high' }],
];

const roleArb = (model: string, permissions: 'write' | 'read_only'): fc.Arbitrary<RoleSpec> =>
  fc
    .record({
      ladder: fc.constantFrom(...LADDERS),
      effort: fc.constantFrom('low' as const, 'medium' as const),
    })
    .map((r) => ({ model, permissions, ...r }));

/**
 * Vary ladder lengths and bindings across roles so rung invariants cannot rely on matching
 * indices.
 */
export const policyArb: fc.Arbitrary<PolicyOptions> = fc.record({
  limits: fc.record({
    max_agent_runs: fc.oneof(
      { weight: 1, arbitrary: fc.integer({ min: 1, max: 3 }) },
      { weight: 4, arbitrary: fc.integer({ min: 4, max: 16 }) },
    ),
    max_wall_ms: fc.constantFrom(600_000, 3_600_000, 6 * 3_600_000),
  }),
  required_checks: fc.subarray(['build', 'test', 'format']),
  escalation: fc.record({ auto_up_to_tier: fc.integer({ min: 1, max: 3 }) }),
  roles: fc.record({
    coder: roleArb('sonnet', 'write'),
    fixer: roleArb('haiku', 'write'),
    reviewer: roleArb('sol', 'read_only'),
  }),
});

const scopedRoleArb = (model: string, permissions: 'write' | 'read_only'): fc.Arbitrary<RoleSpec> =>
  fc
    .tuple(roleArb(model, permissions), fc.constantFrom('step' as const, 'task' as const))
    .map(([r, scope]) => ({ ...r, scope }));

/**
 * Policies that stress escalation: denied or approval-gated upper rungs, small escalation limits and roles
 * whose raises lift the task floor.
 */
export const escalationPolicyArb: fc.Arbitrary<PolicyOptions> = fc.record({
  limits: fc.record({
    max_agent_runs: fc.integer({ min: 4, max: 24 }),
    max_escalations: fc.integer({ min: 0, max: 4 }),
    classes: fc.record({
      quality_tries_per_rung: fc.integer({ min: 1, max: 5 }),
    }),
  }),
  escalation: fc.record({
    auto_up_to_tier: fc.constantFrom(1, 2, 2, 3),
    above: fc.constantFrom('ask_human' as const, 'ask_human' as const, 'deny' as const),
  }),
  roles: fc.record({
    coder: scopedRoleArb('sonnet', 'write'),
    fixer: scopedRoleArb('haiku', 'write'),
    reviewer: scopedRoleArb('sol', 'read_only'),
  }),
});

export const taskOverArb: fc.Arbitrary<Partial<CanonicalTask>> = fc.record({
  size: fc.constantFrom('XS' as const, 'M' as const, 'L' as const),
  labels: fc.constantFrom([], ['needs_scout']),
  base_branch: fc.constantFrom('main', 'feature/x'),
});

export function propertyParams(numRuns = 60): fc.Parameters<unknown> {
  const seed = process.env['CUSR_SEED'];
  const runs = process.env['CUSR_RUNS'];
  return {
    numRuns: runs !== undefined ? Number(runs) : numRuns,
    ...(seed !== undefined ? { seed: Number(seed) } : {}),
  };
}
