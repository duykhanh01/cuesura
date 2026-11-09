import type { GoalEvent, GoalEventDraft, GoalState } from '../../domain/goal.ts';

function empty(goalId: string): GoalState {
  return {
    id: goalId,
    project: '',
    status: 'planning',
    implicit: false,
    version: 0,
    base_branch: '',
    request: '',
    hints: {},
    revisions: [],
    plan: null,
    plan_version: 0,
    plan_hash: null,
    confirmed_plan_version: null,
    plans: [],
    pending_amendment: null,
    notes: [],
    branch: null,
    branch_base_sha: null,
    branch_created: false,
    units: {},
    final_task_id: null,
    replan_reason: null,
    created_at: 0,
    ended: null,
  };
}

/** Folds one goal event; the state passed in is changed and returned. */
export function evolveGoal(state: GoalState | null, goalId: string, e: GoalEventDraft): GoalState {
  const s = state ?? empty(goalId);
  s.version += 1;
  switch (e.type) {
    case 'GoalAdded':
      s.project = e.payload.project;
      s.base_branch = e.payload.base_branch;
      s.request = e.payload.request;
      s.hints = e.payload.hints;
      s.created_at = e.payload.at;
      s.status = 'planning';
      break;
    case 'GoalRevised':
      s.revisions.push({ request: s.request, by: e.payload.by, at: e.payload.at });
      s.request = e.payload.request;
      s.plan_version += 1;
      s.pending_amendment = null;
      if (s.confirmed_plan_version === null) s.status = 'planning';
      else {
        s.status = 'replan';
        s.replan_reason = 'request_revised';
      }
      break;
    case 'GoalNoted':
      s.notes.push({
        by: e.payload.by,
        kind: e.payload.kind,
        text: e.payload.text,
        at: e.payload.at,
      });
      break;
    case 'PlanProposed':
      s.plan = e.payload.plan;
      s.plan_version = e.payload.plan_version;
      s.plan_hash = e.payload.plan_hash;
      s.plans.push({
        version: e.payload.plan_version,
        hash: e.payload.plan_hash,
        by: e.payload.by,
        reason: e.payload.reason,
        kind: 'proposed',
        at: e.payload.at,
      });
      s.status = 'awaiting_confirm';
      break;
    case 'PlanConfirmed': {
      const pending = s.pending_amendment;
      if (pending !== null && pending.plan_hash === e.payload.plan_hash) {
        s.plan = pending.plan;
        s.plan_hash = pending.plan_hash;
        s.plan_version = pending.plan_version;
      }
      s.pending_amendment = null;
      s.confirmed_plan_version = e.payload.plan_version;
      if (e.payload.branch !== undefined) {
        s.branch = e.payload.branch.name;
        s.branch_base_sha = e.payload.branch.base_sha;
        s.branch_created = false;
      }
      if (e.payload.final_task_id !== undefined) s.final_task_id = e.payload.final_task_id;
      for (const [key, taskId] of Object.entries(e.payload.units)) {
        const prev = Object.hasOwn(s.units, key) ? s.units[key] : undefined;
        s.units[key] = {
          task_id: taskId,
          previous: prev === undefined ? [] : [...prev.previous, prev.task_id],
        };
      }
      s.status = 'running';
      s.replan_reason = null;
      break;
    }
    case 'PlanAmended':
      s.plan = e.payload.plan;
      s.plan_version = e.payload.plan_version;
      s.plan_hash = e.payload.plan_hash;
      s.confirmed_plan_version = e.payload.plan_version;
      s.plans.push({
        version: e.payload.plan_version,
        hash: e.payload.plan_hash,
        by: e.payload.by,
        reason: e.payload.reason,
        kind: 'amended',
        at: e.payload.at,
      });
      s.status = 'running';
      s.replan_reason = null;
      break;
    case 'PlanAmendmentProposed':
      s.plan_version = e.payload.plan_version;
      s.pending_amendment = {
        plan: e.payload.plan,
        plan_version: e.payload.plan_version,
        plan_hash: e.payload.plan_hash,
        affected: e.payload.affected,
        by: e.payload.by,
        reason: e.payload.reason,
      };
      s.plans.push({
        version: e.payload.plan_version,
        hash: e.payload.plan_hash,
        by: e.payload.by,
        reason: e.payload.reason,
        kind: 'amendment_proposed',
        at: e.payload.at,
      });
      s.status = 'amendment_pending';
      break;
    case 'GoalBranchCreated':
      s.branch_created = true;
      break;
    case 'GoalReplanNeeded':
      s.status = 'replan';
      s.replan_reason = e.payload.reason;
      break;
    case 'GoalCompleted':
      s.status = 'done';
      s.ended = { reason: 'completed', by: e.actor, at: e.payload.at };
      break;
    case 'GoalFailed':
      s.status = 'failed';
      s.ended = { reason: e.payload.reason, by: e.actor, at: e.payload.at };
      break;
    case 'GoalCancelled':
      s.status = 'cancelled';
      s.ended = { reason: e.payload.reason, by: e.payload.by, at: e.payload.at };
      break;
  }
  return s;
}

export function replayGoal(goalId: string, events: readonly GoalEvent[]): GoalState | null {
  let s: GoalState | null = null;
  for (const e of events) s = evolveGoal(s, goalId, e);
  return s;
}
