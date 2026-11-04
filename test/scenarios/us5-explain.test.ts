import { afterEach, describe, expect, it } from 'vitest';
import type { EpochMs } from '../../src/shared/brand.ts';
import { canonicalJson } from '../../src/shared/canonical-json.ts';
import type { DomainEvent } from '../../src/domain/event.ts';
import type { FailureClass } from '../../src/domain/trigger.ts';
import { replay } from '../../src/engine/evolve.ts';
import { explain } from '../../src/index.ts';
import { buildTask, type PolicyOptions } from '../support/builders.ts';
import { checkWaitExplained } from '../support/explain-check.ts';
import {
  agentData,
  expectAccepted,
  gatesData,
  reviewData,
  Sim,
  started,
  toCode,
  USAGE,
} from '../support/scenario.ts';

const TASK = buildTask();
const XS_TASK = buildTask({ size: 'XS' });
let sims: Sim[] = [];

afterEach(() => {
  for (const s of sims) s.replayCheck();
  sims = [];
});

function run(policy: PolicyOptions = {}, task = TASK): Sim {
  const sim = started(task, { policy });
  sims.push(sim);
  return sim;
}

function fail(
  sim: Sim,
  effectId: string,
  failure_class: FailureClass,
  extra: Record<string, unknown> = {},
): void {
  sim.complete(effectId, 'failed', {
    failure_class,
    invoked: true,
    usage: USAGE,
    ...extra,
  });
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}

function explainOf(sim: Sim, now?: number) {
  const input = deepFreeze(
    structuredClone({ state: sim.s, events: sim.events, policy: sim.policy }),
  );
  const a = explain(input.state, input.events, input.policy, now as EpochMs | undefined);
  const b = explain(input.state, input.events, input.policy, now as EpochMs | undefined);
  expect(canonicalJson(a)).toBe(canonicalJson(b));

  const rebuilt = replay(input.events);
  if (rebuilt === null) throw new Error('empty log');
  expect(
    canonicalJson(explain(rebuilt, input.events, input.policy, now as EpochMs | undefined)),
  ).toBe(canonicalJson(a));
  return a;
}

function bySeq(sim: Sim, seq: number): DomainEvent {
  const e = sim.events.find((x) => x.seq === seq);
  if (e === undefined) throw new Error(`no event seq ${seq}`);
  return e;
}

describe('US5 - Explain task state from recorded facts', () => {
  it('Scenario 1: explains wait reasons, resume conditions, exits, and remaining limits', () => {
    const sim = run({ limits: { max_agent_runs: 2, max_wall_ms: 3_600_000 } }, XS_TASK);
    sim.complete(toCode(sim).id, 'succeeded', agentData('done'));
    sim.complete(
      sim.pendingOne('run_gates').id,
      'succeeded',
      gatesData({ build: true, unit: false }),
    );
    sim.complete(sim.pendingOne('start_agent').id, 'succeeded', agentData('done'));
    sim.complete(
      sim.pendingOne('run_gates').id,
      'succeeded',
      gatesData({ build: true, unit: false }),
    );
    expect(sim.s.status).toBe('WAITING');

    const deadline = sim.s.deadline_at as number;
    const x = explainOf(sim, sim.now + 1_000);
    expect(x).toMatchObject({
      status: 'WAITING',
      step: 'fix_gates',
      wait: {
        reason: 'policy',
        detail: { code: 'agent_runs_exhausted', step: 'fix_gates' },
        resume_when: ['amend'],
        exit_paths: ['cancel'],
      },
      remaining: {
        agent_runs: 0,
        reserved: 0,
        wall_ms: deadline - sim.now - 1_000,
        escalations: sim.s.budget.escalations.limit,
      },
      escalations: [],
      pending_effects: [],
      cancellation: null,
    });

    const requested = sim.events.flatMap((e) => (e.type === 'AttemptRequested' ? [e.payload] : []));
    expect(x.bindings_used).toEqual(
      requested.map((p) => ({
        step: p.step,
        rung: p.rung,
        binding: p.binding,
        requested: 1,
        invoked: 1,
      })),
    );

    expect(sim.s.budget.agent_runs.used + (x.remaining.agent_runs ?? Infinity)).toBe(
      sim.policy?.limits.max_agent_runs,
    );

    expect(explainOf(sim).remaining.wall_ms).toBeNull();
    sim.advance(3_600_000).fireDue();
    expect(explainOf(sim)).toMatchObject({
      wait: { reason: 'policy', detail: { code: 'deadline' } },
      remaining: { wall_ms: 0 },
    });
  });

  it('Scenario 1b: human and rate-limit waits include resume conditions and outstanding effects', () => {
    const asked = run();
    asked.complete(
      toCode(asked).id,
      'succeeded',
      agentData('needs_input', { questions: ['Use PostgreSQL or SQLite?'] }),
    );
    const q = explainOf(asked);
    expect(q.wait).toMatchObject({
      reason: 'human_input',
      detail: { code: 'agent_question' },
    });
    expect(q.wait?.resume_when.length).toBeGreaterThan(0);
    expect(q.wait?.exit_paths).toContain('cancel');

    const limited = run();
    const agent = toCode(limited);
    expect(explainOf(limited).pending_effects).toEqual([
      { id: agent.id, kind: 'start_agent', status: 'pending' },
    ]);
    limited.claim(agent.id);
    expect(explainOf(limited).pending_effects).toEqual([
      { id: agent.id, kind: 'start_agent', status: 'started' },
    ]);
    expect(explainOf(limited).remaining.reserved).toBe(1);
    limited.result(agent.id, 'failed', {
      failure_class: 'rate_limit',
      invoked: true,
      usage: USAGE,
      reset_at: limited.now + 60_000,
    });
    expect(explainOf(limited)).toMatchObject({
      wait: { reason: 'rate_limit', detail: { code: 'rate_limited' } },
      pending_effects: [],
      remaining: { reserved: 0 },
    });
  });

  it('Scenario 2: lists rung raises with failure signatures and their triggering events', () => {
    const fixer = {
      model: 'sonnet',
      effort: 'medium' as const,
      ladder: [{ effort: 'high' as const }, { model: 'opus', effort: 'high' as const }],
      scope: 'task' as const,
    };
    const sim = run({ roles: { fixer }, escalation: { auto_up_to_tier: 3 } });

    toCode(sim);
    fail(sim, sim.pendingOne('start_agent').id, 'quality', { signature: 'C1' });
    fail(sim, sim.pendingOne('start_agent').id, 'quality', { signature: 'C1' });
    sim.complete(sim.pendingOne('start_agent').id, 'succeeded', agentData('done'));

    sim.complete(
      sim.pendingOne('run_gates').id,
      'succeeded',
      gatesData({ build: true, unit: false }),
    );
    fail(sim, sim.pendingOne('start_agent').id, 'quality', { signature: 'F1' });
    fail(sim, sim.pendingOne('start_agent').id, 'quality', { signature: 'F1' });
    sim.complete(sim.pendingOne('start_agent').id, 'succeeded', agentData('done'));
    sim.complete(
      sim.pendingOne('run_gates').id,
      'succeeded',
      gatesData({ build: true, unit: true, lint: true }),
    );
    sim.complete(
      sim.pendingOne('start_agent').id,
      'succeeded',
      reviewData('request_changes', 'h1', {
        findings: [{ severity: 'major', msg: 'missing test' }],
      }),
    );

    const x = explainOf(sim);
    const raised = sim.events.filter((e) => e.type === 'RungRaised');
    expect(x.escalations.map((e) => e.event_seq)).toEqual(raised.map((e) => e.seq));
    expect(
      x.escalations.map(({ step, from, to, reason, signature }) => ({
        step,
        from,
        to,
        reason,
        signature,
      })),
    ).toEqual([
      { step: 'code', from: 0, to: 1, reason: 'quality', signature: 'C1' },
      { step: 'fix_gates', from: 0, to: 1, reason: 'quality', signature: 'F1' },
      { step: 'review', from: 0, to: 1, reason: 'floor', signature: null },
      { step: 'fix_review', from: 0, to: 1, reason: 'floor', signature: null },
    ]);
    for (const e of x.escalations) {
      expect(e.trigger_seq).not.toBeNull();
      const trigger = bySeq(sim, e.trigger_seq as number);
      expect(trigger.seq).toBeLessThan(e.event_seq);
      if (e.reason === 'quality') {
        expect(trigger).toMatchObject({
          type: 'FailureClassified',
          payload: {
            step: e.step,
            rung: e.from,
            signature: e.signature,
            escalate: true,
          },
        });
      } else {
        expect(trigger).toMatchObject({
          type: 'TaskFloorRaised',
          payload: { step: 'fix_gates', reason: 'scope_task' },
        });
      }
    }
    expect(x.remaining.escalations).toBe(
      (sim.s.budget.escalations.limit ?? Infinity) - raised.length,
    );
    expect(x.bindings_used.filter((b) => b.step === 'code')).toEqual([
      {
        step: 'code',
        rung: 0,
        binding: expect.any(String) as string,
        requested: 2,
        invoked: 2,
      },
      {
        step: 'code',
        rung: 1,
        binding: 'sonnet/high',
        requested: 1,
        invoked: 1,
      },
    ]);
  });

  it('unlaunched cancelled attempts and unknown attempts do not count as invoked', () => {
    const cancelled = run();
    toCode(cancelled);
    expectAccepted(cancelled.when({ kind: 'cancel', reason: 'No longer needed' }));
    expect(cancelled.s.budget.agent_runs.used).toBe(0);
    expect(explainOf(cancelled).bindings_used).toEqual([
      {
        step: 'code',
        rung: 0,
        binding: expect.any(String) as string,
        requested: 1,
        invoked: 0,
      },
    ]);

    const unknown = run();
    unknown.complete(toCode(unknown).id, 'unknown');
    expect(explainOf(unknown).bindings_used).toMatchObject([
      { step: 'code', requested: 1, invoked: 0 },
    ]);
  });

  it('bindings_used follows log order rather than projection key order', () => {
    const sim = run({ escalation: { auto_up_to_tier: 3 } });
    toCode(sim);
    fail(sim, sim.pendingOne('start_agent').id, 'quality', { signature: 'C1' });
    fail(sim, sim.pendingOne('start_agent').id, 'quality', { signature: 'C1' });
    const x = explainOf(sim);
    expect(x.bindings_used.map((b) => b.rung)).toEqual([0, 1]);
    // Canonical storage sorts keys by ID; reversing projection key order must not change the explanation.
    const reordered = structuredClone(sim.s);
    reordered.attempts = Object.fromEntries(Object.entries(reordered.attempts).reverse());
    expect(explain(reordered, sim.events, sim.policy)).toEqual(x);
  });

  it('records cancellation and its request time in the explanation', () => {
    const sim = run();
    toCode(sim);
    expectAccepted(sim.when({ kind: 'cancel', reason: 'No longer needed' }));
    expect(explainOf(sim)).toMatchObject({
      status: 'CANCELLED',
      wait: null,
      cancellation: { requested_at: sim.now, late: false },
    });
  });

  it('SC-006: every scenario wait has nonempty resume_when and exit_paths', () => {
    // Sim checks SC-006 after every write. This test verifies that the shared scenario hook actually detects violations.

    const sim = run();
    sim.complete(toCode(sim).id, 'succeeded', agentData('needs_input', { questions: ['?'] }));
    expect(sim.waits.length).toBeGreaterThan(0);
    for (const w of sim.waits) {
      expect(w.wait?.resume_when.length).toBeGreaterThan(0);
      expect(w.wait?.exit_paths.length).toBeGreaterThan(0);
    }
    const broken = structuredClone(sim.s);
    if (broken.wait === null) throw new Error('expected a wait');
    broken.wait.exit_paths = [];
    expect(() => checkWaitExplained(broken, sim.events, sim.policy)).toThrow(/exit_paths/);
    broken.wait = null;
    expect(() => checkWaitExplained(broken, sim.events, sim.policy)).toThrow(/SC-006/);
  });

  it('explains PENDING tasks before a policy exists', () => {
    const sim = new Sim(buildTask({ acceptance: [] }).id);
    sims.push(sim);
    expectAccepted(sim.when({ kind: 'create_task', task: buildTask({ acceptance: [] }) }));
    const x = explainOf(sim);
    expect(sim.policy).toBeNull();
    expect(x).toMatchObject({
      status: 'PENDING',
      step: null,
      wait: { reason: 'needs_info' },
      remaining: { wall_ms: null },
      bindings_used: [],
    });
  });
});
