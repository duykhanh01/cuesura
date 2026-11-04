import type { Budget } from '../domain/state.ts';
import type { Usage } from '../domain/trigger.ts';
import type { Ctx } from './context.ts';

/** Available budget = limit - used - reserved. */
export function available(b: Budget): number {
  return b.agent_runs.limit === null
    ? Number.POSITIVE_INFINITY
    : b.agent_runs.limit - b.agent_runs.used - b.agent_runs.reserved;
}

export function reserve(ctx: Ctx, reservation_id: string, effect_id: string): void {
  ctx.emit('BudgetReserved', { reservation_id, effect_id, units: 1 });
}

function held(ctx: Ctx, reservation_id: string | null): reservation_id is string {
  return (
    reservation_id !== null && ctx.state.budget.reservations[reservation_id]?.status === 'held'
  );
}

export function consume(ctx: Ctx, reservation_id: string | null): void {
  if (held(ctx, reservation_id)) ctx.emit('BudgetConsumed', { reservation_id });
}

/**
 * Release only when execution is proven not to have started; unknown outcomes keep their
 * reservation.
 */
export function release(ctx: Ctx, reservation_id: string | null): void {
  if (held(ctx, reservation_id)) ctx.emit('BudgetReleased', { reservation_id });
}

/** Usage recorded for an attempt; missing data is `unavailable`, never zero (FR-024). */
export function usageOf(u: Usage | null | undefined): Usage {
  return u ?? { basis: 'unavailable' };
}
