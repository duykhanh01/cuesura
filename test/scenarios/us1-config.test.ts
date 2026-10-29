import { describe, expect, it } from 'vitest';
import {
  validateConfig,
  type ValidatedConfig,
} from '../../src/config/validate.ts';
import { freeze } from '../../src/config/freeze.ts';
import { formatDiagnostic } from '../../src/config/positions.ts';
import { proposeAmendment } from '../../src/policy/amendment.ts';
import {
  verifyContextHash,
  verifyPolicyHash,
} from '../../src/policy/finalize.ts';
import type { ConfigSource } from '../../src/config/yaml-loader.ts';
import type { CanonicalTask } from '../../src/domain/task.ts';
import { authz, buildTask } from '../support/builders.ts';
import {
  docsFor,
  MIN_PARTS,
  MIN_PROJECT,
  minUser,
  PACKS,
  source,
} from '../support/config-fixtures.ts';

const USER = source('configs/valid/user.yaml');
const CUSR = source('configs/valid/cusr.yaml', 'cusr.yaml');

function valid(
  user: ConfigSource,
  project: ConfigSource | undefined = CUSR,
  packs: Record<string, ConfigSource> = PACKS,
): ValidatedConfig {
  const r = validateConfig({ user, ...(project ? { project } : {}), packs });
  if (!r.ok) throw new Error(r.error.map(formatDiagnostic).join('\n'));
  return r.value.config;
}

function errorsOf(
  user: ConfigSource,
  project: ConfigSource | undefined = MIN_PROJECT,
): string[] {
  const r = validateConfig({
    user,
    ...(project ? { project } : {}),
    packs: {},
  });
  return r.ok ? [] : r.error.map(formatDiagnostic);
}

function freezeTask(
  config: ValidatedConfig,
  task: CanonicalTask,
  extra: {
    overrides?: Record<string, unknown>;
    attachments?: { name: string; media_type: string; content: string }[];
  } = {},
) {
  return freeze({
    config,
    task,
    caller: authz(['operate']),
    base_sha: 'base1111',
    attachments: extra.attachments ?? [],
    ...docsFor(config),
    ...(extra.overrides ? { overrides: extra.overrides } : {}),
  });
}

describe('US1 - Kiểm tra cấu hình và chốt chính sách', () => {
  it('Scenario 1: transition trỏ tới bước không tồn tại bị báo đúng file:dòng:cột và tên bước', () => {
    const workflows =
      'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      gates:\n        next: { pass: review, fail: fixx }\n';
    expect(errorsOf(minUser({ workflows }))).toEqual([
      "config.yaml:15:31 unknown_step: transition 'fail' của bước 'gates' trỏ tới 'fixx'",
    ]);
  });

  it('Scenario 2: vòng review → fix không có giới hạn đếm bị từ chối và chỉ ra chu trình', () => {
    const workflows = `workflows:
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
        role: fixer
        next: { done: review, needs_input: ask, needs_context: review, blocked: escalate }
      finish: { kind: complete }
`;
    const errs = errorsOf(minUser({ workflows }));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(
      /^config\.yaml:\d+:\d+ unbounded_cycle: chu trình chưa có giới hạn đếm: fix → review → fix$/,
    );
  });

  it('Scenario 3: hai cấu hình chỉ khác thứ tự khoá và định dạng cho cùng hash chính sách', () => {
    const task = buildTask();
    const a = freezeTask(valid(USER), task);
    const b = freezeTask(
      valid(source('configs/valid/user-reordered.yaml')),
      task,
    );
    expect(
      a.ok && b.ok && a.value.policy.policy_hash === b.value.policy.policy_hash,
    ).toBe(true);
  });

  it('Scenario 4: sửa cấu hình sau khi chốt không đổi chính sách của task đã chốt', () => {
    const first = freezeTask(valid(USER), buildTask());
    if (!first.ok) throw new Error('freeze');
    const frozen = structuredClone(first.value.policy);

    const edited = {
      ...USER,
      text: USER.text.replace('max_agent_runs: 12', 'max_agent_runs: 30'),
    };
    const later = freezeTask(
      valid(edited),
      buildTask({
        id: '00000000-0000-7000-8000-000000000002' as CanonicalTask['id'],
      }),
    );
    if (!later.ok) throw new Error('freeze');

    expect(first.value.policy).toEqual(frozen);
    expect(verifyPolicyHash(first.value.policy)).toBe(true);
    expect(first.value.policy.limits.max_agent_runs).toBe(12);
    expect(later.value.policy.limits.max_agent_runs).toBe(30);
  });

  it('Scenario 5: nấc thang không thể đạt trong giới hạn lượt bị báo lỗi', () => {
    const roles = MIN_PARTS.roles.replace(
      'coder: { binding: [{ model: sonnet }] }',
      'coder:\n    binding: [{ model: sonnet }]\n    escalation:\n      ladder: [{ effort: high }, { model: opus }]',
    );
    const workflows =
      'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      code: { max_visits: 4 }\n';
    const errs = errorsOf(minUser({ roles, workflows }));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('unreachable_rung');
    expect(errs[0]).toContain("nấc 2 của role 'coder'");
  });

  it('Scenario 6: amendment chỉ có tên actor hoặc chỉ có operate bị từ chối, chính sách giữ nguyên', () => {
    const r = freezeTask(valid(USER), buildTask());
    if (!r.ok) throw new Error('freeze');
    const policy = r.value.policy;
    const before = structuredClone(policy);
    const change = { limits: { ...policy.limits, max_agent_runs: 99 } };

    // Chỉ có tên actor tự khai: không có ngữ cảnh quyền.
    expect(
      proposeAmendment({
        current: policy,
        change,
        reason: 'cần thêm lượt',
        authz: null,
      }),
    ).toEqual({ ok: false, error: { code: 'not_admin' } });
    expect(
      proposeAmendment({
        current: policy,
        change,
        reason: 'cần thêm lượt',
        authz: authz(['operate'], 'owner'),
      }),
    ).toEqual({
      ok: false,
      error: { code: 'not_admin' },
    });
    expect(policy).toEqual(before);
    expect([
      policy.revision,
      policy.policy_version,
      policy.limits.max_agent_runs,
    ]).toEqual([1, 1, 12]);
  });

  it('Scenario 7: project thắng pack; override chỉ áp khi profile cho phép và không vượt người gọi; khoá ngoài thẩm quyền bị báo', () => {
    const packs = {
      node: {
        file: 'node.yaml',
        text: 'gates: { lint: pack-lint, typecheck: pack-tsc }\n',
      },
    };
    const config = valid(USER, CUSR, packs);
    expect(config.project?.gates).toEqual({
      lint: 'npm run lint',
      typecheck: 'pack-tsc',
      build: 'npm run build',
      unit: 'npm test',
    });

    const task = buildTask({ profile: 'standard' });
    const allowed = freezeTask(config, task, {
      overrides: { 'gates.lint': 'npm run lint:ci' },
    });
    expect(allowed.ok && allowed.value.policy.gates.commands.lint).toBe(
      'npm run lint:ci',
    );

    const notAllowed = freezeTask(config, task, {
      overrides: { 'gates.unit': 'true' },
    });
    expect(
      !notAllowed.ok &&
        notAllowed.error.code === 'config_invalid' &&
        notAllowed.error.diagnostics[0]?.code,
    ).toBe('override_not_allowed');

    const exceeds = freezeTask(config, task, {
      overrides: { 'budgets.max_agent_runs': 100 },
    });
    expect(!exceeds.ok && exceeds.error).toEqual({
      code: 'override_exceeds_caller',
      keys: ['budgets.max_agent_runs'],
    });

    const forbidden = validateConfig({
      user: USER,
      project: {
        ...CUSR,
        text: `${CUSR.text}roles:\n  coder: { binding: [{ model: opus }] }\n`,
      },
      packs: PACKS,
    });
    expect(!forbidden.ok && forbidden.error.map(formatDiagnostic)).toEqual([
      "cusr.yaml:20:1 forbidden_key: khoá 'roles' chỉ thuộc cấu hình người dùng",
    ]);
  });

  it('Scenario 8: ngữ cảnh đã chốt giữ nguyên nội dung và hash khi yêu cầu hay attachment gốc đổi', () => {
    const task = buildTask({
      attachments: [
        {
          name: 'spec.md',
          media_type: 'text/markdown',
          content_ref: 'file://spec.md',
        },
      ],
    });
    const attachments = [
      { name: 'spec.md', media_type: 'text/markdown', content: 'v1' },
    ];
    const r = freezeTask(valid(USER), task, { attachments });
    if (!r.ok) throw new Error('freeze');
    const context = r.value.context;
    const before = structuredClone(context);

    // Nguồn đổi sau khi chốt.
    attachments[0]!.content = 'v2';
    task.description = 'yêu cầu đã sửa';
    task.acceptance.push('tiêu chí mới');

    expect(context).toEqual(before);
    expect(verifyContextHash(context)).toBe(true);
    // Thay đổi chỉ vào qua revision mới, với ngữ cảnh mới.
    const next = freezeTask(
      valid(USER),
      { ...task, revision: 2 },
      { attachments },
    );
    expect(next.ok && next.value.context.context_hash).not.toBe(
      context.context_hash,
    );
  });

  it('Scenario 9: agent_review được báo là chưa hỗ trợ; chốt cho task dùng workflow đó bị từ chối, không đổi sang human', () => {
    const user = source('configs/valid/user-workflows.yaml');
    const project = source('configs/valid/cusr-minimal.yaml', 'cusr.yaml');
    const r = validateConfig({ user, project, packs: {} });
    if (!r.ok) throw new Error('validate');
    expect(
      r.value.unsupported.find((u) => u.workflow === 'wf_b'),
    ).toMatchObject({
      code: 'decision_mode_unsupported',
      points: ['agent_question', 'missing_acceptance'],
      file: 'user-workflows.yaml',
    });
    const f = freezeTask(r.value.config, buildTask({ profile: 'prof_b' }));
    expect(f).toEqual({
      ok: false,
      error: {
        code: 'unsupported_decision_mode',
        points: ['agent_question', 'missing_acceptance'],
      },
    });
  });

  it('Scenario 10: workflow hợp lệ khác software_dev@1 được chấp nhận khi kiểm tra nhưng bị từ chối khi chốt', () => {
    const r = validateConfig({
      user: source('configs/valid/user-workflows.yaml'),
      project: source('configs/valid/cusr-minimal.yaml', 'cusr.yaml'),
      packs: {},
    });
    if (!r.ok) throw new Error('validate');
    expect(r.value.unsupported.find((u) => u.workflow === 'wf_c')?.code).toBe(
      'unsupported_workflow',
    );
    const f = freezeTask(r.value.config, buildTask({ profile: 'prof_c' }));
    expect(!f.ok && f.error.code).toBe('unsupported_workflow');
    expect('value' in f).toBe(false);
  });

  it('Scenario 11: workflow A chỉ human chốt được; workflow B dùng agent bị từ chối kèm lý do', () => {
    const r = validateConfig({
      user: source('configs/valid/user-workflows.yaml'),
      project: source('configs/valid/cusr-minimal.yaml', 'cusr.yaml'),
      packs: {},
    });
    if (!r.ok) throw new Error('validate');
    expect(r.value.unsupported.map((u) => [u.code, u.workflow])).toEqual([
      ['decision_mode_unsupported', 'wf_b'],
      ['unsupported_workflow', 'wf_c'],
    ]);
    const a = freezeTask(r.value.config, buildTask({ profile: 'prof_a' }));
    const b = freezeTask(r.value.config, buildTask({ profile: 'prof_b' }));
    expect(a.ok).toBe(true);
    expect(!b.ok && b.error.code).toBe('unsupported_decision_mode');
  });
});
