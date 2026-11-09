/**
 * Read-only probes of GitHub effects before any retry (T089, FR-017/018/034.01, contracts/github.md
 *). Each logical effect is found again by its own identity: the PR by repo ID,
 * head/base tuple and the canonical marker with the operation key across every state; a description
 * update by the body digest it sent; a CI rerun by the workflow runs of the head that started a new
 * attempt after the operation was claimed. A probe only reads. Several matches, a body someone edited
 * or a read that fails is reported as such and keeps the effect waiting; nothing here creates, patches
 * or posts, and how many requests a probe took says nothing about how many logical effects happened.
 */
import type { GitHubPort } from '../ports.ts';
import { listAll } from './gh-port.ts';
import {
  bodyDigest,
  finalBody,
  findTaskPr,
  readPrBody,
  type DescriptionUpdate,
  type FoundPr,
  type PrSpec,
} from './publish.ts';
import { workflowRunOf, type RerunRequest, type RerunRun } from './rerun.ts';

export type PrProbe = FoundPr | { readonly kind: 'absent' };

/** The task's PR on its tuple, in any state; `absent` only after a complete listing showed none. */
export async function probePr(port: GitHubPort, s: PrSpec): Promise<PrProbe> {
  return (await findTaskPr(port, s)) ?? { kind: 'absent' };
}

export type DescriptionProbe =
  /** GitHub carries the body this update sends. */
  | { readonly kind: 'current'; readonly body_digest: string }
  /** GitHub still carries the body the task sent before: the update did not apply. */
  | { readonly kind: 'not_applied' }
  /** Neither: a person edited the description; nothing is overwritten. */
  | { readonly kind: 'body_changed'; readonly observed_digest: string }
  | { readonly kind: 'unknown'; readonly detail: string };

/** Where a description update stands, judged by body digests only. */
export async function probeDescription(
  port: GitHubPort,
  u: DescriptionUpdate,
): Promise<DescriptionProbe> {
  const want = bodyDigest(finalBody(u.spec));
  const read = await readPrBody(port, u.repo, u.pr_number);
  if (typeof read === 'string') return { kind: 'unknown', detail: `read: ${read}` };
  const seen = bodyDigest(read.body);
  if (seen === want) return { kind: 'current', body_digest: want };
  if (seen === u.expected_body_digest) return { kind: 'not_applied' };
  return { kind: 'body_changed', observed_digest: seen };
}

export type RerunProbe =
  | {
      readonly kind: 'rerun';
      readonly runs: readonly RerunRun[];
      readonly checks: readonly string[];
    }
  | { readonly kind: 'unknown'; readonly detail: string };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {};

/**
 * Whether the rerun requested for `head_sha` happened: every workflow run behind the named checks is a
 * run of that head with a later attempt that started at or after `since` (when the operation was
 * claimed). GitHub has no idempotency for the POST, so anything short of that proof is `unknown`, never
 * "not sent": the POST may still be queued.
 */
export async function probeRerun(
  port: GitHubPort,
  req: RerunRequest & { readonly since: number },
): Promise<RerunProbe> {
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
    };
  if (!listed.value.complete) return { kind: 'unknown', detail: 'check run list incomplete' };
  // A rerun replaces the failed check runs; the newest one per name says which run it belongs to.
  const newest = new Map<string, Obj>();
  for (const r of listed.value.items) {
    const o = obj(r);
    if (
      typeof o['name'] !== 'string' ||
      typeof o['id'] !== 'number' ||
      o['head_sha'] !== req.head_sha
    )
      continue;
    const prev = newest.get(o['name']);
    if (prev === undefined || (prev['id'] as number) < o['id']) newest.set(o['name'], o);
  }
  const byRun = new Map<number, string[]>();
  for (const name of [...new Set(req.checks)].sort()) {
    const id = workflowRunOf(newest.get(name));
    if (id === null) return { kind: 'unknown', detail: `check ${name} maps to no run` };
    byRun.set(id, [...(byRun.get(id) ?? []), name]);
  }
  if (byRun.size === 0) return { kind: 'unknown', detail: 'no checks named' };
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
      };
    const run = obj(read.value.body);
    const attempt = run['run_attempt'];
    const started =
      typeof run['run_started_at'] === 'string' ? Date.parse(run['run_started_at']) : Number.NaN;
    if (run['head_sha'] !== req.head_sha)
      return {
        kind: 'unknown',
        detail: `workflow run ${id} is not a run of ${req.head_sha}`,
      };
    if (
      typeof attempt !== 'number' ||
      attempt < 2 ||
      !Number.isFinite(started) ||
      started < req.since
    )
      return {
        kind: 'unknown',
        detail: `workflow run ${id} shows no attempt since the request`,
      };
    runs.push({ run_id: id, attempt, checks });
  }
  return { kind: 'rerun', runs, checks: runs.flatMap((r) => r.checks).sort() };
}
