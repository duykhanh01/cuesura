import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ensureDefaultDispatch } from '../../../src/config/default-dispatch.ts';
import { validateConfig } from '../../../src/config/validate.ts';

function config(
  models: string,
  profiles = 'locked:\n    workflow: flow\n    allow_models: [fast]\n  main: { workflow: flow }',
) {
  const text = `version: 1
harnesses:
  claude: { cmd: claude, auth: subscription, pool: claude }
  codex: { cmd: codex, auth: subscription, pool: codex }
pools: { claude: 1, codex: 1 }
models:
  fast: { harness: claude, id: claude-haiku-5-5, tier: 1 }
${models}
roles:
  coder: { prompt: coder.md, binding: [{ model: fast, effort: low }${models.includes('big') ? ', { model: big, effort: medium }' : ''}] }
  fixer: { prompt: fixer.md, binding: [{ model: fast, effort: low }${models.includes('big') ? ', { model: big, effort: medium }' : ''}] }
  reviewer: { prompt: reviewer.md, permissions: read_only, binding: [{ model: fast, effort: low }${models.includes('check') ? ', { model: check, effort: high }' : ''}] }
  scout: { prompt: scout.md, permissions: read_only, binding: [{ model: fast, effort: low }] }
workflows:
  flow: { base: software_dev@1 }
profiles:
  ${profiles}
runtime: {}
`;
  const v = validateConfig({ user: { file: 'config.yaml', text }, packs: {} });
  if (!v.ok) throw new Error(JSON.stringify(v.error));
  return v.value;
}

const BOTH = `  big: { harness: claude, id: claude-opus-5-5, tier: 3 }
  check: { harness: codex, id: gpt-6.1-sol, tier: 3 }`;
const configPath = () => join(mkdtempSync(join(tmpdir(), 'cusr-dispatch-')), 'config.yaml');
const dispatchOf = (path: string) => join(path, '..', 'dispatch.yaml');

describe('default dispatch.yaml', () => {
  it('uses Opus to code and Sol to review, under the names and profile of the config', async () => {
    const path = configPath();
    expect(await ensureDefaultDispatch(path, config(BOTH))).toBe('created');
    expect(parse(readFileSync(dispatchOf(path), 'utf8'))).toMatchObject({
      version: 1,
      profile: 'main',
      rules: [],
      default: {
        use: { harness: 'claude', model: 'big', effort: 'medium' },
        reviewer: { harness: 'codex', model: 'check', effort: 'high' },
      },
    });
  });

  it('leaves an existing file alone', async () => {
    const path = configPath();
    writeFileSync(dispatchOf(path), 'mine\n');
    expect(await ensureDefaultDispatch(path, config(BOTH))).toBe('exists');
    expect(readFileSync(dispatchOf(path), 'utf8')).toBe('mine\n');
  });

  it.each([
    [
      'a default model is not declared',
      config('  big: { harness: claude, id: claude-opus-5-5, tier: 3 }'),
    ],
    [
      'no profile allows the models',
      config(BOTH, 'main:\n    workflow: flow\n    allow_models: [fast]'),
    ],
  ])('writes nothing when %s', async (_name, validated) => {
    expect(await ensureDefaultDispatch(configPath(), validated)).toBe('unavailable');
  });
});
