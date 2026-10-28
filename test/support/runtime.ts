import { computeRuntimeHash, DEFAULT_RUNTIME_LIMITS, type FrozenRuntimeContext } from '../../src/domain/runtime.ts';
import type { CanonicalTask } from '../../src/domain/task.ts';
import type { Uuid } from '../../src/shared/brand.ts';
import { freezeOk } from './builders.ts';
import type { StoreDriver } from './store-driver.ts';

/** A valid 002 runtime snapshot for `task`, matching `freezeOk(task)` (base `base0000`). */
export function buildRuntime(task: CanonicalTask, over: Partial<Omit<FrozenRuntimeContext, 'runtime_hash'>> = {}): FrozenRuntimeContext {
  const rt: Omit<FrozenRuntimeContext, 'runtime_hash'> = {
    schema_version: 1,
    task_id: task.id,
    revision: task.revision,
    base_sha: 'base0000',
    completion_mode: 'external_confirmation',
    network_mode: 'internet_outbound',
    isolation: { mode: 'isolated', provider: 'bwrap' },
    project_path: '/srv/acme',
    target: { provider: 'github', repo: 'acme/app', immutable_repo_id: 'R_1', base_ref: task.base_branch },
    limits: DEFAULT_RUNTIME_LIMITS,
    capability_refs: {},
    credential_refs: [],
    ...over,
  };
  return { ...rt, runtime_hash: computeRuntimeHash(rt) };
}

/** create → queue → grant → start with a runtime snapshot; returns the granted request ID. */
export function createGrantStart(d: StoreDriver, task: CanonicalTask): string {
  d.must(task.id, { kind: 'create_task', task });
  d.must(task.id, { kind: 'request_execution' });
  const g = d.store.grantNext(d.now as never);
  if (!g.ok || g.value.kind !== 'decided' || g.value.outcome.decision.kind !== 'accepted') throw new Error(`grant failed: ${JSON.stringify(g)}`);
  d.must(task.id, { kind: 'start', freeze: freezeOk(task, { limits: { max_wall_ms: 3_600_000 } }), runtime: buildRuntime(task) });
  return g.value.request_id;
}

export function asUuid(id: string): Uuid {
  return id as Uuid;
}
