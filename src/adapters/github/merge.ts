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
import { CONFIRM_PULL_QUERY } from './gh-port.ts';

export type MergeTarget = {
  readonly repo: string;
  readonly pr_number: number;
  readonly target: string;
  readonly head_sha: string;
};

export type MergeReadiness =
  /** `tip`: the target branch tip the head was compared with. */
  | { readonly ready: true; readonly tip?: string }
  | {
      readonly ready: false;
      readonly reason: string;
      readonly base_sha?: string;
      readonly tip?: string;
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
  // GitHub refuses to merge a draft (HTTP 405), whatever its mergeable_state says.
  if (facts.draft !== false)
    return notReady(facts.draft === true ? 'pull is a draft' : 'pull draft state unknown');
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
  if (!comparison.ok) return { ...notReady(`compare unreadable: ${comparison.error.detail}`), tip };
  const ahead = obj(comparison.value.body)['ahead_by'];
  if (typeof ahead === 'number' && Number.isSafeInteger(ahead) && ahead > 0)
    return {
      ready: false,
      reason: `compare ahead_by ${ahead}`,
      base_sha: tip,
      tip,
    };
  if (ahead !== 0) return { ...notReady(`compare ahead_by ${String(ahead)}`), tip };
  // `unstable` only means a check outside the required set is failing or pending; the caller verifies
  // that the required set is non-empty and green before merging.
  if (state !== 'clean' && state !== 'unstable')
    return { ...notReady(`mergeable_state ${String(state)}`), tip };
  return { ready: true, tip };
}

/** What the last check before a merge approval read, or why it could not. */
export type PullConfirmation =
  | { readonly ok: true; readonly tip: string | null }
  /** `tip` only when the PR still targets `t.target`: the tip of that branch, read with the PR. */
  | { readonly ok: false; readonly reason: string; readonly tip: string | null };

/**
 * The PR as the approval is about to bind it: open, not a draft, on `t.target` with head `t.head_sha`,
 * and the tip of `t.target`, all from one GraphQL answer. Read last, so no other read can stand between
 * it and the approval; GitHub's own merge check is the only one after it. Anything missing fails closed.
 */
export async function confirmPull(port: GitHubPort, t: MergeTarget): Promise<PullConfirmation> {
  const [owner, name] = t.repo.split('/');
  const r = await port.request({
    method: 'POST',
    path: 'graphql',
    query: {},
    body: { query: CONFIRM_PULL_QUERY, variables: { owner, name, number: t.pr_number } },
  });
  if (!r.ok) return { ok: false, reason: `pull unreadable: ${r.error.detail}`, tip: null };
  // GraphQL may answer 200 with errors beside partial data: none of that data is trusted.
  const errors = obj(r.value.body)['errors'];
  if (Array.isArray(errors) && errors.length > 0)
    return { ok: false, reason: 'pull unreadable: GraphQL errors', tip: null };
  const pr = obj(obj(obj(obj(r.value.body)['data'])['repository'])['pullRequest']);
  const state = pr['state'];
  const draft = pr['isDraft'];
  const head = pr['headRefOid'];
  const base = pr['baseRefName'];
  const oid = obj(obj(pr['baseRef'])['target'])['oid'];
  if (typeof state !== 'string' || typeof draft !== 'boolean' || typeof head !== 'string')
    return { ok: false, reason: 'pull unreadable: answer incomplete', tip: null };
  if (base !== t.target) return { ok: false, reason: 'target does not match', tip: null };
  const tip = typeof oid === 'string' && /^[0-9a-f]{40}$/.test(oid) ? oid : null;
  if (state !== 'OPEN') return { ok: false, reason: 'pull is not open', tip };
  if (draft) return { ok: false, reason: 'pull is a draft', tip };
  if (head !== t.head_sha) return { ok: false, reason: 'head does not match', tip };
  return { ok: true, tip };
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
