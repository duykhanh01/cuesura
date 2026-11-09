import { describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import { taskProgress } from '../../../src/application/progress.ts';
import type { ExecutionMode } from '../../../src/domain/run-config.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-progress-');
const OWNER: Caller = {
  grant: {
    actor: 'owner',
    roles: ['read', 'operate', 'admin'],
  },
};

type Step = { name: string; state: string; visits: number };
type Progress = {
  task_id: string;
  version: number;
  mode: string | null;
  steps: Step[] | null;
  reason: string | null;
  needs_user: boolean;
  worktree_path: string | null;
};

function setup() {
  const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
  const read = (id: string, caller: Caller = OWNER): Progress => {
    const r = taskProgress(d.store, caller, {
      kind: 'task_progress',
      task_id: id,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value as Progress;
  };
  return { d, read };
}

const step = (p: Progress, name: string): Step | undefined => p.steps?.find((s) => s.name === name);

function prepared(d: StoreDriver, mode: ExecutionMode) {
  const t = buildTask();
  createGrantStart(d, t, mode);
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', {
    ...PREPARE_DATA,
    worktree_ref: '/data/worktrees/one',
    worktree_tree: 'a'.repeat(40),
  });
  return t;
}

describe('task_progress', () => {
  it('has no steps before a policy is frozen, and says why', () => {
    const { d, read } = setup();
    const t = buildTask();
    d.must(t.id, { kind: 'create_task', task: t });
    expect(read(t.id)).toEqual({
      task_id: t.id,
      version: d.task(t.id).version,
      mode: null,
      steps: null,
      reason: 'not_frozen',
      needs_user: true,
      worktree_path: null,
    });
  });

  it('walks the frozen graph: past, current and remaining, with visits', () => {
    const { d, read } = setup();
    const t = prepared(d, 'full-review');
    const p = read(t.id);
    expect(p.mode).toBe('full-review');
    expect(p.reason).toBeNull();
    expect(step(p, 'prepare')).toEqual({
      name: 'prepare',
      state: 'past',
      visits: 1,
    });
    expect(step(p, 'code')).toEqual({
      name: 'code',
      state: 'current',
      visits: 1,
    });
    expect(step(p, 'gates')).toEqual({
      name: 'gates',
      state: 'remaining',
      visits: 0,
    });
    expect(step(p, 'review')).toMatchObject({ state: 'remaining' });
    const names = p.steps?.map((s) => s.name) ?? [];
    expect(names.indexOf('code')).toBeLessThan(names.indexOf('gates'));
    expect(names.indexOf('gates')).toBeLessThan(names.indexOf('publish'));
    expect(names.indexOf('publish')).toBeLessThan(names.indexOf('pr'));
    expect(names.indexOf('pr')).toBeLessThan(names.indexOf('review'));
    expect(names.indexOf('review')).toBeLessThan(names.indexOf('ready'));
    expect(names.indexOf('ready')).toBeLessThan(names.indexOf('ci'));
    expect(new Set(names).size).toBe(names.length);
  });

  it('review of a direct-pr task is not_required, never presented as passed', () => {
    const { d, read } = setup();
    const t = prepared(d, 'direct-pr');
    const p = read(t.id);
    expect(p.mode).toBe('direct-pr');
    for (const name of ['review', 'fix_review'])
      expect(step(p, name)).toEqual({
        name,
        state: 'not_required',
        visits: 0,
      });
    const names = p.steps?.map((s) => s.name) ?? [];
    expect(names.indexOf('gates')).toBeLessThan(names.indexOf('publish'));
    expect(names.indexOf('pr')).toBeLessThan(names.indexOf('review'));
    for (const name of ['post_review', 'post_changes', 'ready'])
      expect(step(p, name)).toMatchObject({ state: 'not_required' });
  });

  it('gives the same order on every read', () => {
    const { d, read } = setup();
    const t = prepared(d, 'full-review');
    expect(read(t.id).steps).toEqual(read(t.id).steps);
  });

  it('needs_user follows the wait', () => {
    const { d, read } = setup();
    const t = prepared(d, 'direct-pr');
    expect(read(t.id).needs_user).toBe(false);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
      failure_class: 'unknown',
      message: 'the worktree changed outside the task since its last step',
      invoked: false,
      worktree: { known: 'a'.repeat(40), observed: 'b'.repeat(40) },
    });
    expect(read(t.id).needs_user).toBe(true);
  });

  it('names the worktree only while waiting on worktree_changed', () => {
    const { d, read } = setup();
    const t = prepared(d, 'direct-pr');
    expect(read(t.id).worktree_path).toBeNull();
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
      failure_class: 'unknown',
      message: 'the worktree changed outside the task since its last step',
      invoked: false,
      worktree: { known: 'a'.repeat(40), observed: 'b'.repeat(40) },
    });
    expect(d.task(t.id).wait?.detail.code).toBe('worktree_changed');
    expect(read(t.id).worktree_path).toBe('/data/worktrees/one');
  });
});
