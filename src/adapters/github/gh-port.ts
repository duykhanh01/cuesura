/**
 * GitHub through the pinned `gh` binary (T040, contracts/github.md), checked against archived T008
 * fixtures. `gh api` runs by argv without a shell, with the pinned API version, an
 * endpoint allowlist, and caps on time, bytes, pages, calls and sends. The credential stays in the
 * orchestrator's environment; nothing here is mounted into a sandbox.
 *
 * The writes are creating a PR, turning the task's draft PR ready, posting a COMMENT review, re-running
 * failed jobs, editing a PR's text and yolo's merge of a named head. A GET may be resent inside the round window; a write is sent once, and a write whose outcome
 * cannot be read back is `unknown` (it may have been applied), so the caller probes before any new send.
 */
import { spawn } from 'node:child_process';
import type { Clock, GitHubFailure, GitHubPort, GitHubRequest, GitHubResponse } from '../ports.ts';
import { operationEnv } from '../../runner/process-tag.ts';
import type { Redactor } from '../../runner/redact.ts';
import type { Hash } from '../../shared/brand.ts';
import { canonicalJson } from '../../shared/canonical-json.ts';
import { hashText } from '../../shared/hash.ts';
import { err, ok, type Result } from '../../shared/result.ts';

export const API_VERSION = '2026-03-10';

export const DEFAULT_GH_LIMITS = {
  call_timeout_ms: 30_000,
  round_ms: 60_000,
  max_calls: 100,
  max_pages: 20,
  per_page: 100,
  max_response_bytes: 2 * 1024 * 1024,
  max_sends: 3,
} as const;
export type GhLimits = {
  -readonly [K in keyof typeof DEFAULT_GH_LIMITS]: number;
};

const SEG = '[A-Za-z0-9_.-]+';
const BRANCH = '[A-Za-z0-9_.%/-]+';
// The exact checked commit SHA, followed by one encoded branch name. No raw path separators.
const COMPARE_BRANCH = '(?!\\.)(?:[A-Za-z0-9_-]|\\.(?!\\.)|%[0-9A-Fa-f]{2})+';
const REPO = `repos/${SEG}/${SEG}`;

/** Read endpoints. Nothing else is reachable with GET, whatever the caller passes. */
export const GET_ENDPOINTS: readonly RegExp[] = [
  new RegExp(`^${REPO}$`),
  new RegExp(`^${REPO}/pulls$`),
  new RegExp(`^${REPO}/pulls/\\d+$`),
  new RegExp(`^${REPO}/pulls/\\d+/merge$`),
  new RegExp(`^${REPO}/pulls/\\d+/reviews$`),
  new RegExp(`^${REPO}/issues/\\d+/events$`),
  new RegExp(`^${REPO}/branches/${BRANCH}$`),
  new RegExp(`^${REPO}/branches/${BRANCH}/protection$`),
  new RegExp(`^${REPO}/rules/branches/${BRANCH}$`),
  new RegExp(`^${REPO}/rulesets/\\d+$`),
  new RegExp(`^${REPO}/commits/[0-9a-f]{40}/(check-runs|statuses)$`),
  new RegExp(`^${REPO}/compare/[0-9a-f]{40}\\.\\.\\.${COMPARE_BRANCH}$`),
  new RegExp(`^${REPO}/actions/runs/\\d+$`),
];

/**
 * The only POSTs: open a PR, post a COMMENT review on it, re-run the failed jobs of one workflow run, and
 * the one GraphQL mutation that turns a draft PR ready. Never merge.
 */
export const POST_ENDPOINTS: readonly RegExp[] = [
  new RegExp(`^${REPO}/pulls$`),
  new RegExp(`^${REPO}/pulls/\\d+/reviews$`),
  new RegExp(`^${REPO}/actions/runs/\\d+/rerun-failed-jobs$`),
  /^graphql$/,
];
/** The only GraphQL document the port lets through. */
export const MARK_READY_MUTATION =
  'mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }';

const REVIEW_FIELDS = new Set(['commit_id', 'body', 'event', 'comments']);
const REVIEW_COMMENT_FIELDS = new Set(['path', 'line', 'side', 'body']);

/** A review only comments: never APPROVE or REQUEST_CHANGES, which would act on the PR's merge state. */
function validReviewBody(body: unknown): boolean {
  const b = obj(body);
  const comments = b['comments'];
  return (
    Object.keys(b).every((k) => REVIEW_FIELDS.has(k)) &&
    b['event'] === 'COMMENT' &&
    typeof b['body'] === 'string' &&
    (comments === undefined ||
      (Array.isArray(comments) &&
        comments.every((c) => Object.keys(obj(c)).every((k) => REVIEW_COMMENT_FIELDS.has(k)))))
  );
}

/** GraphQL is reachable for exactly one document: marking a pull request ready for review. */
function validGraphqlBody(body: unknown): boolean {
  const b = obj(body);
  const vars = obj(b['variables']);
  return (
    Object.keys(b).every((k) => k === 'query' || k === 'variables') &&
    b['query'] === MARK_READY_MUTATION &&
    Object.keys(vars).length === 1 &&
    typeof vars['id'] === 'string'
  );
}

function obj(v: unknown): Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** The one edit: title/description of a PR (M05/M07); never state, base, head or merge settings. */
export const PATCH_ENDPOINTS: readonly RegExp[] = [new RegExp(`^${REPO}/pulls/\\d+$`)];
const PATCH_FIELDS = new Set(['title', 'body']);

/** Yolo's merge (SPEC §14.2): of a named head, with its method and squash message and nothing else. */
export const PUT_ENDPOINTS: readonly RegExp[] = [new RegExp(`^${REPO}/pulls/\\d+/merge$`)];
const MERGE_FIELDS = new Set(['sha', 'merge_method', 'commit_title', 'commit_message']);

function validMergeBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Readonly<Record<string, unknown>>;
  const squash = b['merge_method'] === 'squash';
  return (
    Object.keys(b).every((k) => MERGE_FIELDS.has(k)) &&
    typeof b['sha'] === 'string' &&
    /^[0-9a-f]{40}$/.test(b['sha']) &&
    (squash
      ? typeof b['commit_title'] === 'string' &&
        b['commit_title'] !== '' &&
        typeof b['commit_message'] === 'string'
      : (b['merge_method'] === 'merge' || b['merge_method'] === 'rebase') &&
        b['commit_title'] === undefined &&
        b['commit_message'] === undefined)
  );
}

const QUERY_KEYS = new Set(['per_page', 'page', 'state', 'head', 'base', 'sort', 'direction']);
const KEEP_HEADERS = new Set([
  'etag',
  'link',
  'retry-after',
  'date',
  'x-github-request-id',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-resource',
  'x-github-api-version-selected',
]);

export type GhExecResult = {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly overflow: boolean;
};
export type GhExec = (
  args: readonly string[],
  opts: {
    readonly timeoutMs: number;
    readonly maxBytes: number;
    readonly stdin: string | null;
  },
) => Promise<GhExecResult>;

/** Variables `gh` may see; the token comes from the orchestrator, never from a repo or agent. */
export const GH_ENV_PASS = [
  'PATH',
  'HOME',
  'GH_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
  'XDG_CONFIG_HOME',
] as const;

/** Real gh via spawn (no shell), its process group killed on timeout or overflow. */
export function spawnGhExec(gh: string, env: NodeJS.ProcessEnv): GhExec {
  if (!gh.startsWith('/')) throw new Error(`gh must be an absolute path: ${gh}`);
  const childEnv: Record<string, string> = {
    GH_PROMPT_DISABLED: '1',
    GH_PAGER: 'cat',
    PAGER: 'cat',
    NO_COLOR: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_SPINNER_DISABLED: '1',
    CLICOLOR: '0',
    LANG: 'C',
  };
  for (const k of GH_ENV_PASS) if (env[k] !== undefined) childEnv[k] = env[k];
  return (args, opts) =>
    new Promise((resolve) => {
      const child = spawn(gh, [...args], {
        env: { ...childEnv, ...operationEnv() },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderr = '';
      let timedOut = false;
      let overflow = false;
      const kill = (): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMs);
      child.stdout.on('data', (b: Buffer) => {
        bytes += b.length;
        if (bytes > opts.maxBytes) {
          if (!overflow) kill();
          overflow = true;
          return;
        }
        chunks.push(b);
      });
      child.stderr.on('data', (b: Buffer) => {
        if (stderr.length < 8_192) stderr += b.toString('utf8');
      });
      child.once('error', (e) => {
        clearTimeout(timer);
        resolve({
          code: null,
          stdout: Buffer.alloc(0),
          stderr: e.message,
          timedOut,
          overflow,
        });
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({
          code,
          stdout: Buffer.concat(chunks),
          stderr,
          timedOut,
          overflow,
        });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.stdin ?? undefined);
    });
}

export type GhEvidence = {
  readonly seq: number;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  readonly path: string;
  readonly send: number;
  readonly status: number | null;
  readonly outcome:
    | 'ok'
    | 'http_error'
    | 'timeout'
    | 'overflow'
    | 'transport_error'
    | 'unparseable';
  readonly headers: Readonly<Record<string, string>>;
  readonly body_redacted: string;
  readonly digest: Hash | null;
};

function parseIncluded(
  out: Buffer,
): { status: number; headers: Record<string, string>; body: string } | null {
  const text = out.toString('utf8');
  const m = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n/.exec(text);
  if (m === null) return null;
  const sep = text.search(/\r?\n\r?\n/);
  if (sep < 0) return null;
  const headers: Record<string, string> = {};
  for (const line of text.slice(m[0].length, sep).split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return {
    status: Number(m[1]),
    headers,
    body: text.slice(sep).replace(/^\r?\n\r?\n/, ''),
  };
}

export type GhPortOptions = {
  readonly exec: GhExec;
  readonly clock: Clock;
  readonly redactor: Redactor;
  readonly limits?: Partial<GhLimits>;
  /** Called for every response or transport outcome, after redaction; the store keeps raw evidence. */
  readonly onEvidence?: (e: GhEvidence) => void;
};

/**
 * One port instance serves one observation/publish round: the call cap and round deadline count from
 * its creation. A request outside the allowlist fails with `not_allowed` and is never sent.
 */
export class GhPort implements GitHubPort {
  readonly evidence: GhEvidence[] = [];
  readonly #o: GhPortOptions;
  readonly #limits: GhLimits;
  readonly #roundStart: number;
  #calls = 0;

  constructor(o: GhPortOptions) {
    this.#o = o;
    this.#limits = { ...DEFAULT_GH_LIMITS, ...o.limits };
    this.#roundStart = o.clock.monotonic();
  }

  get limits(): Readonly<GhLimits> {
    return this.#limits;
  }

  #remaining(): number {
    return this.#limits.round_ms - (this.#o.clock.monotonic() - this.#roundStart);
  }

  #record(e: Omit<GhEvidence, 'seq'>): GhEvidence {
    const full = { seq: this.evidence.length, ...e };
    this.evidence.push(full);
    this.#o.onEvidence?.(full);
    return full;
  }

  async request(req: GitHubRequest): Promise<Result<GitHubResponse, GitHubFailure>> {
    const allowed = (
      req.method === 'GET'
        ? GET_ENDPOINTS
        : req.method === 'POST'
          ? POST_ENDPOINTS
          : req.method === 'PATCH'
            ? PATCH_ENDPOINTS
            : PUT_ENDPOINTS
    ).some((re) => re.test(req.path));
    if (!allowed)
      return err({
        reason: 'not_allowed',
        status: null,
        detail: `${req.method} ${req.path} is not allowed`,
        retry_after_ms: null,
      });
    const badKey = Object.keys(req.query).find((k) => !QUERY_KEYS.has(k));
    if (badKey !== undefined)
      return err({
        reason: 'not_allowed',
        status: null,
        detail: `query ${badKey} is not allowed`,
        retry_after_ms: null,
      });
    if (req.method === 'GET' && req.body !== null)
      return err({
        reason: 'not_allowed',
        status: null,
        detail: 'GET has no body',
        retry_after_ms: null,
      });
    if (
      req.method === 'PATCH' &&
      (typeof req.body !== 'object' ||
        req.body === null ||
        Object.keys(req.body).some((k) => !PATCH_FIELDS.has(k)))
    ) {
      return err({
        reason: 'not_allowed',
        status: null,
        detail: 'PATCH may change only title and body',
        retry_after_ms: null,
      });
    }
    if (
      req.method === 'POST' &&
      ((req.path === 'graphql' && !validGraphqlBody(req.body)) ||
        (req.path.endsWith('/reviews') && !validReviewBody(req.body)))
    )
      return err({
        reason: 'not_allowed',
        status: null,
        detail:
          req.path === 'graphql'
            ? 'graphql may only mark a pull request ready'
            : 'a review may only COMMENT',
        retry_after_ms: null,
      });
    if (req.method === 'PUT' && !validMergeBody(req.body))
      return err({
        reason: 'not_allowed',
        status: null,
        detail: 'PUT must name the head and the merge method',
        retry_after_ms: null,
      });
    const qs = new URLSearchParams(req.query).toString();
    const target = qs === '' ? req.path : `${req.path}?${qs}`;
    const args = [
      'api',
      '--method',
      req.method,
      '--include',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      `X-GitHub-Api-Version: ${API_VERSION}`,
    ];
    const write = req.method !== 'GET';
    if (write) args.push('--input', '-');
    args.push(target);
    const stdin = write ? JSON.stringify(req.body ?? {}) : null;
    // A write is sent once: a lost answer is unknown, never resent blindly.
    const sends = write ? 1 : this.#limits.max_sends;

    let last: GitHubFailure = {
      reason: 'unknown',
      status: null,
      detail: 'not sent',
      retry_after_ms: null,
    };
    for (let send = 1; send <= sends; send++) {
      if (this.#calls >= this.#limits.max_calls)
        return err({
          reason: 'unknown',
          status: null,
          detail: 'call cap reached',
          retry_after_ms: null,
        });
      const remaining = this.#remaining();
      if (remaining <= 0)
        return err({
          reason: 'unknown',
          status: null,
          detail: 'round deadline reached',
          retry_after_ms: null,
        });
      this.#calls++;
      const r = await this.#o.exec(args, {
        timeoutMs: Math.min(this.#limits.call_timeout_ms, remaining),
        maxBytes: this.#limits.max_response_bytes,
        stdin,
      });
      const base = {
        method: req.method,
        path: target,
        send,
        headers: {},
        body_redacted: '',
        digest: null,
      };
      if (r.timedOut || r.overflow) {
        this.#record({
          ...base,
          status: null,
          outcome: r.timedOut ? 'timeout' : 'overflow',
        });
        last = {
          reason: 'unknown',
          status: null,
          detail: r.timedOut ? 'timeout' : 'response exceeds byte cap',
          retry_after_ms: null,
        };
        if (r.overflow) return err(last);
        continue;
      }
      const parsed = parseIncluded(r.stdout);
      if (parsed === null) {
        this.#record({
          ...base,
          status: null,
          outcome: r.code === 0 ? 'unparseable' : 'transport_error',
        });
        last = {
          reason: 'unknown',
          status: null,
          detail: `no HTTP response (${this.#o.redactor.text(r.stderr.trim()).slice(0, 200)})`,
          retry_after_ms: null,
        };
        continue;
      }
      const headers = Object.fromEntries(
        Object.entries(parsed.headers).filter(([k]) => KEEP_HEADERS.has(k)),
      );
      const body_redacted = this.#o.redactor.text(parsed.body);
      const digest = hashText(
        canonicalJson({ status: parsed.status, headers, body: body_redacted }),
      );
      const success = parsed.status >= 200 && parsed.status < 300;
      if (success && r.code !== 0) {
        this.#record({
          ...base,
          status: parsed.status,
          outcome: 'transport_error',
          headers,
          body_redacted,
          digest,
        });
        last = {
          reason: 'unknown',
          status: null,
          detail: `gh exited ${String(r.code)} after HTTP ${parsed.status}`,
          retry_after_ms: null,
        };
        continue;
      }
      this.#record({
        ...base,
        status: parsed.status,
        outcome: success ? 'ok' : 'http_error',
        headers,
        body_redacted,
        digest,
      });
      if (success) {
        let body: unknown = null;
        if (parsed.body !== '') {
          try {
            body = JSON.parse(parsed.body) as unknown;
          } catch {
            return err({
              reason: 'unknown',
              status: parsed.status,
              detail: 'unparseable JSON body',
              retry_after_ms: null,
            });
          }
        }
        return ok({
          status: parsed.status,
          headers,
          body,
          evidence_digest: digest,
        });
      }
      const retryAfter = Number(headers['retry-after'] ?? '0') * 1000;
      let errorBody: unknown;
      try {
        errorBody = parsed.body === '' ? undefined : (JSON.parse(body_redacted) as unknown);
      } catch {
        errorBody = undefined;
      }
      last = {
        reason: 'http_error',
        status: parsed.status,
        detail: `HTTP ${parsed.status}`,
        retry_after_ms: retryAfter > 0 ? retryAfter : null,
        ...(errorBody === undefined ? {} : { body: errorBody }),
      };
      const retryable = req.method === 'GET' && (parsed.status >= 500 || parsed.status === 429);
      if (!retryable) return err(last);
      if (retryAfter > this.#remaining())
        return err({
          reason: 'unknown',
          status: parsed.status,
          detail: `retry-after ${retryAfter} ms beyond the round window`,
          retry_after_ms: retryAfter,
        });
      if (retryAfter > 0) await new Promise((res) => setTimeout(res, retryAfter));
    }
    // A POST that got no readable answer may have been applied; that is unknown, never "failed".
    return err(last);
  }
}

export type ListRead = {
  readonly items: unknown[];
  readonly complete: boolean;
  readonly pages: number;
  readonly digest: Hash;
};

/** Page-numbered GET listing; complete only if the last page was short and no `rel="next"` remains. */
export async function listAll(
  port: GitHubPort,
  path: string,
  pick: (body: unknown) => unknown[] | null,
  opts: {
    readonly per_page?: number;
    readonly max_pages?: number;
    readonly query?: Readonly<Record<string, string>>;
  } = {},
): Promise<Result<ListRead, GitHubFailure>> {
  const perPage = opts.per_page ?? DEFAULT_GH_LIMITS.per_page;
  const maxPages = opts.max_pages ?? DEFAULT_GH_LIMITS.max_pages;
  const items: unknown[] = [];
  const digests: string[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await port.request({
      method: 'GET',
      path,
      query: { ...opts.query, per_page: String(perPage), page: String(page) },
      body: null,
    });
    if (!r.ok) return r;
    digests.push(r.value.evidence_digest);
    const got = pick(r.value.body);
    if (got === null)
      return err({
        reason: 'unknown',
        status: r.value.status,
        detail: 'unexpected list shape',
        retry_after_ms: null,
      });
    items.push(...got);
    if (got.length < perPage && !/rel="next"/.test(r.value.headers['link'] ?? ''))
      return ok({
        items,
        complete: true,
        pages: page,
        digest: hashText(digests.join(',')),
      });
  }
  return ok({
    items,
    complete: false,
    pages: maxPages,
    digest: hashText(digests.join(',')),
  });
}
