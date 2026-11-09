import { describe, expect, it } from 'vitest';
import { FakeHarness, FakeHarnessError, FAKE_VENDOR } from '../../../src/adapters/harness/fake.ts';
import { wireRoleSchema, type Role } from '../../../src/adapters/harness/result-schema.ts';
import type { HarnessInput } from '../../../src/adapters/ports.ts';
import { CapabilityManifestSchema } from '../../../src/domain/runtime.ts';
import { asEpochMs } from '../../../src/shared/brand.ts';
import { hashText } from '../../../src/shared/hash.ts';

function input(role: Role, schemaRole: Role = role): HarnessInput {
  return {
    role,
    operation_id: `op-${role}`,
    attempt_id: `at-${role}`,
    revision: 1,
    binding: {
      harness: 'fake',
      vendor: FAKE_VENDOR,
      model: 'fake-model',
      effort: null,
      permission_policy_hash: hashText('policy'),
    },
    context: { text: 'do the task', digest: hashText('do the task') },
    schema: wireRoleSchema(schemaRole, { omit_meta_schema: false }),
    wall_ms: 1_000,
    deadline_at: asEpochMs(1_000),
    session: null,
  };
}

const live = (): AbortSignal => new AbortController().signal;
const coderDone = {
  schema_version: 1,
  status: 'done',
  summary: 'implemented',
  questions: [],
  blocker: null,
};

describe('FakeHarness (T013)', () => {
  it('claims no proven vendor capability', () => {
    const h = new FakeHarness({});
    expect(CapabilityManifestSchema.parse(h.manifest)).toEqual(h.manifest);
    expect(h.manifest.vendor).toBe(FAKE_VENDOR);
    expect(Object.values(h.manifest.capabilities).every((c) => c === 'unknown')).toBe(true);
    expect(h.manifest.native_result).toBe('not_tried');
    expect(h.manifest.selected_inner_mode).toBeNull();
  });

  it('returns scripted steps in order and records each call', async () => {
    const h = new FakeHarness({
      coder: [
        {
          kind: 'result',
          value: coderDone,
          usage: { basis: 'reported', tokens: 10 },
        },
      ],
      reviewer: [
        {
          kind: 'result',
          value: {
            schema_version: 1,
            verdict: 'approve',
            summary: 'fine',
            findings: [],
          },
        },
      ],
    });
    const c = await h.run(input('coder'), live());
    expect(c).toMatchObject({
      kind: 'result',
      role: 'coder',
      value: coderDone,
      usage: { basis: 'reported', tokens: 10 },
    });
    const r = await h.run(input('reviewer'), live());
    expect(r).toMatchObject({
      kind: 'result',
      value: { verdict: 'approve' },
      usage: { basis: 'unavailable' },
    });
    expect(h.calls.map((x) => x.role)).toEqual(['coder', 'reviewer']);
    expect(h.remaining('coder')).toBe(0);
  });

  it('turns a scripted answer that fails validation into invalid_output', async () => {
    const h = new FakeHarness({
      coder: [
        { kind: 'result', value: { ...coderDone, status: 'needs_input' } },
        { kind: 'result', value: { ...coderDone, extra: true } },
      ],
    });
    const semantic = await h.run(input('coder'), live());
    expect(semantic).toMatchObject({
      kind: 'invalid_output',
      issues: [{ layer: 'semantic', path: 'questions' }],
    });
    const structure = await h.run(input('coder'), live());
    expect(structure).toMatchObject({
      kind: 'invalid_output',
      issues: [{ layer: 'structure' }],
    });
  });

  it('reports scripted failures with their facts', async () => {
    const h = new FakeHarness({
      fixer: [
        {
          kind: 'failure',
          failure: 'rate_limited',
          reset_at: asEpochMs(5_000),
        },
        { kind: 'failure', failure: 'auth', invoked: false },
      ],
    });
    expect(await h.run(input('fixer'), live())).toMatchObject({
      kind: 'failure',
      failure: 'rate_limited',
      reset_at: 5_000,
      invoked: true,
    });
    expect(await h.run(input('fixer'), live())).toMatchObject({
      kind: 'failure',
      failure: 'auth',
      invoked: false,
    });
  });

  it('a hanging step ends as cancelled when the caller aborts', async () => {
    const h = new FakeHarness({ coder: [{ kind: 'hang' }] });
    const ctl = new AbortController();
    const pending = h.run(input('coder'), ctl.signal);
    ctl.abort();
    expect(await pending).toMatchObject({
      kind: 'failure',
      failure: 'cancelled',
      invoked: true,
    });
  });

  it('does not consume a step when aborted before start', async () => {
    const h = new FakeHarness({
      coder: [{ kind: 'result', value: coderDone }],
    });
    const ctl = new AbortController();
    ctl.abort();
    expect(await h.run(input('coder'), ctl.signal)).toMatchObject({
      kind: 'failure',
      failure: 'cancelled',
      invoked: false,
    });
    expect(h.remaining('coder')).toBe(1);
  });

  it('rejects a schema of another role and an exhausted script', async () => {
    const h = new FakeHarness({ reviewer: [] });
    await expect(h.run(input('reviewer', 'coder'), live())).rejects.toThrow(FakeHarnessError);
    await expect(h.run(input('reviewer'), live())).rejects.toThrow(/no scripted step/);
  });
});
