/**
 * The daemon's merge of a yolo task's PR (SPEC §14.2). Two reads say whether GitHub itself would enforce
 * what the merge relies on: the PR is `clean` on the head the task checked, and the target's classic
 * protection requires up-to-date branches and applies to admins, since the daemon merges with the owner's
 * account. Anything unreadable or different is "not ready". The merge carries the checked head as `sha`,
 * so GitHub refuses it if the head moved; the outcome is learned from the next observation of the PR.
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
  { readonly ready: true } | { readonly ready: false; readonly reason: string };

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
  if (facts.state !== 'open' || facts.merged !== false)
    return notReady('pull is not open');
  if (facts.base.ref !== t.target) return notReady('target does not match');
  if (facts.head.sha !== t.head_sha) return notReady('head does not match');
  const state = obj(pull.value.body)['mergeable_state'];
  if (state !== 'clean') return notReady(`mergeable_state ${String(state)}`);

  const protection = await port.request({
    method: 'GET',
    path: `repos/${t.repo}/branches/${encodeURIComponent(t.target)}/protection`,
    query: {},
    body: null,
  });
  if (!protection.ok)
    return notReady(`protection unreadable: ${protection.error.detail}`);
  const body = obj(protection.value.body);
  if (obj(body['required_status_checks'])['strict'] !== true)
    return notReady('protection does not require up-to-date branches');
  if (obj(body['enforce_admins'])['enabled'] !== true)
    return notReady('protection does not apply to admins');
  return { ready: true };
}

export type MergeSent =
  | { readonly kind: 'merged' }
  | { readonly kind: 'refused'; readonly detail: string }
  /** The answer was lost: the merge may have happened, and only an observation can tell. */
  | { readonly kind: 'unknown'; readonly detail: string };

export async function sendMerge(
  port: GitHubPort,
  t: MergeTarget,
  method: MergeMethod,
): Promise<MergeSent> {
  const r = await port.request({
    method: 'PUT',
    path: `repos/${t.repo}/pulls/${t.pr_number}/merge`,
    query: {},
    body: { sha: t.head_sha, merge_method: method },
  });
  if (r.ok) return { kind: 'merged' };
  return r.error.reason === 'unknown'
    ? { kind: 'unknown', detail: r.error.detail }
    : { kind: 'refused', detail: r.error.detail };
}
