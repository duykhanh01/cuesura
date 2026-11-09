import { describe, expect, it } from 'vitest';
import type { TaskState } from '../../../src/domain/state.ts';
import { explainRuntime, type RuntimeInput } from '../../../src/explain/explain.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { openMemoryStore } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { createAndStart } from '../../support/store-flows.ts';

const input = (now: number): RuntimeInput => ({
  now: now as EpochMs,
  recheckable: false,
  rt: null,
  queue_position: null,
  prerequisite: () => null,
  dependents: [],
  merge: null,
});

describe('explainRuntime blockers (issue #264)', () => {
  it('keeps a blocker whose end is still ahead and drops one that ended', () => {
    const d = new StoreDriver(openMemoryStore());
    const t = buildTask({ id: uuidOf(1) });
    createAndStart(d, t);
    const blocker = (until: number | null): TaskState['blockers'][number] => ({
      code: 'merge_cleanup_pending',
      source: 'drain',
      since: d.now,
      until,
    });
    const s: TaskState = {
      ...d.task(t.id),
      blockers: [blocker(null), blocker(d.now + 1_000), blocker(d.now - 1)],
    };
    expect(explainRuntime(s, d.store.readEvents(t.id), null, input(d.now)).blockers).toEqual([
      blocker(null),
      blocker(d.now + 1_000),
    ]);
  });
});
