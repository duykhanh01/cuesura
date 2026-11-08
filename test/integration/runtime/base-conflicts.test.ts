import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readBaseConflicts } from '../../../src/adapters/git/base-conflicts.ts';
import { gitSandbox } from '../../support/git-repo.ts';

// Issue #210: the base conflict fact a checkpoint carries, read from the local remote-tracking ref.
const g = gitSandbox('cusr-base-conflicts-');
afterAll(() => g.cleanup());

const commit = (dir: string, files: Record<string, string>, msg: string): string => {
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  g.sh(dir, 'add', '-A');
  g.sh(dir, 'commit', '-qm', msg);
  return g.sh(dir, 'rev-parse', 'HEAD');
};

/** A task commit off the first commit, and a base tip at refs/remotes/origin/main. */
function setup(task: Record<string, string>, base: Record<string, string>) {
  const dir = g.repo(undefined, { 'a.txt': 'one\n', 'b.txt': 'one\n' });
  const root = g.sh(dir, 'rev-parse', 'HEAD');
  const tip = commit(dir, base, 'base');
  g.sh(dir, 'update-ref', 'refs/remotes/origin/main', tip);
  g.sh(dir, 'checkout', '-q', '-b', 'task', root);
  const head = commit(dir, task, 'task');
  return { dir, head, tip };
}

describe('base conflicts of a checkpoint (#210)', () => {
  it('lists the files a merge of the base tip would conflict on', async () => {
    const { dir, head, tip } = setup(
      { 'a.txt': 'task\n', 'b.txt': 'task\n' },
      { 'a.txt': 'base\n', 'c.txt': 'new\n' },
    );
    expect(await readBaseConflicts(g.runner(), dir, 'main', head)).toEqual({
      tip_sha: tip,
      files: ['a.txt'],
    });
  });

  it('is empty when the merge is clean or the base is already in', async () => {
    const clean = setup({ 'a.txt': 'task\n' }, { 'b.txt': 'base\n' });
    expect(await readBaseConflicts(g.runner(), clean.dir, 'main', clean.head)).toEqual({
      tip_sha: clean.tip,
      files: [],
    });
    expect(await readBaseConflicts(g.runner(), clean.dir, 'main', clean.tip)).toEqual({
      tip_sha: clean.tip,
      files: [],
    });
  });

  it('is unknown without the remote-tracking ref or a readable head', async () => {
    const { dir, head } = setup({ 'a.txt': 'task\n' }, { 'a.txt': 'base\n' });
    expect(await readBaseConflicts(g.runner(), dir, 'release', head)).toBeUndefined();
    expect(await readBaseConflicts(g.runner(), dir, 'main', 'f'.repeat(40))).toBeUndefined();
  });
});
