/**
 * PR maintenance and yolo merges (SPEC §14.2). Base integration is independent of yolo.
 * Only the final merge requires the owner to enable yolo. After a PR read, a task waiting for merge
 * is merged when the owner's user config has `yolo: true` right now, its head contains the latest target tip,
 * and the checks GitHub reports meet the union of policy and binding GitHub names, including pinned
 * app identities. An empty required list never permits merge; it does not change the engine's CI wait.
 * Protection is optional; without enforcement, a target/check change before merge remains a race.
 * The engine decides eligibility and records the `policy:yolo` approval with the content digest before
 * anything is sent. The merge names the checked head and that content's commit message, so a resend
 * after a lost answer is the same request, and
 * the next observation completes the task from its proof. No agent takes part. Anything else leaves the wait as
 * it is, so the user can still merge on GitHub.
 */
import { readMergeReadiness, sendMerge, type MergeTarget } from '../adapters/github/merge.ts';
import { readHeadChecks } from '../adapters/github/checks.ts';
import { readRequirements } from '../adapters/github/observe.ts';
import type { Clock, GitHubPort } from '../adapters/ports.ts';
import type { PublishContent } from '../adapters/context.ts';
import { submit } from '../application/triage.ts';
import { DEFAULT_MERGE_METHOD } from '../domain/merge-method.ts';
import type { FrozenPolicy } from '../domain/policy.ts';
import type { TaskState } from '../domain/state.ts';
import { checkPasser, MAX_ENVELOPE_IDS } from '../domain/trigger.ts';
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
  | 'updating_base'
  | 'not_approved'
  | 'merged'
  | 'refused'
  | 'unknown';

const NO_REQUIRED_CHECKS = 'no required CI checks; declare ci.required_checks in cusr.yaml';
// One warning per task in this daemon/store lifetime, rather than one on every observation poll.
const emptyCheckWarnings = new WeakMap<Store, Set<string>>();

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
  skippedBefore: number | null,
): Promise<string | null> {
  const required = await readRequirements(port, t.repo, t.target, now);
  const verdict = evaluateRequired(required, policy.ci.required_checks);
  if (verdict.kind !== 'covered') return `required checks ${verdict.kind}`;
  if (policy.ci.required_checks.length === 0 && verdict.github.length === 0)
    return NO_REQUIRED_CHECKS;
  const checks = await readHeadChecks(port, t.repo, t.head_sha, skippedBefore);
  if (!checks.ok) return `checks unreadable: ${checks.error.detail}`;
  const passed = checkPasser(checks.value.checks);
  for (const identity of verdict.app_pinned ?? []) {
    if (
      !checks.value.checks.some(
        (check) =>
          check.name === identity.name &&
          check.source === 'check_run' &&
          check.app_id === identity.app &&
          passed(check.state),
      )
    )
      return `required check ${identity.name} from app ${identity.app} has not passed`;
  }
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

export async function advanceTaskPr(deps: YoloDeps, taskId: string): Promise<YoloOutcome> {
  const id = taskId as Uuid;
  const s = deps.store.readTask(id);
  if (!mergeWait(s) || s.policy_ref === null) return 'not_waiting';
  const pr = /#(\d+)$/.exec(s.pr_ref ?? '');
  const rt = deps.store.readRuntimeContext(id, s.revision);
  const policy = deps.store.readPolicy(id, s.policy_ref.revision, s.policy_ref.version);
  if (pr === null || rt === null || policy === null) return 'not_waiting';
  const target: MergeTarget = {
    repo: rt.target.repo,
    pr_number: Number(pr[1]),
    target: s.task.base_branch,
    head_sha: s.head_sha as string,
  };
  const port = deps.github();
  const notReady = (reason: string): YoloOutcome => {
    if (reason === NO_REQUIRED_CHECKS) {
      let warned = emptyCheckWarnings.get(deps.store);
      if (warned === undefined) {
        warned = new Set<string>();
        emptyCheckWarnings.set(deps.store, warned);
      }
      if (warned.has(taskId)) return 'not_ready';
      warned.add(taskId);
    }
    deps.log?.(`yolo ${taskId}: not merged: ${reason}`);
    return 'not_ready';
  };
  const ready = await readMergeReadiness(port, target);
  if (!ready.ready && ready.base_sha === undefined)
    return (await deps.enabled()) ? notReady(ready.reason) : 'off';
  if (!ready.ready && ready.base_sha !== undefined) {
    const updated = submit(deps.store, {
      task_id: taskId,
      dedup_key: `base-update:${taskId}:${target.head_sha}:${ready.base_sha}:${s.version}`,
      trigger: {
        kind: 'update_base',
        head_sha: target.head_sha,
        base_sha: ready.base_sha,
      },
      now: deps.clock.now(),
      ids: Array.from({ length: MAX_ENVELOPE_IDS }, () => deps.newId()),
      expected_version: s.version,
    });
    if (!updated.ok) return 'not_approved';
    const after = deps.store.readTask(id);
    const waiting = after?.wait;
    const queued =
      waiting?.detail.code === 'execution_slot' &&
      'base_update' in waiting.resume &&
      waiting.resume.base_update?.head_sha === target.head_sha &&
      waiting.resume.base_update.base_sha === ready.base_sha;
    const pending = Object.values(after?.effects ?? {}).some(
      (e) =>
        e.kind === 'run_gates' &&
        (e.status === 'pending' || e.status === 'started') &&
        e.base_update?.head_sha === target.head_sha &&
        e.base_update.base_sha === ready.base_sha,
    );
    if (!queued && !pending) return 'not_approved';
    deps.log?.(
      `task ${taskId}: updating base to ${ready.base_sha}; gates, conflict scope and CI must pass on the new head`,
    );
    return 'updating_base';
  }

  if (!(await deps.enabled())) return 'off';
  // `clean` accepts a skipped or neutral check and the engine holds the CI seen earlier: read what is true now.
  const problem = await currentChecksProblem(
    port,
    policy,
    target,
    deps.clock.now(),
    s.run.pr_ready_at ?? null,
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
  if (!mergeWait(now) || now.head_sha !== target.head_sha) return 'not_approved';
  const intent = yoloApproval(now, target.head_sha);
  const content = now.run.content;
  if (intent === undefined || content === null || content.digest !== intent.content_digest)
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
