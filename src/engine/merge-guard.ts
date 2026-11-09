import type { FrozenPolicy } from '../domain/policy.ts';
import type { Evidence, TaskState } from '../domain/state.ts';
import { type Check, checkPasser, type RequiredSet } from '../domain/trigger.ts';
import { canonicalJson } from '../shared/canonical-json.ts';
import { minorFixApproved } from './head-evidence.ts';

export type CiVerdict =
  | { kind: 'pass' }
  | { kind: 'fail'; failed: string[] }
  | {
      kind: 'incomplete';
      missing: string[];
      not_passed: string[];
      complete: boolean;
    };

/** Expected checks are the union of frozen ci.required_checks and required_set.names. */
export function expectedChecks(policy: FrozenPolicy, rs: RequiredSet): string[] {
  return [...new Set([...policy.ci.required_checks, ...rs.names])].sort();
}

/**
 * Expected checks must pass under `checkPasser` over all current checks of the head. Missing names or
 * incomplete observations never satisfy the merge guard.
 */
export function ciVerdict(
  policy: FrozenPolicy,
  rs: RequiredSet,
  checks: readonly Check[],
): CiVerdict {
  const expected = expectedChecks(policy, rs);
  const byName = new Map(checks.map((c) => [c.name, c]));
  const failed = expected.filter((n) => byName.get(n)?.state === 'failure');
  if (failed.length > 0) return { kind: 'fail', failed };
  const missing = expected.filter((n) => !byName.has(n));
  const passed = checkPasser(checks);
  const notPassed = expected.filter((n) => byName.has(n) && !passed(byName.get(n)!.state));
  if (!rs.complete || missing.length > 0 || notPassed.length > 0) {
    return {
      kind: 'incomplete',
      missing,
      not_passed: notPassed,
      complete: rs.complete,
    };
  }
  return { kind: 'pass' };
}

function latest<T>(xs: readonly T[], ok: (x: T) => boolean): T | undefined {
  for (let i = xs.length - 1; i >= 0; i--) if (ok(xs[i] as T)) return xs[i];
  return undefined;
}

export function latestCi(state: TaskState, head: string): Evidence['ci'][number] | undefined {
  return latest(
    state.evidence.ci,
    (c) => c.valid && c.revision === state.revision && c.head_sha === head,
  );
}

/** Whether a CI read says nothing the head's latest recorded CI evidence does not already hold. */
export function heldCi(
  state: TaskState,
  ci: { head_sha: string; required_set: unknown; checks: unknown; required?: unknown },
): boolean {
  const prior = latestCi(state, ci.head_sha);
  const view = (c: { required_set: unknown; checks: unknown; required?: unknown }) =>
    canonicalJson({ r: c.required_set, c: c.checks, required: c.required ?? null });
  return prior !== undefined && view(prior) === view(ci);
}

export type GuardFailure =
  | 'cancelling'
  | 'no_head'
  | 'review_missing'
  | 'checks_incomplete'
  | 'checks_failed'
  | 'base_outdated'
  | 'approval_missing';

export type GuardResult = { ok: true; head_sha: string } | { ok: false; code: GuardFailure };

/**
 * Merge requires current revision/head evidence: approved or skipped review, complete CI, base
 * ancestry, human head-bound merge approval, and no cancellation.
 */
export function mergeGuard(state: TaskState, policy: FrozenPolicy): GuardResult {
  if (state.cancellation !== null) return { ok: false, code: 'cancelling' };
  const head = state.head_sha;
  if (head === null) return { ok: false, code: 'no_head' };
  const rev = state.revision;

  const review = latest(
    state.evidence.reviews,
    (r) => r.valid && r.revision === rev && r.head_sha === head,
  );
  const skipped = state.evidence.review_skipped.some((r) => r.valid && r.revision === rev);
  if (review?.verdict !== 'approve' && !skipped && !minorFixApproved(state, head))
    return { ok: false, code: 'review_missing' };

  const ci = latestCi(state, head);
  if (ci === undefined) return { ok: false, code: 'checks_incomplete' };
  const verdict = ciVerdict(policy, ci.required_set, ci.checks);
  if (verdict.kind === 'fail') return { ok: false, code: 'checks_failed' };
  if (verdict.kind === 'incomplete') return { ok: false, code: 'checks_incomplete' };

  // Base ancestry evidence must match both the head and target base_ref.
  const target = state.task.base_branch;
  const base = latest(
    state.evidence.base_relations,
    (b) => b.valid && b.revision === rev && b.head_sha === head && b.base_ref === target,
  );
  if (base?.head_contains_base !== true) return { ok: false, code: 'base_outdated' };

  const approved = Object.values(state.approvals).some(
    (a) =>
      a.kind === 'merge' &&
      a.status === 'granted' &&
      !a.revoked &&
      a.revision === rev &&
      a.head_sha === head,
  );
  if (!approved) return { ok: false, code: 'approval_missing' };
  return { ok: true, head_sha: head };
}
