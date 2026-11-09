import { describe, expect, it } from 'vitest';
import { buildTask, uuidOf } from '../../support/builders.ts';
import type { SeededDaemon } from '../../support/daemon-task.ts';
import type { PtySession } from '../../support/pty.ts';
import { cancelTask, seedRunning, useTui } from '../../support/tui-fixtures.ts';

// Wall-clock acceptance measurements: run explicitly with pnpm test:performance.
const tui = useTui();
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

async function quit(s: PtySession): Promise<void> {
  s.send('q');
  expect((await s.waitForExit()).status).toBe(0);
}

describe('US1 scenario 4 and SC-003: a change shows by itself', () => {
  // 20 is the fewest samples where one late change still leaves 95%. A late one is measured, not a failure by itself.
  it('shows at least 95% of 20 status changes within 3 seconds, with no key pressed', async () => {
    const SAMPLES = 20;
    const sd = tui.daemon();
    const ids = seedReady(sd, SAMPLES);
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await s.waitForText(`Tasks: READY ${SAMPLES}`);
    const tookMs: number[] = [];
    for (const [i, id] of ids.entries()) {
      const r = await cancelTask(sd, id, i);
      expect(r.envelope.ok).toBe(true);
      const changedAt = Date.now();
      await s.waitForText(`CANCELLED ${i + 1}`, 10_000);
      tookMs.push(Date.now() - changedAt);
      await s.waitForText(`Finished (${i + 1})`);
      expect(s.screenText()).not.toContain(`Ready ${String(i + 1).padStart(2, '0')}`);
    }
    const inTime = tookMs.filter((ms) => ms < 3_000).length;
    expect(inTime, `took ${tookMs.join(', ')} ms`).toBeGreaterThanOrEqual(
      Math.ceil(SAMPLES * 0.95),
    );
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });
});

describe('SC-002: 100 tasks', () => {
  it('has data on the main screen within 2 seconds, and the board reads inside its timeout', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 100));
    await sd.start();
    const startedAt = Date.now();
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('Tasks: RUNNING 100', 2_000);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await quit(s);

    // A daemon just started has to read every task's log for `status_since`: the slowest this read gets.
    await sd.stop();
    await sd.start();
    const readAt = Date.now();
    const r = await sd.query('owner', { kind: 'task_board', limit: 100 });
    const tookMs = Date.now() - readAt;
    expect(r.envelope.ok).toBe(true);
    expect(tookMs).toBeLessThan(2_000);
  });
});
