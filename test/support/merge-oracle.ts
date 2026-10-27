import type { FrozenPolicy } from '../../src/domain/policy.ts';
import type { TaskState } from '../../src/domain/state.ts';

/** Oracle độc lập với `src/engine/merge-guard.ts`, viết thẳng từ FR-015 và research R-10. */
export function mergeAllowed(s: TaskState, p: FrozenPolicy, head: string): string | null {
  if (s.cancellation !== null) return 'đang hủy';
  if (s.head_sha !== head) return 'head khác head hiện hành';
  const rev = s.revision;
  const approval = Object.values(s.approvals).some((a) => a.kind === 'merge' && a.status === 'granted' && !a.revoked && a.revision === rev && a.head_sha === head);
  if (!approval) return 'thiếu approval merge gắn head';
  const reviews = s.evidence.reviews.filter((r) => r.valid && r.revision === rev && r.head_sha === head);
  const skipped = s.evidence.review_skipped.some((r) => r.valid && r.revision === rev);
  if (reviews.at(-1)?.verdict !== 'approve' && !skipped) return 'thiếu review approve cho head';
  const ci = s.evidence.ci.filter((c) => c.valid && c.revision === rev && c.head_sha === head).at(-1);
  if (ci === undefined) return 'thiếu CI cho head';
  if (!ci.required_set.complete) return 'required_set chưa đầy đủ';
  const expected = new Set([...p.ci.required_checks, ...ci.required_set.names]);
  for (const name of expected) {
    if (ci.checks.find((c) => c.name === name)?.state !== 'success') return `check ${name} chưa success`;
  }
  const base = s.evidence.base_relations.filter((b) => b.valid && b.revision === rev && b.head_sha === head && b.base_ref === s.task.base_branch).at(-1);
  if (base?.head_contains_base !== true) return 'head chưa chứa base';
  return null;
}
