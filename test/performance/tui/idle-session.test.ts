import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STORE_FILE } from '../../../src/daemon/main.ts';
import { openFileStoreForTest, storeDb } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import type { SeededDaemon } from '../../support/daemon-task.ts';
import { daemonSocket, useTui } from '../../support/tui-fixtures.ts';

// T033: an early check on an idle session, on a real PTY and a real daemon, through a proxy that sees every
// byte. Thirty seconds says nothing about an hour: this does not claim SC-009.
const tui = useTui();

const IDLE_MS = 30_000;
/** One round a second, and the session's first reads. */
const MOST_BOARD_READS = IDLE_MS / 1_000 + 3;

function countRows(sd: SeededDaemon): {
  events: number;
  commands: number;
  effects: number;
} {
  const store = openFileStoreForTest(join(sd.dataDir, STORE_FILE));
  try {
    const db = storeDb(store);
    const count = (table: string): number =>
      (
        db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n;
    return {
      events: count('events'),
      commands: count('command_ledger'),
      effects: count('effects'),
    };
  } finally {
    store.close();
  }
}

describe('T033: an idle session', () => {
  it('for 30 seconds makes 0 events and 0 commands, holds no slot, and is answered `unchanged`', async () => {
    const sd = tui.daemon();
    sd.seed((d) => {
      const t = buildTask({ id: uuidOf(1), title: 'Sitting here' });
      d.must(t.id, { kind: 'create_task', task: t });
    });
    const before = countRows(sd);
    await sd.start();

    const proxy = await tui.proxy(daemonSocket(sd));
    const requests: string[] = [];
    const responses: string[] = [];
    proxy.tap = (direction, data) =>
      (direction === 'request' ? requests : responses).push(data.toString('utf8'));

    const s = tui.cusr(proxy.dataDir);
    await s.waitForText('Sitting here');
    await new Promise((r) => setTimeout(r, IDLE_MS));

    expect(s.screenText()).toContain('Sitting here');
    expect(s.screenText()).not.toContain('Data may be out of date');
    const slot = await sd.query('owner', { kind: 'task_board' });
    expect(slot.envelope.data?.['queue']).toEqual({ length: 0 });
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);

    const boardReads = requests.filter((r) => r.includes('"task_board"'));
    const asksWatermark = boardReads.filter((r) => r.includes('"if_changed_since"'));
    const unchanged = responses.filter((r) => r.includes('"unchanged":true'));

    // Only the first read brings data; each one after it asks "anything new?" and hears "no".
    expect(boardReads.length).toBeGreaterThanOrEqual(IDLE_MS / 1_000 - 5);
    expect(boardReads.length).toBeLessThanOrEqual(MOST_BOARD_READS);
    expect(asksWatermark.length).toBe(boardReads.length - 1);
    expect(unchanged.length).toBe(asksWatermark.length);

    // The client sent no command, and the board and health are all it polled.
    expect(requests.filter((r) => r.includes('/v1/command'))).toEqual([]);
    expect(requests.filter((r) => r.includes('"project_list"'))).toHaveLength(1);

    await sd.stop();
    expect(countRows(sd)).toEqual(before);
    // No slot was taken, and none was ever asked for.
    const store = openFileStoreForTest(join(sd.dataDir, STORE_FILE));
    try {
      expect(store.readSlots()).toEqual([]);
    } finally {
      store.close();
    }
  }, 60_000);
});
