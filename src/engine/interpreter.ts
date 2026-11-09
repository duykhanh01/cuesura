import type { EventPayloads } from '../domain/event.ts';
import { minorFixApproved, reviewOf } from './head-evidence.ts';
import type { BaseUpdate, BaseUpdateRun } from '../domain/runtime.ts';
import type { z } from 'zod';
import { assertNever } from '../shared/assert-never.ts';
import { bindingName, type FrozenPolicy } from '../domain/policy.ts';
import {
  isTerminal,
  streakKey,
  type Attempt,
  type AttemptKind,
  type EffectMirror,
  type ResumeAction,
  type ReviewEvidence,
  type TaskState,
} from '../domain/state.ts';
import {
  AgentDataSchema,
  AwaitCiDataSchema,
  CheckpointDataSchema,
  CreatePrDataSchema,
  FailureDataSchema,
  GateDataSchema,
  MarkReadyDataSchema,
  MergeDataSchema,
  PostReviewDataSchema,
  PrepareDataSchema,
  PublishDataSchema,
  RerunDataSchema,
  ReviewDataSchema,
  ReviewRefusedSchema,
  StopDataSchema,
  type FailureData,
  type RequiredCheckVerdict,
  type Trigger,
} from '../domain/trigger.ts';
import {
  branchMatches,
  evalPredicate,
  isAgentStep,
  isMinorStep,
  isSpecialTarget,
  type PredicateFacts,
  type StepDef,
  type StepKind,
} from '../domain/workflow.ts';
import { available, consume, release, reserve, usageOf } from './budget.ts';
import { maybeFinishCancel, requestCancel } from './cancel.ts';
import { classifyFailures } from './classify.ts';
import { externalConfirmation, waitForExternalMerge } from './external-completion.ts';
import { settleExecutionOnClose, waitForSlot } from './runtime.ts';
import { reject, type Ctx } from './context.ts';
import { requestEffect, requestReconcile } from './effects.ts';
import { applyRaise, chooseRung, rungReady } from './escalation.ts';
import {
  clearRetryCounters,
  handleFailure,
  recordCheckFailure,
  isBlocking,
  keptFindings,
  reviewSignature,
  untouchedRepeats,
} from './failure.ts';
import { ciVerdict, heldCi, latestCi, mergeGuard, type GuardFailure } from './merge-guard.ts';
import { answerForFixer, askHuman, AUTO_ACTOR, requestApproval } from './questions.ts';
import { creditableAttempts } from './recheck.ts';
import { settleUnderDrift } from './head-drift.ts';
import { deferForDrift } from './revision.ts';
import { restartCadence, waitMergeEvidence, waitPrClosed } from './observation.ts';
import { isPaused, stoppedByPause, waitPaused } from './pause.ts';
import { afterMessageStop, stoppedByMessage } from './message.ts';
import { reusableReview, reviewInputDigest } from './review-evidence.ts';
import { ensureRunning, mkWait, waitPolicy, waitTask } from './waits.ts';

/**
 * All continuation passes through these guards: terminal state, cancellation, source drift, then
 * deadline.
 */
export function proceed(ctx: Ctx, action: ResumeAction, reason = 'continue'): void {
  const s = ctx.state;
  if (isTerminal(s.status)) return;
  if (s.cancellation !== null) {
    maybeFinishCancel(ctx);
    return;
  }
  if (action.kind === 'none') return;
  // After a merge proof only the drain runs: no step, retry or push resumes (FR-040.02/05).
  if (s.completion !== null) return;
  // An unexpected remote head holds everything until reconciled; a late callback is not an exit (H01).
  if (s.run.head_drift !== null) return;
  // Paused by a person: hold the action itself, so unpausing runs exactly it (issue #142).
  if (isPaused(ctx)) {
    waitPaused(ctx, action);
    return;
  }
  // A PR closed without a merge holds business work until it is reopened; no replacement PR (FR-041.07).
  if (
    s.runtime_ref !== null &&
    s.observation?.last?.status === 'closed' &&
    !s.observation.expired
  ) {
    waitPrClosed(ctx, action);
    return;
  }
  // GitHub reported a merge whose proof was not accepted: nothing resumes until it is reconciled, even
  // after a later read failed or showed something else (FR-040.12).
  if (s.runtime_ref !== null && s.blockers.some((b) => b.code === 'merge_evidence_incomplete')) {
    waitMergeEvidence(ctx, action);
    return;
  }
  if (s.source_drift !== null) {
    deferForDrift(ctx, action);
    return;
  }
  if (pastDeadline(ctx)) {
    waitPolicy(ctx, 'deadline', action, { deadline_at: s.deadline_at });
    return;
  }
  ensureRunning(ctx, reason);
  execute(ctx, action);
}

/**
 * The deadline applies even when its timer has not been processed; no new work may start
 * afterward.
 */
export function pastDeadline(ctx: Ctx): boolean {
  const s = ctx.state;
  return s.deadline_passed || (s.deadline_at !== null && ctx.now >= s.deadline_at);
}

function execute(ctx: Ctx, action: ResumeAction): void {
  switch (action.kind) {
    case 'repair_base': {
      const update = ctx.state.run.base_update;
      if (update === undefined) return;
      const {
        scope: _scope,
        certificate: _certificate,
        manual_resolution: _manual,
        fixer_attempt_id: _fixer,
        ...previous
      } = update;
      if (action.mode === 'retry_fixer') {
        if (update.conflict === undefined) return waitBaseRepair(ctx, 'no conflict fixer to retry');
        ctx.emit('BaseUpdateRecorded', { update: previous });
        const fix = conflictFixStep(ctx, update);
        if (fix === undefined) return waitBaseRepair(ctx, 'missing conflict fixer step');
        enterStep(ctx, fix, { step: update.gate_step, outcome: 'fail' }, 'retry');
      } else {
        ctx.emit('BaseUpdateRecorded', {
          update: {
            ...previous,
            ...(update.fixer_attempt_id === undefined
              ? {}
              : { fixer_attempt_id: update.fixer_attempt_id }),
            manual_resolution: { by: ctx.actor, at: ctx.now },
          },
        });
        enterStep(
          ctx,
          update.gate_step,
          {
            step: ctx.state.current_step ?? update.gate_step,
            outcome: 'manual_repair',
          },
          'initial',
          update.conflict === undefined
            ? { head_sha: update.head_sha, base_sha: update.base_sha }
            : undefined,
        );
      }
      return;
    }
    case 'start_attempt':
      startAttempt(ctx, action.step, action.attempt_kind);
      return;
    case 'enter_step':
      enterStep(ctx, action.step, null, 'initial', action.base_update);
      return;
    case 'run_step':
      runStep(ctx, action.step, 'initial', action.base_update);
      return;
    case 'merge_check':
      runStep(ctx, action.step);
      return;
    case 'route':
      route(ctx, action.step, action.outcome);
      return;
    case 'retry_effect':
      enterStep(
        ctx,
        action.step,
        { step: action.step, outcome: 'retry' },
        'retry',
        action.base_update,
      );
      return;
    case 'poll_ci':
      requestAwaitCi(ctx, action.step);
      return;
    case 'triage':
      enterStep(ctx, ctx.frozen.workflow.start, null);
      return;
    case 'none':
      return;
    default:
      assertNever(action);
  }
}

function stepDef(ctx: Ctx, step: string): StepDef {
  const def = ctx.frozen.workflow.steps[step];
  if (def === undefined) throw new Error(`Workflow has no step '${step}'`);
  return def;
}

function facts(ctx: Ctx, step: string): PredicateFacts {
  const t = ctx.state.task;
  return {
    labels: t.labels,
    size: t.size,
    task_type: t.type,
    attempt: (ctx.state.step_visits[step] ?? 0) + 1,
    target_branch: t.base_branch,
    // The fixer runs once per approval; the gates after it run while that fix is still open.
    minor_findings:
      minorStage(ctx.state) ===
      (ctx.frozen.workflow.steps[step]?.kind === 'agent' ? 'due' : 'open'),
  };
}

/** The latest review of this revision when it approved the change. */
function latestApproval(s: TaskState): ReviewEvidence | undefined {
  const last = s.run.reviews.filter((r) => r.valid && r.revision === s.revision).at(-1);
  return last?.verdict === 'approve' ? last : undefined;
}

/**
 * The minor findings the latest review of this revision left when it approved the change; empty when
 * it did not approve, or found nothing below the blocking levels to fix (`info` needs no change).
 */
export function minorFindings(s: TaskState): ReviewEvidence['findings'] {
  return latestApproval(s)?.findings.filter((f) => f.severity === 'minor') ?? [];
}

/**
 * Where the minor fix of the latest approval stands: `due` before its one fixer run, `open` from that
 * run until it is carried or dropped, null when there is nothing (more) to fix.
 */
function minorStage(s: TaskState): 'due' | 'open' | null {
  const approval = latestApproval(s);
  if (approval === undefined || minorFindings(s).length === 0) return null;
  if (s.run.minor_fix?.review_attempt_id === approval.attempt_id) return null;
  return (s.run.minor_started ?? []).includes(approval.attempt_id) ? 'open' : 'due';
}

const SKIP_OUTCOME: Partial<Record<StepKind, string>> = {
  agent: 'done',
  review: 'approve',
  gate: 'pass',
  action: 'ok',
  prepare: 'ok',
  triage: 'ok',
};

function skip(ctx: Ctx, step: string, reason: StepSkippedReason): void {
  const def = stepDef(ctx, step);
  const outcome = SKIP_OUTCOME[def.kind] ?? 'ok';
  ctx.emit('StepSkipped', { step, kind: def.kind, reason, outcome });
  // A minor fixer entered again while its fix is open (its run was stopped, say) drops that fix: the
  // worktree may hold a change no gate saw.
  if (isMinorStep(def) && def.kind === 'agent' && minorStage(ctx.state) === 'open')
    return dropMinorFix(ctx, step);
  // A skipped minor step skips the whole minor fix: its success would lead on into the fix.
  if (isMinorStep(def) && def.on_exhausted !== undefined)
    return goTarget(ctx, step, def.on_exhausted, outcome);
  route(ctx, step, outcome);
}

export function enterStep(
  ctx: Ctx,
  step: string,
  from: { step: string; outcome: string } | null,
  attemptKind: AttemptKind = 'initial',
  baseUpdate?: BaseUpdate,
): void {
  const def = stepDef(ctx, step);
  if (def.when !== undefined && !evalPredicate(def.when, facts(ctx, step)))
    return skip(ctx, step, 'when');
  if (def.skip_when !== undefined && evalPredicate(def.skip_when, facts(ctx, step)))
    return skip(ctx, step, 'skip_when');
  // The approval carries a minor fix to its checkpoint: no reviewer runs, so no review visit counts.
  const cp = ctx.state.run.checkpoint;
  if (def.kind === 'review' && cp !== null && minorFixApproved(ctx.state, cp.sha))
    return skip(ctx, step, 'approval_carried');
  const visits = ctx.state.step_visits[step] ?? 0;
  let limit = visitLimit(ctx, step);
  if (limit !== null && visits >= limit) {
    // Visits lost to the harness, not the work (infra, rate limit, login) come back on their own, as
    // `recheck visits` would give them (#247).
    const credited = creditableAttempts(ctx.state, step);
    if (credited.length > 0) {
      ctx.emit('VisitsCredited', {
        step,
        attempt_ids: credited.map((a) => a.id),
        by: ctx.actor,
        at: ctx.now,
      });
      limit = visitLimit(ctx, step);
    }
  }
  if (limit !== null && visits >= limit) {
    const target = def.on_exhausted ?? 'escalate';
    ctx.emit('StepExhausted', { step, visits, target });
    goTarget(ctx, step, target, 'exhausted');
    return;
  }
  ctx.emit('StepEntered', { step, visit: visits + 1, from });
  runStep(ctx, step, attemptKind, baseUpdate);
}

export function visitLimit(ctx: Ctx, step: string): number | null {
  return stepVisitLimit(ctx.frozen, ctx.state, step);
}

/**
 * Whether the last fix step's streak counts review rejections. Gates passing on the fix say nothing
 * about the review that asked for it, so they leave that streak to the next review: a rejection on the
 * same files then counts as a second one in a row, and only an approval clears it.
 */
function reviewStreak(s: TaskState): boolean {
  const step = s.last_fix_step;
  if (step === null) return false;
  const streak = s.failure_streaks[streakKey(step, s.rungs.by_step[step] ?? 0)];
  return streak?.signature?.startsWith('review:') === true;
}

/** `max_visits` plus the visits an amendment or a granted credit added; null when the step has no limit. */
export function stepVisitLimit(
  frozen: Pick<FrozenPolicy, 'workflow' | 'limits'>,
  state: TaskState,
  step: string,
): number | null {
  const max = frozen.workflow.steps[step]?.max_visits;
  return max === undefined
    ? null
    : max + (frozen.limits.extra_visits[step] ?? 0) + (state.visit_credits?.[step]?.visits ?? 0);
}

export function route(ctx: Ctx, step: string, outcome: string, body?: string): void {
  const target = stepDef(ctx, step).next[outcome];
  if (target === undefined) throw new Error(`Step '${step}' has no transition for '${outcome}'`);
  goTarget(ctx, step, target, outcome, body);
}

function goTarget(ctx: Ctx, from: string, target: string, outcome: string, body?: string): void {
  if (!isSpecialTarget(target)) {
    if (updateBaseBeforeReviewFix(ctx, target, { step: from, outcome })) return;
    enterStep(ctx, target, { step: from, outcome });
    return;
  }
  const def = stepDef(ctx, from);
  if (target === 'escalate' && outcome === 'exhausted') {
    // An answer cannot reopen an exhausted step; only an amendment granting more visits can.
    waitTask(
      ctx,
      mkWait('human_input', 'loop_exhausted', {
        resume: isAgentStep(def)
          ? { kind: 'start_attempt', step: from, attempt_kind: 'initial' }
          : { kind: 'enter_step', step: from },
        resume_when: [`amend(limits.extra_visits.${from})`],
        detail: {
          step: from,
          outcome,
          visits: ctx.state.step_visits[from] ?? 0,
        },
      }),
    );
    return;
  }
  const again: ResumeAction = isAgentStep(def)
    ? { kind: 'start_attempt', step: from, attempt_kind: 'initial' }
    : { kind: 'run_step', step: from };
  const attempt = ctx.state.current_attempt[from] ?? null;
  switch (target) {
    case 'ask':
      askHuman(ctx, 'agent_question', {
        step: from,
        attempt_id: attempt,
        body: body ?? `Step '${from}' requires additional information`,
        resume: again,
      });
      return;
    case 'escalate':
      askHuman(ctx, 'loop_exhausted', {
        step: from,
        attempt_id: attempt,
        body: body ?? `Step '${from}' returned '${outcome}'; a human decision is required`,
        resume: again,
        detail: { step: from, outcome },
      });
      return;
    case 'retry':
      // Automatic retry counts as another visit and remains subject to max_visits.
      enterStep(ctx, from, { step: from, outcome }, 'retry');
      return;
    case 'fail':
      failTask(ctx, `${from}:${outcome}`);
      return;
    case 'cancel':
      requestCancel(ctx, `${from}:${outcome}`);
      return;
    default:
      assertNever(target);
  }
}

function visitOf(ctx: Ctx, step: string): number {
  return ctx.state.step_visits[step] ?? 0;
}

export function runStep(
  ctx: Ctx,
  step: string,
  attemptKind: AttemptKind = 'initial',
  baseUpdate?: BaseUpdate,
): void {
  const def = stepDef(ctx, step);
  const s = ctx.state;
  const p = ctx.frozen;
  const visit = visitOf(ctx, step);
  // A step entered while paused waits before doing anything; its visit is already counted, so the
  // unpause runs it without counting another (issue #142).
  if (isPaused(ctx)) {
    waitPaused(
      ctx,
      def.kind === 'agent' || (def.kind === 'review' && attemptKind !== 'initial')
        ? { kind: 'start_attempt', step, attempt_kind: attemptKind }
        : {
            kind: 'run_step',
            step,
            ...(baseUpdate === undefined ? {} : { base_update: baseUpdate }),
          },
    );
    return;
  }
  switch (def.kind) {
    case 'triage': {
      const need = agentRunsAhead(ctx, step);
      if (available(s.budget) < need) {
        waitPolicy(
          ctx,
          'agent_runs_insufficient',
          { kind: 'route', step, outcome: 'ok' },
          { needed: need, available: available(s.budget) },
        );
        return;
      }
      route(ctx, step, 'ok');
      return;
    }
    case 'prepare':
      if (s.base_sha !== null) return skip(ctx, step, 'prepared');
      if (waitForSlot(ctx, { kind: 'run_step', step })) return;
      requestEffect(ctx, {
        kind: 'prepare',
        logical_id: `${step}#${visit}`,
        step,
        request: { base_branch: s.task.base_branch, base_sha: p.base_sha },
      });
      return;
    case 'agent':
      startAttempt(ctx, step, attemptKind);
      return;
    case 'review':
      if (
        s.run.base_update?.certificate?.head_sha === s.run.checkpoint?.sha &&
        s.run.checkpoint !== null &&
        reviewOf(s, s.run.checkpoint.sha) === 'not_required'
      ) {
        route(ctx, step, 'approve');
        return;
      }
      if (reuseReview(ctx, step)) return;
      startAttempt(ctx, step, attemptKind);
      return;
    case 'gate': {
      const gates = p.gates.by_step[step];
      const run = gates?.run ?? [];
      if (run.length === 0) return skip(ctx, step, 'no_gates');
      if (
        waitForSlot(ctx, {
          kind: 'run_step',
          step,
          ...(baseUpdate === undefined ? {} : { base_update: baseUpdate }),
        })
      )
        return;
      requestEffect(ctx, {
        kind: 'run_gates',
        logical_id: `${step}#${visit}`,
        step,
        request: {
          gates: run.map((g) => ({ gate: g, cmd: p.gates.commands[g] ?? '' })),
          required: gates?.required ?? [],
          ...(baseUpdate === undefined ? {} : { base_update: baseUpdate }),
        },
      });
      return;
    }
    case 'action':
      runAction(ctx, step, def, visit);
      return;
    case 'wait':
      requestAwaitCi(ctx, step);
      return;
    case 'classify': {
      const ci = s.head_sha === null ? undefined : latestCi(s, s.head_sha);
      const c = classifyFailures(p.ci.rules, ci?.checks ?? []);
      if (c.kind === 'class') {
        if (c.class === 'code') {
          const failing = c.by_check
            .filter((x) => x.class === 'code')
            .map((x) => x.check)
            .sort();
          recordCheckFailure(ctx, `ci:${failing.join(',')}`);
        }
        route(ctx, step, c.class);
        return;
      }
      askHuman(ctx, 'ci_unclassified', {
        step,
        attempt_id: null,
        body: 'The CI result has no failed check to classify',

        resume: { kind: 'route', step, outcome: 'code' },
        detail: { checks: c.checks },
      });
      return;
    }
    case 'approval': {
      // Runtime (002): the user merges on GitHub; no approval request, auto approval or merge effect.
      if (externalConfirmation(ctx)) return waitForExternalMerge(ctx, step);
      // Merging into a protected branch requires human approval even when auto_when matches.
      const protectedTarget = p.protected_branches.some((b) =>
        branchMatches(b, s.task.base_branch),
      );
      if (
        !protectedTarget &&
        def.auto_when !== undefined &&
        evalPredicate(def.auto_when, facts(ctx, step))
      ) {
        const id = ctx.nextId();
        ctx.emit('ApprovalRequested', {
          approval_id: id,
          kind: 'merge',
          step,
          rung: null,
          head_sha: s.head_sha,
          policy_hash: p.policy_hash,
        });
        ctx.emit('ApprovalGranted', {
          approval_id: id,
          by: 'policy:auto_when',
          head_sha: s.head_sha,
        });
        route(ctx, step, 'approved');
        return;
      }
      requestApproval(ctx, {
        kind: 'merge',
        step,
        rung: null,
        head_sha: s.head_sha,
        resume: { kind: 'route', step, outcome: 'approved' },
      });
      return;
    }
    case 'complete':
      finish(ctx, 'workflow_complete');
      return;
    default:
      assertNever(def.kind);
  }
}

function runAction(ctx: Ctx, step: string, def: StepDef, visit: number): void {
  const s = ctx.state;
  switch (def.action) {
    case 'git.publish':
      if (waitForSlot(ctx, { kind: 'run_step', step })) return;
      requestEffect(ctx, {
        kind: 'publish',
        logical_id: `${step}#${visit}`,
        step,
        request: publishRequest(ctx, visit),
      });
      return;
    case 'github.create_pr':
      if (s.pr_ref !== null) {
        // The same PR keeps its marker; only its title/body follow newer worker content (M05/M07).
        const content = s.run.content?.digest ?? null;
        const pb = s.run.pr_body;
        if (
          s.runtime_ref === null ||
          pb === null ||
          content === null ||
          content === pb.content_digest
        )
          return skip(ctx, step, 'pr_exists');
        requestEffect(ctx, {
          kind: 'create_pr',
          logical_id: `${s.id}#${visit}#describe:${content}`,
          step,
          request: {
            head_sha: s.head_sha,
            content_digest: content,
            update: true,
          },
        });
        return;
      }
      requestEffect(ctx, {
        kind: 'create_pr',
        logical_id: `${s.id}#${visit}`,
        step,
        request: {
          head_sha: s.head_sha,
          content_digest: s.run.content?.digest ?? null,
          ...(draftUntilReady(ctx) ? { draft: true } : {}),
        },
      });
      return;
    case 'github.mark_ready':
      requestEffect(ctx, {
        kind: 'mark_ready',
        logical_id: `${s.id}#${visit}`,
        step,
        request: { pr_ref: s.pr_ref },
      });
      return;
    case 'github.post_review': {
      const reviews = s.run.reviews.filter((r) => r.valid && r.revision === s.revision);
      // The verdict the review step routed on, a reused one included; never merely the latest recorded.
      const at = reviews.findIndex((r) => r.attempt_id === s.run.verdict_attempt_id);
      const review = reviews[at];
      if (review === undefined || s.pr_ref === null) return skip(ctx, step, 'no_review');
      if (s.run.posted_reviews?.includes(review.attempt_id) === true)
        return skip(ctx, step, 'review_posted');
      requestEffect(ctx, {
        kind: 'post_review',
        logical_id: `${review.attempt_id}#${visit}`,
        step,
        request: {
          pr_ref: s.pr_ref,
          attempt_id: review.attempt_id,
          round: at + 1,
        },
      });
      return;
    }
    case 'github.rerun_failed': {
      const ci = s.head_sha === null ? undefined : latestCi(s, s.head_sha);
      const failed = (ci?.checks ?? []).filter((c) => c.state === 'failure').map((c) => c.name);
      requestEffect(ctx, {
        kind: 'rerun_ci',
        logical_id: `${s.head_sha ?? 'none'}#${visit}`,
        step,
        request: { head_sha: s.head_sha, checks: failed },
      });
      return;
    }
    case 'github.merge': {
      if (externalConfirmation(ctx)) return waitForExternalMerge(ctx, step);
      const g = mergeGuard(s, ctx.frozen);
      if (!g.ok) {
        onGuardFailure(ctx, step, g.code);
        return;
      }
      requestEffect(ctx, {
        kind: 'merge',
        logical_id: `${g.head_sha}#${visit}`,
        step,
        request: { head_sha: g.head_sha, pr_ref: s.pr_ref },
      });
      return;
    }
    case undefined:
      throw new Error(`Action step '${step}' is missing action`);
    default:
      assertNever(def.action);
  }
}

function onGuardFailure(ctx: Ctx, step: string, code: GuardFailure): void {
  const recheck: ResumeAction = { kind: 'merge_check', step };
  switch (code) {
    case 'cancelling':
      return;
    case 'checks_incomplete':
    case 'checks_failed': {
      const ci = Object.entries(ctx.frozen.workflow.steps).find(([, d]) => d.kind === 'wait')?.[0];
      if (ci !== undefined && code === 'checks_incomplete') {
        armCiPoll(ctx, ci, { kind: 'poll_ci', step: ci }, { guard: code });
        return;
      }
      askHuman(ctx, 'merge_not_done', {
        step,
        attempt_id: null,
        body: `Merge guard: ${code}`,
        resume: recheck,
        detail: { guard: code },
      });
      return;
    }
    case 'base_outdated':
      askHuman(ctx, 'base_outdated', {
        step,
        attempt_id: null,
        body: `Head ${ctx.state.head_sha ?? '?'} does not contain the base tip; update the branch before merging`,
        resume: recheck,
        detail: { head_sha: ctx.state.head_sha },
      });
      return;
    case 'no_head':
    case 'review_missing':
    case 'approval_missing':
      askHuman(ctx, 'merge_not_done', {
        step,
        attempt_id: null,
        body: `Merge guard: ${code}`,
        resume: recheck,
        detail: { guard: code },
      });
      return;
    default:
      assertNever(code);
  }
}

function finish(ctx: Ctx, reason: string): void {
  closeOut(ctx);
  ctx.emit('TaskCompleted', { reason });
}

/**
 * Ends the task when no automatic way forward is left, instead of a wait only a person could clear
 * (issues #245, #247). The slot is released; an open PR stays as it is, a draft until it was approved.
 */
export function failTask(ctx: Ctx, reason: string): void {
  closeOut(ctx);
  ctx.emit('TaskFailed', { reason });
}

/**
 * Ends a task that ran out of ways forward, but first puts its work where a person sees it: a task
 * of an execution mode without a PR commits what its worktree holds and opens it as a draft PR, then
 * fails with the reason and the outcome (#247). With a PR already open it fails at once, keeping it.
 */
export function failWithDraft(ctx: Ctx, reason: string): void {
  const s = ctx.state;
  if (
    s.run.mode === null ||
    s.runtime_ref === null ||
    s.pr_ref !== null ||
    s.base_sha === null ||
    s.cancellation !== null ||
    s.run.salvage !== undefined
  )
    return failTask(ctx, reason);
  // Past the deadline no business effect is claimed, so the salvage could never run.
  if (pastDeadline(ctx)) return failTask(ctx, `${reason} (no draft PR: deadline passed)`);
  ctx.emit('FailureSalvageStarted', { reason });
  ensureRunning(ctx, 'salvage');
  requestEffect(ctx, {
    kind: 'publish',
    logical_id: `${s.id}#salvage`,
    step: s.current_step ?? ctx.frozen.workflow.start,
    request: { salvage: { reason, title: s.task.title } },
  });
}

/**
 * The deadline passed during a salvage. One not started yet would never be claimed: the task fails
 * now. One already running or being reconciled still ends the task when its outcome is known, so a PR
 * it opened is linked. Returns whether a salvage was under way.
 */
export function salvageAtDeadline(ctx: Ctx): boolean {
  if (ctx.state.run.salvage === undefined || isTerminal(ctx.state.status)) return false;
  const open = Object.values(ctx.state.effects).find(
    (e) => e.kind === 'publish' && ['pending', 'started', 'unknown'].includes(e.status),
  );
  if (open === undefined || open.status === 'pending')
    finishSalvage(ctx, { detail: 'deadline passed' });
  return true;
}

/**
 * Run after every decision: a salvage always ends the task. Once nothing of it is pending, running or
 * being reconciled (a reconcile that did not queue it again), or once it is back in the queue past the
 * deadline where no claim takes it, the task fails now, never left running without a way to end.
 */
export function settleSalvage(ctx: Ctx): void {
  const s = ctx.state;
  if (s.run.salvage === undefined || isTerminal(s.status) || s.cancellation !== null) return;
  const open = Object.values(s.effects).find(
    (e) => e.kind === 'publish' && ['pending', 'started', 'unknown'].includes(e.status),
  );
  if (open === undefined) return finishSalvage(ctx, { detail: 'the salvage did not run' });
  if (open.status === 'pending' && pastDeadline(ctx))
    finishSalvage(ctx, { detail: 'deadline passed' });
}

/** Nothing else publishes once a failing task started its salvage, so its publish is that one. */
function isSalvage(ctx: Ctx, e: EffectMirror): boolean {
  return e.kind === 'publish' && ctx.state.run.salvage !== undefined;
}

function finishSalvage(ctx: Ctx, outcome: { pr_ref?: string; detail?: string }): void {
  if (isTerminal(ctx.state.status)) return;
  const reason = ctx.state.run.salvage?.reason ?? 'failed';
  failTask(
    ctx,
    outcome.pr_ref === undefined
      ? `${reason} (no draft PR: ${outcome.detail ?? 'unknown'})`
      : `${reason} (draft PR ${outcome.pr_ref})`,
  );
}

/**
 * Cancel timers and invalidate all pending effects, including service effects, before ending the
 * task.
 */
export function closeOut(ctx: Ctx): void {
  cancelArmedTimers(ctx);
  settleExecutionOnClose(ctx);
  for (const e of Object.values(ctx.state.effects)) {
    if (e.status !== 'pending') continue;
    ctx.emit('EffectInvalidated', { effect_id: e.id, reason: 'task_ended' });
    release(ctx, e.reservation_id);
  }
}

export function cancelArmedTimers(ctx: Ctx, keepDeadline = false): void {
  for (const t of Object.values(ctx.state.timers)) {
    if (t.status !== 'armed') continue;
    if (keepDeadline && t.kind === 'deadline') continue;
    ctx.emit('TimerCancelled', { timer_id: t.id });
  }
}

function agentRunsAhead(ctx: Ctx, from: string): number {
  const wf = ctx.frozen.workflow;
  const SUCCESS = ['ok', 'done', 'pass', 'approve', 'approved'];
  const seen = new Set<string>();
  let n = 0;
  let cur: string | undefined = from;
  while (cur !== undefined && !seen.has(cur) && !isSpecialTarget(cur)) {
    seen.add(cur);
    const def: StepDef | undefined = wf.steps[cur];
    if (def === undefined) break;
    const f = facts(ctx, cur);
    const skipped =
      (def.when !== undefined && !evalPredicate(def.when, f)) ||
      (def.skip_when !== undefined && evalPredicate(def.skip_when, f));
    if (isAgentStep(def) && !skipped) n++;
    const out: string | undefined = SUCCESS.find((o) => def.next[o] !== undefined);
    cur = out === undefined ? undefined : def.next[out];
  }
  return n;
}

// ---------- Attempt ----------

/**
 * Starts an attempt: picks the rung (escalation and task floor, then `denied`/approval/escalation limit,
 * FR-020, FR-021), checks deadline and budget (available ≥ 1), and reserves budget before requesting
 * `start_agent` (FR-022).
 */
export function startAttempt(ctx: Ctx, step: string, kind: AttemptKind): void {
  const s = ctx.state;
  const sp = ctx.frozen.steps[step];
  if (sp === undefined) throw new Error(`The policy has no binding for step '${step}'`);
  const again: ResumeAction = {
    kind: 'start_attempt',
    step,
    attempt_kind: kind,
  };
  if (waitForSlot(ctx, again)) return;
  /*
   * Each step visit has at most one attempt. Resuming after input, a stop, or failure must re-enter
   * the step so max_visits still applies.
   */

  if (Object.values(s.attempts).filter((a) => a.step === step).length >= visitOf(ctx, step)) {
    enterStep(ctx, step, { step, outcome: 'resume' }, kind);
    return;
  }
  // A minor fix never waits for runs, a rung or a confirmation: it is dropped instead. Past the
  // deadline it is dropped too; the task then waits on the deadline like any other.
  const minor = isMinorStep(stepDef(ctx, step));
  if (minor && (pastDeadline(ctx) || available(s.budget) < 1 || !rungReady(ctx, step, sp)))
    return dropMinorFix(ctx, step);
  const choice = chooseRung(ctx, step, sp, again);
  if (choice === null) return;
  if (pastDeadline(ctx)) return waitPolicy(ctx, 'deadline', again, { deadline_at: s.deadline_at });
  if (available(s.budget) < 1) return waitPolicy(ctx, 'agent_runs_exhausted', again, { step });
  const rungIndex = choice.rung;
  const rung = sp.ladder[rungIndex] as (typeof sp.ladder)[number];
  applyRaise(ctx, step, sp, choice);

  const baseUpdate = s.run.base_update;
  const baseFix =
    baseUpdate?.conflict !== undefined &&
    baseUpdate.certificate === undefined &&
    step === conflictFixStep(ctx, baseUpdate);
  if (baseFix && baseUpdate?.fixer_attempt_id !== undefined)
    return waitBaseRepair(ctx, 'single conflict fixer attempt already used', BASE_REPAIR_WAIT_MS);
  const attemptId = ctx.nextId();
  if (baseFix && baseUpdate !== undefined)
    ctx.emit('BaseUpdateRecorded', {
      update: { ...baseUpdate, fixer_attempt_id: attemptId },
    });
  const effectId = ctx.nextId();
  const reservationId = ctx.nextId();
  const n = Object.values(s.attempts).filter((a) => a.step === step).length + 1;
  const resume: Partial<ReturnType<typeof resumePlan>> =
    s.runtime_ref === null
      ? {}
      : resumePlan(ctx, step, sp.role, bindingName(rung.binding), kind, attemptId);
  ensureRunning(ctx, 'attempt');
  const approval = latestApproval(s);
  if (minor && approval !== undefined)
    ctx.emit('MinorFixStarted', { review_attempt_id: approval.attempt_id });
  reserve(ctx, reservationId, effectId);
  ctx.emit('AttemptRequested', {
    attempt_id: attemptId,
    step,
    n,
    kind,
    rung: rungIndex,
    binding: bindingName(rung.binding),
    effect_id: effectId,
    reservation_id: reservationId,
    ...(resume.resume == null ? {} : { resumed_from: resume.resume.from_attempt_id }),
  });
  const answers = Object.values(ctx.state.questions)
    .filter((q) => q.step === step && q.status === 'answered' && q.revision === s.revision)
    .map((q) => ({ question_id: q.id, answer: q.answer }));
  // Which messages this attempt's context carries (issue #154); the handler reads them from state.
  const messages = (ctx.state.messages ?? [])
    .filter((m) => m.revision === s.revision)
    .map((m) => m.id);
  requestEffect(ctx, {
    kind: 'start_agent',
    logical_id: attemptId,
    step,
    attempt_id: attemptId,
    reservation_id: reservationId,
    effect_id: effectId,
    request: {
      role: sp.role,
      binding: rung.binding,
      rung: rungIndex,
      attempt_kind: kind,
      context_hash: s.context_ref?.hash ?? null,
      answers,
      ...(messages.length === 0 ? {} : { messages }),
      ...resume,
    },
  });
}

/**
 * Which worker session a repair, or the continuation after an answer, should resume (M04, FR-038): the
 * newest finished worker attempt of this revision that reported a session on the same binding. Never
 * across bindings, never for a fresh session the failure handling asked for, and a session is resumed at
 * most once: when an attempt that resumed it ended without a session of its own (lost, failed, dead
 * session), the next one starts a new session. The handler resumes only when the harness proved it can;
 * either way the context carries the full packet with every answer, so a fallback loses only the session.
 */
function resumePlan(
  ctx: Ctx,
  step: string,
  role: string,
  binding: string,
  kind: AttemptKind,
  self: string,
): {
  resume: { session_ref: string; from_attempt_id: string } | null;
  resume_reason: string | null;
} {
  if (role === 'reviewer') return reviewerResume(ctx, step, binding, kind, self);
  if (role !== 'coder' && role !== 'fixer') return { resume: null, resume_reason: null };
  const s = ctx.state;
  const answered = Object.values(s.questions).some(
    (q) =>
      q.step === step &&
      q.status === 'answered' &&
      q.revision === s.revision &&
      q.attempt_id !== null,
  );
  const repair = step !== 'code' || kind !== 'initial' || answered;
  if (!repair) return { resume: null, resume_reason: null };
  if (kind === 'fresh_session') return { resume: null, resume_reason: 'fresh_session_requested' };
  const workers = Object.values(s.attempts).filter(
    (a) =>
      a.id !== self &&
      a.revision === s.revision &&
      a.status === 'finished' &&
      (ctx.frozen.steps[a.step]?.role === 'coder' || ctx.frozen.steps[a.step]?.role === 'fixer'),
  );
  return lastSession(ctx, workers, binding, self);
}

/**
 * A later review round resumes the reviewer's own session of this revision and step, so it keeps the
 * findings it raised and the vendor's prompt cache; the packet is still built fresh. A reviewer session
 * is never handed to a worker and a worker session never to a reviewer. The first round has nothing to
 * resume.
 */
function reviewerResume(
  ctx: Ctx,
  step: string,
  binding: string,
  kind: AttemptKind,
  self: string,
): ReturnType<typeof resumePlan> {
  const s = ctx.state;
  const reviews = Object.values(s.attempts).filter(
    (a) =>
      a.id !== self &&
      a.revision === s.revision &&
      a.step === step &&
      a.status === 'finished' &&
      ctx.frozen.steps[a.step]?.role === 'reviewer',
  );
  if (reviews.length === 0) return { resume: null, resume_reason: null };
  if (kind === 'fresh_session') return { resume: null, resume_reason: 'fresh_session_requested' };
  return lastSession(ctx, reviews, binding, self);
}

/**
 * The newest of `candidates` that reported a session, on the same binding, resumed at most once: when an
 * attempt that resumed it ended without a session of its own, the next one starts a new session.
 */
function lastSession(
  ctx: Ctx,
  candidates: readonly Attempt[],
  binding: string,
  self: string,
): ReturnType<typeof resumePlan> {
  // Attempts keep their request order in state.
  const last = candidates.filter((a) => typeof a.session_ref === 'string').at(-1);
  if (last === undefined) return { resume: null, resume_reason: 'no_session' };
  if (last.binding !== binding) return { resume: null, resume_reason: 'binding_changed' };
  const spent = Object.values(ctx.state.attempts).some(
    (a) =>
      a.id !== self &&
      a.resumed_from === last.id &&
      a.status === 'finished' &&
      typeof a.session_ref !== 'string',
  );
  if (spent) return { resume: null, resume_reason: 'session_unusable' };
  return {
    resume: {
      session_ref: last.session_ref as string,
      from_attempt_id: last.id,
    },
    resume_reason: null,
  };
}

// ---------- CI ----------

function requestAwaitCi(ctx: Ctx, step: string): void {
  const s = ctx.state;
  // A spent window is final for the head: no poll after it, whatever resumed the CI wait (FR-043.08).
  if (s.runtime_ref !== null && ciSpent(ctx, step))
    return waitCiExhausted(ctx, step, { kind: 'poll_ci', step }, {});
  // A runtime task stamps the request so the per-head CI window starts at the first poll (FR-043.08).
  const at = s.runtime_ref === null ? {} : { at: ctx.now };
  // A runtime task numbers polls per head, which only grows: re-entering the CI wait from the merge
  // wait (a rerun seen by the observation) must not collide with an earlier poll of the same head.
  const n =
    s.runtime_ref === null
      ? `${s.ci_polls + 1}`
      : `p${(s.head_sha === null ? 0 : (s.run.ci_wait[s.head_sha]?.polls ?? 0)) + 1}`;
  requestEffect(ctx, {
    kind: 'await_ci',
    logical_id: `${s.head_sha ?? 'none'}#${visitOf(ctx, step)}#${n}`,
    step,
    request: {
      head_sha: s.head_sha,
      pr_ref: s.pr_ref,
      required_checks: ctx.frozen.ci.required_checks,
      ...at,
    },
  });
}

/**
 * CI budget of one head for a runtime task (FR-043.08, research R-04): the frozen step timeout from the
 * first poll of that head, and at most `ci_max_polls_per_head` polls. A rerun, a recheck or a revisit of
 * the step does not reset it; only a new head starts a new window.
 */
export function ciWindow(
  ctx: Pick<Ctx, 'state' | 'frozen'>,
  step: string,
  head: string | null,
): {
  exhausted: boolean;
  polls: number;
  max_polls: number;
  started_at: number | null;
  until: number | null;
} {
  const def = ctx.frozen.workflow.steps[step];
  const poll = def?.poll ?? 60_000;
  const timeout = def?.timeout ?? 3_600_000;
  const cap = ctx.state.run.limits?.ci_max_polls_per_head ?? Number.POSITIVE_INFINITY;
  const maxPolls = Math.min(cap, Math.max(1, Math.ceil(timeout / poll)));
  const w = head === null ? undefined : ctx.state.run.ci_wait[head];
  if (w === undefined)
    return {
      exhausted: false,
      polls: 0,
      max_polls: maxPolls,
      started_at: null,
      until: null,
    };
  return {
    exhausted: w.polls >= maxPolls,
    polls: w.polls,
    max_polls: maxPolls,
    started_at: w.started_at,
    until: w.started_at + timeout,
  };
}

/** Whether the head's CI window is spent: every poll used, or its time passed (FR-043.08). */
export function ciSpent(ctx: Pick<Ctx, 'state' | 'frozen' | 'now'>, step: string): boolean {
  const w = ciWindow(ctx, step, ctx.state.head_sha);
  return w.exhausted || (w.until !== null && ctx.now > w.until);
}

/** Whether the time of the head's CI window has passed; the last poll's own answer still counts within it. */
function ciClosed(ctx: Pick<Ctx, 'state' | 'frozen' | 'now'>, step: string): boolean {
  const w = ciWindow(ctx, step, ctx.state.head_sha);
  return w.until !== null && ctx.now > w.until;
}

/** The head's CI window is spent: wait `ci/ci_wait_exhausted`, with no fix, rerun or further poll (FR-043.08). */
export function waitCiExhausted(
  ctx: Ctx,
  step: string,
  resume: ResumeAction,
  detail: Record<string, unknown>,
): void {
  const w = ciWindow(ctx, step, ctx.state.head_sha);
  waitTask(
    ctx,
    mkWait('ci', 'ci_wait_exhausted', {
      resume,
      resume_when: ['recheck(observation)'],
      exit_paths: ['merge the PR on GitHub', 'cancel'],
      detail: {
        ...detail,
        step,
        head_sha: ctx.state.head_sha,
        polls: w.polls,
        max_polls: w.max_polls,
        started_at: w.started_at,
        until: w.until,
      },
    }),
  );
  restartCadence(ctx);
}

/**
 * Legacy CI polling follows timeout/poll. Runtime tasks wait with ci_wait_exhausted when the head
 * window is spent; independent PR observation continues without granting fixes, reruns, or
 * extensions.
 */
function armCiPoll(
  ctx: Ctx,
  step: string,
  resume: ResumeAction,
  detail: Record<string, unknown>,
  as: {
    reason: 'ci' | 'infra';
    code: 'checks_incomplete' | 'observation_unknown';
  } = { reason: 'ci', code: 'checks_incomplete' },
): void {
  const def = stepDef(ctx, step);
  const poll = def.poll ?? 60_000;
  if (ctx.state.runtime_ref !== null) {
    const w = ciWindow(ctx, step, ctx.state.head_sha);
    if (w.exhausted || (w.until !== null && ctx.now + poll > w.until))
      return waitCiExhausted(ctx, step, resume, detail);
  } else {
    const maxPolls = def.timeout !== undefined ? Math.max(1, Math.ceil(def.timeout / poll)) : 1;
    if (ctx.state.ci_polls >= maxPolls && ctx.state.current_step === step) {
      route(ctx, step, 'timeout');
      return;
    }
  }
  const timerId = ctx.nextId();
  ctx.emit('TimerArmed', {
    timer_id: timerId,
    kind: 'ci_poll',
    due_at: ctx.now + poll,
    payload: { step, resume },
  });
  waitTask(
    ctx,
    mkWait(as.reason, as.code, {
      resume,
      resume_when: [`timer(${timerId})`],
      detail: { ...detail, timer_id: timerId },
    }),
  );
}

type EffectResultTrigger = Extract<Trigger, { kind: 'effect_result' }>;

function stepKindOf(ctx: Ctx, e: EffectMirror): StepKind | null {
  return e.step === null ? null : (ctx.frozen.workflow.steps[e.step]?.kind ?? null);
}

export function parseSuccess(
  ctx: Ctx,
  e: EffectMirror,
  data: unknown,
): { ok: true; data: unknown } | { ok: false; issues: string[] } {
  const schema = (() => {
    switch (e.kind) {
      case 'start_agent':
        return stepKindOf(ctx, e) === 'review'
          ? ReviewDataSchema.or(ReviewRefusedSchema)
          : AgentDataSchema;
      case 'run_gates':
        return GateDataSchema;
      case 'prepare':
        return PrepareDataSchema;
      case 'publish':
        return PublishDataSchema;
      case 'rerun_ci':
        return RerunDataSchema;
      case 'create_pr':
        return CreatePrDataSchema;
      case 'mark_ready':
        return MarkReadyDataSchema;
      case 'post_review':
        return PostReviewDataSchema;
      case 'await_ci':
        return AwaitCiDataSchema;
      case 'merge':
        return MergeDataSchema;
      case 'stop_attempt':
        return StopDataSchema;
      case 'reconcile':
      case 'observe_external':
        return null;
      default:
        return assertNever(e.kind);
    }
  })();
  if (schema === null) return { ok: true, data };
  const r = schema.safeParse(data);
  return r.success
    ? { ok: true, data: r.data }
    : {
        ok: false,
        issues: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
}

/** A CI read started before a remote merge was taken as the base update reads a replaced head (#110). */
export function supersededCiRead(s: TaskState, e: EffectMirror): boolean {
  return e.kind === 'await_ci' && (s.run.superseded_reads?.includes(e.id) ?? false);
}

export function onEffectResult(ctx: Ctx, t: EffectResultTrigger): void {
  const e = ctx.state.effects[t.effect_id];
  if (e === undefined)
    reject('invalid_trigger', {
      reason: 'unknown_effect',
      effect_id: t.effect_id,
    });
  if (t.attempt_id !== undefined && t.attempt_id !== e.attempt_id) {
    reject('invalid_trigger', { reason: 'attempt_mismatch', effect_id: e.id });
  }
  if (e.status !== 'started') {
    ctx.emit('SignalIgnored', {
      reason: `effect_${e.status}`,
      trigger_kind: t.kind,
      detail: { effect_id: e.id },
    });
    return;
  }
  switch (t.outcome) {
    case 'unknown':
      ctx.emit('EffectCompleted', {
        effect_id: e.id,
        status: 'unknown',
        result: null,
      });
      // Still reconciled so the read settles, but it no longer holds the task (#110).
      if (supersededCiRead(ctx.state, e)) return requestReconcile(ctx, e);
      onEffectUnknown(ctx, e);
      return;
    case 'succeeded': {
      // Invalid agent output still consumes a run; classify it as invalid_output below.
      const parsed = parseSuccess(ctx, e, t.data);
      if (!parsed.ok && e.kind !== 'start_agent')
        reject('invalid_trigger', {
          reason: 'invalid_data',
          issues: parsed.issues,
        });
      ctx.emit('EffectCompleted', {
        effect_id: e.id,
        status: 'succeeded',
        result: parsed.ok ? parsed.data : (t.data ?? null),
      });
      // A late result after a merge proof (e.g. a push that still landed) is recorded, never acted on.
      if (ctx.state.completion !== null || supersededCiRead(ctx.state, e)) return;
      // Under a recorded head drift a result is history of its own operation (H01/H02): no route.
      if (ctx.state.run.head_drift !== null)
        return settleUnderDrift(
          ctx,
          e,
          (t.data as { invoked?: boolean } | undefined)?.invoked !== false,
        );
      onEffectSucceeded(ctx, e, t.data);
      return;
    }
    case 'failed': {
      const f = FailureDataSchema.safeParse(t.data);
      if (!f.success)
        reject('invalid_trigger', {
          reason: 'invalid_failure',
          issues: f.error.issues.map((i) => i.message),
        });
      ctx.emit('EffectCompleted', {
        effect_id: e.id,
        status: 'failed',
        result: f.data,
      });
      if (ctx.state.completion !== null || supersededCiRead(ctx.state, e)) return;
      if (ctx.state.run.head_drift !== null)
        return settleUnderDrift(ctx, e, f.data.invoked !== false);
      onEffectFailed(ctx, e, f.data);
      return;
    }
    default:
      assertNever(t.outcome);
  }
}

/**
 * Unknown outcomes keep reservations and require reconciliation; never replay an effect on a
 * guess.
 */
export function onEffectUnknown(ctx: Ctx, e: EffectMirror): void {
  requestReconcile(ctx, e);
  if (ctx.state.status === 'RUNNING' && ctx.state.cancellation === null) {
    ctx.emit('TaskWaiting', {
      wait: mkWait('infra', 'effect_unknown', {
        resume_when: [`reconcile(${e.id})`],
        // `since` lets a long reconciliation reach the person's attention list (#249).
        detail: { effect_id: e.id, kind: e.kind, since: ctx.now },
      }),
    });
  }
}

function resumeIfWaitingOn(ctx: Ctx, e: EffectMirror): void {
  const w = ctx.state.wait;
  if (ctx.state.status === 'WAITING' && w?.detail['effect_id'] === e.id)
    ctx.emit('TaskResumed', { reason: `effect:${e.id}` });
}

/**
 * Handle validated success data for both direct results and reconciliation. Only success that
 * survives step-level validation clears the rate-limit/infrastructure outage; probes settle
 * through closeProbe.
 */
export function onEffectSucceeded(ctx: Ctx, e: EffectMirror, data: unknown): void {
  const since = ctx.events.length;
  routeSuccess(ctx, e, data);
  clearRetryCounters(ctx, e.step, since);
}

function routeSuccess(ctx: Ctx, e: EffectMirror, data: unknown): void {
  resumeIfWaitingOn(ctx, e);
  const step = e.step;
  switch (e.kind) {
    case 'start_agent':
      onAgentOutput(ctx, e, data);
      return;
    case 'run_gates': {
      const d = GateDataSchema.parse(data);
      const baseUpdate = ctx.state.run.base_update;
      if (d.base_conflict !== undefined) {
        if (
          baseUpdate === undefined ||
          e.base_update === undefined ||
          d.tree !== d.base_conflict.tree
        )
          return waitBaseRepair(ctx, 'unbound base conflict');
        ctx.emit('BaseUpdateRecorded', {
          update: { ...baseUpdate, conflict: d.base_conflict },
        });
        if (baseUpdate.fixer_attempt_id !== undefined)
          return retryBaseFixer(ctx, 'conflict returned after the single fixer attempt');
        // In a review/fix round the review fixer takes the conflict with the review's findings.
        if (baseUpdate.fix_step !== undefined)
          return proceed(ctx, { kind: 'enter_step', step: baseUpdate.fix_step });
        proceed(ctx, { kind: 'route', step: step as string, outcome: 'fail' });
        return;
      }
      // A minor fix whose gate tree moved is dropped like a failed one, never a wait.
      if (isMinorStep(stepDef(ctx, step as string))) return onMinorGates(ctx, e, d);
      if (onGateTree(ctx, e, d)) return;
      const sg = ctx.frozen.gates.by_step[step as string];
      // Without an explicit required list, every executed gate is required; an empty list never passes.
      const required =
        sg !== undefined && sg.required.length > 0
          ? sg.required
          : (sg?.run ?? d.results.map((r) => r.gate));
      const passed =
        required.length > 0 &&
        required.every((g) => d.results.some((r) => r.gate === g && r.passed));
      const failing =
        d.results.find((r) => !r.passed && required.includes(r.gate)) ??
        d.results.find((r) => !r.passed);
      const signature = failing?.signature ?? null;
      ctx.emit('GateResultRecorded', {
        step: step as string,
        visit: visitOf(ctx, step as string),
        effect_id: e.id,
        results: d.results,
        passed,
        signature,
        resets_streak_of: passed && !reviewStreak(ctx.state) ? ctx.state.last_fix_step : null,
      });
      if (!passed) recordCheckFailure(ctx, signature);
      // A review/fix round goes on to the gate fixer as any round does; its one conflict fix is spent.
      if (
        !passed &&
        baseUpdate !== undefined &&
        baseUpdate.certificate === undefined &&
        baseUpdate.fix_step === undefined
      )
        return waitBaseRepair(
          ctx,
          'base update gates failed; no additional automatic fixer attempt',
        );
      if (passed && d.checkpoint === undefined && commitsCheckpoint(ctx, step as string)) {
        onEffectFailed(ctx, e, {
          failure_class: 'infra',
          message: 'gates passed without a checkpoint commit',
        });
        return;
      }
      if (passed && d.checkpoint !== undefined) recordCheckpoint(ctx, step as string, d.checkpoint);
      if (
        passed &&
        d.checkpoint !== undefined &&
        baseUpdate !== undefined &&
        baseUpdate.certificate === undefined
      ) {
        const scope = d.base_scope ?? baseUpdate.scope;
        if (
          baseUpdate.conflict !== undefined &&
          (scope === undefined ||
            scope.unresolved ||
            ((scope.unchanged_conflicts?.length ?? 0) > 0 &&
              baseUpdate.manual_resolution === undefined) ||
            scope.tree !== d.checkpoint.tree)
        )
          return retryBaseFixer(ctx, 'conflict resolution is not verified');
        const outside = scope?.outside_files ?? [];
        ctx.emit('BaseUpdateRecorded', {
          update: {
            ...baseUpdate,
            ...(scope === undefined ? {} : { scope }),
            // Gate certification closes base repair; only reviewOf may exempt a new review,
            // and it also requires the recorded scope to contain no outside changes.
            certificate: {
              head_sha: d.checkpoint.sha,
              tree: d.checkpoint.tree,
            },
          },
        });
        if (outside.length > 0 && ctx.state.run.mode === 'direct-pr')
          return waitBaseRepair(
            ctx,
            'review required for changes outside conflict files; this direct-pr snapshot has no reviewer',
          );
        // A clean merge in a review/fix round: the review's findings still wait for their fixer.
        if (baseUpdate.fix_step !== undefined && baseUpdate.conflict === undefined)
          return proceed(ctx, { kind: 'enter_step', step: baseUpdate.fix_step });
      }
      if (
        passed &&
        d.checkpoint !== undefined &&
        // Only the gate of an open conflict repair is exempt; a certified update stays recorded.
        (baseUpdate === undefined || baseUpdate.certificate !== undefined) &&
        fixLeftFindings(ctx, step as string, d.checkpoint.sha, d.changed_since)
      )
        return;
      proceed(ctx, {
        kind: 'route',
        step: step as string,
        outcome: passed ? 'pass' : 'fail',
      });
      return;
    }
    case 'prepare': {
      const d = PrepareDataSchema.parse(data);
      if (!d.setup.passed) {
        onEffectFailed(ctx, e, {
          failure_class: 'infra',
          message: 'setup_failed',
        });
        return;
      }
      proceed(ctx, { kind: 'route', step: step as string, outcome: 'ok' });
      return;
    }
    case 'publish': {
      const d = PublishDataSchema.parse(data);
      ctx.emit('PublishRecorded', { head_sha: d.head_sha });
      ctx.emit('BaseRelationRecorded', { relation: d.base_relation });
      if (isSalvage(ctx, e))
        return finishSalvage(
          ctx,
          d.pr_ref === undefined ? { detail: 'no PR' } : { pr_ref: d.pr_ref },
        );
      proceed(ctx, { kind: 'route', step: step as string, outcome: 'ok' });
      return;
    }
    case 'create_pr':
    case 'mark_ready':
    case 'post_review':
    case 'rerun_ci':
      proceed(ctx, { kind: 'route', step: step as string, outcome: 'ok' });
      return;
    case 'await_ci': {
      const d = AwaitCiDataSchema.parse(data);
      // CI of a PR that targets another branch is not recorded: it proves nothing for this target.
      if (d.target_ref !== undefined && d.target_ref !== ctx.state.task.base_branch)
        return waitTargetMismatch(ctx, step as string, d.target_ref, d.target_merged === true);
      // A closed PR yields no CI evidence; the task waits for it to be reopened (FR-041.07).
      if (d.pr_state === 'closed') {
        if (ctx.state.cancellation !== null) return proceed(ctx, { kind: 'none' });
        return waitPrClosed(ctx, { kind: 'poll_ci', step: step as string });
      }
      const green =
        d.head_sha === ctx.state.head_sha &&
        ciVerdict(ctx.frozen, d.required_set, d.checks).kind === 'pass';
      // A poll that reads the same CI again adds nothing to the evidence (#262).
      const resets = green ? ctx.state.last_fix_step : null;
      if (resets !== null || !heldCi(ctx.state, d))
        ctx.emit('CiResultRecorded', {
          head_sha: d.head_sha,
          required_set: d.required_set,
          checks: d.checks,
          ...(d.required === undefined ? {} : { required: d.required }),
          resets_streak_of: resets,
        });
      if (d.base_relation !== undefined)
        ctx.emit('BaseRelationRecorded', { relation: d.base_relation });
      onCiRecorded(ctx, step as string, d.head_sha === ctx.state.head_sha ? d.required : undefined);
      return;
    }
    case 'merge': {
      const d = MergeDataSchema.parse(data);
      if (d.merged) {
        proceed(ctx, { kind: 'route', step: step as string, outcome: 'ok' });
        return;
      }
      if (ctx.state.cancellation !== null) return;
      askHuman(ctx, 'merge_not_done', {
        step,
        attempt_id: null,
        body: 'Merge has not been performed',
        resume: { kind: 'merge_check', step: step as string },
      });
      return;
    }
    case 'stop_attempt': {
      const target =
        e.target_effect_id === null ? undefined : ctx.state.effects[e.target_effect_id];
      if (target !== undefined && target.status === 'started') requestReconcile(ctx, target);
      return;
    }
    // Observation facts arrive through `observation_result`, not through this effect's own result.
    case 'reconcile':
    case 'observe_external':
      return;
    default:
      assertNever(e.kind);
  }
}

export function onCiRecorded(ctx: Ctx, step: string, required?: RequiredCheckVerdict): void {
  const s = ctx.state;
  if (s.cancellation !== null || isTerminal(s.status)) return proceed(ctx, { kind: 'none' });
  const covered = required === undefined || required.kind === 'covered';
  const head = s.head_sha;
  const ci = head === null ? undefined : latestCi(s, head);
  // Evidence for another head cannot prove anything about the current head.
  const verdict = ci === undefined ? null : ciVerdict(ctx.frozen, ci.required_set, ci.checks);
  // Any other result that lands after the head's CI window closed is evidence only, even for a poll
  // sent in time; a covered pass still moves to the merge wait (FR-043.08, FR-043.11).
  if (s.runtime_ref !== null && ciClosed(ctx, step) && !(covered && verdict?.kind === 'pass'))
    return waitCiExhausted(ctx, step, { kind: 'poll_ci', step }, { late_result: true });
  if (required !== undefined && required.kind !== 'covered' && s.runtime_ref !== null)
    return onRequiredNotCovered(ctx, step, required);
  if (verdict?.kind === 'pass') return proceed(ctx, { kind: 'route', step, outcome: 'pass' });
  if (verdict?.kind === 'fail') return proceed(ctx, { kind: 'route', step, outcome: 'fail' });
  if (s.source_drift !== null || pastDeadline(ctx)) return proceed(ctx, { kind: 'poll_ci', step });
  armCiPoll(
    ctx,
    step,
    { kind: 'poll_ci', step },
    verdict === null
      ? { stale_head: true }
      : {
          missing: verdict.missing,
          not_passed: verdict.not_passed,
          complete: verdict.complete,
        },
  );
}

/**
 * GitHub requires checks the frozen snapshot does not cover, or could not be read in full (FR-042.04/06).
 * A mismatch withdraws green and waits under policy with both sides listed; the exit is adjusting GitHub
 * and observing again, or a cancel and a new task (FR-042.09). The snapshot is never widened. An
 * incomplete read is `unknown`: it waits under infra and polls again within the head's CI window.
 */
function onRequiredNotCovered(
  ctx: Ctx,
  step: string,
  v: Exclude<RequiredCheckVerdict, { kind: 'covered' }>,
): void {
  const s = ctx.state;
  if (s.source_drift !== null || pastDeadline(ctx)) return proceed(ctx, { kind: 'poll_ci', step });
  if (v.kind === 'unknown') {
    armCiPoll(
      ctx,
      step,
      { kind: 'poll_ci', step },
      { required: 'unknown', basis: v.basis },
      { reason: 'infra', code: 'observation_unknown' },
    );
    return;
  }
  waitTask(
    ctx,
    mkWait('policy', 'required_checks_mismatch', {
      resume: { kind: 'poll_ci', step },
      resume_when: ['observation', 'recheck(observation)'],
      exit_paths: [
        'make the GitHub required checks a subset of the frozen ci.required_checks, then recheck',
        'cancel and add a new task with the new configuration',
      ],
      detail: {
        step,
        head_sha: s.head_sha,
        github_only: v.missing_from_snapshot,
        app_pinned: v.app_pinned,
        snapshot_only: v.snapshot_only,
      },
    }),
  );
}

/**
 * The PR targets another branch than the task snapshot (FR-041.05): WAITING/policy `target_mismatch`.
 * Within the step's poll budget a timer re-observes, so retargeting the PR back resumes the CI wait;
 * past it only an amendment or a cancel moves the task. A PR already merged into the other branch
 * cannot be retargeted, so it waits for a person with no timer (FR-040.12). No CI result or merge
 * evidence is taken from the other branch.
 */
function waitTargetMismatch(ctx: Ctx, step: string, observed: string, merged: boolean): void {
  const s = ctx.state;
  if (s.cancellation !== null || isTerminal(s.status)) return proceed(ctx, { kind: 'none' });
  const resume: ResumeAction = { kind: 'poll_ci', step };
  const detail = { step, expected: s.task.base_branch, observed, merged };
  const def = stepDef(ctx, step);
  const poll = def.poll ?? 60_000;
  const maxPolls = def.timeout !== undefined ? Math.max(1, Math.ceil(def.timeout / poll)) : 1;
  if (merged) {
    waitTask(
      ctx,
      mkWait('policy', 'target_mismatch', {
        resume,
        resume_when: ['amend'],
        exit_paths: ['cancel'],
        detail,
      }),
    );
    return;
  }
  const exit_paths = [`retarget the PR to ${s.task.base_branch}`, 'cancel'];
  if (s.ci_polls >= maxPolls) {
    waitTask(
      ctx,
      mkWait('policy', 'target_mismatch', {
        resume,
        resume_when: ['amend'],
        exit_paths,
        detail,
      }),
    );
    return;
  }
  const timerId = ctx.nextId();
  ctx.emit('TimerArmed', {
    timer_id: timerId,
    kind: 'ci_poll',
    due_at: ctx.now + poll,
    payload: { step, resume },
  });
  waitTask(
    ctx,
    mkWait('policy', 'target_mismatch', {
      resume,
      resume_when: [`timer(${timerId})`, 'amend'],
      exit_paths,
      detail: { ...detail, timer_id: timerId },
    }),
  );
}

function isStale(ctx: Ctx, attemptId: string | null): boolean {
  if (attemptId === null) return true;
  const a = ctx.state.attempts[attemptId];
  return (
    a === undefined ||
    a.revision !== ctx.state.revision ||
    ctx.state.current_attempt[a.step] !== attemptId
  );
}

/** A worker's report is a claim for the reviewer to check, so a long one is cut rather than kept whole. */
export const WORKER_REPORT_MAX = 8_000;

function workerReport(summary: string): string {
  if (summary.length <= WORKER_REPORT_MAX) return summary;
  return `${summary.slice(0, WORKER_REPORT_MAX)}\n[truncated: kept ${WORKER_REPORT_MAX} of ${summary.length} characters]`;
}

function onAgentOutput(ctx: Ctx, e: EffectMirror, data: unknown): void {
  const step = e.step as string;
  const review = stepKindOf(ctx, e) === 'review';
  const parsed = (review ? ReviewDataSchema.or(ReviewRefusedSchema) : AgentDataSchema).safeParse(
    data,
  );
  const invoked = parsed.success ? parsed.data.invoked !== false : true;
  if (invoked) consume(ctx, e.reservation_id);
  else release(ctx, e.reservation_id);

  if (!parsed.success || !parsed.data.schema_checked) {
    onEffectFailed(
      ctx,
      e,
      {
        failure_class: 'invalid_output',
        message: parsed.success
          ? 'schema_checked=false'
          : 'Output does not match the result schema',
      },
      true,
    );
    return;
  }
  const d = parsed.data;
  const status = 'verdict' in d ? d.verdict : d.status;
  if (e.attempt_id !== null) {
    const session =
      'session_ref' in d && d.session_ref !== undefined ? { session_ref: d.session_ref } : {};
    const role = ctx.frozen.steps[step]?.role;
    const report =
      !('verdict' in d) && d.status === 'done' && (role === 'coder' || role === 'fixer')
        ? { summary: workerReport(d.summary) }
        : {};
    ctx.emit('AttemptFinished', {
      attempt_id: e.attempt_id,
      step,
      status,
      class: null,
      signature: null,
      usage: usageOf(d.usage),
      ...session,
      ...report,
    });
  }
  if (afterAttempt(ctx, e)) return;
  // The required context alone is past the budget: no answer or retry makes the packet smaller, so the
  // task ends with the reason (#247). The optional parts were already dropped.
  if (
    !('verdict' in d) &&
    d.invoked === false &&
    d.missing?.includes('context_budget') === true &&
    ctx.state.cancellation === null &&
    !isMinorStep(stepDef(ctx, step))
  )
    return failWithDraft(ctx, `context_budget:${step}`);
  const baseUpdate = ctx.state.run.base_update;
  if (
    !('verdict' in d) &&
    baseUpdate?.fixer_attempt_id === e.attempt_id &&
    baseUpdate.certificate === undefined
  ) {
    if (
      d.status !== 'done' ||
      d.base_repair === undefined ||
      d.base_repair.unresolved ||
      d.base_repair.tree !== d.worktree_tree
    )
      return retryBaseFixer(ctx, 'single conflict fixer attempt did not resolve the conflict');
    ctx.emit('BaseUpdateRecorded', {
      update: { ...baseUpdate, scope: d.base_repair },
    });
  } else if (
    !('verdict' in d) &&
    baseUpdate?.fix_step !== undefined &&
    baseUpdate.fixer_attempt_id !== undefined &&
    baseUpdate.conflict !== undefined &&
    baseUpdate.certificate === undefined &&
    d.status === 'done'
  ) {
    // A gate fixer after the conflict fix: its tree is the one the next gates check the scope of.
    if (
      d.base_repair === undefined ||
      d.base_repair.unresolved ||
      d.base_repair.tree !== d.worktree_tree
    )
      return retryBaseFixer(ctx, 'gate fixer left the merge conflict unresolved');
    ctx.emit('BaseUpdateRecorded', {
      update: { ...baseUpdate, scope: d.base_repair },
    });
  }
  // A minor fix keeps the PR title and body the review approved.
  if (!('verdict' in d) && d.content !== undefined && !isMinorStep(stepDef(ctx, step))) {
    ctx.emit('PublishContentRecorded', {
      content: {
        revision: ctx.state.revision,
        digest: d.content.digest,
        ref: d.content.ref,
        attempt_id: e.attempt_id,
      },
    });
  }
  if ('verdict' in d) {
    const approved = d.verdict === 'approve';
    const signature = approved ? null : reviewSignature(d.findings);
    const input = modeReview(ctx) ? reviewInputDigest(ctx.state, ctx.frozen, step) : null;
    // A mode-aware review approves the checkpoint commit and the input it was given, nothing else (M03).
    if (
      modeReview(ctx) &&
      (input === null || d.head_sha !== ctx.state.run.checkpoint?.sha || d.input_digest !== input)
    ) {
      onEffectFailed(
        ctx,
        e,
        {
          failure_class: 'invalid_output',
          message: 'review does not match the checkpoint it was given',
        },
        true,
      );
      return;
    }
    const repeated = approved ? [] : untouchedRepeats(ctx.state.run.reviews, ctx.state.revision, d);
    ctx.emit('ReviewVerdictRecorded', {
      step,
      attempt_id: e.attempt_id as string,
      verdict: d.verdict,
      head_sha: d.head_sha,
      signature,
      resets_streak_of: approved ? ctx.state.last_fix_step : null,
      ...(input === null
        ? {}
        : { input_digest: input, findings: keptFindings(d.findings, MAX_FINDINGS) }),
      ...(input === null || d.summary === undefined
        ? {}
        : { summary: d.summary.slice(0, MAX_SUMMARY) }),
    });
    if (!approved) recordCheckFailure(ctx, signature);
    if (
      !approved &&
      ctx.state.run.base_update?.fix_step === undefined &&
      ctx.state.run.base_update?.scope?.outside_files.length
    )
      return waitBaseRepair(
        ctx,
        'review rejected changes outside conflict files; conflict fixer attempt already used',
      );
    // The fixer left these files alone after the last review asked for them: it is told so, and the
    // verdict routes on as usual, so the review is posted on its way to the fixer.
    if (repeated.length > 0) {
      waitReviewRepeated(
        ctx,
        step,
        e.attempt_id,
        `The review blocks again on ${repeated.join(', ')}, which the fix since the last review did not change:`,
        d.findings.filter((f) => isBlocking(f) && repeated.includes(f.file ?? '')),
        repeated,
      );
      return;
    }
    proceed(ctx, { kind: 'route', step, outcome: d.verdict });
    return;
  }
  // A minor fix never waits for a person: short of done, the handler put the worktree back and the
  // approved commit goes on as it is.
  if (isMinorStep(stepDef(ctx, step)) && d.status !== 'done') {
    if (ctx.state.cancellation !== null) return proceed(ctx, { kind: 'none' });
    dropMinorFix(ctx, step);
    return;
  }
  // Context refused before launch is a human wait, never another automatic model attempt.
  if (ctx.state.runtime_ref !== null && d.status === 'needs_context' && d.invoked === false) {
    askHuman(ctx, 'agent_question', {
      step,
      attempt_id: e.attempt_id,
      body: `needs_context: ${d.summary}`,
      resume: { kind: 'start_attempt', step, attempt_kind: 'retry' },
    });
    return;
  }
  // An invoked worker that lacks context or is blocked waits for a person with what it reported; the
  // next attempt runs only on an answer, under the usual slot/budget checks (FR-039).
  if (ctx.state.runtime_ref !== null && (d.status === 'needs_context' || d.status === 'blocked')) {
    if (ctx.state.cancellation !== null) return proceed(ctx, { kind: 'none' });
    const reported = d.blocker ?? d.summary;
    askHuman(ctx, d.status === 'blocked' ? 'agent_blocked' : 'agent_needs_context', {
      step,
      attempt_id: e.attempt_id,
      // A worker may list questions with its blocker; whoever answers needs them too.
      body: [`${d.status}: ${reported}`, ...(d.questions ?? [])].join('\n'),
      resume: { kind: 'start_attempt', step, attempt_kind: 'retry' },
      detail: { step, reported },
    });
    return;
  }
  if (d.status === 'needs_input') {
    if (ctx.state.cancellation !== null) return proceed(ctx, { kind: 'none' });
    route(ctx, step, 'needs_input', d.questions?.join('\n') ?? d.summary);
    return;
  }
  proceed(ctx, { kind: 'route', step, outcome: d.status });
}

/**
 * Ignore stale results and wait for input after a requested stop. true means the outcome must not
 * advance the task.
 */
function afterAttempt(ctx: Ctx, e: EffectMirror): boolean {
  if (isStale(ctx, e.attempt_id)) {
    ctx.emit('SignalIgnored', {
      reason: 'stale_attempt',
      trigger_kind: ctx.env.trigger.kind,
      detail: { attempt_id: e.attempt_id },
    });
    return true;
  }
  const a = ctx.state.attempts[e.attempt_id as string];
  if (a?.stop_requested) {
    if (ctx.state.cancellation !== null) return true;
    // A stopped minor fixer is not started over: its fix is dropped, whatever its run returned.
    if (isMinorStep(stepDef(ctx, a.step))) {
      dropMinorFix(ctx, a.step);
      return true;
    }
    // Stopped by `pause --now`: the step starts over in a new session, held while the task is paused,
    // and started at once when it was resumed before the stopped run ended.
    if (stoppedByPause(ctx, a.id)) {
      proceed(ctx, { kind: 'start_attempt', step: a.step, attempt_kind: 'fresh_session' });
      return true;
    }
    // Interrupted by a message: the next turn continues this session with it when the harness can
    // resume, else starts a new one; held while the task is paused (issue #154).
    if (stoppedByMessage(ctx, a.id)) {
      proceed(ctx, afterMessageStop(ctx, a));
      return true;
    }
    askHuman(ctx, 'attempt_stopped', {
      step: a.step,
      attempt_id: a.id,
      body: `Attempt ${a.n} of step '${a.step}' stopped as requested`,
      resume: {
        kind: 'start_attempt',
        step: a.step,
        attempt_kind: 'fresh_session',
      },
    });
    return true;
  }
  return false;
}

/**
 * Failed effect: settles the reservation and the attempt, then applies the per-class handling of FR-019.
 */
export function onEffectFailed(
  ctx: Ctx,
  e: EffectMirror,
  f: FailureData,
  budgetSettled = false,
): void {
  resumeIfWaitingOn(ctx, e);
  const s = ctx.state;
  if (isSalvage(ctx, e) && s.cancellation === null)
    return finishSalvage(ctx, { detail: f.message ?? f.failure_class });
  const step = e.step;
  const agent = e.kind === 'start_agent';
  if (agent && !budgetSettled) {
    if (f.invoked === false) release(ctx, e.reservation_id);
    else consume(ctx, e.reservation_id);
  }
  if (agent && e.attempt_id !== null) {
    ctx.emit('AttemptFinished', {
      attempt_id: e.attempt_id,
      step: step as string,
      status: null,
      class: f.failure_class,
      signature: f.signature ?? null,
      usage: usageOf(f.usage),
      ...(f.session_ref === undefined ? {} : { session_ref: f.session_ref }),
    });
    if (afterAttempt(ctx, e)) return;
  }
  // Minor findings never hold the task: a minor fixer or its gates that fail for any reason drop the fix,
  // with no retry and no wait; the steps after it need no harness. A failed publish is not dropped,
  // since the checkpoint already moved to the fix.
  if (
    (agent || e.kind === 'run_gates') &&
    step !== null &&
    s.cancellation === null &&
    isMinorStep(stepDef(ctx, step))
  ) {
    dropMinorFix(ctx, step);
    return;
  }
  // The harness was re-proved after the task froze its snapshot. Never a silent switch (T070/T071):
  // a manifest that still meets what the task froze for is recorded as taken (#249), any other waits for
  // a person's `recheck`; then the same step runs again. Nothing was invoked, so a conflict fixer
  // blocked here keeps its one attempt: it resumes as a fixer retry.
  if (agent && f.manifest !== undefined && s.cancellation === null && step !== null) {
    const baseFixer =
      s.run.base_update?.fixer_attempt_id === e.attempt_id &&
      s.run.base_update.certificate === undefined;
    const resume: ResumeAction = baseFixer
      ? { kind: 'repair_base', mode: 'retry_fixer' }
      : { kind: 'run_step', step };
    const { compatible, ...manifest } = f.manifest;
    if (compatible === true) {
      ctx.emit('ManifestChangeAccepted', {
        harness: manifest.harness,
        manifest_hash: manifest.observed,
        previous: manifest.known,
        by: ctx.actor,
        at: ctx.now,
      });
      proceed(ctx, resume, 'manifest_accepted');
      return;
    }
    waitPolicy(ctx, 'manifest_changed', resume, { step, ...manifest });
    return;
  }
  if (
    agent &&
    s.run.base_update?.fixer_attempt_id === e.attempt_id &&
    s.run.base_update.certificate === undefined &&
    s.cancellation === null
  )
    return retryBaseFixer(ctx, 'single conflict fixer attempt failed');
  if (
    !agent &&
    e.kind === 'run_gates' &&
    s.run.base_update !== undefined &&
    s.run.base_update.certificate === undefined &&
    s.cancellation === null &&
    (f.failure_class === 'refused' || f.failure_class === 'auth_config')
  )
    return waitBaseRepair(ctx, `base gates failed: ${f.message}`);
  // An expired or refused login fails every retry the same way, so none is scheduled: the task waits
  // for a person to sign in again, and `recheck` gives the visit back and runs the same step (#97).
  if (agent && f.auth !== undefined && s.cancellation === null && step !== null) {
    waitPolicy(
      ctx,
      'harness_auth',
      { kind: 'run_step', step },
      {
        step,
        harness: f.auth.harness,
        ...(f.message === undefined ? {} : { message: f.message }),
      },
    );
    return;
  }
  // The worktree is not the tree the task last left: someone else changed it, and it is not the
  // attempt's to take (T072). A person looks first; `recheck` takes the observed tree as the task's.
  if (agent && f.worktree !== undefined && s.cancellation === null && step !== null) {
    waitPolicy(
      ctx,
      'worktree_changed',
      { kind: 'run_step', step },
      { step, known: f.worktree.known, observed: f.worktree.observed },
    );
    return;
  }
  if (
    s.cancellation !== null ||
    step === null ||
    e.kind === 'stop_attempt' ||
    e.kind === 'reconcile'
  ) {
    proceed(ctx, { kind: 'none' });
    return;
  }
  handleFailure(ctx, e, f);
  if (
    e.kind === 'run_gates' &&
    s.run.base_update?.certificate === undefined &&
    s.run.base_update !== undefined &&
    ctx.state.wait?.detail.code === 'backoff_exhausted'
  )
    waitBaseRepair(ctx, 'base update retries exhausted; inspect and answer to continue');
}

// ---------- Execution modes (task-execution-modes.md) ----------

type StepSkippedReason = EventPayloads['StepSkipped']['reason'];

const MAX_FINDINGS = 50;
const MAX_SUMMARY = 4_000;

/** A graph that turns the PR ready later opens it as a draft, so the repo's CI can wait for the review. */
function draftUntilReady(ctx: Ctx): boolean {
  return Object.values(ctx.frozen.workflow.steps).some(
    (d) => d.kind === 'action' && d.action === 'github.mark_ready',
  );
}

/** Review steps of a task started with a confirmed mode compare inputs and bind to the checkpoint. */
function modeReview(ctx: Ctx): boolean {
  return ctx.state.run.mode === 'full-review';
}

/**
 * Before the review of a fix round: when the commits since the last rejecting review touched none of
 * the files it blocked on, the fix went around the findings (only tests, say). No reviewer run is spent
 * on it and no person is asked: the round counts against the fixer, which runs again with a note naming
 * those files (#168, #247). Returns true when the task went back to the fixer. Unknown changed files
 * never block.
 */
function fixLeftFindings(
  ctx: Ctx,
  step: string,
  head: string,
  changed: { sha: string; paths: readonly string[] } | undefined,
): boolean {
  // In `full-review` the committing gate step leads on, through publish, to the review.
  if (!modeReview(ctx) || changed === undefined || !commitsCheckpoint(ctx, step)) return false;
  const fixer = ctx.state.last_fix_step;
  if (fixer === null) return false;
  const prior = ctx.state.run.reviews
    .filter((r) => r.valid && r.revision === ctx.state.revision)
    .at(-1);
  // An unchanged commit is the reused review's case (M03), not this one.
  if (prior?.verdict !== 'request_changes' || prior.sha !== changed.sha || prior.sha === head)
    return false;
  const findings = prior.findings.filter((f) => isBlocking(f) && (f.file ?? '') !== '');
  const files = [...new Set(findings.map((f) => f.file as string))].sort();
  const touched = new Set(changed.paths);
  if (files.length === 0 || files.some((f) => touched.has(f))) return false;
  recordCheckFailure(ctx, prior.signature);
  answerForFixer(ctx, 'fix_no_src_change', {
    step,
    attempt_id: null,
    body: [
      'The fix since the last review changed none of the files its blocking findings are in:',
      ...findings.map(findingLine),
      `Changed: ${changed.paths.length === 0 ? '(nothing)' : changed.paths.join(', ')}`,
    ].join('\n'),
    answer: FIXER_NOTE,
    resume: { kind: 'enter_step', step: fixer },
    detail: { step, files },
  });
  return true;
}

const findingLine = (f: ReviewEvidence['findings'][number]): string =>
  `- ${f.severity} ${f.file ?? ''}${f.line === undefined ? '' : `:${f.line}`}: ${f.msg}`;

/** What the fixer is told when it left the review's findings alone; no person was asked. */
const FIXER_NOTE =
  'No person was asked: the engine answered. The review blocks on these files and the last fix did not change them. Fix each finding in the file it names. If a finding is wrong or out of scope, leave it and say why in your summary instead of changing other files.';

/**
 * A review/fix round that made no progress goes on to the fixer with a note naming the files it left
 * alone, never to a person (#247). The fixer gets one turn at its rung for it; repeating then raises
 * the rung, and past the ladder the task fails.
 */
function waitReviewRepeated(
  ctx: Ctx,
  step: string,
  attemptId: string | null,
  lead: string,
  findings: readonly ReviewEvidence['findings'][number][],
  files: readonly string[],
): void {
  answerForFixer(ctx, 'review_repeated', {
    step,
    attempt_id: attemptId,
    body: [lead, ...findings.map(findingLine)].join('\n'),
    answer: FIXER_NOTE,
    resume: { kind: 'route', step, outcome: 'request_changes' },
    detail: { step, files },
  });
}

/**
 * Before calling the reviewer: an unchanged review input of this revision reuses the recorded verdict
 * (M03). An approval routes on without a reviewer run. A reused rejection means the fix round moved
 * nothing the review reads, so it counts against the fixer, which is told so before another round.
 */
function reuseReview(ctx: Ctx, step: string): boolean {
  if (!modeReview(ctx)) return false;
  const input = reviewInputDigest(ctx.state, ctx.frozen, step);
  if (input === null) return false;
  const prior = reusableReview(ctx.state, input);
  if (prior === undefined) return false;
  ctx.emit('ReviewReused', {
    step,
    from_attempt_id: prior.attempt_id,
    verdict: prior.verdict,
    input_digest: input,
  });
  if (prior.verdict === 'approve') {
    route(ctx, step, 'approve');
    return true;
  }
  recordCheckFailure(ctx, prior.signature);
  // The whole input is unchanged, so this holds for a finding without a file or a minor one too.
  const blocking = prior.findings.filter(isBlocking);
  const findings = blocking.length > 0 ? blocking : prior.findings;
  const files = [...new Set(findings.flatMap((f) => (f.file ? [f.file] : [])))].sort();
  waitReviewRepeated(
    ctx,
    step,
    prior.attempt_id,
    'The review input is unchanged since it was rejected, so the rejection stands:',
    findings,
    files,
  );
  return true;
}

/** What publish pushes: the checkpoint commit, never whatever HEAD is at the time (M06). */
function publishRequest(ctx: Ctx, visit: number): Record<string, unknown> {
  const cp = ctx.state.run.checkpoint;
  if (ctx.state.run.mode === null || cp === null) return { checkpoint: visit };
  return {
    checkpoint: visit,
    sha: cp.sha,
    tree: cp.tree,
    base_sha: cp.base_sha,
    content_digest: ctx.state.run.content?.digest ?? cp.content_digest,
  };
}

/**
 * Gate tree discipline of a mode-aware task (M06): a run whose tree did not hold still is not evidence,
 * and a passing run of the commit gate step must come with the checkpoint commit of that same tree.
 * Returns true when the result was handled here.
 */
function onGateTree(ctx: Ctx, e: EffectMirror, d: z.infer<typeof GateDataSchema>): boolean {
  if (ctx.state.run.mode === null) return false;
  const step = e.step as string;
  // A new visit: the same visit's run_gates effect is already settled and would not run again.
  const again: ResumeAction = {
    kind: 'enter_step',
    step,
    ...(e.base_update === undefined ? {} : { base_update: e.base_update }),
  };
  if (d.stable === false) {
    onUnstableGates(ctx, e, d, again);
    return true;
  }
  if (d.checkpoint !== undefined && d.checkpoint.tree !== d.tree) {
    // `recheck worktree` takes the committed tree as the task's and runs the gates again on it.
    waitPolicy(ctx, 'worktree_changed', again, {
      step,
      known: d.tree ?? ctx.state.run.worktree_tree ?? '',
      observed: d.checkpoint.tree,
      gate_tree: d.tree ?? null,
      checkpoint_tree: d.checkpoint.tree,
    });
    return true;
  }
  return false;
}

const UNSTABLE_TREE = 'gate_tree_unstable';

/**
 * Gates that left the tree moving (a formatter or generator whose output the run could not settle on):
 * they run once more on the tree they left, which a passing run then commits. Moving again, it is a
 * quality failure the gate fixer gets with the reason, never a wait (#245).
 */
function onUnstableGates(
  ctx: Ctx,
  e: EffectMirror,
  d: z.infer<typeof GateDataSchema>,
  again: ResumeAction,
): void {
  const s = ctx.state;
  const step = e.step as string;
  const visit = visitOf(ctx, step);
  const prev = s.evidence.gates.filter((g) => g.valid && g.revision === s.revision).at(-1);
  const repeated =
    prev?.step === step && prev.visit === visit - 1 && prev.signature === UNSTABLE_TREE;
  ctx.emit('GateResultRecorded', {
    step,
    visit,
    effect_id: e.id,
    results: [
      ...d.results,
      {
        gate: 'tree_stability',
        passed: false,
        signature: UNSTABLE_TREE,
        log_excerpt:
          'The gate commands kept changing the working tree, so no run settled on one tree to commit. Make the generated or formatted output deterministic (or commit it) so a second run of the gates leaves the tree as it is.',
      },
    ],
    passed: false,
    signature: UNSTABLE_TREE,
    resets_streak_of: null,
  });
  if (!repeated) return proceed(ctx, again, 'gate_tree_unstable');
  recordCheckFailure(ctx, UNSTABLE_TREE);
  // The tree the gates left is the task's own: the fixer starts from it, and a change made after it
  // by someone else is still caught by the fixer's own worktree check.
  if (d.tree !== undefined && d.tree !== ctx.state.run.worktree_tree)
    ctx.emit('WorktreeChangeAccepted', {
      tree: d.tree,
      previous: ctx.state.run.worktree_tree ?? '',
      by: AUTO_ACTOR,
      at: ctx.now,
    });
  proceed(ctx, { kind: 'route', step, outcome: 'fail' });
}

/** The gate step whose pass leads to review or publish ends with the checkpoint commit in a mode task. */
export function commitsCheckpoint(ctx: Pick<Ctx, 'state' | 'frozen'>, step: string): boolean {
  if (ctx.state.run.mode === null) return false;
  const pass = ctx.frozen.workflow.steps[step]?.next['pass'];
  const next = pass === undefined ? undefined : ctx.frozen.workflow.steps[pass];
  return next?.kind === 'review' || next?.action === 'git.publish';
}

function recordCheckpoint(ctx: Ctx, step: string, c: z.infer<typeof CheckpointDataSchema>): void {
  const { base_conflicts, ...rest } = c;
  ctx.emit('CheckpointRecorded', {
    checkpoint: {
      revision: ctx.state.revision,
      ...rest,
      gate_visit: visitOf(ctx, step),
      ...(base_conflicts === undefined ? {} : { base_conflicts }),
    },
  });
}

// ---------- Minor findings of an approving review ----------

/**
 * Drops the minor fix and routes on: the approved commit goes on as it is. The approved checkpoint's
 * tree is the task's own again, so a worktree the handler could not put back makes the next worker
 * wait for a person (T072) instead of taking the dropped fix as the task's.
 */
function dropMinorFix(ctx: Ctx, step: string): void {
  const approval = latestApproval(ctx.state);
  const cp = ctx.state.run.checkpoint;
  if (approval !== undefined)
    ctx.emit('MinorFixDropped', {
      review_attempt_id: approval.attempt_id,
      tree: cp !== null && cp.revision === ctx.state.revision ? cp.tree : null,
    });
  proceed(ctx, {
    kind: 'route',
    step,
    outcome: stepDef(ctx, step).kind === 'gate' ? 'fail' : 'blocked',
  });
}

/**
 * Gates of a minor fix. A failure drops the fix (the handler put the worktree back) and is no evidence
 * against the approved commit. A pass carries the approval to the new checkpoint when the fix changed
 * only the findings' files and tests; anything else goes back through review.
 */
function onMinorGates(ctx: Ctx, e: EffectMirror, d: z.infer<typeof GateDataSchema>): void {
  const step = e.step as string;
  const sg = ctx.frozen.gates.by_step[step];
  const required =
    sg !== undefined && sg.required.length > 0
      ? sg.required
      : (sg?.run ?? d.results.map((r) => r.gate));
  const passed =
    required.length > 0 &&
    required.every((g) => d.results.some((r) => r.gate === g && r.passed)) &&
    d.stable !== false &&
    d.checkpoint !== undefined &&
    d.checkpoint.tree === d.tree;
  const failing = d.results.find((r) => !r.passed);
  ctx.emit('GateResultRecorded', {
    step,
    visit: visitOf(ctx, step),
    effect_id: e.id,
    results: d.results,
    passed,
    signature: failing?.signature ?? null,
    resets_streak_of: null,
    ...(passed ? {} : { discarded: true }),
  });
  if (!passed || d.checkpoint === undefined) return dropMinorFix(ctx, step);
  const findings = minorFindings(ctx.state);
  const approved = latestApproval(ctx.state);
  const before = ctx.state.run.checkpoint;
  recordCheckpoint(ctx, step, d.checkpoint);
  const allowed = new Set(findings.flatMap((f) => (f.file ? [f.file] : [])));
  const changed = d.changed_since;
  const inScope =
    approved !== undefined &&
    changed !== undefined &&
    changed.sha === approved.sha &&
    before?.sha === approved.sha &&
    before.content_digest === d.checkpoint.content_digest &&
    changed.paths.every((p) => allowed.has(p) || isTestPath(p));
  // Outside its findings, the fix is a change like any other: the review runs on it.
  if (!inScope) {
    proceed(ctx, { kind: 'route', step, outcome: 'pass' });
    return;
  }
  ctx.emit('MinorFixRecorded', {
    fix: {
      revision: ctx.state.revision,
      review_attempt_id: approved.attempt_id,
      approved_sha: approved.sha,
      sha: d.checkpoint.sha,
      tree: d.checkpoint.tree,
      paths: [...changed.paths],
    },
  });
  proceed(ctx, { kind: 'route', step, outcome: 'pass' });
}

/** A path conventionally holding tests: a minor fix may add or change them beside the findings' files. */
export function isTestPath(path: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|spec)\//.test(path) ||
    /\.(test|spec)\.[^/]+$/.test(path) ||
    /(^|\/)test_[^/]+\.py$/.test(path) ||
    /_test\.[^/.]+$/.test(path)
  );
}

/** The fixer step of a base conflict: the review fixer in a review/fix round, else the gate's `fail`. */
function conflictFixStep(ctx: Ctx, update: BaseUpdateRun): string | undefined {
  return update.fix_step ?? ctx.frozen.workflow.steps[update.gate_step]?.next['fail'];
}

/** The fixer a rejecting review leads to, past the step that posts the verdict on the PR. */
function reviewFixStep(ctx: Ctx): string | undefined {
  const steps = ctx.frozen.workflow.steps;
  const review = Object.values(steps).find((d) => d.kind === 'review');
  let target = review?.next['request_changes'];
  const post = target === undefined ? undefined : steps[target];
  if (post?.kind === 'action' && post.action === 'github.post_review') target = post.next['ok'];
  return target !== undefined && steps[target]?.kind === 'agent' ? target : undefined;
}

/**
 * Before the review fixer runs on a rejected checkpoint that conflicts with the base tip it was read
 * against (#239), the base is merged in first through the usual base update: a conflict then goes to
 * that fixer with the review's findings in the same attempt, a clean merge is gated and certified before
 * it. A fixer cannot clear a base conflict without the base, so waiting until merge only spends rounds.
 * Returns true when the update started.
 */
function updateBaseBeforeReviewFix(
  ctx: Ctx,
  target: string,
  from: { step: string; outcome: string },
): boolean {
  const s = ctx.state;
  const cp = s.run.checkpoint;
  const conflicts = cp?.base_conflicts;
  const u = s.run.base_update;
  const review = s.run.reviews.filter((r) => r.valid && r.revision === s.revision).at(-1);
  const gate = ctx.frozen.workflow.steps[target]?.next['done'];
  if (
    !modeReview(ctx) ||
    s.cancellation !== null ||
    cp === null ||
    conflicts === undefined ||
    conflicts.files.length === 0 ||
    cp.revision !== s.revision ||
    cp.sha !== s.head_sha ||
    s.run.head_drift !== null ||
    review?.verdict !== 'request_changes' ||
    review.sha !== cp.sha ||
    target !== reviewFixStep(ctx) ||
    gate === undefined ||
    !commitsCheckpoint(ctx, gate) ||
    // One update per checkpoint, and never over one still open.
    (u?.revision === s.revision && (u.certificate === undefined || u.head_sha === cp.sha))
  )
    return false;
  const update = { head_sha: cp.sha, base_sha: conflicts.tip_sha };
  ctx.emit('BaseUpdateRecorded', {
    update: { ...update, revision: s.revision, gate_step: gate, fix_step: target },
  });
  enterStep(ctx, gate, from, 'initial', update);
  return true;
}

/** A bounded operator decision, using the existing public question/answer path. */
/** How long a base repair question waits for a person after the automatic retry, before the task fails. */
export const BASE_REPAIR_WAIT_MS = 12 * 3_600_000;

/**
 * The conflict fixer did not get the base update through. Its one automatic second attempt runs first
 * (lockfiles and generated files are regenerated by it, see the conflict packet). Failing again, a
 * person may still repair it by hand, but only for {@link BASE_REPAIR_WAIT_MS}: then the task fails
 * with the reason instead of holding on (#247). Without a used conflict fixer the usual question stands.
 */
function retryBaseFixer(ctx: Ctx, reason: string): void {
  const u = ctx.state.run.base_update;
  if (u?.conflict === undefined || u.fixer_attempt_id === undefined || u.certificate !== undefined)
    return waitBaseRepair(ctx, reason);
  if (u.auto_retried === true || conflictFixStep(ctx, u) === undefined)
    return waitBaseRepair(ctx, reason, BASE_REPAIR_WAIT_MS);
  ctx.emit('BaseUpdateRecorded', { update: { ...u, auto_retried: true } });
  proceed(ctx, { kind: 'repair_base', mode: 'retry_fixer' }, 'base_conflict_retry');
}

export function waitBaseRepair(ctx: Ctx, reason: string, timeoutMs?: number): void {
  const due = timeoutMs === undefined ? undefined : ctx.now + timeoutMs;
  const qid = askHuman(ctx, 'refused', {
    step: ctx.state.current_step,
    attempt_id: null,
    body: `${reason}. Inspect the task worktree and resolve conflicts (or revert changes outside conflict files), then answer exactly "continue" to rerun gates and publish. For markerless conflicts, "continue" explicitly confirms the selected file versions. Answer exactly "retry fixer" to authorize another worker attempt instead. No automatic retry or budget/deadline reset.${due === undefined ? '' : ' Unanswered by the due time, the task fails.'}`,
    resume: { kind: 'repair_base', mode: 'manual' },
    detail: {
      reason,
      files: ctx.state.run.base_update?.conflict?.files ?? [],
      ...(due === undefined ? {} : { due_at: due }),
    },
  });
  // Bound to the question, not to the wait: a deadline or a source drift may hide it meanwhile.
  if (due !== undefined)
    ctx.emit('TimerArmed', {
      timer_id: ctx.nextId(),
      kind: 'wait_timeout',
      due_at: due,
      payload: { reason: `base_conflict_unresolved: ${reason}`, question_id: qid },
    });
}
