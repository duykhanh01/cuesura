/**
 * Spike 0 read-only gh port prototype (T005, contracts/github.md).
 *
 *   node scripts/spike-002/gh.ts observe --repo OWNER/NAME --pr N --snapshot check1,check2 \
 *        [--expect-repo-id ID] [--expect-pr-id ID] [--expect-target BRANCH] --fixture FILE   (default: local fixture)
 *   node scripts/spike-002/gh.ts observe ... --live [--gh PATH]       (T008 sandbox repo only)
 *
 * GET only, endpoint allowlist, argv without shell, pinned API version, per-call timeout, round
 * deadline, call/page/byte/send caps, request ledger and redacted raw evidence with digests. There is
 * no merge, create or rerun operation in this port. Head-at-merge facts are recorded as candidates;
 * whether `.head.sha` proves the head at merge is exactly what S0.3 (T008) must establish.
 *
 * API 2026-03-10 removed `merge_commit_sha` from pull responses, so the merge commit comes from the
 * PR's single `merged` issue event (`commit_id`). Completeness of that proof is reported separately
 * from the merged fact; a missing, truncated or contradictory source leaves the proof incomplete.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../../src/shared/canonical-json.ts';
import { Redactor } from './runner.ts';

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
/** Read endpoints the port may call. Nothing else is reachable, whatever the caller passes. */
export const ENDPOINTS: readonly RegExp[] = [
  new RegExp(`^repos/${SEG}/${SEG}$`),
  new RegExp(`^repos/${SEG}/${SEG}/pulls/\\d+$`),
  new RegExp(`^repos/${SEG}/${SEG}/pulls/\\d+/merge$`),
  new RegExp(`^repos/${SEG}/${SEG}/issues/\\d+/events$`),
  new RegExp(`^repos/${SEG}/${SEG}/branches/${BRANCH}$`),
  new RegExp(`^repos/${SEG}/${SEG}/branches/${BRANCH}/protection$`),
  new RegExp(`^repos/${SEG}/${SEG}/rules/branches/${BRANCH}$`),
  new RegExp(`^repos/${SEG}/${SEG}/rulesets/\\d+$`),
  new RegExp(
    `^repos/${SEG}/${SEG}/commits/[0-9a-f]{40}/(check-runs|statuses)$`,
  ),
];

export class GhPortError extends Error {
  override name = 'GhPortError';
}

export type ExecResult = {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly overflow: boolean;
};
export type GhExec = (
  args: readonly string[],
  opts: { readonly timeoutMs: number; readonly maxBytes: number },
) => Promise<ExecResult>;

const GH_ENV_PASS = [
  'PATH',
  'HOME',
  'GH_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'LANG',
] as const;

/** Real gh via spawn (no shell). Credential stays in the orchestrator env/home; output is capped. */
export function spawnGhExec(
  ghPath = 'gh',
  env: NodeJS.ProcessEnv = process.env,
): GhExec {
  const childEnv: Record<string, string> = {
    GH_PROMPT_DISABLED: '1',
    GH_PAGER: 'cat',
    PAGER: 'cat',
    NO_COLOR: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    CLICOLOR: '0',
  };
  for (const k of GH_ENV_PASS) if (env[k] !== undefined) childEnv[k] = env[k];
  return (args, opts) =>
    new Promise((res) => {
      const child = spawn(ghPath, [...args], {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderr = '';
      let timedOut = false;
      let overflow = false;
      const stop = (): void => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, opts.timeoutMs);
      child.stdout.on('data', (b: Buffer) => {
        bytes += b.length;
        if (bytes > opts.maxBytes) {
          if (!overflow) stop();
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
        res({
          code: null,
          stdout: Buffer.alloc(0),
          stderr: e.message,
          timedOut,
          overflow,
        });
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        res({
          code,
          stdout: Buffer.concat(chunks),
          stderr,
          timedOut,
          overflow,
        });
      });
    });
}

// --- local fixture exec -------------------------------------------------------------------------

export type FixtureResponse = {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly transport?: 'timeout' | 'overflow' | 'exit_no_output';
};
/** Keyed by request path including query; each key holds a sequence (last item repeats). */
export type FixtureScript = {
  readonly source: string;
  readonly responses: Readonly<Record<string, readonly FixtureResponse[]>>;
};

const REASON: Readonly<Record<number, string>> = {
  200: 'OK',
  204: 'No Content',
  304: 'Not Modified',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
};

/** Emulates `gh api --include` output from a script; records nothing and never touches the network. */
export function fixtureExec(
  script: FixtureScript,
): GhExec & { readonly calls: string[] } {
  const seen = new Map<string, number>();
  const calls: string[] = [];
  const exec = (
    args: readonly string[],
    opts: { timeoutMs: number; maxBytes: number },
  ): Promise<ExecResult> => {
    const path = args.at(-1) as string;
    calls.push(`${args[args.indexOf('--method') + 1] ?? '?'} ${path}`);
    const seq = script.responses[path];
    if (seq === undefined || seq.length === 0) {
      return Promise.resolve({
        code: 1,
        stdout: Buffer.from(
          `HTTP/2.0 404 Not Found\r\n\r\n{"message":"fixture: no response for ${path}"}`,
        ),
        stderr: 'gh: Not Found (HTTP 404)',
        timedOut: false,
        overflow: false,
      });
    }
    const n = seen.get(path) ?? 0;
    seen.set(path, n + 1);
    const r = seq[Math.min(n, seq.length - 1)] as FixtureResponse;
    if (r.transport === 'timeout')
      return Promise.resolve({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: '',
        timedOut: true,
        overflow: false,
      });
    if (r.transport === 'exit_no_output')
      return Promise.resolve({
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: 'error connecting to api.github.com',
        timedOut: false,
        overflow: false,
      });
    const head = [
      `HTTP/2.0 ${r.status} ${REASON[r.status] ?? ''}`,
      ...Object.entries(r.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    ].join('\r\n');
    const body = r.body === undefined ? '' : JSON.stringify(r.body);
    const out = Buffer.from(`${head}\r\n\r\n${body}`);
    if (r.transport === 'overflow' || out.length > opts.maxBytes) {
      return Promise.resolve({
        code: null,
        stdout: out.subarray(0, opts.maxBytes),
        stderr: '',
        timedOut: false,
        overflow: true,
      });
    }
    return Promise.resolve({
      code: r.status >= 200 && r.status < 300 ? 0 : 1,
      stdout: out,
      stderr: '',
      timedOut: false,
      overflow: false,
    });
  };
  return Object.assign(exec, { calls });
}

// --- port ---------------------------------------------------------------------------------------

export type RequestRecord = {
  readonly seq: number;
  readonly method: 'GET';
  readonly path: string;
  readonly send: number;
  readonly started_ms: number;
  readonly duration_ms: number;
  readonly status: number | null;
  readonly bytes: number;
  readonly outcome:
    | 'ok'
    | 'http_error'
    | 'timeout'
    | 'overflow'
    | 'transport_error'
    | 'unparseable';
  readonly evidence_digest: string | null;
};

export type Evidence = {
  readonly seq: number;
  readonly path: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body_redacted: string;
  readonly digest: string;
};

export type Response = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly digest: string;
};

/** Unknown: the call could not establish a fact (transport, caps, deadline). Never "not happened". */
export type Read<T> =
  | { readonly ok: true; readonly value: T; readonly digest: string }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly status: number | null;
    };

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

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function parseIncluded(
  out: Buffer,
): { status: number; headers: Record<string, string>; body: string } | null {
  const text = out.toString('utf8');
  const m = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n/.exec(text);
  if (m === null) return null;
  const sepIdx = text.search(/\r?\n\r?\n/);
  if (sepIdx < 0) return null;
  const headEnd = sepIdx;
  const headers: Record<string, string> = {};
  for (const line of text.slice(m[0].length, headEnd).split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0)
      headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const body = text.slice(sepIdx).replace(/^\r?\n\r?\n/, '');
  return { status: Number(m[1]), headers, body };
}

export class GhPort {
  readonly ledger: RequestRecord[] = [];
  readonly evidence: Evidence[] = [];
  readonly #exec: GhExec;
  readonly #limits: GhLimits;
  readonly #redactor = new Redactor();
  readonly #now: () => number;
  readonly #roundStart: number;

  constructor(
    exec: GhExec,
    limits: Partial<GhLimits> = {},
    now: () => number = () => performance.now(),
  ) {
    this.#exec = exec;
    this.#limits = { ...DEFAULT_GH_LIMITS, ...limits };
    this.#now = now;
    this.#roundStart = now();
  }

  get limits(): Readonly<GhLimits> {
    return this.#limits;
  }

  #remaining(): number {
    return this.#limits.round_ms - (this.#now() - this.#roundStart);
  }

  /** One logical GET with up to max_sends sends inside the round window (GET is safe to resend). */
  async get(
    path: string,
    query: Readonly<Record<string, string>> = {},
  ): Promise<Read<Response>> {
    if (!ENDPOINTS.some((re) => re.test(path)))
      throw new GhPortError(`endpoint not allowed: ${path}`);
    for (const k of Object.keys(query))
      if (k !== 'per_page' && k !== 'page')
        throw new GhPortError(`query ${k} not allowed`);
    const qs = new URLSearchParams(query).toString();
    const target = qs === '' ? path : `${path}?${qs}`;
    let last: Read<Response> = { ok: false, reason: 'not sent', status: null };
    for (let send = 1; send <= this.#limits.max_sends; send++) {
      if (this.ledger.length >= this.#limits.max_calls)
        return { ok: false, reason: 'call cap reached', status: null };
      const remaining = this.#remaining();
      if (remaining <= 0)
        return { ok: false, reason: 'round deadline reached', status: null };
      const started = this.#now();
      const r = await this.#exec(
        [
          'api',
          '--method',
          'GET',
          '--include',
          '-H',
          'Accept: application/vnd.github+json',
          '-H',
          `X-GitHub-Api-Version: ${API_VERSION}`,
          target,
        ],
        {
          timeoutMs: Math.min(this.#limits.call_timeout_ms, remaining),
          maxBytes: this.#limits.max_response_bytes,
        },
      );
      const base = {
        seq: this.ledger.length,
        method: 'GET' as const,
        path: target,
        send,
        started_ms: Math.round(started - this.#roundStart),
        duration_ms: Math.round(this.#now() - started),
        bytes: r.stdout.length,
      };
      if (r.timedOut || r.overflow) {
        this.ledger.push({
          ...base,
          status: null,
          outcome: r.timedOut ? 'timeout' : 'overflow',
          evidence_digest: null,
        });
        last = {
          ok: false,
          reason: r.timedOut ? 'timeout' : 'response exceeds byte cap',
          status: null,
        };
        if (r.overflow) return last;
        continue;
      }
      const parsed = parseIncluded(r.stdout);
      if (parsed === null) {
        this.ledger.push({
          ...base,
          status: null,
          outcome: r.code === 0 ? 'unparseable' : 'transport_error',
          evidence_digest: null,
        });
        last = {
          ok: false,
          reason: `no HTTP response (${this.#redactor.redact(r.stderr.trim()).slice(0, 200)})`,
          status: null,
        };
        continue;
      }
      const headers = Object.fromEntries(
        Object.entries(parsed.headers).filter(([k]) => KEEP_HEADERS.has(k)),
      );
      const bodyRedacted = this.#redactor.redact(parsed.body);
      const digest = sha256(
        canonicalJson({ status: parsed.status, headers, body: bodyRedacted }),
      );
      this.evidence.push({
        seq: base.seq,
        path: target,
        status: parsed.status,
        headers,
        body_redacted: bodyRedacted,
        digest,
      });
      const ok = parsed.status >= 200 && parsed.status < 300;
      if (ok && r.code !== 0) {
        this.ledger.push({
          ...base,
          status: parsed.status,
          outcome: 'transport_error',
          evidence_digest: digest,
        });
        last = {
          ok: false,
          reason: `gh exited ${String(r.code)} after HTTP ${parsed.status}`,
          status: null,
        };
        continue;
      }
      this.ledger.push({
        ...base,
        status: parsed.status,
        outcome: ok ? 'ok' : 'http_error',
        evidence_digest: digest,
      });
      if (ok) {
        let body: unknown = null;
        if (parsed.body !== '') {
          try {
            body = JSON.parse(parsed.body) as unknown;
          } catch {
            return {
              ok: false,
              reason: 'unparseable JSON body',
              status: parsed.status,
            };
          }
        }
        return {
          ok: true,
          value: { status: parsed.status, headers, body, digest },
          digest,
        };
      }
      last = {
        ok: false,
        reason: `HTTP ${parsed.status}`,
        status: parsed.status,
      };
      const retryable = parsed.status >= 500 || parsed.status === 429;
      if (!retryable) return last;
      const after = Number(headers['retry-after'] ?? '0') * 1000;
      if (after > this.#remaining())
        return {
          ok: false,
          reason: `retry-after ${after} ms beyond round window`,
          status: parsed.status,
        };
      if (after > 0) await new Promise((res) => setTimeout(res, after));
    }
    return last;
  }

  /** Page-numbered listing; complete only if the last page was short and no Link rel="next" remains. */
  async list(
    path: string,
    pick: (body: unknown) => unknown[] | null,
  ): Promise<Read<{ items: unknown[]; complete: boolean; pages: number }>> {
    const items: unknown[] = [];
    const digests: string[] = [];
    for (let page = 1; page <= this.#limits.max_pages; page++) {
      const r = await this.get(path, {
        per_page: String(this.#limits.per_page),
        page: String(page),
      });
      if (!r.ok) return r;
      digests.push(r.digest);
      const got = pick(r.value.body);
      if (got === null)
        return {
          ok: false,
          reason: 'unexpected list shape',
          status: r.value.status,
        };
      items.push(...got);
      const hasNext = /rel="next"/.test(r.value.headers['link'] ?? '');
      if (got.length < this.#limits.per_page && !hasNext)
        return {
          ok: true,
          value: { items, complete: true, pages: page },
          digest: sha256(digests.join(',')),
        };
    }
    return {
      ok: true,
      value: { items, complete: false, pages: this.#limits.max_pages },
      digest: sha256(digests.join(',')),
    };
  }
}

// --- facts --------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

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

export type RequiredCheck = {
  readonly name: string;
  /** 'any' when GitHub does not pin an app (absent/null/-1); otherwise the pinned app id. */
  readonly app: 'any' | number;
  readonly source: 'classic' | 'rules';
  readonly enforcement:
    'active' | 'evaluate' | 'disabled' | 'classic' | 'unknown';
  readonly ruleset_id: number | null;
};

export type RequiredChecks =
  | {
      readonly status: 'none';
      readonly checks: readonly RequiredCheck[];
      readonly basis: string;
    }
  | {
      readonly status: 'required';
      readonly checks: readonly RequiredCheck[];
      readonly basis: string;
    }
  | {
      readonly status: 'unknown';
      readonly checks: readonly RequiredCheck[];
      readonly basis: string;
    };

function appOf(v: unknown): 'any' | number | null {
  if (v === undefined || v === null || v === -1) return 'any';
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
}

function notProtectedBody(body: string | undefined): boolean {
  if (body === undefined) return false;
  try {
    return obj(JSON.parse(body))['message'] === 'Branch not protected';
  } catch {
    return false;
  }
}

/** Classic protection + active branch rules. Missing permission, truncation or errors → unknown, never empty. */
export async function readRequiredChecks(
  port: GhPort,
  owner: string,
  repo: string,
  branch: string,
): Promise<RequiredChecks> {
  const b = encodeURIComponent(branch);
  const checks: RequiredCheck[] = [];
  const branchRead = await port.get(`repos/${owner}/${repo}/branches/${b}`);
  if (!branchRead.ok)
    return {
      status: 'unknown',
      checks,
      basis: `branch read failed: ${branchRead.reason}`,
    };
  const isProtected = obj(branchRead.value.body)['protected'];
  if (isProtected === true) {
    const protPath = `repos/${owner}/${repo}/branches/${b}/protection`;
    const prot = await port.get(protPath);
    // `protected` is also true when only rulesets apply; the endpoint then answers 404 "Branch not
    // protected" (seen live 2026-10-28). Any other failure, incl. a bare 404 "Not Found", stays unknown.
    const noClassic =
      !prot.ok &&
      prot.status === 404 &&
      notProtectedBody(
        port.evidence.findLast((e) => e.path === protPath)?.body_redacted,
      );
    if (!prot.ok && !noClassic)
      return {
        status: 'unknown',
        checks,
        basis: `classic protection unreadable: ${prot.reason}`,
      };
    const raw = obj(prot.ok ? prot.value.body : null)['required_status_checks'];
    if (
      prot.ok &&
      raw !== null &&
      (typeof raw !== 'object' || Array.isArray(raw))
    ) {
      return {
        status: 'unknown',
        checks,
        basis: 'classic required checks malformed or missing',
      };
    }
    const rsc = obj(raw);
    const list = Array.isArray(rsc['checks'])
      ? (rsc['checks'] as unknown[])
      : null;
    if (list !== null) {
      for (const c of list) {
        const name = str(obj(c)['context']);
        const app = appOf(obj(c)['app_id']);
        if (!name || app === null)
          return {
            status: 'unknown',
            checks,
            basis: 'classic check identity malformed',
          };
        checks.push({
          name,
          app,
          source: 'classic',
          enforcement: 'classic',
          ruleset_id: null,
        });
      }
    } else if (rsc['checks'] === undefined && Array.isArray(rsc['contexts'])) {
      for (const name of rsc['contexts'] as unknown[]) {
        if (typeof name !== 'string' || name === '')
          return {
            status: 'unknown',
            checks,
            basis: 'classic contexts malformed',
          };
        checks.push({
          name,
          app: 'any',
          source: 'classic',
          enforcement: 'classic',
          ruleset_id: null,
        });
      }
    } else if (prot.ok && raw !== null) {
      return {
        status: 'unknown',
        checks,
        basis: 'classic required check list missing or malformed',
      };
    }
  } else if (isProtected !== false) {
    return {
      status: 'unknown',
      checks,
      basis: 'branch protected flag missing',
    };
  }

  const rules = await port.list(
    `repos/${owner}/${repo}/rules/branches/${b}`,
    (body) => (Array.isArray(body) ? body : null),
  );
  if (!rules.ok)
    return {
      status: 'unknown',
      checks,
      basis: `branch rules unreadable: ${rules.reason}`,
    };
  if (!rules.value.complete)
    return {
      status: 'unknown',
      checks,
      basis: 'branch rules truncated by page cap',
    };
  const enforcement = new Map<number, RequiredCheck['enforcement']>();
  for (const rule of rules.value.items) {
    const r = obj(rule);
    if (!str(r['type']))
      return {
        status: 'unknown',
        checks,
        basis: 'branch rule type missing or malformed',
      };
    if (r['type'] !== 'required_status_checks') continue;
    const rulesetId = num(r['ruleset_id']);
    let enf: RequiredCheck['enforcement'] = 'unknown';
    if (
      rulesetId !== null &&
      Number.isSafeInteger(rulesetId) &&
      rulesetId > 0
    ) {
      if (!enforcement.has(rulesetId)) {
        const rs = await port.get(
          `repos/${owner}/${repo}/rulesets/${rulesetId}`,
        );
        const e = rs.ok ? str(obj(rs.value.body)['enforcement']) : null;
        enforcement.set(
          rulesetId,
          e === 'active' || e === 'evaluate' || e === 'disabled'
            ? e
            : 'unknown',
        );
      }
      enf = enforcement.get(rulesetId) ?? 'unknown';
    }
    if (enf === 'unknown')
      return {
        status: 'unknown',
        checks,
        basis: 'ruleset enforcement unreadable',
      };
    const params = obj(r['parameters']);
    const list = Array.isArray(params['required_status_checks'])
      ? (params['required_status_checks'] as unknown[])
      : null;
    if (list === null)
      return {
        status: 'unknown',
        checks,
        basis: 'rule required check list missing or malformed',
      };
    for (const c of list) {
      const name = str(obj(c)['context']);
      const app = appOf(obj(c)['integration_id']);
      if (!name || app === null)
        return {
          status: 'unknown',
          checks,
          basis: 'rule check identity malformed',
        };
      checks.push({
        name,
        app,
        source: 'rules',
        enforcement: enf,
        ruleset_id: rulesetId,
      });
    }
  }
  if (checks.some((c) => c.enforcement === 'unknown'))
    return {
      status: 'unknown',
      checks,
      basis: 'ruleset enforcement unreadable',
    };
  const enforced = checks.filter(
    (c) => c.enforcement === 'active' || c.enforcement === 'classic',
  );
  return enforced.length === 0
    ? {
        status: 'none',
        checks,
        basis:
          isProtected === true
            ? 'protected, no enforced required checks'
            : 'unprotected, no enforced required-check rules',
      }
    : { status: 'required', checks, basis: 'classic and/or active rules' };
}

export type RequiredComparison =
  | { readonly verdict: 'covered'; readonly github: readonly string[] }
  | {
      readonly verdict: 'required_checks_mismatch';
      readonly missing_from_snapshot: readonly string[];
      readonly app_pinned: readonly string[];
    }
  | { readonly verdict: 'unknown'; readonly basis: string };

/** G ⊆ S for any-app checks; any app-pinned enforced check is a mismatch. Snapshot is never widened. */
export function compareRequired(
  required: RequiredChecks,
  snapshot: readonly string[],
): RequiredComparison {
  if (required.status === 'unknown')
    return { verdict: 'unknown', basis: required.basis };
  const enforced = required.checks.filter(
    (c) => c.enforcement === 'active' || c.enforcement === 'classic',
  );
  const pinned = [
    ...new Set(
      enforced
        .filter((c) => c.app !== 'any')
        .map((c) => `${c.name}@app:${String(c.app)}`),
    ),
  ].sort();
  const names = [
    ...new Set(enforced.filter((c) => c.app === 'any').map((c) => c.name)),
  ].sort();
  const missing = names.filter((n) => !snapshot.includes(n));
  if (pinned.length > 0 || missing.length > 0)
    return {
      verdict: 'required_checks_mismatch',
      missing_from_snapshot: missing,
      app_pinned: pinned,
    };
  return { verdict: 'covered', github: names };
}

export type CheckState =
  | 'success'
  | 'pending'
  | 'failure'
  | 'neutral'
  | 'skipped'
  | 'cancelled'
  | 'missing'
  | 'collision'
  | 'unknown';

/** Latest check run per name + app, and latest status per context, for one SHA. */
export async function readCheckBundle(
  port: GhPort,
  owner: string,
  repo: string,
  sha: string,
  snapshot: readonly string[],
): Promise<{
  complete: boolean;
  states: Record<string, CheckState>;
  all_success: boolean;
  basis: string;
}> {
  const unknown = (
    basis: string,
  ): {
    complete: boolean;
    states: Record<string, CheckState>;
    all_success: boolean;
    basis: string;
  } => ({
    complete: false,
    states: Object.fromEntries(
      snapshot.map((n): [string, CheckState] => [n, 'unknown']),
    ),
    all_success: false,
    basis,
  });
  const runs = await port.list(
    `repos/${owner}/${repo}/commits/${sha}/check-runs`,
    (b) =>
      Array.isArray(obj(b)['check_runs'])
        ? (obj(b)['check_runs'] as unknown[])
        : null,
  );
  if (!runs.ok) return unknown(`check-runs: ${runs.reason}`);
  const statuses = await port.list(
    `repos/${owner}/${repo}/commits/${sha}/statuses`,
    (b) => (Array.isArray(b) ? b : null),
  );
  if (!statuses.ok) return unknown(`statuses: ${statuses.reason}`);
  if (!runs.value.complete || !statuses.value.complete)
    return unknown('pagination cap reached');

  const latestRun = new Map<string, Map<number, Obj>>();
  for (const r of runs.value.items.map(obj)) {
    const name = str(r['name']);
    if (name === null || str(r['head_sha']) !== sha) continue;
    const app = num(obj(r['app'])['id']);
    const id = num(r['id']);
    if (
      app === null ||
      !Number.isSafeInteger(app) ||
      app <= 0 ||
      id === null ||
      !Number.isSafeInteger(id) ||
      id <= 0
    ) {
      if (snapshot.includes(name))
        return unknown('check-run identity missing or malformed');
      continue;
    }
    const apps = latestRun.get(name) ?? new Map<number, Obj>();
    const prev = apps.get(app);
    if (prev === undefined || id > (num(prev['id']) ?? 0)) apps.set(app, r);
    latestRun.set(name, apps);
  }
  const latestStatus = new Map<string, Obj>();
  for (const s of statuses.value.items.map(obj)) {
    const ctx = str(s['context']);
    if (ctx === null) continue;
    const prev = latestStatus.get(ctx);
    if (prev === undefined || (num(s['id']) ?? 0) > (num(prev['id']) ?? 0))
      latestStatus.set(ctx, s);
  }
  const states: Record<string, CheckState> = {};
  for (const name of snapshot) {
    const apps = latestRun.get(name);
    const run = apps?.values().next().value;
    const status = latestStatus.get(name);
    if ((apps?.size ?? 0) > 1 || (run !== undefined && status !== undefined))
      states[name] = 'collision';
    else if (run !== undefined) {
      if (run['status'] !== 'completed') states[name] = 'pending';
      else {
        const c = str(run['conclusion']);
        states[name] =
          c === 'success'
            ? 'success'
            : c === 'neutral'
              ? 'neutral'
              : c === 'skipped'
                ? 'skipped'
                : c === 'cancelled'
                  ? 'cancelled'
                  : c === null
                    ? 'unknown'
                    : 'failure';
      }
    } else if (status !== undefined) {
      const st = str(status['state']);
      states[name] =
        st === 'success'
          ? 'success'
          : st === 'pending'
            ? 'pending'
            : st === 'failure' || st === 'error'
              ? 'failure'
              : 'unknown';
    } else states[name] = 'missing';
  }
  return {
    complete: true,
    states,
    all_success:
      snapshot.length > 0 && snapshot.every((n) => states[n] === 'success'),
    basis: 'check-runs + statuses for one sha',
  };
}

const SHA_RE = /^[0-9a-f]{40}$/;

export const MERGE_COMMIT_SOURCE = 'issues.events.merged.commit_id';

export type MergeCommitFact = {
  readonly sha: string | null;
  readonly source: typeof MERGE_COMMIT_SOURCE;
  readonly status: 'found' | 'missing' | 'invalid' | 'conflict' | 'unknown';
  readonly basis: string;
  readonly event_id: number | null;
  readonly event_created_at: string | null;
  readonly events: {
    readonly pages: number;
    readonly complete: boolean;
    readonly digest: string;
  } | null;
};

/**
 * Exactly one `merged` event on a fully paged listing, with a 40-hex `commit_id` that is neither the
 * PR head nor base, points at this repo, carries the PR's `merged_at`, and agrees with a legacy
 * `merge_commit_sha` when one is present. Anything else is not a merge commit fact.
 */
export async function readMergeCommit(
  port: GhPort,
  owner: string,
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
    source: MERGE_COMMIT_SOURCE,
    status,
    basis,
    event_id: null,
    event_created_at: null,
    events: null,
    ...rest,
  });
  const listed = await port.list(
    `repos/${owner}/${repo}/issues/${n}/events`,
    (b) => (Array.isArray(b) ? b : null),
  );
  if (!listed.ok)
    return fact('unknown', `issue events unreadable: ${listed.reason}`);
  const events = {
    pages: listed.value.pages,
    complete: listed.value.complete,
    digest: listed.digest,
  };
  if (!listed.value.complete)
    return fact('unknown', 'issue events truncated by page cap', { events });
  const merged = listed.value.items
    .map(obj)
    .filter((e) => e['event'] === 'merged');
  if (merged.length === 0)
    return fact('missing', 'no merged event', { events });
  if (merged.length > 1)
    return fact('conflict', `${merged.length} merged events`, { events });
  const e = merged[0] as Obj;
  const at = {
    events,
    event_id: num(e['id']),
    event_created_at: str(e['created_at']),
  };
  const sha = e['commit_id'];
  if (sha === null || sha === undefined)
    return fact('missing', 'merged event has no commit_id', at);
  if (typeof sha !== 'string' || !SHA_RE.test(sha))
    return fact('invalid', 'merged event commit_id is not a 40-hex SHA', at);
  if (sha === pull.head.sha || sha === pull.base.sha)
    return fact(
      'conflict',
      'merged event commit_id equals the PR head or base SHA',
      at,
    );
  const url = e['commit_url'];
  if (url === null || url === undefined)
    return fact('missing', 'merged event has no commit_url', at);
  let commitUrl: URL;
  try {
    if (typeof url !== 'string') throw new Error('invalid URL');
    commitUrl = new URL(url);
  } catch {
    return fact('invalid', 'merged event commit_url is not a URL', at);
  }
  if (
    commitUrl.origin !== 'https://api.github.com' ||
    commitUrl.username !== '' ||
    commitUrl.password !== '' ||
    commitUrl.search !== '' ||
    commitUrl.hash !== '' ||
    commitUrl.pathname.toLowerCase() !==
      `/repos/${owner}/${repo}/commits/${sha}`.toLowerCase()
  ) {
    return fact(
      'conflict',
      'merged event commit_url points outside this repository',
      at,
    );
  }
  if (at.event_created_at === null || at.event_created_at !== pull.merged_at)
    return fact('conflict', 'merged event time differs from merged_at', at);
  if (pull.merge_commit_sha !== null && pull.merge_commit_sha !== sha)
    return fact('conflict', 'merged event disagrees with merge_commit_sha', at);
  return fact('found', 'single merged event on a complete listing', {
    ...at,
    sha,
  });
}

export type MergeProof = {
  /** The merged fact itself (pulls.merged); independent of how complete the proof below is. */
  readonly merged: true;
  readonly repo_id: number | null;
  readonly pr_id: number | null;
  readonly target: string | null;
  readonly merged_at: string | null;
  readonly merge_commit_sha: string | null;
  readonly merge_commit: MergeCommitFact;
  readonly head_at_merge_candidate: string | null;
  /** Held across post-merge push/delete in the S0.3 sandbox; promotion is T044's call, not this port's. */
  readonly head_source: 'pulls.head.sha';
  readonly merge_endpoint:
    'merged_204' | 'not_merged_404_unconfirmed' | 'unknown';
  readonly completeness: 'complete' | 'incomplete';
  readonly gaps: readonly string[];
};

export type Observation = {
  readonly schema_version: 2;
  readonly api_version: string;
  readonly identity: {
    readonly repo_id: number | null;
    readonly pr_id: number | null;
    readonly target: string | null;
    readonly verdict:
      | 'match'
      | 'identity_mismatch'
      | 'target_mismatch'
      | 'unchecked'
      | 'unknown';
  };
  readonly pull: PullFacts | null;
  readonly state: 'merged' | 'open' | 'closed' | 'inconsistent' | 'unknown';
  readonly merge_proof: MergeProof | null;
  readonly required: RequiredChecks | null;
  readonly comparison: RequiredComparison | null;
  readonly checks: Awaited<ReturnType<typeof readCheckBundle>> | null;
  readonly green: boolean;
  readonly reasons: readonly string[];
};

/** Merge endpoint, merged event and a pull re-read; any gap keeps the merged fact but marks the proof incomplete. */
async function mergeProof(
  port: GhPort,
  owner: string,
  repo: string,
  n: number,
  pull: PullFacts,
  repoId: number | null,
  targetOk: boolean,
): Promise<MergeProof> {
  const m = await port.get(`repos/${owner}/${repo}/pulls/${n}/merge`);
  const endpoint =
    m.ok && m.value.status === 204
      ? 'merged_204'
      : !m.ok && m.status === 404
        ? 'not_merged_404_unconfirmed'
        : 'unknown';
  const commit = await readMergeCommit(port, owner, repo, n, pull);
  const again = await port.get(`repos/${owner}/${repo}/pulls/${n}`);
  const gaps: string[] = [];
  if (repoId === null || pull.id === null) gaps.push('repo or PR id missing');
  if (pull.base.ref === null) gaps.push('target missing');
  else if (!targetOk) gaps.push('target does not match the task');
  if (pull.merged_at === null) gaps.push('merged_at missing');
  if (pull.head.sha === null || !SHA_RE.test(pull.head.sha))
    gaps.push('head sha missing or invalid');
  if (endpoint !== 'merged_204') gaps.push(`merge endpoint ${endpoint}`);
  if (commit.status !== 'found')
    gaps.push(`merge commit ${commit.status}: ${commit.basis}`);
  if (!again.ok) gaps.push(`pull re-read failed: ${again.reason}`);
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
    merged: true,
    repo_id: repoId,
    pr_id: pull.id,
    target: pull.base.ref,
    merged_at: pull.merged_at,
    merge_commit_sha: commit.sha,
    merge_commit: commit,
    head_at_merge_candidate: pull.head.sha,
    head_source: 'pulls.head.sha',
    merge_endpoint: endpoint,
    completeness: gaps.length === 0 ? 'complete' : 'incomplete',
    gaps,
  };
}

export type Expectation = {
  readonly repo_id: number | null;
  readonly pr_id: number | null;
  readonly target?: string | null;
};

/** Contract read bundle: pull → (merge proof | required + checks of observed head) → pull again. */
export async function observePull(
  port: GhPort,
  owner: string,
  repo: string,
  n: number,
  snapshot: readonly string[],
  expect: Expectation = { repo_id: null, pr_id: null },
): Promise<Observation> {
  const reasons: string[] = [];
  const empty = {
    schema_version: 2 as const,
    api_version: API_VERSION,
    merge_proof: null,
    required: null,
    comparison: null,
    checks: null,
    green: false,
  };
  const expectTarget = expect.target ?? null;
  const repoRead = await port.get(`repos/${owner}/${repo}`);
  const repoId = repoRead.ok ? num(obj(repoRead.value.body)['id']) : null;
  const first = await port.get(`repos/${owner}/${repo}/pulls/${n}`);
  if (!repoRead.ok || !first.ok) {
    return {
      ...empty,
      identity: {
        repo_id: repoId,
        pr_id: null,
        target: null,
        verdict: 'unknown',
      },
      pull: null,
      state: 'unknown',
      reasons: ['repo or pull unreadable'],
    };
  }
  const pull = pullFacts(first.value.body);
  const checked =
    expect.repo_id !== null || expect.pr_id !== null || expectTarget !== null;
  const mismatch =
    (expect.repo_id !== null && expect.repo_id !== repoId) ||
    (expect.pr_id !== null && expect.pr_id !== pull.id) ||
    pull.base.repo_id !== repoId;
  const targetOk = expectTarget === null || pull.base.ref === expectTarget;
  const verdict = mismatch
    ? 'identity_mismatch'
    : !targetOk
      ? 'target_mismatch'
      : checked
        ? 'match'
        : 'unchecked';
  const identity = {
    repo_id: repoId,
    pr_id: pull.id,
    target: pull.base.ref,
    verdict,
  } as const;
  if (mismatch)
    return {
      ...empty,
      identity,
      pull,
      state: 'unknown',
      reasons: ['repo/PR identity does not match the task'],
    };
  if (!targetOk) reasons.push('target does not match the task');

  if (pull.merged === true) {
    return {
      ...empty,
      identity,
      pull,
      state: 'merged',
      merge_proof: await mergeProof(
        port,
        owner,
        repo,
        n,
        pull,
        repoId,
        targetOk,
      ),
      reasons,
    };
  }
  if (
    pull.head.sha === null ||
    pull.base.ref === null ||
    pull.merged !== false
  ) {
    return {
      ...empty,
      identity,
      pull,
      state: 'unknown',
      reasons: ['pull facts incomplete'],
    };
  }
  const required = await readRequiredChecks(port, owner, repo, pull.base.ref);
  const comparison = compareRequired(required, snapshot);
  const checks = SHA_RE.test(pull.head.sha)
    ? await readCheckBundle(port, owner, repo, pull.head.sha, snapshot)
    : null;
  const second = await port.get(`repos/${owner}/${repo}/pulls/${n}`);
  if (!second.ok)
    return {
      ...empty,
      identity,
      pull,
      state: 'unknown',
      required,
      comparison,
      checks,
      reasons: ['second pull read failed'],
    };
  const again = pullFacts(second.value.body);
  const againMismatch = again.id !== pull.id || again.base.repo_id !== repoId;
  const againTargetOk =
    expectTarget === null || again.base.ref === expectTarget;
  const againIdentity = {
    repo_id: repoId,
    pr_id: again.id,
    target: again.base.ref,
    verdict: againMismatch
      ? 'identity_mismatch'
      : !againTargetOk
        ? 'target_mismatch'
        : checked
          ? 'match'
          : 'unchecked',
  } as const;
  if (againMismatch)
    return {
      ...empty,
      identity: againIdentity,
      pull: again,
      state: 'unknown',
      reasons: ['repo/PR identity changed between reads'],
    };
  if (again.merged === true) {
    return {
      ...empty,
      identity: againIdentity,
      pull: again,
      state: 'merged',
      merge_proof: await mergeProof(
        port,
        owner,
        repo,
        n,
        again,
        repoId,
        againTargetOk,
      ),
      reasons: [
        ...(againTargetOk ? [] : ['target does not match the task']),
        'merged during observation',
      ],
    };
  }
  if (
    again.head.sha !== pull.head.sha ||
    again.base.ref !== pull.base.ref ||
    again.base.sha !== pull.base.sha ||
    again.state !== pull.state
  ) {
    return {
      ...empty,
      identity,
      pull: again,
      state: 'inconsistent',
      required,
      comparison,
      checks,
      reasons: ['head/base/state changed between reads'],
    };
  }
  if (comparison.verdict !== 'covered')
    reasons.push(`required checks: ${comparison.verdict}`);
  if (checks === null || !checks.complete)
    reasons.push('check bundle incomplete');
  else if (!checks.all_success)
    reasons.push('not every snapshot check is success');
  const green =
    targetOk &&
    pull.state === 'open' &&
    comparison.verdict === 'covered' &&
    checks !== null &&
    checks.all_success;
  return {
    ...empty,
    identity,
    pull,
    state: pull.state === 'open' ? 'open' : 'closed',
    required,
    comparison,
    checks,
    green,
    reasons,
  };
}

// --- cli ----------------------------------------------------------------------------------------

function main(argv: readonly string[]): Promise<number> | number {
  const [cmd, ...rest] = argv;
  const opt = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd !== 'observe') return usage();
  const repoArg = opt('--repo');
  const pr = Number(opt('--pr'));
  const snapshot = (opt('--snapshot') ?? '').split(',').filter(Boolean);
  const fixture = opt('--fixture');
  const live = rest.includes('--live');
  if (
    repoArg === undefined ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoArg) ||
    !Number.isInteger(pr) ||
    pr <= 0
  )
    return usage();
  if (live === (fixture !== undefined)) {
    process.stderr.write(
      'choose exactly one of --fixture FILE (default local) or --live\n',
    );
    return 2;
  }
  const exec =
    fixture !== undefined
      ? fixtureExec(
          JSON.parse(readFileSync(resolve(fixture), 'utf8')) as FixtureScript,
        )
      : spawnGhExec(opt('--gh') ?? 'gh');
  const port = new GhPort(exec);
  const [owner, repo] = repoArg.split('/') as [string, string];
  const idOpt = (name: string): number | null =>
    opt(name) === undefined ? null : Number(opt(name));
  const expect = {
    repo_id: idOpt('--expect-repo-id'),
    pr_id: idOpt('--expect-pr-id'),
    target: opt('--expect-target') ?? null,
  };
  return observePull(port, owner, repo, pr, snapshot, expect).then(
    (observation) => {
      const report = {
        observation,
        ledger: port.ledger,
        evidence: port.evidence,
        limits: port.limits,
        mode: live ? 'live' : 'fixture',
      };
      const outFile = opt('--evidence-out');
      if (outFile !== undefined)
        writeFileSync(resolve(outFile), `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(
        `${JSON.stringify(outFile !== undefined ? { observation, requests: port.ledger.length, evidence_out: outFile } : report, null, 2)}\n`,
      );
      return 0;
    },
  );
}

function usage(): number {
  process.stderr.write(
    'usage: gh.ts observe --repo OWNER/NAME --pr N --snapshot a,b [--expect-repo-id ID] [--expect-pr-id ID] [--expect-target BRANCH] (--fixture FILE | --live [--gh PATH]) [--evidence-out FILE]\n',
  );
  return 2;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(
        `${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`,
      );
      process.exitCode = 1;
    });
}
