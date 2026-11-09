import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OperationLaunch } from '../../../src/adapters/ports.ts';
import { asEpochMs } from '../../../src/shared/brand.ts';
import { RUN_FILES, RunDir, SECRET_ENV_FILE } from '../../../src/runner/files.ts';
import { execOperation } from '../../../src/runner/lifecycle.ts';
import {
  PidRecordSchema,
  captureIdentity,
  checkIdentity,
  startTicks,
  unitName,
} from '../../../src/runner/identity.ts';
import {
  FLOCK,
  LOCK_CONFLICT_EXIT,
  claimLaunch,
  fenceLaunch,
  flockArgv,
  lockFilePath,
  probeOperationLock,
  type LaunchMarker,
} from '../../../src/runner/operation-lock.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import {
  SYSTEMCTL,
  SYSTEMD_RUN,
  SystemdSupervisor,
  observeLaunch,
  parseUnitShow,
  systemdRunArgv,
  type CommandExec,
  type CommandResult,
} from '../../../src/runner/supervisor.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dataDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-supervisor-')));
  dirs.push(d);
  return d;
}

function launchSpec(over: Partial<OperationLaunch> = {}): OperationLaunch {
  return {
    operation_id: 'op-1',
    kind: 'agent',
    run_dir_kind: 'runs',
    run_id: 'at-1',
    argv: ['/usr/bin/true'],
    cwd: '/tmp',
    env: { PATH: '/usr/bin:/bin' },
    wall_ms: 600_000,
    deadline_at: asEpochMs(1_000_000),
    term_grace_ms: 10_000,
    kill_verify_ms: 5_000,
    launch_nonce: 'nonce-1',
    ...over,
  };
}

const result = (over: Partial<CommandResult> = {}): CommandResult => ({
  code: 0,
  stdout: '',
  stderr: '',
  timed_out: false,
  error: null,
  ...over,
});
const show = (load: string, active: string, invocation = ''): CommandResult =>
  result({
    stdout: `LoadState=${load}\nActiveState=${active}\nSubState=x\nResult=success\nInvocationID=${invocation}\nControlGroup=\n`,
  });

/** Answers systemctl show from a queue of states and records every call. */
function scripted(
  shows: CommandResult[],
  run: CommandResult = result(),
): CommandExec & { calls: string[][] } {
  const calls: string[][] = [];
  const exec = (file: string, args: readonly string[]): Promise<CommandResult> => {
    calls.push([file, ...args]);
    if (file === SYSTEMD_RUN) return Promise.resolve(run);
    if (args[1] === 'show') return Promise.resolve(shows.shift() ?? show('loaded', 'active'));
    return Promise.resolve(result());
  };
  return Object.assign(exec, { calls });
}

const marker = (nonce = 'nonce-1'): LaunchMarker => ({
  schema_version: 1,
  operation_id: 'op-1',
  attempt_id: 'at-1',
  launch_nonce: nonce,
  boot_id: 'boot-a',
  runner_pid: 1,
  at: '2026-10-28T00:00:00.000Z',
});

describe('systemd unit argv (T018, ADR-0002)', () => {
  it('omits the systemd runtime cap for an unlimited worker', () => {
    const argv = systemdRunArgv({ ...launchSpec(), wall_ms: null, deadline_at: null }, '/d/lock', [
      '/runner',
    ]);
    expect(argv.some((a) => a.includes('RuntimeMaxSec'))).toBe(false);
    expect(argv).toContain('--property=KillMode=control-group');
  });

  it('runs the runner under flock in a transient unit that is not bound to the daemon', () => {
    const argv = systemdRunArgv(launchSpec(), '/d/locks/op-1.lock', [
      '/node',
      '/cusr-runner.js',
      'exec',
    ]);
    expect(argv.slice(0, 3)).toEqual([SYSTEMD_RUN, '--user', '--unit=cusr-op-op-1.service']);
    expect(argv).toContain('--property=Restart=no');
    expect(argv).toContain('--property=KillMode=control-group');
    expect(argv).toContain('--property=TimeoutStopSec=15s');
    expect(argv.join(' ')).not.toMatch(/PartOf|Requires|BindsTo|--collect|--scope/);
    const flock = argv.indexOf(FLOCK);
    expect(argv.slice(flock)).toEqual(
      flockArgv('/d/locks/op-1.lock', ['/node', '/cusr-runner.js', 'exec']),
    );
    expect(argv.slice(flock)).toContain(String(LOCK_CONFLICT_EXIT));
  });

  it('derives one unit per operation and rejects unsafe ids', () => {
    expect(unitName('op-1')).toBe('cusr-op-op-1.service');
    expect(() => unitName('../x')).toThrow();
    expect(() => unitName('a b')).toThrow();
  });

  it.each([
    ['not-found', 'inactive', 'not_found'],
    ['loaded', 'active', 'active'],
    ['loaded', 'deactivating', 'active'],
    ['loaded', 'failed', 'failed'],
    ['loaded', 'inactive', 'exited'],
    ['masked', 'inactive', 'unknown'],
  ])('maps LoadState=%s ActiveState=%s to %s', (load, active, state) => {
    expect(parseUnitShow('u', show(load, active).stdout).state).toBe(state);
  });
});

describe('SystemdSupervisor with scripted systemctl', () => {
  it('writes the invocation spec, then starts the unit and reports its invocation id', async () => {
    const d = dataDir();
    const exec = scripted([
      show('not-found', 'inactive'),
      show('loaded', 'active', 'a'.repeat(32)),
    ]);
    const sup = new SystemdSupervisor({
      dataDir: d,
      runnerCommand: ['/node', '/runner.js'],
      exec,
    });
    const r = await sup.launch(launchSpec());
    expect(r).toEqual({
      ok: true,
      value: { unit: 'cusr-op-op-1.service', invocation_id: 'a'.repeat(32) },
    });
    const started = exec.calls.find((c) => c[0] === SYSTEMD_RUN) ?? [];
    expect(started.slice(-9)).toEqual([
      '/node',
      '/runner.js',
      'exec',
      '--data-dir',
      d,
      '--kind',
      'runs',
      '--id',
      'at-1',
    ]);
    const run = RunDir.open({
      dataDir: d,
      kind: 'runs',
      id: 'at-1',
      redactor: new Redactor(),
      create: false,
    });
    expect(run.readFinal(RUN_FILES.invocation)).toMatchObject({
      state: 'valid',
      value: { operation_id: 'op-1', launch_nonce: 'nonce-1' },
    });
  });

  describe('secret variables', () => {
    const secrets = { GH_TOKEN: 'gho_owner-login-value', NPM_TOKEN: 'npm-owner-value' };
    const open = (d: string): RunDir =>
      RunDir.open({
        dataDir: d,
        kind: 'runs',
        id: 'at-1',
        redactor: new Redactor(),
        create: false,
      });
    const launch = (d: string, exec: CommandExec) =>
      new SystemdSupervisor({ dataDir: d, runnerCommand: ['/r'], exec }).launch(
        launchSpec({
          argv: ['/bin/sh', '-c', 'printf %s "$GH_TOKEN $NPM_TOKEN $PLAIN" > "$OUT"'],
          cwd: d,
          env: { ...secrets, PATH: '/usr/bin:/bin', PLAIN: 'plain', OUT: join(d, 'seen') },
          deadline_at: asEpochMs(Date.now() + 60_000),
        }),
      );

    it('reach the command as they are, and only redacted files stay on disk', async () => {
      const d = dataDir();
      const exec = scripted([show('not-found', 'inactive'), show('loaded', 'active')]);
      expect(await launch(d, exec)).toMatchObject({ ok: true });
      const run = open(d);
      expect(statSync(run.resolve(SECRET_ENV_FILE)).mode & 0o777).toBe(0o600);
      const stored = readFileSync(run.resolve(RUN_FILES.invocation), 'utf8');
      expect(stored).not.toContain(secrets.GH_TOKEN);
      expect(JSON.parse(stored)).toMatchObject({ secret_env: true, env: { PLAIN: 'plain' } });

      const r = await execOperation(run, { sample_ms: 50, onStop: () => () => undefined });
      expect(r).toMatchObject({ state: 'finished', exit: { outcome: 'exited', exit_code: 0 } });
      expect(readFileSync(join(d, 'seen'), 'utf8')).toBe(
        `${secrets.GH_TOKEN} ${secrets.NPM_TOKEN} plain`,
      );
      expect(existsSync(run.resolve(SECRET_ENV_FILE))).toBe(false);
    });

    it('a run that lost them does not start without them', async () => {
      const d = dataDir();
      await launch(d, scripted([show('not-found', 'inactive'), show('loaded', 'active')]));
      const run = open(d);
      run.removeSecretEnv();
      const r = await execOperation(run, { sample_ms: 50, onStop: () => () => undefined });
      expect(r).toMatchObject({
        state: 'finished',
        exit: { outcome: 'spawn_failed', spawned: false, error: 'secret environment missing' },
      });
      expect(existsSync(join(d, 'seen'))).toBe(false);
    });

    it('do not stay behind a launch that failed or a run that is fenced off', async () => {
      const failed = dataDir();
      const refused = scripted(
        [show('not-found', 'inactive'), show('not-found', 'inactive')],
        result({ code: 1 }),
      );
      expect(await launch(failed, refused)).toMatchObject({ error: { code: 'spawn_failed' } });
      expect(existsSync(open(failed).resolve(SECRET_ENV_FILE))).toBe(false);

      const fenced = dataDir();
      await launch(fenced, scripted([show('not-found', 'inactive'), show('loaded', 'active')]));
      const run = open(fenced);
      fenceLaunch(run, { operation_id: 'op-1', attempt_id: 'at-1', at: 'now' });
      expect(existsSync(run.resolve(SECRET_ENV_FILE))).toBe(false);
    });
  });

  it('refuses to start again when a launch marker exists, without calling systemd-run', async () => {
    const d = dataDir();
    const run = RunDir.open({
      dataDir: d,
      kind: 'runs',
      id: 'at-1',
      redactor: new Redactor(),
    });
    expect(claimLaunch(run, marker()).state).toBe('claimed');
    expect(claimLaunch(run, marker('other')).state).toBe('marker_exists');
    const exec = scripted([]);
    const r = await new SystemdSupervisor({
      dataDir: d,
      runnerCommand: ['/r'],
      exec,
    }).launch(launchSpec());
    expect(r).toMatchObject({ ok: false, error: { code: 'marker_exists' } });
    expect(exec.calls).toEqual([]);
  });

  it('refuses when the unit is still loaded, and reports unknown when systemd cannot be read', async () => {
    const loaded = scripted([show('loaded', 'failed')]);
    expect(
      await new SystemdSupervisor({
        dataDir: dataDir(),
        runnerCommand: ['/r'],
        exec: loaded,
      }).launch(launchSpec()),
    ).toMatchObject({
      ok: false,
      error: { code: 'marker_exists' },
    });
    const broken = scripted([result({ code: 1 })]);
    expect(
      await new SystemdSupervisor({
        dataDir: dataDir(),
        runnerCommand: ['/r'],
        exec: broken,
      }).launch(launchSpec()),
    ).toMatchObject({
      ok: false,
      error: { code: 'unknown' },
    });
    expect([...loaded.calls, ...broken.calls].some((c) => c[0] === SYSTEMD_RUN)).toBe(false);
  });

  it('reports spawn_failed only when no unit exists after a failed systemd-run, unknown on timeout', async () => {
    const failed = scripted(
      [show('not-found', 'inactive'), show('not-found', 'inactive')],
      result({ code: 1, stderr: 'Failed to start' }),
    );
    expect(
      await new SystemdSupervisor({
        dataDir: dataDir(),
        runnerCommand: ['/r'],
        exec: failed,
      }).launch(launchSpec()),
    ).toMatchObject({
      ok: false,
      error: { code: 'spawn_failed' },
    });
    const slow = scripted(
      [show('not-found', 'inactive'), show('not-found', 'inactive')],
      result({ code: null, timed_out: true }),
    );
    expect(
      await new SystemdSupervisor({
        dataDir: dataDir(),
        runnerCommand: ['/r'],
        exec: slow,
      }).launch(launchSpec()),
    ).toMatchObject({
      ok: false,
      error: { code: 'unknown' },
    });
  });

  it('stops only an active unit and verifies it afterwards', async () => {
    const stop = { term_grace_ms: 10_000, kill_verify_ms: 5_000 };
    const idle = scripted([show('not-found', 'inactive')]);
    expect(
      await new SystemdSupervisor({
        dataDir: dataDir(),
        runnerCommand: ['/r'],
        exec: idle,
      }).stop('op-1', stop),
    ).toBe('not_running');
    const ok = scripted([show('loaded', 'active'), show('loaded', 'failed')]);
    expect(
      await new SystemdSupervisor({
        dataDir: dataDir(),
        runnerCommand: ['/r'],
        exec: ok,
      }).stop('op-1', stop),
    ).toBe('stopped');
    expect(ok.calls).toContainEqual([SYSTEMCTL, '--user', 'stop', 'cusr-op-op-1.service']);
    const stuck = scripted([show('loaded', 'active'), show('loaded', 'active')]);
    expect(
      await new SystemdSupervisor({
        dataDir: dataDir(),
        runnerCommand: ['/r'],
        exec: stuck,
      }).stop('op-1', stop),
    ).toBe('unknown');
  });
});

describe('process identity and launch recovery view', () => {
  it('captures this process and recognises it as alive; a reused pid or other boot is not', () => {
    const rec = captureIdentity(process.pid, {
      operation_id: 'op-1',
      launch_nonce: 'n',
    });
    expect(rec).not.toBeNull();
    expect(PidRecordSchema.parse(rec)).toEqual(rec);
    if (rec === null) return;
    expect(rec.start_ticks).toBe(startTicks(process.pid));
    expect(checkIdentity(rec)).toBe('alive');
    expect(checkIdentity({ ...rec, start_ticks: rec.start_ticks + 1 })).toBe('gone');
    expect(checkIdentity({ ...rec, boot_id: 'another-boot' })).toBe('other_boot');
  });

  it('observes not_launched, running, lost and finished without ever offering a respawn', () => {
    const d = dataDir();
    const run = RunDir.open({
      dataDir: d,
      kind: 'runs',
      id: 'at-1',
      redactor: new Redactor(),
    });
    const probe = {
      bootId: () => 'boot-a',
      startTicks: (pid: number) => (pid === 42 ? 7 : null),
    };
    expect(observeLaunch(run, () => 'free', probe)).toEqual({
      state: 'not_launched',
    });
    claimLaunch(run, marker());
    expect(observeLaunch(run, () => 'held', probe).state).toBe('running');
    expect(observeLaunch(run, () => 'free', probe).state).toBe('lost');
    expect(observeLaunch(run, () => 'unknown', probe).state).toBe('unknown');
    const pid = {
      schema_version: 1,
      operation_id: 'op-1',
      launch_nonce: 'nonce-1',
      boot_id: 'boot-a',
      pid: 42,
      pgid: 42,
      start_ticks: 7,
      runner_pid: 2,
      runner_start_ticks: 1,
      invocation_id: null,
      cgroup: null,
    };
    run.writeJson(RUN_FILES.pid, pid);
    expect(observeLaunch(run, () => 'free', probe)).toMatchObject({
      state: 'running',
      reason: 'pid and start ticks match',
    });
    run.writeJson(RUN_FILES.pid, { ...pid, start_ticks: 8 });
    expect(observeLaunch(run, () => 'free', probe).state).toBe('lost');
    // /proc that cannot be read is no evidence the process is gone.
    expect(
      observeLaunch(run, () => 'free', {
        bootId: () => 'boot-a',
        startTicks: () => 'unreadable' as const,
      }),
    ).toMatchObject({
      state: 'unknown',
      reason: 'process identity unreadable',
    });
    run.writeJson(RUN_FILES.pid, { ...pid, launch_nonce: 'stale' });
    expect(observeLaunch(run, () => 'free', probe).state).toBe('unknown');
    run.writeExit({ outcome: 'exited' });
    expect(observeLaunch(run, () => 'free', probe)).toEqual({
      state: 'finished',
    });
  });
});

describe('kernel operation lock (util-linux flock)', () => {
  it('reports held while a runner holds it and free once it exits', async () => {
    const lock = lockFilePath(dataDir(), 'op-lock', true);
    expect(probeOperationLock(lock)).toBe('free');
    // Descendants inherit the locked fd, so the whole group must be gone before the lock is free.
    const holder = spawn(
      FLOCK,
      ['--exclusive', lock, '/bin/sh', '-c', 'echo ready; exec sleep 30'],
      { stdio: ['ignore', 'pipe', 'ignore'], detached: true },
    );
    await once(holder.stdout, 'data');
    expect(probeOperationLock(lock)).toBe('held');
    const closed = once(holder, 'close');
    process.kill(-(holder.pid as number), 'SIGKILL');
    await closed;
    expect(probeOperationLock(lock)).toBe('free');
  });
});
