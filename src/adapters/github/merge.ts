/**
 * Yolo merge readiness (SPEC §14.2): an open PR on the checked head and target must be `clean` or
 * `unstable`, and a fresh head...target comparison must report ahead_by === 0. Protection is optional:
 * GitHub may enforce additional rules at merge time; the daemon checks CI and pinned apps itself.
 * The request carries the checked
 * head as `sha` and the worker's validated squash message; the next observation learns the outcome.
 * Without protection, target/check changes between the reads and merge remain a race.
 */
import type { MergeMethod } from '../../domain/merge-method.ts';
import type { GitHubPort } from '../ports.ts';
import { pullFacts } from './merge-proof.ts';

export type MergeTarget = {
  readonly repo: string;
  readonly pr_number: number;
  readonly target: string;
  readonly head_sha: string;
};

export type MergeReadiness =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly reason: string;
      readonly base_sha?: string;
    };

type Obj = Readonly<Record<string, unknown>>;
const obj = (v: unknown): Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {};
const notReady = (reason: string): MergeReadiness => ({ ready: false, reason });

export async function readMergeReadiness(
  port: GitHubPort,
  t: MergeTarget,
): Promise<MergeReadiness> {
  const pull = await port.request({
    method: 'GET',
    path: `repos/${t.repo}/pulls/${t.pr_number}`,
    query: {},
    body: null,
  });
  if (!pull.ok) return notReady(`pull unreadable: ${pull.error.detail}`);
  const facts = pullFacts(pull.value.body);
  if (facts.state !== 'open' || facts.merged !== false) return notReady('pull is not open');
  if (facts.base.ref !== t.target) return notReady('target does not match');
  if (facts.head.sha !== t.head_sha) return notReady('head does not match');
  const state = obj(pull.value.body)['mergeable_state'];
  if (state !== 'clean' && state !== 'unstable' && state !== 'behind' && state !== 'dirty')
    return notReady(`mergeable_state ${String(state)}`);

  // pull.base.sha is the PR's base snapshot, not necessarily the branch's current tip.
  const branch = await port.request({
    method: 'GET',
    path: `repos/${t.repo}/branches/${encodeURIComponent(t.target)}`,
    query: {},
    body: null,
  });
  if (!branch.ok) return notReady(`target tip unreadable: ${branch.error.detail}`);
  const tip = obj(obj(branch.value.body)['commit'])['sha'];
  if (typeof tip !== 'string' || !/^[0-9a-f]{40}$/.test(tip))
    return notReady('target tip missing or invalid');

  const comparison = await port.request({
    method: 'GET',
    path: `repos/${t.repo}/compare/${t.head_sha}...${tip}`,
    // GitHub returns changed files only on page 1; totals remain available on page 2.
    query: { per_page: '1', page: '2' },
    body: null,
  });
  if (!comparison.ok) return notReady(`compare unreadable: ${comparison.error.detail}`);
  const ahead = obj(comparison.value.body)['ahead_by'];
  if (typeof ahead === 'number' && Number.isSafeInteger(ahead) && ahead > 0)
    return {
      ready: false,
      reason: `compare ahead_by ${ahead}`,
      base_sha: tip,
    };
  if (ahead !== 0) return notReady(`compare ahead_by ${String(ahead)}`);
  // `unstable` only means a check outside the required set is failing or pending; the caller verifies
  // that the required set is non-empty and green before merging.
  if (state !== 'clean' && state !== 'unstable')
    return notReady(`mergeable_state ${String(state)}`);
  return { ready: true };
}

export type MergeSent =
  | { readonly kind: 'merged' }
  | { readonly kind: 'refused'; readonly detail: string }
  /** The answer was lost: the merge may have happened, and only an observation can tell. */
  | { readonly kind: 'unknown'; readonly detail: string };

/** A squash commit's title and message from the worker's validated commit message (SPEC §14.2). */
export function squashMessage(message: string): {
  commit_title: string;
  commit_message: string;
} {
  const [title = '', ...rest] = message.split('\n');
  return {
    commit_title: title.trim(),
    commit_message: rest.join('\n').trim(),
  };
}

export async function sendMerge(
  port: GitHubPort,
  t: MergeTarget,
  method: MergeMethod,
  message: string,
): Promise<MergeSent> {
  const r = await port.request({
    method: 'PUT',
    path: `repos/${t.repo}/pulls/${t.pr_number}/merge`,
    query: {},
    body: {
      sha: t.head_sha,
      merge_method: method,
      ...(method === 'squash' ? squashMessage(message) : {}),
    },
  });
  if (r.ok) return { kind: 'merged' };
  return r.error.reason === 'unknown'
    ? { kind: 'unknown', detail: r.error.detail }
    : { kind: 'refused', detail: r.error.detail };
}
