import { afterEach, describe, expect, it } from 'vitest';
import type { Uuid } from '../../src/shared/brand.ts';
import type { DomainEventDraft } from '../../src/domain/event.ts';
import type { Attempt } from '../../src/domain/state.ts';
import { FrozenPolicySchema } from '../../src/domain/policy.ts';
import { UsageSchema, type FailureClass } from '../../src/domain/trigger.ts';
import { available } from '../../src/engine/budget.ts';
import { buildPolicy, buildTask, type PolicyOptions } from '../support/builders.ts';
import {
  agentData,
  gatesData,
  PREPARE_DATA,
  reviewData,
  Sim,
  started,
  toCode,
  USAGE,
} from '../support/scenario.ts';

const TASK = buildTask();
const XS_TASK = buildTask({ size: 'XS' });
let sims: Sim[] = [];

/** Every scenario must replay to the same events, decisions and state (SC-004). */
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

function attemptsOf(sim: Sim, step: string): Attempt[] {
  return Object.values(sim.s.attempts)
    .filter((a) => a.step === step)
    .sort((a, b) => a.n - b.n);
}

function latest(sim: Sim, step: string): Attempt {
  const a = attemptsOf(sim, step).at(-1);
  if (a === undefined) throw new Error(`no attempt for ${step}`);
  return a;
}

function eventsOf<T extends DomainEventDraft['type']>(
  sim: Sim,
  type: T,
  from = 0,
): Extract<DomainEventDraft, { type: T }>[] {
  return sim.events
    .slice(from)
    .filter(
      (e): e is Extract<DomainEventDraft, { type: T }> & (typeof sim.events)[number] =>
        e.type === type,
    );
}

function approvalId(sim: Sim): Uuid {
  return sim.s.wait?.detail['approval_id'] as Uuid;
}

/** Coder fails twice with the same quality signature, which asks for the next rung. */
function twoQualityFailures(sim: Sim, signature = 'C1'): void {
  fail(sim, sim.pendingOne('start_agent').id, 'quality', { signature });
  fail(sim, sim.pendingOne('start_agent').id, 'quality', { signature });
}

describe('US4 - Model escalation and budget under the approved policy', () => {
  it('unlimited runs and infra retries continue beyond the former retry cap without a task deadline', () => {
    const sim = run({
      limits: {
        max_agent_runs: null,
        max_wall_ms: null,
        max_escalations: null,
        classes: { infra_retries: null },
        backoff: {
          infra: { base_ms: 1, factor: 2, max_ms: 100, max_attempts: null },
        },
      },
    });
    toCode(sim);
    expect(sim.s.deadline_at).toBeNull();
    expect(available(sim.s.budget)).toBe(Infinity);
    sim.advance(30 * 86_400_000);
    for (let i = 0; i < 8; i++) {
      fail(sim, sim.pendingOne('start_agent').id, 'infra');
      sim.advance(1000).fireDue();
      expect(sim.s.status).toBe('RUNNING');
    }
    expect(sim.s.budget.agent_runs).toMatchObject({
      limit: null,
      used: 8,
      reserved: 1,
    });
  });

  it('Scenario 1: two consecutive quality failures with the same signature move to the next auto rung', () => {
    const sim = run();
    toCode(sim);
    fail(sim, sim.pendingOne('start_agent').id, 'quality', { signature: 'S1' });
    expect(latest(sim, 'code')).toMatchObject({
      rung: 0,
      kind: 'retry',
      status: 'running',
    });

    const before = sim.events.length;
    fail(sim, sim.pendingOne('start_agent').id, 'quality', { signature: 'S1' });
    expect(eventsOf(sim, 'RungRaised', before).map((e) => e.payload)).toEqual([
      { step: 'code', from: 0, to: 1, reason: 'quality', signature: 'S1' },
    ]);
    expect(eventsOf(sim, 'ApprovalRequested', before)).toEqual([]);
    expect(latest(sim, 'code')).toMatchObject({
      rung: 1,
      binding: 'sonnet/high',
      status: 'running',
    });
    expect(sim.s.status).toBe('RUNNING');
  });

  it('Scenario 2: a needs_approval rung without a valid approval waits for approval and starts no attempt', () => {
    const sim = run({
      roles: {
        coder: {
          model: 'sonnet',
          effort: 'medium',
          ladder: [{ model: 'opus', effort: 'high' }],
        },
      },
    });
    toCode(sim);
    twoQualityFailures(sim);
    expect(sim.s.status).toBe('WAITING');
    expect(sim.s.wait).toMatchObject({
      reason: 'approval',
      detail: {
        code: 'escalation',
        approval_kind: 'escalation',
        step: 'code',
        rung: 1,
      },
    });
    expect(sim.effects('start_agent', 'pending')).toEqual([]);
    expect(attemptsOf(sim, 'code')).toHaveLength(2);
    expect(sim.s.rungs.by_step['code'] ?? 0).toBe(0);

    sim.when({ kind: 'approve', approval_request_id: approvalId(sim) });
    expect(latest(sim, 'code')).toMatchObject({
      rung: 1,
      binding: 'opus/high',
      status: 'running',
    });
  });

  it('Scenario 3: rate limit and infra failures neither count as quality failures nor escalate; they retry on the same rung after a timer', () => {
    const limited = run();
    toCode(limited);
    const resetAt = limited.now + 120_000;
    fail(limited, limited.pendingOne('start_agent').id, 'rate_limit', {
      reset_at: resetAt,
    });
    expect(limited.s.wait).toMatchObject({
      reason: 'rate_limit',
      detail: { code: 'rate_limited', due_at: resetAt },
    });
    expect(limited.armedTimers('backoff').map((t) => t.due_at)).toEqual([resetAt]);
    expect(limited.s.failure_streaks).toEqual({});
    expect(limited.effects('start_agent', 'pending')).toEqual([]);
    limited.advance(120_000).fireDue();
    expect(latest(limited, 'code')).toMatchObject({
      n: 2,
      rung: 0,
      kind: 'retry',
      status: 'running',
    });

    // A reset hours away is waited for too, instead of a wait only an amendment could end (#245).
    const far = run();
    toCode(far);
    const farReset = far.now + 5 * 3_600_000;
    fail(far, far.pendingOne('start_agent').id, 'rate_limit', { reset_at: farReset });
    expect(far.s.wait).toMatchObject({
      reason: 'rate_limit',
      detail: { code: 'rate_limited', due_at: farReset },
    });
    far.advance(5 * 3_600_000).fireDue();
    expect(latest(far, 'code')).toMatchObject({ n: 2, kind: 'retry', status: 'running' });

    const infra = run();
    toCode(infra);
    fail(infra, infra.pendingOne('start_agent').id, 'infra');
    expect(infra.s.wait).toMatchObject({
      reason: 'infra',
      detail: { code: 'infra_backoff' },
    });
    const due = infra.armedTimers('backoff')[0]?.due_at ?? 0;
    expect(due - infra.now).toBeGreaterThanOrEqual(5_000);
    expect(due - infra.now).toBeLessThanOrEqual(5_500);
    infra.advance(due - infra.now).fireDue();
    expect(latest(infra, 'code')).toMatchObject({
      n: 2,
      rung: 0,
      kind: 'retry',
    });
    expect(infra.s.failure_streaks).toEqual({});
    expect(eventsOf(infra, 'RungRaised')).toEqual([]);
  });

  it('Scenario 3b: a success on the step clears its infra and rate-limit counters, so the next outage starts afresh', () => {
    const sim = run();
    toCode(sim);
    fail(sim, sim.pendingOne('start_agent').id, 'infra');
    sim.advance(10_000).fireDue();
    fail(sim, sim.pendingOne('start_agent').id, 'rate_limit');
    expect(sim.s.class_counters).toMatchObject({
      'code#infra': 1,
      'code#rate_limit': 1,
    });
    sim.advance(10 * 60_000).fireDue();
    sim.complete(sim.pendingOne('start_agent').id, 'succeeded', agentData('done'));
    expect(sim.s.class_counters['code#infra']).toBeUndefined();
    expect(sim.s.class_counters['code#rate_limit']).toBeUndefined();
  });

  it('Scenario 3c: a prepare that reports success with a failed setup is an infra failure and keeps counting to the limit', () => {
    const sim = run();
    const setupFailed = {
      ...PREPARE_DATA,
      setup: { ran: true, passed: false },
    };
    for (let i = 1; i <= 3; i++) {
      sim.complete(sim.pendingOne('prepare').id, 'succeeded', setupFailed);
      expect(sim.s.class_counters['prepare#infra']).toBe(i);
      expect(eventsOf(sim, 'RetryCountersCleared')).toEqual([]);
      sim.advance(300_000).fireDue();
    }
    sim.complete(sim.pendingOne('prepare').id, 'succeeded', setupFailed);
    expect(sim.s.wait).toMatchObject({
      reason: 'policy',
      detail: { code: 'backoff_exhausted', class: 'infra', count: 4 },
    });
  });

  it('Scenario 3d: a reconcile probe that settles a failed run does not clear the retries the run spent', () => {
    const sim = run({ limits: { max_agent_runs: 10 } });
    toCode(sim);
    for (let i = 1; i <= 3; i++) {
      fail(sim, sim.pendingOne('start_agent').id, 'infra');
      sim.advance(300_000).fireDue();
    }
    const agent = sim.pendingOne('start_agent');
    sim.complete(agent.id, 'unknown');
    expect(sim.effects('reconcile', 'pending')).toHaveLength(1);
    sim.reconciled(agent.id, 'executed_failed', { failure_class: 'infra' });
    expect(eventsOf(sim, 'RetryCountersCleared')).toEqual([]);
    expect(sim.s.wait).toMatchObject({
      reason: 'policy',
      detail: { code: 'backoff_exhausted', class: 'infra', count: 4 },
    });
  });

  it('Scenario 4: with the agent run cap used up no new attempt starts and the task waits on policy', () => {
    const sim = run({ limits: { max_agent_runs: 2 } }, XS_TASK);
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
    expect(sim.s.budget.agent_runs).toMatchObject({
      limit: 2,
      used: 2,
      reserved: 0,
    });
    expect(sim.s.status).toBe('WAITING');
    expect(sim.s.wait).toMatchObject({
      reason: 'policy',
      detail: { code: 'agent_runs_exhausted', step: 'fix_gates' },
      resume_when: ['amend'],
    });
    expect(sim.effects('start_agent', 'pending')).toEqual([]);
  });

  it('Scenario 5: a revisited step keeps its higher rung; a step that has not run starts at its own floor', () => {
    const fixer = {
      model: 'sonnet',
      effort: 'medium' as const,
      ladder: [{ effort: 'high' as const }, { model: 'opus', effort: 'high' as const }],
      scope: 'task' as const,
    };
    const sim = run({ roles: { fixer }, escalation: { auto_up_to_tier: 3 } });
    sim.complete(toCode(sim).id, 'succeeded', agentData('done'));
    sim.complete(
      sim.pendingOne('run_gates').id,
      'succeeded',
      gatesData({ build: true, unit: false }),
    );
    fail(sim, sim.pendingOne('start_agent').id, 'quality', { signature: 'F1' });
    fail(sim, sim.pendingOne('start_agent').id, 'quality', { signature: 'F1' });
    expect(latest(sim, 'fix_gates').rung).toBe(1);
    expect(sim.s.rungs.floor_level).toEqual({ tier: 2, effort_rank: 2 });

    sim.complete(sim.pendingOne('start_agent').id, 'succeeded', agentData('done'));
    sim.complete(
      sim.pendingOne('run_gates').id,
      'succeeded',
      gatesData({ build: true, unit: true, lint: true }),
    );
    // Review has not run yet: it starts at the floor mapped onto the reviewer ladder.
    expect(latest(sim, 'review')).toMatchObject({
      n: 1,
      rung: 1,
      binding: 'sol/high',
    });
    sim.complete(
      sim.pendingOne('start_agent').id,
      'succeeded',
      reviewData('request_changes', 'h1', {
        findings: [{ severity: 'major', msg: 'missing test' }],
      }),
    );
    expect(latest(sim, 'fix_review')).toMatchObject({
      n: 1,
      rung: 1,
      binding: 'sonnet/high',
    });

    const before = sim.events.length;
    sim.complete(sim.pendingOne('start_agent').id, 'succeeded', agentData('done'));
    sim.complete(
      sim.pendingOne('run_gates').id,
      'succeeded',
      gatesData({ build: true, unit: false }),
    );
    expect(attemptsOf(sim, 'fix_gates').map((a) => a.rung)).toEqual([0, 0, 1, 1]);
    expect(eventsOf(sim, 'RungRaised', before)).toEqual([]);
    expect(sim.s.rungs.by_step).toEqual({
      fix_gates: 1,
      review: 1,
      fix_review: 1,
    });
  });

  it('Scenario 6: usage that cannot be measured is recorded as unavailable, never as zero', () => {
    const sim = run();
    toCode(sim);
    sim.complete(sim.pendingOne('start_agent').id, 'failed', {
      failure_class: 'infra',
      invoked: true,
    });
    const finished = eventsOf(sim, 'AttemptFinished').at(-1);
    expect(finished?.payload.usage).toEqual({ basis: 'unavailable' });
    expect(attemptsOf(sim, 'code')[0]?.usage).toEqual({ basis: 'unavailable' });

    sim.advance(10_000).fireDue();
    sim.complete(
      sim.pendingOne('start_agent').id,
      'succeeded',
      agentData('done', { usage: { basis: 'unavailable' } }),
    );
    expect(latest(sim, 'code').usage).toEqual({ basis: 'unavailable' });
    expect(UsageSchema.safeParse({ basis: 'unavailable', tokens: 0 }).success).toBe(false);
    expect(UsageSchema.safeParse({ basis: 'unavailable', cost: 0 }).success).toBe(false);
  });

  it.each(['auth_config', 'refused'] as const)(
    'Scenario 7: %s waits for a person with no new attempt and no escalation, budget notwithstanding',
    (cls) => {
      const sim = run();
      toCode(sim);
      fail(sim, sim.pendingOne('start_agent').id, cls);
      expect(sim.s.status).toBe('WAITING');
      expect(sim.s.wait).toMatchObject({
        reason: 'human_input',
        detail: { code: cls, class: cls },
      });
      expect(sim.effects('start_agent', 'pending')).toEqual([]);
      expect(attemptsOf(sim, 'code')).toHaveLength(1);
      expect(eventsOf(sim, 'RungRaised')).toEqual([]);
      expect(sim.s.failure_streaks).toEqual({});
      expect(available(sim.s.budget)).toBeGreaterThan(0);
    },
  );

  it('Scenario 8: a second consecutive timeout on the same rung moves to the next rung instead of waiting (#247)', () => {
    const sim = run();
    toCode(sim);
    fail(sim, sim.pendingOne('start_agent').id, 'timeout');
    expect(latest(sim, 'code')).toMatchObject({
      n: 2,
      kind: 'retry',
      rung: 0,
      status: 'running',
    });
    fail(sim, sim.pendingOne('start_agent').id, 'timeout');
    expect(sim.s.wait).toBeNull();
    expect(latest(sim, 'code')).toMatchObject({ n: 3, rung: 1, status: 'running' });
    expect(eventsOf(sim, 'RungRaised')).toHaveLength(1);
    // The new rung gets its own retry before it asks for the next one.
    fail(sim, sim.pendingOne('start_agent').id, 'timeout');
    expect(latest(sim, 'code')).toMatchObject({ n: 4, rung: 1, status: 'running' });
  });

  it('Scenario 8b: timeouts past the last rung end the task with the reason (#247)', () => {
    const sim = run({ roles: { coder: { model: 'sonnet', effort: 'medium', ladder: [] } } });
    toCode(sim);
    fail(sim, sim.pendingOne('start_agent').id, 'timeout');
    fail(sim, sim.pendingOne('start_agent').id, 'timeout');
    expect(sim.s.terminal).toEqual({ kind: 'FAILED', reason: 'ladder_exhausted:code' });
    expect(sim.effects('start_agent', 'pending')).toEqual([]);
  });

  it('Scenario 9: invalid output after one repair and one fresh session moves to the next rung with no further repair on the old one', () => {
    const sim = run();
    toCode(sim);
    sim.complete(
      sim.pendingOne('start_agent').id,
      'succeeded',
      agentData('done', { schema_checked: false }),
    );
    expect(latest(sim, 'code')).toMatchObject({ kind: 'repair', rung: 0 });
    fail(sim, sim.pendingOne('start_agent').id, 'invalid_output');
    expect(latest(sim, 'code')).toMatchObject({
      kind: 'fresh_session',
      rung: 0,
    });

    const before = sim.events.length;
    fail(sim, sim.pendingOne('start_agent').id, 'invalid_output');
    expect(eventsOf(sim, 'RungRaised', before).map((e) => e.payload)).toMatchObject([
      { step: 'code', from: 0, to: 1, reason: 'quality' },
    ]);
    expect(attemptsOf(sim, 'code').map((a) => [a.kind, a.rung])).toEqual([
      ['initial', 0],
      ['repair', 0],
      ['fresh_session', 0],
      ['retry', 1],
    ]);

    // The repair allowance is per rung.
    fail(sim, sim.pendingOne('start_agent').id, 'invalid_output');
    expect(latest(sim, 'code')).toMatchObject({ kind: 'repair', rung: 1 });
  });

  it('Scenario 10: repeated infra failures stop at the agent run cap before the class retry limit, and every retry counts', () => {
    const sim = run({ limits: { max_agent_runs: 2 } }, XS_TASK);
    toCode(sim);
    fail(sim, sim.pendingOne('start_agent').id, 'infra');
    expect(sim.s.wait).toMatchObject({
      reason: 'infra',
      detail: { code: 'infra_backoff' },
    });
    sim.advance(10_000).fireDue();
    fail(sim, sim.pendingOne('start_agent').id, 'infra');

    expect(sim.s.class_counters['code#infra']).toBe(2);
    expect(sim.s.class_counters['code#infra']).toBeLessThan(
      sim.policy?.limits.classes.infra_retries ?? 0,
    );
    expect(sim.s.budget.agent_runs).toMatchObject({ used: 2, reserved: 0 });
    expect(sim.s.wait).toMatchObject({
      reason: 'policy',
      detail: { code: 'agent_runs_exhausted' },
    });
    expect(sim.armedTimers('backoff')).toEqual([]);
    expect(sim.effects('start_agent', 'pending')).toEqual([]);
  });

  it('Scenario 11: cancelling before dispatch returns the reservation of the last agent run', () => {
    const sim = run({ limits: { max_agent_runs: 1 } }, XS_TASK);
    const agent = toCode(sim);
    expect(sim.s.budget.agent_runs).toMatchObject({
      limit: 1,
      used: 0,
      reserved: 1,
    });
    sim.when({ kind: 'cancel', reason: 'no longer needed' });
    expect(sim.s.effects[agent.id]?.status).toBe('invalidated');
    expect(sim.s.budget.agent_runs).toMatchObject({ used: 0, reserved: 0 });
    expect(Object.values(sim.s.budget.reservations).map((r) => r.status)).toEqual(['released']);
    expect(sim.s.status).toBe('CANCELLED');
  });

  it('Scenario 12: an unknown agent launch keeps its reservation until reconciliation says whether it ran', () => {
    const ran = run();
    const a = toCode(ran);
    ran.complete(a.id, 'unknown');
    const limit = ran.s.budget.agent_runs.limit;
    expect(ran.s.budget.agent_runs).toMatchObject({ used: 0, reserved: 1 });
    expect(available(ran.s.budget)).toBe((limit ?? Infinity) - 1);
    expect(ran.s.wait).toMatchObject({
      reason: 'infra',
      detail: { code: 'effect_unknown' },
    });
    ran.reconciled(a.id, 'executed_succeeded', { data: agentData('done') });
    expect(ran.s.budget.reservations[a.reservation_id as string]?.status).toBe('consumed');
    expect(ran.s.budget.agent_runs).toMatchObject({ used: 1 });

    const notRun = run();
    const b = toCode(notRun);
    notRun.complete(b.id, 'unknown');
    notRun.reconciled(b.id, 'not_executed');
    expect(notRun.s.budget.reservations[b.reservation_id as string]?.status).toBe('released');
    expect(notRun.s.budget.agent_runs.used).toBe(0);
  });

  it('FR-019 infra: a failed prepare setup is retried and no agent starts until setup passes', () => {
    const sim = run();
    sim.complete(sim.pendingOne('prepare').id, 'succeeded', {
      ...PREPARE_DATA,
      setup: { ran: true, passed: false },
    });
    expect(sim.s.base_sha).toBeNull();
    expect(sim.s.wait).toMatchObject({
      reason: 'infra',
      detail: { code: 'infra_backoff', step: 'prepare' },
    });
    sim.advance(10_000).fireDue();
    expect(sim.effects('start_agent')).toEqual([]);
    sim.complete(sim.pendingOne('prepare').id, 'succeeded', PREPARE_DATA);
    expect(sim.s.base_sha).toBe(PREPARE_DATA.base_sha);
    expect(sim.effects('start_agent', 'pending')).toHaveLength(1);
  });

  it('FR-020: quality tries per rung follow the configured value, with no hard cap', () => {
    const limits = { classes: { quality_tries_per_rung: 7 } };
    expect(FrozenPolicySchema.safeParse(buildPolicy({ limits })).success).toBe(true);
    const sim = run({ limits });
    toCode(sim);
    for (let i = 0; i < 7; i++)
      fail(sim, sim.pendingOne('start_agent').id, 'quality', {
        signature: `Q${i}`,
      });
    expect(attemptsOf(sim, 'code').map((a) => a.rung)).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });

  describe('Scenario 13: the task floor maps onto the reviewer ladder and still passes every check', () => {
    const coder = {
      model: 'sonnet',
      effort: 'medium' as const,
      ladder: [{ effort: 'high' as const }, { model: 'opus', effort: 'high' as const }],
      scope: 'task' as const,
    };
    const terraReviewer = {
      model: 'sol',
      effort: 'medium' as const,
      permissions: 'read_only' as const,
      ladder: [{ model: 'terra' }],
    };

    /** Raises the coder to its third rung (floor 3:2), then passes gates so review is next. */
    function coderToTopRung(sim: Sim): void {
      toCode(sim);
      twoQualityFailures(sim);
      twoQualityFailures(sim);
      if (sim.s.wait?.reason === 'approval')
        sim.when({ kind: 'approve', approval_request_id: approvalId(sim) });
      expect(latest(sim, 'code').rung).toBe(2);
      expect(sim.s.rungs.floor_level).toEqual({ tier: 3, effort_rank: 2 });
      sim.complete(sim.pendingOne('start_agent').id, 'succeeded', agentData('done'));
      sim.complete(
        sim.pendingOne('run_gates').id,
        'succeeded',
        gatesData({ build: true, unit: true, lint: true }),
      );
    }

    it('maps to the last reviewer rung rather than the coder rung number', () => {
      const sim = run({ roles: { coder }, escalation: { auto_up_to_tier: 3 } });
      coderToTopRung(sim);
      expect(sim.policy?.steps['review']?.ladder).toHaveLength(2);
      expect(latest(sim, 'review')).toMatchObject({
        rung: 1,
        binding: 'sol/high',
        status: 'running',
      });
      expect(eventsOf(sim, 'RungRaised').at(-1)?.payload).toEqual({
        step: 'review',
        from: 0,
        to: 1,
        reason: 'floor',
        signature: null,
      });
    });

    it('ends the task when the mapped reviewer rung is denied', () => {
      const sim = run({
        roles: { coder, reviewer: terraReviewer },
        escalation: {
          auto_up_to_tier: 3,
          allow_models: ['sonnet', 'opus', 'sol'],
        },
      });
      coderToTopRung(sim);
      expect(sim.s.terminal).toEqual({ kind: 'FAILED', reason: 'rung_denied:review:1' });
      expect(attemptsOf(sim, 'review')).toEqual([]);
    });

    it('asks for approval when the mapped reviewer rung needs it', () => {
      const sim = run({
        roles: { coder, reviewer: terraReviewer },
        escalation: { auto_up_to_tier: 2 },
      });
      coderToTopRung(sim);
      expect(sim.s.wait).toMatchObject({
        reason: 'approval',
        detail: { approval_kind: 'escalation', step: 'review', rung: 1 },
      });
      expect(attemptsOf(sim, 'review')).toEqual([]);
      sim.when({ kind: 'approve', approval_request_id: approvalId(sim) });
      expect(latest(sim, 'review')).toMatchObject({
        rung: 1,
        binding: 'terra/medium',
      });
    });

    it('does not raise the reviewer rung when the budget is exhausted', () => {
      const sim = run({
        roles: { coder },
        escalation: { auto_up_to_tier: 3 },
        limits: { max_agent_runs: 5 },
      });
      coderToTopRung(sim);
      expect(sim.s.wait).toMatchObject({
        reason: 'policy',
        detail: { code: 'agent_runs_exhausted', step: 'review' },
      });
      expect(sim.s.rungs.by_step['review']).toBeUndefined();
    });
  });
});
