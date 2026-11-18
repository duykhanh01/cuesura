import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PtySession, seededKeys, KEY } from '../../support/pty.ts';
import { hostUsable, Rehearsal, type HistoryEvent } from '../../support/smoke.ts';
import { seedRunning, useTui } from '../../support/tui-fixtures.ts';

// SC-011. The probe covers the terminal half for every exit path, including internal errors. The last block
// runs the real `cusr` against a real daemon and adds the other half: the task goes on. SIGKILL is outside
// the scope: nothing can run after it, so neither restoring the terminal nor reporting is promised.
const PROBE = fileURLToPath(new URL('../../fixtures/tui/terminal-probe.ts', import.meta.url));

const INJECT = fileURLToPath(
  new URL('../../fixtures/tui/inject-internal-error.ts', import.meta.url),
);

const INITIAL_MODES = {
  alternateScreen: false,
  cursorHidden: false,
  bracketedPaste: false,
  mouseTracking: false,
};

describe('terminal restore through a real PTY', () => {
  let session: PtySession | null = null;
  afterEach(() => {
    session?.dispose();
    session = null;
  });

  async function start(
    env: Readonly<Record<string, string>> = {},
  ): Promise<{ s: PtySession; pid: number }> {
    const s = new PtySession({ entry: PROBE, env });
    session = s;
    await s.waitForText('probe ready');
    return { s, pid: await s.programPid() };
  }

  function expectOpen(s: PtySession): void {
    expect(s.modes()).toEqual({
      alternateScreen: true,
      cursorHidden: true,
      bracketedPaste: true,
      mouseTracking: false,
    });
  }

  it('enters raw mode, the alternate screen, hidden cursor and bracketed paste, without the mouse', async () => {
    const { s } = await start();
    expectOpen(s);
    s.send('q');
    const exit = await s.waitForExit();
    expect(exit.sttyBefore).not.toBe('');
  });

  it.each([
    ['a normal exit', 'q', 0],
    ['Ctrl-C', KEY.ctrlC, 0],
  ] as const)('restores after %s', async (_name, key, status) => {
    const { s } = await start();
    expectOpen(s);
    const during = s.stty();
    s.send(key);
    const exit = await s.waitForExit();
    expect(exit.status).toBe(status);
    expect(exit.sttyAfter).toBe(exit.sttyBefore);
    expect(during).not.toBe(exit.sttyBefore);
    expect(s.modes()).toEqual(INITIAL_MODES);
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const)('restores after %s', async (signal, status) => {
    const { s, pid } = await start();
    expectOpen(s);
    s.signal(signal, pid);
    const exit = await s.waitForExit();
    expect(exit.status).toBe(status);
    expect(exit.sttyAfter).toBe(exit.sttyBefore);
    expect(s.modes()).toEqual(INITIAL_MODES);
  });

  it.each([
    ['an uncaught exception', 'x', 'probe: internal error'],
    ['an unhandled rejection', 'r', 'probe: rejected'],
  ] as const)('restores after %s and reports it on the normal screen', async (_n, key, text) => {
    const { s } = await start();
    s.send(key);
    const exit = await s.waitForExit();
    expect(exit.status).toBe(1);
    expect(exit.sttyAfter).toBe(exit.sttyBefore);
    expect(s.modes()).toEqual(INITIAL_MODES);
    expect(s.screenText()).toContain(text);
  });

  it.each([
    ['an uncaught exception', 'x'],
    ['an unhandled rejection', 'r'],
  ] as const)('exits 3 after %s while a result is unknown, with the notice', async (_n, key) => {
    const { s } = await start({ PROBE_NOTICE: 'request ID: abc\n' });
    s.send(key);
    const exit = await s.waitForExit();
    expect(exit.status).toBe(3);
    expect(exit.sttyAfter).toBe(exit.sttyBefore);
    expect(s.screenText()).toContain('request ID: abc');
  });

  it('restores after a stdout write error', async () => {
    const { s } = await start();
    s.send('w');
    await new Promise((r) => setTimeout(r, 50));
    s.send('W');
    const exit = await s.waitForExit();
    expect(exit.status).toBe(1);
    expect(exit.sttyAfter).toBe(exit.sttyBefore);
    expect(s.modes()).toEqual(INITIAL_MODES);
  });

  it('re-enters the alternate screen and redraws after SIGCONT', async () => {
    const { s, pid } = await start();
    await s.waitForText('draws=1');
    s.signal('SIGSTOP', pid);
    // What a shell does on job control: the program has lost its terminal state.
    s.term.write('\x1b[?1049l\x1b[?25h\x1b[?2004l');
    await s.waitFor(() => !s.modes().alternateScreen);
    s.signal('SIGCONT', pid);
    await s.waitForText('draws=2');
    expectOpen(s);
    s.send('q');
    const exit = await s.waitForExit();
    expect(exit.status).toBe(0);
    expect(exit.sttyAfter).toBe(exit.sttyBefore);
    expect(s.modes()).toEqual(INITIAL_MODES);
  });

  it('redraws at the new size on resize', async () => {
    const { s } = await start();
    s.resize(120, 40);
    await s.waitForText('120x40');
    s.send('q');
    await s.waitForExit();
  });
});

describe('exit paths of the real interface against a real daemon', () => {
  const tui = useTui();

  it.each([
    ['q', 0, (s: PtySession) => s.send('q')],
    ['Ctrl-C', 0, (s: PtySession) => s.send(KEY.ctrlC)],
    ['SIGINT', 130, (s: PtySession, pid: number) => s.signal('SIGINT', pid)],
    ['SIGTERM', 143, (s: PtySession, pid: number) => s.signal('SIGTERM', pid)],
    ['SIGHUP', 129, (s: PtySession, pid: number) => s.signal('SIGHUP', pid)],
  ] as const)(
    'restores the terminal after %s and the task keeps running',
    async (_n, status, leave) => {
      const sd = tui.daemon();
      const [task] = sd.seed((d) => seedRunning(d, 1));
      await sd.start();
      const s = tui.cusr(sd.dataDir, { cols: 100, rows: 30 });
      await s.waitForText('Task 001');
      const pid = await s.programPid();
      expect(s.modes()).toEqual({
        alternateScreen: true,
        cursorHidden: true,
        bracketedPaste: true,
        mouseTracking: false,
      });
      const before = await sd.query('owner', { kind: 'task_show', task_id: task!.id });
      expect(before.envelope.data?.['status']).toBe('RUNNING');

      leave(s, pid);
      const exit = await s.waitForExit();
      expect(exit.status).toBe(status);
      expect(exit.sttyAfter).toBe(exit.sttyBefore);
      expect(s.modes()).toEqual(INITIAL_MODES);

      const after = await sd.query('owner', { kind: 'task_show', task_id: task!.id });
      expect(after.envelope.ok).toBe(true);
      expect(after.envelope.data?.['status']).toBe('RUNNING');
      expect(after.envelope.data?.['version']).toBe(before.envelope.data?.['version']);
    },
  );
});

// The seeded block above has no runner, so it cannot show work going on. Here a real runner holds a real
// agent (the fake vendor waits on a marker file) while the interface leaves; the same attempt must still be
// unfinished right after the exit, and finish only once the hold is released.
describe.skipIf(!hostUsable())('the task goes on after each exit of the real interface', () => {
  const tui = useTui();
  const rehearsals: Rehearsal[] = [];
  afterEach(async () => {
    for (const r of rehearsals.splice(0)) await r.cleanup();
  });
  const ofType = (events: readonly HistoryEvent[], type: string): HistoryEvent[] =>
    events.filter((e) => e.type === type);
  const attemptsOf = (events: readonly HistoryEvent[], type: string): unknown[] =>
    ofType(events, type).map((e) => e.payload['attempt_id']);

  it.each([
    ['q', 0, (s: PtySession) => s.send('q')],
    ['Ctrl-C', 0, (s: PtySession) => s.send(KEY.ctrlC)],
    ['SIGTERM', 143, (s: PtySession, pid: number) => s.signal('SIGTERM', pid)],
    ['SIGHUP', 129, (s: PtySession, pid: number) => s.signal('SIGHUP', pid)],
    ['an internal error', 1, (s: PtySession, pid: number) => s.signal('SIGUSR2', pid)],
  ] as const)(
    'restores the terminal after %s and the held agent finishes the same attempt',
    async (_n, status, leave) => {
      const r = new Rehearsal({
        kind: 'node',
        worker: 'claude',
        mode: 'direct-pr',
        coder: 'pass',
        hold: true,
      });
      rehearsals.push(r);
      await r.startDaemon();
      const id = await r.addTask();
      await expect.poll(() => r.held(), { timeout: 60_000 }).toHaveLength(1);

      const s = tui.cusr(r.dataDir, {
        cols: 100,
        rows: 30,
        env: { NODE_OPTIONS: `--import ${INJECT}` },
      });
      await s.waitFor(() => s.modes().alternateScreen && s.screenText().includes('daemon: ok'));
      const pid = await s.programPid();
      const before = await r.history(id);
      const running = attemptsOf(before, 'AttemptRequested');
      expect(running).toHaveLength(1);
      expect(attemptsOf(before, 'AttemptFinished')).toEqual([]);

      leave(s, pid);
      const exit = await s.waitForExit();
      expect(exit.status).toBe(status);
      expect(exit.sttyAfter).toBe(exit.sttyBefore);
      expect(s.modes()).toEqual(INITIAL_MODES);

      // Held through the exit: the attempt is still open and the vendor is still waiting.
      const during = await r.history(id);
      expect(attemptsOf(during, 'AttemptFinished')).toEqual([]);
      expect(ofType(during, 'TaskCancelled')).toEqual([]);
      expect(r.held()).toHaveLength(1);

      r.release();
      await r.untilMergeWait(id);
      const after = await r.history(id);
      expect(attemptsOf(after, 'AttemptFinished')).toContain(running[0]);
      expect(attemptsOf(after, 'AttemptRequested').slice(0, 1)).toEqual(running);
      expect(ofType(after, 'TaskCancelled')).toEqual([]);
    },
    180_000,
  );
});

describe('PTY harness', () => {
  it('generates the same keys from the same seed', () => {
    expect(seededKeys(7, 50)).toEqual(seededKeys(7, 50));
    expect(seededKeys(7, 50)).not.toEqual(seededKeys(8, 50));
    expect(seededKeys(7, 2000)).not.toContain(KEY.ctrlC);
  });

  it('reads the screen cell by cell', async () => {
    const s = new PtySession({ entry: PROBE, cols: 90, rows: 25 });
    try {
      await s.waitForText('probe ready');
      expect(s.cell(1, 0)).toBe('p');
      expect(s.screenText()).toContain('90x25');
      s.send('q');
      await s.waitForExit();
    } finally {
      s.dispose();
    }
  });
});
