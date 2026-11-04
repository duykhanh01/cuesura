import { describe, expect, it } from 'vitest';
import { proposeAmendment } from '../../../src/policy/amendment.ts';
import { FrozenPolicySchema } from '../../../src/domain/policy.ts';
import { policyHash, verifyPolicyHash } from '../../../src/policy/finalize.ts';
import { authz, buildPolicy } from '../../support/builders.ts';

const reason = 'Increase the agent-run budget for a larger task';

describe('proposeAmendment (FR-005, FR-036)', () => {
  const current = buildPolicy();
  const snapshot = structuredClone(current);
  const change = {
    limits: {
      ...current.limits,
      max_agent_runs: (current.limits.max_agent_runs ?? 0) + 10,
    },
  };

  it('an actor name without trusted authorization returns not_admin', () => {
    expect(proposeAmendment({ current, change, reason, authz: null })).toEqual({
      ok: false,
      error: { code: 'not_admin' },
    });
    expect(proposeAmendment({ current, change, reason, authz: undefined })).toEqual({
      ok: false,
      error: { code: 'not_admin' },
    });
  });

  it('operate-only authorization returns not_admin', () => {
    expect(
      proposeAmendment({
        current,
        change,
        reason,
        authz: authz(['read', 'operate'], 'admin'),
      }),
    ).toEqual({
      ok: false,
      error: { code: 'not_admin' },
    });
  });

  it('workflow graph changes return workflow_change_forbidden', () => {
    const r = proposeAmendment({
      current,
      change: { workflow: current.workflow } as never,
      reason,
      authz: authz(['admin']),
    });
    expect(r).toEqual({
      ok: false,
      error: { code: 'workflow_change_forbidden' },
    });
  });

  it('increments policy_version and recomputes policy_hash', () => {
    const r = proposeAmendment({
      current,
      change,
      reason,
      authz: authz(['admin']),
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.policy_version).toBe(current.policy_version + 1);
    expect(r.value.limits.max_agent_runs).toBe((current.limits.max_agent_runs ?? 0) + 10);
    expect(r.value.policy_hash).not.toBe(current.policy_hash);
    expect(verifyPolicyHash(r.value)).toBe(true);
  });

  it('decision modes cannot be amended (FR-039)', () => {
    const r = proposeAmendment({
      current,
      change: { decision_modes: { agent_question: 'agent' } } as never,
      reason,
      authz: authz(['admin']),
    });
    expect(!r.ok && r.error.code).toBe('invalid');
  });

  it('new policies share no objects with change or current', () => {
    const ch = { limits: { ...current.limits, max_agent_runs: 50 } };
    const r = proposeAmendment({
      current,
      change: ch,
      reason,
      authz: authz(['admin']),
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    ch.limits.max_agent_runs = 999;
    expect(r.value.limits.max_agent_runs).toBe(50);
    expect(r.value.steps).not.toBe(current.steps);
    r.value.steps.code!.role = 'mutated';
    expect(current.steps.code!.role).toBe(snapshot.steps.code!.role);
    r.value.steps.code!.role = current.steps.code!.role;
    expect(verifyPolicyHash(r.value)).toBe(true);
  });

  it('preserves inputs on both acceptance and rejection', () => {
    proposeAmendment({ current, change, reason, authz: authz(['operate']) });
    proposeAmendment({ current, change, reason, authz: authz(['admin']) });
    expect(current).toEqual(snapshot);
  });
});

describe('policies frozen before decider support was removed', () => {
  const legacy = () => {
    const { policy_hash: _hash, ...rest } = buildPolicy();
    const old = {
      ...rest,
      limits: { ...rest.limits, max_decider_calls: 0 },
      decision_modes: { agent_question: 'human' as const },
      workflow: {
        ...rest.workflow,
        decisions: { merge_to_main: 'human' as const },
      },
    };
    return { ...old, policy_hash: policyHash(old) };
  };

  it('still parse, verify, and amend with their old fields kept', () => {
    const old = FrozenPolicySchema.parse(legacy());
    expect(verifyPolicyHash(old)).toBe(true);
    const r = proposeAmendment({
      current: old,
      change: { protected_branches: ['main'] },
      reason: 'test',
      authz: authz(['admin']),
    });
    expect(r.ok && r.value.limits.max_decider_calls).toBe(0);
    expect(r.ok && verifyPolicyHash(r.value)).toBe(true);
  });

  it('reject a non-human mode', () => {
    const bad = { ...legacy(), decision_modes: { agent_question: 'agent' } };
    expect(FrozenPolicySchema.safeParse(bad).success).toBe(false);
  });
});
