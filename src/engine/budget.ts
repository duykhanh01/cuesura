import type { Budget } from '../domain/state.ts';
import type { Ctx } from './context.ts';

/** "Khả dụng = `limit − used − reserved`" (data-model.md "Ngân sách"). */
export function available(b: Budget): number {
  return b.agent_runs.limit - b.agent_runs.used - b.agent_runs.reserved;
}

/** Giữ chỗ một lượt trước khi yêu cầu `start_agent` (FR-022). */
export function reserve(ctx: Ctx, reservation_id: string, effect_id: string): void {
  ctx.emit('BudgetReserved', { reservation_id, effect_id, units: 1 });
}

function held(ctx: Ctx, reservation_id: string | null): reservation_id is string {
  return reservation_id !== null && ctx.state.budget.reservations[reservation_id]?.status === 'held';
}

/** `held → consumed`: agent đã thật sự được gọi. */
export function consume(ctx: Ctx, reservation_id: string | null): void {
  if (held(ctx, reservation_id)) ctx.emit('BudgetConsumed', { reservation_id });
}

/** `held → released`: chắc chắn agent chưa chạy. Kết quả `unknown` không đi qua đây (FR-022). */
export function release(ctx: Ctx, reservation_id: string | null): void {
  if (held(ctx, reservation_id)) ctx.emit('BudgetReleased', { reservation_id });
}
