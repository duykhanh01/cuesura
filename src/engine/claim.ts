import { isBusinessEffect, type EffectKind } from '../domain/effect.ts';
import { isTerminal, type TaskState } from '../domain/state.ts';

export type ClaimBlockReason =
  | 'stale_revision'
  | 'source_drift'
  | 'cancelling'
  | 'terminal'
  | 'deadline'
  | 'task_waiting'
  | 'legacy_task'
  | 'completion'
  | 'head_changed'
  | 'merge_evidence_incomplete'
  | 'run_config_unconfirmed'
  | 'probe_running';

/** The 002 daemon only dispatches tasks that carry a runtime snapshot; 001 callers keep the old rules. */
export type ClaimOptions = { require_runtime?: boolean };

export type Claimability = { ok: true } | { ok: false; reason: ClaimBlockReason };

export type ClaimTarget = { id: string; kind: EffectKind; revision: number };

/**
 * Claim and EffectStarted commit together. Service effects bypass business guards. Check the
 * claim-time deadline even if its timer has not fired yet.
 */
export function claimable(
  state: TaskState,
  effect: ClaimTarget,
  now: number,
  opts: ClaimOptions = {},
): Claimability {
  // A legacy task without a runtime snapshot is read-only for the 002 daemon, service effects included.
  if (opts.require_runtime === true && state.runtime_ref === null)
    return { ok: false, reason: 'legacy_task' };
  // One probe of an effect at a time: a follow-up probe waits until the earlier one has ended and been
  // reconciled itself. A probe left unknown may still have processes (a rerun gate it could not see
  // stopped); its own probe settles it first (FR-044.01).
  if (effect.kind === 'reconcile') {
    const target = state.effects[effect.id]?.target_effect_id ?? null;
    if (
      target !== null &&
      Object.values(state.effects).some(
        (e) =>
          e.id !== effect.id &&
          e.kind === 'reconcile' &&
          e.target_effect_id === target &&
          (e.status === 'started' || e.status === 'unknown'),
      )
    )
      return { ok: false, reason: 'probe_running' };
  }
  if (!isBusinessEffect(effect.kind)) return { ok: true };
  // A runtime task runs only the selection the user confirmed and froze at start (M01/M02).
  if (
    opts.require_runtime === true &&
    (state.run.frozen_digest === null || state.run.confirmation?.digest !== state.run.frozen_digest)
  ) {
    return { ok: false, reason: 'run_config_unconfirmed' };
  }
  // A recorded merge proof stops all business work; only stop/reconcile/observe may run (FR-040.02).
  if (state.completion !== null) return { ok: false, reason: 'completion' };
  if (isTerminal(state.status)) return { ok: false, reason: 'terminal' };
  // An unexpected remote head blocks every business effect, publishes already enqueued included (H02).
  if (state.run.head_drift !== null) return { ok: false, reason: 'head_changed' };
  // A merge GitHub reported without an accepted proof holds enqueued business effects until reconciled (FR-040.12).
  if (state.blockers.some((b) => b.code === 'merge_evidence_incomplete'))
    return { ok: false, reason: 'merge_evidence_incomplete' };
  if (state.cancellation !== null) return { ok: false, reason: 'cancelling' };
  if (effect.revision !== state.revision) return { ok: false, reason: 'stale_revision' };
  if (state.source_drift !== null) return { ok: false, reason: 'source_drift' };
  if (state.deadline_passed || (state.deadline_at !== null && now >= state.deadline_at)) {
    return { ok: false, reason: 'deadline' };
  }
  if (state.status === 'WAITING' && state.wait?.detail['effect_id'] !== effect.id) {
    return { ok: false, reason: 'task_waiting' };
  }
  return { ok: true };
}
