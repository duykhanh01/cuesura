import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compareCheckpoint, takeCheckpoint } from '../../../src/adapters/git/checkpoint.ts';
import {
  ensureWorktree,
  markerPath,
  taskBranch,
  type WorktreeSpec,
} from '../../../src/adapters/git/worktree.ts';
import { uuidOf } from '../../support/builders.ts';
import { gitSandbox } from '../../support/git-repo.ts';

const g = gitSandbox('cusr-worktree-');
afterAll(() => g.cleanup());

let n = 0;
function setup(over: Partial<WorktreeSpec> = {}) {
  const project = g.repo();
  const base = g.sh(project, 'rev-parse', 'HEAD');
  const data = join(g.base, `data${n++}`);
  const spec: WorktreeSpec = {
    task_id: uuidOf(1),
    title: 'Thêm tìm kiếm khách hàng',
    project_realpath: project,
    common_git_dir: join(project, '.git'),
    base_sha: base,
    worktrees_root: join(data, 'worktrees'),
    markers_dir: join(data, 'owners'),
    nonce: 'n1',
    ...over,
  };
  return { project, base, spec, git: g.runner() };
}

describe('task worktree (T036, FR-003)', () => {
  it('names the branch cusr/<task_id>-<slug> with an ASCII slug', () => {
    expect(taskBranch(uuidOf(1), 'Thêm tìm kiếm khách hàng!')).toBe(
      `cusr/${uuidOf(1)}-them-tim-kiem-khach-hang`,
    );
    expect(taskBranch(uuidOf(1), '***')).toBe(`cusr/${uuidOf(1)}`);
  });

  it('creates the branch and worktree from the frozen base after writing the owner marker', async () => {
    const { project, base, spec, git } = setup();
    // The base branch moves on; the worktree still starts at the frozen base.
    writeFileSync(join(project, 'b.txt'), 'later\n');
    g.sh(project, 'add', 'b.txt');
    g.sh(project, 'commit', '-qm', 'later');

    const r = await ensureWorktree(git, spec);
    expect(r).toMatchObject({
      kind: 'created',
      head: base,
      branch: taskBranch(spec.task_id, spec.title),
    });
    if (r.kind !== 'created') return;
    expect(existsSync(join(r.worktree_path, 'a.txt'))).toBe(true);
    expect(existsSync(join(r.worktree_path, 'b.txt'))).toBe(false);
    expect(
      JSON.parse(readFileSync(markerPath(spec.markers_dir, spec.task_id), 'utf8')),
    ).toMatchObject({
      task_id: spec.task_id,
      base_sha: base,
      worktree_path: r.worktree_path,
    });
    expect(g.sh(project, 'rev-parse', 'HEAD')).not.toBe(base);
  });

  it('checks out the head of an adopted PR on its private branch and keeps the base in the marker', async () => {
    const { project, base, spec, git } = setup();
    g.sh(project, 'checkout', '-q', '-b', 'feature/human');
    writeFileSync(join(project, 'human.txt'), 'human\n');
    g.sh(project, 'add', 'human.txt');
    g.sh(project, 'commit', '-qm', 'human');
    const head = g.sh(project, 'rev-parse', 'HEAD');

    // The PR's branch stays checked out in the project: the private branch cannot collide with it.
    const r = await ensureWorktree(git, { ...spec, start_sha: head });
    expect(r).toMatchObject({
      kind: 'created',
      head,
      branch: taskBranch(spec.task_id, spec.title),
      marker: { base_sha: base },
    });
    const again = await ensureWorktree(git, { ...spec, start_sha: head, nonce: 'n2' });
    expect(again).toMatchObject({ kind: 'adopted', head });
  });

  it('adopts its own worktree again, keeping uncommitted work', async () => {
    const { spec, git } = setup();
    const first = await ensureWorktree(git, spec);
    if (first.kind !== 'created') throw new Error(JSON.stringify(first));
    writeFileSync(join(first.worktree_path, 'wip.txt'), 'draft\n');
    const again = await ensureWorktree(git, { ...spec, nonce: 'n2' });
    expect(again).toMatchObject({
      kind: 'adopted',
      worktree_path: first.worktree_path,
      marker: { nonce: 'n1' },
    });
    expect(readFileSync(join(first.worktree_path, 'wip.txt'), 'utf8')).toBe('draft\n');
  });

  it('resumes a create interrupted after the marker was written', async () => {
    const { spec, git } = setup();
    mkdirSync(spec.markers_dir, { recursive: true });
    const branch = taskBranch(spec.task_id, spec.title);
    writeFileSync(
      markerPath(spec.markers_dir, spec.task_id),
      JSON.stringify({
        schema_version: 1,
        task_id: spec.task_id,
        project_realpath: spec.project_realpath,
        common_git_dir: spec.common_git_dir,
        worktree_path: join(spec.worktrees_root, spec.task_id),
        branch,
        base_sha: spec.base_sha,
        nonce: 'n0',
      }),
    );
    expect(await ensureWorktree(git, spec)).toMatchObject({
      kind: 'created',
      marker: { nonce: 'n0' },
    });
  });

  it('never adopts a branch or path it does not own, and changes nothing', async () => {
    const { project, base, spec, git } = setup();
    const branch = taskBranch(spec.task_id, spec.title);
    g.sh(project, 'branch', branch, base);
    expect(await ensureWorktree(git, spec)).toMatchObject({
      kind: 'mismatch',
      reason: 'not_owned',
    });
    expect(existsSync(markerPath(spec.markers_dir, spec.task_id))).toBe(false);
    expect(g.sh(project, 'rev-parse', branch)).toBe(base);
  });

  it('reports a missing worktree or a moved branch instead of recreating or resetting', async () => {
    const { project, spec, git } = setup();
    const r = await ensureWorktree(git, spec);
    if (r.kind !== 'created') throw new Error(JSON.stringify(r));

    // Someone switched the worktree to another branch.
    g.sh(r.worktree_path, 'switch', '-q', '-c', 'other');
    expect(await ensureWorktree(git, spec)).toMatchObject({
      kind: 'mismatch',
      reason: 'branch_mismatch',
    });
    g.sh(r.worktree_path, 'switch', '-q', r.branch);

    // The worktree directory is gone and pruned; the branch and its commits stay.
    rmSync(r.worktree_path, { recursive: true, force: true });
    g.sh(project, 'worktree', 'prune');
    expect(await ensureWorktree(git, spec)).toMatchObject({
      kind: 'mismatch',
      reason: 'worktree_missing',
    });
    expect(g.sh(project, 'rev-parse', `refs/heads/${r.branch}`)).toBe(r.head);
  });

  it('rejects a worktree whose history no longer contains the frozen base', async () => {
    const { spec, git } = setup();
    const r = await ensureWorktree(git, spec);
    if (r.kind !== 'created') throw new Error(JSON.stringify(r));
    g.sh(r.worktree_path, 'checkout', '-q', '--orphan', 'tmp');
    g.sh(r.worktree_path, 'commit', '-qm', 'rewrite', '--allow-empty');
    const orphan = g.sh(r.worktree_path, 'rev-parse', 'HEAD');
    g.sh(r.worktree_path, 'checkout', '-q', r.branch);
    g.sh(r.worktree_path, 'reset', '-q', '--hard', orphan);
    expect(await ensureWorktree(git, spec)).toMatchObject({
      kind: 'mismatch',
      reason: 'base_not_ancestor',
    });
  });
});

describe('worktree checkpoint (T036, FR-004)', () => {
  it('records tree, parent and diff digest of all changes and compares by value', async () => {
    const { spec, git, base } = setup();
    const r = await ensureWorktree(git, spec);
    if (r.kind !== 'created') throw new Error(JSON.stringify(r));
    const cpSpec = {
      task_id: spec.task_id,
      revision: 1,
      project_realpath: spec.project_realpath,
      common_git_dir: spec.common_git_dir,
      worktree_path: r.worktree_path,
      branch: r.branch,
      base_sha: base,
      owner_marker: markerPath(spec.markers_dir, spec.task_id),
    };

    const clean = await takeCheckpoint(git, cpSpec);
    if (!clean.ok) throw new Error(JSON.stringify(clean.error));
    expect(clean.value).toMatchObject({
      parent_oid: base,
      tree_oid: g.sh(spec.project_realpath, 'rev-parse', `${base}^{tree}`),
    });

    writeFileSync(join(r.worktree_path, 'new.txt'), 'n\n');
    writeFileSync(join(r.worktree_path, 'a.txt'), 'changed\n');
    const dirty = await takeCheckpoint(git, cpSpec);
    if (!dirty.ok) throw new Error(JSON.stringify(dirty.error));
    expect(dirty.value.tree_oid).not.toBe(clean.value.tree_oid);
    expect(dirty.value.diff_digest).not.toBe(clean.value.diff_digest);
    expect(g.sh(r.worktree_path, 'cat-file', '-p', `${dirty.value.tree_oid}:new.txt`)).toBe('n');
    // Nothing was committed; the files are still there.
    expect(g.sh(r.worktree_path, 'rev-parse', 'HEAD')).toBe(base);
    expect(readFileSync(join(r.worktree_path, 'a.txt'), 'utf8')).toBe('changed\n');

    expect(await compareCheckpoint(git, dirty.value)).toEqual({ kind: 'same' });
    writeFileSync(join(r.worktree_path, 'later.txt'), 'x\n');
    expect(await compareCheckpoint(git, dirty.value)).toMatchObject({
      kind: 'changed',
      fields: ['tree_oid', 'diff_digest'],
    });
  });

  it('refuses a checkpoint when the worktree is not on the task branch', async () => {
    const { spec, git, base } = setup();
    const r = await ensureWorktree(git, spec);
    if (r.kind !== 'created') throw new Error(JSON.stringify(r));
    g.sh(r.worktree_path, 'checkout', '-q', '--detach');
    const cp = await takeCheckpoint(git, {
      task_id: spec.task_id,
      revision: 1,
      project_realpath: spec.project_realpath,
      common_git_dir: spec.common_git_dir,
      worktree_path: r.worktree_path,
      branch: r.branch,
      base_sha: base,
      owner_marker: 'm',
    });
    expect(cp).toMatchObject({ ok: false, error: { kind: 'invalid' } });
  });
});
