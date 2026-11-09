import { isTerminal } from '../domain/state.ts';
import type { Trigger } from '../domain/trigger.ts';
import { consume, release } from './budget.ts';
import { adoptingRemoteMerge, adoptRemoteMerge } from './base-update.ts';
import { invalidatePending } from './cancel.ts';
import { reject, type Ctx } from './context.ts';
import { mkWait } from './waits.ts';
import type { EffectMirror } from '../domain/state.ts';

/**
 * A remote head of the task branch that no operation of this task expected (FR-041.03, H01–H05). The
 * fact is kept with its expected/observed SHAs and provenance; green is withdrawn, every pending business
 * effect is invalidated (an enqueued publish included) and the task waits under policy `head_changed`.
 * Nothing here accepts the new head, moves an approval to it or writes the remote. Only the
 * reconciliation exits of FR-029 clear it; a late reviewer callback is not one of them.
 */

type HeadDriftTrigger = Extract<Trigger, { kind: 'head_drift' }>;

export function onHeadDrift(ctx: Ctx, t: HeadDriftTrigger): void {
  const s = ctx.state;
  if (s.runtime_ref === null) reject('invalid_trigger', { reason: 'not_runtime_task' });
  if (isTerminal(s.status) || s.completion !== null) {
    ctx.emit('SignalIgnored', {
      reason: s.completion !== null ? 'completion_recorded' : 'terminal',
      trigger_kind: t.kind,
    });
    return;
  }
  // A read made before the task moved to this very head (a late duplicate after the merge was published).
  if (t.source === 'observation' && t.observed !== null && t.observed === s.head_sha) {
    ctx.emit('SignalIgnored', {
      reason: 'head_is_current',
      trigger_kind: t.kind,
      detail: { observed: t.observed },
    });
    return;
  }
  if (adoptingRemoteMerge(s, t.observed)) {
    ctx.emit('SignalIgnored', {
      reason: 'base_update_in_progress',
      trigger_kind: t.kind,
      detail: { observed: t.observed },
    });
    return;
  }
  // Also for a drift already recorded on this head, so a task stuck before #110 recovers on its next read.
  if (adoptRemoteMerge(ctx, t)) return;
  const prior = s.run.head_drift;
  if (prior !== null && prior.observed === t.observed) {
    ctx.emit('SignalIgnored', {
      reason: 'head_drift_recorded',
      trigger_kind: t.kind,
      detail: { observed: t.observed },
    });
    return;
  }
  const drift = {
    expected: t.expected,
    observed: t.observed,
    source: t.source,
    evidence_ref: t.evidence_ref,
    at: ctx.now,
  };
  ctx.emit('HeadDriftRecorded', { drift });
  invalidatePending(ctx, 'head_changed', () => true);
  if (s.cancellation !== null) return;
  ctx.emit('TaskWaiting', {
    wait: mkWait('policy', 'head_changed', {
      resume: { kind: 'none' },
      resume_when: ['reconcile(head_changed)'],
      exit_paths: ['reconcile the branch (FR-029)', 'cancel'],
      detail: {
        expected: t.expected,
        observed: t.observed,
        source: t.source,
        evidence_ref: t.evidence_ref,
      },
    }),
  });
}

/** Under a recorded drift a late result is history only: settle its budget, route nothing. */
export function settleUnderDrift(ctx: Ctx, e: EffectMirror, invoked: boolean): void {
  if (e.kind !== 'start_agent') return;
  if (invoked) consume(ctx, e.reservation_id);
  else release(ctx, e.reservation_id);
}
