/** Map I01-I12 to actual evidence suites. Suite paths are relative to the repository root. */
export type InvariantEntry =
  | {
      title: string;
      scope: 'full' | 'partial';
      layer: string;
      suites: string[];
      /** Recorded runs on real vendors and GitHub: no Vitest result stands for them. */
      records?: string[];
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
    scope: 'partial',
    layer: 'Real Git worktree and bwrap integration tests',
    suites: [
      'test/integration/runtime/feature-002-flow.test.ts',
      'test/integration/runtime/scheduler.test.ts',
      'test/integration/runtime/harness-bwrap.test.ts',
    ],
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
    // 002 has no merge effect, so only that nothing dispatches one is shown here.
    title: 'Merge conditions: Cuesura dispatches no merge',
    scope: 'partial',
    layer: 'Property and external-completion integration tests',
    suites: [
      'test/property/invariants/merge-guard.test.ts',
      'test/integration/runtime/external-completion.test.ts',
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

const SMOKE_RECORDS = [
  'test/fixtures/runtime/spike-0/harness/proof-20261031/smoke-ledger.jsonl',
  'test/fixtures/runtime/spike-0/harness/rerun-20261031/smoke-ledger.jsonl',
];

/** S01-S10 (SPEC §18.2). `partial` says the journey is only shown as far as feature 002 reaches. */
export const SCENARIOS: Record<string, InvariantEntry> = {
  S01: {
    title: 'Task to PR, done once the merge is confirmed',
    scope: 'partial',
    layer: 'Flow tests and real sandbox runs; the CLI only, no GitHub intake',
    suites: ['test/integration/runtime/feature-002-flow.test.ts'],
    records: SMOKE_RECORDS,
  },
  S02: {
    title: 'Missing information waits, no coder or worktree',
    scope: 'partial',
    layer: 'Real-store integration tests',
    suites: ['test/integration/runtime/confirm-start.test.ts'],
  },
  S03: {
    title: 'Gate, review and CI failures fixed in bounded rounds',
    scope: 'full',
    layer: 'Flow tests and real sandbox runs',
    suites: ['test/integration/runtime/feature-002-fixes.test.ts'],
    records: SMOKE_RECORDS,
  },
  S04: {
    title: 'Agent question answered once',
    scope: 'partial',
    layer: 'Real-store integration tests; the CLI channel only',
    suites: ['test/integration/runtime/questions.test.ts'],
  },
  S05: {
    title: 'Daemon stopped mid-run: no second run or PR',
    scope: 'full',
    layer: 'Recovery tests, crash injection and real sandbox runs',
    suites: [
      'test/integration/runtime/feature-002-recovery.test.ts',
      'test/integration/runtime/publish-recovery.test.ts',
      'test/reliability/runtime-crash.test.ts',
    ],
    records: SMOKE_RECORDS,
  },
  S06: {
    title: 'Rate limit or infrastructure failure waits with a reason',
    scope: 'partial',
    layer: 'Integration tests with fake harnesses',
    suites: [
      'test/integration/runtime/feature-002-fixes.test.ts',
      'test/integration/runtime/cancel-drain.test.ts',
    ],
  },
  S07: {
    title: 'Independent and dependent tasks',
    scope: 'partial',
    layer: 'Real-store integration tests; one execution slot in 002',
    suites: [
      'test/integration/runtime/scheduler.test.ts',
      'test/integration/runtime/atomic-claims.test.ts',
    ],
  },
  S08: {
    title: 'Base or head changes before the merge',
    scope: 'partial',
    layer: 'Integration tests',
    suites: [
      'test/integration/runtime/feature-002-fixes.test.ts',
      'test/integration/runtime/execution-modes.test.ts',
    ],
  },
  S09: {
    title: 'Changed request gets a new revision',
    scope: 'partial',
    layer: 'Unit and integration tests',
    suites: ['test/unit/policy/amendment.test.ts', 'test/property/invariants/revision.test.ts'],
  },
  S10: {
    title: 'Status and evidence read through the CLI',
    scope: 'partial',
    layer: 'CLI integration tests; backup, restore and upgrade not accepted',
    suites: ['test/integration/runtime/feature-002-cli.test.ts'],
  },
};

/** R1-R9 (SPEC §18.1). R7 and R9 are not accepted in full (T132). */
export const RELIABILITY: Record<string, InvariantEntry> = {
  R1: {
    title: 'At least 200 seeded daemon kills, full projection replay',
    scope: 'full',
    layer: 'Crash injection',
    suites: ['test/reliability/r1-crash.test.ts', 'test/reliability/runtime-crash.test.ts'],
  },
  R2: {
    title: 'Crash matrix around commit, push and PR; no doubled effect',
    scope: 'partial',
    layer: 'Crash injection; no comment or merge effect in 002',
    suites: [
      'test/reliability/runtime-crash.test.ts',
      'test/integration/runtime/publish-recovery.test.ts',
    ],
  },
  R3: {
    title: 'Every task ends or waits with a reason and a way on',
    scope: 'partial',
    layer: 'Property and integration tests; no standalone watchdog',
    suites: [
      'test/property/invariants/transitions.test.ts',
      'test/integration/runtime/feature-002-fixes.test.ts',
    ],
  },
  R4: {
    title: 'At least 10,000 generated trigger sequences',
    scope: 'full',
    layer: 'Property tests',
    suites: ['test/reliability/r4-sequences.test.ts'],
  },
  R5: {
    title: 'No process of an attempt outlives it unintended',
    scope: 'partial',
    layer: 'Real process and systemd integration tests',
    suites: [
      'test/integration/runtime/cancel-drain.test.ts',
      'test/integration/runtime/feature-002-recovery.test.ts',
    ],
    records: SMOKE_RECORDS,
  },
  R6: {
    title: 'Bad output, torn logs, API errors and full disks are classified',
    scope: 'partial',
    layer: 'Contract and integration tests',
    suites: [
      'test/contract/harness.test.ts',
      'test/integration/runtime/runner-storage.test.ts',
      'test/integration/store/write-failure.test.ts',
    ],
  },
  R7: {
    title: 'Soak of 8-12 hours with 50 fake tasks',
    scope: 'out_of_scope',
    layer: 'Not run; not accepted',
  },
  R8: {
    title: 'Claude and Codex end to end, daemon killed mid-run, two ecosystems',
    scope: 'full',
    layer: 'Real vendors on sandbox repos, recorded; not part of pnpm test',
    suites: [],
    records: [
      ...SMOKE_RECORDS,
      'test/fixtures/runtime/spike-0/harness/rerun-20261031/evidence-claude.json',
      'test/fixtures/runtime/spike-0/harness/proof-20261031/evidence-codex.json',
    ],
  },
  R9: {
    title: 'Backup, restore, migration and doctor',
    scope: 'partial',
    layer: 'Doctor and store migration; backup, restore and rollback not accepted',
    suites: [
      'test/integration/runtime/feature-002-cli.test.ts',
      'test/integration/runtime/migration.test.ts',
    ],
  },
};
