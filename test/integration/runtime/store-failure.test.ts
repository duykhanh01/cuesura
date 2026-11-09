/**
 * T092 store failure latch on a real daemon, SQLite file and control socket (FR-006/022/023). A handler
 * failing on a full disk or a refused store write latches dispatch: health answers 503 with the reason,
 * new commands are refused before anything is admitted, recovery neither ingests nor acknowledges, the
 * effect stays `started` for restart and a second writer is still refused. Restart starts clean.
 */
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { callDaemon } from '../../../src/cli/client.ts';
import { STORE_FILE, startDaemon } from '../../../src/daemon/main.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { openFileStoreForTest, storeDb } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-store-failure-');

function enospc(): Error {
  return Object.assign(new Error('ENOSPC: no space left on device'), {
    code: 'ENOSPC',
  });
}

describe('store failure latch (T092, FR-023)', () => {
  it('latches on a full disk: health 503, commands refused, nothing ingested or claimed until restart', async () => {
    const dir = tempDir();
    const d = new StoreDriver(openFileStoreForTest(join(dir, STORE_FILE)));
    const t = buildTask({ id: uuidOf(1) });
    createGrantStart(d, t);
    const prepare = d.pendingOne(t.id, 'prepare');
    d.store.close();

    const base = {
      dataDir: dir,
      clock: { now: () => d.now as EpochMs, monotonic: () => 0 },
      newId: uuidv7,
      dispatchIntervalMs: 60_000,
      inspectUnit: (id: string) =>
        Promise.resolve({
          unit: `cusr-op-${id}.service`,
          state: 'not_found' as const,
          invocation_id: null,
          cgroup: null,
        }),
      probeLock: () => 'free' as const,
    };
    const logs: string[] = [];
    let calls = 0;
    const started = await startDaemon({
      ...base,
      log: (m) => logs.push(m),
      effects: { prepare: () => (calls++, Promise.reject(enospc())) },
    });
    if (!started.ok) throw new Error(started.error.detail);
    const daemon = started.value;
    try {
      await daemon.dispatcher.settle();
      expect(calls).toBe(1);
      expect(daemon.dispatcher.latchedReason).toBe('filesystem write failed: ENOSPC');
      expect(logs.some((l) => l.includes('dispatch store_latched'))).toBe(true);

      const health = await callDaemon({
        socketPath: daemon.socketPath,
        actor: 'owner',
        method: 'GET',
        path: '/v1/health',
      });
      expect(health.ok && health.value.status).toBe(503);
      expect(health.ok && health.value.envelope).toMatchObject({
        ok: false,
        error: {
          code: 'unhealthy',
          message: 'store unwritable: filesystem write failed: ENOSPC',
          details: {
            store: {
              writable: false,
              failure: 'filesystem write failed: ENOSPC',
            },
          },
        },
      });

      const ledger = (): number =>
        (
          storeDb(daemon.store).prepare('SELECT COUNT(*) AS n FROM command_ledger').get() as {
            n: number;
          }
        ).n;
      const before = ledger();
      const command = await callDaemon({
        socketPath: daemon.socketPath,
        actor: 'owner',
        method: 'POST',
        path: '/v1/command',
        body: {
          request_id: '11111111-1111-4111-8111-111111111111',
          kind: 'task_cancel',
          project: 'p1',
          task_id: t.id,
          expected_version: 3,
          payload: { reason: 'disk full' },
        },
      });
      expect(command.ok && command.value.status).toBe(503);
      expect(command.ok && command.value.envelope).toMatchObject({
        ok: false,
        error: { code: 'store_unwritable' },
      });
      expect(ledger()).toBe(before);

      // Recovery takes no facts while latched: nothing reaches the store, nothing is acknowledged.
      const accept = daemon.store.accept.bind(daemon.store);
      let accepted = 0;
      daemon.store.accept = (e) => (accepted++, accept(e));
      await daemon.recover();
      expect(accepted).toBe(0);
      expect(daemon.dispatcher.tick()).toEqual({ started: [], skipped: [] });
      expect(daemon.store.readTask(t.id)?.effects[prepare.id]?.status).toBe('started');

      const second = await startDaemon({ ...base });
      expect(second.ok ? null : second.error.code).toBe('store_locked');
    } finally {
      await daemon.stop();
    }

    const again = await startDaemon({ ...base });
    if (!again.ok) throw new Error(again.error.detail);
    try {
      expect(again.value.dispatcher.latchedReason).toBeNull();
      // The claim the latched daemon left is resolved by startup recovery, never guessed.
      expect(again.value.startup.operations).toHaveLength(1);
    } finally {
      await again.value.stop();
    }
  });
});
