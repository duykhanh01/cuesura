/**
 * A wait past the end of the ladder (`ladder_exhausted`, `rung_denied`) is the deputy's (007, FR-004).
 * With no `deputy` role configured the daemon ends it with `task fail` as `system:deputy-absent`, as
 * #247 did in the engine; the binding is live config, so the engine cannot decide this (R-11). Until a
 * round has done so, `holds` keeps the wait from the assistant.
 */
import type { DetailCode, TaskState } from '../domain/state.ts';
import { MAX_ENVELOPE_IDS } from '../domain/trigger.ts';
import type { Clock } from '../adapters/ports.ts';
import type { Uuid } from '../shared/brand.ts';
import { submit } from '../application/triage.ts';
import type { DeputyWatch } from '../application/attention.ts';
import type { Store } from '../store/index.ts';

export const DEPUTY_ABSENT_ACTOR = 'system:deputy-absent';

/** Waits the engine opens where #247 failed the task. */
export const EXHAUSTED_WAITS: readonly DetailCode[] = ['ladder_exhausted', 'rung_denied'];

export type DeputyAbsentDeps = {
  readonly store: Store;
  readonly clock: Pick<Clock, 'now'>;
  readonly newId: () => string;
  /** Whether the user config names a `deputy` role right now. */
  readonly configured: () => Promise<boolean>;
  readonly log?: (msg: string) => void;
};

/** The reason #247 recorded for the same end, so reports read alike. */
function failReason(s: TaskState): string {
  const d = s.wait?.detail ?? { code: 'ladder_exhausted' };
  const step = typeof d['step'] === 'string' ? d['step'] : (s.current_step ?? '');
  return d.code === 'rung_denied'
    ? `rung_denied:${step}:${String(d['rung'])}`
    : `${d.code}:${step}`;
}

const exhausted = (s: TaskState): boolean =>
  s.status === 'WAITING' && s.wait !== null && EXHAUSTED_WAITS.includes(s.wait.detail.code);

export function createDeputyAbsent(deps: DeputyAbsentDeps): DeputyWatch & {
  round(): Promise<void>;
} {
  // Unknown until the first round reads the config: held meanwhile, as that round follows within a tick.
  let configured: boolean | null = null;
  let version = 0;
  return {
    async round() {
      const now = await deps.configured();
      if (now !== configured) version += 1;
      configured = now;
      if (now) return;
      for (const id of deps.store.taskIdsByStatus(['WAITING'])) {
        const s = deps.store.readTask(id as Uuid);
        if (s === null || !exhausted(s)) continue;
        const at = deps.clock.now();
        const r = submit(deps.store, {
          task_id: s.id,
          dedup_key: `deputy-absent:${s.id}:${s.version}`,
          trigger: { kind: 'fail', reason: failReason(s) },
          now: at,
          ids: Array.from({ length: MAX_ENVELOPE_IDS }, () => deps.newId()),
          expected_version: s.version,
          authz: {
            actor: DEPUTY_ABSENT_ACTOR,
            roles: ['operate'],
            issued_by: 'daemon',
            issued_at: at,
          },
        });
        if (!r.ok) deps.log?.(`task ${s.id}: deputy-absent fail: ${r.error.code}`);
      }
    },
    holds: (s) => configured !== true && exhausted(s),
    version: () => version,
  };
}
