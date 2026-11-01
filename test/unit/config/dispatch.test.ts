import { describe, expect, it } from 'vitest';
import { dispatchGuidance } from '../../../src/application/dispatch.ts';
import { freeze } from '../../../src/config/freeze.ts';
import { validateConfig } from '../../../src/config/validate.ts';
import { authz, buildTask } from '../../support/builders.ts';
import { docsFor } from '../../support/config-fixtures.ts';

const dispatchYaml = (body: string): string =>
  `    ${body.trim().split('\n').join('\n    ')}\n`;

const PROJECT = {
  file: 'cusr.yaml',
  text: `version: 1
gates:
  build: "true"
  unit: "true"
profile: main
`,
};

function validate(dispatch: string, modes = '', project?: typeof PROJECT) {
  return validateConfig({
    ...(project === undefined ? {} : { project }),
    user: {
      file: 'config.yaml',
      text: `version: 1
harnesses:
  claude: { cmd: claude, auth: subscription, pool: claude }
  codex: { cmd: codex, auth: subscription, pool: codex }
pools: { claude: 1, codex: 1 }
models:
  opus: { harness: claude, id: claude-opus, tier: 3 }
  sonnet: { harness: claude, id: claude-sonnet, tier: 2 }
  sol: { harness: codex, id: gpt-sol, tier: 3 }
roles:
  coder:
    prompt: coder.md
    binding: [{ model: opus, effort: medium }, { model: sonnet, effort: medium }]
  fixer:
    prompt: fixer.md
    binding: [{ model: opus, effort: medium }]
  reviewer:
    prompt: reviewer.md
    permissions: read_only
    binding: [{ model: sol, effort: high }]
  scout:
    prompt: scout.md
    permissions: read_only
    binding: [{ model: sol, effort: high }]
workflows:
  flow: { base: software_dev@1 }
profiles:
  main:
    workflow: flow
    overridable: [roles.reviewer.binding]
  limited:
    workflow: flow
    allow_models: [opus]
runtime:
${modes}  dispatch:
${dispatchYaml(dispatch)}`,
    },
    packs: {},
  });
}

const DEFAULT = `default:
  profile: main
  mode: full-review
  use: [{ worker: claude/opus/medium, reviewer: codex/sol/high }]`;

const codes = (r: ReturnType<typeof validate>): string[] =>
  r.ok ? [] : r.error.map((d) => `${d.code}:${d.path.join('.')}`);

describe('runtime.dispatch at load', () => {
  it('keeps rules, order and default as written', () => {
    const r = validate(`rules:
  - when: "the bug has a known cause"
    why: "narrow change"
    profile: main
    mode: direct-pr
    use: [{ worker: claude/opus/medium }]
${DEFAULT}`);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.runtime?.dispatch).toEqual({
      rules: [
        {
          when: 'the bug has a known cause',
          why: 'narrow change',
          profile: 'main',
          mode: 'direct-pr',
          use: [{ worker: 'claude/opus/medium' }],
        },
      ],
      default: {
        profile: 'main',
        mode: 'full-review',
        use: [{ worker: 'claude/opus/medium', reviewer: 'codex/sol/high' }],
      },
    });
  });

  it.each([
    [
      'an unknown profile',
      `default: { profile: none, mode: direct-pr, use: [{ worker: claude/opus/medium }] }`,
      'unknown_profile:runtime.dispatch.default.profile',
    ],
    [
      'an effort no role declares',
      `default: { profile: main, mode: direct-pr, use: [{ worker: claude/opus/high }] }`,
      'schema_invalid:runtime.dispatch.default.use.0.worker',
    ],
    [
      'a harness that does not run the model',
      `default: { profile: main, mode: direct-pr, use: [{ worker: codex/opus/medium }] }`,
      'schema_invalid:runtime.dispatch.default.use.0.worker',
    ],
    [
      'a worker only the coder declares, since the fixer runs the same binding',
      `default: { profile: main, mode: direct-pr, use: [{ worker: claude/sonnet/medium }] }`,
      'schema_invalid:runtime.dispatch.default.use.0.worker',
    ],
    [
      'a model the profile does not allow',
      `default: { profile: limited, mode: full-review, use: [{ worker: claude/opus/medium, reviewer: codex/sol/high }] }`,
      'schema_invalid:runtime.dispatch.default.use.0.reviewer',
    ],
    [
      'a reviewer on direct-pr',
      `default: { profile: main, mode: direct-pr, use: [{ worker: claude/opus/medium, reviewer: codex/sol/high }] }`,
      'schema_invalid:runtime.dispatch.default.use.0.reviewer',
    ],
    [
      'full-review without a reviewer',
      `default: { profile: main, mode: full-review, use: [{ worker: claude/opus/medium }] }`,
      'schema_invalid:runtime.dispatch.default.use.0',
    ],
    [
      'a reviewer choice from another role',
      `default: { profile: main, mode: full-review, use: [{ worker: claude/opus/medium, reviewer: claude/opus/medium }] }`,
      'schema_invalid:runtime.dispatch.default.use.0.reviewer',
    ],
  ])('refuses %s', (_name, body, code) => {
    expect(codes(validate(`rules: []\n${body}`))).toContain(code);
  });

  it.each(['constructor', '__proto__', 'toString'])(
    "refuses profile '%s', which only exists on the prototype",
    (name) => {
      expect(
        codes(
          validate(`rules: []
default: { profile: ${name}, mode: direct-pr, use: [{ worker: claude/opus/medium }] }`),
        ),
      ).toContain('unknown_profile:runtime.dispatch.default.profile');
    },
  );

  it('a task override stays free of the source-level guidance (SPEC §8)', () => {
    const r = validate(`rules: []\n${DEFAULT}`, '', PROJECT);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const f = freeze({
      config: r.value.config,
      task: buildTask({ profile: 'main' }),
      overrides: { 'roles.reviewer.binding': [{ model: 'opus' }] },
      caller: authz(['operate']),
      base_sha: 'abc',
      attachments: [],
      ...docsFor(r.value.config),
    });
    if (!f.ok) throw new Error(JSON.stringify(f.error));
    expect(f.value.policy.steps['review']?.binding.model).toBe('opus');
  });

  it('checks every rule, not only the default', () => {
    const r = validate(`rules:
  - when: x
    why: y
    profile: main
    mode: direct-pr
    use:
      - { worker: claude/opus/medium }
      - { worker: claude/opus/low }
${DEFAULT}`);
    expect(codes(r)).toEqual([
      'schema_invalid:runtime.dispatch.rules.0.use.1.worker',
      'schema_invalid:runtime.dispatch.rules.0.use.1.worker',
    ]);
  });

  it('refuses a mode runtime.modes leaves out', () => {
    const r = validate(
      `rules: []\n${DEFAULT}`,
      `  modes: { direct-pr: { when_to_use: small } }\n`,
    );
    expect(codes(r)).toContain('schema_invalid:runtime.dispatch.default.mode');
  });

  it.each([
    ['no default', `rules: []`],
    [
      'a rule without why',
      `rules: [{ when: x, profile: main, mode: direct-pr, use: [{ worker: claude/opus/medium }] }]\n${DEFAULT}`,
    ],
    [
      'an empty use',
      `rules: []\ndefault: { profile: main, mode: direct-pr, use: [] }`,
    ],
    [
      'a malformed choice',
      `rules: []\ndefault: { profile: main, mode: direct-pr, use: [{ worker: opus }] }`,
    ],
    [
      'an unknown key',
      `rules: []\ndefault: { profile: main, mode: direct-pr, weight: 1, use: [{ worker: claude/opus/medium }] }`,
    ],
  ])('fails the schema on %s', (_name, body) => {
    expect(validate(body).ok).toBe(false);
  });

  it('does not change the policy hash a task freezes', () => {
    const hash = (d: string) => {
      const r = validate(d);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value.config.hashes.user;
    };
    expect(hash(`rules: []\n${DEFAULT}`)).toBe(
      hash(`rules:
  - { when: other, why: other, profile: main, mode: direct-pr, use: [{ worker: claude/opus/medium }] }
${DEFAULT}`),
    );
  });
});

describe('dispatch query', () => {
  it('serves the configured guidance as written', () => {
    const r = validate(`rules: []\n${DEFAULT}`);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const out = dispatchGuidance(r.value.runtime, { kind: 'dispatch' });
    expect(out).toMatchObject({
      ok: true,
      value: { rules: [], default: { profile: 'main', mode: 'full-review' } },
    });
  });

  it('is empty without configuration, so a caller knows to ask', () => {
    expect(dispatchGuidance(null, { kind: 'dispatch' })).toEqual({
      ok: true,
      value: { modes: {}, rules: [], default: null },
    });
  });

  it('refuses unknown query fields', () => {
    expect(dispatchGuidance(null, { project: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });
});
