import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../../src/cli/output.ts';
import { dispatchCommand, pauseCommand } from '../../../src/cli/tasks.ts';
import { buildTask } from '../../support/builders.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import { createAndStart } from '../../support/store-flows.ts';

// Refusals name the next step (issue #258): guidance with the task's current version and the command
// to read the task, a list of valid choices, or what to hand to the user.

describe('refusals that name the next step (issue #258)', () => {
  const live: SeededDaemon[] = [];
  afterEach(async () => {
    for (const x of live.splice(0)) await x.cleanup();
  });

  async function running() {
    const sd = new SeededDaemon();
    live.push(sd);
    const t = buildTask();
    sd.seed((d) => createAndStart(d, t));
    await sd.start();
    const version = () => sd.daemon?.store.readTask(t.id)?.version ?? -1;
    let n = 0;
    const command = (kind: string, over: Record<string, unknown> = {}) => ({
      request_id: `0192bbbb-0000-7000-8000-${String(++n).padStart(12, '0')}`,
      kind,
      project: 'acme',
      task_id: t.id,
      expected_version: version(),
      payload: {},
      ...over,
    });
    return { sd, t, version, command };
  }

  const guidance = (r: { envelope: { error?: Record<string, unknown> } }): string =>
    (r.envelope.error?.['details'] as { guidance?: string } | undefined)?.guidance ?? '';

  it('stale_version names the current version and how to read the task, also on replay', async () => {
    const { sd, t, version, command } = await running();
    const body = command('task_pause', { expected_version: 0, payload: { reason: 'later' } });
    const r = await sd.command('assistant', body);
    expect(r.code).toBe(ExitCode.conflict);
    expect(r.envelope.error).toMatchObject({ details: { version: version() } });
    expect(guidance(r)).toContain(`--expected-version ${version()}`);
    expect(guidance(r)).toContain(`cusr task explain ${t.id}`);
    const again = await sd.command('assistant', body);
    expect(guidance(again)).toBe(guidance(r));
  });

  it('a continue the task does not allow is rejected with a way forward', async () => {
    const { sd, t, command } = await running();
    const r = await sd.command('assistant', command('task_continue'));
    expect(r.code).toBe(ExitCode.conflict);
    expect(r.envelope.error).toMatchObject({ code: 'rejected' });
    expect(guidance(r)).toContain(`cusr task explain ${t.id}`);
  });

  it('a command the assistant may not run says to hand it to the user', async () => {
    const { sd, command } = await running();
    const r = await sd.command(
      'assistant',
      command('approve_adopt', { payload: { head_sha: 'a'.repeat(40) } }),
    );
    expect(r.code).toBe(ExitCode.forbidden);
    expect(guidance(r)).toMatch(/give the command to the user/);
  });

  it('task explain on an ID that is not a UUID says so instead of asking for one', async () => {
    const { sd } = await running();
    const r = await sd.query('assistant', { kind: 'task_explain', task_id: 'not-a-uuid' });
    expect(r.code).toBe(ExitCode.usage);
    expect(r.envelope.error).toMatchObject({ message: 'task_id "not-a-uuid" is not a task ID' });
    expect(guidance(r)).toContain('cusr task list');
  });

  it('dispatch on an unknown project lists the configured ones', async () => {
    const { sd } = await running();
    const r = await sd.query('assistant', { kind: 'dispatch', project: 'nope' });
    expect(r.code).toBe(ExitCode.missing);
    expect(r.envelope.error).toMatchObject({ code: 'not_found', details: { projects: ['acme'] } });
  });

  it('request_not_found says how to find out whether the command arrived', async () => {
    const { sd } = await running();
    const r = await sd.query('assistant', {
      kind: 'request_show',
      request_id: '0192bbbb-0000-7000-8000-000000009999',
    });
    expect(r.code).toBe(ExitCode.missing);
    expect(
      (r.envelope.error?.['details'] as { next_step?: string } | undefined)?.next_step,
    ).toContain('--request-id');
  });

  it('prints the current version of a stale command for a reader too', async () => {
    const { sd, t, version } = await running();
    const err: string[] = [];
    const code = await pauseCommand.run(
      { dataDir: sd.dataDir, id: t.id, project: 'acme', expectedVersion: '0', reason: 'later' },
      false,
      { stdout: () => undefined, stderr: (x) => err.push(x) },
    );
    expect(code).toBe(ExitCode.conflict);
    expect(err.join('')).toContain(`version ${version()}`);
  });

  it('dispatch without --project lists the configured projects', async () => {
    const { sd } = await running();
    const out: string[] = [];
    const code = await dispatchCommand.run({ dataDir: sd.dataDir }, true, {
      stdout: (x) => out.push(x),
      stderr: () => undefined,
    });
    expect(code).toBe(ExitCode.usage);
    expect(JSON.parse(out.join(''))).toMatchObject({
      error: { code: 'invalid_arguments', details: { projects: ['acme'] } },
    });
  });
});
