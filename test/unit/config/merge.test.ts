import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../../src/config/validate.ts';
import { freeze } from '../../../src/config/freeze.ts';
import { applyOverrides, deepMerge } from '../../../src/config/merge.ts';
import { USER_ONLY_KEYS } from '../../../src/config/schema-user.ts';
import type { ConfigSource } from '../../../src/config/yaml-loader.ts';
import { authz, buildTask } from '../../support/builders.ts';
import {
  docsFor,
  MIN_PARTS,
  MIN_PROJECT,
  minUser,
  source,
} from '../../support/config-fixtures.ts';

const USER = source('configs/valid/user.yaml');
const project = (text: string): ConfigSource => ({ file: 'cusr.yaml', text });
const pack = (name: string, text: string): ConfigSource => ({
  file: `${name}.yaml`,
  text,
});

function validProject(text: string, packs: Record<string, ConfigSource> = {}) {
  const r = validateConfig({ user: USER, project: project(text), packs });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value.config.project;
}

describe('thẩm quyền theo file (FR-001)', () => {
  it.each(USER_ONLY_KEYS)(
    'khoá %s trong cusr.yaml là forbidden_key tại chính khoá đó',
    (key) => {
      const r = validateConfig({
        user: USER,
        project: project(
          `version: 1\ngates: { build: make, unit: t }\n${key}: {}\nprofile: standard\n`,
        ),
        packs: {},
      });
      expect(r.ok).toBe(false);
      if (!r.ok)
        expect(r.error.map((d) => [d.code, d.file, d.line, d.col])).toEqual([
          ['forbidden_key', 'cusr.yaml', 3, 1],
        ]);
    },
  );

  it('khoá của project trong cấu hình người dùng là forbidden_key', () => {
    const r = validateConfig({
      user: minUser({}, 'setup: npm ci\n'),
      packs: {},
    });
    expect(!r.ok && r.error.map((d) => d.code)).toEqual(['forbidden_key']);
  });

  it('pack không được khai báo ci.required_checks, pools, extends, profile', () => {
    const r = validateConfig({
      user: USER,
      project: project(
        'version: 1\nextends: [p]\ngates: { build: make, unit: t }\nprofile: standard\n',
      ),
      packs: {
        p: pack('p', 'ci: { required_checks: [x] }\npools: { db: 1 }\n'),
      },
    });
    expect(!r.ok && r.error.map((d) => [d.code, d.file, d.line])).toEqual([
      ['forbidden_key', 'p.yaml', 1],
      ['forbidden_key', 'p.yaml', 2],
    ]);
  });
});

describe('thứ tự hợp nhất', () => {
  const packs = {
    a: pack('a', 'setup: from-a\nhotspots: [a1]\n'),
    b: pack('b', 'setup: from-b\n'),
  };

  it('pack sau trong extends ghi đè pack trước', () => {
    expect(
      validProject(
        'version: 1\nextends: [a, b]\ngates: { build: x, unit: y }\nprofile: standard\n',
        packs,
      )?.setup,
    ).toEqual(['from-b']);
    expect(
      validProject(
        'version: 1\nextends: [b, a]\ngates: { build: x, unit: y }\nprofile: standard\n',
        packs,
      )?.setup,
    ).toEqual(['from-a']);
  });

  it('cusr.yaml thắng pack', () => {
    const p = validProject(
      'version: 1\nextends: [a]\nsetup: own\ngates: { build: x, unit: y }\nprofile: standard\n',
      packs,
    );
    expect(p?.setup).toEqual(['own']);
    expect(p?.hotspots).toEqual(['a1']);
  });

  it('map hợp nhất theo khoá, mảng bị thay thế không nối', () => {
    const packs2 = {
      p: pack(
        'p',
        'gates: { lint: eslint, build: tsc }\nconventions: [A.md, B.md]\n',
      ),
    };
    const p = validProject(
      'version: 1\nextends: [p]\ngates: { unit: vitest }\nconventions: [C.md]\nprofile: standard\n',
      packs2,
    );
    expect(p?.gates).toEqual({ lint: 'eslint', build: 'tsc', unit: 'vitest' });
    expect(p?.conventions).toEqual(['C.md']);
  });

  it('deepMerge: giá trị vô hướng và mảng của lớp trên thắng', () => {
    expect(
      deepMerge({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] }, d: 1 }),
    ).toEqual({ a: { b: 1, c: [3] }, d: 1 });
  });

  it('lỗi ở khoá kế thừa từ pack chỉ về file pack', () => {
    const r = validateConfig({
      user: USER,
      project: project(
        'version: 1\nextends: [p]\ngates: { build: x, unit: y }\nprofile: standard\n',
      ),
      packs: {
        p: pack('p', 'ci_rules:\n  - match: { job: e2e }\n    class: maybe\n'),
      },
    });
    expect(
      !r.ok && r.error.map((d) => [d.code, d.file, d.line, d.col]),
    ).toEqual([['schema_invalid', 'p.yaml', 3, 5]]);
  });
});

describe('profile', () => {
  it('extends hợp nhất profile cha trước con', () => {
    const r = validateConfig({ user: USER, packs: {} });
    expect(r.ok && r.value.config.profiles.heavy).toMatchObject({
      workflow: 'impl',
      allow_models: ['sonnet', 'sol', 'opus'],
      max_agent_runs: 12,
      escalation: {
        auto_up_to_tier: 3,
        above: 'ask_human',
        max_escalations: 2,
      },
    });
  });

  it('profile_cycle khi extends tạo chu trình', () => {
    const r = validateConfig({
      user: minUser({
        profiles:
          'profiles:\n  standard: { workflow: impl, budgets: { max_agent_runs: 1, max_wall: 1h }, extends: x }\n  x: { extends: standard }\n',
      }),
      packs: {},
    });
    expect(!r.ok && [...new Set(r.error.map((d) => d.code))]).toEqual([
      'profile_cycle',
    ]);
  });

  it('extends sâu quá giới hạn bị từ chối', () => {
    const chain = Array.from(
      { length: 4 },
      (_, i) => `  p${i}: { extends: p${i + 1} }\n`,
    ).join('');
    const profiles = `profiles:\n  standard: { workflow: impl, budgets: { max_agent_runs: 1, max_wall: 1h } }\n${chain}  p4: { extends: standard }\n`;
    const r = validateConfig({
      user: minUser({ profiles }),
      packs: {},
      limits: { max_profile_depth: 3 },
    });
    // p0 (5 cấp) và p1 (4 cấp) vượt 3; p2 trở xuống không.
    expect(!r.ok && r.error.map((d) => [d.code, d.path.join('.')])).toEqual([
      ['profile_cycle', 'profiles.p3.extends'],
      ['profile_cycle', 'profiles.p4.extends'],
    ]);
    expect(validateConfig({ user: minUser({ profiles }), packs: {} }).ok).toBe(
      true,
    );
  });
});

describe('override khi tạo task (bước 4)', () => {
  const validated = (() => {
    const r = validateConfig({
      user: USER,
      project: source('configs/valid/cusr.yaml', 'cusr.yaml'),
      packs: { node: source('packs/node.yaml') },
    });
    if (!r.ok) throw new Error('fixture');
    return r.value.config;
  })();
  const run = (
    overrides: Record<string, unknown>,
    roles: ('read' | 'operate' | 'admin')[],
  ) =>
    freeze({
      config: validated,
      task: buildTask({ profile: 'standard' }),
      overrides,
      caller: authz(roles),
      base_sha: 'abc',
      attachments: [],
      ...docsFor(validated),
    });

  it('override được profile cho phép thì áp sau cùng', () => {
    const r = run(
      {
        'roles.reviewer.binding': [{ model: 'sonnet' }],
        'gates.lint': 'npm run lint:strict',
      },
      ['operate'],
    );
    expect(r.ok && r.value.policy.steps.review?.binding.model).toBe('sonnet');
    expect(r.ok && r.value.policy.gates.commands.lint).toBe(
      'npm run lint:strict',
    );
  });

  it('override_not_allowed khi profile không cho khoá đó', () => {
    const r = run({ 'budgets.max_wall': '9h' }, ['admin']);
    expect(
      !r.ok &&
        r.error.code === 'config_invalid' &&
        r.error.diagnostics.map((d) => d.code),
    ).toEqual(['override_not_allowed']);
  });

  it('override_exceeds_caller khi override nới quyền mà người gọi chỉ có operate', () => {
    const r = run({ 'budgets.max_agent_runs': 50 }, ['operate']);
    expect(!r.ok && r.error).toEqual({
      code: 'override_exceeds_caller',
      keys: ['budgets.max_agent_runs'],
    });
  });

  it('người gọi có admin được nới ngân sách qua override', () => {
    const r = run({ 'budgets.max_agent_runs': 50 }, ['admin']);
    expect(r.ok && r.value.policy.limits.max_agent_runs).toBe(50);
  });

  it('người gọi chỉ có read không override được gì', () => {
    const r = applyOverrides(
      { roles: {}, profile: {}, project: {} },
      { 'gates.lint': 'x' },
      ['gates.lint'],
      authz(['read']),
    );
    expect(!r.ok && r.error).toEqual({
      code: 'override_exceeds_caller',
      keys: ['gates.lint'],
    });
  });

  describe('quyền được xét trên cấu hình sau override, không trên tên khoá', () => {
    const target = {
      roles: {
        coder: { permissions: 'read_only', binding: [{ model: 'sonnet' }] },
      },
      profile: { budgets: { max_agent_runs: 10 } },
      project: {},
    };
    const operate = authz(['operate']);

    it('override object cha nâng permissions bị chặn như khoá lá', () => {
      const viaParent = applyOverrides(
        target,
        {
          'roles.coder': {
            permissions: 'write',
            binding: [{ model: 'sonnet' }],
          },
        },
        ['roles.coder'],
        operate,
      );
      const viaLeaf = applyOverrides(
        target,
        { 'roles.coder.permissions': 'write' },
        ['roles.coder'],
        operate,
      );
      expect(!viaParent.ok && viaParent.error).toEqual({
        code: 'override_exceeds_caller',
        keys: ['roles.coder'],
      });
      expect(!viaLeaf.ok && viaLeaf.error).toEqual({
        code: 'override_exceeds_caller',
        keys: ['roles.coder.permissions'],
      });
    });

    it('override object cha bỏ permissions (về mặc định write) cũng bị chặn', () => {
      const r = applyOverrides(
        target,
        { 'roles.coder': { binding: [{ model: 'opus' }] } },
        ['roles.coder'],
        operate,
      );
      expect(!r.ok && r.error).toEqual({
        code: 'override_exceeds_caller',
        keys: ['roles.coder'],
      });
    });

    it('override object cha giữ nguyên permissions thì được', () => {
      const r = applyOverrides(
        target,
        {
          'roles.coder': {
            permissions: 'read_only',
            binding: [{ model: 'opus' }],
          },
        },
        ['roles.coder'],
        operate,
      );
      expect(r.ok).toBe(true);
    });

    it('override cả roles hay budgets qua object cha cũng bị xét', () => {
      const roles = applyOverrides(
        target,
        { roles: { coder: { permissions: 'write', binding: [] } } },
        ['roles'],
        operate,
      );
      const budgets = applyOverrides(
        target,
        { budgets: { max_agent_runs: 99 } },
        ['budgets'],
        operate,
      );
      expect(!roles.ok && roles.error).toEqual({
        code: 'override_exceeds_caller',
        keys: ['roles'],
      });
      expect(!budgets.ok && budgets.error).toEqual({
        code: 'override_exceeds_caller',
        keys: ['budgets'],
      });
      expect(
        applyOverrides(
          target,
          { 'roles.coder': { permissions: 'write', binding: [] } },
          ['roles.coder'],
          authz(['admin']),
        ).ok,
      ).toBe(true);
    });

    it('qua freeze: caller operate không nâng được role read_only lên write', () => {
      const roles = MIN_PARTS.roles.replace(
        'coder: { binding: [{ model: sonnet }] }',
        'coder: { permissions: read_only, binding: [{ model: sonnet }] }',
      );
      const profiles =
        'profiles:\n  standard: { workflow: impl, overridable: [roles.coder], budgets: { max_agent_runs: 5, max_wall: 1h } }\n';
      const r = validateConfig({
        user: minUser({ roles, profiles }),
        project: MIN_PROJECT,
        packs: {},
      });
      if (!r.ok) throw new Error('validate');
      const f = freeze({
        config: r.value.config,
        task: buildTask({ profile: 'standard' }),
        overrides: {
          'roles.coder': {
            permissions: 'write',
            binding: [{ model: 'sonnet' }],
          },
        },
        caller: authz(['operate']),
        base_sha: 'abc',
        attachments: [],
      });
      expect(!f.ok && f.error).toEqual({
        code: 'override_exceeds_caller',
        keys: ['roles.coder'],
      });
    });

    it('tên role chứa dấu chấm không lọt khỏi luật quyền', () => {
      const dotted = {
        roles: {
          'team.coder': {
            permissions: 'read_only',
            binding: [{ model: 'sonnet' }],
          },
        },
        profile: {},
        project: {},
      };
      const r = applyOverrides(
        dotted,
        {
          roles: {
            'team.coder': {
              permissions: 'write',
              binding: [{ model: 'sonnet' }],
            },
          },
        },
        ['roles'],
        operate,
      );
      expect(!r.ok && r.error).toEqual({
        code: 'override_exceeds_caller',
        keys: ['roles'],
      });
      const same = applyOverrides(
        dotted,
        {
          roles: {
            'team.coder': {
              permissions: 'read_only',
              binding: [{ model: 'opus' }],
            },
          },
        },
        ['roles'],
        operate,
      );
      expect(same.ok).toBe(true);
    });

    it('qua freeze: thay cả map roles để nâng role có dấu chấm bị chặn (FR-001)', () => {
      const roles = `${MIN_PARTS.roles}  team.coder: { permissions: read_only, binding: [{ model: sonnet }] }\n`;
      const profiles =
        'profiles:\n  standard: { workflow: impl, overridable: [roles], budgets: { max_agent_runs: 5, max_wall: 1h } }\n';
      const r = validateConfig({
        user: minUser({ roles, profiles }),
        project: MIN_PROJECT,
        packs: {},
      });
      if (!r.ok) throw new Error('validate');
      const raw = r.value.config.raw.user.roles as Record<
        string,
        Record<string, unknown>
      >;
      expect(raw['team.coder']?.['permissions']).toBe('read_only');
      const f = freeze({
        config: r.value.config,
        task: buildTask({ profile: 'standard' }),
        overrides: {
          roles: {
            ...raw,
            'team.coder': { ...raw['team.coder'], permissions: 'write' },
          },
        },
        caller: authz(['operate']),
        base_sha: 'abc',
        attachments: [],
        ...docsFor(r.value.config),
      });
      expect(!f.ok && f.error).toEqual({
        code: 'override_exceeds_caller',
        keys: ['roles'],
      });
    });
  });

  it('giá trị override sai được kiểm lại như cấu hình', () => {
    const r = run({ 'roles.reviewer.binding': [{ model: 'gpt' }] }, [
      'operate',
    ]);
    expect(
      !r.ok &&
        r.error.code === 'config_invalid' &&
        r.error.diagnostics.map((d) => [d.code, d.file]),
    ).toEqual([['unknown_model', '<overrides>']]);
  });

  it('cấu hình tối thiểu không override vẫn chốt được', () => {
    const r = validateConfig({
      user: minUser(),
      project: MIN_PROJECT,
      packs: {},
    });
    expect(r.ok).toBe(true);
  });
});
