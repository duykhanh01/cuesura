import fc from 'fast-check';
import type { Uuid } from '../../../src/shared/brand.ts';
import type { DomainEventDraft } from '../../../src/domain/event.ts';
import type { FrozenPolicy } from '../../../src/domain/policy.ts';
import type { EffectMirror, TaskState } from '../../../src/domain/state.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import {
  FAILURE_CLASSES,
  type Check,
  type FailureClass,
  type Trigger,
} from '../../../src/domain/trigger.ts';
import type { Decision } from '../../../src/engine/decide.ts';
import { evolve } from '../../../src/engine/evolve.ts';
import { buildTask, freezeOk, type PolicyOptions } from '../../support/builders.ts';
import {
  agentData,
  ciData,
  gatesData,
  PREPARE_DATA,
  publishData,
  reviewData,
  Sim,
  started,
  type ClaimResult,
} from '../../support/scenario.ts';

export type Choice = { pick: number; variant: number; flag: number };

export const choicesArb = (maxLength = 120, minLength = 1): fc.Arbitrary<Choice[]> =>
  fc.array(
    fc.record({
      pick: fc.nat(10_000),
      variant: fc.nat(10_000),
      flag: fc.nat(10_000),
    }),
    { minLength, maxLength },
  );

export type TraceEntry = {
  kind: 'decide' | 'claim';
  label: string;
  before: TaskState | null;
  policyBefore: FrozenPolicy | null;
  after: TaskState | null;
  decision: Decision | null;
  claim: ClaimResult | null;
  trigger: Trigger | null;
  ids: number;

  now: number;
};

/**
 * driftEvery controls edit frequency (default: 17). driftFocus forces revision choices at safe
 * boundaries so every generated run exercises revision handling.
 */
export type DriveOptions = {
  driftEvery?: number;
  driftFocus?: boolean;
  failureFocus?: boolean;
};

export type Run = {
  sim: Sim;
  trace: TraceEntry[];
  policy: PolicyOptions;
  task: CanonicalTask;
  opts: DriveOptions;
};

type Action = {
  label: string;
  run: () => {
    decision?: Decision;
    claim?: ClaimResult;
    trigger?: Trigger;
    ids?: number;
  };
};

const CHECK_NAMES = ['build', 'test', 'format'];
const CHECK_STATES: Check['state'][] = [
  'success',
  'success',
  'success',
  'failure',
  'pending',
  'cancelled',
  'unknown',
];

function successData(sim: Sim, e: EffectMirror, c: Choice): unknown {
  const v = c.variant;
  switch (e.kind) {
    case 'start_agent': {
      const review = sim.policy?.workflow.steps[e.step ?? '']?.kind === 'review';
      if (v % 13 === 12) return agentData('done', { schema_checked: false });
      if (review)
        return reviewData(
          v % 5 === 0 ? 'request_changes' : 'approve',
          c.flag % 7 === 0 ? 'h-other' : `h${sim.s.revision}`,
        );
      const statuses = [
        'done',
        'done',
        'done',
        'done',
        'done',
        'done',
        'done',
        'done',
        'needs_input',
        'needs_context',
        'blocked',
      ] as const;
      return agentData(statuses[v % statuses.length], { questions: ['?'] });
    }
    case 'run_gates':
      return gatesData({
        build: v % 9 !== 0,
        unit: v % 11 !== 0,
        lint: v % 2 === 0,
      });
    case 'prepare':
      return PREPARE_DATA;
    case 'publish':
      return publishData(
        v % 7 === 0 ? 'h-other' : `h${sim.s.revision}`,
        c.flag % 4 !== 0,
        sim.s.task.base_branch,
      );
    case 'create_pr':
      return { pr_ref: 'acme#1', head_sha: sim.s.head_sha ?? 'h1' };
    case 'mark_ready':
      return { pr_ref: 'acme#1', ready_at: v % 2 === 0 ? 1 : null };
    case 'post_review':
      return {
        attempt_id: 'a1',
        outcome: (['posted', 'not_posted', 'unknown'] as const)[v % 3],
        review_id: v % 3 === 0 ? v : null,
        inline: 0,
        detail: null,
      };
    case 'rerun_ci':
      return { head_sha: sim.s.head_sha ?? 'h1', rerun_checks: [] };
    case 'await_ci': {
      const head = c.flag % 9 === 0 ? 'stale' : (sim.s.head_sha ?? 'h1');
      const checks: Record<string, Check['state']> = {};
      CHECK_NAMES.forEach((n, i) => {
        if ((v >> i) % 7 !== 0)
          checks[n] =
            c.flag % 3 === 0
              ? (CHECK_STATES[(v + i * 3) % CHECK_STATES.length] as Check['state'])
              : 'success';
      });
      const complete = c.flag % 6 !== 0;
      const extra =
        c.flag % 3 === 0
          ? {
              base_relation: {
                head_sha: head,
                base_ref: sim.s.task.base_branch,
                base_sha: 'b2',
                head_contains_base: c.flag % 2 === 0,
              },
            }
          : {};
      return ciData(head, checks, { names: Object.keys(checks).slice(0, v % 3), complete }, extra);
    }
    case 'merge':
      return { merged: v % 5 !== 0, merge_sha: 'm1' };
    case 'stop_attempt':
      return { stopped: true };
    case 'reconcile':
    case 'observe_external':
      return {};
  }
}

/** Failure mix used with `failureFocus`: mostly quality classes, so streaks build up and escalate. */
const FOCUS_CLASSES: FailureClass[] = [
  'quality',
  'quality',
  'quality',
  'invalid_output',
  'invalid_output',
  'rate_limit',
  'infra',
  'timeout',
];

function failureData(c: Choice, focus = false): Record<string, unknown> {
  // Independent of the bits that pick the outcome (variant), invocation (flag % 4) and signature (flag % 3).
  const classes = focus ? FOCUS_CLASSES : FAILURE_CLASSES;
  const cls = classes[Math.floor(c.flag / 60) % classes.length];
  const usage =
    c.flag % 5 === 0
      ? {}
      : {
          usage: c.flag % 2 === 0 ? { basis: 'unavailable' } : { basis: 'reported', tokens: 10 },
        };
  return {
    failure_class: cls,
    signature: `sig${c.flag % 3}`,
    invoked: c.flag % 4 !== 0,
    ...usage,
  };
}

function actions(sim: Sim, run: Run, c: Choice): Action[] {
  const s = sim.state;
  if (s === null) return [];
  const out: Action[] = [];
  const effects = Object.values(s.effects);
  for (const e of effects) {
    if (e.status === 'pending') {
      // Usually claim and return immediately; occasional claim-only actions leave effects running.
      const okBelow = run.opts.failureFocus === true ? 10 : 17;
      const outcome =
        c.variant % 20 < okBelow ? 'succeeded' : c.variant % 20 < 19 ? 'failed' : 'unknown';
      const step = (): { decision?: Decision; claim: ClaimResult } => {
        const claim = sim.claim(e.id);
        if (!claim.ok) return { claim };
        const data =
          outcome === 'succeeded'
            ? successData(sim, e, c)
            : outcome === 'failed'
              ? failureData(c, run.opts.failureFocus)
              : undefined;
        return { claim, decision: sim.result(e.id, outcome, data) };
      };
      out.push(
        { label: `run:${e.kind}`, run: step },
        { label: `run:${e.kind}`, run: step },
        { label: `run:${e.kind}`, run: step },
      );
      if (c.flag % 3 === 0)
        out.push({
          label: `claim:${e.kind}`,
          run: () => ({ claim: sim.claim(e.id) }),
        });
    }
    if (e.status === 'started') {
      out.push({
        label: `ok:${e.kind}`,
        run: () => ({
          decision: sim.result(e.id, 'succeeded', successData(sim, e, c)),
        }),
      });
      out.push({
        label: `ok:${e.kind}`,
        run: () => ({
          decision: sim.result(e.id, 'succeeded', successData(sim, e, c)),
        }),
      });
      out.push({
        label: `fail:${e.kind}`,
        run: () => ({
          decision: sim.result(e.id, 'failed', failureData(c, run.opts.failureFocus)),
        }),
      });
      if (c.flag % 2 === 0)
        out.push({
          label: `unknown:${e.kind}`,
          run: () => ({ decision: sim.result(e.id, 'unknown') }),
        });
    }
    if (e.status === 'unknown' || (e.status === 'started' && c.flag % 7 === 0)) {
      const findings = [
        'executed_succeeded',
        'executed_succeeded',
        'executed_failed',
        'not_executed',
        'still_unknown',
      ] as const;
      const f = findings[c.variant % findings.length] as (typeof findings)[number];
      out.push({
        label: `reconcile:${e.kind}:${f}`,
        run: () => ({
          decision: sim.reconciled(
            e.id,
            f,
            f === 'executed_succeeded'
              ? c.flag % 5 === 0
                ? {}
                : { data: successData(sim, e, c) }
              : f === 'executed_failed'
                ? {
                    failure_class: FAILURE_CLASSES[c.variant % 8] as FailureClass,
                    ...(c.flag % 2 === 0 ? { signature: 's' } : {}),
                  }
                : {},
          ),
        }),
      });
    }

    if (e.status === 'succeeded' || e.status === 'failed' || e.status === 'invalidated') {
      if (c.flag % 11 === 0)
        out.push({
          label: `stale:${e.kind}`,
          run: () => ({
            decision: sim.result(e.id, 'succeeded', successData(sim, e, c)),
          }),
        });
    }
  }
  for (const t of Object.values(s.timers)) {
    if (t.status !== 'armed') continue;
    // Keep the task deadline late enough to exercise the workflow while other timers remain available.
    if (t.kind === 'deadline' && c.variant % 19 !== 0) continue;
    out.push({
      label: `timer:${t.kind}`,
      run: () => {
        if (sim.now < t.due_at) sim.now = t.due_at;
        return { decision: sim.fire(t.id) };
      },
    });
  }
  for (const q of Object.values(s.questions)) {
    if (q.status === 'open' || c.flag % 5 === 0) {
      out.push({
        label: 'answer',
        run: () => ({
          decision: sim.when({
            kind: 'answer',
            question_id: q.id as Uuid,
            answer: `a${c.variant}`,
          }),
        }),
      });
    }
  }
  for (const a of Object.values(s.approvals)) {
    if (a.status !== 'requested') continue;
    const head = c.flag % 8 === 0 ? 'wrong' : (a.head_sha ?? undefined);
    const t = (k: 'approve' | 'reject'): Trigger => ({
      kind: k,
      approval_request_id: a.id as Uuid,
      ...(head !== undefined ? { head_sha: head } : {}),
    });
    out.push({
      label: 'approve',
      run: () => ({ decision: sim.when(t('approve')) }),
    });
    if (c.variant % 6 === 0)
      out.push({
        label: 'reject',
        run: () => ({ decision: sim.when(t('reject')) }),
      });
  }
  for (const a of Object.values(s.attempts)) {
    if (a.status === 'running' && c.variant % 9 === 0) {
      out.push({
        label: 'stop_attempt',
        run: () => ({
          decision: sim.when({
            kind: 'stop_attempt',
            attempt_id: a.id as Uuid,
            reason: 'test',
          }),
        }),
      });
    }
  }
  if (s.source_drift?.safe_boundary_reached) {
    if (run.opts.driftFocus === true) out.length = 0;
    const choice = (['continue_old', 'apply_new', 'apply_new', 'new_task'] as const)[
      c.variant % 4
    ] as 'continue_old' | 'apply_new' | 'new_task';
    const drift = s.source_drift;
    out.push({
      label: `drift:${choice}`,
      run: () => ({
        decision: sim.when({
          kind: 'drift_choice',
          choice,
          ...(choice === 'apply_new' ? { freeze: freezeOk(drift.task, run.policy) } : {}),
        }),
      }),
    });
  }
  if (c.variant % (run.opts.driftEvery ?? 17) === 0) {
    out.push({
      label: 'source_updated',
      run: () => ({
        decision: sim.when({
          kind: 'source_updated',
          task: { ...run.task, description: `rev ${c.flag}` },
        }),
      }),
    });
  }
  if (c.variant % 29 === 0)
    out.push({
      label: 'cancel',
      run: () => ({ decision: sim.when({ kind: 'cancel', reason: 'test' }) }),
    });
  if (c.variant % 23 === 0) {
    out.push({
      label: 'advance',
      run: () => {
        sim.advance(30 * 60_000);
        const ds = sim.fireDue();
        return ds.length > 0 ? { decision: ds[ds.length - 1] as Decision } : {};
      },
    });
  }
  return out;
}

/**
 * Sim checks deterministic decisions and immutable inputs. Retain before/after states for
 * invariant checks.
 */
export function drive(
  policy: PolicyOptions,
  taskOver: Partial<CanonicalTask>,
  choices: readonly Choice[],
  seed = 1,
  opts: DriveOptions = {},
): Run {
  const task = buildTask(taskOver);
  const sim = started(task, { policy, seed });
  const run: Run = { sim, trace: [], policy, task, opts };
  for (const c of choices) {
    const acts = actions(sim, run, c);
    if (acts.length === 0) break;
    const act = acts[c.pick % acts.length] as Action;
    const before = sim.state === null ? null : structuredClone(sim.state);
    const policyBefore = sim.policy;
    const decisionsBefore = sim.decisions.length;
    const r = act.run();
    // advance may fire several timers; each trace entry uses the final state.
    const extra = sim.decisions.length - decisionsBefore;
    run.trace.push({
      kind: r.claim !== undefined && r.decision === undefined ? 'claim' : 'decide',
      label: act.label,
      before,
      policyBefore,
      after: sim.state === null ? null : structuredClone(sim.state),
      decision: r.decision ?? null,
      claim: r.claim ?? null,
      trigger:
        extra === 1
          ? ((sim.log.at(-1) as { envelope?: { trigger: Trigger } }).envelope?.trigger ?? null)
          : null,
      ids: 8,
      now: sim.now,
    });
  }
  return run;
}

export function eventsOf(e: TraceEntry): DomainEventDraft[] {
  return e.decision?.kind === 'accepted' ? e.decision.events : [];
}

export function walk(
  events: readonly DomainEventDraft[],
  fn: (before: TaskState | null, ev: DomainEventDraft, after: TaskState, i: number) => void,
): void {
  let s: TaskState | null = null;
  events.forEach((ev, i) => {
    const next = evolve(s, ev);
    fn(s, ev, next, i);
    s = next;
  });
}
