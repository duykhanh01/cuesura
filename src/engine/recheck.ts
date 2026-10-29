import { hasRole } from '../domain/policy.ts';
import { FREEZE_PENDING_CODES } from './start.ts';
import type { Trigger } from '../domain/trigger.ts';
import { reject, type Ctx } from './context.ts';

/**
 * `recheck` (T062, FR-046.01–08). The engine only records that one bounded check was asked for and
 * checks it fits the task's state; the application service then does the single read (preflight, PR
 * observation or drain round) and submits what it found as ordinary facts. Nothing here resets a
 * schedule, a deadline or a budget, calls an agent, merges, or accepts a new head. A terminal task is
 * handled before this point: the signal is only logged (FR-046.08).
 *
 * - `config`: a task PENDING/needs_info on config_invalid/capability_missing reads the newest base and
 *   goes through preflight as a confirm would (FR-046.02);
 * - `observation`: a task with a PR is observed once; the automatic schedule is untouched (FR-046.03/05/06);
 * - `drain`: a paused drain after a merge proof may run one more bounded stop/reconcile round (FR-046.07).
 */

type RecheckTrigger = Extract<Trigger, { kind: 'recheck' }>;

export function onRecheck(ctx: Ctx, t: RecheckTrigger): void {
  const s = ctx.state;
  if (!hasRole(ctx.env.authz, 'operate') && !hasRole(ctx.env.authz, 'admin'))
    reject('invalid_trigger', { reason: 'operate_required' });
  switch (t.target) {
    case 'config': {
      const w = s.wait;
      const ok =
        s.status === 'PENDING' &&
        s.policy_ref === null &&
        w?.reason === 'needs_info' &&
        FREEZE_PENDING_CODES.includes(w.detail.code);
      if (!ok)
        reject('invalid_trigger', {
          reason: 'recheck_not_applicable',
          target: t.target,
        });
      break;
    }
    case 'observation':
      if (s.pr_ref === null || s.policy_ref === null)
        reject('invalid_trigger', {
          reason: 'recheck_not_applicable',
          target: t.target,
        });
      if (s.completion !== null)
        reject('invalid_trigger', {
          reason: 'completion_recorded',
          target: t.target,
        });
      break;
    case 'drain':
      if (s.completion === null || s.completion.finalized_at !== null)
        reject('invalid_trigger', {
          reason: 'recheck_not_applicable',
          target: t.target,
        });
      break;
    default: {
      const never: never = t.target;
      throw new Error(`unknown recheck target ${String(never)}`);
    }
  }
  ctx.emit('RecheckRequested', {
    request_id: ctx.env.dedup_key,
    target: t.target,
    at: ctx.now,
  });
}
