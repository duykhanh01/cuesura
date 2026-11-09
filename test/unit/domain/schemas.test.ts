import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/shared/canonical-json.ts';
import {
  AuthzContextSchema,
  CanonicalTaskSchema,
  DomainEventSchema,
  FrozenExecutionContextSchema,
  FrozenPolicySchema,
  TriggerEnvelopeSchema,
  UsageSchema,
  WorkflowSchema,
  idemKey,
  type DomainEvent,
} from '../../../src/domain/index.ts';
import { SOFTWARE_DEV } from '../../../src/engine/workflows/software-dev.ts';
import { verifyContextHash, verifyPolicyHash } from '../../../src/policy/finalize.ts';
import {
  authz,
  buildContext,
  buildPolicy,
  buildTask,
  envelope,
  uuidOf,
} from '../../support/builders.ts';

function roundTrip<T>(schema: { parse(v: unknown): T }, value: T): void {
  const text = canonicalJson(value);
  const parsed = schema.parse(JSON.parse(text));
  expect(canonicalJson(parsed)).toBe(text);
}

describe('Domain schemas round-trip through canonical JSON', () => {
  it('CanonicalTask', () => roundTrip(CanonicalTaskSchema, buildTask()));
  it('Workflow software_dev@1', () => roundTrip(WorkflowSchema, SOFTWARE_DEV));
  it('FrozenPolicy verifies its own hash', () => {
    const p = buildPolicy();
    roundTrip(FrozenPolicySchema, p);
    expect(verifyPolicyHash(p)).toBe(true);
    expect(verifyPolicyHash({ ...p, profile: 'other' })).toBe(false);
  });
  it('FrozenExecutionContext verifies its own hash', () => {
    const c = buildContext(buildTask(), 'abc', [
      { name: 'spec.md', media_type: 'text/markdown', content: '# x' },
    ]);
    roundTrip(FrozenExecutionContextSchema, c);
    expect(verifyContextHash(c)).toBe(true);
  });
  it('AuthzContext', () => roundTrip(AuthzContextSchema, authz(['admin'])));
  it('TriggerEnvelope', () => {
    const env = envelope(
      uuidOf(1),
      { kind: 'cancel', reason: 'No longer needed' },
      { authz: authz(), expected_version: 3, ids: [uuidOf(9)] },
    );
    roundTrip(TriggerEnvelopeSchema, env);
  });
  it('DomainEvent', () => {
    const e: DomainEvent = {
      schema_version: 1,
      task_id: uuidOf(1),
      seq: 1,
      global_seq: 7,
      type: 'TaskReady',
      revision: 1,
      actor: 'engine',
      causation: { dedup_key: 'k' },
      payload: {},
    };
    roundTrip(DomainEventSchema, e);
  });
});

describe('Schema constraints', () => {
  it('rejects human commands without authz or expected_version', () => {
    const env = envelope(uuidOf(1), { kind: 'cancel', reason: 'x' });
    expect(TriggerEnvelopeSchema.safeParse(env).success).toBe(false);
  });
  it('rejects envelopes containing more than eight IDs', () => {
    const ids = Array.from({ length: 9 }, (_, i) => uuidOf(100 + i));
    const env = envelope(uuidOf(1), { kind: 'timer', timer_id: uuidOf(2) }, { ids });
    expect(TriggerEnvelopeSchema.safeParse(env).success).toBe(false);
  });
  it('unavailable usage cannot carry zero-valued metrics (FR-024)', () => {
    expect(UsageSchema.safeParse({ basis: 'unavailable', tokens: 0 }).success).toBe(false);
    expect(UsageSchema.safeParse({ basis: 'unavailable' }).success).toBe(true);
    expect(UsageSchema.safeParse({ basis: 'reported', tokens: 0 }).success).toBe(true);
  });
  it('idemKey follows the data-model format', () => {
    expect(idemKey('merge', 'acme', 't1', 2, 'abc123')).toBe('merge:acme:t1:r2:abc123');
  });
});
