import { describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
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

function userText(
  dispatch: string,
  modes = '',
  projects = 'acme: { base_branch: main }',
): string {
  return `version: 1
harnesses:
  claude: { cmd: claude, auth: subscription, pool: claude }
  codex: { cmd: codex, auth: subscription, pool: codex }
pools: { claude: 1, codex: 1 }
models:
  opus: { harness: claude, id: claude-opus, tier: 3 }
  sonnet: { harness: claude, id: claude-sonnet, tier: 2 }
  haiku: { harness: claude, id: claude-haiku, tier: 1 }
  sol: { harness: codex, id: gpt-sol, tier: 3 }
roles:
  coder:
    prompt: coder.md
    binding: [{ model: opus, effort: medium }, { model: sonnet, effort: medium }, { model: haiku, effort: medium }]
  fixer:
    prompt: fixer.md
    binding: [{ model: opus, effort: medium }, { model: haiku, effort: medium }]
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
projects:
  ${projects.trim().split('\n').join('\n  ')}
runtime:${dispatch === '' && modes === '' ? ' {}' : ''}
${modes}${dispatch === '' ? '' : `  dispatch:\n${dispatchYaml(dispatch)}`}`;
}

function validate(dispatch: string, modes = '', project?: typeof PROJECT) {
  return validateConfig({
    ...(project === undefined ? {} : { project }),
    user: { file: 'config.yaml', text: userText(dispatch, modes) },
    packs: {},
  });
}

const OPUS = '{ harness: claude, model: opus, effort: medium }';
const SOL = '{ harness: codex, model: sol, effort: high }';
const DEFAULT = `default: { use: ${OPUS}, reviewer: ${SOL} }`;
const block = (rest: string, profile = 'main'): string =>
  `profile: ${profile}\n${rest}`;

const codes = (r: ReturnType<typeof validate>): string[] =>
  r.ok ? [] : r.error.map((d) => `${d.code}:${d.path.join('.')}`);

describe('dispatch at load', () => {
  it('expands agents into the values task propose takes, keeping order', () => {
    const r = validate(
      block(`rules:
  - when: "the bug has a known cause"
    why: "narrow change"
    use: ${OPUS}
  - when: "a small change in src"
    why: "needs review"
    use:
      - { harness: claude, model: haiku, effort: medium }
      - ${OPUS}
    reviewer: ${SOL}
${DEFAULT}`),
    );
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
        {
          when: 'a small change in src',
          why: 'needs review',
          profile: 'main',
          mode: 'full-review',
          use: [
            { worker: 'claude/haiku/medium', reviewer: 'codex/sol/high' },
            { worker: 'claude/opus/medium', reviewer: 'codex/sol/high' },
          ],
        },
      ],
      default: {
        profile: 'main',
        mode: 'full-review',
        use: [{ worker: 'claude/opus/medium', reviewer: 'codex/sol/high' }],
      },
    });
  });

  it('accepts a default-only block', () => {
    const r = validate(block(DEFAULT));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.runtime?.dispatch?.rules).toEqual([]);
  });

  it.each([
    [
      'an unknown profile',
      block(DEFAULT, 'none'),
      'unknown_profile:runtime.dispatch.profile',
    ],
    [
      'an effort no role declares',
      block('default: { use: { harness: claude, model: opus, effort: high } }'),
      'schema_invalid:runtime.dispatch.default.use',
    ],
    [
      'a harness that does not run the model',
      block(
        'default: { use: { harness: codex, model: opus, effort: medium } }',
      ),
      'schema_invalid:runtime.dispatch.default.use',
    ],
    [
      'a worker only the coder declares, since the fixer runs the same binding',
      block(
        'default: { use: { harness: claude, model: sonnet, effort: medium } }',
      ),
      'schema_invalid:runtime.dispatch.default.use',
    ],
    [
      'a model the profile does not allow',
      block(DEFAULT, 'limited'),
      'schema_invalid:runtime.dispatch.default.reviewer',
    ],
    [
      'a reviewer choice from another role',
      block(`default: { use: ${OPUS}, reviewer: ${OPUS} }`),
      'schema_invalid:runtime.dispatch.default.reviewer',
    ],
    [
      'a bad entry in a use list, by its position',
      block(`default:
  use:
    - ${OPUS}
    - { harness: claude, model: opus, effort: low }`),
      'schema_invalid:runtime.dispatch.default.use.1',
    ],
  ])('refuses %s', (_name, body, code) => {
    expect(codes(validate(body))).toContain(code);
  });

  it.each(['constructor', '__proto__', 'toString'])(
    "refuses profile '%s', which only exists on the prototype",
    (name) => {
      expect(codes(validate(block(DEFAULT, name)))).toContain(
        'unknown_profile:runtime.dispatch.profile',
      );
    },
  );

  it('a task override stays free of the source-level guidance (SPEC §8)', () => {
    const r = validate(block(DEFAULT), '', PROJECT);
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
    const r = validate(
      block(`rules:
  - when: x
    why: y
    use:
      - ${OPUS}
      - { harness: claude, model: opus, effort: low }
${DEFAULT}`),
    );
    expect(codes(r)).toEqual([
      'schema_invalid:runtime.dispatch.rules.0.use.1',
      'schema_invalid:runtime.dispatch.rules.0.use.1',
    ]);
  });

  it('refuses the mode a reviewer implies when runtime.modes leaves it out', () => {
    const r = validate(
      block(DEFAULT),
      `  modes: { direct-pr: { when_to_use: small } }\n`,
    );
    expect(codes(r)).toContain(
      'schema_invalid:runtime.dispatch.default.reviewer',
    );
  });

  it('refuses the mode no reviewer implies when runtime.modes leaves it out', () => {
    const r = validate(
      block(`default: { use: ${OPUS} }`),
      `  modes: { full-review: { when_to_use: always } }\n`,
    );
    expect(codes(r)).toContain('schema_invalid:runtime.dispatch.default.use');
  });

  it.each([
    ['no default', block('rules: []')],
    ['no profile', DEFAULT],
    [
      'a rule without why',
      block(`rules: [{ when: x, use: ${OPUS} }]\n${DEFAULT}`),
    ],
    [
      'a rule without when',
      block(`rules: [{ why: x, use: ${OPUS} }]\n${DEFAULT}`),
    ],
    ['an empty use', block('default: { use: [] }')],
    [
      'the old text form',
      block('default: { use: [{ worker: claude/opus/medium }] }'),
    ],
    ['a rule-level mode', block(`default: { mode: direct-pr, use: ${OPUS} }`)],
    [
      'an agent without effort',
      block('default: { use: { harness: claude, model: opus } }'),
    ],
    [
      'a name with a slash',
      block(
        'default: { use: { harness: claude, model: a/b, effort: medium } }',
      ),
    ],
  ])('fails the schema on %s', (_name, body) => {
    expect(validate(body).ok).toBe(false);
  });

  it('does not change the policy hash a task freezes', () => {
    const hash = (d: string, projects?: string) => {
      const r = validateConfig({
        user: { file: 'config.yaml', text: userText(d, '', projects) },
        packs: {},
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value.config.hashes.user;
    };
    const base = hash(block(DEFAULT));
    expect(
      hash(
        block(`rules:
  - { when: other, why: other, use: ${OPUS} }
${DEFAULT}`),
      ),
    ).toBe(base);
    expect(
      hash(
        block(DEFAULT),
        `acme:
  base_branch: main
  dispatch: { profile: main, default: { use: ${OPUS} } }`,
      ),
    ).toBe(base);
  });
});

describe('projects.<id>.dispatch at load', () => {
  const validateProjects = (projects: string) =>
    validateConfig({
      user: { file: 'config.yaml', text: userText('', '', projects) },
      packs: {},
    });

  it('reports a bad choice under the project that declares it', () => {
    const r = validateProjects(`acme:
  base_branch: main
  dispatch:
    profile: main
    default: { use: { harness: claude, model: opus, effort: low } }`);
    expect(codes(r)).toContain(
      'schema_invalid:projects.acme.dispatch.default.use',
    );
  });

  it('refuses an unknown profile under the project', () => {
    const r = validateProjects(`acme:
  base_branch: main
  dispatch: { profile: none, default: { use: ${OPUS} } }`);
    expect(codes(r)).toContain(
      'unknown_profile:projects.acme.dispatch.profile',
    );
  });
});

describe('dispatch query', () => {
  const caller = (projects: string[] | '*' = '*'): Caller => ({
    grant: { id: 'assistant', actor: 'assistant', roles: ['read'], projects },
  });
  const ask = (
    text: string,
    who: Caller,
    body: Record<string, unknown> = { kind: 'dispatch', project: 'acme' },
  ) =>
    dispatchGuidance(
      {
        configInputs: () =>
          Promise.resolve({
            user: { file: 'config.yaml', text },
            packs: {},
          } as never),
      },
      who,
      body,
    );
  const projects = `acme:
  base_branch: main
  dispatch:
    profile: main
    rules: [{ when: acme work, why: own rules, use: ${OPUS} }]
    default: { use: ${OPUS} }
other: { base_branch: main }`;

  it("serves a project's own rules, whole, instead of the shared ones", async () => {
    const out = await ask(userText(block(DEFAULT), '', projects), caller());
    expect(out).toMatchObject({
      ok: true,
      value: {
        project: 'acme',
        source: 'project',
        rules: [{ when: 'acme work', mode: 'direct-pr' }],
        default: { profile: 'main', mode: 'direct-pr' },
      },
    });
  });

  it('falls back to runtime.dispatch for a project without its own', async () => {
    const out = await ask(userText(block(DEFAULT), '', projects), caller(), {
      project: 'other',
    });
    expect(out).toMatchObject({
      ok: true,
      value: {
        project: 'other',
        source: 'global',
        rules: [],
        default: { profile: 'main', mode: 'full-review' },
      },
    });
  });

  it('is empty without any guidance, so a caller knows to ask', async () => {
    const out = await ask(userText(''), caller());
    expect(out).toEqual({
      ok: true,
      value: {
        project: 'acme',
        source: 'none',
        modes: {
          'direct-pr': { when_to_use: null },
          'full-review': { when_to_use: null },
        },
        rules: [],
        default: null,
      },
    });
  });

  it('reads the config on each query', async () => {
    let text = userText('');
    const deps = {
      configInputs: () =>
        Promise.resolve({
          user: { file: 'config.yaml', text },
          packs: {},
        } as never),
    };
    const body = { project: 'acme' };
    expect(await dispatchGuidance(deps, caller(), body)).toMatchObject({
      value: { source: 'none' },
    });
    text = userText(block(DEFAULT));
    expect(await dispatchGuidance(deps, caller(), body)).toMatchObject({
      value: { source: 'global' },
    });
  });

  it('keeps another project out of a limited token', async () => {
    const out = await ask(userText(block(DEFAULT)), caller(['other']));
    expect(out).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('reports an unknown project', async () => {
    const out = await ask(userText(block(DEFAULT)), caller(), {
      project: 'missing',
    });
    expect(out).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('reports an invalid config rather than empty guidance', async () => {
    const out = await ask(userText(block(DEFAULT, 'none')), caller());
    expect(out).toMatchObject({ ok: false, error: { code: 'config_invalid' } });
  });

  it.each([
    ['no project', {}],
    ['unknown fields', { project: 'acme', extra: 1 }],
  ])('refuses a query with %s', async (_name, body) => {
    expect(await ask(userText(''), caller(), body)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });
});
