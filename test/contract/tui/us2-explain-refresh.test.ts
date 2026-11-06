import { describe, expect, it } from 'vitest';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { createGrantStart, proposeAndConfirm, selectionFor } from '../../support/runtime.ts';
import {
  cancelTask,
  cliJson,
  daemonSocket,
  flat,
  openTask,
  technicalInfo,
  useTui,
  leaveTask,
} from '../../support/tui-fixtures.ts';
import type { SeededDaemon } from '../../support/daemon-task.ts';

// T041: what `task_explain` says can change while the version of the open task stands still: the queue, a
// prerequisite and the time. R-03: the watermark catches the first two, a read every 5 seconds the third.
const tui = useTui();
const TALL = { cols: 170, rows: 80 } as const;

const versionOf = async (sd: SeededDaemon, id: string): Promise<number> =>
  (await cliJson(sd, 'task', 'show', id)).envelope.data?.['version'] as number;

describe('T041: reading `task_explain` again while the version stands still', () => {
  it('shows the new queue position when a task ahead leaves the queue', async () => {
    const sd = tui.daemon();
    const holder = buildTask({ id: uuidOf(1), title: 'Holder' });
    const first = buildTask({ id: uuidOf(2), title: 'First in line' });
    const second = buildTask({ id: uuidOf(3), title: 'Second in line' });
    sd.seed((d) => {
      createGrantStart(d, holder);
      for (const t of [first, second]) {
        d.must(t.id, { kind: 'create_task', task: t });
        proposeAndConfirm(d, t, selectionFor(t, 'full-review'));
        d.must(t.id, { kind: 'request_execution' });
      }
    });
    await sd.start();
    const s = tui.cusr(sd.dataDir, TALL);
    await openTask(s, 'Second in line');
    await s.waitFor(() => flat(s.screenText()).includes('Queue position 2'));
    const version = await versionOf(sd, second.id);

    await cancelTask(sd, first.id, 1);
    // Sooner than the 5-second read: the watermark moved.
    const from = Date.now();
    await s.waitFor(() => flat(s.screenText()).includes('Queue position 1'), 4_500);
    expect(Date.now() - from).toBeLessThan(4_500);
    expect(await versionOf(sd, second.id)).toBe(version);
    s.send('q');
    await s.waitForExit();
  });

  it('shows a prerequisite that has finished', async () => {
    const sd = tui.daemon();
    const pre = buildTask({ id: uuidOf(1), title: 'Prerequisite' });
    const dep = buildTask({
      id: uuidOf(2),
      title: 'Dependent',
      depends_on: [pre.id],
    });
    sd.seed((d) => {
      d.must(pre.id, { kind: 'create_task', task: pre });
      d.must(dep.id, { kind: 'create_task', task: dep });
    });
    await sd.start();
    const s = tui.cusr(sd.dataDir, TALL);
    await openTask(s, 'Dependent');
    await technicalInfo(s);
    await s.waitFor(() => /Prerequisite [0-9a-f-]+ · (READY|PENDING)/.test(flat(s.screenText())));
    const version = await versionOf(sd, dep.id);

    await cancelTask(sd, pre.id, 2);
    await s.waitFor(() => flat(s.screenText()).includes(`${pre.id} · CANCELLED`), 4_500);
    expect(await versionOf(sd, dep.id)).toBe(version);
    s.send('q');
    await s.waitForExit();
  });

  it('brings what depends on time within 5 seconds, with no event at all, and says when it was read', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Timed task' });
    sd.seed((d) => createGrantStart(d, t));
    await sd.start();
    const s = tui.cusr(sd.dataDir, TALL);
    await openTask(s, 'Timed task');
    await s.waitFor(() => flat(s.screenText()).includes('Time left 1h 0m 0s'));
    await technicalInfo(s);
    await s.waitFor(() => /Read at\s+\d\d:\d\d:\d\d/.test(s.screenText()));
    const readAt = (): string => /Read at\s+(\d\d:\d\d:\d\d)/.exec(s.screenText())?.[1] ?? '';
    const first = readAt();
    const version = await versionOf(sd, t.id);

    // The daemon's clock moves on; nothing happens to any task.
    sd.now += 600_000;
    const from = Date.now();
    // 5 seconds, and half a second for the answer to reach the screen and this test.
    await s.waitFor(() => flat(s.screenText()).includes('Time left 50m 0s'), 5_500);
    expect(Date.now() - from).toBeLessThan(5_500);
    expect(readAt()).not.toBe(first);
    expect(await versionOf(sd, t.id)).toBe(version);
    s.send('q');
    await s.waitForExit();
  });

  it('never counts down by itself: between reads the time stays what the daemon said', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Timed task' });
    sd.seed((d) => createGrantStart(d, t));
    await sd.start();
    const s = tui.cusr(sd.dataDir, TALL);
    await openTask(s, 'Timed task');
    await s.waitFor(() => flat(s.screenText()).includes('Time left 1h 0m 0s'));
    // The daemon's clock stands still here, so any change on screen would be the client's own counting.
    await new Promise((r) => setTimeout(r, 6_000));
    expect(flat(s.screenText())).toContain('Time left 1h 0m 0s');
    s.send('q');
    await s.waitForExit();
  });

  it('reads `task_explain` at least every 5 seconds, `task_show` and `task_progress` only when the version moves', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Watched' });
    const other = buildTask({ id: uuidOf(2), title: 'Other' });
    sd.seed((d) => {
      d.must(t.id, { kind: 'create_task', task: t });
      d.must(other.id, { kind: 'create_task', task: other });
    });
    await sd.start();
    const proxy = await tui.proxy(daemonSocket(sd));
    const requests: string[] = [];
    proxy.tap = (direction, data) => {
      if (direction === 'request') requests.push(data.toString('utf8'));
    };
    const s = tui.cusr(proxy.dataDir, TALL);
    await openTask(s, 'Watched');
    const count = (kind: string): number => requests.filter((r) => r.includes(`"${kind}"`)).length;
    await s.waitFor(() => count('task_show') === 1 && count('task_progress') === 1);

    const explainsBefore = count('task_explain');
    // One automatic refresh proves the PTY wiring. Exact intervals and repeated
    // refreshes are covered by unit/tui/screen-reads.test.ts with a controlled clock.
    await s.waitFor(() => count('task_explain') > explainsBefore, 5_500);
    expect(count('task_show')).toBe(1);
    expect(count('task_progress')).toBe(1);

    // Another task's event moves the watermark, so the explanation is read, but this version did not move.
    await cancelTask(sd, other.id, 3);
    const after = count('task_explain');
    await s.waitFor(() => count('task_explain') > after, 2_500);
    await new Promise((r) => setTimeout(r, 500));
    expect(count('task_show')).toBe(1);

    // Its own event moves the version: show and progress follow.
    await cancelTask(sd, t.id, 4);
    await s.waitFor(() => count('task_show') === 2 && count('task_progress') === 2, 4_000);
    await s.waitFor(() => flat(s.screenText()).includes('CANCELLED ·'));

    // Back on Home, this screen reads nothing any more (R-03).
    await leaveTask(s);
    await s.waitForText('Finished (2)');
    await new Promise((r) => setTimeout(r, 200));
    const left = count('task_explain');
    await new Promise((r) => setTimeout(r, 6_000));
    expect(count('task_explain')).toBe(left);
    s.send('q');
    await s.waitForExit();
  });
});
