import { afterEach, describe, expect, it } from 'vitest';
import { streakKey, type Attempt } from '../../src/domain/state.ts';
import type { FailureClass } from '../../src/domain/trigger.ts';
import { authz, buildTask, type PolicyOptions } from '../support/builders.ts';
import { expectAccepted, Sim, started, toCode, USAGE } from '../support/scenario.ts';

let sims: Sim[] = [];

afterEach(() => {
  for (const s of sims) s.replayCheck();
  sims = [];
});

// A raise the escalation limit refuses keeps the task waiting; past the last rung it fails (#247).
const ONE_RUNG: PolicyOptions = {
  roles: { coder: { model: 'sonnet', effort: 'medium', ladder: [{ effort: 'high' }] } },
  limits: { max_escalations: 0 },
};
const READER = { authz: authz(['read']) };

function run(policy: PolicyOptions = ONE_RUNG): Sim {
  const sim = started(buildTask(), { policy });
  sims.push(sim);
  return sim;
}

function fail(sim: Sim, cls: FailureClass, signature: string): void {
  sim.complete(sim.pendingOne('start_agent').id, 'failed', {
    failure_class: cls,
    invoked: true,
    usage: USAGE,
    signature,
  });
}

function codeAttempts(sim: Sim): Attempt[] {
  return Object.values(sim.s.attempts)
    .filter((a) => a.step === 'code')
    .sort((a, b) => a.n - b.n);
}

function toEscalationsExhausted(sim: Sim): void {
  fail(sim, 'quality', 'C1');
  fail(sim, 'quality', 'C1');
  expect(sim.s.wait).toMatchObject({
    reason: 'policy',
    detail: { code: 'escalations_exhausted', step: 'code', from: 0, to: 1 },
  });
}

describe('task continue (issue #101)', () => {
  it('keeps the current model after the ladder ran out and runs the same step again', () => {
    const sim = run();
    toCode(sim);
    toEscalationsExhausted(sim);
    const before = sim.events.length;

    expectAccepted(sim.when({ kind: 'continue' }));
    expect(sim.eventTypes(before)).toContain('TaskContinued');
    expect(sim.s.status).toBe('RUNNING');
    expect(sim.s.failure_streaks[streakKey('code', 0)]).toMatchObject({
      consecutive: 0,
      quality_tries: 0,
      escalate: false,
    });
    expect(codeAttempts(sim).at(-1)).toMatchObject({
      rung: 0,
      status: 'running',
    });
    expect(codeAttempts(sim)).toHaveLength(3);
  });

  it('is bounded: the same failure twice after continuing waits again', () => {
    const sim = run();
    toCode(sim);
    toEscalationsExhausted(sim);
    expectAccepted(sim.when({ kind: 'continue' }));
    toEscalationsExhausted(sim);
    expect(sim.effects('start_agent', 'pending')).toEqual([]);
  });

  it('needs the operate role an assistant holds, not admin', () => {
    const sim = run();
    toCode(sim);
    toEscalationsExhausted(sim);
    const d = sim.when({ kind: 'continue' }, READER);
    expect(d).toMatchObject({
      kind: 'rejected',
      code: 'invalid_trigger',
      detail: { reason: 'operate_required' },
    });
    expect(sim.s.wait?.detail.code).toBe('escalations_exhausted');
  });

  it('is rejected while the task is not waiting on an exhausted limit', () => {
    const sim = run();
    toCode(sim);
    expect(sim.when({ kind: 'continue' })).toMatchObject({
      kind: 'rejected',
      code: 'invalid_trigger',
      detail: { reason: 'continue_not_applicable' },
    });
  });

  it('tops up the visits of a step that ran out of them', () => {
    const sim = run({
      ...ONE_RUNG,
      limits: { classes: { quality_tries_per_rung: 100 } },
    });
    toCode(sim);
    for (let i = 0; sim.s.status === 'RUNNING'; i++) fail(sim, 'quality', `C${i}`);
    expect(sim.s.wait).toMatchObject({
      detail: { code: 'loop_exhausted', step: 'code', outcome: 'exhausted' },
    });
    const used = sim.s.step_visits['code'] ?? 0;

    expectAccepted(sim.when({ kind: 'continue' }));
    expect(sim.s.status).toBe('RUNNING');
    expect(sim.s.visit_credits?.['code']?.visits).toBe(100);
    expect(sim.s.step_visits['code']).toBe(used + 1);
    expect(codeAttempts(sim).at(-1)).toMatchObject({ status: 'running' });
  });
});
