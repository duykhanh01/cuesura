import { describe, expect, it } from 'vitest';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { ControlProxy } from '../../support/control-proxy.ts';
import type { SeededDaemon } from '../../support/daemon-task.ts';
import { KEY, type PtySession } from '../../support/pty.ts';
import {
  cancelTask,
  cliJson,
  daemonSocket,
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
  env: Record<string, string> = {},
): Promise<{ s: PtySession; proxy: ControlProxy }> {
  const proxy = await tui.proxy(daemonSocket(sd));
  const s = tui.cusr(proxy.dataDir, { env });
  return { s, proxy };
}

/** Nothing connects for this long, on a session that says it has stopped trying. */
async function expectNoNewConnections(proxy: ControlProxy, ms: number): Promise<void> {
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
    await s.waitForText('▲ 1 need you');
    const result = await cancelTask(sd, id!, 0);
    expect(result.envelope.ok).toBe(true);
    await s.waitForText('■ 1 cancelled');
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
    await s.waitForText('▲ 2 need you');
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
    await s.waitForText('▲ 2 need you');
    expect(s.screenText()).toContain('Data may be out of date');
    expect(s.screenText()).toContain('Ready 01');
    expect(s.screenText()).not.toContain('Filters:');
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
    await s.waitForText('▲ 1 need you');

    proxy.mode = 'hold';
    await s.waitFor(() => reconnectAttempt(s.screenText()) >= 5, 30_000);
    // Nobody waits on the stuck reads: keys still answer.
    s.send('?');
    await s.waitForText('Keys on Home');
    s.send(KEY.esc);
    await s.waitForText('▲ 1 need you');

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
    ['SIGTERM', 143, async (s: PtySession) => s.signal('SIGTERM', await s.programPid())],
    ['SIGHUP', 129, async (s: PtySession) => s.signal('SIGHUP', await s.programPid())],
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

describe('US1 scenario 10: a declared actor the daemon does not know', () => {
  it('stops at once, says how to fix it and never connects', async () => {
    const sd = tui.daemon();
    seedReady(sd, 1);
    await sd.start();
    const { s, proxy } = await throughProxy(sd, { CUSR_ACTOR: 'viewer' });
    await s.waitForText('Stopped:');
    const stopped = s.screenText();
    expect(stopped).toContain("CUSR_ACTOR 'viewer' is not one of owner, assistant");
    expect(stopped).toContain('Next: set CUSR_ACTOR');
    expect(stopped).not.toContain('Reconnecting');
    expect(proxy.connections).toBe(0);
    await expectNoNewConnections(proxy, 1_500);
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
    await s.waitForText('▲ 1 need you');

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
    await s.waitFor(() => !s.screenText().includes('Data may be out of date'), 10_000);
    expect(s.screenText()).toContain('▲ 1 need you');
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });
});
