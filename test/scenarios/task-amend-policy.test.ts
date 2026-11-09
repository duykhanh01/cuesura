import { afterEach, describe, expect, it } from 'vitest';
import { planModelAmendment, type ModelChange } from '../../src/application/amend-policy.ts';
import type { Attempt } from '../../src/domain/state.ts';
import type { FailureClass } from '../../src/domain/trigger.ts';
import type { EscalationPolicy } from '../../src/policy/ladder.ts';
import type { Uuid } from '../../src/shared/brand.ts';
import { authz, buildTask, MODELS, type PolicyOptions } from '../support/builders.ts';
import { expectAccepted, Sim, started, toCode, USAGE } from '../support/scenario.ts';

let sims: Sim[] = [];

afterEach(() => {
  for (const s of sims) s.replayCheck();
  sims = [];
});

const OWNER = { authz: authz(['read', 'operate', 'admin']) };
const ASSISTANT = { authz: authz(['read', 'operate'], 'assistant') };
const ESC: EscalationPolicy = { auto_up_to_tier: 2, above: 'ask_human', allow_models: null };
// A raise the escalation limit refuses keeps the task waiting; past the last rung it fails (#247).
const ONE_RUNG: PolicyOptions = {
  roles: { coder: { model: 'sonnet', effort: 'medium', ladder: [{ effort: 'high' }] } },
  limits: { max_escalations: 0 },
};

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

function plan(sim: Sim, change: Partial<ModelChange>, escalation: Partial<EscalationPolicy> = {}) {
  return planModelAmendment({
    state: sim.s,
    current: sim.policy!,
    change: { model: 'haiku', reason: 'try another model', ...change },
    models: MODELS,
    escalation: { ...ESC, ...escalation },
    authz: OWNER.authz,
  });
}

function amend(sim: Sim, change: Partial<ModelChange>, o = OWNER) {
  const p = plan(sim, change);
  if (!p.ok) throw new Error(`plan failed: ${p.error.reason}`);
  return {
    plan: p.value,
    decision: sim.when(
      { kind: 'amend', policy: p.value.policy, diff: p.value.diff, reason: 'try another model' },
      o,
    ),
  };
}

describe('task amend-policy (issue #105)', () => {
  it('adds a rung above the current one when the escalation limit refused the raise', () => {
    const sim = run();
    toCode(sim);
    toEscalationsExhausted(sim);
    const before = sim.events.length;
    const hashBefore = sim.s.policy_ref?.hash;

    const { plan: p, decision } = amend(sim, { model: 'sol', effort: 'high' });
    expectAccepted(decision);
    expect(p.diff).toMatchObject({
      step: 'code',
      wait_code: 'escalations_exhausted',
      rung: 1,
      placement: 'insert',
      from: null,
      to: 'sol/high',
      state: 'auto',
      max_escalations: { from: 0, to: 1 },
    });
    expect(sim.eventTypes(before)).toEqual(
      expect.arrayContaining(['PolicyAmended', 'TaskResumed', 'RungRaised']),
    );
    expect(sim.s.policy_ref).toMatchObject({ version: 2, hash: p.policy.policy_hash });
    expect(sim.s.policy_ref?.hash).not.toBe(hashBefore);
    expect(sim.policy?.steps['code']?.ladder).toHaveLength(3);
    expect(codeAttempts(sim).at(-1)).toMatchObject({
      rung: 1,
      binding: 'sol/high',
      status: 'running',
    });
    // Earlier attempts keep the binding they ran on.
    expect(codeAttempts(sim)[0]).toMatchObject({ rung: 0, binding: 'sonnet/medium' });
  });

  it('asks for the usual escalation approval when the new model is above auto_up_to_tier', () => {
    const sim = run();
    toCode(sim);
    toEscalationsExhausted(sim);
    const { plan: p, decision } = amend(sim, { model: 'opus', effort: 'high' });
    expectAccepted(decision);
    expect(p.diff.state).toBe('needs_approval');
    expect(sim.s.wait).toMatchObject({
      reason: 'approval',
      detail: { code: 'escalation', step: 'code', rung: 1 },
    });
    expect(sim.effects('start_agent', 'pending')).toEqual([]);

    expectAccepted(
      sim.when({
        kind: 'approve',
        approval_request_id: sim.s.wait?.detail['approval_id'] as Uuid,
      }),
    );
    expect(codeAttempts(sim).at(-1)).toMatchObject({
      rung: 1,
      binding: 'opus/high',
      status: 'running',
    });
  });

  it('refuses a model the profile denies, by allow_models or above: deny', () => {
    const sim = run();
    toCode(sim);
    toEscalationsExhausted(sim);
    expect(plan(sim, { model: 'sol' }, { allow_models: ['sonnet', 'opus'] })).toMatchObject({
      ok: false,
      error: { code: 'rejected', reason: 'model_denied' },
    });
    expect(plan(sim, { model: 'opus' }, { above: 'deny' })).toMatchObject({
      ok: false,
      error: { code: 'rejected', reason: 'model_denied' },
    });
    expect(plan(sim, { model: 'gpt-x' })).toMatchObject({
      ok: false,
      error: { reason: 'unknown_model' },
    });
  });

  it('applies only for an admin and only while the task waits on an exhausted limit', () => {
    const sim = run();
    toCode(sim);
    expect(plan(sim, {})).toMatchObject({
      ok: false,
      error: { code: 'conflict', reason: 'amend_not_applicable' },
    });
    toEscalationsExhausted(sim);
    const { decision } = amend(sim, { model: 'sol' }, ASSISTANT);
    expect(decision).toMatchObject({ kind: 'rejected', code: 'not_admin' });
    expect(sim.s.wait?.detail.code).toBe('escalations_exhausted');
    expect(sim.s.policy_ref?.version).toBe(1);
  });

  it('has nothing to amend once a denied rung ended the task (#247)', () => {
    const sim = run({
      roles: { coder: { model: 'sonnet', effort: 'medium', ladder: [{ model: 'opus' }] } },
      escalation: { above: 'deny' },
    });
    toCode(sim);
    fail(sim, 'quality', 'C1');
    fail(sim, 'quality', 'C1');
    expect(sim.s.status).toBe('FAILED');
    expect(sim.s.terminal).toEqual({ kind: 'FAILED', reason: 'rung_denied:code:1' });
    const p = plan(sim, { model: 'sol' });
    expect(p.ok).toBe(false);
  });

  it('runs a step that ran out of visits on the new model in place of its current rung', () => {
    const sim = run({ ...ONE_RUNG, limits: { classes: { quality_tries_per_rung: 100 } } });
    toCode(sim);
    for (let i = 0; sim.s.status === 'RUNNING'; i++) fail(sim, 'quality', `C${i}`);
    expect(sim.s.wait).toMatchObject({
      detail: { code: 'loop_exhausted', step: 'code', outcome: 'exhausted' },
    });
    const used = sim.s.step_visits['code'] ?? 0;

    const { plan: p, decision } = amend(sim, { model: 'sol' });
    expectAccepted(decision);
    expect(p.diff).toMatchObject({
      rung: 0,
      placement: 'replace',
      from: 'sonnet/medium',
      to: 'sol/medium',
      state: 'auto',
      extra_visits: { code: { from: 0 } },
    });
    expect(sim.s.status).toBe('RUNNING');
    expect(sim.s.step_visits['code']).toBe(used + 1);
    expect(codeAttempts(sim).at(-1)).toMatchObject({
      rung: 0,
      binding: 'sol/medium',
      status: 'running',
    });
  });

  it('refuses a change that keeps the current binding', () => {
    const sim = run({ ...ONE_RUNG, limits: { classes: { quality_tries_per_rung: 100 } } });
    toCode(sim);
    for (let i = 0; sim.s.status === 'RUNNING'; i++) fail(sim, 'quality', `C${i}`);
    expect(plan(sim, { model: 'sonnet', effort: 'medium' })).toMatchObject({
      ok: false,
      error: { reason: 'unchanged' },
    });
  });

  it('allows one more raise when the escalations ran out', () => {
    const sim = run({ limits: { max_escalations: 0 } });
    toCode(sim);
    fail(sim, 'quality', 'C1');
    fail(sim, 'quality', 'C1');
    expect(sim.s.wait).toMatchObject({ detail: { code: 'escalations_exhausted', step: 'code' } });

    const { plan: p, decision } = amend(sim, { model: 'sol', effort: 'high' });
    expectAccepted(decision);
    expect(p.diff).toMatchObject({
      rung: 1,
      placement: 'insert',
      max_escalations: { from: 0, to: 1 },
    });
    expect(sim.s.budget.escalations).toMatchObject({ used: 1, limit: 1 });
    expect(codeAttempts(sim).at(-1)).toMatchObject({ rung: 1, binding: 'sol/high' });
    // The rungs the frozen ladder had stay above the new one.
    expect(sim.policy?.steps['code']?.ladder.map((r) => r.binding.model)).toEqual([
      'sonnet',
      'sol',
      'sonnet',
      'opus',
    ]);
  });

  it('gives the same policy hash for the same inputs, so a confirmation binds to its preview', () => {
    const sim = run();
    toCode(sim);
    toEscalationsExhausted(sim);
    const a = plan(sim, { model: 'sol', reason: 'one' });
    const b = plan(sim, { model: 'sol', reason: 'two' });
    const c = plan(sim, { model: 'sol', effort: 'high' });
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(a.value.policy.policy_hash).toBe(b.value.policy.policy_hash);
    expect(c.value.policy.policy_hash).not.toBe(a.value.policy.policy_hash);
  });
});
