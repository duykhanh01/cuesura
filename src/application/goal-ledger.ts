/**
 * The goal ledger (R-17, FR-060–FR-063): a view built from the goal's events, the command ledger of the
 * goal and its tasks, and the deputy's turn records. No table holds it.
 */
import type { GoalEvent, GoalState, NoteKind } from '../domain/goal.ts';
import type { Store } from '../store/index.ts';

export type LedgerKind = NoteKind | 'decision';

/** FR-063: a ledger entry's kind follows from who wrote it, never from what the caller said. */
export function noteKindOf(actor: string): NoteKind {
  if (actor === 'deputy') return 'observation';
  if (actor.startsWith('system:')) return 'event';
  return 'directive';
}

export type LedgerEntry = {
  readonly at: number;
  readonly actor: string;
  readonly kind: LedgerKind;
  readonly text: string;
  readonly task_id: string | null;
  readonly turn_id: string | null;
  readonly reason: string | null;
  readonly trial: unknown;
};

/** A deputy's write is a decision; a person's a directive; the daemon's an event (FR-063). */
function writeKind(actor: string): LedgerKind {
  const k = noteKindOf(actor);
  return k === 'observation' ? 'decision' : k;
}

function fromEvent(e: GoalEvent): LedgerEntry | null {
  const base = { task_id: null, turn_id: null, reason: null, trial: null } as const;
  switch (e.type) {
    case 'GoalAdded':
      return { ...base, at: e.payload.at, actor: e.actor, kind: 'event', text: 'goal added' };
    case 'GoalRevised':
      return {
        ...base,
        at: e.payload.at,
        actor: e.actor,
        kind: writeKind(e.actor),
        text: 'request revised',
      };
    case 'GoalNoted':
      return {
        ...base,
        at: e.payload.at,
        actor: e.actor,
        kind: e.payload.kind,
        text: e.payload.text,
      };
    case 'PlanProposed':
    case 'PlanAmended':
    case 'PlanAmendmentProposed': {
      const what =
        e.type === 'PlanProposed'
          ? 'plan proposed'
          : e.type === 'PlanAmended'
            ? 'plan amended (execution)'
            : 'plan amendment proposed (scope)';
      return {
        ...base,
        at: e.payload.at,
        actor: e.actor,
        kind: writeKind(e.actor),
        text: `${what}: v${e.payload.plan_version} ${e.payload.plan_hash}`,
        reason: e.payload.reason,
      };
    }
    case 'PlanConfirmed':
      return {
        ...base,
        at: e.payload.at,
        actor: e.actor,
        kind: writeKind(e.actor),
        text: `plan v${e.payload.plan_version} confirmed`,
      };
    case 'GoalReplanNeeded':
      return {
        ...base,
        at: e.payload.at,
        actor: e.actor,
        kind: 'event',
        text: `replan: ${e.payload.reason}`,
      };
    case 'GoalCompleted':
      return { ...base, at: e.payload.at, actor: e.actor, kind: 'event', text: 'goal done' };
    case 'GoalFailed':
      return {
        ...base,
        at: e.payload.at,
        actor: e.actor,
        kind: 'event',
        text: `goal failed: ${e.payload.reason}`,
      };
    case 'GoalCancelled':
      return {
        ...base,
        at: e.payload.at,
        actor: e.actor,
        kind: writeKind(e.actor),
        text: `goal cancelled: ${e.payload.reason}`,
      };
  }
}

/** Every entry of the goal, oldest first. An implicit goal has no events of its own. */
export function goalLedger(store: Store, goal: GoalState): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  if (!goal.implicit)
    for (const e of store.goals.events(goal.id)) {
      const entry = fromEvent(e);
      if (entry !== null) out.push(entry);
    }
  const tasks = Object.values(goal.units).flatMap((u) => [u.task_id, ...u.previous]);
  for (const c of store.commandsFor(tasks)) {
    if (c.status !== 'completed') continue;
    out.push({
      at: c.admitted_at,
      actor: c.actor,
      kind: writeKind(c.actor),
      text: c.kind,
      task_id: c.task_id,
      turn_id: c.turn_id,
      reason: c.reason,
      trial: c.trial,
    });
  }
  for (const t of store.deputy.turnsOf({ goal_id: goal.id })) {
    if (t.handoff === null) continue;
    out.push({
      at: t.ended_at ?? t.started_at,
      actor: 'deputy',
      kind: 'decision',
      text: `turn ${t.kind}: ${t.handoff.decision} (cause ${t.handoff.cause})`,
      task_id: t.task_id,
      turn_id: t.turn_id,
      reason: t.handoff.next_look,
      trial: null,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The owner's directives, in time order: the only ledger entries of the context's stable zone. */
export function directives(goal: GoalState): { at: number; by: string; text: string }[] {
  const notes = goal.notes
    .filter((n) => n.kind === 'directive')
    .map((n) => ({ at: n.at, by: n.by, text: n.text }));
  const revised = goal.revisions.map((r) => ({
    at: r.at,
    by: r.by,
    text: 'replaced the request (the current request is above)',
  }));
  return [...notes, ...revised].sort((a, b) => a.at - b.at);
}
