import { describe, expect, it } from 'vitest';
import {
  CapabilityManifestSchema,
  cursorAfter,
  DEFAULT_RUNTIME_LIMITS,
  FrozenRuntimeContextSchema,
  RelativePathSchema,
  RuntimeLimitsSchema,
  runtimeLimitIssues,
  verifyRuntimeHash,
} from '../../../src/domain/runtime.ts';
import type { TaskState } from '../../../src/domain/state.ts';
import { decide } from '../../../src/engine/decide.ts';
import { emptyRuntime, replay } from '../../../src/engine/evolve.ts';
import { claimable } from '../../../src/engine/claim.ts';
import { buildTask, envelope, freezeOk, uuidOf } from '../../support/builders.ts';
import {
  buildRuntime,
  confirmedRuntime,
  proposeAndConfirm,
  selectionFor,
} from '../../support/runtime.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { openMemoryStore } from '../../../src/store/testing.ts';
import { started } from '../../support/scenario.ts';

/** A 002 start runs under the slot; tests of the start handler begin from a granted fresh request. */
function granted(s: TaskState | null): TaskState {
  if (s === null) throw new Error('no task state');
  const g = structuredClone(s);
  g.execution.holding = { request_id: uuidOf(60), granted_at: 0 };
  return g;
}

const HASH = `sha256:${'b'.repeat(64)}`;

describe('runtime limits', () => {
  it('defaults are valid finite positive integers with consistent cross-field caps', () => {
    expect(RuntimeLimitsSchema.parse(DEFAULT_RUNTIME_LIMITS)).toEqual(DEFAULT_RUNTIME_LIMITS);
    expect(runtimeLimitIssues(DEFAULT_RUNTIME_LIMITS)).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])('rejects %s as a cap', (v) => {
    expect(
      RuntimeLimitsSchema.safeParse({
        ...DEFAULT_RUNTIME_LIMITS,
        spool_bytes: v,
      }).success,
    ).toBe(false);
  });

  it('reports initial > max, segment > spool and TERM+KILL beyond drain/recheck', () => {
    const issues = runtimeLimitIssues({
      ...DEFAULT_RUNTIME_LIMITS,
      poll_initial_ms: 7_200_000,
      log_segment_bytes: 128 * 1024 * 1024,
      term_grace_ms: 299_000,
      recheck_max_ms: 60_000,
    });
    expect(issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([
        'poll_initial_ms must be <= poll_max_ms',
        'log_segment_bytes must be <= spool_bytes',
        'term_grace_ms + kill_verify_ms must be <= drain_max_ms',
        'term_grace_ms + kill_verify_ms must be <= recheck_max_ms',
      ]),
    );
  });
});

describe('runtime snapshot and entities', () => {
  it('runtime hash covers every field and the schema is closed', () => {
    const rt = buildRuntime(buildTask());
    expect(FrozenRuntimeContextSchema.parse(rt)).toEqual(rt);
    expect(verifyRuntimeHash(rt)).toBe(true);
    expect(verifyRuntimeHash({ ...rt, project_path: '/srv/other' })).toBe(false);
    expect(FrozenRuntimeContextSchema.safeParse({ ...rt, completion_mode: 'merge' }).success).toBe(
      false,
    );
    expect(FrozenRuntimeContextSchema.safeParse({ ...rt, token: 'x' }).success).toBe(false);
  });

  it.each(['/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a/.'])(
    'artifact path %s cannot leave the root',
    (p) => {
      expect(RelativePathSchema.safeParse(p).success).toBe(false);
    },
  );

  it('cursor moves forward only', () => {
    const at = (
      generation: number,
      segment: number,
      byte_offset: number,
      last_record_seq: number,
    ) => ({
      operation_id: 'op',
      generation,
      segment,
      byte_offset,
      last_record_seq,
    });
    expect(cursorAfter(at(0, 0, 10, 1), null)).toBe(true);
    expect(cursorAfter(at(0, 0, 20, 2), at(0, 0, 10, 1))).toBe(true);
    expect(cursorAfter(at(0, 0, 10, 1), at(0, 0, 10, 1))).toBe(false);
    expect(cursorAfter(at(0, 1, 0, 3), at(0, 0, 500, 2))).toBe(true);
    expect(cursorAfter(at(0, 0, 900, 9), at(1, 0, 10, 10))).toBe(false);
  });

  it('external_verified needs a recorded native failure plus outer and permission proofs', () => {
    const manifest = {
      schema_version: 1,
      vendor: 'claude',
      binary: { realpath: '/usr/bin/claude', version: '2.1.306', digest: HASH },
      role_schemas: { coder: HASH },
      isolation_mode: 'isolated',
      provider: 'bwrap',
      capabilities: {
        structured_output: 'unknown',
        permission_enforced: 'unknown',
        private_home_auth: 'unknown',
        cost_reporting: 'unknown',
        resume: 'unknown',
      },
      native_result: 'not_tried',
      selected_inner_mode: 'external_verified',
      outer_proof_hash: HASH,
      permission_policy_hash: HASH,
      environment_hash: HASH,
      settings_hash: HASH,
      host_policy_hash: HASH,
      layout_shapes: { coder: HASH },
      fixture_refs: [],
      checked_at: 0,
      manifest_hash: HASH,
    };
    expect(CapabilityManifestSchema.safeParse(manifest).success).toBe(false);
    expect(
      CapabilityManifestSchema.safeParse({
        ...manifest,
        native_result: 'failed',
      }).success,
    ).toBe(true);
    expect(
      CapabilityManifestSchema.safeParse({
        ...manifest,
        native_result: 'failed',
        outer_proof_hash: null,
      }).success,
    ).toBe(false);
  });
});

describe('replay defaults and pure runtime decisions', () => {
  it('a v1 log replays to runtime defaults', () => {
    const sim = started(buildTask());
    const state = replay(sim.events);
    expect(state).toMatchObject(emptyRuntime());
  });

  it('start with a runtime snapshot commits RuntimeConfigured before PolicyFrozen', () => {
    const task = buildTask();
    const d0 = new StoreDriver(openMemoryStore());
    d0.must(task.id, { kind: 'create_task', task });
    proposeAndConfirm(d0, task, selectionFor(task, 'full-review'));
    const s0 = granted(d0.task(task.id));
    const d = decide({
      state: s0,
      policy: null,
      envelope: envelope(
        task.id,
        {
          kind: 'start',
          freeze: freezeOk(task, { mode: 'full-review' }),
          runtime: confirmedRuntime(d0, task),
        },
        { ids: [uuidOf(70), uuidOf(71), uuidOf(72), uuidOf(73)] },
      ),
      related: { deps: {}, dependency_cycle: false },
    });
    if (d.kind !== 'accepted') throw new Error(JSON.stringify(d));
    const types = d.events.map((e) => e.type);
    expect(types.indexOf('RuntimeConfigured')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('RuntimeConfigured')).toBeLessThan(types.indexOf('PolicyFrozen'));
  });

  it('a runtime snapshot for another base is rejected', () => {
    const task = buildTask();
    const created = decide({
      state: null,
      policy: null,
      envelope: envelope(
        task.id,
        { kind: 'create_task', task },
        {
          authz: {
            actor: 'o',
            roles: ['operate'],
            issued_by: 't',
            issued_at: 0,
          },
          expected_version: 0,
        },
      ),
      related: { deps: {}, dependency_cycle: false },
    });
    if (created.kind !== 'accepted') throw new Error('create rejected');
    const d = decide({
      state: granted(replay(created.events)),
      policy: null,
      envelope: envelope(
        task.id,
        {
          kind: 'start',
          freeze: freezeOk(task),
          runtime: buildRuntime(task, { base_sha: 'other' }),
        },
        { ids: [uuidOf(70)] },
      ),
      related: { deps: {}, dependency_cycle: false },
    });
    expect(d).toMatchObject({
      kind: 'rejected',
      code: 'invalid_trigger',
      detail: { reason: 'runtime_freeze_mismatch' },
    });
  });

  it('business effects are blocked once a merge proof is recorded; service effects are not', () => {
    const sim = started(buildTask());
    const s = structuredClone(sim.s);
    s.completion = {
      proof: {
        subject: {
          provider: 'github',
          immutable_repo_id: 'R',
          subject_id: '1',
          target_ref: 'main',
          head_ref: 'b',
        },
        merged_at: 0,
        merged_head_sha: 'a'.repeat(40),
        checked_head_sha: null,
        merge_commit_sha: 'c'.repeat(40),
        observation_id: 'o',
        evidence_ref: 'e',
      },
      unverified: null,
      recorded_at: 0,
      drain: {
        started_at: null,
        deadline_at: null,
        count: 0,
        max_rounds: 3,
        auto_exhausted: false,
        paused: false,
      },
      pending_operations: [],
      finalized_at: null,
    };
    expect(claimable(s, { id: 'e', kind: 'start_agent', revision: s.revision }, 0)).toEqual({
      ok: false,
      reason: 'completion',
    });
    expect(claimable(s, { id: 'e', kind: 'stop_attempt', revision: s.revision }, 0)).toEqual({
      ok: true,
    });
    expect(
      claimable(
        s,
        { id: 'e', kind: 'observe_external', revision: s.revision },
        Number.MAX_SAFE_INTEGER,
      ),
    ).toEqual({ ok: true });
  });

  it('observation_due needs an open observation window; a drain result needs a merge proof', () => {
    const sim = started(buildTask());
    const due = decide({
      state: sim.s,
      policy: sim.policy,
      envelope: envelope(sim.s.id, { kind: 'observation_due' }),
      related: { deps: {}, dependency_cycle: false },
    });
    expect(due).toMatchObject({
      kind: 'rejected',
      code: 'invalid_trigger',
      detail: { reason: 'no_observation' },
    });
    const drain = decide({
      state: sim.s,
      policy: sim.policy,
      envelope: envelope(sim.s.id, {
        kind: 'drain_result',
        pending_operations: [],
      }),
      related: { deps: {}, dependency_cycle: false },
    });
    expect(drain).toMatchObject({
      kind: 'rejected',
      code: 'invalid_trigger',
      detail: { reason: 'no_completion' },
    });
  });
});
