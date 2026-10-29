/**
 * Dependency notifications (T034, FR-001.02/03). A dependent waits until each prerequisite has recorded a
 * terminal status; a merge seen while the prerequisite still drains is not DONE and releases nothing.
 * DONE counts even when the merged head was not verified, with no extra approval; the dependent still
 * passes its own checks (acceptance, confirmation, config at start).
 *
 * Notifications are derived from committed state on every pass rather than pushed once, so a crash never
 * loses one; the dedup key makes a repeat a no-op.
 */
import type { TaskState, TaskStatus } from '../domain/state.ts';
import type { Uuid } from '../shared/brand.ts';
import type { AcceptOutcome, Store } from '../store/index.ts';
import { submit } from './triage.ts';

const TERMINAL: readonly TaskStatus[] = ['DONE', 'FAILED', 'CANCELLED'];
const DEPENDENCY_WAITS: readonly string[] = ['dependency_pending', 'dependency_failed'];

export type DependencyNotice = { readonly task_id: string; readonly depends_on: string; readonly status: TaskStatus; readonly outcome: AcceptOutcome };

function waitingOnDependencies(s: TaskState): boolean {
  return s.status === 'PENDING' && s.wait?.reason === 'dependency' && DEPENDENCY_WAITS.includes(s.wait.detail.code);
}

/** Sends `dependency_status` for every prerequisite that ended since its dependent last saw it. */
export function notifyDependents(store: Store, now: number): DependencyNotice[] {
  const out: DependencyNotice[] = [];
  for (const id of store.taskIdsByStatus(['PENDING'])) {
    const s = store.readTask(id as Uuid);
    if (s === null || !waitingOnDependencies(s)) continue;
    for (const dep of s.task.depends_on) {
      const prereq = store.readTask(dep);
      if (prereq === null || !TERMINAL.includes(prereq.status)) continue;
      const r = submit(store, {
        task_id: s.id,
        dedup_key: `dep:${s.id}:${dep}:${prereq.status}`,
        trigger: {
          kind: 'dependency_status',
          depends_on: dep,
          status: prereq.status,
          provenance: { prerequisite_version: prereq.version, unverified_reason: prereq.completion?.unverified?.reason ?? null },
        },
        now,
      });
      if (r.ok && !r.value.duplicate) out.push({ task_id: s.id, depends_on: dep, status: prereq.status, outcome: r.value });
    }
  }
  return out;
}
