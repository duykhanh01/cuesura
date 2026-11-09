/**
 * The trial table and the loop guard (007, FR-042–FR-044, R-19). Every extension the deputy sends is a
 * trial on the failure signature the unit stood at; the guard refuses a repeat without new evidence,
 * lets each kind of action run out, and once all have run out on a signature leaves only `task fail`
 * and a handover. Pure: the daemon reads the ledger and the logs and passes them in.
 */
import { canonicalJson } from '../shared/canonical-json.ts';
import { hashText } from '../shared/hash.ts';
import type { Incident, TaskHistory } from './loop-signals.ts';

export const ACTION_KINDS = ['extend', 'model', 'instruct', 'waive', 'approve_rung'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export type TrialAction = { readonly action: ActionKind; readonly params: string };

/** The action an extension command stands for, with its normalized parameters; null for others. */
export function trialAction(kind: string, payload: unknown): TrialAction | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (kind) {
    case 'task_continue':
      return { action: 'extend', params: 'continue' };
    case 'task_amend_policy':
      if (typeof p['model'] === 'string') return { action: 'model', params: p['model'] };
      return {
        action: 'extend',
        params: canonicalJson({
          agent_runs: p['agent_runs_delta'] ?? null,
          deadline: p['deadline'] ?? null,
        }),
      };
    case 'task_message':
      return {
        action: 'instruct',
        params: hashText(typeof p['body'] === 'string' ? p['body'] : ''),
      };
    case 'task_waive': {
      const t = (p['target'] ?? {}) as Record<string, unknown>;
      return { action: 'waive', params: `${String(t['kind'])}:${String(t['key'])}` };
    }
    case 'approve_escalation':
      return { action: 'approve_rung', params: `${String(p['step'])}#${String(p['rung'])}` };
    default:
      return null;
  }
}

/** What the ledger keeps with a trial (`command_ledger.trial_json`, data-model.md). */
export type TrialFact = {
  readonly hypothesis: string;
  readonly expect: string;
  readonly action_kind: ActionKind;
  readonly params: string;
  readonly signature: string;
  readonly goal_id: string;
  readonly unit_key: string | null;
  readonly task_id: string;
  /** The log position the trial was admitted at; outcomes and new evidence come after it. */
  readonly global_seq: number;
  readonly errors: number;
  readonly tree: string | null;
};

export type TrialOutcome = {
  readonly global_seq: number;
  readonly signature_changed: boolean;
  readonly errors_delta: number;
  readonly tree_changed: boolean;
};

export type TrialRow = TrialFact & {
  readonly request_id: string;
  readonly at: number;
  /** Measured at the next incident of the unit; null while there is none. */
  readonly outcome: TrialOutcome | null;
};

export function progressed(o: TrialOutcome | null): boolean {
  return o !== null && o.tree_changed && (o.signature_changed || o.errors_delta < 0);
}

/** Trials with their outcome at the unit's next incident. */
export function trialTable(
  facts: readonly (TrialFact & { request_id: string; at: number })[],
  incidents: readonly Incident[],
): TrialRow[] {
  return [...facts]
    .sort((a, b) => a.global_seq - b.global_seq || a.at - b.at)
    .map((f) => {
      const next = incidents.find((i) => i.global_seq > f.global_seq);
      return {
        ...f,
        outcome:
          next === undefined
            ? null
            : {
                global_seq: next.global_seq,
                signature_changed: next.signature !== f.signature,
                errors_delta: next.errors - f.errors,
                tree_changed: next.tree !== f.tree,
              },
      };
    });
}

export type GuardFacts = {
  readonly signature: string;
  readonly trials: readonly TrialRow[];
  readonly history: TaskHistory;
  /** Global seqs at which the owner confirmed a plan version that touches this unit (FR-043.1). */
  readonly plan_confirms: readonly number[];
  /** Models the deputy may move to: `allow_models`, or every configured model when it is open. */
  readonly models: readonly string[];
  /** Waiver targets on the current basis (`finding:<key>`, `gate:<name>`, `check:<name>`). */
  readonly waivable: readonly string[];
  /** The escalation rung awaiting approval, `<step>#<rung>`; null when none does. */
  readonly rung_pending: string | null;
};

export type GuardReason = 'repeat_without_evidence' | 'action_exhausted' | 'signature_exhausted';
export type GuardRefusal = { readonly reason: GuardReason; readonly prior: TrialRow | null };

/** Whether something counts as new evidence after `seq`: progress, an instruction, a confirmed plan. */
function evidenceAfter(f: GuardFacts, seq: number): boolean {
  return (
    f.trials.some((t) => progressed(t.outcome) && (t.outcome as TrialOutcome).global_seq > seq) ||
    f.history.directives.some((d) => d > seq) ||
    f.plan_confirms.some((p) => p > seq)
  );
}

/** Trials on the current signature that no new evidence has followed. */
function live(f: GuardFacts): TrialRow[] {
  return f.trials.filter((t) => t.signature === f.signature && !evidenceAfter(f, t.global_seq));
}

/** Models already tried on the signature: those its incidents ran on and those trials moved to. */
export function triedModels(f: GuardFacts): Set<string> {
  return new Set([
    ...f.history.incidents.flatMap((i) =>
      i.signature === f.signature && i.model !== null ? [i.model] : [],
    ),
    ...f.trials.flatMap((t) =>
      t.signature === f.signature && t.action_kind === 'model' ? [t.params] : [],
    ),
  ]);
}

export type Exhaustion = Readonly<Record<ActionKind, boolean>> & { readonly all: boolean };

export function exhaustion(f: GuardFacts): Exhaustion {
  const rows = live(f);
  const tried = triedModels(f);
  const waived = new Set(
    f.trials.flatMap((t) =>
      t.signature === f.signature && t.action_kind === 'waive' ? [t.params] : [],
    ),
  );
  const e = {
    extend: rows.some((t) => t.action_kind === 'extend'),
    instruct: rows.some((t) => t.action_kind === 'instruct'),
    model: f.models.every((m) => tried.has(m)),
    waive: f.waivable.every((w) => waived.has(w)),
    approve_rung:
      f.rung_pending === null ||
      rows.some((t) => t.action_kind === 'approve_rung' && t.params === f.rung_pending),
  };
  return { ...e, all: Object.values(e).every(Boolean) };
}

/**
 * The three rules of FR-043 for one command of the deputy. `action` is null for a command that buys no
 * time (answer, recheck, pause): only rule 3 applies to it. `task_fail` always passes.
 */
export function loopGuard(
  f: GuardFacts,
  kind: string,
  action: TrialAction | null,
): GuardRefusal | null {
  if (kind === 'task_fail' || kind === 'deputy_handoff') return null;
  if (action !== null) {
    const rows = live(f);
    const same = rows.findLast(
      (t) => t.action_kind === action.action && t.params === action.params,
    );
    if (same !== undefined && action.action !== 'waive')
      return { reason: 'repeat_without_evidence', prior: same };
    switch (action.action) {
      case 'extend':
      case 'instruct': {
        const prior = rows.findLast((t) => t.action_kind === action.action);
        if (prior !== undefined) return { reason: 'action_exhausted', prior };
        break;
      }
      case 'model':
        if (triedModels(f).has(action.params) || !f.models.includes(action.params))
          return {
            reason: 'action_exhausted',
            prior:
              f.trials.findLast((t) => t.signature === f.signature && t.action_kind === 'model') ??
              null,
          };
        break;
      case 'waive': {
        const prior = f.trials.findLast(
          (t) =>
            t.signature === f.signature && t.action_kind === 'waive' && t.params === action.params,
        );
        if (prior !== undefined) return { reason: 'action_exhausted', prior };
        break;
      }
      case 'approve_rung':
        break;
    }
  }
  if (exhaustion(f).all)
    return {
      reason: 'signature_exhausted',
      prior: f.trials.findLast((t) => t.signature === f.signature) ?? null,
    };
  return null;
}

/**
 * Upper bound of SC-009: extensions admitted on one signature without new evidence. Each model once,
 * one instruction, one extension, each waiver target once, each pending rung once.
 */
export function trialBound(f: Pick<GuardFacts, 'models' | 'waivable' | 'rung_pending'>): number {
  return f.models.length + 2 + f.waivable.length + (f.rung_pending === null ? 0 : 1);
}
