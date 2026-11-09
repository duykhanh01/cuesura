import { hasRole } from '../domain/policy.ts';
import {
  streakKey,
  type DetailCode,
  type Question,
  type ResumeAction,
  type TaskState,
} from '../domain/state.ts';
import type { Trigger } from '../domain/trigger.ts';
import type { Uuid } from '../shared/brand.ts';
import { available, consume, release, reserve } from './budget.ts';
import { reject, type Ctx } from './context.ts';
import { pastDeadline, proceed } from './interpreter.ts';
import { isPaused } from './pause.ts';
import { reachSafeBoundary } from './revision.ts';
import { mkWait, waitPolicy, waitTask } from './waits.ts';

export function askHuman(
  ctx: Ctx,
  code: DetailCode,
  o: {
    step: string | null;
    attempt_id: string | null;
    body: string;
    resume: ResumeAction;
    detail?: Record<string, unknown>;
  },
): string {
  const qid = ctx.nextId();
  ctx.emit('QuestionAsked', {
    question_id: qid,
    step: o.step,
    attempt_id: o.attempt_id,
    body: o.body,
    resume: o.resume,
  });
  waitTask(
    ctx,
    mkWait('human_input', code, {
      resume: o.resume,
      resume_when: [`answer(${qid})`],
      detail: { ...o.detail, question_id: qid },
    }),
  );
  return qid;
}

/** Who answered when the engine did, instead of asking a person (#247). */
export const AUTO_ACTOR = 'engine:auto';

/**
 * A stop no person needs to decide: the question is asked and answered at once by the engine, so the
 * answer reaches every later agent of the revision as a person's would, and the task resumes as on an
 * answer. A review-fix round answered this way gets one turn per streak (see {@link grantAnswerTurn}).
 */
export function answerForFixer(
  ctx: Ctx,
  code: DetailCode,
  o: {
    step: string;
    attempt_id: string | null;
    body: string;
    answer: string;
    resume: ResumeAction;
    detail?: Record<string, unknown>;
  },
): void {
  const qid = askHuman(ctx, code, o);
  onAnswer(ctx, { kind: 'answer', question_id: qid as Uuid, answer: o.answer }, AUTO_ACTOR);
}

export function requestApproval(
  ctx: Ctx,
  o: {
    kind: 'escalation' | 'merge';
    step: string;
    rung: number | null;
    head_sha: string | null;
    resume: ResumeAction;
  },
): void {
  const s = ctx.state;
  const open = Object.values(s.approvals).find(
    (a) =>
      a.status === 'requested' &&
      a.kind === o.kind &&
      a.step === o.step &&
      a.rung === o.rung &&
      a.revision === s.revision &&
      a.head_sha === o.head_sha,
  );
  const id = open?.id ?? ctx.nextId();
  if (open === undefined) {
    ctx.emit('ApprovalRequested', {
      approval_id: id,
      kind: o.kind,
      step: o.step,
      rung: o.rung,
      head_sha: o.head_sha,
      policy_hash: s.policy_ref?.hash ?? ctx.frozen.policy_hash,
    });
  }
  waitTask(
    ctx,
    mkWait('approval', o.kind, {
      resume: o.resume,
      resume_when: [`approve(${id})`],
      exit_paths: [`reject(${id})`, 'cancel'],
      detail: {
        approval_id: id,
        approval_kind: o.kind,
        step: o.step,
        rung: o.rung,
        head_sha: o.head_sha,
      },
    }),
  );
}

type AnswerTrigger = Extract<Trigger, { kind: 'answer' }>;

/** Who answered when the decider did; only {@link onDeciderRan} records it. */
export const DECIDER_ACTOR = 'agent:decider';
/** The waits a decider may end: its worker asked. Approvals and every other wait stay with a person. */
export const WORKER_WAITS: readonly string[] = [
  'agent_question',
  'agent_needs_context',
  'agent_blocked',
];

function waitsOnWorker(s: TaskState, questionId: string): boolean {
  return (
    s.status === 'WAITING' &&
    s.cancellation === null &&
    s.questions[questionId]?.status === 'open' &&
    s.wait?.detail['question_id'] === questionId &&
    WORKER_WAITS.includes(s.wait.detail.code)
  );
}

/**
 * Holds one agent run for the decider before it spawns, under the same limits as any attempt. It needs
 * a second run left for the worker its answer resumes; otherwise the question is the person's (issue #266).
 */
export function onDeciderStart(ctx: Ctx, t: Extract<Trigger, { kind: 'decider_start' }>): void {
  if (!waitsOnWorker(ctx.state, t.question_id))
    reject('invalid_trigger', { reason: 'question_not_waiting' });
  if (isPaused(ctx)) reject('invalid_trigger', { reason: 'task_paused' });
  if (available(ctx.state.budget) < 2) reject('invalid_trigger', { reason: 'no_agent_runs_left' });
  if (pastDeadline(ctx)) reject('invalid_trigger', { reason: 'task_deadline_passed' });
  reserve(ctx, t.attempt_id, t.attempt_id);
}

/**
 * One decider run ended. Its usage and reason are recorded whatever happened, in the same accept as the
 * answer. The answer applies only while the task still waits on this worker question, so it can never
 * override a person, a newer revision or a cancel. Its reservation is settled like an attempt's, except
 * that a run a person overtook (answered, cancelled, paused) gives its agent run back: the run has ended,
 * so nothing more can be spent under it, and the person's answer must not cost the worker its run.
 */
export function onDeciderRan(ctx: Ctx, t: Extract<Trigger, { kind: 'decider_ran' }>): void {
  const still = waitsOnWorker(ctx.state, t.question_id) && !isPaused(ctx);
  const applied = t.apply && t.decision !== null && still;
  ctx.emit('DeciderRan', {
    attempt_id: t.attempt_id,
    question_id: t.question_id,
    usage: t.usage,
    invoked: t.invoked,
    answer: t.decision?.answer ?? null,
    reason: t.decision?.reason ?? null,
    failure: t.failure,
    applied,
    at: ctx.now,
  });
  if (t.invoked && still) consume(ctx, t.attempt_id);
  else release(ctx, t.attempt_id);
  if (applied && t.decision !== null)
    onAnswer(
      ctx,
      {
        kind: 'answer',
        question_id: t.question_id,
        answer: `${t.decision.answer}\n\n${t.decision.note}`,
      },
      DECIDER_ACTOR,
    );
}

/**
 * An answer to `review_repeated` is the person's decision on what the fixer should do, and the engine
 * cannot read it, so a streak built on the old findings must not stop the fixer from ever seeing it
 * (issue #192). Only that question routes on a rejection. When the streak already asks for a raise, the
 * fixer gets one turn at its rung and one more quality failure asks again; a streak that still has tries
 * keeps them, so the answer never cuts tries the fixer had. Rung, floor, visits, budget and deadline still
 * apply. Recorded with the answer, so a restart before the fixer starts keeps the turn.
 */
function grantAnswerTurn(ctx: Ctx, q: Question, by: string): void {
  const auto = by === AUTO_ACTOR;
  const step = turnStep(ctx, q.resume, auto);
  if (step === undefined) return;
  const s = ctx.state;
  const streak = streakKey(step, s.rungs.by_step[step] ?? 0);
  if (s.failure_streaks[streak]?.escalate !== true) return;
  if (auto && s.auto_turns?.includes(streak) === true) return;
  ctx.emit('AnswerTurnGranted', {
    question_id: q.id,
    step,
    streak,
    quality_tries: ctx.frozen.limits.classes.quality_tries_per_rung - 1,
    ...(auto ? { auto: true as const } : {}),
  });
}

/** The fixer step an answer sends the task to, when it is a review-fix round. */
function turnStep(ctx: Ctx, resume: ResumeAction, auto: boolean): string | undefined {
  if (auto && resume.kind === 'enter_step') return resume.step;
  if (resume.kind !== 'route' || resume.outcome !== 'request_changes') return undefined;
  const { steps } = ctx.frozen.workflow;
  const next = steps[resume.step]?.next['request_changes'];
  const after = next === undefined ? undefined : steps[next];
  // A full-review task posts the verdict on its way to the fixer.
  return after?.kind === 'action' ? after.next['ok'] : next;
}

export function onAnswer(ctx: Ctx, t: AnswerTrigger, by: string = ctx.actor): void {
  const s = ctx.state;
  const q = s.questions[t.question_id];
  if (q === undefined || q.status === 'withdrawn')
    reject('question_not_open', { question_id: t.question_id });
  if (q.status === 'answered') {
    ctx.emit('AnswerRejected', {
      question_id: q.id,
      by,
      reason: 'already_answered',
    });
    return;
  }
  if (
    q.resume.kind === 'repair_base' &&
    !['continue', 'retry fixer'].includes(t.answer.trim().toLowerCase())
  )
    reject('invalid_trigger', {
      reason: 'base_repair_answer_must_be_continue_or_retry_fixer',
    });
  const resume =
    q.resume.kind === 'repair_base' && t.answer.trim().toLowerCase() === 'retry fixer'
      ? { ...q.resume, mode: 'retry_fixer' as const }
      : q.resume;
  ctx.emit('QuestionAnswered', {
    question_id: q.id,
    answer: t.answer,
    by,
  });
  grantAnswerTurn(ctx, q, by);
  const w = ctx.state.wait;
  if (ctx.state.status === 'WAITING' && w?.detail['question_id'] === q.id) {
    proceed(ctx, resume, `answer:${q.id}`);
    return;
  }
  // If another wait masks the question, replace its deferred action with the question resume action.
  const drift = ctx.state.source_drift;
  if (drift?.safe_boundary_reached && drift.prior_wait?.detail['question_id'] === q.id) {
    reachSafeBoundary(ctx, resume, null);
    return;
  }
  if (w?.reason === 'policy' && w.detail['code'] === 'deadline') {
    waitPolicy(ctx, 'deadline', resume, {
      deadline_at: ctx.state.deadline_at,
    });
  }
}

type ApprovalTrigger = Extract<Trigger, { kind: 'approve' | 'reject' }>;

/** Approvals must match task/revision and policy_hash for escalation, or head_sha for merge. */
export function onApprovalDecision(ctx: Ctx, t: ApprovalTrigger): void {
  const s = ctx.state;
  const a = s.approvals[t.approval_request_id];
  if (a === undefined || a.status !== 'requested' || a.revoked || a.revision !== s.revision) {
    reject('approval_mismatch', {
      approval_id: t.approval_request_id,
      reason: 'not_open',
    });
  }
  if (!hasRole(ctx.env.authz, 'operate') && !hasRole(ctx.env.authz, 'admin')) {
    reject('approval_mismatch', { approval_id: a.id, reason: 'no_authz' });
  }
  if (
    a.kind === 'merge' &&
    (t.head_sha === undefined || t.head_sha !== a.head_sha || t.head_sha !== s.head_sha)
  ) {
    reject('approval_mismatch', { approval_id: a.id, reason: 'head_sha' });
  }
  if (a.kind === 'escalation' && a.policy_hash !== s.policy_ref?.hash) {
    reject('approval_mismatch', { approval_id: a.id, reason: 'policy_hash' });
  }
  const waiting = s.status === 'WAITING' && s.wait?.detail['approval_id'] === a.id;
  if (t.kind === 'approve') {
    ctx.emit('ApprovalGranted', {
      approval_id: a.id,
      by: ctx.actor,
      head_sha: a.head_sha,
    });
    if (waiting) proceed(ctx, (s.wait as NonNullable<typeof s.wait>).resume, `approve:${a.id}`);
    return;
  }
  ctx.emit('ApprovalRejected', { approval_id: a.id, by: ctx.actor });
  if (!waiting) return;
  if (a.kind === 'merge' && a.step !== null) {
    proceed(ctx, { kind: 'route', step: a.step, outcome: 'rejected' }, `reject:${a.id}`);
    return;
  }
  waitPolicy(
    ctx,
    'escalation_rejected',
    { kind: 'none' },
    { approval_id: a.id, step: a.step, rung: a.rung },
  );
}
