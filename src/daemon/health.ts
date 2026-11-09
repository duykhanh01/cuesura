/**
 * `GET /v1/health` (FR-022/023, FR-036). Healthy only while the daemon can hand out work: a latched store
 * or filesystem write failure, a blocked dispatch (projection mismatch, recovery failure) and new work
 * held for unresolved claims each answer 503 `unhealthy` with the reason, so `cusr status` exits 1. Only
 * reads the store, so it still answers when the disk is full.
 */
import type { Store } from '../store/index.ts';
import type { Dispatcher } from './dispatch.ts';
import { errorReply, type Reply } from './server.ts';
import { okEnvelope } from '../cli/output.ts';
import { STARTUP_REPORT_FILE, type StartupReport } from './startup.ts';
import type { SpoolIngestReport } from './ingest.ts';
import type { QueuePause } from './queue-pause.ts';
import { queuePausedView } from '../explain/explain.ts';
import { buildInfo, packageVersion } from '../cli/program.ts';

export type HealthInput = {
  readonly store: Store;
  readonly dispatcher: Dispatcher;
  readonly startup: StartupReport;
  readonly unresolved: StartupReport['unresolved'];
  readonly now: number;
  readonly spoolProblems?: readonly SpoolIngestReport[];
  /** `cusr queue pause` in force: tasks not started yet wait; not a health problem (issue #142). */
  readonly queuePaused?: QueuePause | null;
  /** How many tasks may hold an execution slot at once (FR-044.01); default 1. */
  readonly concurrency?: number;
};

/** The first problem that stops work from being handed out, most fundamental first; null when none. */
export function healthProblem(d: Dispatcher): string | null {
  if (d.latchedReason !== null) return `store unwritable: ${d.latchedReason}`;
  if (d.blockedReason !== null) return `dispatch blocked: ${d.blockedReason}`;
  if (d.heldReason !== null) return `new work held: ${d.heldReason}`;
  return null;
}

export function healthReply(h: HealthInput): Reply {
  const { dispatcher, startup, store } = h;
  const data = {
    // Answering at all means this daemon holds the writer lock; `store` says whether it can write.
    writer: 'ok',
    build: { version: packageVersion(), ...buildInfo() },
    store: {
      writable: dispatcher.latchedReason === null,
      failure: dispatcher.latchedReason,
    },
    // Counted once while the daemon started (issue #260); `cusr doctor` counts now.
    startup: { at: startup.at, projections: startup.projections, timers: startup.timers },
    dispatch: {
      blocked: dispatcher.blockedReason,
      held: dispatcher.heldReason,
      in_flight: dispatcher.inFlight,
    },
    recovery: {
      report: STARTUP_REPORT_FILE,
      steps: startup.steps,
      unresolved: h.unresolved,
      spool_problems: h.spoolProblems ?? [],
      legacy_read_only: startup.legacy_read_only,
    },
    slots: store.readSlots(),
    loans: store.readLoans(),
    concurrency: h.concurrency ?? 1,
    queue_length: store.readQueue(100).length,
    queue_paused: queuePausedView(h.queuePaused ?? null, h.now),
    now: h.now,
  };
  const problem = healthProblem(dispatcher);
  if (problem !== null)
    return errorReply(503, {
      code: 'unhealthy',
      message: problem,
      details: data,
    });
  return { status: 200, envelope: okEnvelope(data) };
}
