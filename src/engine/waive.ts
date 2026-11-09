import { hasRole } from '../domain/policy.ts';
import type { DetailCode } from '../domain/state.ts';
import type { Trigger } from '../domain/trigger.ts';
import { reject, type Ctx } from './context.ts';
import { failureSignature, latestGateFailure, latestRejection } from './failure-signature.ts';
import { onCiRecorded, requestPrBodyUpdate, proceed } from './interpreter.ts';
import { taskCiVerdict } from './merge-guard.ts';
import { gatesPass, reviewWaived, reviewWaivers, waiverScope } from './waivers.ts';

/** Waits that only a quality loop ran out into; a waiver of that loop's failure may clear them. */
const LOOP_WAITS: readonly DetailCode[] = [
  'loop_exhausted',
  'review_repeated',
  'fix_no_src_change',
  'ladder_exhausted',
  'rung_denied',
  'escalations_exhausted',
];

/** A CI step whose window ran out on a failing result also waits on that failure alone. */
const CI_WAITS: readonly DetailCode[] = [...LOOP_WAITS, 'ci_wait_exhausted'];

/** Outcomes that send a failure on to its fix steps. */
const FAILURE_OUTCOMES = ['fail', 'request_changes', 'code'];
/** Past the failing step, an action (posting the review) passes the failure on with `ok`. */
const PASS_ON_OUTCOMES = [...FAILURE_OUTCOMES, 'ok'];

/**
 * Whether the task waits, now, on the loop of the step whose evidence was waived: a quality limit at
 * that step or at a fix step its failure leads to. Any other wait (drift, approval, a deadline, a
 * pause) keeps blocking whatever was waived (FR-045).
 */
function blockedBy(ctx: Ctx, evidenceStep: string, waits = LOOP_WAITS): boolean {
  const s = ctx.state;
  const w = s.wait;
  if (
    s.status !== 'WAITING' ||
    w === null ||
    !waits.includes(w.detail.code) ||
    s.source_drift !== null ||
    s.cancellation !== null ||
    (s.pause ?? null) !== null
  )
    return false;
  const steps = ctx.frozen.workflow.steps;
  const loop = new Set([evidenceStep]);
  let frontier = [evidenceStep];
  for (let depth = 0; depth < 2; depth++) {
    const outcomes = depth === 0 ? FAILURE_OUTCOMES : PASS_ON_OUTCOMES;
    frontier = frontier.flatMap((x) =>
      outcomes.flatMap((o) => {
        const next = steps[x]?.next[o];
        return next === undefined || loop.has(next) ? [] : [next];
      }),
    );
    for (const x of frontier) loop.add(x);
  }
  const step = typeof w.detail['step'] === 'string' ? w.detail['step'] : s.current_step;
  return step !== null && loop.has(step);
}

/**
 * `task waive` (007, FR-045, R-20): records a waiver of one finding, gate or CI check within the scope
 * it has now. A task stopped by the quality loop of the waived evidence, which the waivers now fully
 * cover, goes on from there: a review counts as an approval, a gate step runs again and lets the
 * covered failure through, a CI step passes. Any other wait stays as it is.
 * With a PR open, its body is written again to list the waiver (FR-046).
 */
export function onWaive(ctx: Ctx, t: Extract<Trigger, { kind: 'waive' }>): void {
  if (!hasRole(ctx.env.authz, 'operate') && !hasRole(ctx.env.authz, 'admin'))
    reject('invalid_trigger', { reason: 'operate_required' });
  const s = ctx.state;
  const scope = waiverScope(s, ctx.frozen, t.target);
  if (!scope.ok) reject('invalid_trigger', { reason: scope.reason });
  ctx.emit('Waived', {
    waiver: {
      id: ctx.nextId(),
      target: t.target,
      scope: scope.scope,
      evidence: t.evidence,
      reason: ctx.env.authz?.reason ?? null,
      by: ctx.actor,
      turn_id: ctx.env.authz?.turn_id ?? null,
      revision: s.revision,
      signature: failureSignature(s).signature,
      at: ctx.now,
    },
  });
  requestPrBodyUpdate(ctx, null);
  const after = ctx.state;
  switch (t.target.kind) {
    case 'finding': {
      const review = latestRejection(after);
      const step = review === null ? undefined : after.attempts[review.attempt_id]?.step;
      // Only the review of the commit the task stands on can be taken as its approval.
      if (
        review === null ||
        step === undefined ||
        !blockedBy(ctx, step) ||
        review.sha !== after.run.checkpoint?.sha ||
        !reviewWaived(after, review)
      )
        return;
      ctx.emit('ReviewWaived', {
        attempt_id: review.attempt_id,
        head_sha: review.sha,
        waivers: reviewWaivers(after, review),
      });
      ctx.emit('TaskResumed', { reason: 'waived' });
      proceed(ctx, { kind: 'route', step, outcome: 'approve' });
      return;
    }
    case 'gate': {
      const g = latestGateFailure(after);
      if (g === null || !blockedBy(ctx, g.step)) return;
      const sg = ctx.frozen.gates.by_step[g.step];
      const failed = g.failed ?? [];
      const required =
        sg !== undefined && sg.required.length > 0 ? sg.required : failed.map((f) => f.gate);
      const results = failed.map((f) => ({ ...f, passed: false }));
      const blocking = required.filter((r) => results.some((f) => f.gate === r));
      if (blocking.length === 0 || !gatesPass(after, blocking, results).passed) return;
      ctx.emit('TaskResumed', { reason: 'waived' });
      proceed(ctx, { kind: 'enter_step', step: g.step });
      return;
    }
    case 'check': {
      const head = after.head_sha;
      const ci =
        head === null
          ? undefined
          : after.evidence.ci.findLast(
              (c) => c.valid && c.revision === after.revision && c.head_sha === head,
            );
      const step = Object.entries(ctx.frozen.workflow.steps).find(
        ([, d]) => d.kind === 'wait',
      )?.[0];
      if (ci === undefined || step === undefined || !blockedBy(ctx, step, CI_WAITS)) return;
      const covered = ci.required === undefined || ci.required.kind === 'covered';
      if (!covered || taskCiVerdict(after, ctx.frozen, ci).kind !== 'pass') return;
      ctx.emit('TaskResumed', { reason: 'waived' });
      // As a covered pass seen after the window ran out does (FR-043.11).
      onCiRecorded(ctx, step, ci.required);
      return;
    }
  }
}
