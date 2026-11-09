import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../../src/cli/output.ts';
import { CUSR_COMMANDS } from '../../../src/cli/commands.ts';
import { runCli } from '../../../src/cli/program.ts';
import { uuidOf } from '../../support/builders.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';

const running: SeededDaemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.cleanup();
});

async function daemon(): Promise<SeededDaemon> {
  const sd = new SeededDaemon();
  running.push(sd);
  await sd.start();
  return sd;
}

async function cli(sd: SeededDaemon, id: string, json = true) {
  let out = '';
  let errors = '';
  const code = await runCli(
    { name: 'cusr', description: '', version: '0' },
    ['request', 'show', id, '--data-dir', sd.dataDir, ...(json ? ['--json'] : [])],
    { stdout: (t) => (out += t), stderr: (t) => (errors += t) },
    CUSR_COMMANDS,
  );
  return { code, out, errors };
}

const add = (sd: SeededDaemon, n: number, title = 'A task') =>
  sd.command('owner', {
    request_id: uuidOf(n),
    kind: 'task_add',
    project: 'acme',
    task_id: null,
    expected_version: null,
    payload: { task: { title, base_branch: 'main', acceptance: ['works'] } },
  });

describe('cusr request show', () => {
  it('prints one envelope and exits 0 for a completed request', async () => {
    const sd = await daemon();
    await add(sd, 1);
    const r = await cli(sd, uuidOf(1));
    expect(r.code).toBe(ExitCode.ok);
    expect(r.out.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(r.out)).toMatchObject({
      ok: true,
      data: { state: 'completed', kind: 'task_add' },
    });
    expect((await cli(sd, uuidOf(1), false)).out.split('\n')[0]).toBe(
      'Request completed — operation succeeded',
    );
  });

  it('exits 0 even when the mutation was rejected', async () => {
    const sd = await daemon();
    await add(sd, 2, '');
    const r = await cli(sd, uuidOf(2));
    expect(r.code).toBe(ExitCode.ok);
    expect(JSON.parse(r.out)).toMatchObject({
      ok: true,
      data: { state: 'completed', outcome: { ok: false } },
    });
    const text = await cli(sd, uuidOf(2), false);
    expect(text.code).toBe(ExitCode.ok);
    expect(text.out.split('\n')[0]).toBe('Request completed — operation rejected');
    expect(text.out).toContain('Reason: ');
  });

  it('exits 4 when not found', async () => {
    const sd = await daemon();
    const r = await cli(sd, uuidOf(3));
    expect(r.code).toBe(ExitCode.missing);
    expect(JSON.parse(r.out)).toMatchObject({
      ok: false,
      error: { code: 'request_not_found' },
    });
  });

  it('tells an interrupted request what to do next', async () => {
    const sd = await daemon();
    sd.daemon?.store.admitCommand({
      request_id: uuidOf(4),
      actor: 'owner',
      kind: 'task_add',
      command_hash: 'h',
      project: 'acme',
      task_id: uuidOf(44),
      assigned_ids: [],
      now: 1,
    });
    const r = await cli(sd, uuidOf(4));
    expect(r.code).toBe(ExitCode.ok);
    const data = (JSON.parse(r.out) as { data: Record<string, unknown> }).data;
    expect(data['state']).toBe('interrupted');
    expect(data['task_id']).toBeNull();
    expect(data['next_step']).toEqual(expect.stringContaining(`--request-id ${uuidOf(4)}`));
    const text = await cli(sd, uuidOf(4), false);
    expect(text.out.split('\n')[0]).toBe('Request interrupted');
    expect(text.out).toContain('Next step:');
  });

  it('without a daemon exits 3', async () => {
    const sd = await daemon();
    await sd.stop();
    const r = await cli(sd, uuidOf(5));
    expect(r.code).toBe(ExitCode.connection);
  });
});
