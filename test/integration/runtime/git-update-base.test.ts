import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { updateBase, baseRepairScope } from '../../../src/adapters/git/update-base.ts';
import { FileCommitIntentStore } from '../../../src/adapters/git/commit.ts';
import { ensureWorktree, markerPath } from '../../../src/adapters/git/worktree.ts';
import type { GitPort } from '../../../src/adapters/ports.ts';
import { uuidOf } from '../../support/builders.ts';
import { gitSandbox } from '../../support/git-repo.ts';

const g = gitSandbox('cusr-base-update-');
afterAll(() => g.cleanup());
let seq = 0;
async function setup(conflict = false) {
  const project = g.repo(`p${seq}`);
  const root = join(g.base, `data${seq++}`);
  const base = g.sh(project, 'rev-parse', 'HEAD');
  const task_id = uuidOf(seq);
  const git = g.runner();
  const wt = await ensureWorktree(git, {
    task_id,
    title: 'base update',
    project_realpath: project,
    common_git_dir: join(project, '.git'),
    base_sha: base,
    worktrees_root: join(root, 'worktrees'),
    markers_dir: join(root, 'owners'),
    nonce: 'test',
  });
  if (wt.kind !== 'created') throw new Error(JSON.stringify(wt));
  writeFileSync(join(wt.worktree_path, conflict ? 'a.txt' : 'feature.txt'), 'task change\n');
  g.sh(wt.worktree_path, 'add', '-A');
  g.sh(wt.worktree_path, 'commit', '-qm', 'task');
  const head_sha = g.sh(wt.worktree_path, 'rev-parse', 'HEAD');
  writeFileSync(join(project, conflict ? 'a.txt' : 'base.txt'), 'new base\n');
  g.sh(project, 'add', '-A');
  g.sh(project, 'commit', '-qm', 'base advanced');
  const base_sha = g.sh(project, 'rev-parse', 'HEAD');
  const store = new FileCommitIntentStore(join(root, 'intents'));
  const input = {
    head_sha,
    base_sha,
    remote: project,
    identity: { name: 'Cuesura', email: 'cusr@invalid' },
    at: 1_800_000_000_000,
    checkpoint: {
      task_id,
      revision: 1,
      project_realpath: project,
      common_git_dir: join(project, '.git'),
      worktree_path: wt.worktree_path,
      branch: wt.branch,
      base_sha: base,
      owner_marker: markerPath(join(root, 'owners'), task_id),
    },
  };
  return { git, store, input, wt, project };
}

describe('intentional base integration before recertifying a task', () => {
  it('makes a two-parent merge locally, keeps the task change, and leaves the remote task branch alone', async () => {
    const f = await setup();
    const result = await updateBase(f.git, f.store, f.input);
    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated') return;
    expect(g.sh(f.wt.worktree_path, 'rev-parse', 'HEAD^1')).toBe(f.input.head_sha);
    expect(g.sh(f.wt.worktree_path, 'rev-parse', 'HEAD^2')).toBe(f.input.base_sha);
    expect(readFileSync(join(f.wt.worktree_path, 'feature.txt'), 'utf8')).toBe('task change\n');
    expect(readFileSync(join(f.wt.worktree_path, 'base.txt'), 'utf8')).toBe('new base\n');
    expect(g.sh(f.project, 'rev-parse', 'main')).toBe(f.input.base_sha);
    expect(g.sh(f.wt.worktree_path, 'status', '--porcelain')).toBe('');
    expect(await updateBase(f.git, f.store, { ...f.input, at: f.input.at + 10_000 })).toEqual(
      result,
    );
    expect(g.sh(f.wt.worktree_path, 'rev-list', '--count', `${f.input.head_sha}..HEAD`)).toBe('2');
  });

  it('gives fetch the same 60-second allowance as preflight', async () => {
    const f = await setup();
    const port: GitPort = {
      run: (command) => {
        if (command.args[0] === 'fetch' && command.timeout_ms < 60_000)
          return Promise.resolve({ kind: 'timeout' });
        return f.git.run(command);
      },
    };
    expect((await updateBase(port, f.store, f.input)).kind).toBe('updated');
  });

  it('a conflict prepares a durable worktree plan without changing the branch', async () => {
    const f = await setup(true);
    const result = await updateBase(f.git, f.store, f.input);
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') return;
    expect(result.files).toEqual(['a.txt']);
    expect(g.sh(f.wt.worktree_path, 'rev-parse', 'HEAD')).toBe(f.input.head_sha);
    expect(readFileSync(join(f.wt.worktree_path, 'a.txt'), 'utf8')).toContain('<<<<<<<');
    expect(await updateBase(f.git, f.store, { ...f.input, at: f.input.at + 10_000 })).toEqual(
      result,
    );
    expect(
      await baseRepairScope(f.git, f.wt.worktree_path, f.input.head_sha, result, result.tree),
    ).toMatchObject({ unresolved: true, outside_files: [] });
    writeFileSync(join(f.wt.worktree_path, 'a.txt'), 'resolved\n');
    writeFileSync(join(f.wt.worktree_path, 'outside.txt'), 'extra change\n');
    g.sh(f.wt.worktree_path, 'add', '-A');
    const fixed = g.sh(f.wt.worktree_path, 'write-tree');
    expect(
      await baseRepairScope(f.git, f.wt.worktree_path, f.input.head_sha, result, fixed),
    ).toMatchObject({
      tree: fixed,
      unresolved: false,
      outside_files: ['outside.txt'],
    });
    expect(g.sh(f.wt.worktree_path, 'rev-parse', 'HEAD')).toBe(f.input.head_sha);
  });

  it('does not create an empty merge when the requested base is already an ancestor', async () => {
    const f = await setup();
    const before = g.sh(f.wt.worktree_path, 'rev-list', '--count', 'HEAD');
    const result = await updateBase(f.git, f.store, {
      ...f.input,
      base_sha: f.input.checkpoint.base_sha,
    });
    expect(result.kind).toBe('blocked');
    expect(g.sh(f.wt.worktree_path, 'rev-parse', 'HEAD')).toBe(f.input.head_sha);
    expect(g.sh(f.wt.worktree_path, 'rev-list', '--count', 'HEAD')).toBe(before);
  });

  it.each(['modify-delete', 'binary'] as const)(
    'requires a change for markerless %s conflicts',
    async (kind) => {
      const f = await setup(true);
      if (kind === 'modify-delete') {
        rmSync(join(f.project, 'a.txt'));
      } else {
        writeFileSync(join(f.wt.worktree_path, 'a.txt'), Buffer.from([0, 1, 2]));
        g.sh(f.wt.worktree_path, 'add', '-A');
        g.sh(f.wt.worktree_path, 'commit', '-qm', 'binary task');
        f.input.head_sha = g.sh(f.wt.worktree_path, 'rev-parse', 'HEAD');
        writeFileSync(join(f.project, 'a.txt'), Buffer.from([0, 3, 4]));
      }
      g.sh(f.project, 'add', '-A');
      g.sh(f.project, 'commit', '-qm', kind);
      f.input.base_sha = g.sh(f.project, 'rev-parse', 'HEAD');
      const result = await updateBase(f.git, f.store, f.input);
      expect(result.kind).toBe('conflict');
      if (result.kind !== 'conflict') throw new Error('expected conflict');
      expect(g.sh(f.wt.worktree_path, 'diff', '--check', f.input.head_sha, result.tree)).toBe('');
      expect(
        await baseRepairScope(f.git, f.wt.worktree_path, f.input.head_sha, result, result.tree),
      ).toMatchObject({ unresolved: true, unchanged_conflicts: ['a.txt'] });
      writeFileSync(
        join(f.wt.worktree_path, 'a.txt'),
        kind === 'binary' ? Buffer.from([0, 42]) : 'explicit resolution\n',
      );
      g.sh(f.wt.worktree_path, 'add', '-A');
      const resolved = g.sh(f.wt.worktree_path, 'write-tree');
      expect(
        await baseRepairScope(f.git, f.wt.worktree_path, f.input.head_sha, result, resolved),
      ).toMatchObject({ unresolved: false, unchanged_conflicts: [] });
    },
  );

  it('ignores base Markdown separators and unbounded whitespace diagnostics outside conflict paths', async () => {
    const f = await setup(true);
    writeFileSync(
      join(f.project, 'guide.md'),
      'Heading\n=======\n' + 'trailing whitespace \n'.repeat(70_000),
    );
    g.sh(f.project, 'add', '-A');
    g.sh(f.project, 'commit', '-qm', 'base documentation');
    f.input.base_sha = g.sh(f.project, 'rev-parse', 'HEAD');
    const conflict = await updateBase(f.git, f.store, f.input);
    if (conflict.kind !== 'conflict') throw new Error('expected conflict');
    writeFileSync(join(f.wt.worktree_path, 'a.txt'), 'resolved\n');
    g.sh(f.wt.worktree_path, 'add', '-A');
    const tree = g.sh(f.wt.worktree_path, 'write-tree');
    expect(
      await baseRepairScope(f.git, f.wt.worktree_path, f.input.head_sha, conflict, tree),
    ).toMatchObject({ unresolved: false, outside_files: [] });
  });

  it.each([false, true])(
    'recovers a prepared conflict tree after a lost checkout answer (applied=%s)',
    async (applied) => {
      const f = await setup(true);
      let interrupted = false;
      const port: GitPort = {
        run: async (command) => {
          if (command.args[0] !== 'read-tree' || interrupted) return f.git.run(command);
          interrupted = true;
          if (applied) await f.git.run(command);
          return { kind: 'timeout' };
        },
      };
      expect((await updateBase(port, f.store, f.input)).kind).toBe('unknown');
      const after = await updateBase(f.git, f.store, f.input);
      expect(after.kind).toBe('conflict');
      expect(g.sh(f.wt.worktree_path, 'rev-parse', 'HEAD')).toBe(f.input.head_sha);
      expect(readFileSync(join(f.wt.worktree_path, 'a.txt'), 'utf8')).toContain('<<<<<<<');
    },
  );

  it('an outside edit or head move is never overwritten', async () => {
    const f = await setup();
    writeFileSync(join(f.wt.worktree_path, 'feature.txt'), 'outside edit\n');
    expect(await updateBase(f.git, f.store, f.input)).toMatchObject({
      kind: 'blocked',
    });
    expect(readFileSync(join(f.wt.worktree_path, 'feature.txt'), 'utf8')).toBe('outside edit\n');
    expect(g.sh(f.wt.worktree_path, 'rev-parse', 'HEAD')).toBe(f.input.head_sha);
    g.sh(f.wt.worktree_path, 'commit', '-qm', 'outside');
    expect(await updateBase(f.git, f.store, f.input)).toMatchObject({
      kind: 'blocked',
    });
    expect(g.sh(f.wt.worktree_path, 'log', '-1', '--format=%s')).toBe('outside');
  });

  it.each(['before_ref', 'after_ref', 'after_checkout'] as const)(
    'recovers the same merge after losing the answer %s',
    async (point) => {
      const f = await setup();
      let interrupted = false;
      const port: GitPort = {
        run: async (command) => {
          const hit = command.args[0] === (point === 'after_checkout' ? 'read-tree' : 'update-ref');
          if (!hit || interrupted) return f.git.run(command);
          interrupted = true;
          if (point !== 'before_ref') await f.git.run(command);
          return { kind: 'timeout' };
        },
      };
      await updateBase(port, f.store, f.input);
      expect(interrupted).toBe(true);
      const result = await updateBase(f.git, f.store, {
        ...f.input,
        at: f.input.at + 10_000,
      });
      expect(result.kind).toBe('updated');
      expect(g.sh(f.wt.worktree_path, 'status', '--porcelain')).toBe('');
      expect(g.sh(f.wt.worktree_path, 'rev-parse', 'HEAD^1')).toBe(f.input.head_sha);
      expect(g.sh(f.wt.worktree_path, 'rev-parse', 'HEAD^2')).toBe(f.input.base_sha);
      expect(g.sh(f.wt.worktree_path, 'rev-list', '--count', `${f.input.head_sha}..HEAD`)).toBe(
        '2',
      );
    },
  );
});
