/**
 * Yolo merges (SPEC §14.2). After a read of the task's PR, a task waiting for its merge is merged by this
 * code when the owner's user config has `yolo: true` right now and GitHub would enforce what the merge
 * relies on. The engine decides eligibility and records the `policy:yolo` approval before anything is
 * sent; the merge names the checked head, a resend after a lost answer is harmless, and the next
 * observation completes the task from its proof. No agent takes part. Anything else leaves the wait as
 * it is, so the user can still merge on GitHub.
 */
import {
  readMergeReadiness,
  sendMerge,
  type MergeTarget,
} from '../adapters/github/merge.ts';
import type { Clock, GitHubPort } from '../adapters/ports.ts';
import { submit } from '../application/triage.ts';
import { DEFAULT_MERGE_METHOD } from '../domain/merge-method.ts';
import type { TaskState } from '../domain/state.ts';
import { MAX_ENVELOPE_IDS } from '../domain/trigger.ts';
import { yoloApproved } from '../engine/external-completion.ts';
import type { Uuid } from '../shared/brand.ts';
import type { Store } from '../store/index.ts';

export type YoloDeps = {
  readonly store: Store;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly github: () => GitHubPort;
  /** The owner's current setting, read again for each merge; a config that cannot be read means off. */
  readonly enabled: () => Promise<boolean>;
  readonly log?: (line: string) => void;
};

export type YoloOutcome =
  | 'not_waiting'
  | 'off'
  | 'not_ready'
  | 'not_approved'
  | 'merged'
  | 'refused'
  | 'unknown';

function mergeWait(s: TaskState | null): s is TaskState {
  return (
    s !== null &&
    s.runtime_ref !== null &&
    s.wait?.detail.code === 'merge' &&
    s.cancellation === null &&
    s.completion === null &&
    s.head_sha !== null
  );
}

export async function yoloMerge(
  deps: YoloDeps,
  taskId: string,
): Promise<YoloOutcome> {
  const id = taskId as Uuid;
  const s = deps.store.readTask(id);
  if (!mergeWait(s)) return 'not_waiting';
  const pr = /#(\d+)$/.exec(s.pr_ref ?? '');
  const rt = deps.store.readRuntimeContext(id, s.revision);
  if (pr === null || rt === null) return 'not_waiting';
  if (!(await deps.enabled())) return 'off';

  const target: MergeTarget = {
    repo: rt.target.repo,
    pr_number: Number(pr[1]),
    target: s.task.base_branch,
    head_sha: s.head_sha as string,
  };
  const port = deps.github();
  const ready = await readMergeReadiness(port, target);
  if (!ready.ready) {
    deps.log?.(`yolo ${taskId}: not merged: ${ready.reason}`);
    return 'not_ready';
  }

  const approved = submit(deps.store, {
    task_id: taskId,
    dedup_key: `yolo:${taskId}:${target.head_sha}:${s.version}`,
    trigger: { kind: 'yolo_merge_approve', head_sha: target.head_sha },
    now: deps.clock.now(),
    ids: Array.from({ length: MAX_ENVELOPE_IDS }, () => deps.newId()),
    expected_version: s.version,
  });
  // The reads above took time: a cancel, a new head or yolo turned off since then stops the merge here.
  const now = deps.store.readTask(id);
  if (
    !approved.ok ||
    !mergeWait(now) ||
    now.head_sha !== target.head_sha ||
    !yoloApproved(now, target.head_sha)
  )
    return 'not_approved';
  if (!(await deps.enabled())) return 'off';

  const sent = await sendMerge(
    port,
    target,
    rt.merge_method ?? DEFAULT_MERGE_METHOD,
  );
  deps.log?.(
    `yolo ${taskId}: merge of ${target.head_sha}: ${sent.kind}${sent.kind === 'merged' ? '' : `: ${sent.detail}`}`,
  );
  return sent.kind;
}
