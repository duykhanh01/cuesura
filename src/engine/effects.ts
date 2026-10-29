import {
  idemKey,
  isBusinessEffect,
  type EffectKind,
} from '../domain/effect.ts';
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
  /** ID đã lấy sẵn (khi phải biết trước, ví dụ để giữ chỗ ngân sách). */
  effect_id?: string;
};

export function findByIdemKey(ctx: Ctx, key: string): EffectMirror | undefined {
  return Object.values(ctx.state.effects).find((e) => e.idem_key === key);
}

/**
 * Phát `EffectRequested` với khoá idempotency `idemKey()` (FR-016). Khoá đã có trong state thì không phát
 * lần hai và trả effect cũ: kho có unique constraint trên `idem_key` (data-model.md "Effect").
 */
export function requestEffect(
  ctx: Ctx,
  spec: EffectSpec,
): { id: string; created: boolean } {
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

/** Effect đang chạy hoặc chưa rõ kết quả: chưa thể coi là xong (FR-017, FR-018). */
export function inFlight(e: EffectMirror): boolean {
  return e.status === 'started' || e.status === 'unknown';
}

/** Yêu cầu đối chiếu một effect `unknown` hoặc `started`; khoá theo ID effect gốc. */
export function requestReconcile(ctx: Ctx, target: EffectMirror): void {
  requestEffect(ctx, {
    kind: 'reconcile',
    logical_id: target.id,
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

/** Effect nghiệp vụ chưa xong: chặn ranh giới an toàn của source drift (FR-011). */
export function businessInFlight(
  effects: Record<string, EffectMirror>,
): EffectMirror[] {
  return Object.values(effects).filter(
    (e) => isBusinessEffect(e.kind) && inFlight(e),
  );
}
