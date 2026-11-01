/**
 * Yolo merges (SPEC §14.2). After a read of the task's PR, a task waiting for its merge is merged by this
 * code when the owner's user config has `yolo: true` right now and GitHub would enforce what the merge
 * relies on, and the checks it reports now meet the frozen policy. The engine decides eligibility and
 * records the `policy:yolo` approval with the content digest before anything is sent; the merge names the
 * checked head and that content's commit message, so a resend after a lost answer is the same request, and
 * the next observation completes the task from its proof. No agent takes part. Anything else leaves the wait as
 * it is, so the user can still merge on GitHub.
 */
import {
  readMergeReadiness,
  sendMerge,
  type MergeTarget,
} from '../adapters/github/merge.ts';
import { readHeadChecks } from '../adapters/github/checks.ts';
import { readRequirements } from '../adapters/github/observe.ts';
import type { Clock, GitHubPort } from '../adapters/ports.ts';
import type { PublishContent } from '../adapters/context.ts';
import { submit } from '../application/triage.ts';
import { DEFAULT_MERGE_METHOD } from '../domain/merge-method.ts';
import type { FrozenPolicy } from '../domain/policy.ts';
import type { TaskState } from '../domain/state.ts';
import { MAX_ENVELOPE_IDS } from '../domain/trigger.ts';
import { yoloApproval } from '../engine/external-completion.ts';
import { ciVerdict } from '../engine/merge-guard.ts';
import { evaluateRequired } from '../engine/required-checks.ts';
import type { Uuid } from '../shared/brand.ts';
import type { Store } from '../store/index.ts';

export type YoloDeps = {
  readonly store: Store;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly github: () => GitHubPort;
  /** The owner's current setting, read again for each merge; a config that cannot be read means off. */
  readonly enabled: () => Promise<boolean>;
  /** The worker's publish content by reference and digest; null when it cannot be read back intact. */
  readonly content: (ref: string, digest: string) => PublishContent | null;
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

/** Whether the checks GitHub reports for `head` now meet the frozen policy; a reason when they do not. */
async function currentChecksProblem(
  port: GitHubPort,
  policy: FrozenPolicy,
  t: MergeTarget,
  now: number,
): Promise<string | null> {
  const required = await readRequirements(port, t.repo, t.target, now);
  const verdict = evaluateRequired(required, policy.ci.required_checks);
  if (verdict.kind !== 'covered') return `required checks ${verdict.kind}`;
  const checks = await readHeadChecks(port, t.repo, t.head_sha);
  if (!checks.ok) return `checks unreadable: ${checks.error.detail}`;
  const ci = ciVerdict(
    policy,
    {
      names: [...verdict.github],
      source: 'branch_protection',
      complete: checks.value.complete && checks.value.collisions.length === 0,
    },
    checks.value.checks.map((c) => ({ name: c.name, state: c.state })),
  );
  return ci.kind === 'pass' ? null : `checks ${ci.kind}`;
}

export async function yoloMerge(
  deps: YoloDeps,
  taskId: string,
): Promise<YoloOutcome> {
  const id = taskId as Uuid;
  const s = deps.store.readTask(id);
  if (!mergeWait(s) || s.policy_ref === null) return 'not_waiting';
  const pr = /#(\d+)$/.exec(s.pr_ref ?? '');
  const rt = deps.store.readRuntimeContext(id, s.revision);
  const policy = deps.store.readPolicy(
    id,
    s.policy_ref.revision,
    s.policy_ref.version,
  );
  if (pr === null || rt === null || policy === null) return 'not_waiting';
  if (!(await deps.enabled())) return 'off';

  const target: MergeTarget = {
    repo: rt.target.repo,
    pr_number: Number(pr[1]),
    target: s.task.base_branch,
    head_sha: s.head_sha as string,
  };
  const port = deps.github();
  const notReady = (reason: string): YoloOutcome => {
    deps.log?.(`yolo ${taskId}: not merged: ${reason}`);
    return 'not_ready';
  };
  const ready = await readMergeReadiness(port, target);
  if (!ready.ready) return notReady(ready.reason);
  // `clean` accepts a skipped or neutral check and the engine holds the CI seen earlier: read what is true now.
  const problem = await currentChecksProblem(
    port,
    policy,
    target,
    deps.clock.now(),
  );
  if (problem !== null) return notReady(problem);

  const approved = submit(deps.store, {
    task_id: taskId,
    dedup_key: `yolo:${taskId}:${target.head_sha}:${s.version}`,
    trigger: { kind: 'yolo_merge_approve', head_sha: target.head_sha },
    now: deps.clock.now(),
    ids: Array.from({ length: MAX_ENVELOPE_IDS }, () => deps.newId()),
    expected_version: s.version,
  });
  if (!approved.ok) return 'not_approved';
  if (!(await deps.enabled())) return 'off';

  // Last, with nothing awaited before the send: a cancel or a new head recorded by now stops the merge.
  const now = deps.store.readTask(id);
  if (!mergeWait(now) || now.head_sha !== target.head_sha)
    return 'not_approved';
  const intent = yoloApproval(now, target.head_sha);
  const content = now.run.content;
  if (
    intent === undefined ||
    content === null ||
    content.digest !== intent.content_digest
  )
    return 'not_approved';
  const message = deps.content(content.ref, content.digest);
  if (message === null) return notReady('publish content unreadable');

  const sent = await sendMerge(
    port,
    target,
    rt.merge_method ?? DEFAULT_MERGE_METHOD,
    message.commit_message,
  );
  deps.log?.(
    `yolo ${taskId}: merge of ${target.head_sha}: ${sent.kind}${sent.kind === 'merged' ? '' : `: ${sent.detail}`}`,
  );
  return sent.kind;
}
