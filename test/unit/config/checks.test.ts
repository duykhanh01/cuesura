import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../../src/config/validate.ts';
import {
  MIN_PARTS,
  MIN_PROJECT,
  minUser,
  source,
} from '../../support/config-fixtures.ts';

type Parts = Partial<typeof MIN_PARTS>;

function codes(parts: Parts, extra = ''): string[] {
  const r = validateConfig({
    user: minUser(parts, extra),
    project: MIN_PROJECT,
    packs: {},
  });
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
  MIN_PARTS.roles.replace(
    'coder: { binding: [{ model: sonnet }] }',
    `coder:\n    binding: [{ model: sonnet }]\n    escalation:\n      ladder: ${ladder}`,
  );

describe('FR-003 check 1: references exist', () => {
  it('accepts minimal configuration', () => expect(codes({})).toEqual([]));
  it('rejects transitions to unknown steps', () => {
    expect(
      codes({
        workflows:
          'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      gates: { next: { fail: fixx } }\n',
      }),
    ).toEqual(['unknown_step']);
  });
  it('rejects unknown roles, models, and pools', () => {
    expect(
      codes({
        workflows:
          'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      code: { role: builder, uses: [gpu] }\n',
      }),
    ).toEqual(['unknown_role', 'unknown_pool']);
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

describe('FR-003 check 2: finite outcomes with targets', () => {
  it('every software_dev@1 outcome has a target', () =>
    expect(codes({})).toEqual([]));
  it('rejects outcomes unsupported by the step kind', () => {
    expect(
      codes({
        workflows:
          'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      gates: { next: { flaky: gates } }\n',
      }),
    ).toEqual(['outcome_not_in_kind']);
  });
  it('rejects outcomes without targets', () => {
    const wf = LOOP(
      '\n        max_visits: 3\n        on_exhausted: escalate',
    ).replace(', blocked: escalate }\n      review', ' }\n      review');
    expect(codes({ workflows: wf })).toEqual(['outcome_without_target']);
  });
});

describe('FR-003 check 3: bounded cycles and tasks', () => {
  it('accepts the formerly rejected fixture without a wall-time cap', () => {
    const r = validateConfig({
      user: source('configs/valid/unlimited-task.yaml'),
      packs: {},
    });
    expect(r.ok).toBe(true);
  });

  it('accepts a review/fix loop bounded by max_visits', () => {
    expect(
      codes({
        workflows: LOOP(
          '\n        max_visits: 3\n        on_exhausted: escalate',
        ),
      }),
    ).toEqual([]);
  });
  it('rejects an unbounded review/fix loop', () => {
    expect(codes({ workflows: LOOP('') })).toEqual(['unbounded_cycle']);
  });
  it('accepts profiles without agent-run or wall-time caps', () => {
    expect(
      codes({
        profiles: 'profiles:\n  standard: { workflow: impl }\n',
      }),
    ).toEqual([]);
    expect(
      codes({ profiles: 'profiles:\n  standard: { workflow: impl }\n' }),
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
        roles: roles(
          '[{ when: { size: [L] }, model: opus }, { model: sonnet }]',
        ),
      }),
    ).toEqual([]);
  });
  it('rejects bindings with only conditional rules', () => {
    expect(
      codes({ roles: roles('[{ when: { size: [L] }, model: opus }]') }),
    ).toEqual(['no_initial_binding']);
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
    expect(codes({ roles: roles('{ priority: high }') })).toEqual([
      'unknown_predicate',
    ]));
  it('invalid types for known predicates return schema_invalid', () => {
    expect(codes({ roles: roles('{ attempt_gte: two }') })).toEqual([
      'schema_invalid',
    ]);
  });
});

describe('FR-006 and gates', () => {
  it('rejects decision modes: every decision point is human', () => {
    expect(
      codes({
        workflows:
          'workflows:\n  impl:\n    base: software_dev@1\n    decisions: { budget_increase: agent_if_confident }\n',
      }),
    ).toEqual(['schema_invalid']);
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
    expect(!r.ok && r.error.map((d) => d.code)).toEqual([
      'required_gate_missing',
    ]);
  });
  it('allow_no_gates permits a project without gates', () => {
    const profiles =
      'profiles:\n  standard: { workflow: impl, allow_no_gates: true }\n';
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
          'workflows:\n  impl:\n    base: software_dev@1\n    steps:\n      gates: { next: { fail: fixx } }\n      code: { role: builder }\n',
      }),
      project: MIN_PROJECT,
      packs: {},
    });
    expect(!r.ok && r.error.map((d) => [d.code, d.line])).toEqual([
      ['unknown_step', 14],
      ['unknown_role', 15],
    ]);
  });
});
