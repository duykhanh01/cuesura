import type { DetailCode, ResumeAction, Wait, WaitReason } from '../domain/state.ts';
import type { Ctx } from './context.ts';
import { businessInFlight } from './effects.ts';
import { reachSafeBoundary } from './revision.ts';

export function mkWait(
  reason: WaitReason,
  code: DetailCode,
  o: {
    resume?: ResumeAction;
    resume_when: string[];
    exit_paths?: string[];
    detail?: Record<string, unknown>;
  },
): Wait {
  return {
    reason,
    detail: { ...o.detail, code },
    resume_when: o.resume_when,
    exit_paths: o.exit_paths ?? ['cancel'],
    resume: o.resume ?? { kind: 'none' },
  };
}

/**
 * If a wait reaches a safe boundary during source drift, ask for a revision choice and retain the
 * new wait so continuing the old revision can restore it.
 */
export function waitTask(ctx: Ctx, wait: Wait): void {
  const drift = ctx.state.source_drift;
  if (drift !== null && businessInFlight(ctx.state.effects).length === 0) {
    reachSafeBoundary(ctx, drift.safe_boundary_reached ? drift.deferred : null, wait);
    return;
  }
  ctx.emit('TaskWaiting', { wait });
}

/** Only an admin amendment can reopen exhausted policy limits. */
export function waitPolicy(
  ctx: Ctx,
  code: DetailCode,
  resume: ResumeAction,
  detail: Record<string, unknown> = {},
): void {
  waitTask(ctx, mkWait('policy', code, { resume, resume_when: ['amend'], detail }));
}

export function ensureRunning(ctx: Ctx, reason: string): void {
  if (ctx.state.status === 'WAITING') ctx.emit('TaskResumed', { reason });
}
