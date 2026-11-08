import type { FrozenPolicy } from '../../src/domain/policy.ts';
import type { TaskState } from '../../src/domain/state.ts';

/** Independent merge oracle derived from the specification rather than the production guard. */
export function mergeAllowed(s: TaskState, p: FrozenPolicy, head: string): string | null {
  if (s.cancellation !== null) return 'cancellation requested';
  if (s.head_sha !== head) return 'head differs from the current head';
  const rev = s.revision;
  const approval = Object.values(s.approvals).some(
    (a) =>
      a.kind === 'merge' &&
      a.status === 'granted' &&
      !a.revoked &&
      a.revision === rev &&
      a.head_sha === head,
  );
  if (!approval) return 'head-bound merge approval is missing';
  const reviews = s.evidence.reviews.filter(
    (r) => r.valid && r.revision === rev && r.head_sha === head,
  );
  const skipped = s.evidence.review_skipped.some((r) => r.valid && r.revision === rev);
  // A minor fix of the revision's latest, approving review carries that approval to its commit.
  const latest = s.run.reviews.filter((r) => r.valid && r.revision === rev).at(-1);
  const fix = s.run.minor_fix;
  const carried =
    fix !== undefined &&
    fix.revision === rev &&
    fix.sha === head &&
    latest?.verdict === 'approve' &&
    latest.attempt_id === fix.review_attempt_id &&
    latest.sha === fix.approved_sha;
  if (reviews.at(-1)?.verdict !== 'approve' && !skipped && !carried)
    return 'review approval for the head is missing';
  const ci = s.evidence.ci
    .filter((c) => c.valid && c.revision === rev && c.head_sha === head)
    .at(-1);
  if (ci === undefined) return 'CI evidence for the head is missing';
  if (!ci.required_set.complete) return 'required_set is incomplete';
  const expected = new Set([...p.ci.required_checks, ...ci.required_set.names]);
  for (const name of expected) {
    // Skipped (GitHub skipped/neutral) passes only while no check of the head failed or was cancelled.
    const state = ci.checks.find((c) => c.name === name)?.state;
    const skipOk = ci.checks.every((c) => c.state !== 'failure' && c.state !== 'cancelled');
    if (state !== 'success' && !(state === 'skipped' && skipOk))
      return `check ${name} has not passed`;
  }
  const base = s.evidence.base_relations
    .filter(
      (b) =>
        b.valid && b.revision === rev && b.head_sha === head && b.base_ref === s.task.base_branch,
    )
    .at(-1);
  if (base?.head_contains_base !== true) return 'head does not contain the base';
  return null;
}
