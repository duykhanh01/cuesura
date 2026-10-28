import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTokenFile } from '../../../src/application/access-tokens.ts';
import { callDaemon, exitCodeFor, statusCommand } from '../../../src/cli/client.ts';
import { ExitCode } from '../../../src/cli/output.ts';
import { startDaemon, type CommandHandler, type RunningDaemon } from '../../../src/daemon/main.ts';
import { asEpochMs } from '../../../src/shared/brand.ts';

const dirs: string[] = [];
const daemons: RunningDaemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dataDir(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-daemon-')));
  dirs.push(base);
  return join(base, 'data');
}

function tokenFile(dir: string, name: string): { path: string; token: string } {
  const token = randomBytes(32).toString('base64url');
  const path = join(dir, `${name}.token`);
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return { path, token };
}

const clock = { now: () => asEpochMs(1_800_000_000_000), monotonic: () => 0 };
let seq = 0;
const newId = (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

function io(): { stdout: (t: string) => void; stderr: (t: string) => void; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { stdout: (t) => out.push(t), stderr: (t) => err.push(t), out, err };
}

const cancel = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  request_id: '11111111-1111-4111-8111-111111111111',
  kind: 'task_cancel',
  project: 'p1',
  task_id: '22222222-2222-4222-8222-222222222222',
  expected_version: 3,
  payload: { reason: 'no longer needed' },
  ...over,
});

describe('daemon control socket (T026)', () => {
  it('serves health over a 0600 socket in a 0700 data dir to an authenticated reader, and cusr status exits 0', async () => {
    const dir = dataDir();
    const started = await startDaemon({ dataDir: dir, accessTokens: [], clock, newId });
    expect(started.ok, JSON.stringify(!started.ok && started.error)).toBe(true);
    if (!started.ok) return;
    daemons.push(started.value);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(started.value.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(started.value.ownerTokenPath).mode & 0o777).toBe(0o600);

    const term = io();
    process.env['CUSR_TOKEN_FILE'] = started.value.ownerTokenPath;
    try {
      expect(await statusCommand.run({ dataDir: dir }, true, term)).toBe(ExitCode.ok);
    } finally {
      delete process.env['CUSR_TOKEN_FILE'];
    }
    const health = JSON.parse(term.out.join('')) as { ok: boolean; data: Record<string, unknown> };
    expect(health).toMatchObject({ ok: true, data: { writer: 'ok', projections: { ok: true }, dispatch: { blocked: null, in_flight: 0 }, slot: null } });

    const anon = await callDaemon({ socketPath: started.value.socketPath, token: 'x'.repeat(43), method: 'GET', path: '/v1/health' });
    expect(anon.ok && anon.value.status).toBe(401);
    expect(anon.ok && exitCodeFor(anon.value.envelope)).toBe(ExitCode.forbidden);
  });

  it('is the only writer: a second daemon on the same data dir is refused', async () => {
    const dir = dataDir();
    const first = await startDaemon({ dataDir: dir, accessTokens: [], clock, newId });
    if (!first.ok) throw new Error(first.error.detail);
    daemons.push(first.value);
    const second = await startDaemon({ dataDir: dir, accessTokens: [], clock, newId });
    expect(second).toMatchObject({ ok: false, error: { code: 'store_locked' } });
  });

  it('refuses a data dir other users can read', async () => {
    const dir = dataDir();
    const started = await startDaemon({ dataDir: dir, accessTokens: [], clock, newId });
    if (!started.ok) throw new Error(started.error.detail);
    await started.value.stop();
    chmodSync(dir, 0o755);
    expect(await startDaemon({ dataDir: dir, accessTokens: [], clock, newId })).toMatchObject({ ok: false, error: { code: 'data_dir_insecure' } });
  });

  it('admits commands server-side: authz from the token, unavailable kinds leave no ledger row, replay and conflict by request id', async () => {
    const dir = dataDir();
    const reader = tokenFile(join(dir, '..'), 'reader');
    let runs = 0;
    const handler: CommandHandler = () => {
      runs++;
      return Promise.resolve({ ok: true, value: { cancelled: true } });
    };
    const started = await startDaemon({
      dataDir: dir,
      accessTokens: [{ id: 'reader', actor: 'assistant', roles: ['read'], projects: ['p1'], token_file: reader.path }],
      clock,
      newId,
      commands: { task_cancel: handler },
    });
    if (!started.ok) throw new Error(started.error.detail);
    daemons.push(started.value);
    const sock = started.value.socketPath;
    const owner = readTokenFile(started.value.ownerTokenPath, 'owner');
    if (!owner.ok) throw new Error('owner token');
    const post = (token: string, body: unknown) => callDaemon({ socketPath: sock, token, method: 'POST', path: '/v1/command', body });
    const code = async (token: string, body: unknown): Promise<number> => {
      const r = await post(token, body);
      if (!r.ok) throw new Error(r.error.message);
      return exitCodeFor(r.value.envelope);
    };

    // A read-only token cannot mutate, whatever actor the body claims.
    expect(await code(reader.token, { ...cancel(), actor: 'owner' })).toBe(ExitCode.usage);
    expect(await code(reader.token, cancel())).toBe(ExitCode.forbidden);
    // Supported kind with no handler in this build: refused before admission.
    const confirm = cancel({ request_id: '33333333-3333-4333-8333-333333333333', kind: 'task_confirm', payload: {} });
    expect(await code(owner.value, confirm)).toBe(ExitCode.usage);
    expect(started.value.store.readCommand('33333333-3333-4333-8333-333333333333')).toBeNull();
    expect(await code(owner.value, cancel({ request_id: '44444444-4444-4444-8444-444444444444', kind: 'yolo', payload: {} }))).toBe(ExitCode.usage);

    const first = await post(owner.value, cancel());
    expect(first.ok && first.value.envelope).toMatchObject({ ok: true, data: { replayed: false, result: { cancelled: true } } });
    const again = await post(owner.value, cancel());
    expect(again.ok && again.value.envelope).toMatchObject({ ok: true, data: { replayed: true, result: { cancelled: true } } });
    expect(runs).toBe(1);
    expect(await code(owner.value, cancel({ payload: { reason: 'different' } }))).toBe(ExitCode.conflict);

    const query = await callDaemon({ socketPath: sock, token: reader.token, method: 'POST', path: '/v1/query', body: { kind: 'task_show' } });
    expect(query.ok && exitCodeFor(query.value.envelope)).toBe(ExitCode.usage);
  });

  it('reports a stopped daemon as a connection failure (exit 3), never by opening the database', async () => {
    const dir = dataDir();
    const started = await startDaemon({ dataDir: dir, accessTokens: [], clock, newId });
    if (!started.ok) throw new Error(started.error.detail);
    await started.value.stop();
    const term = io();
    process.env['CUSR_TOKEN_FILE'] = started.value.ownerTokenPath;
    try {
      expect(await statusCommand.run({ dataDir: dir }, true, term)).toBe(ExitCode.connection);
    } finally {
      delete process.env['CUSR_TOKEN_FILE'];
    }
    expect(JSON.parse(term.out.join(''))).toMatchObject({ ok: false, error: { code: 'daemon_unreachable' } });
  });
});

describe('control socket path', () => {
  it('refuses a data dir whose socket path exceeds the Unix socket limit with a clear error', async () => {
    const dir = join(dataDir(), 'x'.repeat(120));
    const started = await startDaemon({ dataDir: dir, accessTokens: [], clock, newId });
    expect(started).toMatchObject({ ok: false, error: { code: 'listen_failed' } });
    expect(!started.ok && started.error.detail).toMatch(/Unix sockets allow 107/);
  });
});
