/**
 * Reads a goal branch from the remote for `verifyGoalBranch` (007, R-23): its tip, and its first-parent
 * history from the tip down to the goal's base, newest first. The one way every writer reads it, so they
 * all judge the same thing.
 */
import type { GitPort } from '../ports.ts';

/** First-parent commits read at most; a goal branch holds one merge commit per unit. */
export const GOAL_HISTORY_MAX = 1_000;

export type GoalBranchRead = {
  readonly tip: string;
  /**
   * First-parent history from the tip, newest first, up to and including `base` when it is on that
   * history; without `base` when it is not (a branch that does not grow from the goal's base).
   */
  readonly history: readonly string[];
};

/**
 * The first-parent history of `ref` from its tip, newest first, cut after `base` when `base` is on it.
 * Null when Git cannot read it.
 */
export async function firstParentHistory(
  git: GitPort,
  cwd: string,
  ref: string,
  base: string,
  timeout_ms = 60_000,
): Promise<GoalBranchRead | null> {
  const log = await git.run({
    args: ['rev-list', '--first-parent', `--max-count=${GOAL_HISTORY_MAX}`, `${ref}^{commit}`],
    cwd,
    timeout_ms,
    max_output_bytes: 1024 * 1024,
    stdin: null,
  });
  if (log.kind !== 'exited' || log.code !== 0) return null;
  const all = log.stdout.split('\n').filter((l) => l !== '');
  const tip = all[0];
  if (tip === undefined) return null;
  const at = all.indexOf(base);
  return { tip, history: at < 0 ? all : all.slice(0, at + 1) };
}

/**
 * Fetches `branch` from `remote` into `into` (a ref of this checkout only) and reads it. Null when the
 * branch cannot be read; the caller acts on nothing then.
 */
export async function readGoalBranch(
  git: GitPort,
  o: {
    readonly cwd: string;
    readonly remote: string;
    readonly branch: string;
    readonly base: string;
    readonly into: string;
    readonly timeout_ms?: number;
  },
): Promise<GoalBranchRead | null> {
  const fetched = await git.run({
    args: [
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      '--quiet',
      o.remote,
      `+refs/heads/${o.branch}:${o.into}`,
    ],
    cwd: o.cwd,
    timeout_ms: o.timeout_ms ?? 60_000,
    max_output_bytes: 64 * 1024,
    stdin: null,
  });
  if (fetched.kind !== 'exited' || fetched.code !== 0) return null;
  return firstParentHistory(git, o.cwd, o.into, o.base, o.timeout_ms);
}
