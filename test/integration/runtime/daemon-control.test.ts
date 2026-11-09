import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { callDaemon, exitCodeFor, statusCommand } from '../../../src/cli/client.ts';
import type { CallerActor } from '../../../src/application/authz.ts';
import { ExitCode } from '../../../src/cli/output.ts';
import { call } from '../../../src/cli/tasks.ts';
import { packageVersion } from '../../../src/cli/program.ts';
import Database from 'better-sqlite3';
import {
  STORE_FILE,
  startDaemon,
  type CommandHandler,
  type RunningDaemon,
} from '../../../src/daemon/main.ts';
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

const clock = { now: () => asEpochMs(1_800_000_000_000), monotonic: () => 0 };
let seq = 0;
const newId = (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

function io(): {
  stdout: (t: string) => void;
  stderr: (t: string) => void;
  out: string[];
  err: string[];
} {
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
  it('serves health over a 0600 socket in a 0700 data dir, and cusr status exits 0', async () => {
    const dir = dataDir();
    const started = await startDaemon({
      dataDir: dir,
      clock,
      newId,
    });
    expect(started.ok, JSON.stringify(!started.ok && started.error)).toBe(true);
    if (!started.ok) return;
    daemons.push(started.value);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(started.value.socketPath).mode & 0o777).toBe(0o600);

    const term = io();
    expect(await statusCommand.run({ dataDir: dir }, true, term)).toBe(ExitCode.ok);
    const health = JSON.parse(term.out.join('')) as {
      ok: boolean;
      data: Record<string, unknown>;
    };
    expect(health).toMatchObject({
      ok: true,
      data: {
        writer: 'ok',
        build: { version: packageVersion() },
        startup: { at: clock.now(), projections: { ok: true }, timers: { armed: 0 } },
        dispatch: { blocked: null, in_flight: 0 },
        slots: [],
        concurrency: 1,
      },
    });

    const anon = await callDaemon({
      socketPath: started.value.socketPath,
      actor: 'viewer' as CallerActor,
      method: 'GET',
      path: '/v1/health',
    });
    expect(anon.ok && anon.value.status).toBe(401);
    expect(anon.ok && exitCodeFor(anon.value.envelope)).toBe(ExitCode.forbidden);
  });

  it('is the only writer: a second daemon on the same data dir is refused', async () => {
    const dir = dataDir();
    const first = await startDaemon({
      dataDir: dir,
      clock,
      newId,
    });
    if (!first.ok) throw new Error(first.error.detail);
    daemons.push(first.value);
    const second = await startDaemon({
      dataDir: dir,
      clock,
      newId,
    });
    expect(second).toMatchObject({
      ok: false,
      error: { code: 'store_locked' },
    });
  });

  it('refuses a data dir other users can read', async () => {
    const dir = dataDir();
    const started = await startDaemon({
      dataDir: dir,
      clock,
      newId,
    });
    if (!started.ok) throw new Error(started.error.detail);
    await started.value.stop();
    chmodSync(dir, 0o755);
    expect(await startDaemon({ dataDir: dir, clock, newId })).toMatchObject({
      ok: false,
      error: { code: 'data_dir_insecure' },
    });
  });

  it('admits commands server-side: authz from the declared actor, unavailable kinds leave no ledger row, replay and conflict by request id', async () => {
    const dir = dataDir();
    let runs = 0;
    const handler: CommandHandler = () => {
      runs++;
      return Promise.resolve({ ok: true, value: { cancelled: true } });
    };
    const started = await startDaemon({
      dataDir: dir,
      clock,
      newId,
      commands: { task_cancel: handler, approve_adopt: handler },
    });
    if (!started.ok) throw new Error(started.error.detail);
    daemons.push(started.value);
    const sock = started.value.socketPath;
    const post = (actor: CallerActor, body: unknown) =>
      callDaemon({
        socketPath: sock,
        actor,
        method: 'POST',
        path: '/v1/command',
        body,
      });
    const code = async (actor: CallerActor, body: unknown): Promise<number> => {
      const r = await post(actor, body);
      if (!r.ok) throw new Error(r.error.message);
      return exitCodeFor(r.value.envelope);
    };

    // The assistant cannot adopt a PR, whatever actor the body claims.
    const approve = cancel({
      request_id: '55555555-5555-4555-8555-555555555555',
      kind: 'approve_adopt',
      payload: { head_sha: 'a'.repeat(40) },
    });
    expect(await code('assistant', { ...approve, actor: 'owner' })).toBe(ExitCode.forbidden);
    expect(await code('assistant', approve)).toBe(ExitCode.forbidden);
    // Supported kind with no handler in this build: refused before admission.
    const confirm = cancel({
      request_id: '33333333-3333-4333-8333-333333333333',
      kind: 'task_confirm',
      payload: {},
    });
    expect(await code('owner', confirm)).toBe(ExitCode.usage);
    expect(started.value.store.readCommand('33333333-3333-4333-8333-333333333333')).toBeNull();
    expect(
      await code(
        'owner',
        cancel({
          request_id: '44444444-4444-4444-8444-444444444444',
          kind: 'yolo',
          payload: {},
        }),
      ),
    ).toBe(ExitCode.usage);

    const first = await post('owner', cancel());
    expect(first.ok && first.value.envelope).toMatchObject({
      ok: true,
      data: { replayed: false, result: { cancelled: true } },
    });
    const again = await post('owner', cancel());
    expect(again.ok && again.value.envelope).toMatchObject({
      ok: true,
      data: { replayed: true, result: { cancelled: true } },
    });
    expect(runs).toBe(1);
    expect(await code('owner', cancel({ payload: { reason: 'different' } }))).toBe(
      ExitCode.conflict,
    );

    const query = await callDaemon({
      socketPath: sock,
      actor: 'assistant',
      method: 'POST',
      path: '/v1/query',
      body: { kind: 'task_show' },
    });
    expect(query.ok && exitCodeFor(query.value.envelope)).toBe(ExitCode.usage);
  });

  it('runs one handler for concurrent requests with the same id, and replays a rejection without running again', async () => {
    const dir = dataDir();
    let runs = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const handler: CommandHandler = async (_admitted, input) => {
      runs++;
      await gate;
      const reason = (input.payload as { reason?: string }).reason;
      return reason === 'refuse'
        ? {
            ok: false,
            error: { code: 'task_not_cancellable', message: 'no', details: {} },
          }
        : { ok: true, value: { cancelled: true } };
    };
    const started = await startDaemon({
      dataDir: dir,
      clock,
      newId,
      commands: { task_cancel: handler },
    });
    if (!started.ok) throw new Error(started.error.detail);
    daemons.push(started.value);
    const post = (body: unknown) =>
      callDaemon({
        socketPath: started.value.socketPath,
        actor: 'owner',
        method: 'POST',
        path: '/v1/command',
        body,
      });

    const a = post(cancel());
    const b = post(cancel());
    // Both requests reach the daemon before the first handler returns.
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(runs).toBe(1);
    for (const r of [ra, rb])
      expect(r.ok && r.value).toMatchObject({
        status: 200,
        envelope: { ok: true, data: { result: { cancelled: true } } },
      });

    const refused = cancel({
      request_id: '55555555-5555-4555-8555-555555555555',
      payload: { reason: 'refuse' },
    });
    const first = await post(refused);
    expect(first.ok && first.value).toMatchObject({
      status: 422,
      envelope: { ok: false, error: { code: 'task_not_cancellable' } },
    });
    expect(started.value.store.readCommand('55555555-5555-4555-8555-555555555555')).toMatchObject({
      status: 'completed',
    });
    const again = await post(refused);
    expect(again.ok && again.value).toMatchObject({
      status: 422,
      envelope: { ok: false, error: { code: 'task_not_cancellable' } },
    });
    expect(runs).toBe(2);
  });

  it('a mutation the client stopped waiting for still takes effect once; the same request ID gets its result (issue #258)', async () => {
    const dir = dataDir();
    let runs = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const handler: CommandHandler = async () => {
      runs++;
      await gate;
      return { ok: true, value: { cancelled: true } };
    };
    const started = await startDaemon({
      dataDir: dir,
      clock,
      newId,
      commands: { task_cancel: handler },
    });
    if (!started.ok) throw new Error(started.error.detail);
    daemons.push(started.value);
    const id = '11111111-1111-4111-8111-111111111111';
    const timedOut = await call({ dataDir: dir }, '/v1/command', cancel(), id, 100);
    expect(timedOut).toMatchObject({ ok: false, error: { code: 'daemon_timeout' } });
    expect(exitCodeFor(timedOut)).toBe(ExitCode.connection);
    const again = call({ dataDir: dir }, '/v1/command', cancel(), id);
    release();
    expect(await again).toMatchObject({ ok: true, data: { result: { cancelled: true } } });
    expect(runs).toBe(1);
  });

  it('settles a client call when the daemon cuts the response mid-body', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-cut-')));
    dirs.push(base);
    const socketPath = join(base, 's.sock');
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '1000',
      });
      res.write('{"schema_version":1,');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    await new Promise<void>((r) => server.listen(socketPath, r));
    try {
      const r = await callDaemon({
        socketPath,
        actor: 'owner',
        method: 'GET',
        path: '/v1/health',
        timeoutMs: 60_000,
      });
      expect(r).toMatchObject({ ok: false, error: { code: 'connection' } });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('reports blocked dispatch as a health failure (exit 1) and masks secrets in its log', async () => {
    const dir = dataDir();
    const lines: string[] = [];
    const handler: CommandHandler = () =>
      Promise.reject(new Error(`upstream said: token ghp_${'a'.repeat(36)}`));
    const started = await startDaemon({
      dataDir: dir,
      clock,
      newId,
      commands: { task_cancel: handler },
      log: (m) => lines.push(m),
    });
    if (!started.ok) throw new Error(started.error.detail);
    daemons.push(started.value);

    const failed = await callDaemon({
      socketPath: started.value.socketPath,
      actor: 'owner',
      method: 'POST',
      path: '/v1/command',
      body: cancel(),
    });
    expect(failed.ok && failed.value.status).toBe(500);
    // The reply names the request, so the same ID can finish it (#267).
    expect(failed.ok && failed.value.envelope.error).toMatchObject({
      code: 'internal',
      request_id: cancel().request_id,
    });
    const logged = lines.join('\n');
    expect(logged).toContain(`command task_cancel ${String(cancel().request_id)} failed`);
    expect(logged).not.toContain(`ghp_${'a'.repeat(36)}`);

    started.value.dispatcher.block('projection mismatch (1)');
    const term = io();
    expect(await statusCommand.run({ dataDir: dir }, true, term)).toBe(ExitCode.failure);
    expect(JSON.parse(term.out.join(''))).toMatchObject({
      ok: false,
      error: {
        code: 'unhealthy',
        details: { dispatch: { blocked: 'projection mismatch (1)' } },
      },
    });
  });

  it('keeps replaying a success stored by a daemon before the ledger kept outcomes', async () => {
    const dir = dataDir();
    let runs = 0;
    const handler: CommandHandler = () => (
      runs++,
      Promise.resolve({ ok: true, value: { cancelled: true } })
    );
    const opts = {
      dataDir: dir,
      clock,
      newId,
      commands: { task_cancel: handler },
    };
    const first = await startDaemon(opts);
    if (!first.ok) throw new Error(first.error.detail);
    const done = await callDaemon({
      socketPath: first.value.socketPath,
      actor: 'owner',
      method: 'POST',
      path: '/v1/command',
      body: cancel(),
    });
    expect(done.ok && done.value.status).toBe(200);
    await first.value.stop();
    // Rewrite the row as a schema-2 daemon stored it: the bare handler value.
    const raw = new Database(join(dir, STORE_FILE));
    raw
      .prepare(`UPDATE command_ledger SET result_json = '{"cancelled":true}' WHERE request_id = ?`)
      .run(cancel()['request_id']);
    raw.exec('ALTER TABLE command_ledger DROP COLUMN project');
    raw.prepare('UPDATE schema_meta SET version = 2').run();
    raw.close();

    const second = await startDaemon(opts);
    if (!second.ok) throw new Error(second.error.detail);
    daemons.push(second.value);
    const again = await callDaemon({
      socketPath: second.value.socketPath,
      actor: 'owner',
      method: 'POST',
      path: '/v1/command',
      body: cancel(),
    });
    expect(again.ok && again.value).toMatchObject({
      status: 200,
      envelope: {
        ok: true,
        data: { replayed: true, result: { cancelled: true } },
      },
    });
    expect(runs).toBe(1);
  });

  it('reports a stopped daemon as a connection failure (exit 3), never by opening the database', async () => {
    const dir = dataDir();
    const started = await startDaemon({
      dataDir: dir,
      clock,
      newId,
    });
    if (!started.ok) throw new Error(started.error.detail);
    await started.value.stop();
    const term = io();
    expect(await statusCommand.run({ dataDir: dir }, true, term)).toBe(ExitCode.connection);
    expect(JSON.parse(term.out.join(''))).toMatchObject({
      ok: false,
      error: { code: 'daemon_unreachable' },
    });
  });
});

describe('control socket path', () => {
  it('refuses a data dir whose socket path exceeds the Unix socket limit with a clear error', async () => {
    const dir = join(dataDir(), 'x'.repeat(120));
    const started = await startDaemon({
      dataDir: dir,
      clock,
      newId,
    });
    expect(started).toMatchObject({
      ok: false,
      error: { code: 'listen_failed' },
    });
    expect(!started.ok && started.error.detail).toMatch(/Unix sockets allow 107/);
  });
});
