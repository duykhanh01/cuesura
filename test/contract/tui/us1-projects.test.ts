import { request, createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { KEY } from '../../support/pty.ts';
import { daemonSocket, useTui } from '../../support/tui-fixtures.ts';

const tui = useTui();
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** Forward real daemon reads, while controlling just the project-list response. */
async function projectServer(target: string) {
  const proxy = await tui.proxy(target);
  let projectReads = 0;
  let unavailable = false;
  let projectReply: unknown = null;
  let failures = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      if (unavailable) {
        res.destroy();
        return;
      }
      if (body !== '' && (JSON.parse(body) as { kind?: string }).kind === 'project_list') {
        projectReads += 1;
        if (failures > 0) {
          failures -= 1;
          res.destroy();
          return;
        }
        if (projectReply !== null) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(projectReply));
          return;
        }
      }
      const upstream = request(
        {
          socketPath: target,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (reply) => {
          res.writeHead(reply.statusCode ?? 200, reply.headers);
          reply.pipe(res);
        },
      );
      upstream.on('error', () => res.destroy());
      upstream.end(body);
    });
  });
  servers.push(server);
  // The proxy directory already has a listening socket, so use a second socket in it.
  const socket = join(proxy.dataDir, 'projects.sock');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  proxy.retarget(socket);
  return {
    dataDir: proxy.dataDir,
    reads: () => projectReads,
    reply: (value: unknown) => {
      projectReply = value;
    },
    fail: (count: number) => {
      failures = count;
    },
    offline: (value: boolean) => {
      unavailable = value;
    },
  };
}

const projects = (...ids: string[]) => ({
  schema_version: 1,
  ok: true,
  data: {
    caller: {
      actor: 'owner',
      roles: ['read'],
      trusted_confirmer: false,
    },
    projects: ids.map((id) => ({ id, repo: null })),
    profiles: [],
  },
  error: null,
});

describe('US1: project-list failures', () => {
  it.each([
    { schema_version: 1, ok: true, data: { old_schema: true }, error: null },
    {
      schema_version: 1,
      ok: false,
      data: null,
      error: { code: 'not_available', message: 'project_list unavailable' },
    },
  ])('stops on incompatible project data until the user retries', async (reply) => {
    const sd = tui.daemon();
    await sd.start();
    const endpoint = await projectServer(daemonSocket(sd));
    endpoint.reply(reply);
    const s = tui.cusr(endpoint.dataDir);
    await s.waitForText('Stopped:', 3_000);
    expect(s.screenText()).toContain('Next: install the same version');
    expect(s.screenText()).toContain('daemon: unknown');
    const reads = endpoint.reads();
    endpoint.reply(null);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(endpoint.reads()).toBe(reads);
    s.send('R');
    await s.waitFor(() => !s.screenText().includes('Stopped:'));
    await s.waitFor(() => !s.screenText().includes('Data may be out of date'));
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('retries a failed project reload after reconnect even with cached caller data', async () => {
    const sd = tui.daemon();
    await sd.start();
    const endpoint = await projectServer(daemonSocket(sd));
    endpoint.reply(projects('before', 'other'));
    const s = tui.cusr(endpoint.dataDir);
    await s.waitForText('Projects: before, other');
    endpoint.offline(true);
    await s.waitForText('Reconnecting');
    endpoint.reply(projects('after', 'other'));
    endpoint.fail(1);
    endpoint.offline(false);
    await s.waitForText('Projects: after, other', 5_000);
    await s.waitFor(() => !s.screenText().includes('Data may be out of date'));
    expect(endpoint.reads()).toBeGreaterThanOrEqual(3);
    s.send('f');
    await s.waitForText('Find project:');
    s.send(KEY.down);
    await s.waitForText('› after');
    s.send(KEY.enter);
    await s.waitForText('Filters: project after');
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });
});
