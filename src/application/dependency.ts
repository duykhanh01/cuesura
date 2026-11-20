/**
 * Dependency notifications (T034, FR-001.02/03). A dependent waits until each prerequisite has recorded a
 * terminal status; a merge seen while the prerequisite still drains is not DONE and releases nothing.
 * DONE counts even when the merged head was not verified, with no extra approval; the dependent still
 * passes its own checks (acceptance, confirmation, config at start). A FAILED or CANCELLED prerequisite
 * cancels the dependent (#249), with the root task in the reason, instead of leaving it PENDING forever.
 * A task of a planned goal waits on the current task of each unit key instead (R-29): a unit FAILED while
 * the goal has not ended is waited on until a task of the same key replaces it.
 *
 * Notifications are derived from committed state on every pass rather than pushed once, so a crash never
 * loses one; the dedup key makes a repeat a no-op.
 */
import { isGoalTerminal, unitPrerequisites } from '../domain/goal.ts';
import { isCascadeCancel } from '../engine/intake.ts';
import type { TaskState, TaskStatus } from '../domain/state.ts';
import type { Uuid } from '../shared/brand.ts';
import type { AcceptOutcome, Store } from '../store/index.ts';
import { submit } from './triage.ts';

const TERMINAL: readonly TaskStatus[] = ['DONE', 'FAILED', 'CANCELLED'];
const DEPENDENCY_WAITS: readonly string[] = ['dependency_pending', 'dependency_failed'];

export type DependencyNotice = {
  readonly task_id: string;
  readonly depends_on: string;
  readonly status: TaskStatus;
  readonly outcome: AcceptOutcome;
};

function waitingOnDependencies(s: TaskState): boolean {
  return (
    s.status === 'PENDING' &&
    s.wait?.reason === 'dependency' &&
    DEPENDENCY_WAITS.includes(s.wait.detail.code)
  );
}

/**
 * The root task of the cascade that cancelled `dep`, walked through the dependency notifications that
 * cancelled each task down the chain, never read from a reason's text: a reason a person typed, or one an
 * earlier release copied from such text (#357), may name any ID. A notification that records its root
 * ends the walk; anything else unknown stops at the task reached.
 */
function cascadeRoot(store: Store, dep: string): Uuid {
  const seen = new Set<string>();
  let id = dep;
  for (;;) {
    if (seen.has(id)) return dep as Uuid;
    seen.add(id);
    const s = store.readTask(id as Uuid);
    if (s === null || s.status !== 'CANCELLED' || !isCascadeCancel(s.cancellation))
      return id as Uuid;
    const key = store.readEvents(id as Uuid).find((e) => e.type === 'CancelRequested')
      ?.causation.dedup_key;
    const t = key === null || key === undefined ? null : store.priorTrigger(key)?.envelope.trigger;
    if (t?.kind !== 'dependency_status') return id as Uuid;
    if (t.provenance?.root !== undefined) return t.provenance.root;
    id = t.depends_on;
  }
}

/**
 * What a dependent's notification records of a prerequisite that did not end DONE: the cascade's root, and
 * the prerequisite's reason masked, since one stored before reasons were masked (#357) may hold a secret.
 */
function endedPrerequisite(
  store: Store,
  dep: string,
  prereq: TaskState,
  redact: ((text: string) => string) | undefined,
): { terminal_reason?: string; root: Uuid } {
  const root = cascadeRoot(store, dep);
  const reason = prereq.terminal?.reason;
  if (reason === undefined || reason === '') return { root };
  return { terminal_reason: redact?.(reason) ?? reason, root };
}

/** Sends `dependency_status` for every prerequisite that ended since its dependent last saw it. */
export function notifyDependents(
  store: Store,
  now: number,
  redact?: (text: string) => string,
): DependencyNotice[] {
  const out: DependencyNotice[] = [];
  for (const id of store.taskIdsByStatus(['PENDING'])) {
    const s = store.readTask(id as Uuid);
    if (s === null || !waitingOnDependencies(s)) continue;
    const goal = s.task.goal === undefined ? null : store.goals.read(s.task.goal.id);
    const byKey = unitPrerequisites(s.task.goal, goal);
    for (const dep of byKey ?? s.task.depends_on) {
      const prereq = store.readTask(dep as Uuid);
      if (prereq === null || !TERMINAL.includes(prereq.status)) continue;
      const replan =
        byKey !== null &&
        goal !== null &&
        !isGoalTerminal(goal.status) &&
        prereq.status === 'FAILED';
      const r = submit(store, {
        task_id: s.id,
        // A failed prerequisite gets its own key: a dependent that saw it before the cascade existed
        // (#249) still waits on `dependency_failed` and is cancelled on the next pass. One seen while its
        // goal replans gets another, so the goal ending later still cascades.
        dedup_key:
          prereq.status === 'DONE'
            ? `dep:${s.id}:${dep}:DONE`
            : replan
              ? `dep-replan:${s.id}:${dep}`
              : `dep-cascade:${s.id}:${dep}:${prereq.status}`,
        trigger: {
          kind: 'dependency_status',
          depends_on: dep as Uuid,
          status: prereq.status,
          provenance: {
            prerequisite_version: prereq.version,
            unverified_reason: prereq.completion?.unverified?.reason ?? null,
            ...(prereq.status !== 'DONE' ? endedPrerequisite(store, dep, prereq, redact) : {}),
          },
          ...(replan ? { replan: true as const } : {}),
        },
        now,
      });
      if (r.ok && !r.value.duplicate)
        out.push({
          task_id: s.id,
          depends_on: dep,
          status: prereq.status,
          outcome: r.value,
        });
    }
  }
  return out;
}
