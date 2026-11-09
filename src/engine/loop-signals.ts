/**
 * Loop signals (007, FR-040, R-18): facts read from the task's own log, without a model, that say a
 * task is going round in circles. Pure: the caller passes the events.
 */
import type { GoalEvent } from '../domain/goal.ts';
import type { DomainEvent } from '../domain/event.ts';
import type { DetailCode, TaskState } from '../domain/state.ts';
import { DEPUTY_ROUTE } from './deputy-routing.ts';
import { applyInPlace } from './evolve.ts';
import { failureSignature, findingKey } from './failure-signature.ts';
import { isBlocking } from './failure.ts';

/** One entry into a wait that is not routine progress, as the log had it then. */
export type Incident = {
  readonly task_id: string;
  readonly global_seq: number;
  readonly revision: number;
  readonly code: DetailCode;
  readonly step: string | null;
  readonly signature: string;
  readonly errors: number;
  /** The checkpoint tree, or the tree the task last saw as its own; null before either exists. */
  readonly tree: string | null;
  /** Model of the latest attempt before the wait; null when none ran. */
  readonly model: string | null;
};

export type TaskHistory = {
  readonly incidents: readonly Incident[];
  /** Checkpoint trees in the order recorded. */
  readonly checkpoints: readonly {
    readonly task_id: string;
    readonly revision: number;
    readonly tree: string;
    readonly global_seq: number;
  }[];
  /** Global seqs of the owner's (or the assistant's) messages and answers: new instructions (FR-043.1). */
  readonly directives: readonly number[];
};

const DIRECTIVE_ACTORS: ReadonlySet<string> = new Set(['owner', 'assistant']);

/** The model of a binding name (`model/effort+ctx`). */
export function bindingModel(binding: string): string {
  return binding.split('/')[0] ?? binding;
}

/** Replays the task's events once and keeps what the signals and the trial table measure. */
export function taskHistory(events: readonly DomainEvent[]): TaskHistory {
  const incidents: Incident[] = [];
  const checkpoints: TaskHistory['checkpoints'][number][] = [];
  const directives: number[] = [];
  let s: TaskState | null = null;
  for (const e of events) {
    s = applyInPlace(s, structuredClone(e));
    if (
      (e.type === 'TaskMessageSent' || e.type === 'QuestionAnswered') &&
      DIRECTIVE_ACTORS.has(e.actor)
    )
      directives.push(e.global_seq);
    if (e.type === 'CheckpointRecorded')
      checkpoints.push({
        task_id: e.task_id,
        revision: e.payload.checkpoint.revision,
        tree: e.payload.checkpoint.tree,
        global_seq: e.global_seq,
      });
    if (e.type !== 'TaskWaiting' || s.wait === null) continue;
    const code = s.wait.detail.code;
    if (DEPUTY_ROUTE[code] === 'auto') continue;
    const sig = failureSignature(s);
    const revision = s.revision;
    const attempts = Object.values(s.attempts);
    const last =
      attempts.findLast((a) => a.step === sig.basis.step && a.revision === revision) ??
      attempts.at(-1);
    incidents.push({
      task_id: e.task_id,
      global_seq: e.global_seq,
      revision,
      code,
      step: sig.basis.step,
      signature: sig.signature,
      errors: sig.errors,
      tree: s.run.checkpoint?.tree ?? s.run.worktree_tree ?? null,
      model: last === undefined ? null : bindingModel(last.binding),
    });
  }
  return { incidents, checkpoints, directives };
}

/** Histories of every task that held one unit key, merged in log order. */
export function mergeHistories(hs: readonly TaskHistory[]): TaskHistory {
  const by = <T extends { global_seq: number }>(xs: T[]): T[] =>
    xs.sort((a, b) => a.global_seq - b.global_seq);
  return {
    incidents: by(hs.flatMap((h) => h.incidents)),
    checkpoints: by(hs.flatMap((h) => h.checkpoints)),
    directives: hs.flatMap((h) => h.directives).sort((a, b) => a - b),
  };
}

export const LOOP_SIGNALS = [
  'finding_repeat',
  'fix_misses_files',
  'tree_revisit',
  'signature_repeat',
  'cross_model_repeat',
  'unreachable_cause',
  'environment',
] as const;
export type LoopSignalKind = (typeof LOOP_SIGNALS)[number];
export type LoopSignal = { readonly kind: LoopSignalKind; readonly detail: string };

/** Rounds a key must stay open in a row to count as repeated: open after at least two fix rounds. */
const REPEAT_ROUNDS = 3;

/** Waits the worker cannot clear from the step it is in. */
const UNREACHABLE: ReadonlySet<DetailCode> = new Set<DetailCode>([
  'base_outdated',
  'source_drift',
  'required_checks_mismatch',
  'target_mismatch',
  'pr_closed',
  'head_changed',
  'merge_not_done',
]);

/** Limits and the world outside the code. */
const ENVIRONMENT: ReadonlySet<DetailCode> = new Set<DetailCode>([
  'backoff_exhausted',
  'ci_wait_exhausted',
  'ci_unclassified',
  'capability_missing',
  'manifest_changed',
  'observation_expired',
  'timeout',
  'deadline',
  'agent_runs_exhausted',
  'agent_runs_insufficient',
]);

export function loopSignals(s: TaskState, h: TaskHistory, signature: string): LoopSignal[] {
  const out: LoopSignal[] = [];
  const rejections = s.run.reviews.filter((r) => r.valid && r.revision === s.revision);
  const last = rejections.at(-1);
  if (last?.verdict === 'request_changes') {
    const repeated = [...new Set(last.findings.filter(isBlocking).map(findingKey))].filter(
      (key) => {
        let rounds = 0;
        for (let i = rejections.length - 1; i >= 0; i--) {
          const r = rejections[i]!;
          if (r.verdict !== 'request_changes') break;
          if (!r.findings.some((f) => isBlocking(f) && findingKey(f) === key)) break;
          rounds += 1;
        }
        return rounds >= REPEAT_ROUNDS;
      },
    );
    if (repeated.length > 0)
      out.push({
        kind: 'finding_repeat',
        detail: `still open after ${REPEAT_ROUNDS - 1}+ fix rounds: ${repeated.sort().join(', ')}`,
      });
  }
  const misses = h.incidents.filter(
    (i) =>
      i.task_id === s.id &&
      i.revision === s.revision &&
      (i.code === 'review_repeated' || i.code === 'fix_no_src_change'),
  );
  if (misses.length > 0)
    out.push({
      kind: 'fix_misses_files',
      detail: `the fix left the files of blocking findings alone ${misses.length} time(s)`,
    });
  const trees = h.checkpoints
    .filter((c) => c.task_id === s.id && c.revision === s.revision)
    .map((c) => c.tree)
    .filter((t, i, all) => i === 0 || all[i - 1] !== t);
  const now = trees.at(-1);
  if (now !== undefined && trees.slice(0, -1).includes(now))
    out.push({ kind: 'tree_revisit', detail: `checkpoint tree ${now.slice(0, 12)} came back` });
  const same = h.incidents.filter((i) => i.signature === signature);
  const distinctTrees = new Set(same.map((i) => i.tree));
  if (same.length >= 2 && distinctTrees.size >= 2)
    out.push({
      kind: 'signature_repeat',
      detail: `same failure signature on ${distinctTrees.size} different trees`,
    });
  const models = new Set(same.flatMap((i) => (i.model === null ? [] : [i.model])));
  if (models.size >= 2)
    out.push({
      kind: 'cross_model_repeat',
      detail: `same failure signature on models ${[...models].sort().join(', ')}`,
    });
  const code = s.wait?.detail.code;
  if (code !== undefined && UNREACHABLE.has(code))
    out.push({ kind: 'unreachable_cause', detail: `${code} is not something the worker can fix` });
  if (code !== undefined && ENVIRONMENT.has(code))
    out.push({ kind: 'environment', detail: `${code}: a limit or the environment` });
  return out;
}

/**
 * New evidence a goal brings to one unit (FR-043.1): directives of the owner or the assistant on the
 * goal (a note or a revised request), and plan versions the owner confirmed that touch the unit: an
 * amendment naming it, or a whole plan that holds it. Global seqs, in log order.
 */
export function goalEvidence(
  events: readonly GoalEvent[],
  unitKey: string | null,
): { readonly directives: number[]; readonly plan_confirms: number[] } {
  const directives: number[] = [];
  const plan_confirms: number[] = [];
  let proposed: { hash: string; keys: readonly string[] } | null = null;
  let amendment: { hash: string; affected: readonly string[] } | null = null;
  const touches = (keys: readonly string[]) => unitKey === null || keys.includes(unitKey);
  for (const e of events) {
    switch (e.type) {
      case 'GoalNoted':
        if (e.payload.kind === 'directive' && DIRECTIVE_ACTORS.has(e.actor))
          directives.push(e.global_seq);
        break;
      case 'GoalRevised':
        if (DIRECTIVE_ACTORS.has(e.actor)) directives.push(e.global_seq);
        break;
      case 'PlanProposed':
        proposed = { hash: e.payload.plan_hash, keys: e.payload.plan.units.map((u) => u.key) };
        break;
      case 'PlanAmendmentProposed':
        amendment = { hash: e.payload.plan_hash, affected: e.payload.affected };
        break;
      // Applied without a confirmation: evidence only when the owner or the assistant made it.
      case 'PlanAmended':
        if (DIRECTIVE_ACTORS.has(e.actor) && touches(e.payload.affected))
          plan_confirms.push(e.global_seq);
        break;
      case 'PlanConfirmed': {
        const keys =
          amendment?.hash === e.payload.plan_hash
            ? amendment.affected
            : proposed?.hash === e.payload.plan_hash
              ? proposed.keys
              : [];
        if (touches(keys)) plan_confirms.push(e.global_seq);
        amendment = null;
        break;
      }
      default:
        break;
    }
  }
  return { directives, plan_confirms };
}
