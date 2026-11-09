import {
  bindingName,
  compareLevel,
  levelKey,
  type Level,
  type StepPolicy,
} from '../domain/policy.ts';
import { sameChoice } from '../domain/run-config.ts';
import { streakKey, type ResumeAction, type TaskState } from '../domain/state.ts';
import type { Ctx } from './context.ts';
import { failWithDraft } from './interpreter.ts';
import { requestApproval } from './questions.ts';
import { confirmedChoices } from './run-config.ts';
import { waitPolicy } from './waits.ts';

export type RaiseReason = 'quality' | 'floor';

export type RungChoice = {
  rung: number;
  raise: {
    from: number;
    to: number;
    reason: RaiseReason;
    signature: string | null;
  } | null;
};

/** Ladder index the task floor maps to on this step's ladder, never past its last rung (research R-18). */
export function floorRung(sp: StepPolicy, floor: Level | null): number {
  if (floor === null) return 0;
  const mapped = sp.floor_map[levelKey(floor)];
  if (mapped !== undefined) return mapped;
  const idx = sp.ladder.findIndex((r) => compareLevel(r.level, floor) >= 0);
  return idx >= 0 ? idx : sp.ladder.length - 1;
}

/**
 * Target rung = `max(rung[step], floor_map[step][floor_level], proposed)`, where `proposed` is the next rung
 * once the failure streak at the current rung asks for escalation (FR-020, research R-18).
 */
export function targetRung(s: TaskState, sp: StepPolicy, step: string): RungChoice {
  const current = s.rungs.by_step[step] ?? 0;
  const streak = s.failure_streaks[streakKey(step, current)];
  const proposed = streak?.escalate === true ? current + 1 : current;
  const floor = floorRung(sp, s.rungs.floor_level);
  const rung = Math.max(current, floor, proposed);
  if (rung === current) return { rung, raise: null };
  const reason: RaiseReason = proposed === rung ? 'quality' : 'floor';
  return {
    rung,
    raise: {
      from: current,
      to: rung,
      reason,
      signature: reason === 'quality' ? (streak?.signature ?? null) : null,
    },
  };
}

export function hasEscalationApproval(ctx: Ctx, step: string, rung: number): boolean {
  const s = ctx.state;
  return Object.values(s.approvals).some(
    (a) =>
      a.kind === 'escalation' &&
      a.status === 'granted' &&
      !a.revoked &&
      a.revision === s.revision &&
      a.step === step &&
      a.rung === rung &&
      a.policy_hash === s.policy_ref?.hash,
  );
}

/** A binding outside the confirmed selection, worker or reviewer, is never switched to silently (M02). */
function unconfirmed(s: TaskState, sp: StepPolicy, rung: StepPolicy['ladder'][number]): boolean {
  return (
    s.run.mode !== null && !confirmedChoices(s, sp.role).some((c) => sameChoice(c, rung.binding))
  );
}

function escalationsExhausted(s: TaskState, choice: RungChoice): boolean {
  const esc = s.budget.escalations;
  return choice.raise !== null && esc.limit !== null && esc.used >= esc.limit;
}

/** Whether {@link chooseRung} would pick a rung without opening a wait or asking for an approval. */
export function rungReady(ctx: Ctx, step: string, sp: StepPolicy): boolean {
  const s = ctx.state;
  const choice = targetRung(s, sp, step);
  const rung = sp.ladder[choice.rung];
  if (rung === undefined || rung.state === 'denied' || unconfirmed(s, sp, rung)) return false;
  if (escalationsExhausted(s, choice)) return false;
  return !(rung.state === 'needs_approval' && !hasEscalationApproval(ctx, step, choice.rung));
}

/**
 * Picks the rung for the next attempt of `step` and checks it: within the ladder, not `denied`, within
 * `max_escalations`, inside the confirmed selection, approved when `needs_approval`. Approval comes last
 * so nobody is asked to approve a rung that could not run anyway (#263). Past the ladder, on a denied or
 * unconfirmed rung the task fails; otherwise it is put into the matching wait. `null` means no attempt
 * starts. Budget and deadline are checked by the caller.
 */
export function chooseRung(
  ctx: Ctx,
  step: string,
  sp: StepPolicy,
  again: ResumeAction,
): RungChoice | null {
  const s = ctx.state;
  const choice = targetRung(s, sp, step);
  const rung = sp.ladder[choice.rung];
  // No higher rung can be used: the task ends with the reason instead of waiting on a person (#247).
  if (rung === undefined) {
    failWithDraft(ctx, `ladder_exhausted:${step}`);
    return null;
  }
  if (rung.state === 'denied') {
    failWithDraft(ctx, `rung_denied:${step}:${choice.rung}`);
    return null;
  }
  // A wait an admin can lift, also by amending the rung into the confirmed set (#105).
  if (choice.raise !== null && escalationsExhausted(s, choice)) {
    const esc = s.budget.escalations;
    waitPolicy(ctx, 'escalations_exhausted', again, {
      step,
      from: choice.raise.from,
      to: choice.raise.to,
      used: esc.used,
      limit: esc.limit,
    });
    return null;
  }
  // The confirmation cannot be given again once the task started, so this is the end of its ladder.
  if (unconfirmed(s, sp, rung)) {
    failWithDraft(ctx, `run_config_unconfirmed:${step}:${bindingName(rung.binding)}`);
    return null;
  }
  if (rung.state === 'needs_approval' && !hasEscalationApproval(ctx, step, choice.rung)) {
    requestApproval(ctx, {
      kind: 'escalation',
      step,
      rung: choice.rung,
      head_sha: null,
      resume: again,
    });
    return null;
  }
  return choice;
}

/** Records the raise; a quality raise on a `scope: task` role also lifts the task floor (SPEC.md §9.3). */
export function applyRaise(ctx: Ctx, step: string, sp: StepPolicy, choice: RungChoice): void {
  const r = choice.raise;
  if (r === null) return;
  ctx.emit('RungRaised', {
    step,
    from: r.from,
    to: r.to,
    reason: r.reason,
    signature: r.signature,
  });
  if (r.reason !== 'quality' || sp.escalation_scope !== 'task') return;
  const level = sp.ladder[r.to]?.level;
  const floor = ctx.state.rungs.floor_level;
  if (level !== undefined && (floor === null || compareLevel(level, floor) > 0)) {
    ctx.emit('TaskFloorRaised', { step, level, reason: 'scope_task' });
  }
}
