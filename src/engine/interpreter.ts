import type { z } from 'zod';
import { assertNever } from '../shared/assert-never.ts';
import { sameChoice } from '../domain/run-config.ts';
import { bindingName } from '../domain/policy.ts';
import { isTerminal, type AttemptKind, type EffectMirror, type ResumeAction } from '../domain/state.ts';
import {
  AgentDataSchema,
  AwaitCiDataSchema,
  CheckpointDataSchema,
  CreatePrDataSchema,
  FailureDataSchema,
  GateDataSchema,
  MergeDataSchema,
  PrepareDataSchema,
  PublishDataSchema,
  RerunDataSchema,
  ReviewDataSchema,
  StopDataSchema,
  type FailureData,
  type Trigger,
} from '../domain/trigger.ts';
import {
  branchMatches,
  evalPredicate,
  isAgentStep,
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
import { applyRaise, chooseRung } from './escalation.ts';
import { handleFailure, recordCheckFailure, reviewSignature } from './failure.ts';
import { ciVerdict, latestCi, mergeGuard, type GuardFailure } from './merge-guard.ts';
import { askHuman, requestApproval } from './questions.ts';
import { settleUnderDrift } from './head-drift.ts';
import { deferForDrift } from './revision.ts';
import { reusableReview, reviewInputDigest } from './review-evidence.ts';
import { confirmedChoices } from './run-config.ts';
import { ensureRunning, mkWait, waitPolicy, waitTask } from './waits.ts';

// ---------- Điều phối hành động ----------

/**
 * Điểm vào duy nhất để làm việc tiếp theo. Chặn theo thứ tự: task đã kết thúc; đang hủy (chỉ chờ effect
 * còn dở rồi kết thúc, FR-018); source drift (hoãn tới khi người chọn, FR-011); đã quá hạn (FR-023).
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
 * Đã quá hạn task: timer `deadline` đã bắn, hoặc `now` của tín hiệu đã vượt `deadline_at` dù timer chưa
 * kịp được xử lý (FR-023). Không được tạo việc mới trong cả hai trường hợp.
 */
export function pastDeadline(ctx: Ctx): boolean {
  const s = ctx.state;
  return s.deadline_passed || (s.deadline_at !== null && ctx.now >= s.deadline_at);
}

function execute(ctx: Ctx, action: ResumeAction): void {
  switch (action.kind) {
    case 'start_attempt':
      startAttempt(ctx, action.step, action.attempt_kind);
      return;
    case 'enter_step':
      enterStep(ctx, action.step, null);
      return;
    case 'run_step':
    case 'merge_check':
      runStep(ctx, action.step);
      return;
    case 'route':
      route(ctx, action.step, action.outcome);
      return;
    case 'retry_effect':
      enterStep(ctx, action.step, { step: action.step, outcome: 'retry' }, 'retry');
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

// ---------- Bước và transition ----------

function stepDef(ctx: Ctx, step: string): StepDef {
  const def = ctx.frozen.workflow.steps[step];
  if (def === undefined) throw new Error(`workflow không có bước '${step}'`);
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
  };
}

/** Outcome khi bước bị bỏ: coi như bước đã đạt. */
const SKIP_OUTCOME: Partial<Record<StepKind, string>> = {
  agent: 'done',
  review: 'approve',
  gate: 'pass',
  action: 'ok',
  prepare: 'ok',
  triage: 'ok',
};

function skip(ctx: Ctx, step: string, reason: 'when' | 'skip_when' | 'no_gates' | 'pr_exists' | 'prepared'): void {
  const def = stepDef(ctx, step);
  const outcome = SKIP_OUTCOME[def.kind] ?? 'ok';
  ctx.emit('StepSkipped', { step, kind: def.kind, reason, outcome });
  route(ctx, step, outcome);
}

/** Vào bước: xét `when`/`skip_when`, rồi `max_visits` (`StepExhausted` theo `on_exhausted`), rồi chạy. */
export function enterStep(
  ctx: Ctx,
  step: string,
  from: { step: string; outcome: string } | null,
  attemptKind: AttemptKind = 'initial',
): void {
  const def = stepDef(ctx, step);
  if (def.when !== undefined && !evalPredicate(def.when, facts(ctx, step))) return skip(ctx, step, 'when');
  if (def.skip_when !== undefined && evalPredicate(def.skip_when, facts(ctx, step))) return skip(ctx, step, 'skip_when');
  const visits = ctx.state.step_visits[step] ?? 0;
  const limit = visitLimit(ctx, step);
  if (limit !== null && visits >= limit) {
    const target = def.on_exhausted ?? 'escalate';
    ctx.emit('StepExhausted', { step, visits, target });
    goTarget(ctx, step, target, 'exhausted');
    return;
  }
  ctx.emit('StepEntered', { step, visit: visits + 1, from });
  runStep(ctx, step, attemptKind);
}

/** `max_visits` của bước cộng lượt admin đã cấp thêm qua amendment; `null` khi bước không giới hạn. */
export function visitLimit(ctx: Ctx, step: string): number | null {
  const max = stepDef(ctx, step).max_visits;
  return max === undefined ? null : max + (ctx.frozen.limits.extra_visits[step] ?? 0);
}

/** Đi theo `next[outcome]` của bước. */
export function route(ctx: Ctx, step: string, outcome: string, body?: string): void {
  const target = stepDef(ctx, step).next[outcome];
  if (target === undefined) throw new Error(`bước '${step}' không có transition '${outcome}'`);
  goTarget(ctx, step, target, outcome, body);
}

function goTarget(ctx: Ctx, from: string, target: string, outcome: string, body?: string): void {
  if (!isSpecialTarget(target)) {
    enterStep(ctx, target, { step: from, outcome });
    return;
  }
  const def = stepDef(ctx, from);
  if (target === 'escalate' && outcome === 'exhausted') {
    // Hết lượt: trả lời không mở lại được bước (architecture §5.4.1); chỉ amendment cấp thêm lượt.
    waitTask(
      ctx,
      mkWait('human_input', 'loop_exhausted', {
        resume: isAgentStep(def) ? { kind: 'start_attempt', step: from, attempt_kind: 'initial' } : { kind: 'enter_step', step: from },
        resume_when: [`amend(limits.extra_visits.${from})`],
        detail: { step: from, outcome, visits: ctx.state.step_visits[from] ?? 0 },
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
      askHuman(ctx, 'agent_question', { step: from, attempt_id: attempt, body: body ?? `Bước '${from}' cần thêm thông tin`, resume: again });
      return;
    case 'escalate':
      askHuman(ctx, 'loop_exhausted', {
        step: from,
        attempt_id: attempt,
        body: body ?? `Bước '${from}' dừng với '${outcome}'; cần người quyết định`,
        resume: again,
        detail: { step: from, outcome },
      });
      return;
    case 'retry':
      // Retry tự động là một lượt vào bước mới, nên bị `max_visits` chặn như mọi vòng khác (nguyên tắc III).
      enterStep(ctx, from, { step: from, outcome }, 'retry');
      return;
    case 'fail':
      closeOut(ctx);
      ctx.emit('TaskFailed', { reason: `${from}:${outcome}` });
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

/** Diễn giải một bước theo loại (research R-11). */
export function runStep(ctx: Ctx, step: string, attemptKind: AttemptKind = 'initial'): void {
  const def = stepDef(ctx, step);
  const s = ctx.state;
  const p = ctx.frozen;
  const visit = visitOf(ctx, step);
  switch (def.kind) {
    case 'triage': {
      // Đủ lượt cho mọi bước agent còn phải đi trước khi xét merge, không thì chờ người (FR-040).
      const need = agentRunsAhead(ctx, step);
      if (available(s.budget) < need) {
        waitPolicy(ctx, 'agent_runs_insufficient', { kind: 'route', step, outcome: 'ok' }, { needed: need, available: available(s.budget) });
        return;
      }
      route(ctx, step, 'ok');
      return;
    }
    case 'prepare':
      // Revision mới dùng lại worktree và diff hiện có (FR-040).
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
      if (reuseReview(ctx, step)) return;
      startAttempt(ctx, step, attemptKind);
      return;
    case 'gate': {
      const gates = p.gates.by_step[step];
      const run = gates?.run ?? [];
      if (run.length === 0) return skip(ctx, step, 'no_gates');
      if (waitForSlot(ctx, { kind: 'run_step', step })) return;
      requestEffect(ctx, {
        kind: 'run_gates',
        logical_id: `${step}#${visit}`,
        step,
        request: { gates: run.map((g) => ({ gate: g, cmd: p.gates.commands[g] ?? '' })), required: gates?.required ?? [] },
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
          const failing = c.by_check.filter((x) => x.class === 'code').map((x) => x.check).sort();
          recordCheckFailure(ctx, `ci:${failing.join(',')}`);
        }
        route(ctx, step, c.class);
        return;
      }
      askHuman(ctx, 'ci_unclassified', {
        step,
        attempt_id: null,
        body: `Check thất bại không khớp ci_rules nào: ${c.checks.join(', ')}`,
        // Người đã xem lỗi; câu trả lời được chuyển cho bước sửa code.
        resume: { kind: 'route', step, outcome: 'code' },
        detail: { checks: c.checks },
      });
      return;
    }
    case 'approval': {
      // Runtime (002): the user merges on GitHub; no approval request, auto approval or merge effect.
      if (externalConfirmation(ctx)) return waitForExternalMerge(ctx, step);
      // Merge vào protected branch luôn cần người duyệt, kể cả khi `auto_when` khớp (SPEC.md §14.2).
      const protectedTarget = p.protected_branches.some((b) => branchMatches(b, s.task.base_branch));
      if (!protectedTarget && def.auto_when !== undefined && evalPredicate(def.auto_when, facts(ctx, step))) {
        const id = ctx.nextId();
        ctx.emit('ApprovalRequested', { approval_id: id, kind: 'merge', step, rung: null, head_sha: s.head_sha, policy_hash: p.policy_hash });
        ctx.emit('ApprovalGranted', { approval_id: id, by: 'policy:auto_when', head_sha: s.head_sha });
        route(ctx, step, 'approved');
        return;
      }
      requestApproval(ctx, { kind: 'merge', step, rung: null, head_sha: s.head_sha, resume: { kind: 'route', step, outcome: 'approved' } });
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
      requestEffect(ctx, { kind: 'publish', logical_id: `${step}#${visit}`, step, request: publishRequest(ctx, visit) });
      return;
    case 'github.create_pr':
      if (s.pr_ref !== null) return skip(ctx, step, 'pr_exists');
      requestEffect(ctx, { kind: 'create_pr', logical_id: `${s.id}#${visit}`, step, request: { head_sha: s.head_sha, content_digest: s.run.content?.digest ?? null } });
      return;
    case 'github.rerun_failed': {
      const ci = s.head_sha === null ? undefined : latestCi(s, s.head_sha);
      const failed = (ci?.checks ?? []).filter((c) => c.state === 'failure').map((c) => c.name);
      requestEffect(ctx, { kind: 'rerun_ci', logical_id: `${s.head_sha ?? 'none'}#${visit}`, step, request: { head_sha: s.head_sha, checks: failed } });
      return;
    }
    case 'github.merge': {
      if (externalConfirmation(ctx)) return waitForExternalMerge(ctx, step);
      const g = mergeGuard(s, ctx.frozen);
      if (!g.ok) {
        onGuardFailure(ctx, step, g.code);
        return;
      }
      requestEffect(ctx, { kind: 'merge', logical_id: `${g.head_sha}#${visit}`, step, request: { head_sha: g.head_sha, pr_ref: s.pr_ref } });
      return;
    }
    case undefined:
      throw new Error(`bước action '${step}' thiếu action`);
    default:
      assertNever(def.action);
  }
}

/** Merge guard không đạt: không yêu cầu merge, task chờ theo research R-10. */
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
      askHuman(ctx, 'merge_not_done', { step, attempt_id: null, body: `Merge guard: ${code}`, resume: recheck, detail: { guard: code } });
      return;
    }
    case 'base_outdated':
      askHuman(ctx, 'base_outdated', {
        step,
        attempt_id: null,
        body: `Head ${ctx.state.head_sha ?? '?'} chưa chứa base tip; cần cập nhật branch trước khi merge`,
        resume: recheck,
        detail: { head_sha: ctx.state.head_sha },
      });
      return;
    case 'no_head':
    case 'review_missing':
    case 'approval_missing':
      askHuman(ctx, 'merge_not_done', { step, attempt_id: null, body: `Merge guard: ${code}`, resume: recheck, detail: { guard: code } });
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
 * Trước khi task kết thúc: huỷ timer còn hẹn và vô hiệu hoá mọi effect còn `pending`, kể cả effect phục vụ,
 * để không gì được claim trên một task đã kết thúc (FR-010).
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

/**
 * Số lượt agent tối thiểu còn phải chạy từ `step` theo các outcome thành công tới `complete`, bỏ qua bước
 * mà predicate cho biết sẽ bị bỏ (FR-040: đi lại Code → Review trước khi xét merge).
 */
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
    const skipped = (def.when !== undefined && !evalPredicate(def.when, f)) || (def.skip_when !== undefined && evalPredicate(def.skip_when, f));
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
  if (sp === undefined) throw new Error(`chính sách không có binding cho bước '${step}'`);
  const again: ResumeAction = { kind: 'start_attempt', step, attempt_kind: kind };
  if (waitForSlot(ctx, again)) return;
  // Điểm chung tạo attempt: mỗi lượt vào bước có tối đa một attempt. Lượt hiện tại đã có attempt (thử lại
  // sau câu trả lời, sau khi dừng, sau lỗi…) thì phải vào lại bước, nên luôn bị `max_visits` chặn.
  if (Object.values(s.attempts).filter((a) => a.step === step).length >= visitOf(ctx, step)) {
    enterStep(ctx, step, { step, outcome: 'resume' }, kind);
    return;
  }
  const choice = chooseRung(ctx, step, sp, again);
  if (choice === null) return;
  if (pastDeadline(ctx)) return waitPolicy(ctx, 'deadline', again, { deadline_at: s.deadline_at });
  if (available(s.budget) < 1) return waitPolicy(ctx, 'agent_runs_exhausted', again, { step });
  const rungIndex = choice.rung;
  const rung = sp.ladder[rungIndex] as (typeof sp.ladder)[number];
  // A binding outside the confirmed selection, worker or reviewer, needs a new confirmation, never a silent switch (M02).
  if (s.run.mode !== null && !confirmedChoices(s, sp.role).some((c) => sameChoice(c, rung.binding))) {
    return waitPolicy(ctx, 'run_config_unconfirmed', again, { step, binding: bindingName(rung.binding) });
  }
  applyRaise(ctx, step, sp, choice);

  const attemptId = ctx.nextId();
  const effectId = ctx.nextId();
  const reservationId = ctx.nextId();
  const n = Object.values(s.attempts).filter((a) => a.step === step).length + 1;
  ensureRunning(ctx, 'attempt');
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
  });
  const answers = Object.values(ctx.state.questions)
    .filter((q) => q.step === step && q.status === 'answered' && q.revision === s.revision)
    .map((q) => ({ question_id: q.id, answer: q.answer }));
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
    },
  });
}

// ---------- CI ----------

function requestAwaitCi(ctx: Ctx, step: string): void {
  const s = ctx.state;
  requestEffect(ctx, {
    kind: 'await_ci',
    logical_id: `${s.head_sha ?? 'none'}#${visitOf(ctx, step)}#${s.ci_polls + 1}`,
    step,
    request: { head_sha: s.head_sha, pr_ref: s.pr_ref, required_checks: ctx.frozen.ci.required_checks },
  });
}

/** Chờ CI thêm trong giới hạn `timeout / poll` lần hỏi; hết thì đi theo outcome `timeout` (R-10). */
function armCiPoll(ctx: Ctx, step: string, resume: ResumeAction, detail: Record<string, unknown>): void {
  const def = stepDef(ctx, step);
  const poll = def.poll ?? 60_000;
  const maxPolls = def.timeout !== undefined ? Math.max(1, Math.ceil(def.timeout / poll)) : 1;
  if (ctx.state.ci_polls >= maxPolls && ctx.state.current_step === step) {
    route(ctx, step, 'timeout');
    return;
  }
  const timerId = ctx.nextId();
  ctx.emit('TimerArmed', { timer_id: timerId, kind: 'ci_poll', due_at: ctx.now + poll, payload: { step, resume } });
  waitTask(
    ctx,
    mkWait('ci', 'checks_incomplete', { resume, resume_when: [`timer(${timerId})`], detail: { ...detail, timer_id: timerId } }),
  );
}

// ---------- Kết quả effect ----------

type EffectResultTrigger = Extract<Trigger, { kind: 'effect_result' }>;

function stepKindOf(ctx: Ctx, e: EffectMirror): StepKind | null {
  return e.step === null ? null : (ctx.frozen.workflow.steps[e.step]?.kind ?? null);
}

/** Schema thành công theo loại effect (contracts/signals-events.md "Kết quả effect"). */
export function parseSuccess(ctx: Ctx, e: EffectMirror, data: unknown): { ok: true; data: unknown } | { ok: false; issues: string[] } {
  const schema = (() => {
    switch (e.kind) {
      case 'start_agent':
        return stepKindOf(ctx, e) === 'review' ? ReviewDataSchema : AgentDataSchema;
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
  return r.success ? { ok: true, data: r.data } : { ok: false, issues: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
}

/** Tín hiệu `effect_result` (contracts/signals-events.md). */
export function onEffectResult(ctx: Ctx, t: EffectResultTrigger): void {
  const e = ctx.state.effects[t.effect_id];
  if (e === undefined) reject('invalid_trigger', { reason: 'unknown_effect', effect_id: t.effect_id });
  if (t.attempt_id !== undefined && t.attempt_id !== e.attempt_id) {
    reject('invalid_trigger', { reason: 'attempt_mismatch', effect_id: e.id });
  }
  if (e.status !== 'started') {
    ctx.emit('SignalIgnored', { reason: `effect_${e.status}`, trigger_kind: t.kind, detail: { effect_id: e.id } });
    return;
  }
  switch (t.outcome) {
    case 'unknown':
      ctx.emit('EffectCompleted', { effect_id: e.id, status: 'unknown', result: null });
      onEffectUnknown(ctx, e);
      return;
    case 'succeeded': {
      // Output agent sai schema vẫn là lượt đã chạy; nó thành lỗi `invalid_output` ở bước sau (FR-014).
      const parsed = parseSuccess(ctx, e, t.data);
      if (!parsed.ok && e.kind !== 'start_agent') reject('invalid_trigger', { reason: 'invalid_data', issues: parsed.issues });
      ctx.emit('EffectCompleted', { effect_id: e.id, status: 'succeeded', result: parsed.ok ? parsed.data : (t.data ?? null) });
      // A late result after a merge proof (e.g. a push that still landed) is recorded, never acted on.
      if (ctx.state.completion !== null) return;
      // Under a recorded head drift a result is history of its own operation (H01/H02): no route.
      if (ctx.state.run.head_drift !== null) return settleUnderDrift(ctx, e, (t.data as { invoked?: boolean } | undefined)?.invoked !== false);
      onEffectSucceeded(ctx, e, t.data);
      return;
    }
    case 'failed': {
      const f = FailureDataSchema.safeParse(t.data);
      if (!f.success) reject('invalid_trigger', { reason: 'invalid_failure', issues: f.error.issues.map((i) => i.message) });
      ctx.emit('EffectCompleted', { effect_id: e.id, status: 'failed', result: f.data });
      if (ctx.state.completion !== null) return;
      if (ctx.state.run.head_drift !== null) return settleUnderDrift(ctx, e, f.data.invoked !== false);
      onEffectFailed(ctx, e, f.data);
      return;
    }
    default:
      assertNever(t.outcome);
  }
}

/** Kết quả `unknown`: giữ chỗ, yêu cầu đối chiếu, không phát lại theo phỏng đoán (FR-017, FR-022). */
export function onEffectUnknown(ctx: Ctx, e: EffectMirror): void {
  requestReconcile(ctx, e);
  if (ctx.state.status === 'RUNNING' && ctx.state.cancellation === null) {
    ctx.emit('TaskWaiting', {
      wait: mkWait('infra', 'effect_unknown', { resume_when: [`reconcile(${e.id})`], detail: { effect_id: e.id, kind: e.kind } }),
    });
  }
}

/** Bỏ trạng thái chờ đối chiếu của chính effect này trước khi đi tiếp. */
function resumeIfWaitingOn(ctx: Ctx, e: EffectMirror): void {
  const w = ctx.state.wait;
  if (ctx.state.status === 'WAITING' && w?.detail['effect_id'] === e.id) ctx.emit('TaskResumed', { reason: `effect:${e.id}` });
}

/** Xử lý dữ liệu thành công (đã kiểm schema với effect không phải agent). Dùng chung với đối chiếu (R-17). */
export function onEffectSucceeded(ctx: Ctx, e: EffectMirror, data: unknown): void {
  resumeIfWaitingOn(ctx, e);
  const step = e.step;
  switch (e.kind) {
    case 'start_agent':
      onAgentOutput(ctx, e, data);
      return;
    case 'run_gates': {
      const d = GateDataSchema.parse(data);
      if (onGateTree(ctx, e, d)) return;
      const sg = ctx.frozen.gates.by_step[step as string];
      // Bước không khai `required` thì mọi gate đã chạy đều bắt buộc; không bao giờ đạt vì danh sách rỗng.
      const required = sg !== undefined && sg.required.length > 0 ? sg.required : (sg?.run ?? d.results.map((r) => r.gate));
      const passed = required.length > 0 && required.every((g) => d.results.some((r) => r.gate === g && r.passed));
      const failing = d.results.find((r) => !r.passed && required.includes(r.gate)) ?? d.results.find((r) => !r.passed);
      const signature = failing?.signature ?? null;
      ctx.emit('GateResultRecorded', {
        step: step as string,
        visit: visitOf(ctx, step as string),
        effect_id: e.id,
        results: d.results,
        passed,
        signature,
        resets_streak_of: passed ? ctx.state.last_fix_step : null,
      });
      if (!passed) recordCheckFailure(ctx, signature);
      if (passed && d.checkpoint === undefined && commitsCheckpoint(ctx, step as string)) {
        onEffectFailed(ctx, e, { failure_class: 'infra', message: 'gates passed without a checkpoint commit' });
        return;
      }
      if (passed && d.checkpoint !== undefined) recordCheckpoint(ctx, step as string, d.checkpoint);
      proceed(ctx, { kind: 'route', step: step as string, outcome: passed ? 'pass' : 'fail' });
      return;
    }
    case 'prepare': {
      const d = PrepareDataSchema.parse(data);
      if (!d.setup.passed) {
        onEffectFailed(ctx, e, { failure_class: 'infra', message: 'setup_failed' });
        return;
      }
      proceed(ctx, { kind: 'route', step: step as string, outcome: 'ok' });
      return;
    }
    case 'publish': {
      const d = PublishDataSchema.parse(data);
      ctx.emit('PublishRecorded', { head_sha: d.head_sha });
      ctx.emit('BaseRelationRecorded', { relation: d.base_relation });
      proceed(ctx, { kind: 'route', step: step as string, outcome: 'ok' });
      return;
    }
    case 'create_pr':
    case 'rerun_ci':
      proceed(ctx, { kind: 'route', step: step as string, outcome: 'ok' });
      return;
    case 'await_ci': {
      const d = AwaitCiDataSchema.parse(data);
      // CI of a PR that targets another branch is not recorded: it proves nothing for this target.
      if (d.target_ref !== undefined && d.target_ref !== ctx.state.task.base_branch) return waitTargetMismatch(ctx, step as string, d.target_ref, d.target_merged === true);
      const green = d.head_sha === ctx.state.head_sha && ciVerdict(ctx.frozen, d.required_set, d.checks).kind === 'pass';
      ctx.emit('CiResultRecorded', {
        head_sha: d.head_sha,
        required_set: d.required_set,
        checks: d.checks,
        resets_streak_of: green ? ctx.state.last_fix_step : null,
      });
      if (d.base_relation !== undefined) ctx.emit('BaseRelationRecorded', { relation: d.base_relation });
      onCiRecorded(ctx, step as string);
      return;
    }
    case 'merge': {
      const d = MergeDataSchema.parse(data);
      if (d.merged) {
        proceed(ctx, { kind: 'route', step: step as string, outcome: 'ok' });
        return;
      }
      if (ctx.state.cancellation !== null) return;
      askHuman(ctx, 'merge_not_done', { step, attempt_id: null, body: 'Merge chưa thực hiện', resume: { kind: 'merge_check', step: step as string } });
      return;
    }
    case 'stop_attempt': {
      // Attempt đã dừng: đối chiếu effect khởi chạy để biết nó kết thúc ra sao (FR-018).
      const target = e.target_effect_id === null ? undefined : ctx.state.effects[e.target_effect_id];
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

function onCiRecorded(ctx: Ctx, step: string): void {
  const s = ctx.state;
  if (s.cancellation !== null || isTerminal(s.status)) return proceed(ctx, { kind: 'none' });
  const head = s.head_sha;
  const ci = head === null ? undefined : latestCi(s, head);
  // Kết quả cho head khác head hiện hành không chứng minh gì cho head này: chờ tiếp.
  const verdict = ci === undefined ? null : ciVerdict(ctx.frozen, ci.required_set, ci.checks);
  if (verdict?.kind === 'pass') return proceed(ctx, { kind: 'route', step, outcome: 'pass' });
  if (verdict?.kind === 'fail') return proceed(ctx, { kind: 'route', step, outcome: 'fail' });
  if (s.source_drift !== null || pastDeadline(ctx)) return proceed(ctx, { kind: 'poll_ci', step });
  armCiPoll(ctx, step, { kind: 'poll_ci', step }, verdict === null ? { stale_head: true } : { missing: verdict.missing, not_passed: verdict.not_passed, complete: verdict.complete });
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
    waitTask(ctx, mkWait('policy', 'target_mismatch', { resume, resume_when: ['amend'], exit_paths: ['cancel'], detail }));
    return;
  }
  const exit_paths = [`retarget the PR to ${s.task.base_branch}`, 'cancel'];
  if (s.ci_polls >= maxPolls) {
    waitTask(ctx, mkWait('policy', 'target_mismatch', { resume, resume_when: ['amend'], exit_paths, detail }));
    return;
  }
  const timerId = ctx.nextId();
  ctx.emit('TimerArmed', { timer_id: timerId, kind: 'ci_poll', due_at: ctx.now + poll, payload: { step, resume } });
  waitTask(ctx, mkWait('policy', 'target_mismatch', { resume, resume_when: [`timer(${timerId})`, 'amend'], exit_paths, detail: { ...detail, timer_id: timerId } }));
}

/** Attempt của kết quả không còn là attempt hiện hành của bước: ghi nhận rồi bỏ qua (data-model "Attempt"). */
function isStale(ctx: Ctx, attemptId: string | null): boolean {
  if (attemptId === null) return true;
  const a = ctx.state.attempts[attemptId];
  return a === undefined || a.revision !== ctx.state.revision || ctx.state.current_attempt[a.step] !== attemptId;
}

function onAgentOutput(ctx: Ctx, e: EffectMirror, data: unknown): void {
  const step = e.step as string;
  const review = stepKindOf(ctx, e) === 'review';
  const parsed = (review ? ReviewDataSchema : AgentDataSchema).safeParse(data);
  const invoked = parsed.success ? parsed.data.invoked !== false : true;
  if (invoked) consume(ctx, e.reservation_id);
  else release(ctx, e.reservation_id);

  // FR-014: chỉ output đã kiểm tra schema mới làm qua bước.
  if (!parsed.success || !parsed.data.schema_checked) {
    onEffectFailed(ctx, e, { failure_class: 'invalid_output', message: parsed.success ? 'schema_checked=false' : 'output sai schema' }, true);
    return;
  }
  const d = parsed.data;
  const status = 'verdict' in d ? d.verdict : d.status;
  if (e.attempt_id !== null) {
    ctx.emit('AttemptFinished', { attempt_id: e.attempt_id, step, status, class: null, signature: null, usage: usageOf(d.usage) });
  }
  if (afterAttempt(ctx, e)) return;
  if (!('verdict' in d) && d.content !== undefined) {
    ctx.emit('PublishContentRecorded', { content: { revision: ctx.state.revision, digest: d.content.digest, ref: d.content.ref, attempt_id: e.attempt_id } });
  }
  if ('verdict' in d) {
    const approved = d.verdict === 'approve';
    const signature = approved ? null : reviewSignature(d.findings);
    const input = modeReview(ctx) ? reviewInputDigest(ctx.state, ctx.frozen, step) : null;
    // A mode-aware review approves the checkpoint commit and the input it was given, nothing else (M03).
    if (modeReview(ctx) && (input === null || d.head_sha !== ctx.state.run.checkpoint?.sha || d.input_digest !== input)) {
      onEffectFailed(ctx, e, { failure_class: 'invalid_output', message: 'review does not match the checkpoint it was given' }, true);
      return;
    }
    ctx.emit('ReviewVerdictRecorded', {
      step,
      attempt_id: e.attempt_id as string,
      verdict: d.verdict,
      head_sha: d.head_sha,
      signature,
      resets_streak_of: approved ? ctx.state.last_fix_step : null,
      ...(input === null ? {} : { input_digest: input, findings: d.findings.slice(0, MAX_FINDINGS) }),
    });
    if (!approved) recordCheckFailure(ctx, signature);
    proceed(ctx, { kind: 'route', step, outcome: d.verdict });
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
 * Sau khi attempt kết thúc: attempt cũ thì ghi `SignalIgnored(stale_attempt)`; attempt bị người dừng thì
 * chờ người. Trả `true` khi không được đi tiếp theo outcome.
 */
function afterAttempt(ctx: Ctx, e: EffectMirror): boolean {
  if (isStale(ctx, e.attempt_id)) {
    ctx.emit('SignalIgnored', { reason: 'stale_attempt', trigger_kind: ctx.env.trigger.kind, detail: { attempt_id: e.attempt_id } });
    return true;
  }
  const a = ctx.state.attempts[e.attempt_id as string];
  if (a?.stop_requested) {
    if (ctx.state.cancellation !== null) return true;
    askHuman(ctx, 'attempt_stopped', {
      step: a.step,
      attempt_id: a.id,
      body: `Attempt ${a.n} của bước '${a.step}' đã dừng theo yêu cầu`,
      resume: { kind: 'start_attempt', step: a.step, attempt_kind: 'fresh_session' },
    });
    return true;
  }
  return false;
}

/**
 * Failed effect: settles the reservation and the attempt, then applies the per-class handling of FR-019.
 */
export function onEffectFailed(ctx: Ctx, e: EffectMirror, f: FailureData, budgetSettled = false): void {
  resumeIfWaitingOn(ctx, e);
  const s = ctx.state;
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
    });
    if (afterAttempt(ctx, e)) return;
  }
  if (s.cancellation !== null || step === null || e.kind === 'stop_attempt' || e.kind === 'reconcile') {
    proceed(ctx, { kind: 'none' });
    return;
  }
  handleFailure(ctx, e, f);
}

// ---------- Execution modes (task-execution-modes.md) ----------

const MAX_FINDINGS = 50;

/** Review steps of a task started with a confirmed mode compare inputs and bind to the checkpoint. */
function modeReview(ctx: Ctx): boolean {
  return ctx.state.run.mode === 'full-review';
}

/**
 * Before calling the reviewer: an unchanged review input of this revision reuses the recorded verdict
 * (M03). An approval routes on without a reviewer run; unchanged findings go back to the fixer through
 * the same failure signature, so a no-progress loop is caught by the existing limits.
 */
function reuseReview(ctx: Ctx, step: string): boolean {
  if (!modeReview(ctx)) return false;
  const input = reviewInputDigest(ctx.state, ctx.frozen, step);
  if (input === null) return false;
  const prior = reusableReview(ctx.state, input);
  if (prior === undefined) return false;
  ctx.emit('ReviewReused', { step, from_attempt_id: prior.attempt_id, verdict: prior.verdict, input_digest: input });
  if (prior.verdict === 'request_changes') recordCheckFailure(ctx, prior.signature);
  route(ctx, step, prior.verdict);
  return true;
}

/** What publish pushes: the checkpoint commit, never whatever HEAD is at the time (M06). */
function publishRequest(ctx: Ctx, visit: number): Record<string, unknown> {
  const cp = ctx.state.run.checkpoint;
  if (ctx.state.run.mode === null || cp === null) return { checkpoint: visit };
  return { checkpoint: visit, sha: cp.sha, tree: cp.tree, base_sha: cp.base_sha, content_digest: ctx.state.run.content?.digest ?? cp.content_digest };
}

/**
 * Gate tree discipline of a mode-aware task (M06): a run whose tree did not hold still is not evidence,
 * and a passing run of the commit gate step must come with the checkpoint commit of that same tree.
 * Returns true when the result was handled here.
 */
function onGateTree(ctx: Ctx, e: EffectMirror, d: z.infer<typeof GateDataSchema>): boolean {
  if (ctx.state.run.mode === null) return false;
  const step = e.step as string;
  if (d.stable === false) {
    waitPolicy(ctx, 'gate_tree_unstable', { kind: 'run_step', step }, { step, tree: d.tree ?? null });
    return true;
  }
  if (d.checkpoint !== undefined && d.checkpoint.tree !== d.tree) {
    waitPolicy(ctx, 'worktree_changed', { kind: 'run_step', step }, { step, gate_tree: d.tree ?? null, checkpoint_tree: d.checkpoint.tree });
    return true;
  }
  return false;
}

/** The gate step whose pass leads to review or publish ends with the checkpoint commit in a mode task. */
export function commitsCheckpoint(ctx: Pick<Ctx, 'state' | 'frozen'>, step: string): boolean {
  if (ctx.state.run.mode === null) return false;
  const pass = ctx.frozen.workflow.steps[step]?.next['pass'];
  const next = pass === undefined ? undefined : ctx.frozen.workflow.steps[pass];
  return next?.kind === 'review' || next?.action === 'git.publish';
}

function recordCheckpoint(ctx: Ctx, step: string, c: z.infer<typeof CheckpointDataSchema>): void {
  ctx.emit('CheckpointRecorded', { checkpoint: { revision: ctx.state.revision, ...c, gate_visit: visitOf(ctx, step) } });
}
