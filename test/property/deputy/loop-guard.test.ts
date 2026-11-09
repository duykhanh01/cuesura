import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Incident } from '../../../src/engine/loop-signals.ts';
import {
  exhaustion,
  loopGuard,
  trialAction,
  trialBound,
  trialTable,
  type GuardFacts,
  type TrialFact,
} from '../../../src/engine/trials.ts';

// 007 T041 (FR-042–FR-044, R-19, SC-009): the three anti-loop rules over the trial table.

const SIG = 'sig-S';

type Cmd = { kind: string; payload: unknown };

const CMDS = (models: readonly string[], targets: readonly string[]): Cmd[] => [
  { kind: 'task_continue', payload: {} },
  { kind: 'task_amend_policy', payload: { agent_runs_delta: 2 } },
  { kind: 'task_amend_policy', payload: { deadline: { extend_ms: 3_600_000 } } },
  ...models.map((m) => ({ kind: 'task_amend_policy', payload: { model: m } })),
  { kind: 'task_message', payload: { body: 'try the other parser' } },
  { kind: 'task_message', payload: { body: 'use a table-driven test instead' } },
  ...targets.map((t) => {
    const [kind, key] = t.split(':');
    return { kind: 'task_waive', payload: { target: { kind, key }, evidence: 'e' } };
  }),
  { kind: 'task_recheck', payload: {} },
  { kind: 'answer', payload: {} },
];

/** A unit where nothing moves: every trial's next incident is the same failure on the same tree. */
class Unit {
  facts: (TrialFact & { request_id: string; at: number })[] = [];
  incidents: Incident[] = [];
  directives: number[] = [];
  confirms: number[] = [];
  seq = 1;
  readonly models: readonly string[];
  readonly waivable: readonly string[];
  constructor(models: readonly string[], waivable: readonly string[], ran: string | null = null) {
    this.models = models;
    this.waivable = waivable;
    if (ran !== null) this.incident(ran);
  }
  incident(model: string | null = null, o: Partial<Incident> = {}): void {
    this.incidents.push({
      task_id: 't1',
      global_seq: this.seq++,
      revision: 1,
      code: 'loop_exhausted',
      step: 'fix',
      signature: SIG,
      errors: 3,
      tree: 'tree-1',
      model,
      ...o,
    });
  }
  guard(): GuardFacts {
    const trials = trialTable(this.facts, this.incidents);
    return {
      signature: SIG,
      trials,
      history: { incidents: this.incidents, checkpoints: [], directives: this.directives },
      plan_confirms: this.confirms,
      models: this.models,
      waivable: this.waivable,
      rung_pending: null,
    };
  }
  send(c: Cmd, taskId = 't1'): ReturnType<typeof loopGuard> {
    const action = trialAction(c.kind, c.payload);
    const refused = loopGuard(this.guard(), c.kind, action);
    if (refused === null && action !== null) {
      this.facts.push({
        hypothesis: 'h',
        expect: 'e',
        action_kind: action.action,
        params: action.params,
        signature: SIG,
        goal_id: 'g',
        unit_key: 'u',
        task_id: taskId,
        global_seq: this.seq++,
        errors: 3,
        tree: 'tree-1',
        request_id: `r${this.facts.length}`,
        at: this.seq,
      });
      this.incident();
    }
    return refused;
  }
}

const models = fc.uniqueArray(fc.constantFrom('haiku', 'sonnet', 'opus', 'gpt'), {
  minLength: 1,
  maxLength: 4,
});
const targets = fc.uniqueArray(
  fc.constantFrom('finding:k1', 'finding:k2', 'gate:unit', 'check:ci'),
  {
    maxLength: 3,
  },
);

describe('loop guard without progress (SC-009)', () => {
  it('admits a bounded number of commands, then only task fail or a handover', () => {
    fc.assert(
      fc.property(
        models,
        targets,
        fc.array(fc.nat(), { minLength: 1, maxLength: 80 }),
        (ms, ts, picks) => {
          const unit = new Unit(ms, ts, ms[0] ?? null);
          const pool = CMDS(ms, ts);
          let admitted = 0;
          for (const p of picks) {
            const c = pool[p % pool.length] as Cmd;
            if (unit.send(c) === null && trialAction(c.kind, c.payload) !== null) admitted += 1;
          }
          expect(admitted).toBeLessThanOrEqual(trialBound(unit.guard()));
          // Every kind tried once more drives the signature to exhaustion.
          for (const c of pool) unit.send(c);
          const f = unit.guard();
          expect(exhaustion(f).all).toBe(true);
          for (const c of pool)
            expect(loopGuard(f, c.kind, trialAction(c.kind, c.payload))).not.toBeNull();
          expect(loopGuard(f, 'task_fail', null)).toBeNull();
          expect(loopGuard(f, 'deputy_handoff', null)).toBeNull();
        },
      ),
    );
  });
});

describe('the three rules', () => {
  it('rule 1: the same action and parameters again is a repeat without evidence', () => {
    const unit = new Unit(['sonnet', 'opus'], [], 'sonnet');
    expect(unit.send({ kind: 'task_continue', payload: {} })).toBeNull();
    expect(unit.send({ kind: 'task_continue', payload: {} })).toMatchObject({
      reason: 'repeat_without_evidence',
      prior: { action_kind: 'extend' },
    });
  });

  it('rule 2: a message in other words, or another limit, is the same kind and runs out', () => {
    const unit = new Unit(['sonnet'], [], 'sonnet');
    expect(unit.send({ kind: 'task_message', payload: { body: 'a' } })).toBeNull();
    expect(unit.send({ kind: 'task_message', payload: { body: 'b' } })).toMatchObject({
      reason: 'action_exhausted',
    });
    expect(unit.send({ kind: 'task_amend_policy', payload: { agent_runs_delta: 1 } })).toBeNull();
    expect(
      unit.send({ kind: 'task_amend_policy', payload: { deadline: { at: 9 } } }),
    ).toMatchObject({ reason: 'action_exhausted' });
  });

  it('rule 2: a model only once per signature, the one that failed included, and only allowed ones', () => {
    const unit = new Unit(['sonnet', 'opus'], [], 'sonnet');
    expect(unit.send({ kind: 'task_amend_policy', payload: { model: 'sonnet' } })).toMatchObject({
      reason: 'action_exhausted',
    });
    expect(unit.send({ kind: 'task_amend_policy', payload: { model: 'gpt' } })).toMatchObject({
      reason: 'action_exhausted',
    });
    expect(unit.send({ kind: 'task_amend_policy', payload: { model: 'opus' } })).toBeNull();
    expect(unit.send({ kind: 'task_amend_policy', payload: { model: 'opus' } })).not.toBeNull();
  });

  it('rule 2: each target waived once per signature, even after new evidence', () => {
    const unit = new Unit(['sonnet'], ['gate:unit'], 'sonnet');
    const waive = { kind: 'task_waive', payload: { target: { kind: 'gate', key: 'unit' } } };
    expect(unit.send(waive)).toBeNull();
    unit.directives.push(unit.seq++);
    expect(unit.send(waive)).toMatchObject({ reason: 'action_exhausted' });
  });

  it('rule 3: everything spent leaves only fail and handover, for every command', () => {
    const unit = new Unit(['sonnet'], [], 'sonnet');
    unit.send({ kind: 'task_continue', payload: {} });
    unit.send({ kind: 'task_message', payload: { body: 'x' } });
    expect(unit.send({ kind: 'task_recheck', payload: {} })).toMatchObject({
      reason: 'signature_exhausted',
    });
    expect(unit.send({ kind: 'answer', payload: {} })).toMatchObject({
      reason: 'signature_exhausted',
    });
  });
});

describe('new evidence', () => {
  const spent = () => {
    const unit = new Unit(['sonnet'], [], 'sonnet');
    unit.send({ kind: 'task_continue', payload: {} });
    unit.send({ kind: 'task_message', payload: { body: 'x' } });
    expect(exhaustion(unit.guard()).all).toBe(true);
    return unit;
  };

  it("an owner's instruction or a plan version the owner confirmed reopens the same action", () => {
    const a = spent();
    a.directives.push(a.seq++);
    expect(a.send({ kind: 'task_continue', payload: {} })).toBeNull();
    const b = spent();
    b.confirms.push(b.seq++);
    expect(b.send({ kind: 'task_message', payload: { body: 'x' } })).toBeNull();
  });

  it('measured progress reopens it; a new tree alone, or the deputy rewording, does not', () => {
    const unit = new Unit(['sonnet'], [], 'sonnet');
    unit.send({ kind: 'task_continue', payload: {} });
    // The next incident of that trial: another tree but the same failure and as many errors.
    unit.incidents[unit.incidents.length - 1] = {
      ...(unit.incidents.at(-1) as Incident),
      tree: 'tree-2',
    };
    expect(unit.send({ kind: 'task_continue', payload: {} })).not.toBeNull();
    // Fewer errors on another tree is progress.
    unit.incidents[unit.incidents.length - 1] = {
      ...(unit.incidents.at(-1) as Incident),
      tree: 'tree-2',
      errors: 1,
    };
    expect(unit.send({ kind: 'task_continue', payload: {} })).toBeNull();
  });

  it('a task that replaces the unit inherits its trials', () => {
    const unit = new Unit(['sonnet'], [], 'sonnet');
    unit.send({ kind: 'task_continue', payload: {} }, 'old-task');
    expect(unit.send({ kind: 'task_continue', payload: {} }, 'new-task')).toMatchObject({
      reason: 'repeat_without_evidence',
      prior: { task_id: 'old-task' },
    });
  });
});
