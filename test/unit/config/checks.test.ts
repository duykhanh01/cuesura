import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../../src/config/validate.ts';
import { MIN_PARTS, MIN_PROJECT, minUser, source } from '../../support/config-fixtures.ts';

type Parts = Partial<typeof MIN_PARTS>;

function codes(parts: Parts, extra = ''): string[] {
  const r = validateConfig({
    user: minUser(parts, extra),
    project: MIN_PROJECT,
    packs: {},
  });
  return r.ok ? [] : r.error.map((d) => d.code);
}

const coderLadder = (ladder: string) =>
  MIN_PARTS.roles.replace(
    'coder: { binding: [{ model: sonnet }] }',
    `coder:\n    binding: [{ model: sonnet }]\n    escalation:\n      ladder: ${ladder}`,
  );

const wf = (steps: string, extra = '') =>
  `workflows:\n  impl:\n    base: software_dev@1\n${extra}    steps:\n${steps}`;

describe('FR-003 check 1: workflows only tune the built-in graph', () => {
  it('accepts minimal configuration', () => expect(codes({})).toEqual([]));
  it('accepts every tunable on the steps that take it', () => {
    expect(
      codes({
        workflows: wf(
          '      code: { max_visits: 9, max_rung: 0 }\n      gates: { run: [build, unit], required: [build], max_visits: 3 }\n      ci: { poll: 30s, timeout: 2h, max_visits: 4 }\n      review: { max_visits: 2 }\n',
        ),
      }),
    ).toEqual([]);
  });
  it('requires base', () => {
    expect(codes({ workflows: 'workflows:\n  impl: {}\n' })).toEqual(['schema_invalid']);
  });
  it.each([
    'kind: agent',
    'role: builder',
    'next: { done: gates }',
    'on_exhausted: fail',
    'uses: [gpu]',
    'when: { flag: hot }',
    'skip_when: { size: [XS] }',
  ])('names the former graph key %s for removal', (key) => {
    expect(codes({ workflows: wf(`      code: { ${key} }\n`) })).toEqual(['workflow_key_removed']);
  });
  it('names start and decisions for removal', () => {
    expect(
      codes({
        workflows: wf(
          '      code: { max_visits: 3 }\n',
          '    start: code\n    decisions: { agent_question: human }\n',
        ),
      }),
    ).toEqual(['workflow_key_removed', 'workflow_key_removed']);
  });
  it('rejects a step the built-in graph lacks', () => {
    expect(codes({ workflows: wf('      deploy: { max_visits: 2 }\n') })).toEqual(['unknown_step']);
  });
  it('rejects a tunable the step does not take', () => {
    expect(
      codes({
        workflows: wf(
          '      complete: { max_visits: 2 }\n      gates: { max_rung: 1 }\n      code: { poll: 1m }\n',
        ),
      }),
    ).toEqual(['schema_invalid', 'schema_invalid', 'schema_invalid']);
  });
  it('rejects a required gate missing from the run list', () => {
    expect(
      codes({
        workflows: wf('      gates: { run: [build], required: [unit] }\n'),
      }),
    ).toEqual(['unknown_gate']);
  });
  it('rejects unknown models and pools of roles and harnesses', () => {
    expect(
      codes({
        roles: MIN_PARTS.roles.replace(
          'fixer: { binding: [{ model: sonnet }] }',
          'fixer: { binding: [{ model: gpt }] }',
        ),
      }),
    ).toEqual(['unknown_model']);
  });
  it('rejects unknown roles and models referenced by profiles', () => {
    expect(
      codes({
        profiles:
          'profiles:\n  standard: { workflow: impl, allow_roles: [coder, ghost], allow_models: [haiku] }\n',
      }),
    ).toEqual(['unknown_role', 'unknown_model']);
  });
});

describe('FR-003 check 3: tasks without caps', () => {
  it('accepts the formerly rejected fixture without a wall-time cap', () => {
    const r = validateConfig({
      user: source('configs/valid/unlimited-task.yaml'),
      packs: {},
    });
    expect(r.ok).toBe(true);
  });
  it('accepts profiles without agent-run or wall-time caps', () => {
    expect(
      codes({
        profiles: 'profiles:\n  standard: { workflow: impl }\n',
      }),
    ).toEqual([]);
  });
});

describe('FR-003 check 4: reachable ladder rungs', () => {
  const ladder = '[{ effort: high }, { model: opus }]';
  it('max_visits 5 reaches rung 2 (2 * 2 + 1)', () => {
    expect(
      codes({
        roles: coderLadder(ladder),
        workflows:
          'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      code: { max_visits: 5 }\n',
      }),
    ).toEqual([]);
  });
  it('max_visits 4 cannot reach rung 2', () => {
    expect(
      codes({
        roles: coderLadder(ladder),
        workflows:
          'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      code: { max_visits: 4 }\n',
      }),
    ).toEqual(['unreachable_rung']);
  });
  it('max_rung excludes higher rungs from reachability checks', () => {
    expect(
      codes({
        roles: coderLadder(ladder),
        workflows:
          'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      code: { max_visits: 4, max_rung: 1 }\n',
      }),
    ).toEqual([]);
  });
  it('rejects max_rung beyond the role ladder', () => {
    expect(
      codes({
        workflows:
          'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      code: { max_rung: 1 }\n',
      }),
    ).toEqual(['rung_beyond_role']);
  });
});

describe('FR-003 check 5: initial binding', () => {
  const roles = (rules: string) =>
    MIN_PARTS.roles.replace(
      'coder: { binding: [{ model: sonnet }] }',
      `coder: { binding: ${rules} }`,
    );
  it('accepts conditional rules with an unconditional fallback', () => {
    expect(
      codes({
        roles: roles('[{ when: { size: [L] }, model: opus }, { model: sonnet }]'),
      }),
    ).toEqual([]);
  });
  it('rejects bindings with only conditional rules', () => {
    expect(codes({ roles: roles('[{ when: { size: [L] }, model: opus }]') })).toEqual([
      'no_initial_binding',
    ]);
  });
});

describe('FR-003 check 6: predefined predicates', () => {
  const roles = (when: string) =>
    MIN_PARTS.roles.replace(
      'coder: { binding: [{ model: sonnet }] }',
      `coder: { binding: [{ when: ${when}, model: opus }, { model: sonnet }] }`,
    );
  it('accepts all six supported predicates', () => {
    expect(
      codes({
        roles: roles(
          '{ flag: hot, size: [L], label: [ui], task_type: bugfix, attempt_gte: 2, target_branch: "feature/*" }',
        ),
      }),
    ).toEqual([]);
  });
  it('rejects unknown predicates', () =>
    expect(codes({ roles: roles('{ priority: high }') })).toEqual(['unknown_predicate']));
  it('invalid types for known predicates return schema_invalid', () => {
    expect(codes({ roles: roles('{ attempt_gte: two }') })).toEqual(['schema_invalid']);
  });
});

describe('FR-006 and gates', () => {
  it('decision modes are not configurable: every decision point is human', () => {
    expect(
      codes({
        workflows:
          'workflows:\n  impl:\n    base: software_dev@1\n    decisions: { budget_increase: agent_if_confident }\n',
      }),
    ).toEqual(['workflow_key_removed']);
  });
  it('required gates must be declared by the project', () => {
    const r = validateConfig({
      user: minUser(),
      project: {
        file: 'cusr.yaml',
        text: 'version: 1\ngates: { build: make }\nprofile: standard\n',
      },
      packs: {},
    });
    expect(!r.ok && r.error.map((d) => d.code)).toEqual(['required_gate_missing']);
  });
  it('allow_no_gates permits a project without gates', () => {
    const profiles = 'profiles:\n  standard: { workflow: impl, allow_no_gates: true }\n';
    expect(
      validateConfig({
        user: minUser({ profiles }),
        project: { file: 'cusr.yaml', text: 'version: 1\nprofile: standard\n' },
        packs: {},
      }).ok,
    ).toBe(true);
  });
});

describe('returns all errors sorted by file, line, and column', () => {
  it('reports multiple errors in one configuration', () => {
    const r = validateConfig({
      user: minUser({
        workflows:
          'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      gates: { next: { fail: fixx } }\n      deploy: { max_visits: 2 }\n',
      }),
      project: MIN_PROJECT,
      packs: {},
    });
    expect(!r.ok && r.error.map((d) => [d.code, d.line])).toEqual([
      ['workflow_key_removed', 14],
      ['unknown_step', 15],
    ]);
  });
});

describe('autonomous', () => {
  it('needs a decider role', () => {
    expect(codes({}, 'autonomous: true\n')).toEqual(['schema_invalid']);
    expect(codes({})).toEqual([]);
  });
});
