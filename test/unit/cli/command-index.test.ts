import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { LAZY_COMMANDS, commandsFor } from '../../../src/cli/command-index.ts';
import { CUSR_COMMANDS } from '../../../src/cli/commands.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const byName = (name: string) => CUSR_COMMANDS.find((c) => c.name === name);

describe('the lazy command index', () => {
  it('names the same commands, in the same order, as CUSR_COMMANDS', async () => {
    expect(LAZY_COMMANDS.map((c) => c.name)).toEqual(CUSR_COMMANDS.map((c) => c.name));
    const loaded = await Promise.all(LAZY_COMMANDS.map((c) => c.load()));
    expect(loaded).toEqual(CUSR_COMMANDS);
  });

  it.each([
    [['task', 'logs', 'ID', '--json'], 'task logs'],
    [['--data-dir', '/x', 'inbox', '--json'], 'inbox'],
    [['answer', 'QID', '--file', '-'], 'answer'],
    [['assistant', 'hook', '--harness', 'codex'], 'assistant hook'],
    [['task', 'logs', '--help'], 'task logs'],
  ])('loads only the command %j names', async (argv, name) => {
    expect(await commandsFor(argv)).toEqual([byName(name)]);
  });

  it('loads nothing for a bare --version', async () => {
    expect(await commandsFor(['--version'])).toEqual([]);
    expect(await commandsFor(['-V', '--json'])).toEqual([]);
  });

  it.each([[['--help']], [['task', '--help']], [['task', 'nope']], [[]]])(
    'loads all for %j, so help lists them and a typo is rejected as before',
    async (argv) => {
      expect(await commandsFor(argv)).toHaveLength(CUSR_COMMANDS.length);
    },
  );
});

describe('startup of the paths a harness runs often', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cusr-startup-'));
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
  // Reports every import of a schema or YAML library, the bulk of the startup cost.
  const watch = `data:text/javascript,${encodeURIComponent(
    `import { registerHooks } from 'node:module';
registerHooks({ resolve(s, c, next) { if (s === 'zod' || s === 'yaml') process.stderr.write('LOADED ' + s + '\\n'); return next(s, c); } });`,
  )}`;

  it.each([[['--version']], [['assistant', 'hook']], [['assistant', 'session-start']]])(
    'cusr %j loads neither zod nor yaml',
    (argv) => {
      const r = spawnSync(process.execPath, ['--import', watch, 'src/cli/cusr.ts', ...argv], {
        cwd: ROOT,
        encoding: 'utf8',
        input: JSON.stringify({ session_id: 'startup-test' }),
        env: { ...process.env, CUSR_DATA_DIR: dataDir, NO_COLOR: undefined, FORCE_COLOR: '1' },
      });
      expect(r.stderr).not.toContain('LOADED');
      expect(r.status).toBe(0);
    },
  );
});
