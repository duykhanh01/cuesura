import { afterEach, describe, expect, it } from 'vitest';
import { gitSandbox, type GitSandbox } from '../../support/git-repo.ts';
import { gitRemote } from '../../support/git-remote.ts';

// The remote that goal-branch tests (007 slice E) run against: PRs into any branch, merge commits.

let git: GitSandbox | null = null;
afterEach(() => {
  git?.cleanup();
  git = null;
});

describe('git remote for goal branches', () => {
  it('opens a PR into a goal branch and merges it with a merge commit', async () => {
    git = gitSandbox('cusr-remote-');
    const r = gitRemote(git);
    const base = r.branch('goal/abc-x', 'main');
    const unit =
      (r.branch('cusr/unit-a', 'goal/abc-x'), r.commit('cusr/unit-a', { 'a.ts': 'a\n' }));
    const n = await r.openPr('cusr/unit-a', 'goal/abc-x');
    r.checks(unit, { test: 'success' });
    expect(r.github.checks.get(unit)).toEqual({ test: 'success' });
    expect(r.github.prs.find((p) => p.number === n)).toMatchObject({
      base: 'goal/abc-x',
      head: { ref: 'cusr/unit-a', sha: unit },
      merged_at: null,
    });
    const merge = r.mergePr(n);
    expect(r.head('goal/abc-x')).toBe(merge);
    // First parent is the old goal tip, second the unit's head: the unit's boundary on first-parent.
    expect(git.sh(r.url, 'rev-parse', `${merge}^1`, `${merge}^2`).split('\n')).toEqual([
      base,
      unit,
    ]);
    expect(r.github.prs.find((p) => p.number === n)).toMatchObject({
      state: 'closed',
      merge_commit: merge,
    });
    expect(r.head('main')).toBe(base);
  });
});
