/**
 * One incident is one entry into a wait (007, FR-020): task, revision, wait code and the global seq of
 * the event that entered it. Same shape as the attention key, so a turn and a person's item name it alike.
 */
import type { TaskState } from '../domain/state.ts';
import type { Uuid } from '../shared/brand.ts';
import type { Store } from '../store/index.ts';

const ENTERS_WAIT: ReadonlySet<string> = new Set(['TaskPending', 'TaskWaiting']);

export function incidentKey(s: TaskState, enteredSeq: number): string {
  return `${s.id}:${s.revision}:${s.wait?.detail.code ?? 'run_config_unconfirmed'}:${enteredSeq}`;
}

/** Reads the log only when the task moved since the last call for it. */
export function incidentReader(store: Store): (s: TaskState) => string | null {
  const known = new Map<string, { readonly version: number; readonly key: string }>();
  return (s) => {
    if (s.wait === null) return null;
    const hit = known.get(s.id);
    if (hit?.version === s.version) return hit.key;
    const seq =
      store.readEvents(s.id as Uuid).findLast((e) => ENTERS_WAIT.has(e.type))?.global_seq ?? 0;
    const key = incidentKey(s, seq);
    known.set(s.id, { version: s.version, key });
    return key;
  };
}
