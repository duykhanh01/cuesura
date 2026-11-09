import { MAX_CONCURRENCY } from '../../src/config/schema-user.ts';
import {
  computeRuntimeHash,
  DEFAULT_RUNTIME_LIMITS,
  type FrozenRuntimeContext,
} from '../../src/domain/runtime.ts';
import type { CanonicalTask } from '../../src/domain/task.ts';
import type { FrozenPolicy } from '../../src/domain/policy.ts';
import {
  selectionDigest,
  type ExecutionMode,
  type RunSelection,
} from '../../src/domain/run-config.ts';
import type { Hash, Uuid } from '../../src/shared/brand.ts';
import { buildPolicy, freezeOk, ownerAuthz, type PolicyOptions } from './builders.ts';
import type { StoreDriver } from './store-driver.ts';

/** A valid 002 runtime snapshot for `task`, matching `freezeOk(task)` (base `base0000`). */
export function buildRuntime(
  task: CanonicalTask,
  over: Partial<Omit<FrozenRuntimeContext, 'runtime_hash'>> = {},
): FrozenRuntimeContext {
  const rt: Omit<FrozenRuntimeContext, 'runtime_hash'> = {
    schema_version: 1,
    task_id: task.id,
    revision: task.revision,
    base_sha: 'base0000',
    completion_mode: 'external_confirmation',
    network_mode: 'internet_outbound',
    isolation: { mode: 'native', provider: 'host' },
    project_path: '/srv/acme',
    target: {
      provider: 'github',
      repo: 'acme/app',
      immutable_repo_id: 'R_1',
      base_ref: task.base_branch,
    },
    limits: DEFAULT_RUNTIME_LIMITS,
    capability_refs: {},
    credential_refs: [],
    ...over,
  };
  return { ...rt, runtime_hash: computeRuntimeHash(rt) };
}

/**
 * The run selection that matches `freezeOk(task, { mode })`: worker = the coder binding, reviewer = the
 * review binding (full-review), every other worker rung allowed as a fallback.
 */
export function selectionFor(
  task: CanonicalTask,
  mode: ExecutionMode,
  policy: FrozenPolicy = buildPolicy({
    task_id: task.id,
    revision: task.revision,
    mode,
  }),
): RunSelection {
  const pick = (b: {
    harness: string;
    model: string;
    effort: RunSelection['worker']['effort'];
  }) => ({ harness: b.harness, model: b.model, effort: b.effort });
  const code = policy.steps['code'] as FrozenPolicy['steps'][string];
  const worker = pick(code.binding);
  const seen = new Set([JSON.stringify(worker)]);
  const fallbacks: RunSelection['fallbacks'] = [];
  for (const sp of Object.values(policy.steps)) {
    if (sp.role !== 'coder' && sp.role !== 'fixer') continue;
    for (const r of sp.ladder) {
      const c = pick(r.binding);
      if (!seen.has(JSON.stringify(c))) {
        seen.add(JSON.stringify(c));
        fallbacks.push(c);
      }
    }
  }
  const review = policy.steps['review'];
  return {
    task_id: task.id,
    revision: task.revision,
    profile: policy.profile,
    mode,
    reason: 'test',
    worker,
    reviewer: mode === 'full-review' && review !== undefined ? pick(review.binding) : null,
    fallbacks,
  };
}

/** Proposes `selection` and confirms it from the owner's channel. */
export function proposeAndConfirm(
  d: StoreDriver,
  task: CanonicalTask,
  selection: RunSelection,
): string {
  d.must(task.id, { kind: 'propose_run_config', selection });
  const digest = selectionDigest(selection);
  d.must(task.id, { kind: 'confirm_run_config', digest }, { authz: ownerAuthz() });
  return digest;
}

/** The runtime snapshot carrying the confirmed selection of `task` in `d`. */
export function confirmedRuntime(
  d: StoreDriver,
  task: CanonicalTask,
  over: Partial<Omit<FrozenRuntimeContext, 'runtime_hash'>> = {},
): FrozenRuntimeContext {
  const s = d.task(task.id);
  const p = s.run.proposal;
  const c = s.run.confirmation;
  if (p === null || c === null) throw new Error('no confirmed run selection');
  return buildRuntime(task, {
    run_config: {
      mode: p.selection.mode,
      selection: p.selection,
      digest: p.digest as Hash,
      confirmation: c,
    },
    pr_template: null,
    ...over,
  });
}

/** create → confirm a run selection → queue → grant → start with a runtime snapshot; returns the granted request ID. */
export function createGrantStart(
  d: StoreDriver,
  task: CanonicalTask,
  mode: ExecutionMode = 'full-review',
  policy: Pick<PolicyOptions, 'limits' | 'ci_rules' | 'required_checks' | 'roles'> = {},
  runtime: Partial<Omit<FrozenRuntimeContext, 'runtime_hash'>> = {},
  // Started tasks keep their slot reserved while they wait (FR-044.02), so fixtures that put several
  // tasks in flight run as with a large `runtime.concurrency`; slot tests pass the capacity they test.
  capacity = MAX_CONCURRENCY,
): string {
  d.must(task.id, { kind: 'create_task', task });
  proposeAndConfirm(d, task, selectionFor(task, mode));
  d.must(task.id, { kind: 'request_execution' });
  const g = d.store.grantNext(d.now as never, [], { capacity });
  if (!g.ok || g.value.kind !== 'decided' || g.value.outcome.decision.kind !== 'accepted')
    throw new Error(`grant failed: ${JSON.stringify(g)}`);
  d.must(task.id, {
    kind: 'start',
    freeze: freezeOk(task, {
      ...policy,
      limits: { max_wall_ms: 3_600_000, ...policy.limits },
      mode,
    }),
    runtime: confirmedRuntime(d, task, runtime),
  });
  return g.value.request_id;
}

export function asUuid(id: string): Uuid {
  return id as Uuid;
}
