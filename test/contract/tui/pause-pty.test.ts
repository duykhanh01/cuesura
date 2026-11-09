import { describe, expect, it } from 'vitest';
import { uuidOf } from '../../support/builders.ts';
import { KEY, type PtySession } from '../../support/pty.ts';
import { cliJson, seedRunning, selectedLine, useTui } from '../../support/tui-fixtures.ts';

// Issue #155 end to end at 80×24: a real daemon, `cusr` on a PTY, and the CLI to check what reached the
// daemon. Every wait is for something on the screen, bounded, never a fixed sleep (#283).
const tui = useTui();
const TASK = uuidOf(1);

/** Moves the Actions selection to `label`, waiting for each move to show. */
async function choose(s: PtySession, label: string): Promise<void> {
  for (let i = 0; i < 10 && !s.screenText().includes(`› ${label}`); i++) {
    const lines = s.screenText().split('\n');
    const at = lines.findIndex((l) => l.startsWith('›'));
    const want = lines.findIndex((l) => l.startsWith(`  ${label}`));
    const before = lines[at] ?? '';
    s.send(want >= 0 && want < at ? KEY.up : KEY.down);
    await s.waitFor(() => selectedLine(s.screenText()) !== before, 5_000);
  }
  await s.waitForText(`› ${label}`, 5_000);
}

async function explainPaused(sd: Parameters<typeof cliJson>[0]): Promise<unknown> {
  const r = await cliJson(sd, 'task', 'explain', TASK);
  return r.envelope.data?.['paused'];
}

describe('pausing and resuming from the TUI (issue #155)', () => {
  it('pauses a task with a reason, shows who paused it, and resumes it', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 1));
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 80, rows: 24 });
    await s.waitForText('Task 001');

    s.send('a');
    await s.waitForText('Pause task');
    await choose(s, 'Pause task');
    s.send(KEY.enter);
    await s.waitForText('Sent with version');
    s.send('quiet hours');
    await s.waitForText('quiet hours');
    s.send(KEY.ctrlS);
    await s.waitForText('Done (request');
    expect(await explainPaused(sd)).toMatchObject({ reason: 'quiet hours', by: 'owner' });

    // The menu reads the task again: it now offers Resume.
    await s.waitForText('Resume task');
    await choose(s, 'Resume task');
    s.send(KEY.enter);
    await s.waitForText('Ctrl-S resumes the task');
    s.send(KEY.ctrlS);
    await s.waitFor(
      () => s.screenText().includes('Pause task') && !s.screenText().includes('Resume task'),
      10_000,
    );
    // The compact explain leaves a null `paused` out.
    expect((await explainPaused(sd)) ?? null).toBeNull();
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  }, 40_000);

  it('pauses the queue from Home and resumes it', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 1));
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 80, rows: 24 });
    // At 80 columns the bar has no room for `p pause queue`; the key works all the same, as Help says.
    await s.waitForText('Task 001');

    s.send('p');
    await s.waitForText('Pause the queue');
    s.send('deploy');
    await s.waitForText('deploy');
    s.send(KEY.ctrlS);
    await s.waitForText('Queue paused: deploy');
    const status = await cliJson(sd, 'status');
    expect(status.envelope.data?.['queue_paused']).toMatchObject({ reason: 'deploy' });

    s.send('p');
    await s.waitForText('Resume the queue');
    s.send(KEY.ctrlS);
    // Back on Home, which no longer says the queue is paused.
    await s.waitFor(
      () => s.screenText().includes('Task 001') && !s.screenText().includes('Queue paused'),
      10_000,
    );
    expect((await cliJson(sd, 'status')).envelope.data?.['queue_paused'] ?? null).toBeNull();
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  }, 40_000);
});
