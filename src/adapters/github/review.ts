/**
 * Draft → ready and the review comment on the task's PR. Both are idempotent against GitHub: the PR state
 * and a per-attempt marker in the review body are read before anything is sent, and again after a send
 * whose answer was lost.
 */
import type { ReviewEvidence } from '../../domain/state.ts';
import { renderReviewTemplate, type ReviewPlaceholder } from '../../domain/templates.ts';
import type { GitHubFailure, GitHubPort } from '../ports.ts';
import { markerCount } from '../publish-content.ts';
import { listAll, MARK_READY_MUTATION } from './gh-port.ts';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {};

export type ReadyOutcome =
  /** `ready_at`: GitHub's time of the latest draft → ready change; null when the PR never was a draft. */
  | { readonly kind: 'ready'; readonly ready_at: number | null }
  | { readonly kind: 'closed' }
  /** The PR's head is not the commit that was reviewed: left a draft; the CI wait records the drift. */
  | { readonly kind: 'head_moved'; readonly head_sha: string }
  /** The PR targets another branch than the task's: left a draft; the CI wait records the mismatch. */
  | { readonly kind: 'retargeted'; readonly base: string | null }
  | { readonly kind: 'rejected'; readonly detail: string }
  | { readonly kind: 'unknown'; readonly detail: string };

type PullState =
  | {
      draft: boolean;
      closed: boolean;
      node_id: string;
      head_sha: string;
      base: string | null;
    }
  | { error: string };

async function readPull(port: GitHubPort, repo: string, n: number): Promise<PullState> {
  const r = await port.request({
    method: 'GET',
    path: `repos/${repo}/pulls/${n}`,
    query: {},
    body: null,
  });
  if (!r.ok) return { error: r.error.detail };
  const p = obj(r.value.body);
  const head = obj(p['head'])['sha'];
  const base = obj(p['base'])['ref'];
  if (
    typeof p['draft'] !== 'boolean' ||
    typeof p['node_id'] !== 'string' ||
    typeof head !== 'string'
  )
    return { error: 'unexpected PR shape' };
  return {
    draft: p['draft'],
    closed: p['state'] === 'closed',
    node_id: p['node_id'],
    head_sha: head,
    base: typeof base === 'string' ? base : null,
  };
}

async function readyEventAt(
  port: GitHubPort,
  repo: string,
  n: number,
): Promise<number | null | { error: string }> {
  const r = await listAll(port, `repos/${repo}/issues/${n}/events`, (b) =>
    Array.isArray(b) ? b : null,
  );
  if (!r.ok) return { error: r.error.detail };
  if (!r.value.complete) return { error: 'PR events listing incomplete' };
  const at = r.value.items
    .map(obj)
    .filter((e) => e['event'] === 'ready_for_review')
    .map((e) => Date.parse(String(e['created_at'])))
    .filter((t) => Number.isFinite(t));
  return at.length === 0 ? null : Math.max(...at);
}

async function readyResult(port: GitHubPort, repo: string, n: number): Promise<ReadyOutcome> {
  const at = await readyEventAt(port, repo, n);
  return typeof at === 'object' && at !== null
    ? { kind: 'unknown', detail: `events: ${at.error}` }
    : { kind: 'ready', ready_at: at };
}

/** Read-only: whether the PR is ready (and since when), still a draft, or unreadable. Sends nothing. */
export async function probeReady(
  port: GitHubPort,
  repo: string,
  n: number,
): Promise<ReadyOutcome | { readonly kind: 'draft' }> {
  const pull = await readPull(port, repo, n);
  if ('error' in pull) return { kind: 'unknown', detail: pull.error };
  if (pull.closed) return { kind: 'closed' };
  return pull.draft ? { kind: 'draft' } : readyResult(port, repo, n);
}

/**
 * Turns the PR ready for review when it still targets the task's frozen `target` and its head is still
 * `expectedHead`, the commit that was reviewed; a PR that is ready already is left as it is.
 */
export async function markReady(
  port: GitHubPort,
  repo: string,
  n: number,
  expected: { readonly head_sha: string; readonly target: string },
): Promise<ReadyOutcome> {
  const before = await readPull(port, repo, n);
  if ('error' in before) return { kind: 'unknown', detail: before.error };
  if (before.closed) return { kind: 'closed' };
  if (!before.draft) return readyResult(port, repo, n);
  if (before.base !== expected.target) return { kind: 'retargeted', base: before.base };
  if (before.head_sha !== expected.head_sha)
    return { kind: 'head_moved', head_sha: before.head_sha };
  const r = await port.request({
    method: 'POST',
    path: 'graphql',
    query: {},
    body: { query: MARK_READY_MUTATION, variables: { id: before.node_id } },
  });
  const after = await readPull(port, repo, n);
  if ('error' in after) return { kind: 'unknown', detail: `read back: ${after.error}` };
  if (!after.draft) return readyResult(port, repo, n);
  if (!r.ok)
    return r.error.reason === 'http_error' && r.error.status !== null && r.error.status < 500
      ? { kind: 'rejected', detail: r.error.detail }
      : { kind: 'unknown', detail: r.error.detail };
  const errors = obj(r.value.body)['errors'];
  return {
    kind: 'rejected',
    detail: Array.isArray(errors)
      ? errors.map((e) => String(obj(e)['message'])).join('; ')
      : 'PR is still a draft',
  };
}

// ---- review comment ----

export type ReviewPost = {
  readonly repo: string;
  readonly pr_number: number;
  readonly commit_id: string;
  /** Hidden marker that identifies this review attempt's comment; part of the body. */
  readonly marker: string;
  /** The whole review, every finding included: one comment, nothing inline. */
  readonly body: string;
};

export type PostOutcome =
  | { readonly kind: 'posted'; readonly review_id: number | null }
  /** Nothing was sent, or the send was refused outright: posting again cannot duplicate it. */
  | { readonly kind: 'not_posted'; readonly detail: string }
  /** A send may still land although no review with the marker is seen: never sent again. */
  | { readonly kind: 'unknown'; readonly detail: string };

/** Read-only: the id of the review carrying `p.marker`, null when none, or why it could not be read. */
export async function findPosted(
  port: GitHubPort,
  p: Pick<ReviewPost, 'repo' | 'pr_number' | 'marker'>,
): Promise<number | null | { error: string }> {
  const r = await listAll(port, `repos/${p.repo}/pulls/${p.pr_number}/reviews`, (b) =>
    Array.isArray(b) ? b : null,
  );
  if (!r.ok) return { error: r.error.detail };
  const hit = r.value.items
    .map(obj)
    .find((v) => typeof v['body'] === 'string' && v['body'].includes(p.marker));
  if (hit !== undefined) return typeof hit['id'] === 'number' ? hit['id'] : null;
  return r.value.complete ? null : { error: 'review listing incomplete' };
}

/** Posts one COMMENT review for the attempt, unless its marker is on the PR already. */
export async function postReview(port: GitHubPort, p: ReviewPost): Promise<PostOutcome> {
  const seen = await findPosted(port, p);
  if (typeof seen === 'object' && seen !== null)
    return { kind: 'not_posted', detail: `probe: ${seen.error}` };
  if (seen !== null) return { kind: 'posted', review_id: seen };
  const r = await port.request({
    method: 'POST',
    path: `repos/${p.repo}/pulls/${p.pr_number}/reviews`,
    query: {},
    body: { commit_id: p.commit_id, body: p.body, event: 'COMMENT' },
  });
  if (r.ok) return { kind: 'posted', review_id: idOf(r.value.body) };
  const after = await findPosted(port, p);
  if (typeof after === 'number') return { kind: 'posted', review_id: after };
  return mayHaveLanded(r.error)
    ? { kind: 'unknown', detail: r.error.detail }
    : { kind: 'not_posted', detail: r.error.detail };
}

/** A lost answer or a server error: the review may exist now or appear later. */
function mayHaveLanded(f: GitHubFailure): boolean {
  return f.reason !== 'http_error' || f.status === null || f.status >= 500;
}

function idOf(body: unknown): number | null {
  const id = obj(body)['id'];
  return typeof id === 'number' ? id : null;
}

// ---- rendering ----

export const REVIEW_BODY_MAX = 60_000;
const HIDDEN = '[removed: contained a control marker]';

function clean(text: string): string {
  return markerCount(text) > 0 ? HIDDEN : text;
}

function findingLine(f: ReviewEvidence['findings'][number]): string {
  const where =
    f.file === undefined || f.file === ''
      ? ''
      : ` \`${clean(f.file)}${f.line === undefined ? '' : `:${f.line}`}\``;
  return `- **${clean(f.severity)}**${where}: ${clean(f.msg)}`;
}

const SEVERITY_ORDER = ['critical', 'major', 'minor', 'info'];
const BLOCKING = new Set(['critical', 'major']);

/** Blocking findings first, then the rest, each group most severe first; an empty group is left out. */
function findingsBlock(findings: ReviewEvidence['findings']): string {
  if (findings.length === 0) return 'No findings.';
  const rank = (f: ReviewEvidence['findings'][number]) => {
    const i = SEVERITY_ORDER.indexOf(f.severity);
    return i === -1 ? SEVERITY_ORDER.length : i;
  };
  const sorted = [...findings].sort((a, b) => rank(a) - rank(b));
  const group = (title: string, items: typeof sorted) =>
    items.length === 0 ? [] : [`#### ${title}\n\n${items.map(findingLine).join('\n')}`];
  return [
    ...group(
      'Blocking',
      sorted.filter((f) => BLOCKING.has(f.severity)),
    ),
    ...group(
      'Not blocking',
      sorted.filter((f) => !BLOCKING.has(f.severity)),
    ),
  ].join('\n\n');
}

export type RenderInput = {
  readonly template: string;
  readonly round: number;
  readonly review: Pick<ReviewEvidence, 'verdict' | 'findings' | 'summary' | 'sha'>;
  readonly marker: string;
};

export function renderReview(r: RenderInput): string {
  const values: Record<ReviewPlaceholder, string> = {
    round: String(r.round),
    verdict: r.review.verdict === 'approve' ? 'Approved' : 'Changes requested',
    summary: clean(r.review.summary ?? ''),
    findings: findingsBlock(r.review.findings),
    // Kept so existing templates stay valid; nothing is commented inline any more.
    inline_count: '0',
    head_sha: r.review.sha.slice(0, 7),
  };
  let text = renderReviewTemplate(r.template, values).trimEnd();
  if (text.length > REVIEW_BODY_MAX) text = `${text.slice(0, REVIEW_BODY_MAX)}\n\n… (truncated)`;
  return `${text}\n\n${r.marker}\n`;
}
