import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { replayGoal } from '../../../src/engine/goal/evolve.ts';
import { STORE_FILE } from '../../../src/daemon/main.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { useTempDir } from '../../support/temp-db.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import {
  confirmedGoal,
  goalCommand,
  goalPlan,
  goalRequestId,
  planUnit,
  resultOf,
} from '../../support/goal.ts';

// 007 T055, R-21: goal commands go through accept with request ID and expected version; the goal
// stream folds into `goals` and `goal_tasks`, and replaying it gives the stored state.

const tempDir = useTempDir('cusr-goal-');
const live: SeededDaemon[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((d) => d.cleanup()));
});

async function daemon(): Promise<SeededDaemon> {
  const sd = new SeededDaemon();
  live.push(sd);
  await sd.start();
  return sd;
}

describe('goal aggregate', () => {
  it('folds the goal stream into the projection, and replay gives the same state', async () => {
    const sd = await daemon();
    const g = await confirmedGoal(
      sd,
      goalPlan([planUnit('a'), planUnit('b', { depends_on: ['a'] })]),
    );
    expect(g.status).toBe('running');
    expect(Object.keys(g.units).sort()).toEqual(['a', 'b']);
    await sd.stop();

    const store = openFileStoreForTest(join(sd.dataDir, STORE_FILE));
    try {
      const stored = store.goals.read(g.goal_id);
      expect(replayGoal(g.goal_id, store.goals.events(g.goal_id))).toEqual(stored);
      expect(store.goals.events(g.goal_id).map((e) => e.type)).toEqual([
        'GoalAdded',
        'PlanProposed',
        'PlanConfirmed',
      ]);
      expect(
        store.goals
          .tasks(g.goal_id)
          .map((r) => [r.unit_key, r.role])
          .sort(),
      ).toEqual([
        ['a', 'unit'],
        ['b', 'unit'],
      ]);
      // Goal events stay out of every task read.
      expect(store.readTask(g.goal_id as never)).toBeNull();
      expect(store.verifyProjections().ok).toBe(true);
    } finally {
      store.close();
    }
    const db = new Database(join(sd.dataDir, STORE_FILE), { readonly: true });
    try {
      const streams = db
        .prepare('SELECT DISTINCT stream FROM events WHERE task_id = ?')
        .all(g.goal_id) as { stream: string }[];
      expect(streams).toEqual([{ stream: 'goal' }]);
    } finally {
      db.close();
    }
  });

  it('replays the same request and refuses a stale version', async () => {
    const sd = await daemon();
    const added = resultOf(
      await goalCommand(sd, 'goal_add', null, null, { request: 'r', base_branch: 'main' }),
    );
    const rid = goalRequestId();
    const first = await goalCommand(
      sd,
      'goal_note',
      added.goal_id,
      added.version,
      { text: 'keep JSON' },
      { requestId: rid },
    );
    const again = await goalCommand(
      sd,
      'goal_note',
      added.goal_id,
      added.version,
      { text: 'keep JSON' },
      { requestId: rid },
    );
    expect(resultOf(again)).toEqual(resultOf(first));
    const stale = await goalCommand(sd, 'goal_note', added.goal_id, added.version, {
      text: 'other',
    });
    expect(stale.envelope.ok).toBe(false);
    expect(stale.envelope.error?.['code']).toBe('conflict');
    expect(resultOf(first).version).toBe(added.version + 1);
  });

  it('confirms a plan only by its current hash', async () => {
    const sd = await daemon();
    const added = resultOf(
      await goalCommand(sd, 'goal_add', null, null, { request: 'r', base_branch: 'main' }),
    );
    const p = resultOf(
      await goalCommand(sd, 'goal_propose', added.goal_id, added.version, {
        plan: goalPlan([planUnit('a')]),
        plan_version: 0,
      }),
    );
    const wrong = await goalCommand(sd, 'goal_confirm', added.goal_id, p.version, {
      plan_hash: `sha256:${'0'.repeat(64)}`,
    });
    expect(wrong.envelope.error?.['code']).toBe('conflict');
    expect((wrong.envelope.error?.['details'] as { current?: string }).current).toBe(p.plan_hash);
  });

  it('answers a request run again after a crash with its first result, though its time differs', () => {
    // The handler reads the clock and draws task IDs again when the ledger row was left admitted.
    const store = openFileStoreForTest(join(tempDir(), 'cusr.sqlite'));
    try {
      const goalId = '0192aaaa-0000-7000-8000-0000000000a1';
      const add = (now: number) =>
        store.goals.accept({
          goal_id: goalId,
          dedup_key: 'cmd:r1:goal',
          now,
          actor: 'owner',
          trigger: { kind: 'add', project: 'acme', base_branch: 'main', request: 'r', hints: {} },
        });
      const first = add(1);
      const again = add(2);
      expect(first.ok && again.ok).toBe(true);
      if (!first.ok || !again.ok) return;
      expect(again.value).toEqual({ ...first.value, duplicate: true });
      expect(store.goals.events(goalId)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('creates the task of a unit keyed like an inherited property', async () => {
    const sd = await daemon();
    const g = await confirmedGoal(sd, goalPlan([planUnit('constructor'), planUnit('tostring')]));
    expect(Object.keys(g.units).sort()).toEqual(['constructor', 'tostring']);
    expect(typeof g.units['constructor']?.task_id).toBe('string');
    expect(g.units['constructor']?.status).not.toBeNull();
  });
});
