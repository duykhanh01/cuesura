import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTROL_SOCKET, errorEnvelope } from '../../../src/cli/output.ts';
import { call } from '../../../src/cli/tasks.ts';
import { uuidOf } from '../../support/builders.ts';

// #267: a daemon error that carries no request ID still names the ID the mutation sent.

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function daemonAnswering(requestId: string | null): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cusr-err-id-'));
  dirs.push(dir);
  const server = createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        errorEnvelope({
          code: 'internal',
          message: 'internal error',
          details: {},
          request_id: requestId,
        }),
      ),
    );
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(join(dir, CONTROL_SOCKET), r));
  return dir;
}

describe('a daemon error without a request ID (#267)', () => {
  it('gets the request ID the CLI sent; one the daemon named is kept', async () => {
    const sent = uuidOf(1);
    const blank = await daemonAnswering(null);
    expect((await call({ dataDir: blank }, '/v1/command', {}, sent)).error).toMatchObject({
      code: 'internal',
      request_id: sent,
    });
    const named = await daemonAnswering(uuidOf(2));
    expect((await call({ dataDir: named }, '/v1/command', {}, sent)).error).toMatchObject({
      request_id: uuidOf(2),
    });
    expect((await call({ dataDir: blank }, '/v1/query', {}, null)).error).toMatchObject({
      request_id: null,
    });
  });
});
