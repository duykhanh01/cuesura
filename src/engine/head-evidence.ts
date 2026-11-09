import type { TaskState } from '../domain/state.ts';
import { type Check, checkPasser } from '../domain/trigger.ts';
import type { RequiredVerdict } from './required-checks.ts';

/**
 * Green predicate of one head (T043, FR-019, FR-041.06, FR-042.08). A head is green only when, for the
 * head this task checked:
 * - the complete GitHub requirement list is known (FR-042);
 * - check runs and statuses were read completely, and no required name has an unresolved collision;
 * - every check in the snapshot/GitHub union passed under `checkPasser`: `success`, or `skipped`
 *   (GitHub skipped/neutral) while no current check of the head failed or was cancelled; pending,
 *   cancelled, missing and unknown do not;
 * - the latest gate run of the revision passed; with a confirmed mode it passed on the checkpoint tree
 *   of this very head (M06);
 * - `full-review` (and legacy tasks): a review approving this head is still valid; `direct-pr`: no
 *   review is required and none is made up, the verdict says so (M08). A head-specific base integration
 *   certificate can exempt a new review only under SPEC §14.2.
 * A different observed head never becomes the checked head here: it is `head_changed`, and neither the
 * expected head nor the CI budget moves because of it.
 */

export type ObservedChecks = {
  readonly head_sha: string;
  readonly checks: readonly Check[];
  /** Names with more than one source/identity that could not be told apart. */
  readonly collisions: readonly string[];
  readonly complete: boolean;
};

export type ReviewRequirement = 'approved' | 'missing' | 'not_required';

export type HeadVerdict =
  | {
      readonly kind: 'green';
      readonly head_sha: string;
      readonly review: 'approved' | 'not_required';
    }
  | {
      readonly kind: 'head_changed';
      readonly expected: string;
      readonly observed: string;
    }
  | {
      readonly kind: 'not_green';
      readonly head_sha: string;
      readonly required: RequiredVerdict['kind'];
      readonly incomplete: boolean;
      readonly collisions: readonly string[];
      readonly failed: readonly string[];
      readonly not_passed: readonly string[];
      readonly missing: readonly string[];
      readonly gate: 'passed' | 'missing' | 'failed' | 'other_tree';
      readonly review: ReviewRequirement;
    };

export function headVerdict(
  state: Pick<TaskState, 'revision' | 'evidence' | 'run'>,
  snapshot: readonly string[],
  expectedHead: string,
  required: RequiredVerdict,
  observed: ObservedChecks,
): HeadVerdict {
  if (observed.head_sha !== expectedHead)
    return {
      kind: 'head_changed',
      expected: expectedHead,
      observed: observed.head_sha,
    };
  const names = [
    ...new Set([...snapshot, ...(required.kind === 'covered' ? required.github : [])]),
  ].sort();
  const rev = state.revision;
  const byName = new Map<string, Check[]>();
  for (const c of observed.checks) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  const collisions = [
    ...new Set([
      ...observed.collisions.filter((n) => names.includes(n)),
      ...names.filter((n) => (byName.get(n)?.length ?? 0) > 1),
    ]),
  ].sort();
  const missing = names.filter((n) => !byName.has(n));
  const single = (n: string): Check | undefined =>
    collisions.includes(n) ? undefined : byName.get(n)?.[0];
  const failed = names.filter((n) => single(n)?.state === 'failure');
  const passed = checkPasser(observed.checks);
  const notPassed = names.filter(
    (n) =>
      byName.has(n) &&
      !collisions.includes(n) &&
      single(n)?.state !== 'failure' &&
      !passed(single(n)!.state),
  );

  const gates = state.evidence.gates.filter((g) => g.valid && g.revision === rev);
  const lastGate = gates.at(-1);
  const cp = state.run.checkpoint;
  const onCheckpoint =
    state.run.mode === null || (cp !== null && cp.revision === rev && cp.sha === expectedHead);
  const gate =
    lastGate === undefined
      ? 'missing'
      : !lastGate.passed
        ? 'failed'
        : onCheckpoint
          ? 'passed'
          : 'other_tree';
  const review = reviewOf(state, expectedHead);

  const green =
    required.kind === 'covered' &&
    observed.complete &&
    collisions.length === 0 &&
    missing.length === 0 &&
    failed.length === 0 &&
    notPassed.length === 0 &&
    gate === 'passed' &&
    review !== 'missing';
  if (green)
    return {
      kind: 'green',
      head_sha: expectedHead,
      review: review === 'approved' ? 'approved' : 'not_required',
    };
  return {
    kind: 'not_green',
    head_sha: expectedHead,
    required: required.kind,
    incomplete: !observed.complete,
    collisions,
    failed,
    not_passed: notPassed,
    missing,
    gate,
    review,
  };
}

/**
 * Review requirement of `head`: `direct-pr` needs none; a confirmed `full-review` needs the latest
 * verdict recorded for that commit in this revision to be an approval; a legacy task keeps the old rule.
 * A certified base integration is the narrow exception: no conflict or only conflict files changed.
 */
export function reviewOf(
  state: Pick<TaskState, 'revision' | 'evidence' | 'run'>,
  head: string,
): ReviewRequirement {
  const rev = state.revision;
  const update = state.run.base_update;
  if (
    update?.revision === rev &&
    // An update in a review/fix round carries that round's fix, which the review has not seen.
    update.fix_step === undefined &&
    update.certificate?.head_sha === head &&
    update.certificate.tree === state.run.checkpoint?.tree &&
    state.run.checkpoint.sha === head &&
    state.run.checkpoint.revision === rev &&
    (update.conflict === undefined || update.scope !== undefined) &&
    (update.scope === undefined || update.scope.tree === update.certificate.tree) &&
    update.scope?.unresolved !== true &&
    ((update.scope?.unchanged_conflicts?.length ?? 0) === 0 ||
      update.manual_resolution !== undefined) &&
    (update.scope?.outside_files.length ?? 0) === 0
  )
    return 'not_required';
  if (
    update?.revision === rev &&
    update.scope !== undefined &&
    update.scope.outside_files.length > 0 &&
    state.run.mode === 'direct-pr'
  )
    return 'missing';
  if (state.run.mode === 'direct-pr') return 'not_required';
  if (state.run.mode === 'full-review') {
    const last = state.run.reviews
      .filter((r) => r.valid && r.revision === rev && r.sha === head)
      .at(-1);
    if (last === undefined && minorFixApproved(state, head)) return 'approved';
    return last?.verdict === 'approve' ? 'approved' : 'missing';
  }
  return state.evidence.reviews.some(
    (r) => r.valid && r.revision === rev && r.head_sha === head && r.verdict === 'approve',
  )
    ? 'approved'
    : 'missing';
}

/**
 * `head` is the checkpoint of a minor fix whose approving review is still the latest verdict of this
 * revision: the approval carries over to it (gates passed there, and only finding files and tests changed).
 */
export function minorFixApproved(
  state: Pick<TaskState, 'revision' | 'run'>,
  head: string,
): boolean {
  const fix = state.run.minor_fix;
  if (fix === undefined || fix.revision !== state.revision || fix.sha !== head) return false;
  const last = state.run.reviews.filter((r) => r.valid && r.revision === state.revision).at(-1);
  return (
    last?.attempt_id === fix.review_attempt_id &&
    last.verdict === 'approve' &&
    last.sha === fix.approved_sha
  );
}
