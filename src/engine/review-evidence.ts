import type { FrozenPolicy } from '../domain/policy.ts';
import type { ReviewEvidence, TaskState } from '../domain/state.ts';
import { hashCanonical } from '../shared/hash.ts';

/**
 * Review input of a `full-review` task (task-execution-modes.md,
 * M03): task/revision, the base the diff is taken from, the checkpoint commit/tree/diff, the worker's
 * PR content (without the orchestrator's marker), the frozen acceptance/conventions and the review
 * policy/binding. Attempt IDs, timestamps, new gate/CI receipts or a resume log are not part of it.
 * `null` until this revision has a checkpoint.
 */
export function reviewInputDigest(
  s: Pick<TaskState, 'id' | 'revision' | 'run' | 'context_ref'>,
  policy: FrozenPolicy,
  step: string,
): string | null {
  const cp = s.run.checkpoint;
  if (cp === null || cp.revision !== s.revision) return null;
  const sp = policy.steps[step];
  return hashCanonical({
    task_id: s.id,
    revision: s.revision,
    base_sha: cp.base_sha,
    sha: cp.sha,
    tree: cp.tree,
    diff_digest: cp.diff_digest,
    content_digest: s.run.content?.digest ?? cp.content_digest,
    context_hash: s.context_ref?.hash ?? null,
    review: sp === undefined ? null : { role: sp.role, binding: sp.binding, ladder: sp.ladder },
    structure_hash: policy.structure_hash,
  });
}

/** A recorded verdict of this revision for exactly this input, if any; never one for another SHA. */
export function reusableReview(
  s: Pick<TaskState, 'revision' | 'run'>,
  digest: string,
): ReviewEvidence | undefined {
  return s.run.reviews
    .filter((r) => r.valid && r.revision === s.revision && r.input_digest === digest)
    .at(-1);
}
