/**
 * What the loop guard and the deputy's context know about one unit (007, R-19): its failure signature
 * now, the logs of every task that held its key, the trials the deputy ran on it and the loop signals.
 * Read from the store here so the engine functions stay pure.
 */
import type { TaskState } from '../domain/state.ts';
import {
  failureSignature,
  gateScope,
  latestRejection,
  reviewScope,
  waivableTargets,
  type FailureSignature,
} from '../engine/failure-signature.ts';
import {
  goalEvidence,
  loopSignals,
  mergeHistories,
  taskHistory,
  type LoopSignal,
  type TaskHistory,
} from '../engine/loop-signals.ts';
import { checkScope } from '../engine/waivers.ts';
import {
  ACTION_KINDS,
  trialTable,
  type GuardFacts,
  type TrialAction,
  type TrialFact,
  type TrialRow,
} from '../engine/trials.ts';
import type { Uuid } from '../shared/brand.ts';
import type { Store } from '../store/index.ts';

export type UnitFacts = {
  readonly goal_id: string;
  readonly unit_key: string | null;
  readonly signature: FailureSignature;
  readonly history: TaskHistory;
  readonly trials: readonly TrialRow[];
  readonly signals: readonly LoopSignal[];
  readonly guard: GuardFacts;
};

function asFact(v: unknown): TrialFact | null {
  if (typeof v !== 'object' || v === null) return null;
  const f = v as Partial<TrialFact>;
  return typeof f.signature === 'string' &&
    typeof f.params === 'string' &&
    typeof f.global_seq === 'number' &&
    (ACTION_KINDS as readonly unknown[]).includes(f.action_kind)
    ? (f as TrialFact)
    : null;
}

/** Waiver targets on the current basis that no waiver covers yet. */
function openTargets(s: TaskState, sig: FailureSignature): string[] {
  const waivers = s.run.waivers ?? [];
  const review = latestRejection(s);
  const scopeOf = (kind: string, key: string): string | null => {
    if (kind === 'finding') return review === null ? null : reviewScope(review);
    if (kind === 'check') {
      const head = s.head_sha;
      const run = s.evidence.ci
        .findLast((c) => c.valid && c.revision === s.revision && c.head_sha === head)
        ?.checks.find((c) => c.name === key && c.state === 'failure');
      return head === null || run === undefined ? null : checkScope(head, run);
    }
    const g = sig.basis.gates.find((x) => x.gate === key);
    return g === undefined ? null : gateScope(g.gate, g.lines);
  };
  return waivableTargets(sig.basis).filter((t) => {
    const at = t.indexOf(':');
    const kind = t.slice(0, at);
    const key = t.slice(at + 1);
    const scope = scopeOf(kind, key);
    return !waivers.some(
      (w) => w.target.kind === kind && w.target.key === key && w.scope === scope,
    );
  });
}

export function unitFacts(store: Store, s: TaskState, models: readonly string[]): UnitFacts {
  const goal_id = s.task.goal?.id ?? s.id;
  const unit_key = s.task.goal?.unit_key ?? null;
  const tasks = store.deputy.unitTasks(goal_id, unit_key, s.id);
  const own = mergeHistories(tasks.map((id) => taskHistory(store.readEvents(id as Uuid))));
  // An implicit goal has no goal events; a planned one adds its directives and confirmed plans.
  const goal =
    s.task.goal === undefined ? null : goalEvidence(store.goals.events(goal_id), unit_key);
  const history =
    goal === null
      ? own
      : { ...own, directives: [...own.directives, ...goal.directives].sort((a, b) => a - b) };
  const planConfirms = goal?.plan_confirms ?? [];
  const facts = store.deputy.trials(tasks).flatMap((c) => {
    const f = c.ok ? asFact(c.trial) : null;
    return f === null ? [] : [{ ...f, request_id: c.request_id, at: c.admitted_at }];
  });
  const trials = trialTable(facts, history.incidents);
  const signature = failureSignature(s);
  const pending = Object.values(s.approvals).find(
    (a) => a.kind === 'escalation' && a.status === 'requested' && a.revision === s.revision,
  );
  return {
    goal_id,
    unit_key,
    signature,
    history,
    trials,
    signals: loopSignals(s, history, signature.signature),
    guard: {
      signature: signature.signature,
      trials,
      history,
      plan_confirms: planConfirms,
      models,
      waivable: openTargets(s, signature),
      rung_pending: pending === undefined ? null : `${pending.step}#${pending.rung}`,
    },
  };
}

/** The ledger's record of a trial: the deputy's words and where the unit stood (data-model.md). */
export function trialFact(
  store: Store,
  facts: UnitFacts,
  s: TaskState,
  trial: { hypothesis: string; expect: string },
  action: TrialAction,
): TrialFact {
  return {
    hypothesis: trial.hypothesis,
    expect: trial.expect,
    action_kind: action.action,
    params: action.params,
    signature: facts.signature.signature,
    goal_id: facts.goal_id,
    unit_key: facts.unit_key,
    task_id: s.id,
    global_seq: store.lastGlobalSeq(),
    errors: facts.signature.errors,
    tree: s.run.checkpoint?.tree ?? s.run.worktree_tree ?? null,
  };
}
