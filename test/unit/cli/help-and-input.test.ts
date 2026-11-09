import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CUSR_COMMANDS } from '../../../src/cli/commands.ts';
import { DATA_DIR, helpArgv, runCli } from '../../../src/cli/program.ts';

const dir = mkdtempSync(join(tmpdir(), 'cusr-help-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ID = '019a0000-0000-7000-8000-000000000001';

async function cusr(...argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(
    { name: 'cusr', description: 'test', version: '0.0.0', globalOptions: [DATA_DIR] },
    argv,
    { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) },
    CUSR_COMMANDS,
  );
  return { code, stdout, stderr };
}

describe('help (#269)', () => {
  it('cusr help [command] is the command with --help', async () => {
    const help = await cusr('help', 'task', 'add');
    expect(help.code).toBe(0);
    expect(help.stdout).toBe((await cusr('task', 'add', '--help')).stdout);
    expect((await cusr('help')).stdout).toContain('Usage: cusr');
    expect(helpArgv(['--data-dir', '/d', 'help', 'status'], [DATA_DIR])).toEqual([
      '--data-dir',
      '/d',
      'status',
      '--help',
    ]);
    expect(helpArgv(['task', 'help'])).toEqual(['task', 'help']);
  });

  it('help for a command that does not exist is a usage error listing the valid ones', async () => {
    const r = await cusr('help', 'task', 'nonexistent', '--json');
    expect(r.code).toBe(2);
    const env = JSON.parse(r.stdout) as {
      error: { code: string; details: { subcommands: string[] } };
    };
    expect(env.error.code).toBe('invalid_arguments');
    expect(env.error.details.subcommands).toContain('add');
    const top = await cusr('nope', '--help');
    expect(top.code).toBe(2);
    expect(top.stderr).toContain('no command "nope"');
    expect((await cusr('task', 'show', ID, '--help')).code).toBe(0);
    expect((await cusr('answer', 'q', '--help')).code).toBe(0);
  });

  it('--help --json prints one ok envelope holding the help text', async () => {
    const r = await cusr('task', 'propose', '--help', '--json');
    expect(r.code).toBe(0);
    expect(r.stdout.trimEnd().split('\n')).toHaveLength(1);
    const env = JSON.parse(r.stdout) as { ok: boolean; data: { help: string } };
    expect(env.ok).toBe(true);
    expect(env.data.help).toContain('Usage: cusr task propose');
    expect(env.data.help).toContain('--worker claude/opus/high');
  });

  it('task add --help lists the JSON keys and the steps after it', async () => {
    const { stdout } = await cusr('task', 'add', '--help');
    for (const key of ['requirements', 'out_of_scope', 'source_key', 'pr_ref', 'run_config'])
      expect(stdout).toContain(key);
    expect(stdout).toContain('cusr task confirm --run-config');
  });

  it.each([['task', 'add'], ['task', 'propose'], ['task', 'confirm'], ['dispatch'], ['status']])(
    '%s %s --help has an example',
    async (...words) => {
      expect((await cusr(...words, '--help')).stdout).toMatch(
        /Examples?:\n {2}(echo .* \| )?cusr /,
      );
    },
  );
});

describe('task input checked by the CLI (#269)', () => {
  const file = join(dir, 'task.json');
  writeFileSync(
    file,
    JSON.stringify({ project: 'acme', title: 't', base_branch: 'main', acceptance: ['a'] }),
  );

  it('refuses task flags beside --file instead of dropping them', async () => {
    const r = await cusr(
      'task',
      'add',
      '--file',
      file,
      '--priority',
      '5',
      '--title',
      'x',
      '--json',
    );
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_arguments',
        message:
          'task add --file cannot be combined with --title, --priority; put them in the JSON file',
      },
    });
  });

  it('refuses a priority that is not an integer', async () => {
    const r = await cusr(
      'task',
      'add',
      '--project',
      'acme',
      '--title',
      't',
      '--base',
      'main',
      '--priority',
      'abc',
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--priority must be an integer');
  });

  it('names the CLI command, and propose asks for the version first', async () => {
    const propose = await cusr('task', 'propose', ID, '--json');
    expect(JSON.parse(propose.stdout)).toMatchObject({
      error: { message: 'task propose requires --expected-version with a non-negative integer' },
    });
    const pause = await cusr(
      'task',
      'amend-policy',
      ID,
      '--model',
      'm',
      '--reason',
      'r',
      '--confirm',
      'h',
    );
    expect(pause.stderr).toContain('task amend-policy requires --expected-version');
  });
});
