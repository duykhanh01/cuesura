import { hasRole } from '../domain/policy.ts';
import type { DetailCode, ResumeAction } from '../domain/state.ts';
import type { Trigger } from '../domain/trigger.ts';
import { reject, type Ctx } from './context.ts';
import { proceed } from './interpreter.ts';
import { reachSafeBoundary } from './revision.ts';
import { mkWait, waitPolicy, waitTask } from './waits.ts';

/** Hỏi người: `QuestionAsked` + WAITING `human_input`; câu trả lời hợp lệ đầu tiên chạy `resume`. */
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
): void {
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
}

/** Yêu cầu approval của người: WAITING `approval` với `approval_kind` (research R-13). */
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

/** Câu trả lời hợp lệ đầu tiên thắng; câu sau nhận `AnswerRejected` (data-model "Câu hỏi"). */
export function onAnswer(ctx: Ctx, t: AnswerTrigger): void {
  const s = ctx.state;
  const q = s.questions[t.question_id];
  if (q === undefined || q.status === 'withdrawn')
    reject('question_not_open', { question_id: t.question_id });
  if (q.status === 'answered') {
    ctx.emit('AnswerRejected', {
      question_id: q.id,
      by: ctx.actor,
      reason: 'already_answered',
    });
    return;
  }
  ctx.emit('QuestionAnswered', {
    question_id: q.id,
    answer: t.answer,
    by: ctx.actor,
  });
  const w = ctx.state.wait;
  if (ctx.state.status === 'WAITING' && w?.detail['question_id'] === q.id) {
    proceed(ctx, q.resume, `answer:${q.id}`);
    return;
  }
  // Câu hỏi bị che bởi một lý do chờ khác (source drift, hạn): đổi việc được hoãn thành `resume` của câu hỏi.
  const drift = ctx.state.source_drift;
  if (
    drift?.safe_boundary_reached &&
    drift.prior_wait?.detail['question_id'] === q.id
  ) {
    reachSafeBoundary(ctx, q.resume, null);
    return;
  }
  if (w?.reason === 'policy' && w.detail['code'] === 'deadline') {
    waitPolicy(ctx, 'deadline', q.resume, {
      deadline_at: ctx.state.deadline_at,
    });
  }
}

type ApprovalTrigger = Extract<Trigger, { kind: 'approve' | 'reject' }>;

/**
 * Approval chỉ dùng được khi khớp task/revision và `policy_hash` (escalation, FR-021) hoặc `head_sha`
 * (merge, R-10). Không khớp → `approval_mismatch`.
 */
export function onApprovalDecision(ctx: Ctx, t: ApprovalTrigger): void {
  const s = ctx.state;
  const a = s.approvals[t.approval_request_id];
  if (
    a === undefined ||
    a.status !== 'requested' ||
    a.revoked ||
    a.revision !== s.revision
  ) {
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
    (t.head_sha === undefined ||
      t.head_sha !== a.head_sha ||
      t.head_sha !== s.head_sha)
  ) {
    reject('approval_mismatch', { approval_id: a.id, reason: 'head_sha' });
  }
  if (a.kind === 'escalation' && a.policy_hash !== s.policy_ref?.hash) {
    reject('approval_mismatch', { approval_id: a.id, reason: 'policy_hash' });
  }
  const waiting =
    s.status === 'WAITING' && s.wait?.detail['approval_id'] === a.id;
  if (t.kind === 'approve') {
    ctx.emit('ApprovalGranted', {
      approval_id: a.id,
      by: ctx.actor,
      head_sha: a.head_sha,
    });
    if (waiting)
      proceed(
        ctx,
        (s.wait as NonNullable<typeof s.wait>).resume,
        `approve:${a.id}`,
      );
    return;
  }
  ctx.emit('ApprovalRejected', { approval_id: a.id, by: ctx.actor });
  if (!waiting) return;
  if (a.kind === 'merge' && a.step !== null) {
    proceed(
      ctx,
      { kind: 'route', step: a.step, outcome: 'rejected' },
      `reject:${a.id}`,
    );
    return;
  }
  waitPolicy(
    ctx,
    'escalation_rejected',
    { kind: 'none' },
    { approval_id: a.id, step: a.step, rung: a.rung },
  );
}
