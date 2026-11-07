/**
 * Daemon startup recovery (T085, FR-022/036, data-model.md). The
 * order is fixed and nothing is granted before it ends:
 *
 *   1. writer lock: the store file is opened with an exclusive lock; a second daemon gets `store_locked`;
 *   2. schema/integrity: migration, then `integrity_check`; a newer schema is refused untouched;
 *   3. verify: every projection rebuilt from the committed log in global order must match the tables;
 *      task snapshots that differ only in `state_json` are rewritten from the log first (snapshotDrift);
 *   4. reconcile: open operations against the host (reconcile.ts); slot, queue and timers are read back
 *      as committed, never re-armed or extended;
 *   5. ingest: what runners wrote while no daemon ran, from the committed cursor (ingest.ts);
 *   6. schedule: only now may the dispatcher hand out work.
 *
 * Steps 1–2 failing means no daemon. A projection mismatch, a store write failure or an unwritable report
 * blocks dispatch; a claim recovery could not resolve holds new work while service effects keep running.
 * Both are health failures with their reason. A task without a runtime snapshot (001) stays read-only.
 * The report is written to DATA_DIR before any work is granted.
 */
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminal, TASK_STATUSES } from '../domain/state.ts';
import { canonicalJson } from '../shared/canonical-json.ts';
import type { Uuid } from '../shared/brand.ts';
import type { Result } from '../shared/result.ts';
import { openStore, type Store, type StoreOpenError } from '../store/index.ts';
import { snapshotDrift } from '../store/verify.ts';
import {
  ingestAllSpools,
  ingestOperationSpool,
  type SpoolIngestReport,
  type SpoolIngestDeps,
} from './ingest.ts';
import {
  reconcileOperations,
  type OperationReconcile,
  type ReconcileDeps,
  type ReconcileReport,
} from './reconcile.ts';

export const STARTUP_REPORT_FILE = 'startup-report.json';

export const STARTUP_STEPS = [
  'writer_lock',
  'schema_integrity',
  'verify',
  'reconcile',
  'ingest',
  'schedule',
] as const;
export type StartupStepName = (typeof STARTUP_STEPS)[number];

export type StartupStep = {
  readonly step: StartupStepName;
  readonly status: 'ok' | 'failed' | 'skipped';
  readonly detail?: string;
};

export type StartupReport = {
  readonly at: number;
  readonly steps: readonly StartupStep[];
  readonly projections: {
    readonly ok: boolean;
    readonly tasks: number;
    readonly events: number;
    readonly mismatches: number;
    /** Tasks whose snapshot was rewritten from the log before verifying again. */
    readonly rewritten: readonly string[];
  };
  readonly operations: readonly OperationReconcile[];
  readonly unresolved: ReconcileReport['unresolved'];
  /** Effects whose receipt was committed without their result, settled before dispatch. */
  readonly orphaned: ReconcileReport['orphaned'];
  /** Spools that had something to ingest or failed; up-to-date ones are left out. */
  readonly ingest: readonly SpoolIngestReport[];
  readonly slots: ReturnType<Store['readSlots']>;
  readonly queue_length: number;
  readonly timers: { readonly armed: number; readonly overdue: number };
  /** Tasks started before 002 without a runtime snapshot: read-only, never dispatched. */
  readonly legacy_read_only: readonly string[];
  /** Dispatch refused entirely. */
  readonly blocked: string | null;
  /** New work held while claims are unresolved; service effects still run. */
  readonly held: string | null;
};

export type RecoveryDeps = Omit<ReconcileDeps, 'store'> & Pick<SpoolIngestDeps, 'probeCursors'>;

export type StartupDeps = RecoveryDeps & {
  /** The store file inside `dataDir`. */
  readonly path: string;
  readonly busyTimeoutMs?: number;
};

/** Reason new work is held, or null when every claim is resolved. */
export function heldReason(unresolved: ReconcileReport['unresolved']): string | null {
  return unresolved.length === 0 ? null : `unresolved claims (${unresolved.length})`;
}

/** Reconcile, then ingest what the reconciled runners wrote (the daemon repeats this while it runs). */
export async function recoverOperations(
  deps: ReconcileDeps & Pick<SpoolIngestDeps, 'probeCursors'>,
): Promise<{
  readonly reconcile: ReconcileReport;
  readonly ingest: readonly SpoolIngestReport[];
}> {
  // Reconciliation skips handlers owned by this daemon; their live output still needs ingesting.
  const open = deps.store.unresolvedOperations();
  const reconcile = await reconcileOperations(deps);
  const ingest: SpoolIngestReport[] = [];
  if (!reconcile.write_failed) {
    const operations = new Map(open.map((o) => [o.id, o.task_id]));
    for (const o of reconcile.operations) operations.set(o.operation_id, o.task_id);
    for (const [id, taskId] of operations) {
      const i = ingestOperationSpool({ ...deps, finalOnly: true }, taskId, id);
      ingest.push(i);
      if (i.status === 'write_failed') break;
    }
  }
  return { reconcile, ingest };
}

/** temp → fsync → rename → fsync directory, owner-only. */
function writeReport(dataDir: string, report: StartupReport): string | null {
  const file = join(dataDir, STARTUP_REPORT_FILE);
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, `${canonicalJson(report)}\n`, { mode: 0o600 });
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    const dir = openSync(dataDir, 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function committedState(
  store: Store,
  now: number,
): Pick<StartupReport, 'slots' | 'queue_length' | 'timers' | 'legacy_read_only'> {
  let armed = 0;
  let overdue = 0;
  const legacy: string[] = [];
  for (const id of store.taskIdsByStatus(TASK_STATUSES)) {
    const s = store.readTask(id as Uuid);
    if (s === null) continue;
    if (s.policy_ref !== null && s.runtime_ref === null && !isTerminal(s.status)) legacy.push(id);
    for (const t of Object.values(s.timers)) {
      if (t.status !== 'armed') continue;
      armed += 1;
      if (t.due_at <= now) overdue += 1;
    }
  }
  return {
    slots: store.readSlots(),
    queue_length: store.readQueue(1_000).length,
    timers: { armed, overdue },
    legacy_read_only: legacy,
  };
}

/**
 * Steps 1–5. On success the caller owns the store and must apply `blocked`/`held` to its dispatcher
 * before the first tick; step 6 is that first tick.
 */
export async function recoverStore(
  deps: StartupDeps,
): Promise<Result<{ store: Store; report: StartupReport }, StoreOpenError>> {
  const opened = openStore(
    deps.path,
    deps.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: deps.busyTimeoutMs },
  );
  if (!opened.ok) return opened;
  const store = opened.value;
  const steps: StartupStep[] = [
    { step: 'writer_lock', status: 'ok' },
    { step: 'schema_integrity', status: 'ok' },
  ];
  const full: ReconcileDeps & Pick<SpoolIngestDeps, 'probeCursors'> = {
    ...deps,
    store,
  };

  let verify = store.verifyProjections();
  let blocked: string | null = null;
  let rewritten: string[] = [];
  const drift = verify.ok ? null : snapshotDrift(verify);
  if (drift !== null) {
    try {
      rewritten = store.rewriteTaskSnapshots(drift);
      verify = store.verifyProjections();
    } catch (e) {
      blocked = `store write failed during snapshot rewrite: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  let operations: readonly OperationReconcile[] = [];
  let unresolved: ReconcileReport['unresolved'] = [];
  let orphaned: ReconcileReport['orphaned'] = [];
  let ingest: SpoolIngestReport[] = [];
  if (blocked !== null || !verify.ok) {
    blocked ??= `projection mismatch (${verify.mismatches.length})`;
    steps.push(
      { step: 'verify', status: 'failed', detail: blocked },
      { step: 'reconcile', status: 'skipped' },
      { step: 'ingest', status: 'skipped' },
    );
  } else {
    steps.push(
      rewritten.length === 0
        ? { step: 'verify', status: 'ok' }
        : {
            step: 'verify',
            status: 'ok',
            detail: `${rewritten.length} task snapshots rewritten from the event log`,
          },
    );
    const r = await reconcileOperations(full);
    operations = r.operations;
    unresolved = r.unresolved;
    orphaned = r.orphaned;
    if (r.write_failed) {
      blocked = 'store write failed during reconcile';
      steps.push(
        { step: 'reconcile', status: 'failed', detail: blocked },
        { step: 'ingest', status: 'skipped' },
      );
    } else {
      steps.push({
        step: 'reconcile',
        status: 'ok',
        detail: `${operations.length} reconciled, ${unresolved.length} unresolved`,
      });
      ingest = ingestAllSpools({ ...full, finalOnly: true }).filter(
        (i) => i.status !== 'up_to_date' && i.status !== 'no_run_dir',
      );
      const failed = ingest.find((i) => i.status === 'write_failed');
      if (failed !== undefined) {
        blocked = 'spool ingest write failed';
        steps.push({ step: 'ingest', status: 'failed', detail: blocked });
      } else steps.push({ step: 'ingest', status: 'ok' });
    }
  }

  const held = blocked === null ? heldReason(unresolved) : null;
  const report = (schedule: StartupStep): StartupReport => ({
    at: deps.now(),
    steps: [...steps, schedule],
    projections: {
      ok: verify.ok,
      tasks: verify.tasks,
      events: verify.events,
      mismatches: verify.mismatches.length,
      rewritten,
    },
    operations,
    unresolved,
    orphaned,
    ingest,
    ...committedState(store, deps.now()),
    blocked,
    held,
  });
  const scheduled: StartupStep =
    blocked !== null
      ? { step: 'schedule', status: 'skipped', detail: blocked }
      : held !== null
        ? {
            step: 'schedule',
            status: 'ok',
            detail: `service effects only: ${held}`,
          }
        : { step: 'schedule', status: 'ok' };
  const done = report(scheduled);
  const written = writeReport(deps.dataDir, done);
  if (written === null) return { ok: true, value: { store, report: done } };
  // Work is never granted without the report on disk.
  const reason = `startup report not written: ${written}`;
  const final: StartupReport = {
    ...report({ step: 'schedule', status: 'skipped', detail: reason }),
    blocked: blocked ?? reason,
    held: null,
  };
  return { ok: true, value: { store, report: final } };
}
