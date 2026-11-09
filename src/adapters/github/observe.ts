/**
 * One observation of the task's PR (T044, contracts/github.md "API read bundle"): pull → (merge
 * evidence | required checks + checks of the observed head) → pull again. Identity (immutable repo ID,
 * PR ID, target) must match the task before anything else counts. A pull that changed between the two
 * reads is `inconsistent`, so evidence of two heads is never mixed; a merge seen on the second read
 * switches to the merge branch. The adapter reports facts only; the engine decides what they mean.
 */
import type { RequiredEvidence } from '../../domain/runtime.ts';
import type { GitHubPort } from '../ports.ts';
import { readHeadChecks, type HeadChecks } from './checks.ts';
import { listAll } from './gh-port.ts';
import { pullFacts, readMergeEvidence, type MergeEvidence, type PullFacts } from './merge-proof.ts';
import {
  normalizeRequirements,
  rulesetIdsToRead,
  type GhList,
  type GhRead,
} from './requirements.ts';

export type ObserveTarget = {
  readonly repo: string;
  readonly immutable_repo_id: string;
  readonly pr_number: number;
  /** Known after the PR was created or recovered; null only before the first read. */
  readonly pr_id: string | null;
  readonly target: string;
  /** When the task's draft PR was turned ready: skipped check runs that finished earlier are ignored. */
  readonly skipped_before?: number | null;
};

export type PullObservation =
  | {
      readonly status: 'merged';
      readonly pull: PullFacts;
      readonly merge: MergeEvidence;
      readonly reasons: readonly string[];
    }
  | {
      readonly status: 'open' | 'closed';
      readonly pull: PullFacts;
      readonly required: RequiredEvidence;
      readonly checks: HeadChecks | null;
      readonly reasons: readonly string[];
    }
  /**
   * A PR that targets (or was merged into) another branch: nothing of that branch is read or counted,
   * and a merge there is no completion evidence (FR-040.12, FR-041.05).
   */
  | {
      readonly status: 'target_mismatch';
      readonly pull: PullFacts;
      readonly reasons: readonly string[];
    }
  | {
      readonly status: 'inconsistent' | 'identity_mismatch' | 'unknown';
      readonly pull: PullFacts | null;
      readonly reasons: readonly string[];
    };

async function read(port: GitHubPort, path: string): Promise<GhRead> {
  const r = await port.request({ method: 'GET', path, query: {}, body: null });
  return r.ok
    ? { ok: true, status: r.value.status, body: r.value.body }
    : {
        ok: false,
        status: r.error.status,
        body: r.error.body ?? null,
        reason: r.error.detail,
      };
}

/** Branch → classic protection (when protected) → every rules page → each referenced ruleset. */
export async function readRequirements(
  port: GitHubPort,
  repo: string,
  branch: string,
  observedAt: number,
): Promise<RequiredEvidence> {
  const b = encodeURIComponent(branch);
  const branchRead = await read(port, `repos/${repo}/branches/${b}`);
  const isProtected =
    branchRead.ok && (branchRead.body as { protected?: unknown } | null)?.protected === true;
  const protection = isProtected
    ? await read(port, `repos/${repo}/branches/${b}/protection`)
    : null;
  let rules: GhList | null = null;
  const rulesets = new Map<number, GhRead>();
  if (branchRead.ok) {
    const listed = await listAll(port, `repos/${repo}/rules/branches/${b}`, (body) =>
      Array.isArray(body) ? body : null,
    );
    rules = listed.ok
      ? { ok: true, items: listed.value.items, complete: listed.value.complete }
      : { ok: false, reason: listed.error.detail };
    for (const id of rulesetIdsToRead(rules))
      rulesets.set(id, await read(port, `repos/${repo}/rulesets/${id}`));
  }
  return normalizeRequirements(
    {
      target: { repo, branch },
      branch: branchRead,
      protection,
      rules,
      rulesets,
    },
    observedAt,
  );
}

function identityOk(p: PullFacts, t: ObserveTarget): boolean {
  return (
    String(p.base.repo_id) === t.immutable_repo_id &&
    p.number === t.pr_number &&
    (t.pr_id === null || String(p.id) === t.pr_id)
  );
}

export async function observePull(
  port: GitHubPort,
  t: ObserveTarget,
  observedAt: number,
): Promise<PullObservation> {
  const path = `repos/${t.repo}/pulls/${t.pr_number}`;
  const first = await port.request({
    method: 'GET',
    path,
    query: {},
    body: null,
  });
  if (!first.ok)
    return {
      status: 'unknown',
      pull: null,
      reasons: [`pull unreadable: ${first.error.detail}`],
    };
  const pull = pullFacts(first.value.body);
  if (!identityOk(pull, t))
    return {
      status: 'identity_mismatch',
      pull,
      reasons: ['repo/PR identity does not match the task'],
    };
  const reasons = pull.base.ref === t.target ? [] : ['target does not match the task'];
  // Checked before the merge branch: a PR merged into another branch is a target mismatch, not a merge.
  if (pull.base.ref !== null && pull.base.ref !== t.target)
    return { status: 'target_mismatch', pull, reasons };

  if (pull.merged === true)
    return {
      status: 'merged',
      pull,
      merge: await readMergeEvidence(port, t.repo, t.pr_number, pull, pull.base.repo_id, t.target),
      reasons,
    };
  if (
    pull.head.sha === null ||
    pull.base.ref === null ||
    pull.merged !== false ||
    (pull.state !== 'open' && pull.state !== 'closed')
  ) {
    return { status: 'unknown', pull, reasons: ['pull facts incomplete'] };
  }

  const required = await readRequirements(port, t.repo, pull.base.ref, observedAt);
  const checks = /^[0-9a-f]{40}$/.test(pull.head.sha)
    ? await readHeadChecks(port, t.repo, pull.head.sha, t.skipped_before ?? null)
    : null;
  const second = await port.request({
    method: 'GET',
    path,
    query: {},
    body: null,
  });
  if (!second.ok)
    return {
      status: 'unknown',
      pull,
      reasons: [`second pull read failed: ${second.error.detail}`],
    };
  const again = pullFacts(second.value.body);
  if (!identityOk(again, t))
    return {
      status: 'identity_mismatch',
      pull: again,
      reasons: ['repo/PR identity changed between reads'],
    };
  if (again.merged === true) {
    if (again.base.ref !== null && again.base.ref !== t.target)
      return {
        status: 'target_mismatch',
        pull: again,
        reasons: ['target does not match the task', 'merged during observation'],
      };
    return {
      status: 'merged',
      pull: again,
      merge: await readMergeEvidence(
        port,
        t.repo,
        t.pr_number,
        again,
        again.base.repo_id,
        t.target,
      ),
      reasons: [...reasons, 'merged during observation'],
    };
  }
  if (
    again.head.sha !== pull.head.sha ||
    again.base.ref !== pull.base.ref ||
    again.base.sha !== pull.base.sha ||
    again.state !== pull.state
  ) {
    return {
      status: 'inconsistent',
      pull: again,
      reasons: ['head/base/state changed between reads'],
    };
  }
  const checkReasons =
    checks === null
      ? ['observed head is not a commit SHA']
      : !checks.ok
        ? [`checks unreadable: ${checks.error.detail}`]
        : [];
  return {
    status: pull.state,
    pull,
    required,
    checks: checks?.ok === true ? checks.value : null,
    reasons: checkReasons,
  };
}
