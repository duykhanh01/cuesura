import type { GitHubFailure, GitHubPort, GitHubRequest, GitHubResponse } from '../../src/adapters/ports.ts';
import { hashCanonical } from '../../src/shared/hash.ts';
import { err, ok, type Result } from '../../src/shared/result.ts';

// A stateful GitHub for flow tests: one repo, PRs created through the port, checks and merges set by the
// test. Answers only the endpoints the adapters call; anything else is a 404 so a stray call shows up.

export type FakePr = {
  number: number;
  id: number;
  title: string;
  body: string;
  head: { ref: string; sha: string };
  base: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  merge_commit: string | null;
};

export class FakeGitHub implements GitHubPort {
  readonly repo: string;
  readonly repoId: number;
  readonly prs: FakePr[] = [];
  readonly calls: string[] = [];
  /** Check runs per SHA: name → conclusion. */
  readonly checks = new Map<string, Record<string, 'success' | 'failure'>>();
  /** Branch head on the remote; the test keeps it in step with the bare repo. */
  headOf: (branch: string) => string | null = () => null;
  #next = 7;

  constructor(repo = 'acme/app', repoId = 4242) {
    this.repo = repo;
    this.repoId = repoId;
  }

  merge(n: number, mergeCommit: string, at = '2026-10-29T12:00:00Z'): void {
    const pr = this.prs.find((p) => p.number === n);
    if (pr === undefined) throw new Error(`no PR ${n}`);
    pr.state = 'closed';
    pr.merged_at = at;
    pr.merge_commit = mergeCommit;
  }

  #pull(p: FakePr): Record<string, unknown> {
    const repo = { id: this.repoId, full_name: this.repo };
    return {
      id: p.id,
      number: p.number,
      state: p.state,
      merged: p.merged_at !== null,
      merged_at: p.merged_at,
      title: p.title,
      body: p.body,
      html_url: `https://github.com/${this.repo}/pull/${p.number}`,
      head: { ref: p.head.ref, sha: p.head.sha, repo },
      base: { ref: p.base, sha: 'f'.repeat(40), repo },
    };
  }

  request(req: GitHubRequest): Promise<Result<GitHubResponse, GitHubFailure>> {
    this.calls.push(`${req.method} ${req.path}`);
    const reply = (status: number, body: unknown): Promise<Result<GitHubResponse, GitHubFailure>> => Promise.resolve(ok({ status, headers: {}, body, evidence_digest: hashCanonical({ status, body }) }));
    const r = `repos/${this.repo}`;
    if (req.method === 'POST' && req.path === `${r}/pulls`) {
      const b = req.body as { title: string; head: string; base: string; body: string };
      const sha = this.headOf(b.head);
      if (sha === null) return Promise.resolve(err({ reason: 'http_error', status: 422, detail: 'HTTP 422', retry_after_ms: null }));
      const pr: FakePr = { number: this.#next, id: this.#next * 100, title: b.title, body: b.body, head: { ref: b.head, sha }, base: b.base, state: 'open', merged_at: null, merge_commit: null };
      this.#next++;
      this.prs.push(pr);
      return reply(201, this.#pull(pr));
    }
    if (req.method !== 'GET') return Promise.resolve(err({ reason: 'not_allowed', status: null, detail: 'unexpected write', retry_after_ms: null }));
    if (req.path === `${r}/pulls`) {
      const head = (req.query['head'] ?? '').split(':')[1];
      return reply(200, req.query['page'] === '1' ? this.prs.filter((p) => p.head.ref === head).map((p) => this.#pull(p)) : []);
    }
    const pull = /\/pulls\/(\d+)(\/merge)?$/.exec(req.path);
    if (pull !== null) {
      const p = this.prs.find((x) => x.number === Number(pull[1]));
      if (p === undefined) return Promise.resolve(err({ reason: 'http_error', status: 404, detail: 'HTTP 404', retry_after_ms: null }));
      // Keep the head in step with pushes until the PR is merged.
      if (p.merged_at === null) p.head.sha = this.headOf(p.head.ref) ?? p.head.sha;
      if (pull[2] !== undefined) return p.merged_at === null ? Promise.resolve(err({ reason: 'http_error', status: 404, detail: 'HTTP 404', retry_after_ms: null })) : reply(204, null);
      return reply(200, this.#pull(p));
    }
    const events = /\/issues\/(\d+)\/events$/.exec(req.path);
    if (events !== null) {
      const p = this.prs.find((x) => x.number === Number(events[1]));
      const merged = p?.merged_at != null && p.merge_commit !== null ? [{ id: 1, event: 'merged', commit_id: p.merge_commit, commit_url: `https://api.github.com/repos/${this.repo}/commits/${p.merge_commit}`, created_at: p.merged_at }] : [];
      return reply(200, req.query['page'] === '1' ? merged : []);
    }
    if (/\/rules\/branches\//.test(req.path)) return reply(200, []);
    if (/\/branches\/[^/]+$/.test(req.path)) return reply(200, { protected: false });
    const runs = /\/commits\/([0-9a-f]{40})\/check-runs$/.exec(req.path);
    if (runs !== null) {
      const sha = runs[1] as string;
      const list = Object.entries(this.checks.get(sha) ?? {}).map(([name, conclusion], i) => ({ id: i + 1, name, status: 'completed', conclusion, head_sha: sha, app: { id: 15368 } }));
      return reply(200, { total_count: list.length, check_runs: req.query['page'] === '1' ? list : [] });
    }
    if (/\/statuses$/.test(req.path)) return reply(200, []);
    return Promise.resolve(err({ reason: 'http_error', status: 404, detail: `HTTP 404 ${req.path}`, retry_after_ms: null }));
  }
}
