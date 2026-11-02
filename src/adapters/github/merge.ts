/**
 * Yolo merge readiness (SPEC §14.2): an open PR on the checked head and target must be `clean`,
 * and a fresh head...target comparison must report ahead_by === 0. Protection is optional:
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

  const comparison = await port.request({
    method: 'GET',
    path: `repos/${t.repo}/compare/${t.head_sha}...${encodeURIComponent(t.target)}`,
    query: {},
    body: null,
  });
  if (!comparison.ok)
    return notReady(`compare unreadable: ${comparison.error.detail}`);
  const ahead = obj(comparison.value.body)['ahead_by'];
  if (ahead !== 0) return notReady(`compare ahead_by ${String(ahead)}`);
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
