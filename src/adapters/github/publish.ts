/**
 * Creating or recovering the task's PR (T041, FR-017/018, contracts/github.md).
 * A PR belongs to the task only when repo identity, head branch, head repo, base and the marker
 * (task, revision, operation key) all agree; a title or marker alone never claims a PR. Every state is
 * queried before a create, and again after any create whose answer was not a clean 201: a 422 or a
 * lost answer does not prove that nothing was created. Several matches, someone else's PR on the
 * branch, or a head that is not the pushed SHA are reported for the engine to wait on; no replacement
 * PR is opened.
 *
 * Title and body are the worker's content (M05), untrusted: any `<!-- cusr:` marker in them refuses the
 * create. Only this module appends the one canonical marker block at the end of the body, and a probe
 * accepts a PR only when that block sits there, is the only marker, and the whole body is the one this
 * operation sent (M07); a forged, duplicated or edited marker/body is a conflict to reconcile.
 */
import type { GitHubPort } from '../ports.ts';
import { hashText } from '../../shared/hash.ts';
import { markerCount, normalizeForMarker } from '../publish-content.ts';
import { listAll } from './gh-port.ts';

export type PrSpec = {
  readonly repo: string;
  readonly immutable_repo_id: string;
  readonly head_branch: string;
  readonly base: string;
  readonly head_sha: string;
  readonly title: string;
  readonly body: string;
  readonly task_id: string;
  readonly revision: number;
  readonly operation_key: string;
};

export type PrFact = {
  readonly number: number;
  readonly id: number;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly head_sha: string;
  readonly url: string | null;
};

export type PrOutcome =
  | {
      readonly kind: 'created' | 'recovered';
      readonly pr: PrFact;
      readonly body_digest: string;
    }
  /** The worker's title/body carry a control marker: nothing was sent. */
  | { readonly kind: 'content_rejected'; readonly field: 'title' | 'body' }
  /** Our PR exists but is closed or merged: the engine decides; nothing is reopened or replaced. */
  | { readonly kind: 'closed'; readonly pr: PrFact }
  | { readonly kind: 'head_changed'; readonly pr: PrFact }
  | {
      readonly kind: 'conflict';
      readonly reason:
        'multiple' | 'not_ours' | 'marker_forged' | 'body_changed';
      readonly prs: readonly number[];
    }
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly detail: string;
    }
  | { readonly kind: 'unknown'; readonly detail: string };

/** Marker line that ties a PR to one task revision and publish operation. */
export function prMarker(
  s: Pick<PrSpec, 'task_id' | 'revision' | 'operation_key'>,
): string {
  return `<!-- cusr:task=${s.task_id} revision=${s.revision} op=${s.operation_key} -->`;
}

/** The body this operation sends: the worker's body, then the one canonical marker block. */
export function finalBody(
  s: Pick<PrSpec, 'body' | 'task_id' | 'revision' | 'operation_key'>,
): string {
  return `${s.body.trimEnd()}\n\n${prMarker(s)}\n`;
}

const canon = (body: string): string => body.replace(/\r\n?/g, '\n').trimEnd();

export function bodyDigest(body: string): string {
  return hashText(canon(body));
}

/**
 * Ownership by marker: exactly one marker in the normalised body, that marker is ours, at the very end.
 * Anything else is `forged`; ours but with other text than we sent is `changed`.
 */
function markerVerdict(
  body: string,
  s: PrSpec,
): 'ours' | 'none' | 'forged' | 'changed' {
  const n = markerCount(body);
  if (n === 0) return 'none';
  const tail = normalizeForMarker(canon(body)).endsWith(
    normalizeForMarker(prMarker(s)),
  );
  if (n !== 1 || !tail || !canon(body).endsWith(prMarker(s))) return 'forged';
  return bodyDigest(body) === bodyDigest(finalBody(s)) ? 'ours' : 'changed';
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {};

function fact(v: unknown): PrFact | null {
  const p = obj(v);
  const head = obj(p['head']);
  if (
    typeof p['number'] !== 'number' ||
    typeof p['id'] !== 'number' ||
    (p['state'] !== 'open' && p['state'] !== 'closed') ||
    typeof head['sha'] !== 'string'
  )
    return null;
  return {
    number: p['number'],
    id: p['id'],
    state: p['state'],
    merged: p['merged_at'] !== null && p['merged_at'] !== undefined,
    head_sha: head['sha'],
    url: typeof p['html_url'] === 'string' ? p['html_url'] : null,
  };
}

function repoId(side: Obj): string | null {
  const id = obj(side['repo'])['id'];
  return typeof id === 'number' || typeof id === 'string' ? String(id) : null;
}

/** Same repo (by immutable ID), same head branch from that repo, same base. */
function sameTuple(v: unknown, s: PrSpec): boolean {
  const p = obj(v);
  const head = obj(p['head']);
  const base = obj(p['base']);
  return (
    head['ref'] === s.head_branch &&
    repoId(head) === s.immutable_repo_id &&
    base['ref'] === s.base &&
    repoId(base) === s.immutable_repo_id
  );
}

/** What a probe of every PR state found for the task's tuple and marker; null: no PR on the tuple. */
export type FoundPr =
  | {
      readonly kind: 'recovered';
      readonly pr: PrFact;
      readonly body_digest: string;
    }
  | Extract<
      PrOutcome,
      { kind: 'closed' | 'head_changed' | 'conflict' | 'unknown' }
    >;

/** Reads every PR on the task's head/base tuple (all states) and judges ownership; sends nothing. */
export async function findTaskPr(
  port: GitHubPort,
  s: PrSpec,
): Promise<FoundPr | null> {
  const owner = s.repo.split('/')[0] as string;
  const r = await listAll(
    port,
    `repos/${s.repo}/pulls`,
    (b) => (Array.isArray(b) ? b : null),
    {
      query: { state: 'all', head: `${owner}:${s.head_branch}`, base: s.base },
    },
  );
  if (!r.ok) return { kind: 'unknown', detail: `probe: ${r.error.detail}` };
  if (!r.value.complete)
    return { kind: 'unknown', detail: 'probe: PR listing incomplete' };
  const found = r.value.items.filter((p) => sameTuple(p, s));
  if (found.length === 0) return null;
  if (found.length > 1)
    return {
      kind: 'conflict',
      reason: 'multiple',
      prs: found.map((p) => Number(obj(p)['number'])),
    };
  const p = found[0];
  const f = fact(p);
  if (f === null)
    return { kind: 'unknown', detail: 'probe: unexpected PR shape' };
  const body =
    typeof obj(p)['body'] === 'string' ? (obj(p)['body'] as string) : '';
  const verdict = markerVerdict(body, s);
  if (verdict === 'none')
    return { kind: 'conflict', reason: 'not_ours', prs: [f.number] };
  if (verdict === 'forged')
    return { kind: 'conflict', reason: 'marker_forged', prs: [f.number] };
  if (verdict === 'changed')
    return { kind: 'conflict', reason: 'body_changed', prs: [f.number] };
  if (f.state === 'closed') return { kind: 'closed', pr: f };
  if (f.head_sha !== s.head_sha) return { kind: 'head_changed', pr: f };
  return { kind: 'recovered', pr: f, body_digest: bodyDigest(body) };
}

export async function createOrRecoverPr(
  port: GitHubPort,
  s: PrSpec,
): Promise<PrOutcome> {
  if (markerCount(s.title) > 0)
    return { kind: 'content_rejected', field: 'title' };
  if (markerCount(s.body) > 0)
    return { kind: 'content_rejected', field: 'body' };
  const existing = await findTaskPr(port, s);
  if (existing !== null) return existing;

  const body = finalBody(s);
  const r = await port.request({
    method: 'POST',
    path: `repos/${s.repo}/pulls`,
    query: {},
    body: {
      title: s.title,
      head: s.head_branch,
      base: s.base,
      body,
      maintainer_can_modify: false,
      draft: false,
    },
  });
  if (r.ok) {
    const f = fact(r.value.body);
    if (f !== null && sameTuple(r.value.body, s))
      return f.head_sha === s.head_sha
        ? { kind: 'created', pr: f, body_digest: bodyDigest(body) }
        : { kind: 'head_changed', pr: f };
  }
  // Anything but a clean, matching 201 is checked against GitHub before deciding.
  const after = await findTaskPr(port, s);
  if (after !== null)
    return after.kind === 'recovered' && r.ok
      ? { ...after, kind: 'created' }
      : after;
  if (
    !r.ok &&
    r.error.reason === 'http_error' &&
    r.error.status !== null &&
    r.error.status < 500
  )
    return { kind: 'rejected', status: r.error.status, detail: r.error.detail };
  return {
    kind: 'unknown',
    detail: r.ok ? 'created PR does not match the request' : r.error.detail,
  };
}

export type DescriptionUpdate = {
  readonly repo: string;
  readonly pr_number: number;
  /** Digest of the body this task last sent (or recovered); anything else on GitHub is someone's edit. */
  readonly expected_body_digest: string;
  readonly spec: Pick<
    PrSpec,
    'title' | 'body' | 'task_id' | 'revision' | 'operation_key'
  >;
};

export type DescriptionOutcome =
  | {
      readonly kind: 'updated' | 'already_current';
      readonly body_digest: string;
    }
  | { readonly kind: 'content_rejected'; readonly field: 'title' | 'body' }
  /** The PR body is not the one we sent: a person edited it; nothing is overwritten. */
  | { readonly kind: 'body_changed'; readonly observed_digest: string }
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly detail: string;
    }
  | { readonly kind: 'unknown'; readonly detail: string };

/** Title and body of one PR as GitHub has them now, or why they could not be read. */
export async function readPrBody(
  port: GitHubPort,
  repo: string,
  n: number,
): Promise<{ title: string; body: string } | string> {
  const r = await port.request({
    method: 'GET',
    path: `repos/${repo}/pulls/${n}`,
    query: {},
    body: null,
  });
  if (!r.ok) return r.error.detail;
  const p = obj(r.value.body);
  if (typeof p['number'] !== 'number') return 'unexpected PR shape';
  return {
    title: typeof p['title'] === 'string' ? p['title'] : '',
    body: typeof p['body'] === 'string' ? p['body'] : '',
  };
}

/**
 * Replaces title/description of the task's PR with new worker content (M05/M07, contracts/github.md
 * "Update PR description"). GitHub has no compare-and-swap on a body, so the current body is read first
 * and must still be the one this task sent; after a lost answer the PR is read again and only the new
 * body proves the update. A body someone else edited is reported, never overwritten.
 */
export async function updatePrDescription(
  port: GitHubPort,
  u: DescriptionUpdate,
): Promise<DescriptionOutcome> {
  if (markerCount(u.spec.title) > 0)
    return { kind: 'content_rejected', field: 'title' };
  if (markerCount(u.spec.body) > 0)
    return { kind: 'content_rejected', field: 'body' };
  const next = finalBody(u.spec);
  const want = bodyDigest(next);
  const before = await readPrBody(port, u.repo, u.pr_number);
  if (typeof before === 'string')
    return { kind: 'unknown', detail: `read: ${before}` };
  const current = bodyDigest(before.body);
  if (current === want && before.title === u.spec.title)
    return { kind: 'already_current', body_digest: want };
  if (current !== u.expected_body_digest)
    return { kind: 'body_changed', observed_digest: current };
  const r = await port.request({
    method: 'PATCH',
    path: `repos/${u.repo}/pulls/${u.pr_number}`,
    query: {},
    body: { title: u.spec.title, body: next },
  });
  if (r.ok) return { kind: 'updated', body_digest: want };
  const after = await readPrBody(port, u.repo, u.pr_number);
  if (typeof after === 'string')
    return {
      kind: 'unknown',
      detail: `update: ${r.error.detail}; read: ${after}`,
    };
  const seen = bodyDigest(after.body);
  if (seen === want) return { kind: 'updated', body_digest: want };
  if (seen !== u.expected_body_digest)
    return { kind: 'body_changed', observed_digest: seen };
  if (
    r.error.reason === 'http_error' &&
    r.error.status !== null &&
    r.error.status < 500
  )
    return { kind: 'rejected', status: r.error.status, detail: r.error.detail };
  return { kind: 'unknown', detail: r.error.detail };
}
