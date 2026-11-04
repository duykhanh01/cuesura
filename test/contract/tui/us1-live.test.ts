import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCOPE_NOTE } from '../../../src/tui/views/home.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { ControlProxy } from '../../support/control-proxy.ts';
import type { SeededDaemon } from '../../support/daemon-task.ts';
import { KEY, type PtySession } from '../../support/pty.ts';
import {
  cancelTask,
  cliJson,
  daemonSocket,
  ownerTokenEnv,
  reconnectAttempt,
  rowOf,
  seedRunning,
  taskAdd,
  useTui,
  watermark,
} from '../../support/tui-fixtures.ts';

// T032: a session left open while the daemon changes, dies, comes back or stops accepting the client. Budgets
// are the ones SC-003 names, measured from the moment the daemon is ready, and no key is pressed unless said.
const tui = useTui();

const OPEN = {
  alternateScreen: true,
  cursorHidden: true,
  bracketedPaste: true,
  mouseTracking: false,
};

const seedReady = (sd: SeededDaemon, count: number): string[] =>
  sd.seed((d) =>
    Array.from({ length: count }, (_, i) => {
      const t = buildTask({
        id: uuidOf(i + 1),
        title: `Ready ${String(i + 1).padStart(2, '0')}`,
      });
      d.must(t.id, { kind: 'create_task', task: t });
      return t.id;
    }),
  );

/** `cusr` through a proxy, so a test can see every connection and change what the client reaches. */
async function throughProxy(
  sd: SeededDaemon,
  env: Record<string, string> = ownerTokenEnv(sd),
): Promise<{ s: PtySession; proxy: ControlProxy }> {
  const proxy = await tui.proxy(daemonSocket(sd));
  const s = tui.cusr(proxy.dataDir, { env });
  return { s, proxy };
}

/** All at once, as a token is rotated: a read in between must not find the file half written. */
function replaceToken(path: string, token: string): void {
  writeFileSync(`${path}.new`, `${token}\n`, { mode: 0o600 });
  renameSync(`${path}.new`, path);
}

/** Nothing connects for this long, on a session that says it has stopped trying. */
async function expectNoNewConnections(
  proxy: ControlProxy,
  ms: number,
): Promise<void> {
  const before = proxy.connections;
  await new Promise((r) => setTimeout(r, ms));
  expect(proxy.connections).toBe(before);
}

describe('US1 scenario 4: a change shows by itself', () => {
  it('shows a status change without a key press', async () => {
    const sd = tui.daemon();
    const [id] = seedReady(sd, 1);
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('◇ 1 ready');
    const result = await cancelTask(sd, id!, 0);
    expect(result.envelope.ok).toBe(true);
    await s.waitForText('– 1 cancelled');
    await s.waitForText('Finished (1)');
    expect(s.screenText()).not.toContain('Ready 01');
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });
});

describe('US1 scenario 6 and SC-011: the daemon dies under an open session', () => {
  it('stays open, marks what it shows as old, keeps what was typed and sends nothing by itself', async () => {
    const sd = tui.daemon();
    seedReady(sd, 2);
    await sd.start();
    const { s, proxy } = await throughProxy(sd);
    const sent: string[] = [];
    proxy.tap = (direction, data) => {
      if (direction === 'request') sent.push(data.toString('utf8'));
    };
    await s.waitForText('◇ 2 ready');
    await s.waitFor(() => /updated: \d\d:\d\d:\d\d/.test(s.screenText()));

    s.send('f');
    await s.waitForText('Find project:');
    s.send('zz');
    await s.waitForText('Find project: zz_');

    await sd.stop();
    await s.waitForText('Data may be out of date — last updated ');
    await s.waitForText('Reconnecting (');
    const screen = s.screenText();
    expect(screen).toMatch(
      /Data may be out of date — last updated \d\d:\d\d:\d\d — Reconnecting \(\d+\/30\)/,
    );
    expect(screen.split('\n')[0]).toContain('daemon: unknown');
    expect(screen.split('\n')[0]).not.toContain('daemon: ok');
    expect(screen).toContain('Find project: zz_');
    expect(s.modes()).toEqual(OPEN);

    // Leaving the field still works, and what is on screen stays marked.
    s.send(KEY.esc);
    await s.waitForText('◇ 2 ready');
    expect(s.screenText()).toContain('Data may be out of date');
    expect(s.screenText()).toContain('Ready 01');
    expect(s.screenText()).toContain('Filters: project all · status all');
    expect(s.modes()).toEqual(OPEN);
    expect(sent.filter((r) => r.includes('/v1/command'))).toEqual([]);

    // Quitting works with the daemon gone.
    s.send('q');
    const exit = await s.waitForExit();
    expect(exit.status).toBe(0);
    expect(exit.sttyAfter).toBe(exit.sttyBefore);
  });
});

describe('SC-003 and EC-007: the daemon back inside the automatic window', () => {
  it('has new data within 10 seconds of the daemon being ready, and no running task reads as lost', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 2));
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('▶ 2 running');
    await sd.stop();
    // By this attempt the wait between attempts is at its largest: the worst case of the budget.
    await s.waitFor(() => reconnectAttempt(s.screenText()) >= 6, 20_000);
    expect(s.screenText()).toContain('Task 001');

    sd.seed((d) => {
      const t = buildTask({ id: uuidOf(50), title: 'Came with the restart' });
      d.must(t.id, { kind: 'create_task', task: t });
    });
    await sd.start();
    const readyAt = Date.now();
    await s.waitForText('Came with the restart', 10_000);
    expect(Date.now() - readyAt).toBeLessThan(10_000);

    const screen = s.screenText();
    expect(screen).not.toContain('Data may be out of date');
    expect(screen.split('\n')[0]).toContain('daemon: ok');
    expect(screen).toContain('▶ 2 running');
    expect(rowOf(screen, 'Task 001')).toContain('▶ Task 001');
    expect(rowOf(screen, 'Task 002')).toContain('▶ Task 002');
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('a daemon that holds connections and never answers, then answers: within 10 seconds, measured', async () => {
    const sd = tui.daemon();
    seedReady(sd, 1);
    await sd.start();
    const { s, proxy } = await throughProxy(sd);
    await s.waitForText('◇ 1 ready');

    proxy.mode = 'hold';
    await s.waitFor(() => reconnectAttempt(s.screenText()) >= 5, 30_000);
    // Nobody waits on the stuck reads: keys still answer.
    s.send('?');
    await s.waitForText('Keys on Home');
    s.send(KEY.esc);
    await s.waitForText('◇ 1 ready');

    const added = await sd.command('owner', taskAdd(1, 'Answered at last'));
    expect(added.envelope.ok).toBe(true);
    proxy.mode = 'forward';
    const readyAt = Date.now();
    await s.waitForText('Answered at last', 10_000);
    expect(Date.now() - readyAt).toBeLessThan(10_000);
    expect(s.screenText()).not.toContain('Data may be out of date');
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  }, 60_000);
});

describe('US1 scenario 7 and FR-004: quitting changes nothing but the terminal', () => {
  it.each([
    ['q', 0, (s: PtySession) => s.send('q')],
    ['Ctrl-C', 0, (s: PtySession) => s.send(KEY.ctrlC)],
    [
      'SIGTERM',
      143,
      async (s: PtySession) => s.signal('SIGTERM', await s.programPid()),
    ],
    [
      'SIGHUP',
      129,
      async (s: PtySession) => s.signal('SIGHUP', await s.programPid()),
    ],
  ] as const)(
    '%s gives the terminal back; tasks and the daemon go on exactly as they were',
    async (_how, status, leave) => {
      const sd = tui.daemon();
      sd.seed((d) => seedRunning(d, 2));
      await sd.start();
      const before = await cliJson(sd, 'task', 'list');
      const seq = await watermark(sd);
      const s = tui.cusr(sd.dataDir);
      await s.waitForText('▶ 2 running');
      expect(s.modes()).toEqual(OPEN);

      await leave(s);
      const exit = await s.waitForExit();
      expect(exit.status).toBe(status);
      expect(exit.sttyAfter).toBe(exit.sttyBefore);
      expect(s.modes()).toEqual({
        alternateScreen: false,
        cursorHidden: false,
        bracketedPaste: false,
        mouseTracking: false,
      });

      const after = await cliJson(sd, 'task', 'list');
      expect(after.envelope.data).toEqual(before.envelope.data);
      expect(await watermark(sd)).toBe(seq);
      const health = await cliJson(sd, 'status');
      expect(health.code).toBe(0);
    },
  );
});

describe('US1 scenario 10 and EC-008: permission gone mid-session', () => {
  const VIEWER = {
    id: 'viewer',
    actor: 'viewer',
    roles: ['read' as const],
    projects: ['acme'],
  };

  it('a revoked token stops the attempts at once, says why, and only the user tries again', async () => {
    const sd = tui.daemon({ tokens: [VIEWER] });
    seedReady(sd, 1);
    await sd.start();
    const tokenFile = join(sd.base, 'viewer.token');
    const { s, proxy } = await throughProxy(sd, {
      CUSR_TOKEN_FILE: tokenFile,
    });
    await s.waitForText('◇ 1 ready');

    // The daemon no longer knows this token. No other token is looked for.
    replaceToken(tokenFile, 'A'.repeat(43));
    await s.waitForText('Stopped:');
    const stopped = s.screenText();
    expect(stopped).toContain('Next: use a valid token');
    expect(stopped).toContain('Retry connection (R)');
    expect(stopped).toContain('Data may be out of date');
    expect(stopped).not.toContain('Reconnecting');
    expect(stopped).toContain('Ready 01');
    expect(stopped.split('\n')[0]).toContain('daemon: unknown');
    await expectNoNewConnections(proxy, 3_000);

    // Asked again with nothing fixed: one more try, the same answer.
    const beforeRetry = proxy.connections;
    s.send('R');
    // One read of the board and one of health; the old `Stopped` proves nothing until they have connected.
    await s.waitFor(() => proxy.connections >= beforeRetry + 2);
    await s.waitForText('Stopped:');
    await expectNoNewConnections(proxy, 2_000);

    // Fixed, and asked: back to current data.
    replaceToken(tokenFile, sd.tokens['viewer'] ?? '');
    await expectNoNewConnections(proxy, 1_500);
    s.send('R');
    await s.waitFor(() => !s.screenText().includes('Stopped:'), 10_000);
    await s.waitFor(() => !s.screenText().includes('Data may be out of date'));
    expect(s.screenText().split('\n')[0]).toContain('daemon: ok');
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('a token file gone unreadable stops the same way, without printing the token', async () => {
    const sd = tui.daemon({ tokens: [VIEWER] });
    seedReady(sd, 1);
    await sd.start();
    const tokenFile = join(sd.base, 'viewer.token');
    const { s, proxy } = await throughProxy(sd, {
      CUSR_TOKEN_FILE: tokenFile,
    });
    await s.waitForText('◇ 1 ready');
    rmSync(tokenFile);
    await s.waitForText('Stopped:');
    expect(s.screenText()).toContain('Next: fix the token file');
    await expectNoNewConnections(proxy, 2_000);
    expect(s.rawOutput()).not.toContain(sd.tokens['viewer']);
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });
});

describe('US1 scenario 10 and EC-008: a token that may no longer read this view', () => {
  it('stops at once with the reason, and a filter it may read brings the data back on R', async () => {
    const sd = tui.daemon({
      projects: ['beta'],
      tokens: [
        {
          id: 'both',
          actor: 'both',
          roles: ['read'],
          projects: ['acme', 'beta'],
        },
        { id: 'acme', actor: 'acme', roles: ['read'], projects: ['acme'] },
      ],
    });
    sd.seed((d) => {
      seedRunning(d, 1, () => ({ title: 'In acme' }), 1);
      seedRunning(d, 1, () => ({ title: 'In beta', project: 'beta' }), 2);
    });
    await sd.start();
    const tokenFile = join(sd.base, 'both.token');
    const { s, proxy } = await throughProxy(sd, { CUSR_TOKEN_FILE: tokenFile });
    await s.waitForText('Projects: acme, beta');
    s.send('f');
    await s.waitForText('Find project:');
    s.send('beta');
    await s.waitForText('Find project: beta_');
    s.send(KEY.enter);
    await s.waitFor(() => !s.screenText().includes('In acme'));
    await s.waitForText('In beta');

    replaceToken(tokenFile, sd.tokens['acme'] ?? '');
    await s.waitForText('Stopped: requires project beta');
    const screen = s.screenText();
    expect(screen).toContain('Next: use a token that may read this');
    expect(screen).toContain('Data may be out of date');
    expect(screen).not.toContain('Reconnecting');
    expect(screen.split('\n')[0]).toContain('daemon: unknown');
    await expectNoNewConnections(proxy, 2_000);

    // Navigation still works; going back to everything the token may read is the user's call.
    s.send('f');
    await s.waitForText('Find project:');
    s.send(KEY.up + KEY.up);
    await s.waitForText('› All projects');
    s.send(KEY.enter);
    await s.waitForText('Filters: project all');
    await expectNoNewConnections(proxy, 1_500);
    s.send('R');
    await s.waitForText('In acme', 10_000);
    await s.waitFor(() => !s.screenText().includes('Data may be out of date'));
    expect(s.screenText()).not.toContain('In beta');
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });
});

describe('EC-008 and EC-009: another token with nothing new in the daemon', () => {
  it('reads the board, the caller and the projects again, in both directions', async () => {
    const sd = tui.daemon({
      projects: ['beta'],
      tokens: [
        { id: 'acme', actor: 'acme', roles: ['read'], projects: ['acme'] },
      ],
    });
    sd.seed((d) => {
      seedRunning(d, 1, () => ({ title: 'In acme' }), 1);
      seedRunning(d, 1, () => ({ title: 'In beta', project: 'beta' }), 2);
    });
    await sd.start();
    const seq = await watermark(sd);
    const tokenFile = join(sd.base, 'client.token');
    const owner = sd.tokens['owner'] ?? '';
    replaceToken(tokenFile, owner);
    const s = tui.cusr(sd.dataDir, { env: { CUSR_TOKEN_FILE: tokenFile } });
    await s.waitForText('Projects: acme, beta');
    await s.waitForText('In beta');
    expect(s.screenText()).not.toContain(SCOPE_NOTE);

    // Narrower: what the old token read is gone without any event to bring it down.
    replaceToken(tokenFile, sd.tokens['acme'] ?? '');
    await s.waitFor(() => !s.screenText().includes('In beta'), 3_000);
    await s.waitForText('Projects: acme', 3_000);
    await s.waitForText(SCOPE_NOTE, 3_000);
    expect(s.screenText()).not.toContain('Projects: acme, beta');
    expect(s.screenText()).toContain('In acme');
    expect(s.screenText()).not.toContain('Data may be out of date');

    // Wider: nothing new either, and `unchanged` would keep the narrow list for good.
    replaceToken(tokenFile, owner);
    await s.waitForText('In beta', 3_000);
    await s.waitForText('Projects: acme, beta', 3_000);
    await s.waitFor(() => !s.screenText().includes(SCOPE_NOTE), 3_000);

    expect(await watermark(sd)).toBe(seq);
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });
});

describe('US1 scenario 10 and EC-010: a daemon of another version', () => {
  // Shape/envelope/query variants use real sockets in integration/runtime/client-deadline.test.ts.
  // Keep the real socket -> parser -> stopped UI -> manual retry path once.
  it('an unreadable daemon response stops refresh until the user retries', async () => {
    const sd = tui.daemon();
    seedReady(sd, 1);
    await sd.start();
    const { s, proxy } = await throughProxy(sd);
    await s.waitForText('◇ 1 ready');

    const other = await tui.answering('upgrade required');
    proxy.retarget(other.socketPath);
    await s.waitForText('Stopped:');
    const screen = s.screenText();
    expect(screen).toContain('Next: install the same version');
    expect(screen).toContain('Data may be out of date');
    expect(screen).not.toContain('Reconnecting');
    expect(screen.split('\n')[0]).toContain('daemon: unknown');
    await expectNoNewConnections(proxy, 2_000);

    proxy.retarget(daemonSocket(sd));
    await expectNoNewConnections(proxy, 1_500);
    expect(s.screenText()).toContain('Stopped:');
    s.send('R');
    await s.waitFor(
      () => !s.screenText().includes('Data may be out of date'),
      10_000,
    );
    expect(s.screenText()).toContain('◇ 1 ready');
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });
});
