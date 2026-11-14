/**
 * What the deputy decided on a task (007, FR-110, R-14): built by code from the command ledger, the
 * task's events, the deputy's turn records and the trial table, never stored. Answers of the old
 * decider (`agent:decider`, FR-122) are listed the same way.
 */
import { DEPUTY_ACTOR } from '../domain/deputy.ts';
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
  readonly task_id: string;
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

export const waiverView = (w: Waiver): WaiverView => ({ ...w, status: 'waived' });

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

/** Every decision on `s`, oldest first. */
export function taskDecisions(store: Store, s: TaskState): DeputyDecision[] {
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

  const commands = store
    .commandsFor([s.id])
    .filter((c) => c.actor === DEPUTY_ACTOR && c.status === 'completed');
  const turns = store.deputy.turnsOf({ task_id: s.id });
  if (commands.length > 0 || turns.length > 0) {
    const byRequest = new Map<string, DomainEvent[]>();
    for (const e of store.readEvents(s.id as Uuid)) {
      const id = commandRequest(e.causation.dedup_key);
      if (id !== null) byRequest.set(id, [...(byRequest.get(id) ?? []), e]);
    }
    const incident = new Map(turns.map((t) => [t.turn_id, t.incident]));
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
        incident: c.turn_id === null ? null : (incident.get(c.turn_id) ?? null),
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
      if (t.handoff === null) continue;
      out.push({
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
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Actions listed elsewhere in the PR body (answers as assumptions, waivers) or not about content. */
const NOT_CONTENT = new Set(['answer', 'task_waive', 'handoff', 'deputy_handoff']);

/** The decisions a unit's PR body lists (FR-111): applied commands that steered the work. */
export function contentDecisions(decisions: readonly DeputyDecision[]): DeputyDecision[] {
  return decisions.filter(
    (d) => d.actor === DEPUTY_ACTOR && d.applied && !NOT_CONTENT.has(d.action),
  );
}
