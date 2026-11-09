import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { callDaemon, clientErrorEnvelope, exitCodeFor } from '../../../src/cli/client.ts';
import { CONTROL_SOCKET, ExitCode } from '../../../src/cli/output.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('a daemon reply over the client size cap (issue #261)', () => {
  it('is response_too_large, exit 1, with a hint, not daemon_unreachable', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-big-')));
    const socket = join(dir, CONTROL_SOCKET);
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, data: 'x'.repeat(9 * 1024 * 1024) }));
    });
    await new Promise<void>((r) => server.listen(socket, r));
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    });
    const r = await callDaemon({
      socketPath: socket,
      actor: 'owner',
      method: 'GET',
      path: '/v1/x',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const envelope = clientErrorEnvelope(dir, r.error, null);
    expect(envelope).toMatchObject({ ok: false, error: { code: 'response_too_large' } });
    expect(envelope.ok ? null : envelope.error.details['guidance']).toMatch(/--limit/);
    expect(exitCodeFor(envelope)).toBe(ExitCode.failure);
  });
});
