import { type Backoff, type Limits } from '../domain/policy.ts';
import {
  counterKey,
  isTerminal,
  streakKey,
  type AttemptKind,
  type DetailCode,
  type EffectMirror,
  type ResumeAction,
} from '../domain/state.ts';
import type { FailureClass, FailureData } from '../domain/trigger.ts';
import { hashCanonical } from '../shared/hash.ts';
import { assertNever } from '../shared/assert-never.ts';
import { planBackoff } from './backoff.ts';
import { available } from './budget.ts';
import type { Ctx } from './context.ts';
import { pastDeadline, proceed } from './interpreter.ts';
import { askHuman } from './questions.ts';
import { mkWait, waitPolicy, waitTask } from './waits.ts';

/** Classes whose retries are counted per outage, not over the life of the task. */
const TRANSIENT_CLASSES: readonly FailureClass[] = ['infra', 'rate_limit'];

/**
 * Emits `RetryCountersCleared` for `step` when its transient counters are set and no failure was
 * classified on the step among the events emitted since `since`.
 */
export function clearRetryCounters(ctx: Ctx, step: string | null, since: number): void {
  // A finished task keeps its counters as history; nothing is retried any more.
  if (step === null || isTerminal(ctx.state.status)) return;
  const failed = ctx.events
    .slice(since)
    .some((ev) => ev.type === 'FailureClassified' && ev.payload.step === step);
  if (failed) return;
  const keys = TRANSIENT_CLASSES.map((c) => counterKey(step, c)).filter(
    (k) => ctx.state.class_counters[k] !== undefined,
  );
  if (keys.length > 0) ctx.emit('RetryCountersCleared', { step, counter_keys: keys });
}

/** Only these classes feed quality escalation (FR-019). */
export const QUALITY_CLASSES: readonly FailureClass[] = ['quality', 'invalid_output'];

export function countsTowardQuality(c: FailureClass): boolean {
  return QUALITY_CLASSES.includes(c);
}

type Recorded = { count: number; escalate: boolean };

/**
 * Emits `FailureClassified`. `class_counters` are keyed by `(step, class)`, and additionally by rung for
 * `invalid_output` and an agent's `timeout`, whose allowances are per rung. Quality classes also update the streak of
 * `(step, rung)`; the streak asks for escalation after two consecutive quality failures with the same
 * signature, after `quality_tries_per_rung` tries, or once invalid output has used its repair and fresh
 * session (FR-019, FR-020).
 */
export function recordFailure(
  ctx: Ctx,
  o: {
    step: string;
    attempt_id: string | null;
    class: FailureClass;
    signature: string | null;
    rung: number | null;
  },
): Recorded {
  const s = ctx.state;
  const c = ctx.frozen.limits.classes;
  const perRung = (o.class === 'invalid_output' || o.class === 'timeout') && o.rung !== null;
  const key = perRung ? counterKey(o.step, o.class, o.rung!) : counterKey(o.step, o.class);
  const count = (s.class_counters[key] ?? 0) + 1;
  let consecutive = count;
  let escalate = false;
  if (countsTowardQuality(o.class) && o.rung !== null) {
    const prev = s.failure_streaks[streakKey(o.step, o.rung)];
    consecutive =
      o.signature !== null && prev?.signature === o.signature ? prev.consecutive + 1 : 1;
    const tries = (prev?.quality_tries ?? 0) + 1;
    escalate =
      prev?.escalate === true ||
      tries >= c.quality_tries_per_rung ||
      (o.class === 'quality' && consecutive >= 2) ||
      (o.class === 'invalid_output' && count > c.invalid_output_repairs + c.invalid_output_fresh);
  }
  // An agent that ran out of turns or time again at this rung needs a stronger one, not a person (#247).
  if (o.class === 'timeout' && o.rung !== null) escalate = count > c.timeout_retries;
  ctx.emit('FailureClassified', {
    ...o,
    counter_key: key,
    count,
    consecutive,
    escalate,
  });
  return { count, escalate };
}

/**
 * Gate failures, review rejections and CI code failures count as quality failures of the most recent
 * agent step that changed the code (SPEC.md §9.3).
 */
export function recordCheckFailure(ctx: Ctx, signature: string | null): void {
  const s = ctx.state;
  const step = s.last_fix_step;
  if (step === null) return;
  const attemptId = s.current_attempt[step] ?? null;
  const attempt = attemptId === null ? undefined : s.attempts[attemptId];
  const rung = attempt?.rung ?? s.rungs.by_step[step] ?? 0;
  recordFailure(ctx, {
    step,
    attempt_id: attemptId,
    class: 'quality',
    signature,
    rung,
  });
}

type ReviewFinding = { severity: string; file?: string | undefined; msg: string };

export const isBlocking = (f: Pick<ReviewFinding, 'severity'>): boolean =>
  f.severity === 'critical' || f.severity === 'major';

/**
 * The files the review blocks on, so a rejection that comes back on the same files reads as the same
 * failure however the reviewer words it, and whatever minor findings it adds. A review without a
 * blocking finding falls back to the files of all its findings.
 */
export function reviewSignature(findings: readonly ReviewFinding[]): string | null {
  if (findings.length === 0) return null;
  const blocking = findings.filter(isBlocking);
  const files = (blocking.length > 0 ? blocking : findings).map((f) => f.file ?? '');
  // Code-unit order, independent of the host locale, so replay yields the same signature.
  const key = [...new Set(files)].sort();
  return `review:${hashCanonical(key).slice('sha256:'.length, 'sha256:'.length + 16)}`;
}

/**
 * The findings a review keeps when it has more than `max`: every blocking one first, then the others,
 * in the reviewer's order. Later checks read the blocking files from what was kept.
 */
export function keptFindings<F extends { severity: string }>(
  findings: readonly F[],
  max: number,
): F[] {
  if (findings.length <= max) return [...findings];
  const at = findings.map((f, i) => ({ f, i }));
  const blocking = at.filter(({ f }) => isBlocking(f)).slice(0, max);
  const others = at.filter(({ f }) => !isBlocking(f)).slice(0, max - blocking.length);
  return [...blocking, ...others].sort((a, b) => a.i - b.i).map(({ f }) => f);
}

/**
 * Files of blocking findings that the previous rejecting review of this revision also blocked on and
 * that no commit since touched: the fixer left them alone, so another fix round would only repeat.
 * Empty when there is no such review or the changed files are not known for it.
 */
export function untouchedRepeats(
  reviews: readonly {
    revision: number;
    valid: boolean;
    verdict: string;
    sha: string;
    findings: readonly ReviewFinding[];
  }[],
  revision: number,
  current: {
    findings: readonly ReviewFinding[];
    changed_since?: { sha: string; paths: readonly string[] } | undefined;
  },
): string[] {
  const prior = reviews.filter((r) => r.valid && r.revision === revision).at(-1);
  const changed = current.changed_since;
  if (prior?.verdict !== 'request_changes' || changed === undefined || changed.sha !== prior.sha)
    return [];
  const before = new Set(prior.findings.filter(isBlocking).map((f) => f.file ?? ''));
  const touched = new Set(changed.paths);
  const files = current.findings
    .filter(isBlocking)
    .map((f) => f.file ?? '')
    .filter((f) => f !== '' && before.has(f) && !touched.has(f));
  return [...new Set(files)].sort();
}

function invalidOutputKind(c: Limits['classes'], count: number): AttemptKind {
  if (count <= c.invalid_output_repairs) return 'repair';
  if (count <= c.invalid_output_repairs + c.invalid_output_fresh) return 'fresh_session';
  return 'retry';
}

/**
 * Applies the FR-019 table to a failed effect whose budget and attempt have already been settled. Class
 * limits apply together with the agent run cap and the task deadline; whichever is hit first stops.
 */
export function handleFailure(ctx: Ctx, e: EffectMirror, f: FailureData): void {
  const step = e.step as string;
  const agent = e.kind === 'start_agent';
  const attempt = agent && e.attempt_id !== null ? ctx.state.attempts[e.attempt_id] : undefined;
  const cls = f.failure_class;
  const r = recordFailure(ctx, {
    step,
    attempt_id: e.attempt_id,
    class: cls,
    signature: f.signature ?? null,
    rung: attempt?.rung ?? null,
  });
  const limits = ctx.frozen.limits;
  const retry = (kind: AttemptKind = 'retry'): ResumeAction =>
    agent
      ? { kind: 'start_attempt', step, attempt_kind: kind }
      : {
          kind: 'retry_effect',
          step,
          ...(e.base_update === undefined ? {} : { base_update: e.base_update }),
        };
  switch (cls) {
    case 'rate_limit':
      scheduleRetry(ctx, e, cls, limits.backoff.rate_limit, r.count, retry(), f.reset_at);
      return;
    case 'infra':
      if (limits.classes.infra_retries !== null && r.count > limits.classes.infra_retries) {
        waitPolicy(ctx, 'backoff_exhausted', retry(), {
          step,
          class: cls,
          count: r.count,
        });
        return;
      }
      scheduleRetry(ctx, e, cls, limits.backoff.infra, r.count, retry());
      return;
    case 'timeout':
      // Past its retries an agent goes up the ladder (the task fails beyond it); other effects ask.
      if (r.count <= limits.classes.timeout_retries || (agent && attempt !== undefined)) {
        proceed(ctx, retry(), 'timeout_retry');
        return;
      }
      askAbout(ctx, e, f, 'timeout', retry());
      return;
    case 'auth_config':
    case 'refused':
      askAbout(ctx, e, f, cls, retry());
      return;
    case 'invalid_output':
    case 'quality':
      if (!agent) {
        // GitHub refused the PR title/body (#249): the content is the cause, not the credentials.
        const code = e.kind === 'create_pr' ? 'publish_content_invalid' : 'effect_failed';
        askAbout(ctx, e, f, code, retry());
        return;
      }
      proceed(
        ctx,
        retry(cls === 'invalid_output' ? invalidOutputKind(limits.classes, r.count) : 'retry'),
        cls,
      );
      return;
    case 'unknown':
      // No blind replay: a person decides after looking at the effect.
      askAbout(ctx, e, f, 'effect_failed', retry());
      return;
    default:
      assertNever(cls);
  }
}

function scheduleRetry(
  ctx: Ctx,
  e: EffectMirror,
  cls: 'rate_limit' | 'infra',
  cfg: Backoff,
  count: number,
  resume: ResumeAction,
  resetAt?: number,
): void {
  const step = e.step as string;
  if (e.kind === 'start_agent' && available(ctx.state.budget) < 1) {
    waitPolicy(ctx, 'agent_runs_exhausted', resume, { step, class: cls });
    return;
  }
  if (pastDeadline(ctx)) {
    waitPolicy(ctx, 'deadline', resume, { deadline_at: ctx.state.deadline_at });
    return;
  }
  const plan = planBackoff(cfg, count, e.idem_key, ctx.now, resetAt);
  if (plan.kind === 'exhausted') {
    waitPolicy(ctx, 'backoff_exhausted', resume, {
      step,
      class: cls,
      count,
      reason: plan.reason,
    });
    return;
  }
  const timerId = ctx.nextId();
  ctx.emit('TimerArmed', {
    timer_id: timerId,
    kind: 'backoff',
    due_at: plan.due_at,
    payload: { step, resume },
  });
  waitTask(
    ctx,
    mkWait(
      cls === 'rate_limit' ? 'rate_limit' : 'infra',
      cls === 'rate_limit' ? 'rate_limited' : 'infra_backoff',
      {
        resume,
        resume_when: [`timer(${timerId})`],
        detail: {
          step,
          class: cls,
          count,
          timer_id: timerId,
          due_at: plan.due_at,
        },
      },
    ),
  );
}

function askAbout(
  ctx: Ctx,
  e: EffectMirror,
  f: FailureData,
  code: DetailCode,
  resume: ResumeAction,
): void {
  const step = e.step as string;
  askHuman(ctx, code, {
    step,
    attempt_id: e.attempt_id,
    body: `${e.kind} failed in step '${step}': ${f.failure_class}${f.message ? ` (${f.message})` : ''}`,
    resume,
    detail: { effect_id_failed: e.id, class: f.failure_class },
  });
}
