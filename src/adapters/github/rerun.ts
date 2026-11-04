/**
 * Re-run of failed CI jobs (T057, FR-020, contracts/github.md). Only reached after the engine classified
 * the failure as infra/flaky by the frozen ci rules and the step's own limit allowed it; this adapter
 * decides nothing about that. For the head the task published, each failing check run named in the
 * request is mapped to its workflow run (from `details_url`), the run is read back to confirm it belongs
 * to that very head (its generation: run ID and attempt), and `rerun-failed-jobs` is posted once per run.
 * A POST whose answer was lost is `unknown`: it may have applied, so it is never sent again blindly and
 * nothing after it is sent; a refusal (4xx) is `failed`. Never a merge, never a push.
 */
import type { GitHubPort } from '../ports.ts';
import { listAll } from './gh-port.ts';
import { checkRunState } from './checks.ts';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {};

export type RerunRequest = {
  readonly repo: string;
  readonly head_sha: string;
  readonly checks: readonly string[];
};

export type RerunRun = {
  readonly run_id: number;
  readonly attempt: number | null;
  readonly checks: readonly string[];
};

export type RerunResult =
  | {
      readonly kind: 'rerun';
      readonly runs: readonly RerunRun[];
      readonly checks: readonly string[];
    }
  /** Nothing failing could be tied to a workflow run of this head: no POST was sent. */
  | { readonly kind: 'nothing_to_rerun'; readonly reason: string }
  | {
      readonly kind: 'failed';
      readonly detail: string;
      readonly sent: readonly number[];
    }
  | {
      readonly kind: 'unknown';
      readonly detail: string;
      readonly sent: readonly number[];
    };

const RUN_URL = /\/actions\/runs\/(\d+)(?:\/|$)/;

/** Workflow run ID of a check run, from its `details_url`; null for checks not made by Actions. */
export function workflowRunOf(checkRun: unknown): number | null {
  const url = obj(checkRun)['details_url'];
  const m = typeof url === 'string' ? RUN_URL.exec(url) : null;
  return m === null ? null : Number(m[1]);
}

export async function rerunFailedJobs(port: GitHubPort, req: RerunRequest): Promise<RerunResult> {
  if (!/^[0-9a-f]{40}$/.test(req.head_sha))
    return {
      kind: 'nothing_to_rerun',
      reason: `not a commit SHA: ${req.head_sha}`,
    };
  const listed = await listAll(
    port,
    `repos/${req.repo}/commits/${req.head_sha}/check-runs`,
    (b) => {
      const list = obj(b)['check_runs'];
      return Array.isArray(list) ? list : null;
    },
  );
  if (!listed.ok)
    return {
      kind: 'unknown',
      detail: `check runs unreadable: ${listed.error.detail}`,
      sent: [],
    };
  if (!listed.value.complete)
    return { kind: 'unknown', detail: 'check run list incomplete', sent: [] };
  // Current generation per name: the newest check run wins, as in the CI evidence.
  const current = new Map<string, Obj>();
  for (const r of listed.value.items) {
    const o = obj(r);
    if (
      typeof o['name'] !== 'string' ||
      typeof o['id'] !== 'number' ||
      o['head_sha'] !== req.head_sha
    )
      continue;
    const prev = current.get(o['name']);
    if (prev === undefined || (prev['id'] as number) < o['id']) current.set(o['name'], o);
  }
  const byRun = new Map<number, string[]>();
  for (const name of [...new Set(req.checks)].sort()) {
    const run = current.get(name);
    if (run === undefined || checkRunState(run['status'], run['conclusion']) !== 'failure')
      continue;
    const id = workflowRunOf(run);
    if (id === null) continue;
    byRun.set(id, [...(byRun.get(id) ?? []), name]);
  }
  if (byRun.size === 0)
    return {
      kind: 'nothing_to_rerun',
      reason: 'no failing check of this head maps to a workflow run',
    };

  const runs: RerunRun[] = [];
  for (const [id, checks] of [...byRun].sort(([a], [b]) => a - b)) {
    const read = await port.request({
      method: 'GET',
      path: `repos/${req.repo}/actions/runs/${id}`,
      query: {},
      body: null,
    });
    if (!read.ok)
      return {
        kind: 'unknown',
        detail: `workflow run ${id} unreadable: ${read.error.detail}`,
        sent: [],
      };
    const body = obj(read.value.body);
    if (body['head_sha'] !== req.head_sha)
      return {
        kind: 'nothing_to_rerun',
        reason: `workflow run ${id} is not a run of ${req.head_sha}`,
      };
    runs.push({
      run_id: id,
      attempt: typeof body['run_attempt'] === 'number' ? body['run_attempt'] : null,
      checks,
    });
  }
  const sent: number[] = [];
  for (const r of runs) {
    const post = await port.request({
      method: 'POST',
      path: `repos/${req.repo}/actions/runs/${r.run_id}/rerun-failed-jobs`,
      query: {},
      body: {},
    });
    if (!post.ok) {
      if (
        post.error.reason === 'http_error' &&
        post.error.status !== null &&
        post.error.status < 500
      )
        return { kind: 'failed', detail: post.error.detail, sent };
      return { kind: 'unknown', detail: post.error.detail, sent };
    }
    sent.push(r.run_id);
  }
  return { kind: 'rerun', runs, checks: runs.flatMap((r) => r.checks).sort() };
}
