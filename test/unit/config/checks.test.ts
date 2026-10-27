import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../../src/config/validate.ts';
import { MIN_PARTS, MIN_PROJECT, minUser } from '../../support/config-fixtures.ts';

type Parts = Partial<typeof MIN_PARTS>;

function codes(parts: Parts, extra = ''): string[] {
  const r = validateConfig({ user: minUser(parts, extra), project: MIN_PROJECT, packs: {} });
  return r.ok ? [] : r.error.map((d) => d.code);
}

const LOOP = (fixVisits: string) => `workflows:
  impl: { base: software_dev@1 }
  loop:
    start: code
    steps:
      code:
        kind: agent
        role: coder
        max_visits: 5
        on_exhausted: escalate
        next: { done: review, needs_input: ask, needs_context: retry, blocked: escalate }
      review:
        kind: review
        role: reviewer
        next: { approve: finish, request_changes: fix }
      fix:
        kind: agent
        role: fixer${fixVisits}
        next: { done: review, needs_input: ask, needs_context: review, blocked: escalate }
      finish: { kind: complete }
`;

const coderLadder = (ladder: string) =>
  MIN_PARTS.roles.replace('coder: { binding: [{ model: sonnet }] }', `coder:\n    binding: [{ model: sonnet }]\n    escalation:\n      ladder: ${ladder}`);

// Sáu kiểm tra trước thực thi của FR-003 (SPEC.md §8): mỗi kiểm tra một ca đạt, một ca lỗi đúng mã.
describe('FR-003 kiểm tra 1: tham chiếu tồn tại', () => {
  it('đạt: cấu hình tối thiểu', () => expect(codes({})).toEqual([]));
  it('lỗi: transition trỏ tới bước không tồn tại', () => {
    expect(codes({ workflows: 'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      gates: { next: { fail: fixx } }\n' })).toEqual(['unknown_step']);
  });
  it('lỗi: role, model, pool không tồn tại', () => {
    expect(codes({ workflows: 'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      code: { role: builder, uses: [gpu] }\n' })).toEqual(['unknown_role', 'unknown_pool']);
    expect(codes({ roles: MIN_PARTS.roles.replace('fixer: { binding: [{ model: sonnet }] }', 'fixer: { binding: [{ model: gpt }] }') })).toEqual(['unknown_model']);
  });
  it('lỗi: profile tham chiếu role/model không có', () => {
    expect(codes({ profiles: 'profiles:\n  standard: { workflow: impl, allow_roles: [coder, ghost], allow_models: [haiku], budgets: { max_agent_runs: 1, max_wall: 1h } }\n' })).toEqual(['unknown_role', 'unknown_model']);
  });
});

describe('FR-003 kiểm tra 2: outcome hữu hạn và có đích', () => {
  it('đạt: mọi outcome của software_dev@1 có đích', () => expect(codes({})).toEqual([]));
  it('lỗi: outcome không thuộc loại bước', () => {
    expect(codes({ workflows: 'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      gates: { next: { flaky: gates } }\n' })).toEqual(['outcome_not_in_kind']);
  });
  it('lỗi: outcome thiếu đích', () => {
    const wf = LOOP('\n        max_visits: 3\n        on_exhausted: escalate').replace(', blocked: escalate }\n      review', ' }\n      review');
    expect(codes({ workflows: wf })).toEqual(['outcome_without_target']);
  });
});

describe('FR-003 kiểm tra 3: chu trình có bộ đếm, task có cận trên', () => {
  it('đạt: vòng review ↔ fix có max_visits', () => {
    expect(codes({ workflows: LOOP('\n        max_visits: 3\n        on_exhausted: escalate') })).toEqual([]);
  });
  it('lỗi: vòng review ↔ fix không có giới hạn đếm', () => {
    expect(codes({ workflows: LOOP('') })).toEqual(['unbounded_cycle']);
  });
  it('lỗi: profile thiếu trần lượt agent hoặc thời gian', () => {
    expect(codes({ profiles: 'profiles:\n  standard: { workflow: impl, budgets: { max_wall: 1h } }\n' })).toEqual(['no_task_bound']);
    expect(codes({ profiles: 'profiles:\n  standard: { workflow: impl }\n' })).toEqual(['no_task_bound', 'no_task_bound']);
  });
});

describe('FR-003 kiểm tra 4: thang đạt được', () => {
  const ladder = '[{ effort: high }, { model: opus }]';
  it('đạt: max_visits 5 đủ cho nấc 2 (2·2+1)', () => {
    expect(codes({ roles: coderLadder(ladder), workflows: 'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      code: { max_visits: 5 }\n' })).toEqual([]);
  });
  it('lỗi: max_visits 4 không tới được nấc 2', () => {
    expect(codes({ roles: coderLadder(ladder), workflows: 'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      code: { max_visits: 4 }\n' })).toEqual(['unreachable_rung']);
  });
  it('max_rung giới hạn thang nên nấc vượt max_rung không bị xét', () => {
    expect(codes({ roles: coderLadder(ladder), workflows: 'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      code: { max_visits: 4, max_rung: 1 }\n' })).toEqual([]);
  });
  it('lỗi: max_rung vượt thang của role', () => {
    expect(codes({ workflows: 'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      code: { max_rung: 1 }\n' })).toEqual(['rung_beyond_role']);
  });
});

describe('FR-003 kiểm tra 5: binding khởi đầu', () => {
  const roles = (rules: string) => MIN_PARTS.roles.replace('coder: { binding: [{ model: sonnet }] }', `coder: { binding: ${rules} }`);
  it('đạt: rule có điều kiện kèm rule dự phòng', () => {
    expect(codes({ roles: roles('[{ when: { size: [L] }, model: opus }, { model: sonnet }]') })).toEqual([]);
  });
  it('lỗi: mọi rule đều có điều kiện', () => {
    expect(codes({ roles: roles('[{ when: { size: [L] }, model: opus }]') })).toEqual(['no_initial_binding']);
  });
});

describe('FR-003 kiểm tra 6: predicate thuộc tập định nghĩa trước', () => {
  const roles = (when: string) => MIN_PARTS.roles.replace('coder: { binding: [{ model: sonnet }] }', `coder: { binding: [{ when: ${when}, model: opus }, { model: sonnet }] }`);
  it('đạt: đủ sáu predicate cho phép', () => {
    expect(codes({ roles: roles('{ flag: hot, size: [L], label: [ui], task_type: bugfix, attempt_gte: 2, target_branch: "feature/*" }') })).toEqual([]);
  });
  it('lỗi: predicate lạ', () => expect(codes({ roles: roles('{ priority: high }') })).toEqual(['unknown_predicate']));
  it('lỗi: predicate đúng tên nhưng sai kiểu là schema_invalid', () => {
    expect(codes({ roles: roles('{ attempt_gte: two }') })).toEqual(['schema_invalid']);
  });
});

describe('FR-006 và gate', () => {
  it('decision_mode_forbidden cho điểm quyết định bị cấm', () => {
    expect(codes({ workflows: 'workflows:\n  impl:\n    base: software_dev@1\n    decisions: { budget_increase: agent_if_confident }\n' })).toEqual(['decision_mode_forbidden']);
  });
  it('gate bắt buộc phải được project khai báo', () => {
    const r = validateConfig({ user: minUser(), project: { file: 'cusr.yaml', text: 'version: 1\ngates: { build: make }\nprofile: standard\n' }, packs: {} });
    expect(!r.ok && r.error.map((d) => d.code)).toEqual(['required_gate_missing']);
  });
  it('allow_no_gates cho phép project không có gate', () => {
    const profiles = 'profiles:\n  standard: { workflow: impl, allow_no_gates: true, budgets: { max_agent_runs: 1, max_wall: 1h } }\n';
    expect(validateConfig({ user: minUser({ profiles }), project: { file: 'cusr.yaml', text: 'version: 1\nprofile: standard\n' }, packs: {} }).ok).toBe(true);
  });
});

describe('trả đủ lỗi, sắp theo (file, line, col)', () => {
  it('nhiều lỗi trong cùng cấu hình được trả hết', () => {
    const r = validateConfig({
      user: minUser({ workflows: 'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      gates: { next: { fail: fixx } }\n      code: { role: builder }\n' }),
      project: MIN_PROJECT,
      packs: {},
    });
    expect(!r.ok && r.error.map((d) => [d.code, d.line])).toEqual([
      ['unknown_step', 14],
      ['unknown_role', 15],
    ]);
  });
});
