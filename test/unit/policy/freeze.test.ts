import { describe, expect, it } from 'vitest';
import { validateConfig, type ValidatedConfig } from '../../../src/config/validate.ts';
import { freeze } from '../../../src/config/freeze.ts';
import { hashText } from '../../../src/shared/hash.ts';
import { verifyContextHash, verifyPolicyHash } from '../../../src/policy/finalize.ts';
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

function config(user: ConfigSource, project: ConfigSource | undefined = CUSR): ValidatedConfig {
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
  it('freezes unlimited defaults and lets a child profile clear inherited caps', () => {
    const c = config(
      minUser({
        profiles: `profiles:
  bounded:
    workflow: impl
    escalation: { max_escalations_per_task: 1 }
  standard:
    extends: bounded
    escalation: { max_escalations_per_task: null }
`,
      }),
    );
    const r = run(c);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.policy.limits).toMatchObject({
      max_agent_runs: null,
      max_wall_ms: null,
      max_escalations: null,
      classes: { infra_retries: null },
      backoff: {
        infra: { max_attempts: null },
        rate_limit: { max_attempts: null },
      },
    });
    expect(verifyPolicyHash(r.value.policy)).toBe(true);
  });

  it('key order and formatting do not affect policy_hash', () => {
    const a = run(USER);
    const b = run(config(source('configs/valid/user-reordered.yaml')));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.value.policy.policy_hash).toBe(a.value.policy.policy_hash);
      expect(b.value.context.context_hash).toBe(a.value.context.context_hash);
    }
  });

  it('equivalent durations (2h and 120m) produce the same hash (FR-004)', () => {
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
      expect(b.value.policy.config_hashes).toEqual(a.value.policy.config_hashes);
      expect(b.value.policy.policy_hash).toBe(a.value.policy.policy_hash);
    }
  });

  it('rejects zero durations during validation without throwing from freeze', () => {
    const user = source('configs/valid/user.yaml');
    const r = validateConfig({
      user: {
        ...user,
        text: user.text.replace('wall_timeout: 45m', 'wall_timeout: 0s'),
      },
      project: CUSR,
      packs: PACKS,
    });
    expect(!r.ok && r.error.map((d) => [d.code, d.path.join('.')])).toEqual([
      ['schema_invalid', 'roles.coder.limits.wall_timeout'],
    ]);
  });

  it('refuses a profile that still declares budgets', () => {
    const r = validateConfig({
      user: minUser({
        profiles: 'profiles:\n  standard: { workflow: impl, budgets: { max_agent_runs: 5 } }\n',
      }),
      packs: {},
    });
    expect(!r.ok && r.error.map((d) => d.code)).toEqual(['schema_invalid']);
  });

  it('snapshots role prompts and project conventions with content and hashes (FR-037)', () => {
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

  it('different prompt content changes context_hash', () => {
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
        p.name === 'prompts/coder.md' ? { ...p, content: 'different' } : p,
      ),
    });
    expect(a.ok && b.ok && a.value.context.context_hash !== b.value.context.context_hash).toBe(
      true,
    );
  });

  it('missing prompt content prevents all snapshots (FR-038)', () => {
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

  it('policy and context share task_id, revision, and base_sha with verifiable hashes', () => {
    const r = run(USER, buildTask({ revision: 3 }));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const { policy, context } = r.value;
    expect([policy.task_id, policy.revision, policy.base_sha]).toEqual([
      context.task_id,
      context.revision,
      context.base_sha,
    ]);
    expect([policy.revision, policy.base_sha, policy.policy_version]).toEqual([3, 'cafe1234', 1]);
    expect(verifyPolicyHash(policy) && verifyContextHash(context)).toBe(true);
  });

  it('without required, every declared gate in run is mandatory', () => {
    const withAutofix = run(USER);
    if (!withAutofix.ok) throw new Error(JSON.stringify(withAutofix.error));
    expect(withAutofix.value.policy.gates.by_step['ci_autofix']).toEqual({
      run: ['format_fix'],
      required: ['format_fix'],
      skipped: [],
    });
    expect(withAutofix.value.policy.gates.by_step['gates']?.required).toEqual(['build', 'unit']);
    // Undeclared format_fix is optional and skipped; it must not become required_gate_missing.
    const minimal = run(config(minUser(), MIN_PROJECT));
    if (!minimal.ok) throw new Error(JSON.stringify(minimal.error));
    expect(minimal.value.policy.gates.by_step['ci_autofix']).toEqual({
      run: [],
      required: [],
      skipped: ['format_fix'],
    });
  });

  it('snapshots attachments with content_hash', () => {
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

  it('missing attachment content prevents all snapshots (FR-038)', () => {
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

  it('selects the first matching allowlisted binding rule', () => {
    const large = run(USER, buildTask({ size: 'L', profile: 'standard' }));
    const heavy = run(USER, buildTask({ size: 'L', profile: 'heavy' }));
    expect(large.ok && large.value.policy.steps.code?.binding.model).toBe('sonnet');
    expect(heavy.ok && heavy.value.policy.steps.code?.binding.model).toBe('opus');
  });

  it('confirmed bindings select matching role rules and preserve the first rule if none match', () => {
    const task = buildTask({ size: 'L', profile: 'heavy' });
    const frozen = (model: string) => {
      const harness = USER.user.models[model]?.harness ?? '';
      const rule = USER.user.roles.coder?.binding.find((b) => b.model === model);
      const r = freeze({
        config: USER,
        task,
        caller: authz(),
        base_sha: 'cafe1234',
        attachments: [],
        ...docsFor(USER),
        selection: {
          worker: { harness, model, effort: rule?.effort ?? 'high' },
          reviewer: null,
        },
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value.policy.steps.code?.binding.model;
    };

    expect(frozen('opus')).toBe('opus');
    expect(frozen('sonnet')).toBe('sonnet');
    expect(frozen('no-such-model')).toBe('opus');
  });

  it('excluding all rules returns no_valid_binding', () => {
    const profiles = 'profiles:\n  standard: { workflow: impl, allow_models: [opus] }\n';
    const r = run(config(minUser({ profiles }), MIN_PROJECT));
    expect(!r.ok && r.error).toEqual({
      code: 'no_valid_binding',
      step: 'ci_fix',
      role: 'coder',
    });
  });

  it('rung status follows the allowlist and auto_up_to_tier', () => {
    const std = run(USER, buildTask({ profile: 'standard' }));
    const heavy = run(USER, buildTask({ profile: 'heavy' }));
    expect(std.ok && std.value.policy.steps.code?.ladder.map((r) => r.state)).toEqual([
      'auto',
      'auto',
      'denied',
    ]);
    expect(heavy.ok && heavy.value.policy.steps.code?.ladder.map((r) => r.state)).toEqual([
      'auto',
      'auto',
      'auto',
    ]);
  });

  it('floor_map handles ladders with different lengths and bindings (R-18)', () => {
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
    // The review ladder has no capability (3, 2); clamp the floor to its last rung.
    expect(review?.floor_map).toEqual({ '2:1': 0, '2:2': 1, '3:2': 1 });
  });

  it('reviewers are always read-only', () => {
    const r = run(USER);
    expect(r.ok && r.value.policy.steps.review?.binding.permissions).toBe('read_only');
    expect(r.ok && r.value.policy.permissions).toMatchObject({
      reviewer: 'read_only',
      coder: 'write',
    });
  });

  it('records skipped undeclared optional gates', () => {
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

  it('freezes required checks and CI rules after pack/project merging', () => {
    const r = run(USER);
    expect(r.ok && r.value.policy.ci).toEqual({
      required_checks: ['build', 'test'],
      rules: [{ match: { job: 'e2e' }, class: 'flaky_or_infra' }],
    });
  });

  it('uses profile limits and default backoff (R-22)', () => {
    const r = run(USER);
    expect(r.ok && r.value.policy.limits).toMatchObject({
      max_agent_runs: null,
      max_wall_ms: null,
      max_escalations: 2,
      backoff: {
        rate_limit: {
          base_ms: 60_000,
          factor: 2,
          max_ms: 1_800_000,
          max_attempts: null,
        },
        infra: {
          base_ms: 5_000,
          factor: 2,
          max_ms: 300_000,
          max_attempts: null,
        },
      },
    });
  });

  it('rejects tasks outside the project allowlist', () => {
    const r = run(USER, buildTask({ project: 'other' }));
    expect(!r.ok && r.error.code).toBe('config_invalid');
  });

  it('disabling escalation retains only the initial rung', () => {
    const profiles = 'profiles:\n  standard: { workflow: impl, escalation: { enabled: false } }\n';
    const roles = MIN_PARTS.roles.replace(
      'coder: { binding: [{ model: sonnet }] }',
      'coder: { binding: [{ model: sonnet }], escalation: { ladder: [{ effort: high }] } }',
    );
    const r = run(config(minUser({ roles, profiles }), MIN_PROJECT));
    expect(r.ok && r.value.policy.steps.code?.ladder).toHaveLength(1);
  });
});
