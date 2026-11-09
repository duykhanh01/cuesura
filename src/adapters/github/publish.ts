/**
 * Creating or recovering the task's PR (T041, FR-017/018, contracts/github.md).
 * A PR belongs to the task only when repo identity, head branch, head repo, base and the marker
 * (task, revision, operation key) all agree; a title or marker alone never claims a PR. Every state is
 * queried before a create, and again after any create whose answer was not a clean 201: a 422 or a
 * lost answer does not prove that nothing was created. Several matches, a closed or edited PR on
 * the branch, or a head that is not the pushed SHA are reported for the engine to wait on; no
 * replacement PR is opened. An open PR without any marker on the task's own branch whose head is the
 * pushed SHA is one a worker opened for this task: the create takes it over by writing the title, body
 * and marker, as it would have sent them.
 *
 * Title and body are the worker's content (M05), untrusted: any `<!-- cusr:` marker in them refuses the
 * create. Only this module appends the one canonical marker block at the end of the body, and a probe
 * accepts a PR only when that block sits there, is the only marker, and the whole body is the one this
 * operation sent (M07); a forged, duplicated or edited marker/body is a conflict to reconcile.
 *
 * A 422 that names the title or body (too long, blank) is the content's fault, not the credentials'
 * (#249): the content is fitted to GitHub's limits once (`fitContent`) and sent again; a second refusal
 * is `content_invalid`. A probe accepts the fitted body as well, so a later probe of the same operation
 * still finds the PR it created.
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
  /** Open as a draft: the workflow turns it ready later (after review). */
  readonly draft?: boolean;
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
      /** Set when the PR carries the marker of an earlier create of the same task revision (#267). */
      readonly operation_key?: string;
    }
  /** The worker's title/body carry a control marker: nothing was sent. */
  | { readonly kind: 'content_rejected'; readonly field: 'title' | 'body' }
  /** Our PR exists but is closed or merged: the engine decides; nothing is reopened or replaced. */
  | { readonly kind: 'closed'; readonly pr: PrFact }
  | { readonly kind: 'head_changed'; readonly pr: PrFact }
  | {
      readonly kind: 'conflict';
      readonly reason: 'multiple' | 'not_ours' | 'marker_forged' | 'body_changed';
      readonly prs: readonly number[];
    }
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly detail: string;
    }
  /** GitHub refused the title/body even after they were fitted to its limits. */
  | { readonly kind: 'content_invalid'; readonly detail: string }
  | { readonly kind: 'unknown'; readonly detail: string };

/** Marker line that ties a PR to one task revision and publish operation. */
export function prMarker(s: Pick<PrSpec, 'task_id' | 'revision' | 'operation_key'>): string {
  return `<!-- cusr:task=${s.task_id} revision=${s.revision} op=${s.operation_key} -->`;
}

/** The body this operation sends: the worker's body, then the one canonical marker block. */
export function finalBody(
  s: Pick<PrSpec, 'body' | 'task_id' | 'revision' | 'operation_key'>,
): string {
  return `${s.body.trimEnd()}\n\n${prMarker(s)}\n`;
}

/** GitHub's limits on a PR title and description, in characters. */
export const GITHUB_TITLE_MAX = 256;
export const GITHUB_BODY_MAX = 65_536;
const TRUNCATED_NOTE = `\n\n_(truncated by cusr: a GitHub PR description holds at most ${GITHUB_BODY_MAX} characters)_`;

type ContentSpec = Pick<PrSpec, 'title' | 'body' | 'task_id' | 'revision' | 'operation_key'>;

/** Cuts `text` to at most `max` UTF-16 units without splitting a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/**
 * The title and body made to fit GitHub's limits: control characters out of the title, a blank title
 * named after the task, NUL out of the body and the body cut so that the final body with its marker
 * fits. Content within the limits is returned unchanged; fitting fitted content changes nothing.
 */
export function fitContent<T extends ContentSpec>(s: T): T {
  const title =
    cut(s.title.replace(/\p{Cc}/gu, ' ').trim(), GITHUB_TITLE_MAX) || `cusr task ${s.task_id}`;
  let body = s.body.replace(/\0/g, '');
  if (finalBody({ ...s, body }).length > GITHUB_BODY_MAX) {
    const marker = finalBody({ ...s, body: '' }).length;
    body = cut(body, GITHUB_BODY_MAX - marker - TRUNCATED_NOTE.length).trimEnd() + TRUNCATED_NOTE;
  }
  return title === s.title && body === s.body ? s : { ...s, title, body };
}

/** A 422 whose validation errors name the title or the body. */
function contentRefusal(e: { status: number | null; body?: unknown }): boolean {
  if (e.status !== 422) return false;
  const errors = obj(e.body)['errors'];
  return (
    Array.isArray(errors) &&
    errors.some((x) => obj(x)['field'] === 'title' || obj(x)['field'] === 'body')
  );
}

const canon = (body: string): string => body.replace(/\r\n?/g, '\n').trimEnd();

export function bodyDigest(body: string): string {
  return hashText(canon(body));
}

/**
 * Ownership by marker: exactly one marker in the normalised body, that marker is ours, at the very end.
 * Anything else is `forged`; ours but with other text than we sent is `changed`.
 */
function markerVerdict(body: string, s: PrSpec): 'ours' | 'none' | 'forged' | 'changed' {
  const n = markerCount(body);
  if (n === 0) return 'none';
  const tail = normalizeForMarker(canon(body)).endsWith(normalizeForMarker(prMarker(s)));
  if (n !== 1 || !tail || !canon(body).endsWith(prMarker(s))) return 'forged';
  const digest = bodyDigest(body);
  return digest === bodyDigest(finalBody(s)) || digest === bodyDigest(finalBody(fitContent(s)))
    ? 'ours'
    : 'changed';
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
      readonly operation_key?: string;
    }
  /** Open, no marker at all, head at the pushed SHA: a worker opened it; the create takes it over. */
  | { readonly kind: 'unclaimed'; readonly pr: PrFact }
  | Extract<PrOutcome, { kind: 'closed' | 'head_changed' | 'conflict' | 'unknown' }>;

/** Reads every PR on the task's head/base tuple (all states) and judges ownership; sends nothing. */
export async function findTaskPr(port: GitHubPort, s: PrSpec): Promise<FoundPr | null> {
  const owner = s.repo.split('/')[0] as string;
  const r = await listAll(port, `repos/${s.repo}/pulls`, (b) => (Array.isArray(b) ? b : null), {
    query: { state: 'all', head: `${owner}:${s.head_branch}`, base: s.base },
  });
  if (!r.ok) return { kind: 'unknown', detail: `probe: ${r.error.detail}` };
  if (!r.value.complete) return { kind: 'unknown', detail: 'probe: PR listing incomplete' };
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
  if (f === null) return { kind: 'unknown', detail: 'probe: unexpected PR shape' };
  const body = typeof obj(p)['body'] === 'string' ? (obj(p)['body'] as string) : '';
  let verdict = markerVerdict(body, s);
  // A retry of the create runs under a new operation key; the marker of an earlier create of the same
  // task revision is still this task's own (#267).
  const earlier = verdict === 'forged' ? earlierOperation(body, s) : null;
  if (earlier !== null) verdict = markerVerdict(body, { ...s, operation_key: earlier });
  if (verdict === 'none')
    return f.state === 'open' && !f.merged && f.head_sha === s.head_sha
      ? { kind: 'unclaimed', pr: f }
      : { kind: 'conflict', reason: 'not_ours', prs: [f.number] };
  if (verdict === 'forged') return { kind: 'conflict', reason: 'marker_forged', prs: [f.number] };
  if (verdict === 'changed') return { kind: 'conflict', reason: 'body_changed', prs: [f.number] };
  if (f.state === 'closed') return { kind: 'closed', pr: f };
  if (f.head_sha !== s.head_sha) return { kind: 'head_changed', pr: f };
  return {
    kind: 'recovered',
    pr: f,
    body_digest: bodyDigest(body),
    ...(earlier === null ? {} : { operation_key: earlier }),
  };
}

/** The operation key of a single marker of the same task and revision under another key, else null. */
function earlierOperation(body: string, s: PrSpec): string | null {
  if (markerCount(body) !== 1) return null;
  const m = /<!-- cusr:task=(\S+) revision=(\d+) op=(\S+) -->$/.exec(canon(body));
  if (m === null || m[1] !== s.task_id || Number(m[2]) !== s.revision) return null;
  return m[3] === s.operation_key ? null : (m[3] as string);
}

export async function createOrRecoverPr(port: GitHubPort, s: PrSpec): Promise<PrOutcome> {
  const first = await createOnce(port, s);
  if (first.kind !== 'rejected' || !first.content) return first;
  const fitted = fitContent(s);
  const second = fitted === s ? first : await createOnce(port, fitted);
  if (second.kind !== 'rejected') return second;
  return second.content
    ? { kind: 'content_invalid', detail: second.detail }
    : { kind: 'rejected', status: second.status, detail: second.detail };
}

type CreateOnce =
  | Exclude<PrOutcome, { kind: 'rejected' }>
  | (Extract<PrOutcome, { kind: 'rejected' }> & { readonly content: boolean });

async function createOnce(port: GitHubPort, s: PrSpec): Promise<CreateOnce> {
  if (markerCount(s.title) > 0) return { kind: 'content_rejected', field: 'title' };
  if (markerCount(s.body) > 0) return { kind: 'content_rejected', field: 'body' };
  const existing = await findTaskPr(port, s);
  if (existing?.kind === 'unclaimed') return takeOver(port, s, existing.pr);
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
      draft: s.draft === true,
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
  if (after?.kind === 'unclaimed') return takeOver(port, s, after.pr);
  if (after !== null)
    return after.kind === 'recovered' && r.ok ? { ...after, kind: 'created' } : after;
  if (!r.ok && r.error.reason === 'http_error' && r.error.status !== null && r.error.status < 500)
    return {
      kind: 'rejected',
      status: r.error.status,
      detail: r.error.detail,
      content: contentRefusal(r.error),
    };
  return {
    kind: 'unknown',
    detail: r.ok ? 'created PR does not match the request' : r.error.detail,
  };
}

/** Writes this operation's title, body and marker onto a PR a worker opened; GitHub then decides. */
async function takeOver(port: GitHubPort, s: PrSpec, pr: PrFact): Promise<CreateOnce> {
  const body = finalBody(s);
  const r = await port.request({
    method: 'PATCH',
    path: `repos/${s.repo}/pulls/${pr.number}`,
    query: {},
    body: { title: s.title, body },
  });
  const after = await findTaskPr(port, s);
  if (after?.kind === 'recovered') return { ...after, kind: 'created' };
  if (after !== null && after.kind !== 'unclaimed') return after;
  // The PR is still unclaimed, so GitHub's refusal is the answer: a content 422 goes to the retry.
  if (!r.ok && r.error.reason === 'http_error' && r.error.status !== null && r.error.status < 500)
    return {
      kind: 'rejected',
      status: r.error.status,
      detail: r.error.detail,
      content: contentRefusal(r.error),
    };
  return {
    kind: 'unknown',
    detail: r.ok ? 'taken-over PR does not carry the marker' : r.error.detail,
  };
}

export type DescriptionUpdate = {
  readonly repo: string;
  readonly pr_number: number;
  /** Digest of the body this task last sent (or recovered); anything else on GitHub is someone's edit. */
  readonly expected_body_digest: string;
  readonly spec: Pick<PrSpec, 'title' | 'body' | 'task_id' | 'revision' | 'operation_key'>;
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
  | { readonly kind: 'content_invalid'; readonly detail: string }
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
  const first = await updateOnce(port, u);
  if (first.kind !== 'rejected' || !first.content) return first;
  const fitted = fitContent(u.spec);
  const second = fitted === u.spec ? first : await updateOnce(port, { ...u, spec: fitted });
  if (second.kind !== 'rejected') return second;
  return second.content
    ? { kind: 'content_invalid', detail: second.detail }
    : { kind: 'rejected', status: second.status, detail: second.detail };
}

type UpdateOnce =
  | Exclude<DescriptionOutcome, { kind: 'rejected' }>
  | (Extract<DescriptionOutcome, { kind: 'rejected' }> & { readonly content: boolean });

async function updateOnce(port: GitHubPort, u: DescriptionUpdate): Promise<UpdateOnce> {
  if (markerCount(u.spec.title) > 0) return { kind: 'content_rejected', field: 'title' };
  if (markerCount(u.spec.body) > 0) return { kind: 'content_rejected', field: 'body' };
  const next = finalBody(u.spec);
  const want = bodyDigest(next);
  const before = await readPrBody(port, u.repo, u.pr_number);
  if (typeof before === 'string') return { kind: 'unknown', detail: `read: ${before}` };
  const current = bodyDigest(before.body);
  if (current === want && before.title === u.spec.title)
    return { kind: 'already_current', body_digest: want };
  if (current !== u.expected_body_digest) return { kind: 'body_changed', observed_digest: current };
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
  if (seen !== u.expected_body_digest) return { kind: 'body_changed', observed_digest: seen };
  if (r.error.reason === 'http_error' && r.error.status !== null && r.error.status < 500)
    return {
      kind: 'rejected',
      status: r.error.status,
      detail: r.error.detail,
      content: contentRefusal(r.error),
    };
  return { kind: 'unknown', detail: r.error.detail };
}
