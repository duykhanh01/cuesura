/** Map I01-I12 to actual evidence suites. Suite paths are relative to the repository root. */
export type InvariantEntry =
  | {
      title: string;
      scope: 'full' | 'partial';
      layer: string;
      suites: string[];
    }
  | { title: string; scope: 'out_of_scope'; layer: string };

export const INVARIANTS: Record<string, InvariantEntry> = {
  I01: {
    title: 'Deterministic decisions',
    scope: 'full',
    layer: 'Decision-core property tests',
    suites: [
      'test/property/invariants/determinism.test.ts',
      'test/scenarios/us2-decide.test.ts',
      'test/unit/lint/boundaries.test.ts',
      'test/reliability/r4-sequences.test.ts',
    ],
  },
  I02: {
    title: 'Single writer',
    scope: 'partial',
    layer: 'Real-store integration tests',
    suites: ['test/integration/store/single-writer.test.ts'],
  },
  I03: {
    title: 'Atomic writes and effects after commit',
    scope: 'partial',
    layer: 'Integration tests with crash injection',
    suites: [
      'test/integration/crash/crash-points.test.ts',
      'test/integration/store/write-failure.test.ts',
      'test/integration/store/us3-scenarios.test.ts',
      'test/reliability/r1-crash.test.ts',
    ],
  },
  I04: {
    title: 'Idempotency keys',
    scope: 'partial',
    layer: 'Property and store integration tests',
    suites: [
      'test/property/invariants/idempotency.test.ts',
      'test/integration/store/effects.test.ts',
      'test/integration/store/accept.test.ts',
      'test/integration/store/us3-scenarios.test.ts',
      'test/reliability/r4-sequences.test.ts',
    ],
  },
  I05: {
    title: 'Isolated, sequential worktrees',
    scope: 'out_of_scope',
    layer: 'No evidence yet',
  },
  I06: {
    title: 'Validated execution evidence',
    scope: 'partial',
    layer: 'Property tests',
    suites: ['test/property/invariants/evidence.test.ts'],
  },
  I07: {
    title: 'Bounded execution',
    scope: 'partial',
    layer: 'Property tests',
    suites: [
      'test/property/invariants/bounds.test.ts',
      'test/property/invariants/budget.test.ts',
      'test/scenarios/us4-escalation.test.ts',
      'test/unit/engine/backoff.test.ts',
      'test/reliability/r4-sequences.test.ts',
    ],
  },
  I08: {
    title: 'Revision immutability',
    scope: 'partial',
    layer: 'Property and store integration tests',
    suites: [
      'test/scenarios/us1-config.test.ts',
      'test/unit/policy/freeze.test.ts',
      'test/unit/policy/amendment.test.ts',
      'test/property/invariants/revision.test.ts',
      'test/scenarios/us2-decide.test.ts',
      'test/integration/store/effects.test.ts',
      'test/reliability/r4-sequences.test.ts',
    ],
  },
  I09: {
    title: 'Roles, bindings, approvals, and budgets',
    scope: 'partial',
    layer: 'Property tests',
    suites: [
      'test/property/invariants/escalation.test.ts',
      'test/property/invariants/budget.test.ts',
      'test/property/invariants/usage.test.ts',
      'test/scenarios/us4-escalation.test.ts',
      'test/reliability/r4-sequences.test.ts',
    ],
  },
  I10: {
    title: 'Event order and repeated triggers',
    scope: 'full',
    layer: 'Property and store integration tests',
    suites: [
      'test/property/invariants/determinism.test.ts',
      'test/property/invariants/claim.test.ts',
      'test/integration/store/accept.test.ts',
      'test/integration/store/timers.test.ts',
      'test/integration/store/projection.test.ts',
      'test/reliability/r4-sequences.test.ts',
      'test/reliability/r1-crash.test.ts',
    ],
  },
  I11: {
    title: 'Merge conditions',
    scope: 'partial',
    layer: 'Property tests',
    suites: [
      'test/property/invariants/merge-guard.test.ts',
      'test/reliability/r4-sequences.test.ts',
    ],
  },
  I12: {
    title: 'Terminal states stay terminal',
    scope: 'full',
    layer: 'Property and store integration tests',
    suites: [
      'test/property/invariants/transitions.test.ts',
      'test/scenarios/us2-decide.test.ts',
      'test/integration/store/effects.test.ts',
      'test/integration/store/projection.test.ts',
      'test/reliability/r4-sequences.test.ts',
    ],
  },
};
