import { describe, expect, it } from 'vitest';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { KEY } from '../../support/pty.ts';
import { daemonSocket, reconnectAttempt, useTui } from '../../support/tui-fixtures.ts';

// T034: the whole automatic window in real time, about two minutes a round with a socket that refuses at once.
const tui = useTui();

/** 30 attempts: waits of 0.25, 0.5, 1, 2, 4 and then 5 seconds, each read failing at once, with some margin. */
const ROUND_MS = 180_000;
const QUIET_MS = 12_000;
const RETRY_BUDGET_MS = 10_000;

describe('SC-003: after the automatic attempts run out', () => {
  it('stays put with what was typed, never reconnects by itself, and has data within 10 seconds of Retry connection', async () => {
    const sd = tui.daemon();
    sd.seed((d) => {
      const t = buildTask({ id: uuidOf(1), title: 'Before the outage' });
      d.must(t.id, { kind: 'create_task', task: t });
    });
    await sd.start();
    const socket = daemonSocket(sd);
    const proxy = await tui.proxy(socket);
    const s = tui.cusr(proxy.dataDir);
    await s.waitForText('Before the outage');

    // Something being typed when the daemon goes.
    s.send('f');
    await s.waitForText('Find project:');
    s.send('half typed');
    await s.waitForText('Find project: half typed_');

    await sd.stop();
    await s.waitFor(() => reconnectAttempt(s.screenText()) === 1, 10_000);

    // Round 1 runs through all 30 attempts in order, and only then stops.
    let highest = 0;
    await s.waitFor(() => {
      highest = Math.max(highest, reconnectAttempt(s.screenText()));
      return s.screenText().includes('Retry connection (R)');
    }, ROUND_MS);
    expect(highest).toBeGreaterThanOrEqual(29);
    const stopped = s.screenText();
    expect(stopped).toContain('All 30 automatic attempts are used');
    expect(stopped).toContain('Find project: half typed_');
    expect(stopped).not.toContain('Reconnecting');
    expect(stopped.split('\n')[0]).toContain('daemon: unknown');

    // Nothing starts a new round on its own, not even with the daemon back.
    const beforeDaemon = proxy.connections;
    await new Promise((r) => setTimeout(r, QUIET_MS));
    expect(proxy.connections).toBe(beforeDaemon);

    sd.seed((d) => {
      const t = buildTask({ id: uuidOf(2), title: 'Made during the outage' });
      d.must(t.id, { kind: 'create_task', task: t });
    });
    await sd.start();
    expect(daemonSocket(sd)).toBe(socket);
    const beforeWait = proxy.connections;
    await new Promise((r) => setTimeout(r, QUIET_MS));
    expect(proxy.connections).toBe(beforeWait);
    expect(s.screenText()).toContain('Retry connection (R)');
    expect(s.screenText()).toContain('Find project: half typed_');

    // In the text field `R` is text; the screen says how to reach the retry, and what was typed stays.
    expect(s.screenText()).toContain('Press Tab to leave the text field');
    s.send(KEY.tab);
    await s.waitForText('R retry connection');
    s.send('R');
    const retriedAt = Date.now();
    await s.waitFor(() => !s.screenText().includes('Data may be out of date'), RETRY_BUDGET_MS);
    expect(s.screenText().split('\n')[0]).toContain('daemon: ok');
    expect(s.screenText()).toContain('Find project: half typed');

    // The data of that same read, on Home, still inside the budget. Leaving the form applied nothing.
    s.send(KEY.esc);
    await s.waitForText('Made during the outage', RETRY_BUDGET_MS);
    expect(Date.now() - retriedAt).toBeLessThan(RETRY_BUDGET_MS);
    expect(s.screenText()).toContain('Filters: project all · status all');

    // A second loss: `R` starts a new round with the same limit, from 1.
    await sd.stop();
    await s.waitFor(() => reconnectAttempt(s.screenText()) >= 1, 10_000);
    await s.waitForText('Retry connection (R)', ROUND_MS);
    s.send('R');
    await s.waitFor(() => {
      const n = reconnectAttempt(s.screenText());
      return n >= 1 && n <= 3;
    }, 10_000);
    await s.waitForText('Retry connection (R)', ROUND_MS);
    expect(s.screenText()).not.toContain('Reconnecting');
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });
});
