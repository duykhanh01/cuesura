import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { callDaemon } from '../../../src/cli/client.ts';
import { createDaemonPort } from '../../../src/tui/client/daemon-port.ts';
import {
  RefreshScheduler,
  systemRefreshClock,
  type RoundResult,
} from '../../../src/tui/client/refresh.ts';
import type { Connection } from '../../../src/tui/model/state.ts';

// Real sockets: what matters is that a connection really closes, which a fake transport cannot show.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** Sends one space every 10 ms, for ever: never idle, never finished. */
function trickle(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  const timer = setInterval(() => res.write(' '), 10);
  res.on('close', () => clearInterval(timer));
}

async function daemon(handler: (path: string, body: string, res: ServerResponse) => void) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-deadline-')));
  const open = new Set<string>();
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const kind =
        req.url === '/v1/health' ? 'health' : (JSON.parse(body) as { kind: string }).kind;
      const id = `${kind}#${seen.length}`;
      seen.push(kind);
      open.add(id);
      res.on('close', () => open.delete(id));
      handler(req.url ?? '', body, res);
    });
  });
  const socketPath = join(dir, 'control.sock');
  await new Promise<void>((r) => server.listen(socketPath, r));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, socketPath, open, seen };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('callDaemon', () => {
  it('a response that trickles cannot outlast the timeout, and its connection closes', async () => {
    const d = await daemon((_p, _b, res) => trickle(res));
    const started = Date.now();
    const r = await callDaemon({
      socketPath: d.socketPath,
      actor: 'owner',
      method: 'GET',
      path: '/v1/health',
      timeoutMs: 100,
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(Date.now() - started).toBeLessThan(1_000);
    await wait(50);
    expect(d.open.size).toBe(0);
  });

  it('the signal cancels and closes the connection', async () => {
    const d = await daemon((_p, _b, res) => trickle(res));
    const controller = new AbortController();
    const call = callDaemon({
      socketPath: d.socketPath,
      actor: 'owner',
      method: 'GET',
      path: '/v1/health',
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await wait(50);
    expect(d.open.size).toBe(1);
    controller.abort();
    expect(await call).toMatchObject({ ok: false, error: { code: 'timeout' } });
    await wait(50);
    expect(d.open.size).toBe(0);
  });

  it('a signal already fired sends nothing', async () => {
    const d = await daemon((_p, _b, res) => trickle(res));
    const r = await callDaemon({
      socketPath: d.socketPath,
      actor: 'owner',
      method: 'GET',
      path: '/v1/health',
      signal: AbortSignal.abort(),
    });
    expect(r.ok).toBe(false);
    await wait(50);
    expect(d.seen).toEqual([]);
  });

  it.each([
    ['no ok', { schema_version: 1 }],
    ['a null error', { schema_version: 1, ok: false, error: null }],
    ['an error without a code', { schema_version: 1, ok: false, error: {} }],
    ['ok without data', { schema_version: 1, ok: true }],
    ['an array', [1]],
    ['another version', { schema_version: 2, ok: true, data: 1 }],
  ])('%s is a protocol error', async (_name, reply) => {
    const d = await daemon((_p, _b, res) => res.end(JSON.stringify(reply)));
    expect(
      await callDaemon({
        socketPath: d.socketPath,
        actor: 'owner',
        method: 'GET',
        path: '/v1/health',
      }),
    ).toMatchObject({ ok: false, error: { code: 'protocol' } });
  });
});

describe('daemon port on a real socket', () => {
  it('projects() gives up at its deadline while the daemon trickles', async () => {
    const d = await daemon((_p, _b, res) => trickle(res));
    const started = Date.now();
    const r = await createDaemonPort({ dataDir: d.dir, env: {} }).projects(30);
    expect(r).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it.each([
    ['{"schema_version":1}'],
    ['{"schema_version":1,"ok":false,"error":null}'],
    // These variants need the real parser/port, not a separate PTY and retry window each.
    ['{"schema_version":1,"ok":true,"data":{"unchanged":false,"tasks_v9":[]}}'],
    ['{"hello":"world"}'],
    ['{"schema_version":1,"ok":false,"error":{"code":"not_available","message":"no such query"}}'],
  ])('%s is incompatible and does not throw', async (reply) => {
    const d = await daemon((_p, _b, res) => res.end(reply));
    const port = createDaemonPort({ dataDir: d.dir, env: {} });
    expect(await port.board({}, 1_000)).toMatchObject({
      ok: false,
      error: { kind: 'incompatible' },
    });
    expect(await port.health(1_000)).toMatchObject({
      ok: false,
      error: { kind: 'incompatible' },
    });
  });
});

describe('RefreshScheduler on a real socket', () => {
  it('past the 2 second timeout at most one request of each kind is open (R-03)', async () => {
    const d = await daemon((_p, _b, res) => trickle(res));
    const port = createDaemonPort({ dataDir: d.dir, env: {} });
    let connection: Connection = { kind: 'connecting' };
    const reports: RoundResult[] = [];
    const scheduler = new RefreshScheduler({
      clock: systemRefreshClock,
      reads: {
        board: (_fresh, timeoutMs, signal) => port.board({}, timeoutMs, signal),
        health: (timeoutMs, signal) => port.health(timeoutMs, signal),
      },
      report: (r) => {
        reports.push(r);
        connection = { kind: 'reconnecting', attempt: reports.length };
        return connection;
      },
    });
    cleanups.push(() => scheduler.stop());
    let most = 0;
    const started = Date.now();
    scheduler.start();
    while (Date.now() - started < 2_500) {
      const boards = [...d.open].filter((id) => id.startsWith('task_board'));
      most = Math.max(most, boards.length);
      await wait(5);
    }
    // The next round has started by now, so an old request left open would show as two.
    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(d.seen.filter((k) => k === 'task_board').length).toBeGreaterThan(1);
    expect(most).toBe(1);
    scheduler.stop();
    await wait(50);
    expect(d.open.size).toBe(0);
  }, 10_000);
});
