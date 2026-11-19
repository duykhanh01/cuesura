/**
 * The owner's explicit Merge PR (`task_merge`, TUI Actions menu). The owner agrees to one PR at one head
 * on one target with one method and commit message; the daemon then repeats every check yolo makes
 * (readiness, the checks GitHub reports now, the pull confirmation) with yolo off or on, records the
 * `user:merge` approval, and sends the merge naming that head. Nothing here ends the task: DONE comes
 * only from the next observation of the PR, so a refused or lost merge never reads as done.
 *
 * Only the owner holds `admin`; the deputy's command kinds do not include this one. A unit of a goal
 * targeting its goal branch is merged by the goal's own machinery (R-23), never from here.
 */
import { readMergeReadiness, confirmPull, sendMerge } from '../adapters/github/merge.ts';
import { pullFacts } from '../adapters/github/merge-proof.ts';
import type { MergeTarget } from '../adapters/github/merge.ts';
import type { GitHubPort } from '../adapters/ports.ts';
import type { PublishContent } from '../adapters/context.ts';
import { acceptError, taskInProject } from '../application/answer.ts';
import { authzContext, type Caller } from '../application/authz.ts';
import type { Admitted, CommandInput } from '../application/commands.ts';
import type { AppError } from '../application/queries.ts';
import { taskView } from '../application/queries.ts';
import { submit } from '../application/triage.ts';
import { DEFAULT_MERGE_METHOD, type MergeMethod } from '../domain/merge-method.ts';
import type { TaskState } from '../domain/state.ts';
import { MAX_ENVELOPE_IDS } from '../domain/trigger.ts';
import { MANUAL_APPROVER, targetsGoalBranch, yoloApproval } from '../engine/external-completion.ts';
import { unlistedWaivers, waivedChecks } from '../engine/waivers.ts';
import type { Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import { currentChecksProblem } from './yolo.ts';

export type ManualMergeDeps = {
  readonly store: Store;
  readonly now: () => number;
  readonly github: () => GitHubPort;
  /** The worker's publish content by reference and digest; null when it cannot be read back intact. */
  readonly content: (ref: string, digest: string) => PublishContent | null;
};

type MergePayload = {
  readonly pr_ref: string;
  readonly target: string;
  readonly head_sha: string;
  readonly merge_method: MergeMethod;
  readonly content_digest: string;
};

const refused = (reason: string, details: Record<string, unknown> = {}): AppError => ({
  code: 'conflict',
  // The detail is what the owner reads in the TUI; the reason is what a program matches.
  message: typeof details['detail'] === 'string' ? `${reason}: ${details['detail']}` : reason,
  details: { reason, ...details },
});

function waitingForMerge(s: TaskState): boolean {
  return (
    s.runtime_ref !== null &&
    s.wait?.detail.code === 'merge' &&
    s.cancellation === null &&
    s.completion === null &&
    (s.pause ?? null) === null &&
    s.head_sha !== null &&
    s.policy_ref !== null
  );
}

/** What the owner saw in the dialog against what the task is now; the first difference, or null. */
function changed(
  s: TaskState,
  p: MergePayload,
  method: MergeMethod,
): { field: string; shown: string; now: string | null } | null {
  const now: [string, string, string | null][] = [
    ['pr_ref', p.pr_ref, s.pr_ref],
    ['target', p.target, s.task.base_branch],
    ['head_sha', p.head_sha, s.head_sha],
    ['merge_method', p.merge_method, method],
    ['content_digest', p.content_digest, s.run.content?.digest ?? null],
  ];
  for (const [field, shown, current] of now)
    if (shown !== current) return { field, shown, now: current };
  return null;
}

/** Why the engine left a trigger unrecorded, from its own `SignalIgnored` event. */
function ignoredReason(accepted: {
  readonly decision: { readonly kind: string; readonly events?: unknown };
}): string | null {
  if (accepted.decision.kind !== 'accepted' || !Array.isArray(accepted.decision.events))
    return null;
  const e = (accepted.decision.events as { type: string; payload: { reason?: unknown } }[]).find(
    (x) => x.type === 'SignalIgnored',
  );
  return typeof e?.payload.reason === 'string' ? e.payload.reason : null;
}

export async function taskMerge(
  deps: ManualMergeDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const found = taskInProject(deps.store, input);
  if (!found.ok) return found;
  const id = found.value.id as Uuid;
  const s = found.value;
  const p = input.payload as MergePayload;
  if (s.version !== input.expected_version)
    return err(refused('stale_version', { version: s.version }));
  if (!waitingForMerge(s)) return err(refused('not_waiting_for_merge'));
  if (targetsGoalBranch(s)) return err(refused('goal_unit_merge'));
  const pr = /^(.+)#(\d+)$/.exec(s.pr_ref ?? '');
  const rt = deps.store.readRuntimeContext(id, s.revision);
  const policy = deps.store.readPolicy(
    id,
    (s.policy_ref as NonNullable<typeof s.policy_ref>).revision,
    (s.policy_ref as NonNullable<typeof s.policy_ref>).version,
  );
  if (pr === null || rt === null || policy === null) return err(refused('not_waiting_for_merge'));
  const method = rt.merge_method ?? DEFAULT_MERGE_METHOD;
  const diff = changed(s, p, method);
  if (diff !== null) return err(refused('merge_changed', diff));
  const target: MergeTarget = {
    repo: rt.target.repo,
    pr_number: Number(pr[2]),
    target: s.task.base_branch,
    head_sha: p.head_sha,
  };
  if (unlistedWaivers(s).length > 0) return err(refused('waivers_not_listed'));

  const port = deps.github();
  const first = await readMergeReadiness(port, target);
  if (!first.ready) {
    // Not open: whether it was merged or closed is read from GitHub, never inferred from an earlier
    // approval, which says nothing about a merge having been sent.
    if (first.reason === 'pull is not open') return closedPull(deps, port, target, id);
    return err(
      refused('not_ready', {
        detail: first.reason,
        ...(first.base_sha === undefined ? {} : { behind_target: first.base_sha }),
      }),
    );
  }
  const problem = await currentChecksProblem(
    port,
    policy,
    target,
    deps.now(),
    (runs) => waivedChecks(s, policy, target.head_sha, runs),
    target.target,
  );
  if (typeof problem === 'object' && problem !== null)
    return err(refused('rate_limited', { retry_after_ms: problem.rate_limited }));
  if (problem !== null) return err(refused('checks_not_ready', { detail: problem }));
  // The checks took time: the PR and the target's tip are read once more, last, before the approval.
  const last = await readMergeReadiness(port, target);
  if (!last.ready) return err(refused('not_ready', { detail: last.reason }));
  const pull = await confirmPull(port, target);
  if (!pull.ok) return err(refused('not_ready', { detail: pull.reason }));
  // The head was compared with `last.tip`: a target tip that is missing now, or moved since, was not.
  if (last.tip === undefined || pull.tip === null || pull.tip !== last.tip)
    return err(
      refused('not_ready', {
        detail:
          pull.tip === null ? 'target tip unreadable' : 'target moved after the head was compared',
      }),
    );

  const approved = submit(deps.store, {
    task_id: s.id,
    dedup_key: `cmd:${admitted.record.request_id}:merge-approve`,
    trigger: { kind: 'yolo_merge_approve', head_sha: p.head_sha, by: MANUAL_APPROVER },
    now: deps.now(),
    ids: admitted.record.assigned_ids.slice(0, MAX_ENVELOPE_IDS),
    expected_version: s.version,
    authz: authzContext(caller, deps.now()),
  });
  const after = deps.store.readTask(id);
  if (!approved.ok) return err(acceptError(approved.error, after));
  // From here only synchronous checks run before the send: a cancel or a new head recorded by now stops it.
  const now = deps.store.readTask(id);
  if (now === null || !waitingForMerge(now) || now.head_sha !== p.head_sha)
    return err(refused('not_waiting_for_merge'));
  const intent = yoloApproval(now, p.head_sha);
  if (intent === undefined)
    return err(refused('not_approved', { reason: ignoredReason(approved.value) }));
  if (now.run.content === null || intent.content_digest !== p.content_digest)
    return err(refused('merge_changed', { field: 'content_digest' }));
  const message = deps.content(now.run.content.ref, p.content_digest);
  if (message === null) return err(refused('publish_content_unreadable'));

  const sent = await sendMerge(port, target, method, message.commit_message);
  if (sent.kind === 'refused') return err(refused('github_refused', { detail: sent.detail }));
  return ok(result(deps.store, id, sent.kind === 'merged' ? 'sent' : 'unknown'));
}

/**
 * A PR that is no longer open, as GitHub shows it now. Merged: the daemon's own observation proves it and
 * ends the task, whoever merged and by whichever request, so nothing is sent. Closed without a merge, or
 * unreadable, is refused: it is not a merge and not DONE.
 */
async function closedPull(
  deps: ManualMergeDeps,
  port: GitHubPort,
  t: MergeTarget,
  id: Uuid,
): Promise<Result<unknown, AppError>> {
  const r = await port.request({
    method: 'GET',
    path: `repos/${t.repo}/pulls/${t.pr_number}`,
    query: {},
    body: null,
  });
  if (!r.ok) return err(refused('not_ready', { detail: `pull unreadable: ${r.error.detail}` }));
  const facts = pullFacts(r.value.body);
  if (facts.merged === true) return ok(result(deps.store, id, 'already_merged'));
  if (facts.state !== 'closed' || facts.merged !== false)
    return err(refused('not_ready', { detail: 'pull changed or its state is unreadable' }));
  return err(
    refused('pr_closed_unmerged', { detail: 'the pull request was closed without a merge' }),
  );
}

/**
 * `sent`: GitHub accepted the merge. `unknown`: the answer was lost, so the merge may have happened; asking
 * again reads the PR first and sends the same head-bound merge only while it is still open.
 * `already_merged`: GitHub shows the PR merged and nothing was sent. None of them is DONE: the task ends
 * only when the observation of the PR proves the merge.
 */
function result(
  store: Store,
  id: Uuid,
  outcome: 'sent' | 'unknown' | 'already_merged',
): Record<string, unknown> {
  const s = store.readTask(id) as TaskState;
  return { outcome, done: s.status === 'DONE', task: taskView(s) };
}
