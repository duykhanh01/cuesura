import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import { goalShow } from '../../../src/application/goals.ts';
import { taskExplain } from '../../../src/application/queries.ts';
import { conflictRound } from '../../../src/daemon/conflicts.ts';
import type { GoalTrigger } from '../../../src/domain/goal.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import { injectEvents, openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { goalPlan, planUnit } from '../../support/goal.ts';
import { gitSandbox } from '../../support/git-repo.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// 007 US4, T083 (FR-092, R-25): after a checkpoint the daemon runs `git merge-tree` between the task's
// branch and every live task of the project whose changed files overlap it, and keeps the real conflicts
// in `branch_conflicts`. Only information: no event, no version, no task waits for it.

const g = gitSandbox('cusr-branch-conflicts-');
afterAll(() => g.cleanup());
const tempDir = useTempDir('cusr-branch-conflicts-db-');

const LINES = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
const OWNER: Caller = {
  grant: { actor: 'owner', roles: ['read', 'operate', 'admin'] },
} as unknown as Caller;

/** A branch from the base that rewrites lines of `report.ts`; returns its commit and tree. */
function branch(repo: string, name: string, edits: Record<number, string>) {
  g.sh(repo, 'checkout', '-q', '-B', name, 'base');
  const lines = [...LINES];
  for (const [i, text] of Object.entries(edits)) lines[Number(i)] = text;
  writeFileSync(join(repo, 'report.ts'), lines.join('\n') + '\n');
  g.sh(repo, 'commit', '-q', '-am', name);
  return { sha: g.sh(repo, 'rev-parse', 'HEAD'), tree: g.sh(repo, 'rev-parse', 'HEAD^{tree}') };
}

function setup() {
  const repo = g.repo(`acme-${Math.random().toString(16).slice(2, 8)}`, {
    'report.ts': LINES.join('\n') + '\n',
  });
  g.sh(repo, 'branch', 'base');
  // The base as the daemon last fetched it.
  g.sh(repo, 'update-ref', 'refs/remotes/origin/main', 'base');
  const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
  const round = conflictRound({
    store: d.store,
    git: g.runner(),
    projectPath: () => Promise.resolve(repo),
    now: () => d.now,
  });
  return { repo, d, round };
}

/** A live task whose gates passed on `head`: it has a checkpoint and nothing else. */
function checkpointed(
  d: StoreDriver,
  repo: string,
  n: number,
  head: { sha: string; tree: string },
  over: Partial<CanonicalTask> = {},
): string {
  const t = buildTask({ id: uuidOf(n), source_key: `cli:${n}`, ...over });
  d.must(t.id, { kind: 'create_task', task: t });
  checkpoint(d, repo, t.id, head);
  return t.id;
}

function checkpoint(d: StoreDriver, repo: string, id: string, head: { sha: string; tree: string }) {
  injectEvents(d.store, id, [
    {
      type: 'CheckpointRecorded',
      revision: 1,
      actor: 'system',
      payload: {
        checkpoint: {
          revision: 1,
          sha: head.sha,
          tree: head.tree,
          base_sha: g.sh(repo, 'rev-parse', 'base'),
          diff_digest: `sha256:${'0'.repeat(64)}`,
          content_digest: `sha256:${'0'.repeat(64)}`,
          committed: true,
          gate_visit: 1,
        },
      },
    },
  ]);
}

const others = (d: StoreDriver, id: string) =>
  d.store.conflicts.of(id).map((c) => ({ other: c.other_task_id, files: c.files }));

describe('branch_conflicts (FR-092)', () => {
  it('records a real conflict, not a shared file that merges cleanly, and makes nobody wait', async () => {
    const { repo, d, round } = setup();
    const one = checkpointed(d, repo, 1, branch(repo, 't1', { 0: 'one' }));
    const two = checkpointed(d, repo, 2, branch(repo, 't2', { 0: 'two' }));
    // Same file as both, far from their change: Git merges it cleanly.
    const three = checkpointed(d, repo, 3, branch(repo, 't3', { 39: 'three' }));
    const before = [one, two, three].map((id) => ({
      version: d.task(id).version,
      status: d.task(id).status,
      wait: d.task(id).wait,
      events: d.store.readEvents(id as Uuid).length,
    }));

    await round();

    expect(others(d, one)).toEqual([{ other: two, files: ['report.ts'] }]);
    expect(others(d, two)).toEqual([{ other: one, files: ['report.ts'] }]);
    expect(others(d, three)).toEqual([]);
    const row = d.store.conflicts.of(one)[0];
    expect(row?.head).toBe(d.task(one).run.checkpoint?.sha);
    expect(row?.other_head).toBe(d.task(two).run.checkpoint?.sha);
    // Information only: no event, no version, no wait.
    expect(
      [one, two, three].map((id) => ({
        version: d.task(id).version,
        status: d.task(id).status,
        wait: d.task(id).wait,
        events: d.store.readEvents(id as Uuid).length,
      })),
    ).toEqual(before);

    // `task explain` shows it.
    const explained = taskExplain(d.store, OWNER, { kind: 'task_explain', task_id: one }, d.now);
    expect(explained.ok).toBe(true);
    expect((explained as { value: Record<string, unknown> }).value['branch_conflicts']).toEqual([
      expect.objectContaining({ other_task_id: two, files: ['report.ts'] }),
    ]);
  });

  it('checks again after a new checkpoint, and drops the row when a task ends', async () => {
    const { repo, d, round } = setup();
    const one = checkpointed(d, repo, 1, branch(repo, 't1', { 0: 'one' }));
    const two = checkpointed(d, repo, 2, branch(repo, 't2', { 0: 'two' }));
    await round();
    expect(others(d, one)).toHaveLength(1);

    // Two resolves its side: its new checkpoint no longer conflicts.
    checkpoint(d, repo, two, branch(repo, 't2b', { 0: 'one', 20: 'two' }));
    await round();
    expect(others(d, one)).toEqual([]);

    checkpoint(d, repo, two, branch(repo, 't2c', { 0: 'two again' }));
    await round();
    expect(others(d, one)).toEqual([{ other: two, files: ['report.ts'] }]);

    injectEvents(d.store, two, [
      { type: 'TaskCancelled', revision: 1, actor: 'owner', payload: { reason: 'dropped' } },
    ]);
    await round();
    expect(others(d, one)).toEqual([]);
    expect(others(d, two)).toEqual([]);
  });

  it('shows the conflicts of its units in `goal show`', async () => {
    const { repo, d, round } = setup();
    const goalId = '0192cccc-0000-7000-8000-0000000000f1';
    const plan = goalPlan([planUnit('a'), planUnit('b')]);
    const triggers: GoalTrigger[] = [
      { kind: 'add', project: 'acme', base_branch: 'main', request: 'r', hints: {} },
      { kind: 'propose', plan, plan_version: 0, plan_hash: 'sha256:p' },
      { kind: 'confirm', plan_hash: 'sha256:p', units: { a: uuidOf(1), b: uuidOf(2) } },
    ];
    triggers.forEach((trigger, i) => {
      const r = d.store.goals.accept({
        goal_id: goalId,
        dedup_key: `seed:${i}`,
        now: 1,
        actor: 'owner',
        trigger,
      });
      expect(r.ok).toBe(true);
    });
    const unit = (key: string) => ({
      goal: { id: goalId as Uuid, unit_key: key, role: 'unit' as const, depends_on_units: [] },
    });
    const a = checkpointed(d, repo, 1, branch(repo, 'ga', { 5: 'a' }), unit('a'));
    const b = checkpointed(d, repo, 2, branch(repo, 'gb', { 5: 'b' }), unit('b'));
    await round();
    const shown = goalShow(d.store, OWNER, { kind: 'goal_show', goal_id: goalId });
    expect(shown.ok).toBe(true);
    const rows = (
      shown as {
        value: { branch_conflicts: { task_id: string; other_task_id: string; files: string[] }[] };
      }
    ).value.branch_conflicts;
    expect(
      rows.map((r) => ({ pair: [r.task_id, r.other_task_id].sort(), files: r.files })),
    ).toEqual([{ pair: [a, b].sort(), files: ['report.ts'] }]);
  });
});
