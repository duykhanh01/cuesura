import { idemKey, isBusinessEffect, type EffectKind } from '../domain/effect.ts';
import type { EffectMirror } from '../domain/state.ts';
import type { Ctx } from './context.ts';

export type EffectSpec = {
  kind: EffectKind;
  logical_id: string;
  step: string | null;
  attempt_id?: string | null;
  reservation_id?: string | null;
  target_effect_id?: string | null;
  request: Record<string, unknown>;

  effect_id?: string;
};

export function findByIdemKey(ctx: Ctx, key: string): EffectMirror | undefined {
  return Object.values(ctx.state.effects).find((e) => e.idem_key === key);
}

/** Reuse an existing effect with the same idempotency key; the store also enforces uniqueness. */
export function requestEffect(ctx: Ctx, spec: EffectSpec): { id: string; created: boolean } {
  const s = ctx.state;
  const key = idemKey(spec.kind, s.project, s.id, s.revision, spec.logical_id);
  const existing = findByIdemKey(ctx, key);
  if (existing) return { id: existing.id, created: false };
  const id = spec.effect_id ?? ctx.nextId();
  ctx.emit('EffectRequested', {
    effect_id: id,
    kind: spec.kind,
    idem_key: key,
    logical_id: spec.logical_id,
    step: spec.step,
    attempt_id: spec.attempt_id ?? null,
    reservation_id: spec.reservation_id ?? null,
    target_effect_id: spec.target_effect_id ?? null,
    request: spec.request,
  });
  return { id, created: true };
}

export function inFlight(e: EffectMirror): boolean {
  return e.status === 'started' || e.status === 'unknown';
}

/**
 * Reuse an open reconciliation probe. After all earlier probes finish, allocate the next key so an
 * effect lost again after requeueing always has a recovery probe.
 */
export function requestReconcile(
  ctx: Ctx,
  target: EffectMirror,
  o: { readonly afterRunning?: boolean } = {},
): void {
  const probes = Object.values(ctx.state.effects).filter(
    (e) => e.kind === 'reconcile' && e.target_effect_id === target.id,
  );
  if (probes.some((e) => e.status === 'pending')) return;
  // New evidence while a probe runs: that probe may already have read the old state, so one more is
  // queued; it is claimed only once the running one ended (`probe_running`).
  if (
    probes.some((e) => inFlight(e)) &&
    !(o.afterRunning === true && probes.every((e) => e.status !== 'unknown'))
  )
    return;
  requestEffect(ctx, {
    kind: 'reconcile',
    logical_id: probes.length === 0 ? target.id : `${target.id}:${probes.length}`,
    step: target.step,
    attempt_id: target.attempt_id,
    target_effect_id: target.id,
    request: {
      effect_id: target.id,
      kind: target.kind,
      idem_key: target.idem_key,
    },
  });
}

export function businessInFlight(effects: Record<string, EffectMirror>): EffectMirror[] {
  return Object.values(effects).filter((e) => isBusinessEffect(e.kind) && inFlight(e));
}
