import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeGitHub } from './fake-github.ts';
import type { GitSandbox } from './git-repo.ts';

// A bare repo standing in for `origin`, with the fake GitHub reading branch heads from it (007, goal
// branches): PRs may target any branch, checks are set per SHA, and a merge writes a real merge commit
// into the base branch, as GitHub's "Create a merge commit" does.

export type GitRemote = {
  /** The bare repo; a worktree pushes here. */
  readonly url: string;
  readonly github: FakeGitHub;
  /** A clone the test commits from; it pushes to `url`. */
  readonly work: string;
  head(branch: string): string | null;
  /** Creates `branch` at `from` (a branch or SHA) on the remote. */
  branch(branch: string, from: string): string;
  /** Commits `files` on `branch` in the work clone and pushes it; returns the new head. */
  commit(branch: string, files: Record<string, string>, message?: string): string;
  /** Opens a PR from `head` into `base` through the fake's own endpoint, as the adapter would. */
  openPr(head: string, base: string, title?: string): Promise<number>;
  /** Sets the conclusion of each named check on `sha`. */
  checks(sha: string, results: Record<string, 'success' | 'failure'>): void;
  /** Merges PR `n` with a merge commit into its base and marks it merged; returns the merge commit. */
  mergePr(n: number): string;
};

export function gitRemote(git: GitSandbox, repo = 'acme/app'): GitRemote {
  const seed = git.repo('seed');
  const url = join(git.base, 'origin.git');
  git.sh(git.base, 'clone', '-q', '--bare', seed, url);
  const work = join(git.base, 'work');
  git.sh(git.base, 'clone', '-q', url, work);
  const github = new FakeGitHub(repo);
  const head = (branch: string): string | null => {
    try {
      return git.sh(url, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`);
    } catch {
      return null;
    }
  };
  github.headOf = head;
  const fetch = (): void => void git.sh(work, 'fetch', '-q', 'origin');
  return {
    url,
    github,
    work,
    head,
    branch(branch, from) {
      const sha = head(from) ?? from;
      git.sh(url, 'update-ref', `refs/heads/${branch}`, sha);
      return sha;
    },
    commit(branch, files, message = `change ${branch}`) {
      fetch();
      git.sh(work, 'checkout', '-q', '-B', branch, `origin/${branch}`);
      for (const [f, text] of Object.entries(files)) writeFileSync(join(work, f), text);
      git.sh(work, 'add', '-A');
      git.sh(work, 'commit', '-qm', message);
      git.sh(work, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
      return git.sh(work, 'rev-parse', 'HEAD');
    },
    async openPr(headRef, base, title = `${headRef} into ${base}`) {
      const r = await github.request({
        method: 'POST',
        path: `repos/${repo}/pulls`,
        query: {},
        body: { title, head: headRef, base, body: '' },
      });
      if (!r.ok || r.value.status !== 201) throw new Error(`open PR ${headRef}: failed`);
      return (r.value.body as { number: number }).number;
    },
    checks(sha, results) {
      github.checks.set(sha, { ...github.checks.get(sha), ...results });
    },
    mergePr(n) {
      const pr = github.prs.find((p) => p.number === n);
      if (pr === undefined || pr.merged_at !== null) throw new Error(`PR ${n} is not open`);
      fetch();
      git.sh(work, 'checkout', '-q', '-B', pr.base, `origin/${pr.base}`);
      git.sh(
        work,
        'merge',
        '-q',
        '--no-ff',
        '-m',
        `Merge pull request #${n}`,
        `origin/${pr.head.ref}`,
      );
      git.sh(work, 'push', '-q', 'origin', `HEAD:refs/heads/${pr.base}`);
      const sha = git.sh(work, 'rev-parse', 'HEAD');
      pr.head.sha = head(pr.head.ref) ?? pr.head.sha;
      github.merge(n, sha);
      return sha;
    },
  };
}
