/**
 * Ánh xạ bất biến I01–I12 → bộ kiểm thử làm bằng chứng (research R-14, SC-008). Bảng gốc ở mục
 * "Bằng chứng theo bất biến" của spec. `suites` là đường dẫn file test tính từ gốc repo.
 */
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
    title: 'Quyết định tất định',
    scope: 'full',
    layer: 'Thuộc tính trên lõi quyết định',
    suites: [
      'test/property/invariants/determinism.test.ts',
      'test/scenarios/us2-decide.test.ts',
      'test/unit/lint/boundaries.test.ts',
      'test/reliability/r4-sequences.test.ts',
    ],
  },
  I02: {
    title: 'Một bên ghi',
    scope: 'partial',
    layer: 'Tích hợp trên kho thật',
    suites: ['test/integration/store/single-writer.test.ts'],
  },
  I03: {
    title: 'Ghi nguyên tử, effect sau commit',
    scope: 'partial',
    layer: 'Tích hợp có ngắt tiến trình',
    suites: [
      'test/integration/crash/crash-points.test.ts',
      'test/integration/store/write-failure.test.ts',
      'test/integration/store/us3-scenarios.test.ts',
      'test/reliability/r1-crash.test.ts',
    ],
  },
  I04: {
    title: 'Khoá idempotency',
    scope: 'partial',
    layer: 'Thuộc tính + tích hợp kho',
    suites: [
      'test/property/invariants/idempotency.test.ts',
      'test/integration/store/effects.test.ts',
      'test/integration/store/accept.test.ts',
      'test/integration/store/us3-scenarios.test.ts',
      'test/reliability/r4-sequences.test.ts',
    ],
  },
  I05: {
    title: 'Worktree riêng, tuần tự',
    scope: 'out_of_scope',
    layer: 'Chưa có bằng chứng',
  },
  I06: {
    title: 'Bằng chứng, không phải lời agent',
    scope: 'partial',
    layer: 'Thuộc tính',
    suites: ['test/property/invariants/evidence.test.ts'],
  },
  I07: {
    title: 'Mọi thứ có giới hạn',
    scope: 'partial',
    layer: 'Thuộc tính',
    suites: [
      'test/property/invariants/bounds.test.ts',
      'test/property/invariants/budget.test.ts',
      'test/scenarios/us4-escalation.test.ts',
      'test/unit/engine/backoff.test.ts',
      'test/reliability/r4-sequences.test.ts',
    ],
  },
  I08: {
    title: 'Bất biến theo revision',
    scope: 'partial',
    layer: 'Thuộc tính + tích hợp kho',
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
    title: 'Role, binding, approval, ngân sách',
    scope: 'partial',
    layer: 'Thuộc tính',
    suites: [
      'test/property/invariants/escalation.test.ts',
      'test/property/invariants/budget.test.ts',
      'test/property/invariants/usage.test.ts',
      'test/scenarios/us4-escalation.test.ts',
      'test/reliability/r4-sequences.test.ts',
    ],
  },
  I10: {
    title: 'Thứ tự sự kiện, trigger lặp',
    scope: 'full',
    layer: 'Thuộc tính + tích hợp kho',
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
    title: 'Điều kiện merge',
    scope: 'partial',
    layer: 'Thuộc tính',
    suites: [
      'test/property/invariants/merge-guard.test.ts',
      'test/reliability/r4-sequences.test.ts',
    ],
  },
  I12: {
    title: 'Kết thúc không mở lại',
    scope: 'full',
    layer: 'Thuộc tính + tích hợp kho',
    suites: [
      'test/property/invariants/transitions.test.ts',
      'test/scenarios/us2-decide.test.ts',
      'test/integration/store/effects.test.ts',
      'test/integration/store/projection.test.ts',
      'test/reliability/r4-sequences.test.ts',
    ],
  },
};
