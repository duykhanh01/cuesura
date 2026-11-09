import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from '../domain/runtime.ts';
import { isTerminal, type DetailCode, type ResumeAction, type Wait } from '../domain/state.ts';
import type { Trigger } from '../domain/trigger.ts';
import { canonicalJson } from '../shared/canonical-json.ts';
import { reject, type Ctx } from './context.ts';
import { ciSpent, onCiRecorded, proceed, waitCiExhausted } from './interpreter.ts';
import { ciVerdict, heldCi } from './merge-guard.ts';
import { mkWait, waitTask } from './waits.ts';

/**
 * PR observation of a runtime task (T058/T059, FR-041.01–08, FR-043.01–07/12/13, research R-04).
 *
 * The observation window opens with the first observation of the task's PR and is fixed from then on:
 * 30 days and 2,000 automatic rounds by default (the snapshot's limits). Each automatic round (`timer`
 * source) must carry the window's current generation, which then moves on, so two chains reading the
 * same round cannot both count; the next round is due 60 s × 2ⁿ later, capped at one hour, and a
 * changed remote digest only resets the cadence, never the window. A window that runs out while the
 * last observation shows the PR open on the task's own head is extended by a fresh window instead (#248):
 * nothing changed that needs a person, so watching goes on. A recheck observation is recorded and acted
 * on but neither counts nor moves the schedule; after expiry only a recheck observes.
 *
 * What an observation changes, and nothing else:
 * - `closed` (not merged): green is withdrawn, the task waits `policy/pr_closed`; no new PR, no business
 *   work while the PR stays closed (see `proceed`);
 * - `open` after `pr_closed`: the CI of the head is checked again within the execution limits;
 * - `unknown`: a wait on the PR becomes `infra/observation_unknown`, showing the last observation as
 *   history; the next readable observation restores it (FR-041.08);
 * - `open` with the head's CI: a waiting-for-merge task whose checks stopped passing, or whose GitHub
 *   requirement is no longer covered, goes back through the CI handling (FR-041.06, FR-042.04).
 * A changed head is a separate `head_drift` fact; a base tip change alone does nothing here (FR-041.04).
 */

type ObservationResult = Extract<Trigger, { kind: 'observation_result' }>;
type ObservationDue = Extract<Trigger, { kind: 'observation_due' }>;

function limitsOf(ctx: Ctx): RuntimeLimits {
  return ctx.state.run.limits ?? DEFAULT_RUNTIME_LIMITS;
}

/** Delay before the automatic round after `cadenceIndex` unchanged rounds: initial × factorⁿ, capped. */
export function cadenceDelay(
  l: Pick<RuntimeLimits, 'poll_initial_ms' | 'poll_factor' | 'poll_max_ms'>,
  cadenceIndex: number,
): number {
  let d = l.poll_initial_ms;
  for (let i = 0; i < cadenceIndex && d < l.poll_max_ms; i++) d *= l.poll_factor;
  return Math.min(d, l.poll_max_ms);
}

/** Waits an observation may replace; anything else (a question, the deadline, a drift) stays as it is. */
const PR_WAITS: readonly DetailCode[] = [
  'merge',
  'checks_incomplete',
  'ci_wait_exhausted',
  'required_checks_mismatch',
  'observation_unknown',
  'pr_closed',
  'target_mismatch',
  'merge_evidence_incomplete',
];

function prWait(ctx: Ctx): Wait | null {
  const s = ctx.state;
  if (s.status !== 'WAITING' || s.wait === null) return null;
  return PR_WAITS.includes(s.wait.detail.code) ? s.wait : null;
}

/** The CI wait step of the frozen graph. */
function ciStep(ctx: Ctx): string | null {
  return Object.entries(ctx.frozen.workflow.steps).find(([, d]) => d.kind === 'wait')?.[0] ?? null;
}

function cancelWaitTimer(ctx: Ctx, w: Wait): void {
  const id = w.detail['timer_id'];
  if (typeof id === 'string' && ctx.state.timers[id]?.status === 'armed')
    ctx.emit('TimerCancelled', { timer_id: id });
}

export function onObservationResult(ctx: Ctx, t: ObservationResult): void {
  const s = ctx.state;
  const o = t.observation;
  if (s.pr_ref === null) reject('invalid_trigger', { reason: 'no_pr' });
  if (o.subject.target_ref !== s.task.base_branch)
    reject('invalid_trigger', {
      reason: 'observation_target_mismatch',
      target: o.subject.target_ref,
    });
  if (s.observation !== null && canonicalJson(s.observation.subject) !== canonicalJson(o.subject))
    reject('invalid_trigger', { reason: 'observation_subject_mismatch' });
  const auto = o.source === 'timer';
  if (auto && s.observation !== null) {
    // A round of another chain, or one read before the window moved on, is history only (FR-043.05).
    if (s.observation.expired) return ignore(ctx, 'observation_expired', o.observation_id);
    if (o.generation !== s.observation.budget.generation)
      return ignore(ctx, 'stale_generation', o.observation_id);
  }
  const l = limitsOf(ctx);
  const prevDigest = s.observation?.budget.last_remote_digest ?? null;
  if (s.observation === null) {
    ctx.emit('ObservationScheduled', {
      subject: o.subject,
      started_at: ctx.now,
      deadline_at: ctx.now + l.observation_max_ms,
      max_count: l.observation_max_rounds,
      next_due_at: ctx.now,
      cadence_index: 0,
      generation: o.generation,
    });
  }
  ctx.emit('ExternalStateObserved', {
    observation: o,
    remote_digest: t.remote_digest,
    ...(t.target === undefined ? {} : { target: t.target }),
  });
  if (isTerminal(ctx.state.status) || ctx.state.completion !== null) return;
  // A merge keeps the schedule too: only an accepted merge proof stops observing (FR-041.01).
  if (auto) schedule(ctx, prevDigest !== t.remote_digest);
  // After expiry an observation (a recheck) only records evidence; a merge still completes (FR-046.06).
  if (ctx.state.observation?.expired === true) return;
  react(ctx, t);
}

function ignore(ctx: Ctx, reason: string, observationId: string): void {
  ctx.emit('SignalIgnored', {
    reason,
    trigger_kind: ctx.env.trigger.kind,
    detail: { observation_id: observationId },
  });
}

/** Moves the window to its next automatic round, or expires it (FR-043.04–06). */
function schedule(ctx: Ctx, changed: boolean): void {
  const ob = ctx.state.observation;
  if (ob === null) return;
  const spent = spentReason(ob.budget, ctx.now);
  if (spent !== null) {
    if (!extendable(ctx)) return expire(ctx, spent);
    extend(ctx, spent);
  }
  const b = (ctx.state.observation ?? ob).budget;
  const index = changed ? 0 : b.cadence_index + 1;
  const due = Math.min(ctx.now + cadenceDelay(limitsOf(ctx), index), b.deadline_at);
  ctx.emit('ObservationScheduled', {
    subject: ob.subject,
    started_at: b.started_at,
    deadline_at: b.deadline_at,
    max_count: b.max_count,
    next_due_at: due,
    cadence_index: index,
    generation: b.generation + 1,
  });
}

function spentReason(
  b: { count: number; max_count: number; deadline_at: number },
  now: number,
): 'deadline' | 'rounds' | null {
  if (b.count >= b.max_count) return 'rounds';
  if (now >= b.deadline_at) return 'deadline';
  return null;
}

/** The last observation shows the PR still open on the task's own head, with nothing pending on it. */
function extendable(ctx: Ctx): boolean {
  const s = ctx.state;
  const last = s.observation?.last ?? null;
  return (
    last !== null &&
    last.status === 'open' &&
    s.head_sha !== null &&
    last.observed_head === s.head_sha &&
    s.run.head_drift === null &&
    s.cancellation === null &&
    s.completion === null &&
    !isTerminal(s.status)
  );
}

/** A fresh window of the snapshot's limits from now; the rounds already counted stay counted. */
function extend(ctx: Ctx, reason: 'deadline' | 'rounds'): void {
  const ob = ctx.state.observation;
  if (ob === null) return;
  const l = limitsOf(ctx);
  ctx.emit('ObservationExtended', {
    at: ctx.now,
    reason,
    deadline_at: ctx.now + l.observation_max_ms,
    max_count: ob.budget.count + l.observation_max_rounds,
  });
}

/**
 * The CI wait stopped polling while its reads backed the window's cadence off to the cap; the observation
 * alone now watches the PR, so its next round comes at the first cadence step (#209). Counts nothing.
 */
export function restartCadence(ctx: Ctx): void {
  const ob = ctx.state.observation;
  if (ob === null || ob.expired) return;
  const b = ob.budget;
  const due = Math.min(ctx.now + cadenceDelay(limitsOf(ctx), 0), b.deadline_at);
  if (b.next_due_at === null || b.next_due_at <= due) return;
  ctx.emit('ObservationScheduled', {
    subject: ob.subject,
    started_at: b.started_at,
    deadline_at: b.deadline_at,
    max_count: b.max_count,
    next_due_at: due,
    cadence_index: 0,
    generation: b.generation,
  });
}

/**
 * The window is spent: no more automatic rounds. A task waiting on its PR now waits
 * `policy/observation_expired` and keeps the wait it had as history; only a recheck observes again.
 */
function expire(ctx: Ctx, reason: 'deadline' | 'rounds'): void {
  const s = ctx.state;
  ctx.emit('ObservationExpired', { at: ctx.now, reason });
  if (isTerminal(s.status) || s.completion !== null || s.cancellation !== null) return;
  const w = s.status === 'WAITING' ? s.wait : null;
  if (
    w === null ||
    w.detail.code === 'merge_cleanup_pending' ||
    w.detail.code === 'observation_expired'
  )
    return;
  if (w.detail.code === 'checks_incomplete' || w.detail.code === 'source_drift') return;
  cancelWaitTimer(ctx, w);
  waitObservationExpired(ctx, w);
}

export function waitObservationExpired(ctx: Ctx, prior: Wait | null): void {
  const b = ctx.state.observation?.budget;
  ctx.emit('TaskWaiting', {
    wait: mkWait('policy', 'observation_expired', {
      resume: { kind: 'none' },
      resume_when: ['recheck(observation)'],
      exit_paths: ['recheck', 'merge the PR on GitHub, then recheck', 'cancel'],
      detail: {
        last_observation: ctx.state.observation?.last ?? null,
        deadline_at: b?.deadline_at ?? null,
        rounds: b?.count ?? null,
        max_rounds: b?.max_count ?? null,
        ...(prior !== null ? { prior_wait: prior } : {}),
      },
    }),
  });
}

/** `observation_due` from the daemon: expires a window whose deadline or round cap passed without I/O. */
export function onObservationDue(ctx: Ctx, t: ObservationDue): void {
  const ob = ctx.state.observation;
  if (ob === null) reject('invalid_trigger', { reason: 'no_observation' });
  if (t.subject !== undefined && canonicalJson(t.subject) !== canonicalJson(ob.subject))
    reject('invalid_trigger', { reason: 'observation_subject_mismatch' });
  if (ob.expired || ctx.state.completion !== null)
    return ignore(ctx, ob.expired ? 'observation_expired' : 'completion_recorded', '');
  const b0 = ob.budget;
  const spent = ctx.now >= b0.deadline_at ? 'deadline' : b0.count >= b0.max_count ? 'rounds' : null;
  if (spent === null) return ignore(ctx, 'not_due', '');
  if (!extendable(ctx)) return expire(ctx, spent);
  // No read happens here, so the fresh window starts with a round now that checks the PR again.
  extend(ctx, spent);
  const b = (ctx.state.observation ?? ob).budget;
  ctx.emit('ObservationScheduled', {
    subject: ob.subject,
    started_at: b.started_at,
    deadline_at: b.deadline_at,
    max_count: b.max_count,
    next_due_at: ctx.now,
    cadence_index: b.cadence_index,
    generation: b.generation,
  });
}

/** The PR is closed without a merge: wait for a person, with no new PR and no business work (FR-041.07). */
export function waitPrClosed(ctx: Ctx, resume: ResumeAction): void {
  const s = ctx.state;
  waitTask(
    ctx,
    mkWait('policy', 'pr_closed', {
      resume,
      resume_when: ['observation(reopened)', 'recheck(observation)'],
      exit_paths: ['reopen the PR on GitHub', 'cancel'],
      detail: {
        pr_ref: s.pr_ref,
        head_sha: s.head_sha,
        observed_at: s.observation?.last?.observed_at ?? null,
      },
    }),
  );
}

/** GitHub reports a merge whose proof is missing or contradicts the task: wait for reconciliation, never DONE (FR-040.12). */
export function waitMergeEvidence(ctx: Ctx, resume: ResumeAction): void {
  const s = ctx.state;
  waitTask(
    ctx,
    mkWait('policy', 'merge_evidence_incomplete', {
      resume,
      resume_when: ['observation(merge proof)', 'recheck(observation)'],
      exit_paths: ['recheck once GitHub shows the merge in full', 'cancel'],
      detail: {
        pr_ref: s.pr_ref,
        head_sha: s.head_sha,
        last_observation: s.observation?.last ?? null,
      },
    }),
  );
}

function react(ctx: Ctx, t: ObservationResult): void {
  const s = ctx.state;
  if (s.cancellation !== null || s.run.head_drift !== null) return;
  const w = prWait(ctx);
  const step = ciStep(ctx);
  const recheckCi: ResumeAction = step === null ? { kind: 'none' } : { kind: 'poll_ci', step };
  // A PR that targets another branch: nothing it shows counts for the task's target (FR-041.05).
  if (t.target !== undefined && t.target.ref !== s.task.base_branch)
    return onTargetMismatch(ctx, w, recheckCi, t.target);
  // Merged into another branch is final: no later read moves the task (FR-040.12).
  if (w?.detail.code === 'target_mismatch' && w.detail['merged'] === true) return;
  switch (t.observation.status) {
    case 'merged':
      // A merge with incomplete evidence holds the task for reconciliation; a complete one is followed by
      // its proof. A running attempt finishes; its callback is held by `proceed` (FR-040.12).
      if (
        t.observation.completeness.merge_proof ||
        w === null ||
        w.detail.code === 'merge_evidence_incomplete'
      )
        return;
      cancelWaitTimer(ctx, w);
      waitMergeEvidence(ctx, w.resume.kind === 'none' ? recheckCi : w.resume);
      return;
    case 'closed':
      if (w === null || w.detail.code === 'pr_closed') return;
      cancelWaitTimer(ctx, w);
      waitPrClosed(ctx, recheckCi);
      return;
    case 'unknown':
      if (
        w === null ||
        w.detail.code === 'observation_unknown' ||
        w.detail.code === 'checks_incomplete'
      )
        return;
      ctx.emit('TaskWaiting', {
        wait: mkWait('infra', 'observation_unknown', {
          resume: { kind: 'none' },
          resume_when: ['observation'],
          detail: {
            source: 'observation',
            last_observation: lastReadable(ctx),
            prior_wait: w,
          },
        }),
      });
      return;
    case 'open': {
      if (w?.detail.code === 'pr_closed') {
        proceed(ctx, w.resume.kind === 'none' ? recheckCi : w.resume, 'pr_reopened');
        return;
      }
      // Retargeted back to the task's target: the CI of the head is checked again, within its window.
      if (w?.detail.code === 'target_mismatch') {
        cancelWaitTimer(ctx, w);
        proceed(ctx, w.resume.kind === 'none' ? recheckCi : w.resume, 'pr_retargeted');
        return;
      }
      if (w?.detail.code === 'observation_unknown' && w.detail['source'] === 'observation') {
        const prior = w.detail['prior_wait'] as Wait | undefined;
        if (prior !== undefined) ctx.emit('TaskWaiting', { wait: prior });
      }
      onOpenCi(ctx, t, step);
      return;
    }
    default: {
      const never: never = t.observation.status;
      throw new Error(`unknown observation status ${String(never)}`);
    }
  }
}

/**
 * The PR targets another branch than the snapshot (FR-041.05): WAITING/policy `target_mismatch`, withdrawing
 * green. While open, the observation keeps reading it and retargeting back resumes the CI check; merged
 * into the other branch it waits for a person, never DONE (FR-040.12). The CI wait's own poll owns
 * `checks_incomplete`; an equal wait already held is left as it is.
 */
function onTargetMismatch(
  ctx: Ctx,
  w: Wait | null,
  resume: ResumeAction,
  target: { ref: string; merged: boolean },
): void {
  const s = ctx.state;
  if (w === null || w.detail.code === 'checks_incomplete') return;
  if (
    w.detail.code === 'target_mismatch' &&
    w.detail['observed'] === target.ref &&
    w.detail['merged'] === target.merged
  )
    return;
  cancelWaitTimer(ctx, w);
  const detail = {
    step: resume.kind === 'poll_ci' ? resume.step : null,
    expected: s.task.base_branch,
    observed: target.ref,
    merged: target.merged,
    source: 'observation',
  };
  waitTask(
    ctx,
    target.merged
      ? mkWait('policy', 'target_mismatch', {
          resume,
          resume_when: ['amend'],
          exit_paths: ['cancel'],
          detail,
        })
      : mkWait('policy', 'target_mismatch', {
          resume,
          resume_when: ['observation', 'recheck(observation)', 'amend'],
          exit_paths: [`retarget the PR to ${s.task.base_branch}`, 'cancel'],
          detail,
        }),
  );
}

/** The last observation that read the remote, shown as history while reads fail (FR-043.12). */
function lastReadable(ctx: Ctx): unknown {
  return ctx.state.observation?.last ?? null;
}

/**
 * CI of an open PR read by the observation, for the head this task published. Recorded only when it
 * differs from the evidence already held, so an idle PR does not grow the log. Waiting for merge, a
 * check that no longer passes or a requirement no longer covered withdraws green and goes through the
 * CI handling; waiting on a mismatch or after the CI window ran out, a covered pass returns to the
 * merge wait (FR-043.11).
 */
function onOpenCi(ctx: Ctx, t: ObservationResult, step: string | null): void {
  const s = ctx.state;
  const ci = t.ci;
  if (ci === undefined || step === null || s.head_sha === null || ci.head_sha !== s.head_sha)
    return;
  const code = s.status === 'WAITING' ? (s.wait?.detail.code ?? null) : null;
  if (code !== 'merge' && code !== 'required_checks_mismatch' && code !== 'ci_wait_exhausted')
    return;
  const same = heldCi(s, ci);
  const required = ci.required;
  const covered = required === undefined || required.kind === 'covered';
  if (same && covered && code === 'merge') return;
  if (!same)
    ctx.emit('CiResultRecorded', {
      head_sha: ci.head_sha,
      required_set: ci.required_set,
      checks: ci.checks,
      ...(ci.required === undefined ? {} : { required: ci.required }),
      resets_streak_of: null,
    });
  // Still not covered while already waiting on it: nothing changed for the task.
  if (code === 'required_checks_mismatch' && !covered) return;
  const pass = covered && ciVerdict(ctx.frozen, ci.required_set, ci.checks).kind === 'pass';
  if (code === 'merge' && pass) return;
  if (code === 'ci_wait_exhausted' && !pass) return;
  // The head's CI window is spent: anything short of a covered pass is evidence only, never a fix or a
  // new poll (FR-043.08); a covered pass moves to the merge wait (FR-043.11).
  if (!pass && ciSpent(ctx, step))
    return waitCiExhausted(ctx, step, { kind: 'poll_ci', step }, { withdrawn: code });
  ctx.emit('TaskResumed', { reason: 'observation' });
  onCiRecorded(ctx, step, required);
}
