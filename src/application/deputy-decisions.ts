/**
 * What the deputy decided on a task or a goal (007, FR-110, R-14): built by code from the command ledger, the
 * task's events, the deputy's turn records and the trial table, never stored. Answers of the old
 * decider (`agent:decider`, FR-122) are listed the same way.
 */
import { DEPUTY_ACTOR, type DeputyTurn } from '../domain/deputy.ts';
import type { GoalEvent } from '../domain/goal.ts';
import type { DomainEvent } from '../domain/event.ts';
import type { TaskState, Waiver } from '../domain/state.ts';
import { DECIDER_ACTOR } from '../engine/questions.ts';
import { progressed, type TrialRow } from '../engine/trials.ts';
import type { DecisionResult } from '../explain/trial-result.ts';
import type { Uuid } from '../shared/brand.ts';
import type { CommandRecord, Store } from '../store/index.ts';
import { unitFacts } from './loop-facts.ts';

export type DeputyDecision = {
  readonly at: number;
  readonly actor: string;
  readonly goal_id: string;
  /** Null for a decision on the goal itself. */
  readonly task_id: string | null;
  readonly unit_key: string | null;
  readonly turn_id: string | null;
  /** The incident key of the turn (FR-020); null for the old decider. */
  readonly incident: string | null;
  /** The command kind; `handoff` for a turn's handoff, `answer` for the old decider. */
  readonly action: string;
  /** What the action said: a message, an answer, a model, a waived target, a handoff's decision. */
  readonly detail: string | null;
  /** The question an answer was for. */
  readonly question: string | null;
  readonly reason: string | null;
  readonly hypothesis: string | null;
  readonly expect: string | null;
  readonly applied: boolean;
  readonly failure: string | null;
  /** Measured for a trial at the next incident; null for no trial or none yet. */
  readonly result: DecisionResult | null;
  readonly request_id: string | null;
  /** Events the command caused on the task. */
  readonly events: readonly string[];
};

/** A waiver as every view shows it: waived, never passed (FR-046). */
export type WaiverView = Waiver & { readonly status: 'waived' };

/** A waiver as every view shows it, with its reason and evidence masked like a decision's. */
export const waiverView = (w: Waiver, redact: (t: string) => string = (t) => t): WaiverView => ({
  ...w,
  reason: w.reason === null ? null : redact(w.reason),
  evidence: redact(w.evidence),
  status: 'waived',
});

/** The ledger request a `cmd:<request_id>:…` event came from. */
export function commandRequest(dedupKey: string | null): string | null {
  const m = dedupKey === null ? null : /^cmd:([^:]+):/.exec(dedupKey);
  return m === null ? null : (m[1] as string);
}

function asTrial(v: unknown): { hypothesis: string; expect: string } | null {
  if (typeof v !== 'object' || v === null) return null;
  const t = v as Record<string, unknown>;
  return typeof t['hypothesis'] === 'string' && typeof t['expect'] === 'string'
    ? { hypothesis: t['hypothesis'], expect: t['expect'] }
    : null;
}

function resultOf(row: TrialRow | undefined): DecisionResult | null {
  if (row?.outcome == null) return null;
  const { signature_changed, errors_delta, tree_changed } = row.outcome;
  return { signature_changed, errors_delta, tree_changed, progressed: progressed(row.outcome) };
}

function failureOf(c: CommandRecord): string | null {
  const r = c.result as { ok?: unknown; error?: { code?: unknown; details?: unknown } } | null;
  if (r === null || r.ok === true) return null;
  const reason = (r.error?.details as { reason?: unknown } | undefined)?.reason;
  return [r.error?.code, reason].filter((x) => typeof x === 'string').join(': ') || 'refused';
}

/** What a command's events say it did, or the trial's parameters when they do not say. */
function detailOf(events: readonly DomainEvent[], trial: unknown): string | null {
  for (const e of events) {
    if (e.type === 'TaskMessageSent') return e.payload.body;
    if (e.type === 'QuestionAnswered') return e.payload.answer;
    if (e.type === 'Waived')
      return `${e.payload.waiver.target.kind} ${e.payload.waiver.target.key}`;
    if (e.type === 'TaskFailed') return e.payload.reason;
  }
  const t = trial as { action_kind?: unknown; params?: unknown } | null;
  return t !== null && t.action_kind === 'model' && typeof t.params === 'string'
    ? `model ${t.params}`
    : null;
}

function questionOf(s: TaskState, events: readonly DomainEvent[]): string | null {
  const e = events.find((x) => x.type === 'QuestionAnswered');
  return e?.type === 'QuestionAnswered' ? (s.questions[e.payload.question_id]?.body ?? null) : null;
}

/** Masks secrets in what the deputy wrote, at every place it is shown (constitution: Secret). */
export type Redact = (text: string) => string;
const keep: Redact = (t) => t;

function redacted(d: DeputyDecision, redact: Redact): DeputyDecision {
  const r = (t: string | null): string | null => (t === null ? null : redact(t));
  return {
    ...d,
    detail: r(d.detail),
    question: r(d.question),
    reason: r(d.reason),
    hypothesis: r(d.hypothesis),
    expect: r(d.expect),
    failure: r(d.failure),
  };
}

/**
 * The incident of a command's turn, looked up by the turn itself: a turn may act on another task of
 * its goal (FR-051), and the command then keeps the incident it was opened for.
 */
function turnIncidents(store: Store): (turnId: string | null) => string | null {
  const seen = new Map<string, string | null>();
  return (turnId) => {
    if (turnId === null) return null;
    if (!seen.has(turnId)) seen.set(turnId, store.deputy.turn(turnId)?.incident ?? null);
    return seen.get(turnId) ?? null;
  };
}

function handoffDecision(
  base: Pick<DeputyDecision, 'goal_id' | 'task_id' | 'unit_key'>,
  t: DeputyTurn,
): DeputyDecision | null {
  if (t.handoff === null) return null;
  return {
    ...base,
    at: t.ended_at ?? t.started_at,
    actor: DEPUTY_ACTOR,
    turn_id: t.turn_id,
    incident: t.incident,
    action: 'handoff',
    detail: t.handoff.decision,
    question: null,
    reason: `cause ${t.handoff.cause}${t.handoff.next_look === null ? '' : `; next: ${t.handoff.next_look}`}`,
    hypothesis: null,
    expect: null,
    applied: true,
    failure: null,
    result: null,
    request_id: null,
    events: [],
  };
}

const deputyCommands = (store: Store, target: string): CommandRecord[] =>
  store.commandsFor([target]).filter((c) => c.actor === DEPUTY_ACTOR && c.status === 'completed');

/** Every decision on `s`, oldest first, with what the deputy wrote masked by `redact`. */
export function taskDecisions(store: Store, s: TaskState, redact: Redact = keep): DeputyDecision[] {
  const goal_id = s.task.goal?.id ?? s.id;
  const unit_key = s.task.goal?.unit_key ?? null;
  const base = { goal_id, task_id: s.id, unit_key };
  const out: DeputyDecision[] = [];

  for (const r of Object.values(s.decider_runs ?? {})) {
    if (!r.invoked) continue;
    out.push({
      ...base,
      at: r.at,
      actor: DECIDER_ACTOR,
      turn_id: null,
      incident: null,
      action: 'answer',
      detail: r.answer,
      question: s.questions[r.question_id]?.body ?? null,
      reason: r.reason,
      hypothesis: null,
      expect: null,
      applied: r.applied,
      failure: r.failure,
      result: null,
      request_id: null,
      events: [],
    });
  }

  const commands = deputyCommands(store, s.id);
  const turns = store.deputy.turnsOf({ task_id: s.id });
  if (commands.length > 0 || turns.length > 0) {
    const byRequest = new Map<string, DomainEvent[]>();
    for (const e of store.readEvents(s.id as Uuid)) {
      const id = commandRequest(e.causation.dedup_key);
      if (id !== null) byRequest.set(id, [...(byRequest.get(id) ?? []), e]);
    }
    const incidentOf = turnIncidents(store);
    const trials = commands.some((c) => asTrial(c.trial) !== null)
      ? new Map(unitFacts(store, s, []).trials.map((t) => [t.request_id, t]))
      : new Map<string, TrialRow>();
    for (const c of commands) {
      const events = byRequest.get(c.request_id) ?? [];
      const trial = asTrial(c.trial);
      const failure = failureOf(c);
      out.push({
        ...base,
        at: c.admitted_at,
        actor: c.actor,
        turn_id: c.turn_id,
        incident: incidentOf(c.turn_id),
        action: c.kind,
        detail: detailOf(events, c.trial),
        question: questionOf(s, events),
        reason: c.reason,
        hypothesis: trial?.hypothesis ?? null,
        expect: trial?.expect ?? null,
        applied: failure === null,
        failure,
        result: resultOf(trials.get(c.request_id)),
        request_id: c.request_id,
        events: events.map((e) => e.type),
      });
    }
    for (const t of turns) {
      const h = handoffDecision(base, t);
      if (h !== null) out.push(h);
    }
  }
  return out.sort((a, b) => a.at - b.at).map((d) => redacted(d, redact));
}

/** What a goal event caused by a command says it did. */
function goalDetail(e: GoalEvent): string | null {
  switch (e.type) {
    case 'PlanProposed':
      return `plan v${e.payload.plan_version} ${e.payload.plan_hash} proposed`;
    case 'PlanAmended':
      return `plan v${e.payload.plan_version} ${e.payload.plan_hash} amended (execution)`;
    case 'PlanAmendmentProposed':
      return `plan v${e.payload.plan_version} ${e.payload.plan_hash} amendment proposed (scope)`;
    case 'GoalNoted':
      return e.payload.text;
    case 'GoalRevised':
      return 'request revised';
    case 'GoalCancelled':
      return e.payload.reason;
    default:
      return null;
  }
}

/**
 * Decisions on the goal itself (FR-110): the deputy's goal commands (`goal propose`, `amend`, `note`…)
 * and the handoffs of its plan turns, which no task holds. Shown before any task exists.
 */
export function goalOwnDecisions(
  store: Store,
  goalId: string,
  redact: Redact = keep,
): DeputyDecision[] {
  const base = { goal_id: goalId, task_id: null, unit_key: null };
  const events = new Map<string, GoalEvent[]>();
  for (const { dedup_key, event } of store.goals.causedEvents(goalId)) {
    const id = commandRequest(dedup_key);
    if (id !== null) events.set(id, [...(events.get(id) ?? []), event]);
  }
  const incidentOf = turnIncidents(store);
  const out: DeputyDecision[] = deputyCommands(store, goalId).map((c) => {
    const caused = events.get(c.request_id) ?? [];
    const failure = failureOf(c);
    return {
      ...base,
      at: c.admitted_at,
      actor: c.actor,
      turn_id: c.turn_id,
      incident: incidentOf(c.turn_id),
      action: c.kind,
      detail: caused.map(goalDetail).find((x) => x !== null) ?? null,
      question: null,
      reason: c.reason,
      hypothesis: null,
      expect: null,
      applied: failure === null,
      failure,
      result: null,
      request_id: c.request_id,
      events: caused.map((e) => e.type),
    };
  });
  for (const t of store.deputy.turnsOf({ goal_id: goalId })) {
    const h = t.task_id === null ? handoffDecision(base, t) : null;
    if (h !== null) out.push(h);
  }
  return out.sort((a, b) => a.at - b.at).map((d) => redacted(d, redact));
}

/** Actions listed elsewhere in the PR body (answers as assumptions, waivers) or not about content. */
const NOT_CONTENT = new Set(['answer', 'task_waive', 'handoff', 'deputy_handoff']);

/** The decisions a unit's PR body lists (FR-111): applied commands that steered the work. */
export function contentDecisions(decisions: readonly DeputyDecision[]): DeputyDecision[] {
  return decisions.filter(
    (d) => d.actor === DEPUTY_ACTOR && d.applied && !NOT_CONTENT.has(d.action),
  );
}
