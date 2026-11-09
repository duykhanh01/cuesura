import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PtySession, seededKeys, KEY } from '../../support/pty.ts';

// The terminal half of SC-011: every exit path returns the terminal to its initial state.
const PROBE = fileURLToPath(new URL('../../fixtures/tui/terminal-probe.ts', import.meta.url));

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
