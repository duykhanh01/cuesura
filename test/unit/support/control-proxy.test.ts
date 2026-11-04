import { createServer, type Server } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { callDaemon } from '../../../src/cli/client.ts';
import { CONTROL_SOCKET } from '../../../src/cli/output.ts';
import { ControlProxy } from '../../support/control-proxy.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function backend(label: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-backend-')));
  const socket = join(dir, CONTROL_SOCKET);
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push(body);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          schema_version: 1,
          ok: true,
          data: { from: label },
          error: null,
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(socket, r));
  cleanups.push(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  return { socket, seen };
}

async function proxy(target: string, mode?: 'hold' | 'drop_response') {
  const p = await ControlProxy.start(target, mode);
  cleanups.push(() => p.stop());
  return p;
}

const call = (p: ControlProxy, timeoutMs = 2_000) =>
  callDaemon({
    socketPath: join(p.dataDir, CONTROL_SOCKET),
    actor: 'owner',
    method: 'POST',
    path: '/v1/query',
    body: { kind: 'x' },
    timeoutMs,
  });

describe('ControlProxy', () => {
  it('forwards a request and its response', async () => {
    const b = await backend('real');
    const p = await proxy(b.socket);
    const r = await call(p);
    expect(r).toMatchObject({
      ok: true,
      value: { envelope: { data: { from: 'real' } } },
    });
    expect(b.seen).toEqual(['{"kind":"x"}']);
  });

  it('holds a connection without answering', async () => {
    const b = await backend('real');
    const p = await proxy(b.socket, 'hold');
    expect(await call(p, 200)).toMatchObject({
      ok: false,
      error: { code: 'timeout' },
    });
    expect(b.seen).toEqual([]);
    expect(p.connections).toBe(1);
  });

  it('delivers the request and drops the response', async () => {
    const b = await backend('real');
    const p = await proxy(b.socket, 'drop_response');
    expect(await call(p)).toMatchObject({
      ok: false,
      error: { code: 'connection' },
    });
    expect(b.seen).toEqual(['{"kind":"x"}']);
  });

  it('switches from holding to a real daemon without a new listener', async () => {
    const dead = join(tmpdir(), 'cusr-no-such-socket');
    const p = await proxy(dead, 'hold');
    expect((await call(p, 100)).ok).toBe(false);
    const b = await backend('later');
    p.retarget(b.socket);
    p.mode = 'forward';
    p.dropConnections();
    expect(await call(p)).toMatchObject({
      ok: true,
      value: { envelope: { data: { from: 'later' } } },
    });
  });

  it('a target that is gone looks like a dead daemon', async () => {
    const p = await proxy(join(tmpdir(), 'cusr-no-such-socket'));
    expect(await call(p)).toMatchObject({
      ok: false,
      error: { code: 'connection' },
    });
  });
});
