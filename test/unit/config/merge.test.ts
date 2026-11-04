import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../../src/config/validate.ts';
import { freeze } from '../../../src/config/freeze.ts';
import { applyOverrides, deepMerge } from '../../../src/config/merge.ts';
import { USER_ONLY_KEYS } from '../../../src/config/schema-user.ts';
import type { ConfigSource } from '../../../src/config/yaml-loader.ts';
import { authz, buildTask } from '../../support/builders.ts';
import { docsFor, MIN_PARTS, MIN_PROJECT, minUser, source } from '../../support/config-fixtures.ts';

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

describe('Configuration authority by file (FR-001)', () => {
  it.each(USER_ONLY_KEYS)('key %s in cusr.yaml reports forbidden_key at that key', (key) => {
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
  });

  it('project keys in user configuration return forbidden_key', () => {
    const r = validateConfig({
      user: minUser({}, 'setup: npm ci\n'),
      packs: {},
    });
    expect(!r.ok && r.error.map((d) => d.code)).toEqual(['forbidden_key']);
  });

  it('packs cannot declare ci.required_checks, pools, extends, or profile', () => {
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

describe('Merge precedence', () => {
  const packs = {
    a: pack('a', 'setup: from-a\nhotspots: [a1]\n'),
    b: pack('b', 'setup: from-b\n'),
  };

  it('later packs in extends override earlier packs', () => {
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

  it('cusr.yaml overrides packs', () => {
    const p = validProject(
      'version: 1\nextends: [a]\nsetup: own\ngates: { build: x, unit: y }\nprofile: standard\n',
      packs,
    );
    expect(p?.setup).toEqual(['own']);
    expect(p?.hotspots).toEqual(['a1']);
  });

  it('maps merge by key; arrays are replaced rather than concatenated', () => {
    const packs2 = {
      p: pack('p', 'gates: { lint: eslint, build: tsc }\nconventions: [A.md, B.md]\n'),
    };
    const p = validProject(
      'version: 1\nextends: [p]\ngates: { unit: vitest }\nconventions: [C.md]\nprofile: standard\n',
      packs2,
    );
    expect(p?.gates).toEqual({ lint: 'eslint', build: 'tsc', unit: 'vitest' });
    expect(p?.conventions).toEqual(['C.md']);
  });

  it('deepMerge replaces scalars and arrays with higher-precedence values', () => {
    expect(deepMerge({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] }, d: 1 })).toEqual({
      a: { b: 1, c: [3] },
      d: 1,
    });
  });

  it('errors in inherited pack keys point to the pack file', () => {
    const r = validateConfig({
      user: USER,
      project: project(
        'version: 1\nextends: [p]\ngates: { build: x, unit: y }\nprofile: standard\n',
      ),
      packs: {
        p: pack('p', 'ci_rules:\n  - match: { job: e2e }\n    class: maybe\n'),
      },
    });
    expect(!r.ok && r.error.map((d) => [d.code, d.file, d.line, d.col])).toEqual([
      ['schema_invalid', 'p.yaml', 3, 5],
    ]);
  });
});

describe('profile', () => {
  it('extends merges parent profiles before children', () => {
    const r = validateConfig({ user: USER, packs: {} });
    expect(r.ok && r.value.config.profiles.heavy).toMatchObject({
      workflow: 'impl',
      allow_models: ['sonnet', 'sol', 'opus'],
      escalation: {
        auto_up_to_tier: 3,
        above: 'ask_human',
        max_escalations: 2,
      },
    });
  });

  it('extends cycles return profile_cycle', () => {
    const r = validateConfig({
      user: minUser({
        profiles:
          'profiles:\n  standard: { workflow: impl, extends: x }\n  x: { extends: standard }\n',
      }),
      packs: {},
    });
    expect(!r.ok && [...new Set(r.error.map((d) => d.code))]).toEqual(['profile_cycle']);
  });

  it('rejects extends beyond the maximum depth', () => {
    const chain = Array.from({ length: 4 }, (_, i) => `  p${i}: { extends: p${i + 1} }\n`).join('');
    const profiles = `profiles:\n  standard: { workflow: impl }\n${chain}  p4: { extends: standard }\n`;
    const r = validateConfig({
      user: minUser({ profiles }),
      packs: {},
      limits: { max_profile_depth: 3 },
    });
    // p0 (depth 5) and p1 (depth 4) exceed 3; p2 and below do not.
    expect(!r.ok && r.error.map((d) => [d.code, d.path.join('.')])).toEqual([
      ['profile_cycle', 'profiles.p3.extends'],
      ['profile_cycle', 'profiles.p4.extends'],
    ]);
    expect(validateConfig({ user: minUser({ profiles }), packs: {} }).ok).toBe(true);
  });
});

describe('Task-creation overrides (stage 4)', () => {
  const validated = (() => {
    const r = validateConfig({
      user: USER,
      project: source('configs/valid/cusr.yaml', 'cusr.yaml'),
      packs: { node: source('packs/node.yaml') },
    });
    if (!r.ok) throw new Error('fixture');
    return r.value.config;
  })();
  const run = (overrides: Record<string, unknown>, roles: ('read' | 'operate' | 'admin')[]) =>
    freeze({
      config: validated,
      task: buildTask({ profile: 'standard' }),
      overrides,
      caller: authz(roles),
      base_sha: 'abc',
      attachments: [],
      ...docsFor(validated),
    });

  it('permitted overrides apply last', () => {
    const r = run(
      {
        'roles.reviewer.binding': [{ model: 'sonnet' }],
        'gates.lint': 'npm run lint:strict',
      },
      ['operate'],
    );
    expect(r.ok && r.value.policy.steps.review?.binding.model).toBe('sonnet');
    expect(r.ok && r.value.policy.gates.commands.lint).toBe('npm run lint:strict');
  });

  it('disallowed keys return override_not_allowed', () => {
    const r = run({ 'escalation.enabled': false }, ['admin']);
    expect(
      !r.ok && r.error.code === 'config_invalid' && r.error.diagnostics.map((d) => d.code),
    ).toEqual(['override_not_allowed']);
  });

  it('operate-only callers cannot widen permissions through overrides', () => {
    const r = run({ 'escalation.max_escalations_per_task': 50 }, ['operate']);
    expect(!r.ok && r.error).toEqual({
      code: 'override_exceeds_caller',
      keys: ['escalation.max_escalations_per_task'],
    });
  });

  it('admins may raise the escalation cap through overrides', () => {
    const r = run({ 'escalation.max_escalations_per_task': 50 }, ['admin']);
    expect(r.ok && r.value.policy.limits.max_escalations).toBe(50);
  });

  it('read-only callers cannot apply overrides', () => {
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

  describe('checks permissions in the effective configuration rather than override names', () => {
    const target = {
      roles: {
        coder: { permissions: 'read_only', binding: [{ model: 'sonnet' }] },
      },
      profile: { escalation: { max_escalations_per_task: 10 } },
      project: {},
    };
    const operate = authz(['operate']);

    it('parent-object overrides cannot bypass leaf permission checks', () => {
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

    it('removing permissions through a parent override cannot bypass the default write check', () => {
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

    it('permits parent-object overrides that preserve permissions', () => {
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

    it('checks whole roles and escalation overrides through parent objects', () => {
      const roles = applyOverrides(
        target,
        { roles: { coder: { permissions: 'write', binding: [] } } },
        ['roles'],
        operate,
      );
      const escalation = applyOverrides(
        target,
        { escalation: { max_escalations_per_task: 99 } },
        ['escalation'],
        operate,
      );
      expect(!roles.ok && roles.error).toEqual({
        code: 'override_exceeds_caller',
        keys: ['roles'],
      });
      expect(!escalation.ok && escalation.error).toEqual({
        code: 'override_exceeds_caller',
        keys: ['escalation'],
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

    it('freeze prevents operate callers from upgrading read_only roles to write', () => {
      const roles = MIN_PARTS.roles.replace(
        'coder: { binding: [{ model: sonnet }] }',
        'coder: { permissions: read_only, binding: [{ model: sonnet }] }',
      );
      const profiles = 'profiles:\n  standard: { workflow: impl, overridable: [roles.coder] }\n';
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

    it('periods in role names cannot bypass permission checks', () => {
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

    it('freeze blocks permission upgrades through a full roles-map override (FR-001)', () => {
      const roles = `${MIN_PARTS.roles}  team.coder: { permissions: read_only, binding: [{ model: sonnet }] }\n`;
      const profiles = 'profiles:\n  standard: { workflow: impl, overridable: [roles] }\n';
      const r = validateConfig({
        user: minUser({ roles, profiles }),
        project: MIN_PROJECT,
        packs: {},
      });
      if (!r.ok) throw new Error('validate');
      const raw = r.value.config.raw.user.roles as Record<string, Record<string, unknown>>;
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

  it('revalidates invalid override values', () => {
    const r = run({ 'roles.reviewer.binding': [{ model: 'gpt' }] }, ['operate']);
    expect(
      !r.ok &&
        r.error.code === 'config_invalid' &&
        r.error.diagnostics.map((d) => [d.code, d.file]),
    ).toEqual([['unknown_model', '<overrides>']]);
  });

  it('freezes minimal configuration without overrides', () => {
    const r = validateConfig({
      user: minUser(),
      project: MIN_PROJECT,
      packs: {},
    });
    expect(r.ok).toBe(true);
  });
});
