import { describe, expect, it } from 'vitest';
import { validateConfig, type ValidatedConfig } from '../../src/config/validate.ts';
import { freeze } from '../../src/config/freeze.ts';
import { formatDiagnostic } from '../../src/config/positions.ts';
import { proposeAmendment } from '../../src/policy/amendment.ts';
import { verifyContextHash, verifyPolicyHash } from '../../src/policy/finalize.ts';
import type { ConfigSource } from '../../src/config/yaml-loader.ts';
import type { CanonicalTask } from '../../src/domain/task.ts';
import { SOFTWARE_DEV } from '../../src/engine/workflows/software-dev.ts';
import { structureHash } from '../../src/policy/structure-hash.ts';
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

function errorsOf(user: ConfigSource, project: ConfigSource | undefined = MIN_PROJECT): string[] {
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

describe('US1 - Validate configuration and freeze policy', () => {
  it('Scenario 1: a graph key in user config names the key to remove, with its position', () => {
    const workflows =
      'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      gates:\n        next: { pass: review, fail: fixx }\n';
    expect(errorsOf(minUser({ workflows }))).toEqual([
      "config.yaml:15:9 workflow_key_removed: 'next' can no longer be set: the software_dev@1 graph is fixed in code; remove workflows.impl.steps.gates.next (docs/config-upgrade.md)",
    ]);
  });

  it('Scenario 2: a workflow declaring its own graph is rejected key by key', () => {
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
        next: { done: finish, needs_input: ask, needs_context: retry, blocked: escalate }
      finish: { kind: complete }
`;
    const errs = errorsOf(minUser({ workflows }));
    expect(errs.map((e) => e.replace(/^config\.yaml:\d+:\d+ /, ''))).toEqual([
      'schema_invalid: base is required and must be software_dev@1',
    ]);
    const based = workflows.replace('  loop:\n', '  loop:\n    base: software_dev@1\n');
    expect(errorsOf(minUser({ workflows: based })).map((e) => e.split(' ')[1])).toEqual([
      'workflow_key_removed:',
      'workflow_key_removed:',
      'workflow_key_removed:',
      'workflow_key_removed:',
      'workflow_key_removed:',
      'unknown_step:',
    ]);
  });

  it('Scenario 3: key order and formatting do not change the policy hash', () => {
    const task = buildTask();
    const a = freezeTask(valid(USER), task);
    const b = freezeTask(valid(source('configs/valid/user-reordered.yaml')), task);
    expect(a.ok && b.ok && a.value.policy.policy_hash === b.value.policy.policy_hash).toBe(true);
  });

  it('Scenario 4: later configuration edits do not change a frozen policy', () => {
    const first = freezeTask(valid(USER), buildTask());
    if (!first.ok) throw new Error('freeze');
    const frozen = structuredClone(first.value.policy);

    const edited = {
      ...USER,
      text: USER.text.replace('max_escalations_per_task: 2', 'max_escalations_per_task: 30'),
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
    expect(first.value.policy.limits.max_escalations).toBe(2);
    expect(later.value.policy.limits.max_escalations).toBe(30);
  });

  it('Scenario 5: unreachable ladder rungs report an error', () => {
    const roles = MIN_PARTS.roles.replace(
      'coder: { binding: [{ model: sonnet }] }',
      'coder:\n    binding: [{ model: sonnet }]\n    escalation:\n      ladder: [{ effort: high }, { model: opus }]',
    );
    const workflows =
      'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      code: { max_visits: 4 }\n';
    const errs = errorsOf(minUser({ roles, workflows }));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('unreachable_rung');
    expect(errs[0]).toContain("Rung 2 of role 'coder'");
  });

  it('Scenario 6: actor-only and operate-only amendments are rejected without changing the policy', () => {
    const r = freezeTask(valid(USER), buildTask());
    if (!r.ok) throw new Error('freeze');
    const policy = r.value.policy;
    const before = structuredClone(policy);
    const change = { limits: { ...policy.limits, max_agent_runs: 99 } };

    expect(
      proposeAmendment({
        current: policy,
        change,
        reason: 'Additional runs are required',
        authz: null,
      }),
    ).toEqual({ ok: false, error: { code: 'not_admin' } });
    expect(
      proposeAmendment({
        current: policy,
        change,
        reason: 'Additional runs are required',
        authz: authz(['operate'], 'owner'),
      }),
    ).toEqual({
      ok: false,
      error: { code: 'not_admin' },
    });
    expect(policy).toEqual(before);
    expect([policy.revision, policy.policy_version, policy.limits.max_agent_runs]).toEqual([
      1,
      1,
      null,
    ]);
  });

  it('Scenario 7: project overrides pack; overrides respect profile and caller permissions; forbidden keys report errors', () => {
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
    expect(allowed.ok && allowed.value.policy.gates.commands.lint).toBe('npm run lint:ci');

    const notAllowed = freezeTask(config, task, {
      overrides: { 'gates.unit': 'true' },
    });
    expect(
      !notAllowed.ok &&
        notAllowed.error.code === 'config_invalid' &&
        notAllowed.error.diagnostics[0]?.code,
    ).toBe('override_not_allowed');

    const exceeds = freezeTask(config, task, {
      overrides: { 'escalation.max_escalations_per_task': 100 },
    });
    expect(!exceeds.ok && exceeds.error).toEqual({
      code: 'override_exceeds_caller',
      keys: ['escalation.max_escalations_per_task'],
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
      "cusr.yaml:20:1 forbidden_key: Key 'roles' is only allowed in the user configuration",
    ]);
  });

  it('Scenario 8: frozen context content and hashes survive source and attachment changes', () => {
    const task = buildTask({
      attachments: [
        {
          name: 'spec.md',
          media_type: 'text/markdown',
          content_ref: 'file://spec.md',
        },
      ],
    });
    const attachments = [{ name: 'spec.md', media_type: 'text/markdown', content: 'v1' }];
    const r = freezeTask(valid(USER), task, { attachments });
    if (!r.ok) throw new Error('freeze');
    const context = r.value.context;
    const before = structuredClone(context);

    attachments[0]!.content = 'v2';
    task.description = 'Updated request';
    task.acceptance.push('New criterion');

    expect(context).toEqual(before);
    expect(verifyContextHash(context)).toBe(true);

    const next = freezeTask(valid(USER), { ...task, revision: 2 }, { attachments });
    expect(next.ok && next.value.context.context_hash).not.toBe(context.context_hash);
  });

  it('Scenario 10: tunables reach the frozen graph; the graph stays software_dev@1', () => {
    const r = validateConfig({
      user: source('configs/valid/user-workflows.yaml'),
      project: source('configs/valid/cusr-minimal.yaml', 'cusr.yaml'),
      packs: {},
    });
    if (!r.ok) throw new Error(r.error.map(formatDiagnostic).join('\n'));
    const f = freezeTask(r.value.config, buildTask({ profile: 'prof_t' }));
    if (!f.ok) throw new Error(JSON.stringify(f.error));
    const w = f.value.policy.workflow;
    expect(w.steps['code']?.max_visits).toBe(3);
    expect(w.steps['gates']).toMatchObject({
      run: ['build', 'unit'],
      required: ['unit'],
      max_visits: 4,
    });
    expect(w.steps['ci']).toMatchObject({ poll: 120_000, timeout: 5_400_000 });
    expect(f.value.policy.structure_hash).toBe(structureHash(SOFTWARE_DEV));
  });

  it('Scenario 11: a workflow with only a base freezes the built-in graph unchanged', () => {
    const r = validateConfig({
      user: source('configs/valid/user-workflows.yaml'),
      project: source('configs/valid/cusr-minimal.yaml', 'cusr.yaml'),
      packs: {},
    });
    if (!r.ok) throw new Error('validate');
    expect(r.value.config.user.workflows['wf_a']).toEqual(SOFTWARE_DEV);
    expect(freezeTask(r.value.config, buildTask({ profile: 'prof_a' })).ok).toBe(true);
  });
});
