import { describe, expect, it } from 'vitest';
import type { GitResult } from '../../../src/adapters/ports.ts';
import type { Caller } from '../../../src/application/authz.ts';
import { dispatchGuidance } from '../../../src/application/dispatch.ts';
import type { PreflightPorts } from '../../../src/application/preflight.ts';
import { validateConfig, validateDispatchFile } from '../../../src/config/validate.ts';

function userText(modes = '', projects = 'acme: { base_branch: main }'): string {
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
runtime:${modes === '' ? ' {}' : ''}
${modes}`;
}

function validate(body: string, modes = '') {
  const config = validateConfig({
    user: { file: 'config.yaml', text: userText(modes) },
    packs: {},
  });
  if (!config.ok) throw new Error(JSON.stringify(config.error));
  return validateDispatchFile(
    { file: 'dispatch.yaml', text: `version: 1\n${body}\n` },
    config.value,
  );
}

const OPUS = '{ harness: claude, model: opus, effort: medium }';
const HAIKU = '{ harness: claude, model: haiku, effort: medium }';
const SOL = '{ harness: codex, model: sol, effort: high }';
const DEFAULT = `default: { use: ${OPUS}, reviewer: ${SOL} }`;
const block = (rest: string, profile = 'main'): string => `profile: ${profile}\n${rest}`;

const codes = (r: ReturnType<typeof validate>): string[] =>
  r.ok ? [] : r.error.map((d) => `${d.code}:${d.path.join('.')}`);

describe('dispatch file', () => {
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
    expect(r.value).toEqual({
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
    expect(r.value.rules).toEqual([]);
  });

  it.each([
    ['an unknown profile', block(DEFAULT, 'none'), 'unknown_profile:profile'],
    [
      'an effort no role declares',
      block('default: { use: { harness: claude, model: opus, effort: high } }'),
      'schema_invalid:default.use',
    ],
    [
      'a harness that does not run the model',
      block('default: { use: { harness: codex, model: opus, effort: medium } }'),
      'schema_invalid:default.use',
    ],
    [
      'a worker only the coder declares, since the fixer runs the same binding',
      block('default: { use: { harness: claude, model: sonnet, effort: medium } }'),
      'schema_invalid:default.use',
    ],
    [
      'a model the profile does not allow',
      block(DEFAULT, 'limited'),
      'schema_invalid:default.reviewer',
    ],
    [
      'a reviewer choice from another role',
      block(`default: { use: ${OPUS}, reviewer: ${OPUS} }`),
      'schema_invalid:default.reviewer',
    ],
    [
      'a bad entry in a use list, by its position',
      block(`default:
  use:
    - ${OPUS}
    - { harness: claude, model: opus, effort: low }`),
      'schema_invalid:default.use.1',
    ],
  ])('refuses %s', (_name, body, code) => {
    expect(codes(validate(body))).toContain(code);
  });

  it.each(['constructor', '__proto__', 'toString'])(
    "refuses profile '%s', which only exists on the prototype",
    (name) => {
      expect(codes(validate(block(DEFAULT, name)))).toContain('unknown_profile:profile');
    },
  );

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
    expect(codes(r)).toEqual(['schema_invalid:rules.0.use.1', 'schema_invalid:rules.0.use.1']);
  });

  it('refuses the mode a reviewer implies when runtime.modes leaves it out', () => {
    const r = validate(block(DEFAULT), `  modes: { direct-pr: { when_to_use: small } }\n`);
    expect(codes(r)).toContain('schema_invalid:default.reviewer');
  });

  it('refuses the mode no reviewer implies when runtime.modes leaves it out', () => {
    const r = validate(
      block(`default: { use: ${OPUS} }`),
      `  modes: { full-review: { when_to_use: always } }\n`,
    );
    expect(codes(r)).toContain('schema_invalid:default.use');
  });

  it.each([
    ['no default', block('rules: []')],
    ['no profile', DEFAULT],
    ['a rule without why', block(`rules: [{ when: x, use: ${OPUS} }]\n${DEFAULT}`)],
    ['a rule without when', block(`rules: [{ why: x, use: ${OPUS} }]\n${DEFAULT}`)],
    ['an empty use', block('default: { use: [] }')],
    ['the old text form', block('default: { use: [{ worker: claude/opus/medium }] }')],
    ['a rule-level mode', block(`default: { mode: direct-pr, use: ${OPUS} }`)],
    ['an agent without effort', block('default: { use: { harness: claude, model: opus } }')],
    [
      'a name with a slash',
      block('default: { use: { harness: claude, model: a/b, effort: medium } }'),
    ],
  ])('fails the schema on %s', (_name, body) => {
    expect(validate(body).ok).toBe(false);
  });

  it('does not change the policy hash a task freezes', () => {
    const hash = (text: string) => {
      const r = validateConfig({ user: { file: 'config.yaml', text }, packs: {} });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value.config.hashes.user;
    };
    expect(hash(userText('  dispatch: { profile: old }\n'))).toBe(hash(userText()));
  });
});

describe('dispatch keys of an old user config', () => {
  it('are accepted and reported as ignored', () => {
    const r = validateConfig({
      user: {
        file: 'config.yaml',
        text: userText(
          '  dispatch: { profile: old }\n',
          'acme: { base_branch: main, dispatch: { profile: old } }',
        ),
      },
      packs: {},
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.ignoredDispatchKeys).toEqual(['runtime.dispatch', 'projects.acme.dispatch']);
  });
});

/** A clone whose base commit holds `file`, or nothing when it is null. */
function repoWith(file: string | null, mode = '100644'): PreflightPorts['git'] {
  const exited = (stdout: string, code = 0): GitResult => ({
    kind: 'exited',
    code,
    stdout,
    stderr: '',
    truncated: false,
  });
  return {
    run: (c) => {
      expect(c.cwd).toBe('/srv/acme');
      if (c.args[0] === 'rev-parse') return Promise.resolve(exited(`${'a'.repeat(40)}\n`));
      if (c.args[0] === 'ls-tree') {
        expect(c.args.at(-1)).toBe('cusr.dispatch.yaml');
        return Promise.resolve(exited(file === null ? '' : `${mode} blob b\tcusr.dispatch.yaml\n`));
      }
      return Promise.resolve(exited(file ?? ''));
    },
  };
}

describe('dispatch query', () => {
  const caller = (): Caller => ({
    grant: { actor: 'assistant', roles: ['read'] },
  });
  const ask = (
    text: string,
    who: Caller,
    body: Record<string, unknown> = { kind: 'dispatch', project: 'acme' },
    git: PreflightPorts['git'] = repoWith(null),
    file: string | null = null,
  ) =>
    dispatchGuidance(
      {
        configInputs: () =>
          Promise.resolve({
            user: { file: 'config.yaml', text },
            dispatch: () =>
              Promise.resolve(file === null ? null : { file: 'dispatch.yaml', text: file }),
            packs: {},
          } as never),
        ports: { git },
      },
      who,
      body,
    );
  it('is empty without any guidance, so a caller knows to ask', async () => {
    const out = await ask(userText(), caller());
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

  it('reads the file on each query', async () => {
    let file: string | null = null;
    const deps = {
      configInputs: () =>
        Promise.resolve({
          user: { file: 'config.yaml', text: userText() },
          dispatch: () =>
            Promise.resolve(file === null ? null : { file: 'dispatch.yaml', text: file }),
          packs: {},
        } as never),
      ports: { git: repoWith(null) },
    };
    const body = { project: 'acme' };
    expect(await dispatchGuidance(deps, caller(), body)).toMatchObject({
      value: { source: 'none' },
    });
    file = `version: 1\n${block(DEFAULT)}\n`;
    expect(await dispatchGuidance(deps, caller(), body)).toMatchObject({
      value: { source: 'global' },
    });
  });

  it('reports an unknown project', async () => {
    const out = await ask(userText(), caller(), { project: 'missing' });
    expect(out).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('reports an invalid config rather than empty guidance', async () => {
    const out = await ask('version: 2\n', caller());
    expect(out).toMatchObject({ ok: false, error: { code: 'config_invalid' } });
  });

  describe('dispatch.yaml beside the user config', () => {
    const FILE = `version: 1
profile: main
rules:
  - { when: from file, why: file, use: ${OPUS} }
default: { use: ${OPUS} }
`;
    const QUERY = { kind: 'dispatch', project: 'acme' };
    const when = (out: Awaited<ReturnType<typeof ask>>) =>
      out.ok && out.value.rules.map((r) => r.when);

    it('serves a project without a repo file', async () => {
      const out = await ask(userText(), caller(), QUERY, undefined, FILE);
      expect(out).toMatchObject({ ok: true, value: { source: 'global' } });
      expect(when(out)).toEqual(['from file']);
    });

    it('gives way to the repo file, which replaces it whole', async () => {
      const local = 'acme: { base_branch: main, path: /srv/acme }';
      const repo = FILE.replace('from file', 'from repo');
      const out = await ask(userText('', local), caller(), QUERY, repoWith(repo), FILE);
      expect(out).toMatchObject({ ok: true, value: { source: 'repo' } });
      expect(when(out)).toEqual(['from repo']);
    });

    it('refuses a bad file rather than serve no guidance', async () => {
      const out = await ask(userText(), caller(), QUERY, undefined, 'version: 1\nprofile: wide\n');
      expect(out).toMatchObject({
        ok: false,
        error: { code: 'config_invalid', message: 'dispatch.yaml is invalid' },
      });
    });
  });

  describe('cusr.dispatch.yaml', () => {
    const local = `acme: { base_branch: main, path: /srv/acme }`;
    const shared = `version: 1
profile: main
default: { use: ${OPUS} }
`;
    const QUERY = { kind: 'dispatch', project: 'acme' };
    const fromRepo = (file: string | null, mode?: string) =>
      ask(userText('', local), caller(), QUERY, repoWith(file, mode), shared);
    const FILE = `version: 1
profile: main
rules:
  - { when: from repo, why: repo, use: ${OPUS} }
default: { use: ${OPUS} }
`;

    it('replaces the global file whole', async () => {
      const out = await fromRepo(FILE);
      expect(out).toMatchObject({ ok: true, value: { source: 'repo' } });
      expect(out.ok && out.value.rules.map((r) => r.when)).toEqual(['from repo']);
    });

    it('leaves the global file in charge when the base commit has none', async () => {
      expect(await fromRepo(null)).toMatchObject({ ok: true, value: { source: 'global' } });
    });

    it.each([
      ['a model the profile refuses', FILE.replace('main', 'limited').replace(OPUS, HAIKU)],
      ['an unknown profile', FILE.replace('profile: main', 'profile: wide')],
      ['a key the file does not take', `${FILE}yolo: true\n`],
      ['no version', FILE.replace('version: 1\n', '')],
      ['broken YAML', 'version: [\n'],
    ])('refuses %s rather than fall back to the global file', async (_name, text) => {
      expect(await fromRepo(text)).toMatchObject({ ok: false, error: { code: 'config_invalid' } });
    });

    it('refuses a symlink', async () => {
      expect(await fromRepo(FILE, '120000')).toMatchObject({
        ok: false,
        error: { code: 'config_invalid' },
      });
    });

    it('reports an unreadable base rather than propose settings the repo may replace', async () => {
      const missing: PreflightPorts['git'] = {
        run: () =>
          Promise.resolve({ kind: 'exited', code: 1, stdout: '', stderr: '', truncated: false }),
      };
      expect(await ask(userText('', local), caller(), QUERY, missing)).toMatchObject({
        ok: false,
        error: { code: 'options_unavailable' },
      });
    });
  });

  it.each([
    ['no project', {}],
    ['unknown fields', { project: 'acme', extra: 1 }],
  ])('refuses a query with %s', async (_name, body) => {
    expect(await ask(userText(), caller(), body)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });
});
