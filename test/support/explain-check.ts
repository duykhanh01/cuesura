import type { DomainEvent } from '../../src/domain/event.ts';
import type { FrozenPolicy } from '../../src/domain/policy.ts';
import type { TaskState } from '../../src/domain/state.ts';
import { explain, type Explanation } from '../../src/explain/explain.ts';

export function checkWaitExplained(
  state: TaskState,
  events: readonly DomainEvent[],
  policy: FrozenPolicy | null,
): Explanation | null {
  if (state.status !== 'PENDING' && state.status !== 'WAITING') return null;
  const x = explain(state, events, policy);
  const where = `task ${state.id} ${state.status} sau seq ${state.version}`;
  if (state.wait === null || x.wait === null)
    throw new Error(`${where}: wait reason is missing (SC-006)`);
  if (x.wait.resume_when.length === 0)
    throw new Error(`${where}: wait ${state.wait.detail.code} is missing resume_when (SC-006)`);
  if (x.wait.exit_paths.length === 0)
    throw new Error(`${where}: wait ${state.wait.detail.code} is missing exit_paths (SC-006)`);
  if (x.wait.reason !== state.wait.reason || x.wait.detail !== state.wait.detail)
    throw new Error(`${where}: explanation differs from the projection`);
  return x;
}
