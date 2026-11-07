/**
 * Runner adoption across a daemon death (T081, FR-007, FR-034.01, FR-035) under the real systemd user
 * manager, the real `cusr-runner exec`, the kernel operation lock and /proc. A daemon stand-in
 * (`test/support/runner-adoption-child.ts`) claims and launches one agent operation, then dies by
 * SIGKILL in the foreground or by stop/restart of its own unit: before the unit starts, after the unit
 * starts but before the launch marker, and after the marker and the pid receipt. Recovery adopts what
 * still runs and never spawns it again; the operation lock refuses a second runner; stopping or killing
 * the runner ends every descendant; a pid that is reused or from another boot is never the harness and
 * is never signalled.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, describe, expect, it } from 'vitest';
import { STORE_FILE } from '../../../src/daemon/main.ts';
import { reconcileOperations, type ReconcileDeps } from '../../../src/daemon/reconcile.ts';
import { recoverStore } from '../../../src/daemon/startup.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { RUN_FILES, RunDir } from '../../../src/runner/files.ts';
import {
  HOST_PROBE,
  PidRecordSchema,
  unitName,
  type PidRecord,
} from '../../../src/runner/identity.ts';
import { RunnerExitSchema } from '../../../src/runner/lifecycle.ts';
import {
  FLOCK,
  LOCK_CONFLICT_EXIT,
  LaunchMarkerSchema,
  flockArgv,
  lockFilePath,
} from '../../../src/runner/operation-lock.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import { SystemdSupervisor, inspectUnit } from '../../../src/runner/supervisor.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import type { AdoptionChildArgs } from '../../support/runner-adoption-child.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { useTempDir } from '../../support/temp-db.ts';

const manager = spawnSync('systemctl', ['--user', 'is-system-running'], {
  encoding: 'utf8',
});
const available =
  manager.error === undefined &&
  ['running', 'degraded'].includes(manager.stdout.trim()) &&
  existsSync(FLOCK);

const path = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const CHILD = path('../../support/runner-adoption-child.ts');
const RUNNER = path('../../../src/cli/cusr-runner.ts');
const FAKE = path('../../fixtures/runtime/spike-0/bin/fake-harness.js');
const STOP = { term_grace_ms: 2_000, kill_verify_ms: 2_000 };

const tempDir = useTempDir('cusr-adoption-');
const units: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  for (const u of units.splice(0)) {
    spawnSync('systemctl', ['--user', 'stop', u]);
    spawnSync('systemctl', ['--user', 'reset-failed', u]);
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms = 20_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

type Fixture = {
  readonly dir: string;
  readonly task: CanonicalTask;
  readonly effectId: string;
  readonly op: string;
  readonly now: number;
  readonly gate: string;
  readonly spawns: string;
  readonly pids: string;
  readonly log: string;
};

/** prepare done and the code attempt pending, on a real SQLite file the child opens next. */
function fixture(): Fixture {
  const dir = realpathSync(tempDir());
  const d = new StoreDriver(openFileStoreForTest(join(dir, STORE_FILE)));
  const task = buildTask({ id: uuidOf(1) });
  createGrantStart(d, task);
  d.complete(task.id, d.pendingOne(task.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  const effectId = d.pendingOne(task.id, 'start_agent').id;
  const now = d.now;
  d.store.close();
  const op = uuidv7();
  units.push(unitName(op));
  return {
    dir,
    task,
    effectId,
    op,
    now,
    gate: join(dir, 'runner-gate'),
    spawns: join(dir, 'spawns'),
    pids: join(dir, 'pids.json'),
    log: join(dir, 'daemon.log'),
  };
}

function childArgs(f: Fixture, stopAfterClaim = false): string {
  const args: AdoptionChildArgs = {
    data_dir: f.dir,
    task_id: f.task.id,
    effect_id: f.effectId,
    operation_id: f.op,
    now: f.now,
    // The runner waits at the gate while flock already holds the operation lock: a unit that started
    // but has no launch marker yet.
    runner: [
      '/bin/sh',
      '-c',
      'while [ ! -e "$0" ]; do sleep 0.05; done; exec "$@"',
      f.gate,
      process.execPath,
      RUNNER,
    ],
    // Every harness spawn is counted; the harness leaves one child in its group and one that escaped.
    argv: [
      '/bin/sh',
      '-c',
      'echo $$ >> "$0"; exec "$1" "$2" grandchild "$3"',
      f.spawns,
      process.execPath,
      FAKE,
      f.pids,
    ],
    log: f.log,
    stop_after_claim: stopAfterClaim,
  };
  const file = join(f.dir, 'child-args.json');
  writeFileSync(file, JSON.stringify(args));
  return file;
}

type LogEntry = { pid: number; step: string; [k: string]: unknown };

function logOf(f: Fixture): LogEntry[] {
  if (!existsSync(f.log)) return [];
  return readFileSync(f.log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as LogEntry);
}

const logged = (f: Fixture, step: string, n = 1) =>
  until(() => logOf(f).filter((e) => e.step === step).length >= n);

/** The daemon in the foreground; resolves once it logged `step`. */
async function foreground(f: Fixture, step: string, stopAfterClaim = false) {
  const child = spawn(process.execPath, [CHILD, childArgs(f, stopAfterClaim)], {
    stdio: 'ignore',
  });
  children.push(child);
  expect(await logged(f, step), JSON.stringify(logOf(f))).toBe(true);
  return child;
}

async function sigkill(child: ChildProcess): Promise<void> {
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await exited;
}

function spawnCount(f: Fixture): number {
  return existsSync(f.spawns) ? readFileSync(f.spawns, 'utf8').trim().split('\n').length : 0;
}

function harnessPids(f: Fixture): number[] {
  const p = JSON.parse(readFileSync(f.pids, 'utf8')) as {
    in_group: number;
    escaped: number;
  };
  return [p.in_group, p.escaped];
}

function attemptOf(f: Fixture): string {
  const claimed = logOf(f).find((e) => e.step === 'claimed');
  if (typeof claimed?.attempt !== 'string') throw new Error('no attempt');
  return claimed.attempt;
}

function runDir(f: Fixture, attempt: string): RunDir {
  return RunDir.open({
    dataDir: f.dir,
    kind: 'runs',
    id: attempt,
    redactor: new Redactor(),
  });
}

function pidRecord(f: Fixture, attempt: string): PidRecord {
  const r = runDir(f, attempt).readFinal(RUN_FILES.pid, PidRecordSchema);
  if (r.state !== 'valid') throw new Error(`pid.json ${r.state}`);
  return r.value;
}

/** Startup recovery with every host probe real: systemd, the kernel lock and /proc. */
async function restart(f: Fixture) {
  const r = await recoverStore({
    path: join(f.dir, STORE_FILE),
    dataDir: f.dir,
    redactor: new Redactor(),
    inspect: (id) => inspectUnit(id),
    now: () => f.now,
    newId: uuidv7,
  });
  if (!r.ok) throw new Error(`recover: ${JSON.stringify(r.error)}`);
  return { d: new StoreDriver(r.value.store, 7), report: r.value.report };
}

const deps = (f: Fixture, d: StoreDriver): ReconcileDeps => ({
  store: d.store,
  dataDir: f.dir,
  redactor: new Redactor(),
  inspect: (id) => inspectUnit(id),
  now: () => f.now,
  newId: uuidv7,
});

const supervisor = (f: Fixture) =>
  new SystemdSupervisor({
    dataDir: f.dir,
    runnerCommand: [process.execPath, RUNNER],
  });

describe.skipIf(!available)(
  'runner adoption after the daemon dies (T081, FR-034.01, FR-035)',
  () => {
    it('killed after the claim, before any unit: never launched, the reservation returns, nothing ran', async () => {
      const f = fixture();
      await sigkill(await foreground(f, 'claimed', true));
      expect((await inspectUnit(f.op)).state).toBe('not_found');

      const { d, report } = await restart(f);
      try {
        expect(report.operations).toMatchObject([
          {
            operation_id: f.op,
            finding: { status: 'not_launched' },
            effect: 'not_executed',
          },
        ]);
        const s = d.task(f.task.id);
        expect(s.operations[f.op]?.status).toBe('not_launched');
        const effect = s.effects[f.effectId];
        expect(s.budget.reservations[effect?.reservation_id ?? '']?.status).not.toBe('held');
        // The engine decides the next attempt; the old one never ran.
        expect(d.pending(f.task.id, 'start_agent')).toHaveLength(1);
        expect(spawnCount(f)).toBe(0);
        expect(d.store.verifyProjections().ok).toBe(true);
      } finally {
        d.store.close();
      }
    }, 60_000);

    it('killed after the unit started, before the launch marker: adopted, the lock refuses a second runner, then one spawn and a stop that ends every descendant', async () => {
      const f = fixture();
      await sigkill(await foreground(f, 'launched'));
      const unit = await inspectUnit(f.op);
      expect(unit.state).toBe('active');
      const attempt = attemptOf(f);
      expect(existsSync(join(runDir(f, attempt).dir, RUN_FILES.launch))).toBe(false);

      const { d, report } = await restart(f);
      try {
        expect(report.operations).toMatchObject([
          {
            finding: {
              status: 'running',
              reason: 'runner unit active before its launch marker',
            },
            effect: 'kept',
          },
        ]);
        expect(report.held).toBeNull();
        expect(d.pending(f.task.id, 'start_agent')).toEqual([]);
        expect(d.store.readSlots()[0]?.holder_task_id).toBe(f.task.id);

        // Nothing launches the operation again: the loaded unit and the held lock both refuse.
        expect(
          await supervisor(f).launch({
            operation_id: f.op,
            kind: 'agent',
            run_dir_kind: 'runs',
            run_id: attempt,
            argv: ['/bin/true'],
            cwd: f.dir,
            env: { PATH: '/usr/bin:/bin' },
            wall_ms: 60_000,
            deadline_at: (Date.now() + 60_000) as EpochMs,
            ...STOP,
            launch_nonce: 'second',
          }),
        ).toMatchObject({ ok: false, error: { code: 'marker_exists' } });
        const [file, ...rest] = flockArgv(lockFilePath(f.dir, f.op), [
          process.execPath,
          RUNNER,
          'exec',
          '--data-dir',
          runDir(f, attempt).root,
          '--kind',
          'runs',
          '--id',
          attempt,
        ]);
        expect(spawnSync(file as string, rest).status).toBe(LOCK_CONFLICT_EXIT);

        writeFileSync(f.gate, '');
        expect(await until(() => existsSync(f.pids))).toBe(true);
        const pid = pidRecord(f, attempt);
        const later = await reconcileOperations(deps(f, d));
        expect(later.operations).toMatchObject([
          {
            from: 'running',
            finding: {
              status: 'running',
              processes: [{ pid: pid.pid, start_ticks: pid.start_ticks }],
            },
          },
        ]);
        expect(d.task(f.task.id).operations[f.op]).toMatchObject({
          status: 'running',
          invocation_id: unit.invocation_id,
        });

        const tree = [pid.pid, ...harnessPids(f)];
        expect(tree.every(alive)).toBe(true);
        expect(await supervisor(f).stop(f.op, STOP)).toBe('stopped');
        expect(await until(() => !tree.some(alive))).toBe(true);
        const exit = runDir(f, attempt).readFinal(RUN_FILES.exit, RunnerExitSchema);
        expect(exit).toMatchObject({
          state: 'valid',
          value: { outcome: 'cancelled', spawned: true },
        });

        const done = await reconcileOperations(deps(f, d));
        expect(done.operations).toMatchObject([
          {
            finding: { status: 'finished', outcome: 'cancelled' },
            effect: 'unknown',
          },
        ]);
        const s = d.task(f.task.id);
        expect(s.effects[f.effectId]?.status).toBe('unknown');
        expect(d.pending(f.task.id, 'start_agent')).toEqual([]);
        expect(spawnCount(f)).toBe(1);
        expect(d.store.verifyProjections().ok).toBe(true);
      } finally {
        d.store.close();
      }
    }, 90_000);

    it('killed after the marker and pid receipt: adopted with its identity; killing the runner ends the tree and the claim stays as lost', async () => {
      const f = fixture();
      writeFileSync(f.gate, '');
      const child = await foreground(f, 'launched');
      expect(await until(() => existsSync(f.pids))).toBe(true);
      await sigkill(child);
      const attempt = attemptOf(f);
      const pid = pidRecord(f, attempt);

      const { d, report } = await restart(f);
      try {
        expect(report.operations).toMatchObject([
          {
            finding: {
              status: 'running',
              reason: 'pid and start ticks match',
              processes: [
                {
                  boot_id: HOST_PROBE.bootId(),
                  pid: pid.pid,
                  start_ticks: pid.start_ticks,
                },
              ],
            },
          },
        ]);
        expect(d.pending(f.task.id, 'start_agent')).toEqual([]);

        const marker = runDir(f, attempt).readFinal(RUN_FILES.launch, LaunchMarkerSchema);
        if (marker.state !== 'valid') throw new Error('no launch marker');
        const tree = [marker.value.runner_pid, pid.pid, ...harnessPids(f)];
        expect(tree.every(alive)).toBe(true);
        // The runner dies without its exit record: the unit ends and takes the whole cgroup with it.
        process.kill(marker.value.runner_pid, 'SIGKILL');
        expect(await until(() => !tree.some(alive))).toBe(true);
        expect(existsSync(join(runDir(f, attempt).dir, RUN_FILES.exit))).toBe(false);

        let lost = await reconcileOperations(deps(f, d));
        // The unit may still be deactivating for a moment; the next pass sees it gone.
        for (let i = 0; i < 50 && lost.operations[0]?.finding.status !== 'lost'; i++) {
          await new Promise((r) => setTimeout(r, 100));
          lost = await reconcileOperations(deps(f, d));
        }
        expect(lost.operations).toMatchObject([
          {
            from: 'running',
            finding: {
              status: 'lost',
              reason: 'process identity no longer present',
            },
            effect: 'unknown',
            attempt: { id: attempt, step: 'code' },
          },
        ]);
        const s = d.task(f.task.id);
        const effect = s.effects[f.effectId];
        expect(effect?.status).toBe('unknown');
        expect(s.budget.reservations[effect?.reservation_id ?? '']?.status).toBe('held');
        expect(d.store.readSlots()[0]?.holder_task_id).toBe(f.task.id);
        expect(d.pending(f.task.id, 'start_agent')).toEqual([]);
        expect(spawnCount(f)).toBe(1);
      } finally {
        d.store.close();
      }
    }, 90_000);

    it('a daemon unit restarted or stopped leaves the operation unit running; the restarted daemon adopts it and never launches again', async () => {
      const f = fixture();
      writeFileSync(f.gate, '');
      const daemon = `cusr-t081-daemon-${f.op}.service`;
      units.unshift(daemon);
      const env = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'HOME']
        .filter((k) => process.env[k] !== undefined)
        .map((k) => `--setenv=${k}=${process.env[k] ?? ''}`);
      const started = spawnSync(
        'systemd-run',
        [
          '--user',
          `--unit=${daemon}`,
          '--property=Restart=no',
          '--property=KillMode=control-group',
          ...env,
          '--quiet',
          process.execPath,
          CHILD,
          childArgs(f),
        ],
        { encoding: 'utf8', timeout: 30_000 },
      );
      expect(started.status, started.stderr).toBe(0);
      expect(await logged(f, 'launched'), JSON.stringify(logOf(f))).toBe(true);
      expect(await until(() => existsSync(f.pids))).toBe(true);
      const attempt = attemptOf(f);
      const pid = pidRecord(f, attempt);
      const invocation = (await inspectUnit(f.op)).invocation_id;
      expect(invocation).toMatch(/^[0-9a-f]{32}$/);
      const tree = [pid.pid, ...harnessPids(f)];

      const restarted = spawnSync('systemctl', ['--user', 'restart', daemon], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(restarted.status, restarted.stderr).toBe(0);
      expect(await logged(f, 'adopted'), JSON.stringify(logOf(f))).toBe(true);
      const second = logOf(f).filter((e) => e.step === 'recovered')[1];
      expect(second?.operations).toEqual([
        { id: f.op, status: 'running', reason: 'pid and start ticks match' },
      ]);
      expect(logOf(f).find((e) => e.step === 'adopted')).toMatchObject({
        effect: 'started',
        operation: 'running',
      });
      expect(await inspectUnit(f.op)).toMatchObject({
        state: 'active',
        invocation_id: invocation,
      });
      expect(tree.every(alive)).toBe(true);

      const stopped = spawnSync('systemctl', ['--user', 'stop', daemon], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(stopped.status, stopped.stderr).toBe(0);
      expect(await inspectUnit(f.op)).toMatchObject({
        state: 'active',
        invocation_id: invocation,
      });
      expect(tree.every(alive)).toBe(true);
      expect(logOf(f).filter((e) => e.step === 'launched')).toHaveLength(1);
      expect(spawnCount(f)).toBe(1);

      const { d, report } = await restart(f);
      try {
        expect(report.operations).toMatchObject([
          { finding: { status: 'running' }, effect: 'kept' },
        ]);
        expect(d.task(f.task.id).operations[f.op]?.status).toBe('running');
        expect(d.pending(f.task.id, 'start_agent')).toEqual([]);
      } finally {
        d.store.close();
      }
      expect(await supervisor(f).stop(f.op, STOP)).toBe('stopped');
      expect(await until(() => !tree.some(alive))).toBe(true);
    }, 120_000);
  },
);

describe.skipIf(!available)(
  'a recorded pid that is not the harness is never signalled (T081, FR-035)',
  () => {
    describe.each([
      ['reused by another process', 1, null],
      ['recorded on another boot', 0, 'other-boot'],
    ] as const)('pid %s', (_name, tickShift, boot) => {
      it('the operation is lost, the stranger keeps running and a stop finds no unit', async () => {
        const f = fixture();
        const stranger = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
        children.push(stranger);
        const strangerPid = stranger.pid ?? 0;
        const ticks = HOST_PROBE.startTicks(strangerPid);
        if (typeof ticks !== 'number') throw new Error('no start ticks');

        const s0 = new StoreDriver(openFileStoreForTest(join(f.dir, STORE_FILE)), 3);
        s0.now = f.now;
        const claimed = s0.store.claimEffect(f.effectId as Uuid, f.now as EpochMs, {
          require_runtime: true,
          operation: {
            operation_id: f.op,
            kind: 'agent',
            launch_nonce: 'dispatch-1',
            unit: unitName(f.op),
            holds_slot: true,
          },
        });
        if (!claimed.ok) throw new Error(JSON.stringify(claimed.error));
        const attempt = s0.task(f.task.id).effects[f.effectId]?.attempt_id;
        if (attempt == null) throw new Error('no attempt');
        s0.store.close();
        const run = runDir(f, attempt);
        run.createLaunchMarker({
          schema_version: 1,
          operation_id: f.op,
          attempt_id: attempt,
          launch_nonce: 'launch-1',
          boot_id: HOST_PROBE.bootId(),
          runner_pid: strangerPid,
          at: new Date(f.now).toISOString(),
        });
        const rec: PidRecord = {
          schema_version: 1,
          operation_id: f.op,
          launch_nonce: 'launch-1',
          boot_id: boot ?? HOST_PROBE.bootId(),
          pid: strangerPid,
          pgid: strangerPid,
          start_ticks: ticks + tickShift,
          runner_pid: strangerPid,
          runner_start_ticks: ticks,
          invocation_id: null,
          cgroup: null,
        };
        run.writeJson(RUN_FILES.pid, rec);

        const { d, report } = await restart(f);
        try {
          expect(report.operations).toMatchObject([
            {
              finding: {
                status: 'lost',
                reason:
                  boot === null ? 'process identity no longer present' : 'recorded on another boot',
              },
              effect: 'unknown',
            },
          ]);
          expect(d.task(f.task.id).operations[f.op]?.status).toBe('lost');
          expect(d.pending(f.task.id, 'start_agent')).toEqual([]);
        } finally {
          d.store.close();
        }
        expect(await supervisor(f).stop(f.op, STOP)).toBe('not_running');
        expect(alive(strangerPid)).toBe(true);
        expect(HOST_PROBE.startTicks(strangerPid)).toBe(ticks);
      }, 60_000);
    });
  },
);
