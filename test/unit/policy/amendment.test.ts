import { describe, expect, it } from 'vitest';
import { proposeAmendment } from '../../../src/policy/amendment.ts';
import { verifyPolicyHash } from '../../../src/policy/finalize.ts';
import { authz, buildPolicy } from '../../support/builders.ts';

const reason = 'tăng trần lượt agent cho task lớn';

describe('proposeAmendment (FR-005, FR-036)', () => {
  const current = buildPolicy();
  const snapshot = structuredClone(current);
  const change = { limits: { ...current.limits, max_agent_runs: current.limits.max_agent_runs + 10 } };

  it('not_admin khi không có ngữ cảnh quyền, dù có tên actor', () => {
    expect(proposeAmendment({ current, change, reason, authz: null })).toEqual({ ok: false, error: { code: 'not_admin' } });
    expect(proposeAmendment({ current, change, reason, authz: undefined })).toEqual({ ok: false, error: { code: 'not_admin' } });
  });

  it('not_admin khi chỉ có quyền operate', () => {
    expect(proposeAmendment({ current, change, reason, authz: authz(['read', 'operate'], 'admin') })).toEqual({
      ok: false,
      error: { code: 'not_admin' },
    });
  });

  it('workflow_change_forbidden khi đổi graph workflow', () => {
    const r = proposeAmendment({ current, change: { workflow: current.workflow } as never, reason, authz: authz(['admin']) });
    expect(r).toEqual({ ok: false, error: { code: 'workflow_change_forbidden' } });
  });

  it('policy_version tăng 1 và policy_hash được tính lại', () => {
    const r = proposeAmendment({ current, change, reason, authz: authz(['admin']) });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.policy_version).toBe(current.policy_version + 1);
    expect(r.value.limits.max_agent_runs).toBe(current.limits.max_agent_runs + 10);
    expect(r.value.policy_hash).not.toBe(current.policy_hash);
    expect(verifyPolicyHash(r.value)).toBe(true);
  });

  it('chế độ quyết định khác human bị từ chối (FR-039)', () => {
    const r = proposeAmendment({
      current,
      change: { decision_modes: { ...current.decision_modes, agent_question: 'agent' } },
      reason,
      authz: authz(['admin']),
    });
    expect(!r.ok && r.error.code).toBe('invalid');
  });

  it('chính sách mới không dùng chung object với change hay current', () => {
    const ch = { limits: { ...current.limits, max_agent_runs: 50 } };
    const r = proposeAmendment({ current, change: ch, reason, authz: authz(['admin']) });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    ch.limits.max_agent_runs = 999;
    expect(r.value.limits.max_agent_runs).toBe(50);
    expect(r.value.steps).not.toBe(current.steps);
    r.value.steps.code!.role = 'mutated';
    expect(current.steps.code!.role).toBe(snapshot.steps.code!.role);
    r.value.steps.code!.role = current.steps.code!.role;
    expect(verifyPolicyHash(r.value)).toBe(true);
  });

  it('đầu vào giữ nguyên dù bị từ chối hay được chấp nhận', () => {
    proposeAmendment({ current, change, reason, authz: authz(['operate']) });
    proposeAmendment({ current, change, reason, authz: authz(['admin']) });
    expect(current).toEqual(snapshot);
  });
});
