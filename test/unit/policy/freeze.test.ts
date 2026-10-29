import { describe, expect, it } from 'vitest';
import {
  validateConfig,
  type ValidatedConfig,
} from '../../../src/config/validate.ts';
import { freeze } from '../../../src/config/freeze.ts';
import { hashText } from '../../../src/shared/hash.ts';
import {
  verifyContextHash,
  verifyPolicyHash,
} from '../../../src/policy/finalize.ts';
import type { ConfigSource } from '../../../src/config/yaml-loader.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { authz, buildTask } from '../../support/builders.ts';
import {
  docsFor,
  MIN_PARTS,
  MIN_PROJECT,
  minUser,
  PACKS,
  source,
} from '../../support/config-fixtures.ts';

const CUSR = source('configs/valid/cusr.yaml', 'cusr.yaml');

function config(
  user: ConfigSource,
  project: ConfigSource | undefined = CUSR,
): ValidatedConfig {
  const r = validateConfig({
    user,
    ...(project ? { project } : {}),
    packs: PACKS,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error, null, 2));
  return r.value.config;
}

function run(
  c: ValidatedConfig,
  task: CanonicalTask = buildTask(),
  attachments: { name: string; media_type: string; content: string }[] = [],
) {
  return freeze({
    config: c,
    task,
    caller: authz(),
    base_sha: 'cafe1234',
    attachments,
    ...docsFor(c),
  });
}

const USER = config(source('configs/valid/user.yaml'));

describe('freeze (FR-004, FR-037)', () => {
  it('cấu hình chỉ khác thứ tự khoá và định dạng cho cùng policy_hash', () => {
    const a = run(USER);
    const b = run(config(source('configs/valid/user-reordered.yaml')));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.value.policy.policy_hash).toBe(a.value.policy.policy_hash);
      expect(b.value.context.context_hash).toBe(a.value.context.context_hash);
    }
  });

  it('cấu hình tương đương về ngữ nghĩa (2h và 120m) cho cùng hash (FR-004)', () => {
    const user = source('configs/valid/user.yaml');
    const a = run(config(user));
    const b = run(
      config({
        ...user,
        text: user.text.replace('max_wall: 6h', 'max_wall: 360m'),
      }),
    );
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.value.policy.config_hashes).toEqual(
        a.value.policy.config_hashes,
      );
      expect(b.value.policy.policy_hash).toBe(a.value.policy.policy_hash);
    }
  });

  it('thời lượng 0 bị từ chối khi kiểm tra cấu hình, không làm freeze ném lỗi', () => {
    const user = source('configs/valid/user.yaml');
    const r = validateConfig({
      user: {
        ...user,
        text: user.text.replace('max_wall: 6h', 'max_wall: 0s'),
      },
      project: CUSR,
      packs: PACKS,
    });
    expect(!r.ok && r.error.map((d) => [d.code, d.path.join('.')])).toEqual([
      ['schema_invalid', 'profiles.standard.budgets.max_wall'],
    ]);
  });

  it('prompt của role và conventions của project được chụp kèm nội dung và hash (FR-037)', () => {
    const r = run(USER);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.context.prompt_refs.map((p) => p.name)).toEqual([
      'prompts/coder.md',
      'prompts/fixer.md',
      'prompts/reviewer.md',
      'prompts/scout.md',
    ]);
    expect(r.value.context.prompt_refs[0]).toEqual({
      name: 'prompts/coder.md',
      content: '# prompts/coder.md\n',
      content_hash: hashText('# prompts/coder.md\n'),
    });
    expect(r.value.context.conventions).toEqual([
      {
        name: 'AGENTS.md',
        content: '# AGENTS.md\n',
        content_hash: hashText('# AGENTS.md\n'),
      },
    ]);
  });

  it('nội dung prompt khác cho context_hash khác', () => {
    const docs = docsFor(USER);
    const a = freeze({
      config: USER,
      task: buildTask(),
      caller: authz(),
      base_sha: 'x',
      attachments: [],
      ...docs,
    });
    const b = freeze({
      config: USER,
      task: buildTask(),
      caller: authz(),
      base_sha: 'x',
      attachments: [],
      ...docs,
      prompts: docs.prompts.map((p) =>
        p.name === 'prompts/coder.md' ? { ...p, content: 'khác' } : p,
      ),
    });
    expect(
      a.ok &&
        b.ok &&
        a.value.context.context_hash !== b.value.context.context_hash,
    ).toBe(true);
  });

  it('thiếu nội dung prompt thì không trả snapshot nào (FR-038)', () => {
    const docs = docsFor(USER);
    const r = freeze({
      config: USER,
      task: buildTask(),
      caller: authz(),
      base_sha: 'x',
      attachments: [],
      conventions: docs.conventions,
      prompts: docs.prompts.slice(1),
    });
    expect(
      !r.ok &&
        r.error.code === 'config_invalid' &&
        r.error.diagnostics.map((d) => [d.file, d.path.join('.')]),
    ).toEqual([['<prompts>', 'prompts.prompts/coder.md']]);
  });

  it('policy và context gắn cùng task_id, revision, base_sha; hash tự kiểm được', () => {
    const r = run(USER, buildTask({ revision: 3 }));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const { policy, context } = r.value;
    expect([policy.task_id, policy.revision, policy.base_sha]).toEqual([
      context.task_id,
      context.revision,
      context.base_sha,
    ]);
    expect([policy.revision, policy.base_sha, policy.policy_version]).toEqual([
      3,
      'cafe1234',
      1,
    ]);
    expect(verifyPolicyHash(policy) && verifyContextHash(context)).toBe(true);
  });

  it('bước gate không khai required: mọi gate đã khai báo trong run là bắt buộc', () => {
    const withAutofix = run(USER);
    if (!withAutofix.ok) throw new Error(JSON.stringify(withAutofix.error));
    expect(withAutofix.value.policy.gates.by_step['ci_autofix']).toEqual({
      run: ['format_fix'],
      required: ['format_fix'],
      skipped: [],
    });
    expect(withAutofix.value.policy.gates.by_step['gates']?.required).toEqual([
      'build',
      'unit',
    ]);
    // Project không khai format_fix: gate bị bỏ như optional, không thành required_gate_missing.
    const minimal = run(config(minUser(), MIN_PROJECT));
    if (!minimal.ok) throw new Error(JSON.stringify(minimal.error));
    expect(minimal.value.policy.gates.by_step['ci_autofix']).toEqual({
      run: [],
      required: [],
      skipped: ['format_fix'],
    });
  });

  it('attachment được chụp kèm content_hash', () => {
    const task = buildTask({
      attachments: [
        {
          name: 'spec.md',
          media_type: 'text/markdown',
          content_ref: 'file://spec.md',
        },
      ],
    });
    const r = run(USER, task, [
      { name: 'spec.md', media_type: 'text/markdown', content: '# Spec\n' },
    ]);
    expect(r.ok && r.value.context.attachments).toEqual([
      {
        name: 'spec.md',
        media_type: 'text/markdown',
        content: '# Spec\n',
        content_hash: hashText('# Spec\n'),
      },
    ]);
  });

  it('thiếu nội dung attachment thì không trả snapshot nào (FR-038)', () => {
    const task = buildTask({
      attachments: [
        {
          name: 'spec.md',
          media_type: 'text/markdown',
          content_ref: 'file://spec.md',
        },
      ],
    });
    const r = run(USER, task, []);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('config_invalid');
    expect('value' in r).toBe(false);
  });

  it('binding: rule đầu tiên khớp; rule bị allowlist loại thì thử rule kế', () => {
    // coder: L/XL → opus, còn lại sonnet. Profile standard không cho opus.
    const large = run(USER, buildTask({ size: 'L', profile: 'standard' }));
    const heavy = run(USER, buildTask({ size: 'L', profile: 'heavy' }));
    expect(large.ok && large.value.policy.steps.code?.binding.model).toBe(
      'sonnet',
    );
    expect(heavy.ok && heavy.value.policy.steps.code?.binding.model).toBe(
      'opus',
    );
  });

  it('no_valid_binding khi allowlist loại hết rule', () => {
    const profiles =
      'profiles:\n  standard: { workflow: impl, allow_models: [opus], budgets: { max_agent_runs: 5, max_wall: 1h } }\n';
    const r = run(config(minUser({ profiles }), MIN_PROJECT));
    expect(!r.ok && r.error).toEqual({
      code: 'no_valid_binding',
      step: 'ci_fix',
      role: 'coder',
    });
  });

  it('trạng thái nấc theo allowlist và auto_up_to_tier', () => {
    const std = run(USER, buildTask({ profile: 'standard' }));
    const heavy = run(USER, buildTask({ profile: 'heavy' }));
    expect(
      std.ok && std.value.policy.steps.code?.ladder.map((r) => r.state),
    ).toEqual(['auto', 'auto', 'denied']);
    expect(
      heavy.ok && heavy.value.policy.steps.code?.ladder.map((r) => r.state),
    ).toEqual(['auto', 'auto', 'auto']);
  });

  it('floor_map ánh xạ mức năng lực sang hai thang khác độ dài và khác binding (R-18)', () => {
    const r = run(USER, buildTask({ profile: 'heavy' }));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const { code, review } = r.value.policy.steps;
    // code: sonnet/medium (2,1) → sonnet/high (2,2) → opus/high (3,2); review: sol/medium (2,1) → sol/high (2,2).
    expect(code?.ladder.map((x) => x.level)).toEqual([
      { tier: 2, effort_rank: 1 },
      { tier: 2, effort_rank: 2 },
      { tier: 3, effort_rank: 2 },
    ]);
    expect(code?.floor_map).toEqual({ '2:1': 0, '2:2': 1, '3:2': 2 });
    // Thang review không có mức (3,2): sàn đó ánh xạ về nấc cuối của review, không vượt thang.
    expect(review?.floor_map).toEqual({ '2:1': 0, '2:2': 1, '3:2': 1 });
  });

  it('reviewer luôn chỉ đọc', () => {
    const r = run(USER);
    expect(r.ok && r.value.policy.steps.review?.binding.permissions).toBe(
      'read_only',
    );
    expect(r.ok && r.value.policy.permissions).toMatchObject({
      reviewer: 'read_only',
      coder: 'write',
    });
  });

  it('gate optional mà project không khai báo bị bỏ và được ghi', () => {
    const r = run(
      config(source('configs/valid/user.yaml'), {
        file: 'cusr.yaml',
        text: 'version: 1\ngates: { build: make, unit: make test }\nprofile: standard\n',
      }),
    );
    expect(r.ok && r.value.policy.gates.by_step.gates).toEqual({
      run: ['build', 'unit'],
      required: ['build', 'unit'],
      skipped: ['lint'],
    });
    expect(r.ok && r.value.policy.gates.by_step.ci_autofix).toEqual({
      run: [],
      required: [],
      skipped: ['format_fix'],
    });
  });

  it('chốt ci.required_checks và ci_rules đã hợp nhất pack → project', () => {
    const r = run(USER);
    expect(r.ok && r.value.policy.ci).toEqual({
      required_checks: ['build', 'test'],
      rules: [{ match: { job: 'e2e' }, class: 'flaky_or_infra' }],
    });
  });

  it('chế độ quyết định được chốt đủ, chỉ human (FR-039)', () => {
    const r = run(USER);
    expect(
      r.ok && new Set(Object.values(r.value.policy.decision_modes)),
    ).toEqual(new Set(['human']));
  });

  it('giới hạn lấy từ profile, backoff có mặc định (R-22)', () => {
    const r = run(USER);
    expect(r.ok && r.value.policy.limits).toMatchObject({
      max_agent_runs: 12,
      max_wall_ms: 6 * 3_600_000,
      max_escalations: 2,
      backoff: {
        rate_limit: {
          base_ms: 60_000,
          factor: 2,
          max_ms: 1_800_000,
          max_attempts: 5,
        },
        infra: { base_ms: 5_000, factor: 2, max_ms: 300_000, max_attempts: 3 },
      },
    });
  });

  it('unsupported_workflow khi structure_hash khác software_dev@1 (FR-041)', () => {
    const c = config(
      source('configs/valid/user-workflows.yaml'),
      source('configs/valid/cusr-minimal.yaml', 'cusr.yaml'),
    );
    const r = run(
      {
        ...c,
        profiles: {
          ...c.profiles,
          prof_c: { ...c.profiles.prof_c!, allow_no_gates: true },
        },
      },
      buildTask({ profile: 'prof_c' }),
    );
    expect(!r.ok && r.error.code).toBe('unsupported_workflow');
    expect(
      !r.ok && r.error.code === 'unsupported_workflow' && r.error.workflow,
    ).toBe('wf_c');
  });

  it('unsupported_decision_mode khi workflow của task dùng decider (FR-039)', () => {
    const c = config(
      source('configs/valid/user-workflows.yaml'),
      source('configs/valid/cusr-minimal.yaml', 'cusr.yaml'),
    );
    const r = run(c, buildTask({ profile: 'prof_b' }));
    expect(!r.ok && r.error).toEqual({
      code: 'unsupported_decision_mode',
      points: ['agent_question', 'missing_acceptance'],
    });
  });

  it('task dùng project không có trong danh sách repo được phép bị từ chối', () => {
    const r = run(USER, buildTask({ project: 'other' }));
    expect(!r.ok && r.error.code).toBe('config_invalid');
  });

  it('escalation tắt thì thang chỉ còn nấc khởi đầu', () => {
    const profiles =
      'profiles:\n  standard: { workflow: impl, escalation: { enabled: false }, budgets: { max_agent_runs: 5, max_wall: 1h } }\n';
    const roles = MIN_PARTS.roles.replace(
      'coder: { binding: [{ model: sonnet }] }',
      'coder: { binding: [{ model: sonnet }], escalation: { ladder: [{ effort: high }] } }',
    );
    const r = run(config(minUser({ roles, profiles }), MIN_PROJECT));
    expect(r.ok && r.value.policy.steps.code?.ladder).toHaveLength(1);
  });
});
