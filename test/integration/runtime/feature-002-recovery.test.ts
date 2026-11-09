/**
 * Daemon restart recovery on a real SQLite file and real run directories (T084, FR-022, FR-034.01–03,
 * FR-035, FR-036). Startup runs in a fixed order and grants nothing before its report is on disk; open
 * operations are matched against the unit, the operation lock, launch/pid/exit files and the process
 * identity, and a claim recovery cannot prove is kept and holds new work. Systemd, the lock and /proc are
 * scripted here except where noted; the runner itself is covered by T081.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import type { UnitObservation } from '../../../src/adapters/ports.ts';
import { notifyDependents } from '../../../src/application/dependency.ts';
import { callDaemon } from '../../../src/cli/client.ts';
import { drainRound } from '../../../src/daemon/drain.ts';
import { STORE_FILE, startDaemon } from '../../../src/daemon/main.ts';
import { reconcileOperations, type ReconcileDeps } from '../../../src/daemon/reconcile.ts';
import {
  STARTUP_REPORT_FILE,
  STARTUP_STEPS,
  recoverStore,
  type StartupDeps,
} from '../../../src/daemon/startup.ts';
import type { MergeProof, ProcessIdentity } from '../../../src/domain/runtime.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { EventLogWriter, RUN_FILES, RunDir } from '../../../src/runner/files.ts';
import { taskLogs } from '../../../src/application/logs.ts';
import type { IdentityProbe, PidRecord } from '../../../src/runner/identity.ts';
import { execOperation, type RunnerExit } from '../../../src/runner/lifecycle.ts';
import { fenceLaunch } from '../../../src/runner/operation-lock.ts';
import { FLOCK, lockFilePath, type LockProbe } from '../../../src/runner/operation-lock.ts';
import { readOperationMark, writeOperationMark } from '../../../src/runner/process-tag.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { SCHEMA_VERSION } from '../../../src/store/migrate.ts';
import { openFileStoreForTest, storeDb } from '../../../src/store/testing.ts';
import { buildTask, freezeOk, uuidOf } from '../../support/builders.ts';
import { createGrantStart, proposeAndConfirm, selectionFor } from '../../support/runtime.ts';
import { agentData, ciData, PREPARE_DATA, publishData } from '../../support/scenario.ts';
import { buildHandlers, type HandlerDeps } from '../../../src/daemon/handlers.ts';
import type { TriggerEnvelope } from '../../../src/domain/trigger.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { toPublish, reviewToCi } from '../../support/store-flows.ts';
import { useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-recovery-');
const OP = uuidOf(901);
const BOOT = 'boot-1';
const NONCE = 'launch-1';
const PID = 4242;
const TICKS = 777;
const HEAD = 'a'.repeat(40);

type Host = {
  unit: UnitObservation['state'];
  lock: LockProbe;
  /** Start ticks per pid; missing means the process is gone. */
  ticks: Map<number, number | 'unreadable'>;
  /** Processes still tagged with an in-process operation, or a /proc that cannot be read. */
  tagged: ProcessIdentity[] | 'unreadable';
  /** Survivors that a SIGKILL does not take down (stuck in the kernel); the rest go when stopped. */
  unkillable: boolean;
  stopped: ProcessIdentity[];
};

type Fixture = {
  readonly dir: string;
  d: StoreDriver;
  readonly host: Host;
};

function fixture(): Fixture {
  const dir = tempDir();
  return {
    dir,
    d: new StoreDriver(openFileStoreForTest(join(dir, STORE_FILE))),
    host: {
      unit: 'not_found',
      lock: 'free',
      ticks: new Map(),
      tagged: [],
      unkillable: false,
      stopped: [],
    },
  };
}

const identity = (h: Host): IdentityProbe => ({
  bootId: () => BOOT,
  startTicks: (pid) => h.ticks.get(pid) ?? null,
});

function probes(f: Fixture): Omit<StartupDeps, 'path'> {
  return {
    dataDir: f.dir,
    redactor: new Redactor(),
    inspect: (id) =>
      Promise.resolve({
        unit: `cusr-op-${id}.service`,
        state: f.host.unit,
        invocation_id: f.host.unit === 'active' ? 'b'.repeat(32) : null,
        cgroup: null,
      }),
    probeLock: () => f.host.lock,
    identity: identity(f.host),
    tagged: () =>
      f.host.tagged === 'unreadable'
        ? { ok: false, detail: 'EACCES' }
        : { ok: true, processes: f.host.tagged },
    stopTagged: (ps) => {
      f.host.stopped.push(...ps);
      if (!f.host.unkillable) f.host.tagged = [];
    },
    killVerifyMs: 0,
    now: () => f.d.now,
    newId: uuidv7,
  };
}

function reconcileDeps(f: Fixture): ReconcileDeps {
  return { ...probes(f), store: f.d.store };
}

/** Closes the store as a killed daemon would leave it, then runs startup recovery on the same file. */
/** `realLock` drops the scripted lock probe so recovery asks the kernel lock itself. */
async function restart(f: Fixture, realLock = false) {
  f.d.store.close();
  const { probeLock, ...rest } = probes(f);
  const r = await recoverStore({
    ...rest,
    ...(realLock || probeLock === undefined ? {} : { probeLock }),
    path: join(f.dir, STORE_FILE),
  });
  if (!r.ok) throw new Error(`recover: ${JSON.stringify(r.error)}`);
  const now = f.d.now;
  f.d = new StoreDriver(r.value.store, 7);
  f.d.now = now;
  return r.value.report;
}

/** prepare done, the code attempt claimed with a slot-bound agent operation (nothing launched yet). */
function toAgent(
  f: Fixture,
  t: CanonicalTask = buildTask({ id: uuidOf(1) }),
  before?: (t: CanonicalTask) => void,
): { task: CanonicalTask; effectId: string; attemptId: string } {
  createGrantStart(f.d, t);
  f.d.complete(t.id, f.d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  before?.(t);
  const e = f.d.pendingOne(t.id, 'start_agent');
  const claimed = f.d.store.claimEffect(e.id as Uuid, f.d.now as EpochMs, {
    require_runtime: true,
    operation: {
      operation_id: OP,
      kind: 'agent',
      launch_nonce: 'dispatch-1',
      unit: `cusr-op-${OP}.service`,
      holds_slot: true,
    },
  });
  if (!claimed.ok) throw new Error(`claim: ${JSON.stringify(claimed.error)}`);
  const attemptId = f.d.task(t.id).effects[e.id]?.attempt_id;
  if (attemptId == null) throw new Error('no attempt');
  return { task: t, effectId: e.id, attemptId };
}

function runDir(f: Fixture, attemptId: string): RunDir {
  return RunDir.open({
    dataDir: f.dir,
    kind: 'runs',
    id: attemptId,
    redactor: new Redactor(),
  });
}

/** What a runner writes once it holds the lock: the marker, then the harness identity. */
function launched(f: Fixture, attemptId: string, pid = true): RunDir {
  const run = runDir(f, attemptId);
  run.createLaunchMarker({
    schema_version: 1,
    operation_id: OP,
    attempt_id: attemptId,
    launch_nonce: NONCE,
    boot_id: BOOT,
    runner_pid: PID - 1,
    at: new Date(f.d.now).toISOString(),
  });
  if (pid) {
    const rec: PidRecord = {
      schema_version: 1,
      operation_id: OP,
      launch_nonce: NONCE,
      boot_id: BOOT,
      pid: PID,
      pgid: PID,
      start_ticks: TICKS,
      runner_pid: PID - 1,
      runner_start_ticks: 1,
      invocation_id: 'c'.repeat(32),
      cgroup: `/user.slice/cusr-op-${OP}.service`,
    };
    run.writeJson('pid.json', rec);
  }
  return run;
}

function exited(f: Fixture, run: RunDir, attemptId: string): void {
  const exit: RunnerExit = {
    schema_version: 1,
    operation_id: OP,
    run_id: attemptId,
    launch_nonce: NONCE,
    outcome: 'exited',
    exit_code: 0,
    signal: null,
    spawned: true,
    started_at: f.d.now - 1_000,
    ended_at: f.d.now,
    duration_ms: 1_000,
    deadline_at: f.d.now + 60_000,
    termination: {
      term_sent: false,
      kill_sent: false,
      tree_empty_verified: true,
      scope: 'unit_cgroup',
      killed_after_exit: 0,
    },
    progress: { last_progress_at: f.d.now, last_reasons: [], samples: 1 },
    artifacts: { records: 0, last_seq: 0, truncated_records: 0 },
    error: null,
  };
  run.writeExit(exit);
}

const eventCount = (f: Fixture): number =>
  (
    storeDb(f.d.store).prepare('SELECT COUNT(*) AS n FROM events').get() as {
      n: number;
    }
  ).n;

const types = (f: Fixture, taskId: string): string[] =>
  f.d.store.readEvents(taskId as Uuid).map((e) => e.type);

describe('startup order (T085, FR-022, FR-036)', () => {
  it.each(['exit', 'lost'] as const)(
    'keeps a live log cursor through restart and %s without per-tick events',
    async (completion) => {
      const f = fixture();
      const { task, attemptId } = toAgent(f);
      const run = launched(f, attemptId);
      f.host.ticks.set(PID, TICKS);
      f.host.unit = 'active';
      const log = EventLogWriter.open(run, OP);
      const logs = (after: number) =>
        taskLogs(
          { store: f.d.store, dataDir: f.dir, redactor: new Redactor() },
          {
            grant: {
              actor: 'reader',
              roles: ['read'],
            },
          },
          { kind: 'task_logs', task_id: task.id, after },
        );
      for (let i = 0; i < 3; i++) log.append('progress', { i });
      log.sync();
      expect(logs(0)).toMatchObject({
        ok: true,
        value: {
          next_cursor: 3,
          records: [{ data: { i: 0 } }, { data: { i: 1 } }, { data: { i: 2 } }],
        },
      });
      for (let i = 3; i < 5; i++) log.append('progress', { i });
      log.sync();
      await restart(f);
      expect(types(f, task.id)).not.toContain('OutputIngested');
      expect(logs(3)).toMatchObject({
        ok: true,
        value: {
          next_cursor: 5,
          records: [{ data: { i: 3 } }, { data: { i: 4 } }],
        },
      });
      log.close();
      if (completion === 'exit') exited(f, run, attemptId);
      f.host.ticks.clear();
      f.host.unit = completion === 'exit' ? 'exited' : 'not_found';
      await restart(f);
      expect(logs(5)).toMatchObject({
        ok: true,
        value: { next_cursor: 5, records: [] },
      });
      expect(types(f, task.id).filter((t) => t === 'OutputIngested')).toHaveLength(1);
    },
  );

  it('writes its report with every step in order before anything is granted; a second writer is refused', async () => {
    const f = fixture();
    toAgent(f);
    f.host.ticks.set(PID, TICKS);
    const report = await restart(f);
    expect(report.steps.map((s) => s.step)).toEqual([...STARTUP_STEPS]);
    expect(report.steps.every((s) => s.status === 'ok')).toBe(true);
    expect(report).toMatchObject({ blocked: null, held: null });
    const file = JSON.parse(readFileSync(join(f.dir, STARTUP_REPORT_FILE), 'utf8')) as unknown;
    expect(file).toEqual(JSON.parse(JSON.stringify(report)));

    const second = await recoverStore({
      ...probes(f),
      path: join(f.dir, STORE_FILE),
      busyTimeoutMs: 50,
    });
    expect(second).toMatchObject({
      ok: false,
      error: { code: 'store_locked' },
    });
  });

  it('a database newer than the code never starts and is left untouched', async () => {
    const f = fixture();
    f.d.store.close();
    const raw = new Database(join(f.dir, STORE_FILE));
    raw.prepare('UPDATE schema_meta SET version = ?').run(SCHEMA_VERSION + 1);
    raw.close();
    const r = await recoverStore({
      ...probes(f),
      path: join(f.dir, STORE_FILE),
    });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'schema_incompatible' },
    });
    expect(existsSync(join(f.dir, STARTUP_REPORT_FILE))).toBe(false);
  });

  it('a projection that no longer replays blocks dispatch before reconcile or ingest touch anything', async () => {
    const f = fixture();
    const { task } = toAgent(f);
    storeDb(f.d.store).prepare('UPDATE execution_slot SET claimed_at = claimed_at + 1').run();
    f.d.store.close();
    const started = await startDaemon({
      dataDir: f.dir,
      clock: { now: () => f.d.now as EpochMs, monotonic: () => 0 },
      newId: uuidv7,
      dispatchIntervalMs: 60_000,
      inspectUnit: probes(f).inspect,
      probeLock: () => 'free',
      identity: identity(f.host),
    });
    if (!started.ok) throw new Error(started.error.detail);
    try {
      expect(started.value.startup.steps).toMatchObject([
        { step: 'writer_lock', status: 'ok' },
        { step: 'schema_integrity', status: 'ok' },
        { step: 'verify', status: 'failed' },
        { step: 'reconcile', status: 'skipped' },
        { step: 'ingest', status: 'skipped' },
        { step: 'schedule', status: 'skipped' },
      ]);
      // The operation would be provably not launched, yet nothing is reconciled on a mismatched store.
      expect(started.value.store.readTask(task.id)?.operations[OP]?.status).toBe('registered');
      const health = await callDaemon({
        socketPath: started.value.socketPath,
        actor: 'owner',
        method: 'GET',
        path: '/v1/health',
      });
      expect(health.ok && health.value.status).toBe(503);
      expect(health.ok && health.value.envelope).toMatchObject({
        ok: false,
        error: {
          code: 'unhealthy',
          message: expect.stringContaining('projection mismatch') as string,
        },
      });
    } finally {
      await started.value.stop();
    }
  });

  it('a snapshot written before a release derived a new field is rewritten from the log, not blocking dispatch', async () => {
    const f = fixture();
    const { task } = toAgent(f);
    f.host.ticks.set(PID, TICKS);
    const db = storeDb(f.d.store);
    const before = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as {
      state_json: string;
    };
    const state = JSON.parse(before.state_json) as { run: Record<string, unknown> };
    delete state.run['ci_wait'];
    db.prepare('UPDATE tasks SET state_json = ? WHERE id = ?').run(JSON.stringify(state), task.id);
    expect(f.d.store.verifyProjections().ok).toBe(false);

    const report = await restart(f);
    expect(report.steps.find((s) => s.step === 'verify')).toEqual({
      step: 'verify',
      status: 'ok',
      detail: '1 task snapshots rewritten from the event log',
    });
    expect(report).toMatchObject({
      blocked: null,
      projections: { ok: true, mismatches: 0, rewritten: [task.id] },
    });
    // Reconcile went on to settle the never-launched operation on the rewritten snapshot.
    expect(f.d.store.readTask(task.id)?.run.ci_wait).toEqual({});
    expect(f.d.store.readTask(task.id)?.operations[OP]?.status).toBe('not_launched');
    expect(f.d.store.verifyProjections().ok).toBe(true);
  });

  it('lists a task without a runtime snapshot as read-only', async () => {
    const f = fixture();
    const legacy = buildTask({ id: uuidOf(3), source_key: 'cli:3' });
    f.d.must(legacy.id, { kind: 'create_task', task: legacy });
    f.d.must(legacy.id, {
      kind: 'start',
      freeze: freezeOk(legacy, { limits: { max_wall_ms: 3_600_000 } }),
    });
    const report = await restart(f);
    expect(report.legacy_read_only).toEqual([legacy.id]);
    expect(report.held).toBeNull();
  });

  it('reads the slot, the queue in global order, timers and deadlines back unchanged, even overdue', async () => {
    const f = fixture();
    const a = buildTask({ id: uuidOf(1) });
    createGrantStart(f.d, a);
    const queued = [uuidOf(2), uuidOf(3)].map((id, i) =>
      buildTask({ id, source_key: `cli:${i + 2}` }),
    );
    for (const t of queued) {
      f.d.must(t.id, { kind: 'create_task', task: t });
      proposeAndConfirm(f.d, t, selectionFor(t, 'full-review'));
      f.d.now += 10;
      f.d.must(t.id, { kind: 'request_execution' });
    }
    const db = () => storeDb(f.d.store);
    const before = {
      slots: f.d.store.readSlots(),
      queue: f.d.store.readQueue(10),
      timers: db().prepare('SELECT * FROM timers ORDER BY id').all(),
      deadline: f.d.task(a.id).deadline_at,
    };
    expect(before.queue.map((q) => q.task_id)).toEqual(queued.map((t) => t.id));
    expect(before.deadline).not.toBeNull();

    f.d.now = (before.deadline ?? 0) + 60_000;
    const report = await restart(f);
    expect(report.timers.overdue).toBeGreaterThan(0);
    expect(report.slots).toEqual(before.slots);
    expect(report.queue_length).toBe(2);
    expect({
      slots: f.d.store.readSlots(),
      queue: f.d.store.readQueue(10),
      timers: db().prepare('SELECT * FROM timers ORDER BY id').all(),
      deadline: f.d.task(a.id).deadline_at,
    }).toEqual(before);
    expect(f.d.store.verifyProjections().ok).toBe(true);
  });
});

describe('open operations are reconciled before work is granted (T086, FR-034.01, FR-035)', () => {
  it('no marker, no unit, lock free: never launched, the reservation returns and the engine decides the next attempt', async () => {
    const f = fixture();
    const { task, effectId, attemptId } = toAgent(f);
    const reservation = f.d.task(task.id).effects[effectId]?.reservation_id;
    const report = await restart(f);
    expect(report.operations).toMatchObject([
      {
        operation_id: OP,
        from: 'registered',
        finding: { status: 'not_launched' },
        effect: 'not_executed',
      },
    ]);
    const s = f.d.task(task.id);
    expect(s.operations[OP]?.status).toBe('not_launched');
    expect(s.attempts[attemptId]?.outcome?.status).toBe('not_executed');
    expect(s.budget.reservations[reservation ?? '']?.status).toBe('released');
    // One new attempt with its own ID, never the old one launched again.
    const next = f.d.pending(task.id, 'start_agent');
    expect(next).toHaveLength(1);
    expect(s.effects[next[0]?.id ?? '']?.attempt_id).not.toBe(attemptId);
    expect(f.d.store.verifyProjections().ok).toBe(true);
  });

  it('a runner still queued in a terminal cannot start once recovery reported it never launched (ADR-0006)', async () => {
    const f = fixture();
    const { task, attemptId } = toAgent(f);
    const run = runDir(f, attemptId);
    const spawned = join(f.dir, 'spawned');
    run.writeJson(RUN_FILES.invocation, {
      schema_version: 1,
      operation_id: OP,
      kind: 'agent',
      run_dir_kind: 'runs',
      run_id: attemptId,
      argv: ['/bin/sh', '-c', `touch ${spawned}`],
      cwd: f.dir,
      env: { PATH: '/usr/bin:/bin' },
      wall_ms: null,
      deadline_at: null,
      term_grace_ms: 300,
      kill_verify_ms: 2_000,
      launch_nonce: 'nonce-1',
    });
    const report = await restart(f);
    expect(report.operations).toMatchObject([
      { finding: { status: 'not_launched' }, effect: 'not_executed' },
    ]);
    expect(f.d.pending(task.id, 'start_agent')).toHaveLength(1);
    // The shell gets to the command only now.
    expect(await execOperation(run, { onStop: () => () => undefined })).toEqual({
      state: 'marker_exists',
    });
    expect(existsSync(spawned)).toBe(false);
  });

  it('a crash between the fence and the commit reads as never launched again (ADR-0006)', async () => {
    const f = fixture();
    const { attemptId } = toAgent(f);
    fenceLaunch(runDir(f, attemptId), {
      operation_id: OP,
      attempt_id: attemptId,
      at: new Date(0).toISOString(),
    });
    const report = await restart(f);
    expect(report.operations).toMatchObject([
      { finding: { status: 'not_launched' }, effect: 'not_executed' },
    ]);
  });

  it('a live harness is adopted, never spawned again; its later exit makes the effect unknown with the reservation kept', async () => {
    const f = fixture();
    const { task, effectId, attemptId } = toAgent(f);
    const run = launched(f, attemptId);
    f.host.ticks.set(PID, TICKS);
    f.host.unit = 'active';
    const report = await restart(f);
    expect(report.operations).toMatchObject([{ finding: { status: 'running' }, effect: 'kept' }]);
    expect(report.held).toBeNull();
    let s = f.d.task(task.id);
    expect(s.operations[OP]).toMatchObject({
      status: 'running',
      invocation_id: 'c'.repeat(32),
      processes: [{ boot_id: BOOT, pid: PID, pgid: PID, start_ticks: TICKS }],
    });
    expect(s.effects[effectId]?.status).toBe('started');
    expect(f.d.pending(task.id, 'start_agent')).toEqual([]);
    expect(f.d.store.readSlots()[0]?.holder_task_id).toBe(task.id);

    // A second pass with nothing new commits nothing.
    const events = eventCount(f);
    await reconcileOperations(reconcileDeps(f));
    expect(eventCount(f)).toBe(events);

    exited(f, run, attemptId);
    f.host.ticks.delete(PID);
    f.host.unit = 'exited';
    const later = await reconcileOperations(reconcileDeps(f));
    expect(later.operations).toMatchObject([
      {
        from: 'running',
        finding: { status: 'finished', outcome: 'succeeded' },
        effect: 'unknown',
      },
    ]);
    s = f.d.task(task.id);
    expect(s.effects[effectId]?.status).toBe('unknown');
    expect(f.d.pending(task.id, 'reconcile')).toHaveLength(1);
    expect(s.budget.reservations[s.effects[effectId]?.reservation_id ?? '']?.status).toBe('held');
    expect(f.d.store.verifyProjections().ok).toBe(true);
  });

  it('a harness proven gone without exit.json is lost: the claim and reservation stay, the attempt facts are reported', async () => {
    const f = fixture();
    const { task, effectId, attemptId } = toAgent(f);
    launched(f, attemptId);
    const report = await restart(f);
    expect(report.operations).toMatchObject([
      {
        finding: {
          status: 'lost',
          processes: [{ pid: PID, start_ticks: TICKS }],
        },
        effect: 'unknown',
        attempt: { id: attemptId, step: 'code' },
      },
    ]);
    const s = f.d.task(task.id);
    expect(s.operations[OP]?.status).toBe('lost');
    expect(s.effects[effectId]?.status).toBe('unknown');
    expect(s.budget.reservations[s.effects[effectId]?.reservation_id ?? '']?.status).toBe('held');
    expect(f.d.store.readSlots()[0]?.holder_task_id).toBe(task.id);
    expect(f.d.pending(task.id, 'start_agent')).toEqual([]);
    expect(report.held).toBeNull();
  });

  /** A worker asks, the answer resumes its session, and that resumed run dies without exit.json. */
  async function lostResume(f: Fixture) {
    let question = '';
    const { task, effectId, attemptId } = toAgent(f, undefined, (t) => {
      f.d.complete(
        t.id,
        f.d.pendingOne(t.id, 'start_agent').id,
        'succeeded',
        agentData('needs_input', {
          questions: ['Which encoding?'],
          session_ref: 'sess-1',
        }),
      );
      question = Object.values(f.d.task(t.id).questions)[0]?.id ?? '';
      f.d.must(t.id, {
        kind: 'answer',
        question_id: question as Uuid,
        answer: 'UTF-8',
      });
      const g = f.d.store.grantNext(
        f.d.now as EpochMs,
        [0, 1, 2, 3].map((i) => uuidOf(60_000 + i)),
      );
      if (!g.ok) throw new Error(JSON.stringify(g));
    });
    expect(f.d.task(task.id).attempts[attemptId]?.resumed_from).toBeDefined();
    const used = f.d.task(task.id).budget.agent_runs.used;
    launched(f, attemptId);
    await restart(f);
    expect(f.d.task(task.id).operations[OP]?.status).toBe('lost');
    expect(f.d.task(task.id).effects[effectId]?.status).toBe('unknown');
    return { task, effectId, attemptId, question, used };
  }

  let recN = 61_000;
  /** Runs the daemon's reconcile handler on the pending probe; `prefix` envelopes reach the store. */
  async function reconcileOnce(f: Fixture, taskId: string, prefix = Infinity): Promise<number> {
    const rec = f.d.pending(taskId, 'reconcile')[0];
    if (rec === undefined) throw new Error('no reconcile pending');
    const handlers = buildHandlers({
      store: f.d.store,
      clock: { now: () => f.d.now as EpochMs, monotonic: () => f.d.now },
      newId: () => uuidOf(recN++),
      abort: () => false,
    } as unknown as HandlerDeps);
    const opId = uuidOf(recN++);
    const claim = {
      operation_id: opId,
      kind: 'github' as const,
      launch_nonce: `rec-${opId}`,
      unit: `cusr-op-${opId}.service`,
      holds_slot: false,
    };
    const claimed = f.d.store.claimEffect(rec.id as Uuid, f.d.now as EpochMs, {
      require_runtime: true,
      operation: claim,
    });
    if (!claimed.ok) throw new Error(JSON.stringify(claimed.error));
    const run = handlers.reconcile;
    if (run === undefined) throw new Error('no reconcile handler');
    const out = await run(claimed.value, new AbortController().signal, claim);
    const list = Array.isArray(out) ? out : [out as TriggerEnvelope];
    for (const env of list.slice(0, prefix)) {
      const r = f.d.store.accept(env as TriggerEnvelope);
      expect(r.ok && r.value.decision.kind).toBe('accepted');
    }
    return list.length;
  }

  /** After the lost run is settled: one counted failure, then a new session that carries the answer. */
  function expectFallback(f: Fixture, l: Awaited<ReturnType<typeof lostResume>>): void {
    const s = f.d.task(l.task.id);
    expect(s.effects[l.effectId]?.status).toBe('failed');
    expect(s.operations[OP]?.status).toBe('finished');
    expect(s.attempts[l.attemptId]).toMatchObject({
      status: 'finished',
      outcome: { class: 'infra' },
    });
    expect(s.budget.agent_runs.used).toBe(l.used + 1);
    expect(s.budget.reservations[s.effects[l.effectId]?.reservation_id ?? '']?.status).toBe(
      'consumed',
    );
    for (let i = 0; i < 4 && f.d.pending(l.task.id, 'start_agent').length === 0; i++) {
      f.d.now += 600_000;
      f.d.fire();
      if (f.d.task(l.task.id).wait?.detail.code === 'execution_slot')
        f.d.store.grantNext(
          f.d.now as EpochMs,
          [0, 1, 2, 3].map((k) => uuidOf(63_000 + i * 4 + k)),
        );
    }
    const next = f.d.pendingOne(l.task.id, 'start_agent');
    expect(next.request).toMatchObject({
      resume: null,
      resume_reason: 'session_unusable',
      answers: [{ question_id: l.question, answer: 'UTF-8' }],
    });
    const after = f.d.task(l.task.id);
    expect(after.attempts[after.effects[next.id]?.attempt_id ?? '']?.resumed_from).toBeUndefined();
    expect(f.d.store.verifyProjections().ok).toBe(true);
  }

  it('a resumed run proven lost is a counted, failed run; the next attempt starts a new session with the Q&A (FR-035, FR-038)', async () => {
    const f = fixture();
    const l = await lostResume(f);
    await reconcileOnce(f, l.task.id);
    expectFallback(f, l);
  });

  it('the daemon dying between the reconcile facts never loses the evidence that the run is lost', async () => {
    // How many facts the handler sends, so every crash point between them is tried.
    const probe = fixture();
    const total = await reconcileOnce(probe, (await lostResume(probe)).task.id, 0);
    expect(total).toBeGreaterThan(1);
    for (let prefix = 0; prefix < total; prefix++) {
      const f = fixture();
      const l = await lostResume(f);
      await reconcileOnce(f, l.task.id, prefix);
      // The lost run is closed only together with the failed attempt, never on its own.
      const s = f.d.task(l.task.id);
      expect(s.operations[OP]?.status === 'finished', `prefix ${prefix}`).toBe(
        s.effects[l.effectId]?.status === 'failed',
      );
      await restart(f);
      // Whatever probes recovery left (an interrupted one runs again first, T093) run until settled.
      for (
        let i = 0;
        i < 4 &&
        f.d.task(l.task.id).effects[l.effectId]?.status !== 'failed' &&
        f.d.pending(l.task.id, 'reconcile').length > 0;
        i++
      )
        await reconcileOnce(f, l.task.id);
      expectFallback(f, l);
    }
  });

  it('a pid reused by another process is not the harness: still lost, never stopped', async () => {
    const f = fixture();
    const { task, attemptId } = toAgent(f);
    launched(f, attemptId);
    f.host.ticks.set(PID, TICKS + 1);
    await restart(f);
    expect(f.d.task(task.id).operations[OP]?.status).toBe('lost');
  });

  it('an identity it cannot read keeps the claim and holds new work until a later pass can prove it', async () => {
    const f = fixture();
    const { task, effectId, attemptId } = toAgent(f);
    const run = launched(f, attemptId);
    f.host.ticks.set(PID, 'unreadable');
    f.d.store.close();
    const started = await startDaemon({
      dataDir: f.dir,
      clock: { now: () => f.d.now as EpochMs, monotonic: () => 0 },
      newId: uuidv7,
      dispatchIntervalMs: 60_000,
      inspectUnit: probes(f).inspect,
      probeLock: () => f.host.lock,
      identity: identity(f.host),
    });
    if (!started.ok) throw new Error(started.error.detail);
    try {
      const d = started.value;
      expect(d.startup.unresolved).toMatchObject([
        { operation_id: OP, reason: 'process identity unreadable' },
      ]);
      expect(d.dispatcher.heldReason).toBe('unresolved claims (1)');
      expect(d.store.readTask(task.id)?.effects[effectId]?.status).toBe('unknown');
      // Business work waits; the effect's own reconcile is a service effect and still runs.
      const tick = d.dispatcher.tick();
      expect(tick.started).toEqual([]);
      expect(tick.skipped).toContainEqual({
        effect_id: expect.any(String) as string,
        reason: 'no_handler',
      });
      const health = await callDaemon({
        socketPath: d.socketPath,
        actor: 'owner',
        method: 'GET',
        path: '/v1/health',
      });
      expect(health.ok && health.value.status).toBe(503);

      exited(f, run, attemptId);
      f.host.ticks.delete(PID);
      await d.recover();
      expect(d.dispatcher.heldReason).toBeNull();
      expect(d.store.readTask(task.id)?.operations[OP]?.status).toBe('finished');
    } finally {
      await started.value.stop();
    }
  });

  it('an operation run inside the dead daemon is lost and its effect goes to reconcile, nothing replayed', async () => {
    const f = fixture();
    const t = buildTask({ id: uuidOf(1) });
    createGrantStart(f.d, t);
    toPublish(f.d, t, HEAD);
    f.d.complete(t.id, f.d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(HEAD));
    const pr = f.d.pendingOne(t.id, 'create_pr');
    f.d.store.claimEffect(pr.id as Uuid, f.d.now as EpochMs, {
      require_runtime: true,
      operation: {
        operation_id: OP,
        kind: 'github',
        launch_nonce: 'n',
        unit: `cusr-op-${OP}.service`,
        holds_slot: false,
      },
    });
    const report = await restart(f);
    expect(report.operations).toMatchObject([{ finding: { status: 'lost' }, effect: 'unknown' }]);
    expect(f.d.task(t.id).effects[pr.id]?.status).toBe('unknown');
    expect(f.d.pending(t.id, 'create_pr')).toEqual([]);
    expect(f.d.pending(t.id, 'reconcile')).toHaveLength(1);
    // Lost is final for an in-process operation: the next startup adds nothing.
    const events = eventCount(f);
    await restart(f);
    expect(eventCount(f)).toBe(events);
  });

  it('a git or gh process that outlived the daemon is stopped; its operation stays running until it is proven gone, then lost and reconciled', async () => {
    const f = fixture();
    const t = buildTask({ id: uuidOf(1) });
    createGrantStart(f.d, t);
    toPublish(f.d, t, HEAD);
    f.d.complete(t.id, f.d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(HEAD));
    const pr = f.d.pendingOne(t.id, 'create_pr');
    f.d.store.claimEffect(pr.id as Uuid, f.d.now as EpochMs, {
      require_runtime: true,
      operation: {
        operation_id: OP,
        kind: 'github',
        launch_nonce: 'n',
        unit: `cusr-op-${OP}.service`,
        holds_slot: false,
      },
    });
    const survivor = { boot_id: BOOT, pid: 5151, pgid: 5151, start_ticks: 9 };
    // A survivor that does not die yet: stopped, and the operation stays running.
    f.host.tagged = [survivor];
    f.host.unkillable = true;
    let report = await restart(f);
    expect(f.host.stopped).toEqual([survivor]);
    expect(report.operations).toMatchObject([
      { finding: { status: 'running', processes: [survivor] }, effect: 'kept' },
    ]);
    expect(f.d.task(t.id).operations[OP]?.processes).toEqual([survivor]);
    expect(f.d.task(t.id).effects[pr.id]?.status).toBe('started');
    expect(f.d.pending(t.id, 'reconcile')).toEqual([]);

    // A process that may be the operation's but cannot be read proves nothing: held, not probed.
    f.host.tagged = 'unreadable';
    report = await restart(f);
    expect(report.operations).toMatchObject([{ finding: { status: 'unknown' }, effect: 'kept' }]);
    expect(report.unresolved).toHaveLength(1);
    expect(f.d.task(t.id).effects[pr.id]?.status).toBe('started');
    expect(f.d.pending(t.id, 'reconcile')).toEqual([]);

    // A mark that cannot be read dates nothing: unknown as well.
    f.host.tagged = [];
    mkdirSync(join(f.dir, 'process-marks'), { recursive: true });
    writeFileSync(join(f.dir, 'process-marks', `${OP}.json`), '{');
    report = await restart(f);
    expect(report.operations).toMatchObject([{ finding: { status: 'unknown' }, effect: 'kept' }]);

    // Once a stop takes it down, the operation is lost and its effect goes to reconcile.
    writeOperationMark(f.dir, OP);
    f.host.tagged = [survivor];
    f.host.unkillable = false;
    report = await restart(f);
    expect(report.operations).toMatchObject([
      {
        finding: {
          status: 'lost',
          reason: expect.stringContaining('1 surviving processes stopped') as unknown,
        },
        effect: 'unknown',
      },
    ]);
    expect(f.d.pending(t.id, 'reconcile')).toHaveLength(1);
    // Proven lost: the mark has nothing left to date.
    expect(readOperationMark(f.dir, OP)).toEqual({ ok: true, mark: null });
    expect(f.d.store.verifyProjections().ok).toBe(true);
  });

  it('a receipt committed without its effect result leaves no open operation; the started effect is settled unknown and goes to reconcile (T093)', async () => {
    const f = fixture();
    const t = buildTask({ id: uuidOf(1) });
    createGrantStart(f.d, t);
    toPublish(f.d, t, HEAD);
    f.d.complete(t.id, f.d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(HEAD));
    const pr = f.d.pendingOne(t.id, 'create_pr');
    f.d.store.claimEffect(pr.id as Uuid, f.d.now as EpochMs, {
      require_runtime: true,
      operation: {
        operation_id: OP,
        kind: 'github',
        launch_nonce: 'n',
        unit: `cusr-op-${OP}.service`,
        holds_slot: false,
      },
    });
    // The daemon committed the operation's receipt and died before the effect's result.
    f.d.must(t.id, {
      kind: 'operation_result',
      operation_id: OP,
      status: 'finished',
      outcome: 'succeeded',
      invocation_id: null,
      processes: [],
      started_at: f.d.now as EpochMs,
      finished_at: f.d.now as EpochMs,
      receipt_digest: `sha256:${'c'.repeat(64)}`,
    });
    expect(f.d.task(t.id).effects[pr.id]?.status).toBe('started');

    const report = await restart(f);
    expect(report.operations).toEqual([]);
    expect(report.orphaned).toEqual([{ task_id: t.id, effect_id: pr.id, effect: 'unknown' }]);
    expect(f.d.task(t.id).effects[pr.id]?.status).toBe('unknown');
    expect(f.d.pending(t.id, 'reconcile')).toHaveLength(1);
    expect(f.d.pending(t.id, 'create_pr')).toEqual([]);
    const events = eventCount(f);
    expect((await restart(f)).orphaned).toEqual([]);
    expect(eventCount(f)).toBe(events);
  });

  it('an effect run again after a reconcile and orphaned a second time is settled again, not by the first answer (FR-034.01)', async () => {
    const f = fixture();
    const t = buildTask({ id: uuidOf(1) });
    createGrantStart(f.d, t);
    toPublish(f.d, t, HEAD);
    f.d.complete(t.id, f.d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(HEAD));
    const pr = f.d.pendingOne(t.id, 'create_pr');
    const orphan = async (op: Uuid): Promise<void> => {
      const claimed = f.d.store.claimEffect(pr.id as Uuid, f.d.now as EpochMs, {
        require_runtime: true,
        operation: {
          operation_id: op,
          kind: 'github',
          launch_nonce: `n-${op}`,
          unit: `cusr-op-${op}.service`,
          holds_slot: false,
        },
      });
      if (!claimed.ok) throw new Error(JSON.stringify(claimed.error));
      // The receipt is committed, the daemon dies before the effect's result.
      f.d.must(t.id, {
        kind: 'operation_result',
        operation_id: op,
        status: 'finished',
        outcome: 'succeeded',
        invocation_id: null,
        processes: [],
        started_at: f.d.now as EpochMs,
        finished_at: f.d.now as EpochMs,
        receipt_digest: `sha256:${'c'.repeat(64)}`,
      });
      const report = await restart(f);
      expect(report.orphaned).toEqual([{ task_id: t.id, effect_id: pr.id, effect: 'unknown' }]);
      expect(f.d.task(t.id).effects[pr.id]?.status).toBe('unknown');
    };
    await orphan(OP);
    // Its reconcile finds nothing sent: the same effect goes back to the queue and runs again.
    f.d.must(t.id, {
      kind: 'effect_reconciled',
      effect_id: pr.id as Uuid,
      finding: 'not_executed',
    });
    expect(f.d.task(t.id).effects[pr.id]?.status).toBe('pending');
    // The wall clock steps back between the two runs: the later run is still the one settled.
    f.d.now -= 60_000;
    await orphan(uuidOf(902));
    expect(f.d.store.verifyProjections().ok).toBe(true);
  });

  it('an agent operation recorded never launched before its effect was settled: the effect is not executed and the engine decides the next attempt (T093)', async () => {
    const f = fixture();
    const { task, effectId } = toAgent(f);
    f.d.must(task.id, {
      kind: 'operation_result',
      operation_id: OP,
      status: 'not_launched',
      outcome: null,
      invocation_id: null,
      processes: [],
      started_at: null as never,
      finished_at: null as never,
      receipt_digest: `sha256:${'c'.repeat(64)}`,
    });
    expect(f.d.task(task.id).effects[effectId]?.status).toBe('started');
    const report = await restart(f);
    expect(report.orphaned).toEqual([
      { task_id: task.id, effect_id: effectId, effect: 'not_executed' },
    ]);
    const s = f.d.task(task.id);
    expect(s.budget.reservations[s.effects[effectId]?.reservation_id ?? '']?.status).not.toBe(
      'held',
    );
    expect(f.d.pending(task.id, 'start_agent')).toHaveLength(1);
    expect(f.d.store.verifyProjections().ok).toBe(true);
  });

  it('a runner holding the real kernel lock before its marker is adopted; once it is gone it is lost, not relaunched', async () => {
    if (!existsSync(FLOCK)) return;
    const f = fixture();
    const { task } = toAgent(f);
    const lock = lockFilePath(f.dir, OP, true);
    // flock hands the lock to its child: the whole group is killed below, as systemd stops a unit.
    const holder = spawn(FLOCK, ['--exclusive', lock, 'sleep', '30'], {
      stdio: 'ignore',
      detached: true,
    });
    try {
      // Wait until the child really holds the lock.
      for (let i = 0; i < 100; i++) {
        const probe = spawnSync(FLOCK, ['--exclusive', '--nonblock', lock, 'true']);
        if (probe.status !== 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const report = await restart(f, true);
      expect(report.operations).toMatchObject([{ finding: { status: 'running' } }]);
    } finally {
      const exit = new Promise((r) => holder.once('exit', r));
      process.kill(-(holder.pid ?? 0), 'SIGKILL');
      await exit;
    }
    const { probeLock: _scripted, ...real } = reconcileDeps(f);
    const after = await reconcileOperations(real);
    expect(after.operations).toMatchObject([
      { from: 'running', finding: { status: 'lost' }, effect: 'unknown' },
    ]);
    expect(f.d.task(task.id).operations[OP]?.status).toBe('lost');
    expect(f.d.pending(task.id, 'start_agent')).toEqual([]);
  });
});

describe('merge recorded before the drain finished (FR-034.02/03)', () => {
  const proof: MergeProof = {
    subject: {
      provider: 'github',
      immutable_repo_id: 'R1',
      subject_id: '700',
      target_ref: 'main',
      head_ref: 'cusr/t',
    },
    merged_at: 1,
    merged_head_sha: HEAD,
    checked_head_sha: null,
    merge_commit_sha: 'c'.repeat(40),
    observation_id: 'obs-1',
    evidence_ref: 'ev-1',
  };

  it('after a restart the drain keeps its claim: a late red CI starts no fixer, unknown work never ends DONE', async () => {
    const f = fixture();
    const t = buildTask({ id: uuidOf(1) });
    const child = buildTask({
      id: uuidOf(2),
      source_key: 'cli:2',
      depends_on: [t.id],
    });
    createGrantStart(f.d, t);
    toPublish(f.d, t, HEAD);
    f.d.complete(t.id, f.d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(HEAD));
    f.d.complete(t.id, f.d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
      pr_ref: 'acme#7',
      head_sha: HEAD,
    });
    reviewToCi(f.d, t.id);
    f.d.must(child.id, { kind: 'create_task', task: child });
    const ci = f.d.pendingOne(t.id, 'await_ci');
    f.d.store.claimEffect(ci.id as Uuid, f.d.now as EpochMs, {
      require_runtime: true,
      operation: {
        operation_id: OP,
        kind: 'github',
        launch_nonce: 'n',
        unit: `cusr-op-${OP}.service`,
        holds_slot: false,
      },
    });
    f.d.must(t.id, {
      kind: 'observation_result',
      observation: {
        observation_id: 'obs-1',
        source: 'timer',
        requested_at: f.d.now,
        observed_at: f.d.now,
        generation: 1,
        subject: proof.subject,
        status: 'merged',
        observed_head: HEAD,
        raw_evidence_ref: 'ev-1',
        completeness: { merge_proof: true, quality: false },
      },
      remote_digest: `sha256:${'d'.repeat(64)}`,
    });
    f.d.must(t.id, {
      kind: 'external_completion',
      proof,
      unverified_reason: null,
    });
    expect(f.d.task(t.id).wait?.detail['code']).toBe('merge_cleanup_pending');

    // The daemon dies with the CI read in flight.
    await restart(f);
    const s = f.d.task(t.id);
    expect(s.status).toBe('WAITING');
    expect(s.completion?.finalized_at).toBeNull();
    expect(s.operations[OP]?.status).toBe('lost');
    expect(s.effects[ci.id]?.status).toBe('unknown');
    expect(types(f, t.id)).not.toContain('TaskCompleted');

    // The CI result arrives late and red: recorded as evidence, no fixer, no push.
    f.d.must(t.id, {
      kind: 'effect_reconciled',
      effect_id: ci.id as Uuid,
      finding: 'executed_succeeded',
      data: ciData(HEAD, { build: 'failure', test: 'success' }),
    });
    expect(f.d.pending(t.id, 'start_agent')).toEqual([]);
    expect(f.d.pending(t.id, 'publish')).toEqual([]);

    // The operation's end is still unproven: rounds pause, the task never ends DONE, the child waits.
    const port = {
      launch: () => Promise.reject(new Error('no launches in a drain')),
      inspect: probes(f).inspect,
      stop: () => Promise.resolve('not_running' as const),
    };
    for (let i = 0; i < 4; i++)
      await drainRound(
        {
          store: f.d.store,
          process: port,
          clock: { now: () => f.d.now as EpochMs, monotonic: () => 0 },
        },
        t.id,
      );
    const after = f.d.task(t.id);
    expect(after.status).toBe('WAITING');
    expect(after.completion?.drain).toMatchObject({ paused: true, count: 3 });
    expect(after.operations[OP]?.status).toBe('lost');
    expect(types(f, t.id)).not.toContain('TaskCompleted');
    notifyDependents(f.d.store, f.d.now);
    expect(f.d.task(child.id).status).not.toBe('READY');
    expect(f.d.store.verifyProjections().ok).toBe(true);
  });
});

describe('late results through reconcile after a restart (T091, FR-034.03, FR-040.05, H05)', () => {
  const HEAD = 'a'.repeat(40);
  /** A task whose publish of HEAD ended unknown: the shape a lost publish has after recovery. */
  function publishUnknown() {
    const d = new StoreDriver(openFileStoreForTest(join(tempDir(), STORE_FILE)));
    const t = buildTask();
    createGrantStart(d, t);
    toPublish(d, t, HEAD);
    const pub = d.pendingOne(t.id, 'publish');
    d.complete(t.id, pub.id, 'unknown');
    expect(d.pending(t.id, 'reconcile')).toHaveLength(1);
    return { d, t, pub };
  }
  const drift = (d: StoreDriver, t: CanonicalTask) =>
    d.must(t.id, {
      kind: 'head_drift',
      expected: null,
      observed: 'b'.repeat(40),
      source: 'publish_probe',
      evidence_ref: 'probe:B',
    });

  it('a push found landed under a recorded drift is history: no PR, the blocker stays', () => {
    const { d, t, pub } = publishUnknown();
    drift(d, t);
    d.must(t.id, {
      kind: 'effect_reconciled',
      effect_id: pub.id as Uuid,
      finding: 'executed_succeeded',
      data: publishData(HEAD),
      requests: { git: 2, github: 0 },
    });
    const s = d.task(t.id);
    expect(s.effects[pub.id]?.status).toBe('succeeded');
    expect(s.head_sha).toBeNull();
    expect(s.blockers.map((b) => b.code)).toContain('head_changed');
    expect(d.pending(t.id, 'create_pr')).toEqual([]);
    expect(d.store.verifyProjections().ok).toBe(true);
  });

  it('a reconcile that was itself interrupted is run again under its key, under a drift too; its target stays unknown until then (T093)', () => {
    const { d, t, pub } = publishUnknown();
    drift(d, t);
    const probe = d.pendingOne(t.id, 'reconcile');
    // The daemon died while the probe ran: the probe is unknown and gets a reconcile of its own.
    d.complete(t.id, probe.id, 'unknown');
    const again = d.pendingOne(t.id, 'reconcile');
    expect(d.task(t.id).effects[again.id]?.target_effect_id).toBe(probe.id);
    d.must(t.id, {
      kind: 'effect_reconciled',
      effect_id: probe.id as Uuid,
      finding: 'not_executed',
    });
    const s = d.task(t.id);
    expect(s.effects[probe.id]?.status).toBe('pending');
    expect(s.effects[again.id]?.status).toBe('succeeded');
    expect(s.effects[pub.id]?.status).toBe('unknown');
    expect(d.pending(t.id, 'reconcile').map((e) => e.id)).toEqual([probe.id]);
    expect(d.store.verifyProjections().ok).toBe(true);
  });

  it('an effect back in the queue and lost again gets a reconcile of its own; one still open is never doubled (T093)', () => {
    const { d, t, pub } = publishUnknown();
    const first = d.pendingOne(t.id, 'reconcile');
    d.must(t.id, {
      kind: 'effect_reconciled',
      effect_id: pub.id as Uuid,
      finding: 'not_executed',
    });
    expect(d.task(t.id).effects[pub.id]?.status).toBe('pending');
    d.complete(t.id, pub.id, 'unknown');
    const second = d.pendingOne(t.id, 'reconcile');
    expect(second.id).not.toBe(first.id);
    expect(d.task(t.id).effects[second.id]?.target_effect_id).toBe(pub.id);
    expect(d.store.verifyProjections().ok).toBe(true);
  });

  it('a push found not applied under a drift does not go back to the queue', () => {
    const { d, t, pub } = publishUnknown();
    drift(d, t);
    d.must(t.id, {
      kind: 'effect_reconciled',
      effect_id: pub.id as Uuid,
      finding: 'not_executed',
    });
    expect(d.task(t.id).effects[pub.id]?.status).toBe('failed');
    expect(d.pending(t.id, 'publish')).toEqual([]);
  });

  it('the reconcile records the requests it took on its own effect, apart from the one logical effect', () => {
    const { d, t, pub } = publishUnknown();
    const [probe] = d.pending(t.id, 'reconcile');
    d.must(t.id, {
      kind: 'effect_reconciled',
      effect_id: pub.id as Uuid,
      finding: 'executed_succeeded',
      data: publishData(HEAD),
      requests: { git: 3, github: 0 },
    });
    const done = d.store
      .readEvents(t.id)
      .filter(
        (e) =>
          e.type === 'EffectCompleted' &&
          (e.payload as { effect_id: string }).effect_id === probe?.id,
      );
    expect(done.map((e) => e.payload)).toEqual([
      {
        effect_id: probe?.id,
        status: 'succeeded',
        result: {
          finding: 'executed_succeeded',
          requests: { git: 3, github: 0 },
        },
      },
    ]);
    expect(Object.values(d.task(t.id).effects).filter((e) => e.kind === 'publish')).toHaveLength(1);
    expect(d.pending(t.id, 'create_pr')).toHaveLength(1);
  });
});
