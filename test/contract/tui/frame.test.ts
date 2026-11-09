import { afterEach, describe, expect, it } from 'vitest';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import { KEY, PtySession } from '../../support/pty.ts';
import { useTempDir } from '../../support/temp-db.ts';

// Checkpoint A: `cusr` opens the frame on a real PTY against a real daemon, and leaves the terminal clean.
const tempDir = useTempDir('cusr-frame-');

const INITIAL = {
  alternateScreen: false,
  cursorHidden: false,
  bracketedPaste: false,
  mouseTracking: false,
};
const OPEN = {
  ...INITIAL,
  alternateScreen: true,
  cursorHidden: true,
  bracketedPaste: true,
};

const live: { daemons: SeededDaemon[]; sessions: PtySession[] } = {
  daemons: [],
  sessions: [],
};
afterEach(async () => {
  for (const s of live.sessions.splice(0)) s.dispose();
  for (const d of live.daemons.splice(0)) await d.cleanup();
});

async function daemon(tasks = 2): Promise<SeededDaemon> {
  const sd = new SeededDaemon();
  live.daemons.push(sd);
  sd.seed((d) => {
    for (let i = 0; i < tasks; i++) {
      const t = buildTask({ id: uuidOf(i + 1) });
      d.must(t.id, { kind: 'create_task', task: t });
    }
  });
  await sd.start();
  return sd;
}

function cusr(
  dataDir: string,
  o: { cols?: number; rows?: number; env?: Record<string, string> } = {},
): PtySession {
  const s = new PtySession({
    cols: o.cols ?? 100,
    rows: o.rows ?? 30,
    env: { CUSR_DATA_DIR: dataDir, CUSR_ACTOR: undefined, ...o.env },
  });
  live.sessions.push(s);
  return s;
}

describe('cusr at a terminal', () => {
  it('opens with data from the daemon and quits clean', async () => {
    const sd = await daemon();
    const s = cusr(sd.dataDir);
    await s.waitForText('▲ 2 need you');
    expect(s.modes()).toEqual(OPEN);
    // The wheel works, and the mouse stays the terminal's: selecting and copying are left alone.
    expect(s.rawOutput()).toContain('\x1b[?1007h');
    const top = s.screenText().split('\n')[0];
    expect(top).toContain('daemon: ok');
    expect(top).toContain('slot: free');
    expect(top).toContain('queue: 0');
    expect(top).toContain('project: all');
    expect(s.screenText()).toContain('q quit');
    s.send('q');
    const exit = await s.waitForExit();
    expect(exit.status).toBe(0);
    expect(exit.sttyAfter).toBe(exit.sttyBefore);
    expect(s.modes()).toEqual(INITIAL);
  });

  it.each([
    ['coming back to the window', '\x1b[I'],
    ['Ctrl-L', '\x0c'],
  ])('%s draws again what the terminal lost', async (_, input) => {
    const sd = await daemon();
    const s = cusr(sd.dataDir);
    await s.waitForText('q quit');
    expect(s.rawOutput()).toContain('\x1b[?1004h');

    s.term.write('\x1b[2J');
    await s.waitFor(() => !s.screenText().includes('q quit'));
    s.send(input);
    await s.waitForText('q quit');

    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
    expect(s.rawOutput()).toContain('\x1b[?1004l');
  });

  it('Ctrl-C quits clean and the daemon keeps going', async () => {
    const sd = await daemon();
    const s = cusr(sd.dataDir);
    await s.waitForText('Time');
    s.send(KEY.ctrlC);
    const exit = await s.waitForExit();
    expect(exit.status).toBe(0);
    expect(exit.sttyAfter).toBe(exit.sttyBefore);
    expect((await sd.query('owner', { kind: 'task_list' })).envelope.ok).toBe(true);
  });

  it('opens without a daemon, says so, and still quits', async () => {
    const sd = await daemon();
    await sd.stop();
    const s = cusr(sd.dataDir);
    await s.waitForText('Reconnecting (');
    expect(s.screenText()).toContain('last updated never');
    expect(s.modes()).toEqual(OPEN);
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('opens with no data dir at all and keeps trying, as for a daemon not started yet', async () => {
    const s = cusr(`${tempDir()}/nothing`);
    await s.waitForText('Reconnecting (');
    expect(s.screenText()).not.toContain('Stopped:');
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('marks data stale when the daemon dies, stays open, and recovers with no key', async () => {
    const sd = await daemon();
    const s = cusr(sd.dataDir);
    await s.waitForText('▲ 2 need you');
    await sd.stop();
    await s.waitForText('Data may be out of date');
    expect(s.screenText()).toContain('Reconnecting (');
    expect(s.screenText()).toContain('▲ 2 need you');
    expect(s.modes()).toEqual(OPEN);
    await sd.start();
    await s.waitFor(() => !s.screenText().includes('Data may be out of date'), 15_000);
    expect(s.screenText()).toContain('▲ 2 need you');
    s.send('q');
    await s.waitForExit();
  });

  it('shows a change with no key pressed', async () => {
    const sd = await daemon(1);
    const s = cusr(sd.dataDir);
    await s.waitForText('▲ 1 need you');
    await sd.command('owner', {
      request_id: uuidOf(500),
      kind: 'task_add',
      project: 'acme',
      task_id: null,
      expected_version: null,
      payload: {
        task: { title: 'Another', base_branch: 'main', acceptance: ['a'] },
      },
    });
    await s.waitForText('▲ 2 need you', 3_000);
    s.send('q');
    await s.waitForExit();
  });

  it('an unknown CUSR_ACTOR stops at once and says so', async () => {
    const sd = await daemon();
    const s = cusr(sd.dataDir, { env: { CUSR_ACTOR: 'nobody' } });
    await s.waitForText('Stopped:');
    expect(s.screenText()).not.toContain('Reconnecting');
    s.send('q');
    await s.waitForExit();
  });

  it('under 80x24 asks for more room, still quits, and comes back when resized', async () => {
    const sd = await daemon();
    const s = cusr(sd.dataDir, { cols: 60, rows: 20 });
    await s.waitForText('Resize your terminal');
    expect(s.screenText()).toContain('60×20');
    expect(s.screenText()).toContain('q quit');
    s.resize(100, 30);
    await s.waitForText('▲ 2 need you');
    s.resize(70, 24);
    await s.waitForText('70×24');
    s.resize(80, 24);
    await s.waitForText('daemon: ok');
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('? opens help and Esc returns on its own, without waiting for another key', async () => {
    const sd = await daemon();
    const s = cusr(sd.dataDir);
    await s.waitForText('Time');
    s.send('?');
    await s.waitForText('Ctrl-C');
    expect(s.screenText()).toContain('Esc back');
    s.send(KEY.esc);
    await s.waitForText('Time');
    s.send('q');
    await s.waitForExit();
  });

  it('NO_COLOR writes no colour; marks that are not colour stay', async () => {
    const sd = await daemon();
    await sd.stop();
    const s = cusr(sd.dataDir, { env: { NO_COLOR: '1' } });
    await s.waitForText('Reconnecting (');
    expect(s.rawOutput()).not.toMatch(/\x1b\[[0-9;]*3[1-6]m/); // eslint-disable-line no-control-regex
    s.send('q');
    await s.waitForExit();
  });

  it('colour is used otherwise', async () => {
    const sd = await daemon();
    await sd.stop();
    const s = cusr(sd.dataDir, { env: { NO_COLOR: undefined as never } });
    await s.waitForText('Reconnecting (');
    expect(s.rawOutput()).toMatch(/\x1b\[[0-9;]*33m/); // eslint-disable-line no-control-regex
    s.send('q');
    await s.waitForExit();
  });

  it('a task title never reaches this frame unsanitized', async () => {
    const sd = await daemon(0);
    const t = buildTask({ id: uuidOf(9), title: '\x1b[2Jevil' });
    await sd.stop();
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    const s = cusr(sd.dataDir);
    await s.waitForText('▲ 1 need you');
    expect(s.rawOutput()).not.toContain('\x1b[2Jevil');
    s.send('q');
    await s.waitForExit();
  });
});
