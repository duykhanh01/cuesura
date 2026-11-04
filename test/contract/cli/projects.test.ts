import { afterEach, describe, expect, it } from 'vitest';
import { CUSR_COMMANDS } from '../../../src/cli/commands.ts';
import { ExitCode } from '../../../src/cli/output.ts';
import { runCli } from '../../../src/cli/program.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';

const running: SeededDaemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.cleanup();
});

async function list(dataDir: string, json = true) {
  let out = '';
  let errors = '';
  const code = await runCli(
    { name: 'cusr', description: '', version: '0' },
    ['project', 'list', '--data-dir', dataDir, ...(json ? ['--json'] : [])],
    { stdout: (t) => (out += t), stderr: (t) => (errors += t) },
    CUSR_COMMANDS,
  );
  return { code, out, errors };
}

describe('cusr project list', () => {
  it('prints one envelope with the caller and projects', async () => {
    const sd = new SeededDaemon();
    running.push(sd);
    await sd.start();
    const r = await list(sd.dataDir);
    expect(r.code).toBe(ExitCode.ok);
    expect(r.out.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(r.out)).toMatchObject({
      ok: true,
      data: {
        caller: { actor: 'owner', trusted_confirmer: true },
        projects: [{ id: 'acme', repo: 'acme/app' }],
      },
    });
  });

  it('prints a short summary and table without --json', async () => {
    const sd = new SeededDaemon();
    running.push(sd);
    await sd.start();
    const r = await list(sd.dataDir, false);
    expect(r.code).toBe(ExitCode.ok);
    expect(r.out).toContain('Signed in as: owner');
    expect(r.out).toContain('Can confirm runs: yes');
    expect(r.out).toMatch(/^acme\s+acme\/app$/m);
  });

  it('exits 3 without a daemon', async () => {
    const sd = new SeededDaemon();
    running.push(sd);
    await sd.start();
    await sd.stop();
    expect((await list(sd.dataDir)).code).toBe(ExitCode.connection);
  });
});
