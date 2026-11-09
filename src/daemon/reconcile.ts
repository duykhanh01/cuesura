/**
 * Reconciling open operations (T086, FR-034.01/035, contracts/execution.md §5). Every operation the store has not resolved is matched against the host — the unit, the
 * kernel operation lock, launch.json, pid.json and exit.json — and the finding is committed as facts
 * before any work is granted:
 *
 * - no launch marker, no live unit, lock free: the harness never spawned (`not_launched`), and the marker is
 *   taken so that it never will; the agent effect is reconciled `not_executed`, which returns its reservation;
 * - the runner or its harness is alive (same boot, pid and start ticks, or the lock still held): adopted
 *   as `running`, never spawned again;
 * - exit.json final: `finished` with the runner's outcome; reading the result is the effect's own
 *   reconcile, so the effect becomes `unknown` and keeps its reservation;
 * - process proven gone without exit.json: `lost` (FR-035); the effect becomes `unknown`;
 * - anything unreadable or inconsistent: `unknown`, the claim kept, and the daemon holds new work.
 *
 * Operations that ran inside the daemon (Git, GitHub, gates) have no runner to adopt, but the processes
 * they spawned run in their own process groups and may outlive the daemon. Those are stopped (they
 * lost their reader and their timeout); while one still runs the operation is `running`, and a process
 * that may be one but cannot be read is `unknown`; both keep the effect `started`. Only once none is
 * left is the operation `lost`, and the outcome of its external effect is left to that effect's
 * reconcile (T089/T090). An
 * effect whose receipt was committed but whose result was not stays `started` with no open operation;
 * it is settled the same way (T093).
 * Nothing here spawns, retries or releases a claim it cannot prove, and the only thing it stops is what
 * a dead daemon left behind. Whether a lost attempt resumes
 * its session is the engine's decision (T099), from the attempt facts reported here.
 */
import { existsSync } from 'node:fs';
import type { UnitObservation } from '../adapters/ports.ts';
import type { OperationOutcome, OperationStatus, ProcessIdentity } from '../domain/runtime.ts';
import { isTerminal, TASK_STATUSES, type OperationMirror } from '../domain/state.ts';
import type { Trigger } from '../domain/trigger.ts';
import { isUnresolved } from '../engine/runtime.ts';
import { RUN_FILES, RunDir, RunnerFileError } from '../runner/files.ts';
import {
  HOST_PROBE,
  PidRecordSchema,
  toProcessIdentity,
  type IdentityProbe,
} from '../runner/identity.ts';
import { RunnerExitSchema, type RunnerExit } from '../runner/lifecycle.ts';
import {
  lockFilePath,
  probeOperationLock,
  fenceLaunch,
  readLaunchMarker,
  type LockProbe,
} from '../runner/operation-lock.ts';
import {
  clearOperationMark,
  findTagged,
  readOperationMark,
  stopTagged,
  type TaggedProbe,
  type TaggedStopper,
} from '../runner/process-tag.ts';
import type { Redactor } from '../runner/redact.ts';
import { observeLaunch } from '../runner/supervisor.ts';
import { canonicalJson } from '../shared/canonical-json.ts';
import type { Uuid } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import type { Store } from '../store/index.ts';
import { factEnvelope } from './ingest.ts';
import { runLocation } from './retention.ts';

export type UnitInspector = (operationId: string) => Promise<UnitObservation>;
export type LockInspector = (operationId: string) => LockProbe;

export type ReconcileDeps = {
  readonly store: Store;
  readonly dataDir: string;
  readonly redactor: Redactor;
  readonly inspect: UnitInspector;
  readonly probeLock?: LockInspector;
  readonly identity?: IdentityProbe;
  /** Processes still tagged with an in-process operation; defaults to scanning `/proc`. */
  readonly tagged?: TaggedProbe;
  /** Kills what a dead daemon left running; defaults to SIGKILL after an identity check. */
  readonly stopTagged?: TaggedStopper;
  /** How long a pass waits for stopped processes to be gone (default {@link KILL_VERIFY_MS}). */
  readonly killVerifyMs?: number;
  readonly now: () => number;
  readonly newId: () => string;
  /** Effects whose handler still runs in this daemon: their operations are left alone. */
  readonly inFlight?: (effectId: string) => boolean;
};

export type OperationFinding = {
  readonly status: Exclude<OperationStatus, 'registered'>;
  readonly outcome: OperationOutcome | null;
  readonly invocation_id: string | null;
  readonly processes: readonly ProcessIdentity[];
  readonly started_at: number | null;
  readonly finished_at: number | null;
  /** The evidence that decided the status. */
  readonly reason: string;
};

/** What recovery committed for the operation's effect; `kept` leaves it as it was. */
export type EffectFact = 'not_executed' | 'unknown' | 'kept';

export type AttemptFacts = {
  readonly id: string;
  readonly step: string;
  readonly kind: string;
  readonly binding: string;
  readonly reservation_id: string;
};

export type OperationReconcile = {
  readonly task_id: string;
  readonly operation_id: string;
  readonly effect_id: string;
  readonly from: OperationStatus;
  readonly finding: OperationFinding;
  readonly effect: EffectFact;
  /** A lost agent attempt: what the engine weighs before any resume (FR-035, T099). */
  readonly attempt: AttemptFacts | null;
  /** The store refused a fact (`write_failed` or the decision). */
  readonly error?: string;
};

export type ReconcileReport = {
  readonly operations: readonly OperationReconcile[];
  /** Claims recovery could not resolve: they are kept, and no new work is granted while any remains. */
  readonly unresolved: readonly {
    readonly task_id: string;
    readonly operation_id: string;
    readonly reason: string;
  }[];
  /** Effects left `started` after every operation of theirs settled: what recovery committed for them. */
  readonly orphaned: readonly OrphanedEffect[];
  readonly write_failed: boolean;
};

export type OrphanedEffect = {
  readonly task_id: string;
  readonly effect_id: string;
  readonly effect: Exclude<EffectFact, 'kept'>;
  readonly error?: string;
};

/** The runner's flock creates the lock file: without one, no runner ever held this operation. */
export function hostLockProbe(dataDir: string): LockInspector {
  return (operationId) => {
    let file: string;
    try {
      file = lockFilePath(dataDir, operationId);
    } catch {
      return 'unknown';
    }
    return existsSync(file) ? probeOperationLock(file) : 'free';
  };
}

const unknown = (reason: string, unit: UnitObservation | null = null): OperationFinding => ({
  status: 'unknown',
  outcome: null,
  invocation_id: unit?.invocation_id ?? null,
  processes: [],
  started_at: null,
  finished_at: null,
  reason,
});

function runOutcome(x: RunnerExit): OperationOutcome {
  switch (x.outcome) {
    case 'exited':
      return x.exit_code === 0 ? 'succeeded' : 'failed';
    case 'signaled':
    case 'spawn_failed':
      return 'failed';
    case 'timeout':
    case 'stalled':
      return 'timeout';
    case 'cancelled':
      return 'cancelled';
    case 'artifact_backpressure':
      return 'backpressure';
  }
}

/** No launch marker: the runner never reached the harness spawn, unless it is still on its way there. */
function beforeMarker(unit: UnitObservation, lock: () => LockProbe): OperationFinding {
  if (unit.state === 'unknown') return unknown('unit state unreadable');
  const base = {
    outcome: null,
    invocation_id: unit.invocation_id,
    processes: [],
    started_at: null,
    finished_at: null,
  };
  if (unit.state === 'active')
    return {
      ...base,
      status: 'running',
      reason: 'runner unit active before its launch marker',
    };
  const held = lock();
  if (held === 'held')
    return {
      ...base,
      status: 'running',
      reason: 'runner holds the operation lock before its launch marker',
    };
  if (held === 'unknown') return unknown('operation lock unreadable', unit);
  return {
    ...base,
    status: 'not_launched',
    reason: `no launch marker; unit ${unit.state}; lock free`,
  };
}

/** What the host shows for one runner-launched operation; reads only, never stops or spawns. */
export async function observeRunnerOperation(
  deps: ReconcileDeps,
  op: Pick<OperationMirror, 'id' | 'attempt_id'>,
): Promise<OperationFinding> {
  const unit = await deps.inspect(op.id);
  const lock = (): LockProbe => (deps.probeLock ?? hostLockProbe(deps.dataDir))(op.id);
  let run: RunDir | null = null;
  try {
    run = RunDir.open({
      dataDir: deps.dataDir,
      ...runLocation(op),
      redactor: deps.redactor,
      create: false,
    });
  } catch (e) {
    if (!(e instanceof RunnerFileError && e.code === 'not_found'))
      return unknown(
        `run directory unreadable: ${e instanceof Error ? e.message : String(e)}`,
        unit,
      );
  }
  if (run === null) return beforeMarker(unit, lock);
  const marker = readLaunchMarker(run);
  if (marker.state === 'missing') return beforeMarker(unit, lock);
  if (marker.state === 'invalid') return unknown(`launch marker invalid: ${marker.reason}`, unit);
  if (marker.value.operation_id !== op.id)
    return unknown('launch marker belongs to another operation', unit);
  if (marker.value.fence === true)
    return {
      status: 'not_launched',
      outcome: null,
      invocation_id: null,
      processes: [],
      started_at: null,
      finished_at: null,
      reason: 'fenced: a late runner refuses to start',
    };
  const nonce = marker.value.launch_nonce;

  const pid = run.readFinal(RUN_FILES.pid, PidRecordSchema);
  const receipt =
    pid.state === 'valid' && pid.value.operation_id === op.id && pid.value.launch_nonce === nonce
      ? pid.value
      : null;
  const processes = receipt === null ? [] : [toProcessIdentity(receipt)];
  const invocation = receipt?.invocation_id ?? unit.invocation_id;
  const launchedAt = Date.parse(marker.value.at);
  const startedAt = Number.isSafeInteger(launchedAt) ? launchedAt : null;

  const exit = run.readFinal(RUN_FILES.exit, RunnerExitSchema);
  if (exit.state === 'invalid') return unknown(`exit.json invalid: ${exit.reason}`, unit);
  if (exit.state === 'valid') {
    const x = exit.value;
    if (x.operation_id !== op.id || x.launch_nonce !== nonce)
      return unknown('exit record belongs to another launch', unit);
    if (!x.spawned)
      return {
        status: 'not_launched',
        outcome: null,
        invocation_id: invocation,
        processes: [],
        started_at: null,
        finished_at: null,
        reason: 'runner recorded that the harness never started',
      };
    return {
      status: 'finished',
      outcome: runOutcome(x),
      invocation_id: invocation,
      processes,
      started_at: x.started_at,
      finished_at: x.ended_at,
      reason: `exit.json ${x.outcome}`,
    };
  }

  const seen = observeLaunch(run, lock, deps.identity ?? HOST_PROBE);
  const found = {
    outcome: null,
    invocation_id: invocation,
    processes,
    started_at: startedAt,
    finished_at: null,
  };
  switch (seen.state) {
    case 'running':
      return { ...found, status: 'running', reason: seen.reason };
    case 'lost':
      // The lock is free and the identity gone, yet systemd still runs the unit: no proof either way.
      if (unit.state === 'active')
        return unknown(`${seen.reason}, but the unit is still active`, unit);
      return { ...found, status: 'lost', reason: seen.reason };
    case 'unknown':
      return unknown(seen.reason, unit);
    default:
      return unknown(`launch state ${seen.state} without exit.json`, unit);
  }
}

/**
 * `not_launched` releases the effect and lets the engine start a replacement, so it must also be true later:
 * a command still queued in a terminal's shell shows nothing on the host until it runs (ADR-0006). The run
 * directory holds what that command needs; without one there is nothing it could start.
 */
async function fencedRunnerOperation(
  deps: ReconcileDeps,
  op: Pick<OperationMirror, 'id' | 'attempt_id'>,
): Promise<OperationFinding> {
  const found = await observeRunnerOperation(deps, op);
  if (found.status !== 'not_launched') return found;
  try {
    const run = RunDir.open({
      dataDir: deps.dataDir,
      ...runLocation(op),
      redactor: deps.redactor,
      create: false,
    });
    const claim = fenceLaunch(run, {
      operation_id: op.id,
      attempt_id: op.attempt_id ?? null,
      at: new Date(deps.now()).toISOString(),
    });
    // Either the marker was already there (this finding read it) or a runner just took it: read again.
    return claim.state === 'claimed' ? found : observeRunnerOperation(deps, op);
  } catch (e) {
    if (e instanceof RunnerFileError && e.code === 'not_found') return found;
    return unknown(`cannot fence the operation: ${e instanceof Error ? e.message : String(e)}`, {
      unit: '',
      state: 'unknown',
      invocation_id: null,
      cgroup: null,
    });
  }
}

export const KILL_VERIFY_MS = 2_000;

/**
 * An operation run by a daemon process that is gone, without its receipt. It is lost only once no
 * process it spawned is left: a surviving git push or gh call may still change the remote. Survivors
 * lost their reader and their timeout with the daemon, so they are stopped here (FR-034.01, bounded
 * like any operation) and the operation stays running until a scan proves them gone.
 */
async function interrupted(
  deps: ReconcileDeps,
  op: Pick<OperationMirror, 'id'>,
): Promise<OperationFinding> {
  const mark = readOperationMark(deps.dataDir, op.id);
  if (!mark.ok) return unknown(mark.detail);
  const scan = (): ReturnType<TaggedProbe> => (deps.tagged ?? findTagged)(op.id, mark.mark);
  let found = scan();
  let stopped = 0;
  const end = Date.now() + (deps.killVerifyMs ?? KILL_VERIFY_MS);
  while (found.ok && found.processes.length > 0) {
    if (stopped === 0) stopped = found.processes.length;
    (deps.stopTagged ?? stopTagged)(found.processes);
    const last = Date.now() >= end;
    if (!last) await new Promise((r) => setTimeout(r, 50));
    found = scan();
    if (last) break;
  }
  if (!found.ok) return unknown(`process scan failed: ${found.detail}`);
  const base = {
    outcome: null,
    invocation_id: null,
    started_at: null,
    finished_at: null,
  };
  if (found.processes.length > 0)
    return {
      ...base,
      status: 'running',
      processes: found.processes,
      reason: `daemon ended; ${found.processes.length} of its processes for the operation still run after SIGKILL`,
    };
  return {
    ...base,
    status: 'lost',
    processes: [],
    reason:
      stopped === 0
        ? 'ran inside a daemon that ended without its receipt'
        : `ran inside a daemon that ended without its receipt; ${stopped} surviving processes stopped`,
  };
}

function changed(op: OperationMirror, f: OperationFinding): boolean {
  if (op.status !== f.status) return true;
  return (
    f.status === 'running' &&
    canonicalJson([op.invocation_id, op.processes]) !==
      canonicalJson([f.invocation_id, f.processes])
  );
}

type Submitted = { ok: true } | { ok: false; error: string };

function submitFact(deps: ReconcileDeps, taskId: string, key: string, trigger: Trigger): Submitted {
  const now = deps.now();
  const r = deps.store.accept(
    factEnvelope(taskId, key, trigger, {
      now,
      started_at: now,
      newId: deps.newId,
    }),
  );
  if (!r.ok)
    return {
      ok: false,
      error: r.error.code === 'write_failed' ? 'write_failed' : JSON.stringify(r.error),
    };
  return r.value.decision.kind === 'accepted'
    ? { ok: true }
    : { ok: false, error: JSON.stringify(r.value.decision) };
}

/** Commits the finding, then what it means for the effect; a repeat after a crash is a duplicate. */
function commit(
  deps: ReconcileDeps,
  taskId: string,
  op: OperationMirror,
  found: OperationFinding,
  runner: boolean,
): OperationReconcile {
  // An adopted runner that vanished without its marker never spawned, but `running` cannot step back
  // to `not_launched`: it is lost, and the effect waits for its reconcile.
  const finding: OperationFinding =
    op.status === 'running' && found.status === 'not_launched'
      ? {
          ...found,
          status: 'lost',
          reason: `adopted runner gone: ${found.reason}`,
        }
      : found;
  const base = {
    task_id: taskId,
    operation_id: op.id,
    effect_id: op.effect_id,
    from: op.status,
    finding,
  };
  const fail = (error: string): OperationReconcile => ({
    ...base,
    effect: 'kept',
    attempt: null,
    error,
  });
  if (changed(op, finding)) {
    const r = submitFact(deps, taskId, `recover:${op.id}:${hashCanonical(finding)}`, {
      kind: 'operation_result',
      operation_id: op.id as Uuid,
      status: finding.status,
      outcome: finding.outcome,
      invocation_id: finding.invocation_id,
      processes: [...finding.processes],
      started_at: finding.started_at as never,
      finished_at: finding.finished_at as never,
      receipt_digest: hashCanonical({ operation: op.id, finding }),
    });
    if (!r.ok) return fail(r.error);
  }

  const s = deps.store.readTask(taskId as Uuid);
  const effect = s?.effects[op.effect_id];
  let fact: EffectFact = 'kept';
  if (s !== null && effect !== undefined && !isTerminal(s.status)) {
    if (
      finding.status === 'not_launched' &&
      effect.kind === 'start_agent' &&
      (effect.status === 'started' || effect.status === 'unknown')
    ) {
      const r = submitFact(deps, taskId, `recover:${op.id}:not_executed`, {
        kind: 'effect_reconciled',
        effect_id: effect.id as Uuid,
        finding: 'not_executed',
      });
      if (!r.ok) return fail(r.error);
      fact = 'not_executed';
    } else if (
      effect.status === 'started' &&
      finding.status !== 'running' &&
      // An in-process operation not proven ended keeps its effect where a probe cannot race it.
      (runner || finding.status !== 'unknown')
    ) {
      const r = submitFact(deps, taskId, `recover:${op.id}:effect_unknown`, {
        kind: 'effect_result',
        effect_id: effect.id as Uuid,
        ...(effect.attempt_id === null ? {} : { attempt_id: effect.attempt_id as Uuid }),
        outcome: 'unknown',
      });
      if (!r.ok) return fail(r.error);
      fact = 'unknown';
    }
  }
  const attempt =
    finding.status === 'lost' && op.attempt_id !== null
      ? (s?.attempts[op.attempt_id] ?? null)
      : null;
  return {
    ...base,
    effect: fact,
    attempt:
      attempt === null
        ? null
        : {
            id: attempt.id,
            step: attempt.step,
            kind: attempt.kind,
            binding: attempt.binding,
            reservation_id: attempt.reservation_id,
          },
  };
}

/**
 * One pass over every unresolved operation not owned by a running handler. At startup it runs before
 * ingest and dispatch; the daemon repeats it to follow adopted runners and retry unreadable probes.
 */
export async function reconcileOperations(deps: ReconcileDeps): Promise<ReconcileReport> {
  const operations: OperationReconcile[] = [];
  const unresolved: {
    task_id: string;
    operation_id: string;
    reason: string;
  }[] = [];
  for (const row of deps.store.unresolvedOperations()) {
    if (deps.inFlight?.(row.effect_id) === true) continue;
    const s = deps.store.readTask(row.task_id as Uuid);
    const op = s?.operations[row.id];
    if (s === null || s === undefined || op === undefined) continue;
    const runner = op.kind === 'agent' && s.effects[op.effect_id]?.kind === 'start_agent';
    // An in-process operation already recorded lost has nothing new to show.
    if (!runner && op.status === 'lost') continue;
    const finding = runner ? await fencedRunnerOperation(deps, op) : await interrupted(deps, op);
    // Probes yield: a handler that started meanwhile, or a receipt that arrived, wins.
    const current = deps.store.readTask(row.task_id as Uuid)?.operations[op.id];
    if (deps.inFlight?.(row.effect_id) === true || current === undefined || !isUnresolved(current))
      continue;
    const r = commit(deps, row.task_id, current, finding, runner);
    operations.push(r);
    if (r.error === 'write_failed')
      return { operations, unresolved, orphaned: [], write_failed: true };
    if (!runner && r.error === undefined && finding.status === 'lost')
      try {
        clearOperationMark(deps.dataDir, op.id);
      } catch {
        // A stale mark only narrows what a later scan may skip.
      }
    const after = deps.store.readTask(row.task_id as Uuid)?.operations[op.id];
    if (r.error !== undefined || after?.status === 'unknown')
      unresolved.push({
        task_id: row.task_id,
        operation_id: op.id,
        reason: r.error ?? finding.reason,
      });
  }
  const orphaned = settleOrphans(deps);
  return {
    operations,
    unresolved,
    orphaned,
    write_failed: orphaned.some((o) => o.error === 'write_failed'),
  };
}

const SETTLED: readonly OperationStatus[] = ['finished', 'not_launched', 'lost'];

/** The operation the effect registered last, in commit order. */
function lastRegistered(store: Store, taskId: string, effectId: string): string | null {
  let last: string | null = null;
  for (const ev of store.readEvents(taskId as Uuid))
    if (ev.type === 'OperationRegistered' && ev.payload.effect_id === effectId)
      last = ev.payload.operation_id;
  return last;
}

/**
 * A receipt committed without its effect result: the daemon died between the two transactions, or
 * recovery did, between the two facts `commit` writes. The operation is no longer open, so the pass
 * above never sees it again, and no handler runs the effect: it would stay `started` for good. A harness
 * that provably never spawned is `not_executed`; anything else becomes `unknown` and goes to its
 * reconcile like any other interrupted effect.
 */
function settleOrphans(deps: ReconcileDeps): OrphanedEffect[] {
  const out: OrphanedEffect[] = [];
  const live = TASK_STATUSES.filter((x) => !isTerminal(x));
  for (const taskId of deps.store.taskIdsByStatus(live)) {
    const s = deps.store.readTask(taskId as Uuid);
    if (s === null) continue;
    for (const e of Object.values(s.effects)) {
      if (e.status !== 'started' || deps.inFlight?.(e.id) === true) continue;
      const ops = Object.values(s.operations).filter((o) => o.effect_id === e.id);
      if (ops.length === 0 || ops.some((o) => !SETTLED.includes(o.status))) continue;
      const never = e.kind === 'start_agent' && ops.every((o) => o.status === 'not_launched');
      // Keyed by the execution, not the effect: a requeued effect runs again under a new operation and
      // may be orphaned again; a key reused from the earlier run would only return its cached answer.
      // The latest execution is the last one registered in the committed log, never the clock's pick.
      const latest = lastRegistered(deps.store, taskId, e.id);
      if (latest === null) continue;
      const key = `recover:${e.id}:${latest}`;
      const r = never
        ? submitFact(deps, taskId, `${key}:not_executed`, {
            kind: 'effect_reconciled',
            effect_id: e.id as Uuid,
            finding: 'not_executed',
          })
        : submitFact(deps, taskId, `${key}:effect_unknown`, {
            kind: 'effect_result',
            effect_id: e.id as Uuid,
            ...(e.attempt_id === null ? {} : { attempt_id: e.attempt_id as Uuid }),
            outcome: 'unknown',
          });
      out.push({
        task_id: taskId,
        effect_id: e.id,
        effect: never ? 'not_executed' : 'unknown',
        ...(r.ok ? {} : { error: r.error }),
      });
      if (!r.ok && r.error === 'write_failed') return out;
    }
  }
  return out;
}
