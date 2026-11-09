import { describe, expect, it } from 'vitest';
import { openStore } from '../../../src/store/index.ts';
import { holdStore, waitExit } from '../../support/child.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

describe('Single writer (T082, R-06, I02)', () => {
  const tmp = useTempDir();

  it('a second process gets store_locked until SIGKILL releases the first writer', async () => {
    const path = dbPath(tmp());
    const holder = await holdStore(path);
    try {
      const second = openStore(path, { busyTimeoutMs: 100 });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.code).toBe('store_locked');
    } finally {
      holder.kill('SIGKILL');
      await waitExit(holder);
    }
    const after = openStore(path, { busyTimeoutMs: 100 });
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.value.verifyProjections().ok).toBe(true);
      after.value.close();
    }
  });

  it('rejects a second connection in the same process while the store is open', () => {
    const path = dbPath(tmp());
    const first = openStore(path);
    if (!first.ok) throw new Error(first.error.detail);
    const second = openStore(path, { busyTimeoutMs: 50 });
    expect(second.ok ? 'ok' : second.error.code).toBe('store_locked');
    first.value.close();
    const third = openStore(path, { busyTimeoutMs: 50 });
    expect(third.ok).toBe(true);
    if (third.ok) third.value.close();
  });
});
