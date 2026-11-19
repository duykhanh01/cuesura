import { describe, expect, it } from 'vitest';
import { attemptModelIds } from '../../../src/application/attempt-models.ts';
import type { DomainEvent } from '../../../src/domain/event.ts';
import { bindingName } from '../../../src/domain/policy.ts';

const binding = (model: string, model_id: string, effort = 'medium') => ({
  harness: 'h',
  model,
  model_id,
  effort,
  add_context: [],
  permissions: 'write',
  limits: { max_turns: null, stall_timeout_ms: null, wall_timeout_ms: null },
});
const policy = (version: number, ...rungs: ReturnType<typeof binding>[]) => ({
  revision: 1,
  policy_version: version,
  steps: { code: { ladder: rungs.map((b) => ({ binding: b })) } },
});
let seq = 0;
const ev = (type: string, payload: unknown): DomainEvent =>
  ({ type, seq: ++seq, payload }) as unknown as DomainEvent;
const attempt = (id: string, rung: number, b: ReturnType<typeof binding>) =>
  ev('AttemptRequested', { attempt_id: id, step: 'code', rung, binding: bindingName(b as never) });

describe('the model ID of an attempt, from the policy in force when it was requested', () => {
  const opus = binding('opus', 'claude-opus-5-5');
  const sol = binding('opus', 'gpt-6.1-sol');
  const up = binding('sol', 'gpt-6.1-sol', 'high');

  it('reads the rung the attempt named, and the policy as amended at that point, not the latest', () => {
    const ids = attemptModelIds([
      ev('PolicyFrozen', { policy: policy(1, opus, up) }),
      attempt('a1', 0, opus),
      attempt('a2', 1, up),
      // The alias `opus` now maps to another model; a1 keeps the ID it ran with.
      ev('PolicyAmended', { policy: policy(2, sol, up) }),
      attempt('a3', 0, sol),
    ]);
    expect(Object.fromEntries(ids)).toEqual({
      a1: 'claude-opus-5-5',
      a2: 'gpt-6.1-sol',
      a3: 'gpt-6.1-sol',
    });
  });

  it('leaves out an attempt the policy cannot prove: no policy yet, or a binding that differs', () => {
    const ids = attemptModelIds([
      attempt('early', 0, opus),
      ev('PolicyFrozen', { policy: policy(1, opus) }),
      attempt('moved', 0, up),
      attempt('beyond', 5, opus),
    ]);
    expect(ids.size).toBe(0);
  });
});
