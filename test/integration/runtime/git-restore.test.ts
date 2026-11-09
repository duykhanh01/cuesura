import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { headOf, restoreWorktree } from '../../../src/adapters/git/restore.ts';
import { gitSandbox } from '../../support/git-repo.ts';

const g = gitSandbox('cusr-restore-');
afterAll(() => g.cleanup());

describe('the worktree after a review', () => {
  it('goes back to the tree the task left, uncommitted work and ignored files included', async () => {
    const dir = g.repo('r', { 'a.txt': 'a\n', 'b.txt': 'b\n', '.gitignore': 'node_modules/\n' });
    const binary = Buffer.from([0, 255, 1, 254, 10, 13]);
    // The coder's work, not committed: a checkpoint staged it into the index.
    writeFileSync(join(dir, 'a.txt'), 'coder\n');
    writeFileSync(join(dir, 'w.bin'), binary);
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules/dep.js'), 'dep\n');
    g.sh(dir, 'add', '--all', '--', '.');
    const left = g.sh(dir, 'write-tree');
    const before = { head: g.sh(dir, 'rev-parse', 'HEAD'), tree: left };

    // The reviewer edits, deletes, creates and runs a build.
    writeFileSync(join(dir, 'a.txt'), 'reviewer\n');
    writeFileSync(join(dir, 'w.bin'), 'text now');
    rmSync(join(dir, 'b.txt'));
    mkdirSync(join(dir, 'probe'));
    writeFileSync(join(dir, 'probe/test.ts'), 'x\n');
    writeFileSync(join(dir, 'node_modules/cache.js'), 'built\n');

    const r = await restoreWorktree(g.runner(), dir, before);
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && [...r.restored].sort()).toEqual(['a.txt', 'b.txt', 'w.bin']);
    expect(r.ok && r.removed).toEqual(['probe/test.ts']);

    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('coder\n');
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('b\n');
    expect(readFileSync(join(dir, 'w.bin')).equals(binary)).toBe(true);
    expect(existsSync(join(dir, 'probe/test.ts'))).toBe(false);
    expect(readFileSync(join(dir, 'node_modules/cache.js'), 'utf8')).toBe('built\n');
    g.sh(dir, 'add', '--all', '--', '.');
    expect(g.sh(dir, 'write-tree')).toBe(left);
  });

  it('moves the branch back when the reviewer committed, keeping the coder commits under it', async () => {
    const dir = g.repo('committed', { 'a.txt': 'a\n' });
    // The coder committed part of its work and left the rest uncommitted.
    writeFileSync(join(dir, 'a.txt'), 'coder\n');
    g.sh(dir, 'commit', '-qam', 'coder');
    writeFileSync(join(dir, 'b.txt'), 'wip\n');
    g.sh(dir, 'add', '--all', '--', '.');
    const before = { head: g.sh(dir, 'rev-parse', 'HEAD'), tree: g.sh(dir, 'write-tree') };
    expect(await headOf(g.runner(), dir)).toBe(before.head);

    writeFileSync(join(dir, 'a.txt'), 'reviewer\n');
    rmSync(join(dir, 'b.txt'));
    g.sh(dir, 'add', '--all', '--', '.');
    g.sh(dir, 'commit', '-qm', 'reviewer');

    expect(await restoreWorktree(g.runner(), dir, before)).toMatchObject({ ok: true });
    expect(g.sh(dir, 'rev-parse', 'HEAD')).toBe(before.head);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('coder\n');
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('wip\n');
    g.sh(dir, 'add', '--all', '--', '.');
    expect(g.sh(dir, 'write-tree')).toBe(before.tree);
  });

  it('puts back what the reviewer staged without committing', async () => {
    const dir = g.repo('staged', { 'a.txt': 'a\n' });
    const before = { head: g.sh(dir, 'rev-parse', 'HEAD'), tree: g.sh(dir, 'write-tree') };

    writeFileSync(join(dir, 'a.txt'), 'reviewer\n');
    writeFileSync(join(dir, 'probe.txt'), 'x\n');
    g.sh(dir, 'add', '--all', '--', '.');

    expect(await restoreWorktree(g.runner(), dir, before)).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a\n');
    expect(existsSync(join(dir, 'probe.txt'))).toBe(false);
    expect(g.sh(dir, 'write-tree')).toBe(before.tree);
  });

  it('changes nothing when the reviewer left the tree as it was', async () => {
    const dir = g.repo('clean');
    const before = { head: g.sh(dir, 'rev-parse', 'HEAD'), tree: g.sh(dir, 'write-tree') };
    const r = await restoreWorktree(g.runner(), dir, before);
    expect(r).toEqual({ ok: true, restored: [], removed: [] });
  });
});
