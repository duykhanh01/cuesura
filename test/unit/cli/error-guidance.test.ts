import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clientErrorEnvelope, exitCodeFor } from '../../../src/cli/client.ts';
import { CUSR_COMMANDS } from '../../../src/cli/commands.ts';
import { CONTROL_SOCKET, ExitCode, type Envelope } from '../../../src/cli/output.ts';
import { runCli } from '../../../src/cli/program.ts';
import { call } from '../../../src/cli/tasks.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), out, err };
}

/** A daemon that accepts every request and never answers. */
async function silentDaemon(): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-slow-')));
  const server = createServer(() => undefined);
  await new Promise<void>((r) => server.listen(join(dir, CONTROL_SOCKET), r));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const details = (e: Envelope): Readonly<Record<string, unknown>> => (e.ok ? {} : e.error.details);

describe('a daemon that does not answer in time (issue #258)', () => {
  it('is daemon_timeout, exit 3, and says a mutation may have taken effect and how to check', async () => {
    const dir = await silentDaemon();
    const id = '0192cccc-0000-7000-8000-000000000001';
    const e = await call({ dataDir: dir }, '/v1/command', { request_id: id }, id, 100);
    expect(e).toMatchObject({ ok: false, error: { code: 'daemon_timeout', request_id: id } });
    expect(exitCodeFor(e)).toBe(ExitCode.connection);
    const guidance = details(e)['guidance'] as string;
    expect(guidance).toContain(`cusr request show ${id}`);
    expect(guidance).toContain(`--request-id ${id}`);
    expect(guidance).not.toMatch(/No cusrd is listening/);
  });

  it('asks a read to run again, with no request to look up', async () => {
    const dir = await silentDaemon();
    const e = await call({ dataDir: dir }, '/v1/query', { kind: 'task_list' }, null, 100);
    expect(e).toMatchObject({ ok: false, error: { code: 'daemon_timeout' } });
    expect(details(e)['guidance']).toMatch(/Run the same command again/);
  });
});

describe('a socket path longer than a Unix socket allows (issue #258)', () => {
  it('says to use a shorter data dir', () => {
    const dir = `/tmp/${'x'.repeat(120)}`;
    const e = clientErrorEnvelope(
      dir,
      { code: 'connection', message: 'EINVAL: invalid argument' },
      null,
    );
    expect(e).toMatchObject({ ok: false, error: { code: 'daemon_unreachable' } });
    expect(details(e)['guidance']).toMatch(/longer than the 107 bytes.*shorter path/);
  });
});

describe('a command group named without a subcommand (issue #258)', () => {
  it('lists the subcommands under --json', async () => {
    for (const argv of [
      ['queue', '--json'],
      ['queue', 'bogus', '--json'],
    ]) {
      const term = io();
      const code = await runCli(
        { name: 'cusr', description: 'test', version: '0.0.0' },
        argv,
        term,
        CUSR_COMMANDS,
      );
      expect(code).toBe(ExitCode.usage);
      expect(JSON.parse(term.out.join(''))).toMatchObject({
        ok: false,
        error: { code: 'invalid_arguments', details: { subcommands: ['pause', 'resume'] } },
      });
    }
  });
});
