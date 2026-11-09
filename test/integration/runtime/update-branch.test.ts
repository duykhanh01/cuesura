import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { observeTaskPr } from '../../../src/daemon/handlers.ts';
import { replay } from '../../../src/engine/evolve.ts';
import { buildTask } from '../../support/builders.ts';
import { flowEnv } from '../../support/flow-env.ts';

// GitHub's "Update branch" on a task's PR (issue #110): a clean merge of the target into the checked
// head is taken through the base update path (gates, certification, CI on the new head); anything else
// stays a head drift for a person.

const { g, setup } = flowEnv('cusr-update-branch-');
let seq = 0;
type Flow = ReturnType<typeof setup>;

async function toMerge(mode: 'direct-pr' | 'full-review') {
  const task = buildTask();
  const f = setup(task, { mode, reviews: 2 });
  f.d.must(task.id, { kind: 'create_task', task });
  f.start();
  await f.settle();
  expect(f.d.task(task.id).wait?.detail.code).toBe('merge');
  return { task, f, head: f.d.task(task.id).head_sha as string };
}

/** Advances main on the remote, then merges it into the PR branch the way GitHub does; returns both SHAs. */
function updateBranch(
  f: Flow,
  o: { edit?: boolean; extraCommit?: boolean; push?: boolean } = {},
): { base: string; head: string; clone: string; branch: string } {
  const clone = join(g.base, `update-branch-${seq++}`);
  g.sh(g.base, 'clone', '-q', f.remote, clone);
  writeFileSync(join(clone, 'base.txt'), 'change from the preceding task\n');
  g.sh(clone, 'add', '-A');
  g.sh(clone, 'commit', '-qm', 'main advanced');
  g.sh(clone, 'push', '-q', 'origin', 'main');
  const base = g.sh(clone, 'rev-parse', 'HEAD');
  const branch = g.sh(f.worktree, 'symbolic-ref', '--short', 'HEAD');
  g.sh(clone, 'checkout', '-q', branch);
  if (o.edit === true) {
    g.sh(clone, 'merge', '-q', '--no-ff', '--no-commit', 'main');
    writeFileSync(join(clone, 'search.ts'), 'export const search = (q: string) => q.trim();\n');
    g.sh(clone, 'add', '-A');
    g.sh(clone, 'commit', '-qm', `Merge branch 'main' into ${branch}`);
  } else {
    g.sh(clone, 'merge', '-q', '--no-ff', '-m', `Merge branch 'main' into ${branch}`, 'main');
  }
  if (o.extraCommit === true) {
    writeFileSync(join(clone, 'extra.ts'), 'export const extra = true;\n');
    g.sh(clone, 'add', '-A');
    g.sh(clone, 'commit', '-qm', 'extra');
  }
  if (o.push !== false) g.sh(clone, 'push', '-q', 'origin', branch);
  return { base, head: g.sh(clone, 'rev-parse', 'HEAD'), clone, branch };
}

/** One observation round of the task's PR, its facts submitted as the observation service does. */
async function observe(f: Flow, taskId: string): Promise<void> {
  const r = await observeTaskPr(
    {
      ...f.deps,
      local: { git: f.deps.git, worktrees: f.deps.paths.worktrees, remoteUrl: f.deps.remoteUrl },
    },
    taskId,
    `observe:${taskId}:${seq++}`,
    'timer',
  );
  for (const fact of r.facts) f.d.must(taskId, fact);
}

const remoteHead = (f: Flow, branch: string) => g.sh(f.remote, 'rev-parse', `refs/heads/${branch}`);

describe('Update branch on the PR (#110)', () => {
  it.each(['direct-pr', 'full-review'] as const)(
    '%s: a clean update is adopted; gates run on it, the review stands and CI is read on the new head',
    async (mode) => {
      const { task, f, head } = await toMerge(mode);
      const reviews = f.codex.calls.length;
      const u = updateBranch(f);
      await observe(f, task.id);
      expect(f.d.task(task.id).wait?.detail.code).not.toBe('head_changed');
      await f.settle();
      const after = f.d.task(task.id);
      expect(after.wait?.detail.code).toBe('merge');
      expect(after.run.head_drift).toBeNull();
      expect(after.head_sha).toBe(u.head);
      expect(after.run.checkpoint?.sha).toBe(u.head);
      expect(after.run.base_update).toMatchObject({
        head_sha: head,
        base_sha: u.base,
        remote_head: u.head,
        certificate: { head_sha: u.head },
      });
      expect(after.evidence.gates.at(-1)?.passed).toBe(true);
      expect(after.evidence.ci.at(-1)?.head_sha).toBe(u.head);
      expect(g.sh(f.worktree, 'rev-parse', 'HEAD')).toBe(u.head);
      expect(readFileSync(join(f.worktree, 'base.txt'), 'utf8')).toBe(
        'change from the preceding task\n',
      );
      expect(remoteHead(f, u.branch)).toBe(u.head);
      expect(f.github.prs).toHaveLength(1);
      expect(f.codex.calls).toHaveLength(reviews);
      expect(replay(f.d.store.readEvents(task.id))).toEqual(after);
    },
  );

  it.each([
    ['an edit inside the merge commit', { edit: true }],
    ['an extra commit after the merge', { extraCommit: true }],
  ] as const)('%s is not adopted: the task waits head_changed', async (_name, o) => {
    const { task, f, head } = await toMerge('full-review');
    const u = updateBranch(f, o);
    await observe(f, task.id);
    const s = f.d.task(task.id);
    expect(s.wait?.detail.code).toBe('head_changed');
    expect(s.run.head_drift).toMatchObject({ expected: head, observed: u.head });
    expect(s.run.base_update?.remote_head).toBeUndefined();
    await f.settle();
    expect(g.sh(f.worktree, 'rev-parse', 'HEAD')).toBe(head);
    expect(f.d.task(task.id).wait?.detail.code).toBe('head_changed');
  });

  it('a merge of a branch that is not on the target is not adopted, even if FETCH_HEAD is rewritten meanwhile', async () => {
    const task = buildTask();
    let observed: string | null = null;
    let busy = false;
    const f: Flow = setup(task, {
      mode: 'direct-pr',
      reviews: 2,
      // Another read fetching into the same repository between our fetches rewrites FETCH_HEAD.
      afterGit: (args) => {
        if (busy || observed === null || args[0] !== 'fetch') return;
        busy = true;
        g.sh(f.worktree, 'fetch', '-q', '--no-tags', f.remote, observed);
        busy = false;
      },
    });
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    await f.settle();
    const head = f.d.task(task.id).head_sha as string;
    const clone = join(g.base, `side-branch-${seq++}`);
    g.sh(g.base, 'clone', '-q', f.remote, clone);
    g.sh(clone, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(clone, 'side.txt'), 'not on main\n');
    g.sh(clone, 'add', '-A');
    g.sh(clone, 'commit', '-qm', 'side');
    g.sh(clone, 'push', '-q', 'origin', 'side');
    const branch = g.sh(f.worktree, 'symbolic-ref', '--short', 'HEAD');
    g.sh(clone, 'checkout', '-q', branch);
    g.sh(clone, 'merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
    g.sh(clone, 'push', '-q', 'origin', branch);
    observed = g.sh(clone, 'rev-parse', 'HEAD');
    await observe(f, task.id);
    const s = f.d.task(task.id);
    expect(s.wait?.detail.code).toBe('head_changed');
    expect(s.run.head_drift).toMatchObject({ expected: head, observed });
    expect(s.run.base_update?.remote_head).toBeUndefined();
  });

  it('a head that moves again while the update is checked is not taken as checked', async () => {
    const { task, f, head } = await toMerge('full-review');
    const u = updateBranch(f);
    await observe(f, task.id);
    // Someone pushes on top before the gates and the push ran.
    writeFileSync(join(u.clone, 'late.ts'), 'export const late = 1;\n');
    g.sh(u.clone, 'add', '-A');
    g.sh(u.clone, 'commit', '-qm', 'late');
    g.sh(u.clone, 'push', '-q', 'origin', u.branch);
    const late = g.sh(u.clone, 'rev-parse', 'HEAD');
    await f.settle();
    await observe(f, task.id);
    const s = f.d.task(task.id);
    expect(s.wait?.detail.code).toBe('head_changed');
    expect(s.head_sha).not.toBe(late);
    expect([head, u.head]).toContain(s.head_sha);
    expect(s.evidence.ci.some((c) => c.head_sha === late)).toBe(false);
    expect(remoteHead(f, u.branch)).toBe(late);
  });

  it('a task already waiting head_changed on a clean update is adopted by the next read', async () => {
    const { task, f } = await toMerge('direct-pr');
    const u = updateBranch(f);
    // Recorded as a plain drift, as a release before #110 did.
    f.d.must(task.id, {
      kind: 'head_drift',
      expected: f.d.task(task.id).head_sha,
      observed: u.head,
      source: 'observation',
      evidence_ref: 'old-release',
    });
    expect(f.d.task(task.id).wait?.detail.code).toBe('head_changed');
    await observe(f, task.id);
    await f.settle();
    const after = f.d.task(task.id);
    expect(after.wait?.detail.code).toBe('merge');
    expect(after.run.head_drift).toBeNull();
    expect(after.blockers.some((b) => b.code === 'head_changed')).toBe(false);
    expect(after.head_sha).toBe(u.head);
    expect(replay(f.d.store.readEvents(task.id))).toEqual(after);
  });
});
