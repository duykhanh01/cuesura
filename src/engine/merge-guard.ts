import type { FrozenPolicy } from '../domain/policy.ts';
import type { Evidence, TaskState } from '../domain/state.ts';
import type { Check, RequiredSet } from '../domain/trigger.ts';

export type CiVerdict =
  | { kind: 'pass' }
  | { kind: 'fail'; failed: string[] }
  | {
      kind: 'incomplete';
      missing: string[];
      not_passed: string[];
      complete: boolean;
    };

/** Tập kỳ vọng = hợp `ci.required_checks` của chính sách và `required_set.names` (research R-10). */
export function expectedChecks(
  policy: FrozenPolicy,
  rs: RequiredSet,
): string[] {
  return [...new Set([...policy.ci.required_checks, ...rs.names])].sort();
}

/**
 * Chỉ `success` là đạt; tên kỳ vọng vắng trong `checks` là `missing`; `complete = false` không bao giờ
 * đạt (FR-015). Check kỳ vọng `failure` làm CI thất bại để bước phân loại xử lý.
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
  const notPassed = expected.filter(
    (n) => byName.has(n) && byName.get(n)?.state !== 'success',
  );
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

/** Kết quả CI mới nhất còn hiệu lực cho đúng head của revision hiện tại. */
export function latestCi(
  state: TaskState,
  head: string,
): Evidence['ci'][number] | undefined {
  return latest(
    state.evidence.ci,
    (c) => c.valid && c.revision === state.revision && c.head_sha === head,
  );
}

export type GuardFailure =
  | 'cancelling'
  | 'no_head'
  | 'review_missing'
  | 'checks_incomplete'
  | 'checks_failed'
  | 'base_outdated'
  | 'approval_missing';

export type GuardResult =
  { ok: true; head_sha: string } | { ok: false; code: GuardFailure };

/**
 * Điều kiện merge của SPEC.md §14.2 theo research R-10, chỉ dùng bằng chứng còn hiệu lực của revision hiện
 * tại và gắn đúng head (quan hệ base còn phải đúng branch đích): review approve (hoặc review được bỏ theo `skip_when`), CI đạt cho tập kỳ vọng đầy
 * đủ, head chứa base tip, approval merge của người cho head đó, và không có yêu cầu hủy.
 */
export function mergeGuard(
  state: TaskState,
  policy: FrozenPolicy,
): GuardResult {
  if (state.cancellation !== null) return { ok: false, code: 'cancelling' };
  const head = state.head_sha;
  if (head === null) return { ok: false, code: 'no_head' };
  const rev = state.revision;

  const review = latest(
    state.evidence.reviews,
    (r) => r.valid && r.revision === rev && r.head_sha === head,
  );
  const skipped = state.evidence.review_skipped.some(
    (r) => r.valid && r.revision === rev,
  );
  if (review?.verdict !== 'approve' && !skipped)
    return { ok: false, code: 'review_missing' };

  const ci = latestCi(state, head);
  if (ci === undefined) return { ok: false, code: 'checks_incomplete' };
  const verdict = ciVerdict(policy, ci.required_set, ci.checks);
  if (verdict.kind === 'fail') return { ok: false, code: 'checks_failed' };
  if (verdict.kind === 'incomplete')
    return { ok: false, code: 'checks_incomplete' };

  // Chỉ bằng chứng cho đúng cặp head và branch đích (`base_ref`) mới chứng minh head chứa base tip (FR-015).
  const target = state.task.base_branch;
  const base = latest(
    state.evidence.base_relations,
    (b) =>
      b.valid &&
      b.revision === rev &&
      b.head_sha === head &&
      b.base_ref === target,
  );
  if (base?.head_contains_base !== true)
    return { ok: false, code: 'base_outdated' };

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
