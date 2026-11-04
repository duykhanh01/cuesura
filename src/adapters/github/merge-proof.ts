/**
 * Merge proof of a PR (T044, FR-040.10/12/14, contracts/github.md "API read bundle" step 2), promoted
 * from the S0.3 prototype and its live fixtures (T008: merge, squash and rebase). API 2026-03-10 has no
 * `merge_commit_sha` on pulls, so the merge commit is the `commit_id` of the PR's single `merged` issue
 * event on a complete listing. The proof is `complete` only with that commit, the merge endpoint's 204,
 * the task's target and an unchanged pull re-read; otherwise the merged fact stands but the proof is
 * incomplete, with its gaps. Nothing is inferred from a closed PR, a missing branch or a squash OID.
 */
import type { ExternalSubject, MergeProof } from '../../domain/runtime.ts';
import type { GitHubPort } from '../ports.ts';
import { listAll } from './gh-port.ts';

const SHA_RE = /^[0-9a-f]{40}$/;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export type PullFacts = {
  readonly id: number | null;
  readonly number: number | null;
  readonly state: string | null;
  readonly merged: boolean | null;
  readonly merged_at: string | null;
  readonly merge_commit_sha: string | null;
  readonly head: {
    readonly sha: string | null;
    readonly ref: string | null;
    readonly repo_id: number | null;
  };
  readonly base: {
    readonly sha: string | null;
    readonly ref: string | null;
    readonly repo_id: number | null;
  };
};

export function pullFacts(body: unknown): PullFacts {
  const b = obj(body);
  const side = (v: unknown): PullFacts['head'] => ({
    sha: str(obj(v)['sha']),
    ref: str(obj(v)['ref']),
    repo_id: num(obj(obj(v)['repo'])['id']),
  });
  return {
    id: num(b['id']),
    number: num(b['number']),
    state: str(b['state']),
    merged: typeof b['merged'] === 'boolean' ? b['merged'] : null,
    merged_at: str(b['merged_at']),
    merge_commit_sha: str(b['merge_commit_sha']),
    head: side(b['head']),
    base: side(b['base']),
  };
}

export type MergeCommitFact = {
  readonly sha: string | null;
  readonly status: 'found' | 'missing' | 'conflict' | 'invalid' | 'unknown';
  readonly basis: string;
  readonly event_id: number | null;
};

export async function readMergeCommit(
  port: GitHubPort,
  repo: string,
  n: number,
  pull: PullFacts,
): Promise<MergeCommitFact> {
  const fact = (
    status: MergeCommitFact['status'],
    basis: string,
    rest: Partial<MergeCommitFact> = {},
  ): MergeCommitFact => ({
    sha: null,
    status,
    basis,
    event_id: null,
    ...rest,
  });
  const listed = await listAll(port, `repos/${repo}/issues/${n}/events`, (b) =>
    Array.isArray(b) ? b : null,
  );
  if (!listed.ok) return fact('unknown', `issue events unreadable: ${listed.error.detail}`);
  if (!listed.value.complete) return fact('unknown', 'issue events truncated by page cap');
  const merged = listed.value.items.map(obj).filter((e) => e['event'] === 'merged');
  if (merged.length === 0) return fact('missing', 'no merged event');
  if (merged.length > 1) return fact('conflict', `${merged.length} merged events`);
  const e = merged[0] as Obj;
  const at = { event_id: num(e['id']) };
  const sha = e['commit_id'];
  if (sha === null || sha === undefined)
    return fact('missing', 'merged event has no commit_id', at);
  if (typeof sha !== 'string' || !SHA_RE.test(sha))
    return fact('invalid', 'merged event commit_id is not a 40-hex SHA', at);
  if (sha === pull.head.sha || sha === pull.base.sha)
    return fact('conflict', 'merged event commit_id equals the PR head or base SHA', at);
  let url: URL;
  try {
    const u = e['commit_url'];
    if (typeof u !== 'string')
      return fact(
        u === null || u === undefined ? 'missing' : 'invalid',
        'merged event commit_url missing or not a string',
        at,
      );
    url = new URL(u);
  } catch {
    return fact('invalid', 'merged event commit_url is not a URL', at);
  }
  if (
    url.origin !== 'https://api.github.com' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname.toLowerCase() !== `/repos/${repo}/commits/${sha}`.toLowerCase()
  ) {
    return fact('conflict', 'merged event commit_url points outside this repository', at);
  }
  if (str(e['created_at']) === null || e['created_at'] !== pull.merged_at)
    return fact('conflict', 'merged event time differs from merged_at', at);
  if (pull.merge_commit_sha !== null && pull.merge_commit_sha !== sha)
    return fact('conflict', 'merged event disagrees with merge_commit_sha', at);
  return fact('found', 'single merged event on a complete listing', {
    ...at,
    sha,
  });
}

export type MergeEvidence = {
  readonly repo_id: number | null;
  readonly pr_id: number | null;
  readonly target: string | null;
  readonly merged_at: string | null;
  /** `pulls.head.sha`, shown by T008 to equal the head at merge across merge/squash/rebase. */
  readonly head_at_merge: string | null;
  readonly merge_commit: MergeCommitFact;
  readonly merge_endpoint: 'merged_204' | 'not_merged_404_unconfirmed' | 'unknown';
  readonly completeness: 'complete' | 'incomplete';
  readonly gaps: readonly string[];
};

/** Merge endpoint, merged event and a pull re-read; any gap keeps the merged fact but marks the proof incomplete. */
export async function readMergeEvidence(
  port: GitHubPort,
  repo: string,
  n: number,
  pull: PullFacts,
  repoId: number | null,
  target: string,
): Promise<MergeEvidence> {
  const m = await port.request({
    method: 'GET',
    path: `repos/${repo}/pulls/${n}/merge`,
    query: {},
    body: null,
  });
  const endpoint =
    m.ok && m.value.status === 204
      ? 'merged_204'
      : !m.ok && m.error.status === 404
        ? 'not_merged_404_unconfirmed'
        : 'unknown';
  const commit = await readMergeCommit(port, repo, n, pull);
  const again = await port.request({
    method: 'GET',
    path: `repos/${repo}/pulls/${n}`,
    query: {},
    body: null,
  });
  const gaps: string[] = [];
  if (repoId === null || pull.id === null) gaps.push('repo or PR id missing');
  if (pull.base.ref !== target) gaps.push('target does not match the task');
  if (pull.merged_at === null || Number.isNaN(Date.parse(pull.merged_at)))
    gaps.push('merged_at missing');
  if (pull.head.sha === null || !SHA_RE.test(pull.head.sha))
    gaps.push('head sha missing or invalid');
  if (endpoint !== 'merged_204') gaps.push(`merge endpoint ${endpoint}`);
  if (commit.status !== 'found') gaps.push(`merge commit ${commit.status}: ${commit.basis}`);
  if (!again.ok) gaps.push(`pull re-read failed: ${again.error.detail}`);
  else {
    const p = pullFacts(again.value.body);
    const same =
      p.id === pull.id &&
      p.merged === true &&
      p.merged_at === pull.merged_at &&
      p.head.sha === pull.head.sha &&
      p.base.ref === pull.base.ref &&
      p.base.repo_id === pull.base.repo_id;
    if (!same) gaps.push('pull changed between merge-proof reads');
  }
  return {
    repo_id: repoId,
    pr_id: pull.id,
    target: pull.base.ref,
    merged_at: pull.merged_at,
    head_at_merge: pull.head.sha,
    merge_commit: commit,
    merge_endpoint: endpoint,
    completeness: gaps.length === 0 ? 'complete' : 'incomplete',
    gaps,
  };
}

/**
 * The domain proof, only from complete evidence for the task's subject; anything less is `null`, which
 * the caller records as unknown merge proof, never as "not merged".
 */
export function toMergeProof(
  e: MergeEvidence,
  subject: ExternalSubject,
  checkedHead: string | null,
  ids: { readonly observation_id: string; readonly evidence_ref: string },
): MergeProof | null {
  if (
    e.completeness !== 'complete' ||
    e.merge_commit.sha === null ||
    e.head_at_merge === null ||
    e.merged_at === null
  )
    return null;
  if (
    String(e.repo_id) !== subject.immutable_repo_id ||
    String(e.pr_id) !== subject.subject_id ||
    e.target !== subject.target_ref
  )
    return null;
  return {
    subject,
    merged_at: Date.parse(e.merged_at),
    merged_head_sha: e.head_at_merge,
    checked_head_sha: checkedHead,
    merge_commit_sha: e.merge_commit.sha,
    observation_id: ids.observation_id,
    evidence_ref: ids.evidence_ref,
  };
}
