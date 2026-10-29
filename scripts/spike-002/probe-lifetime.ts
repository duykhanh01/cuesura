/**
 * Local-only T006 evidence: systemd --user runner lifetime with the fake child. Records unit
 * identity, cgroup, descendant pids and exit.json for (1) foreground launcher SIGKILL and (2) a
 * disposable daemon unit restart/stop, then stopping the runner unit. No model, network or sudo;
 * the daemon unit is a stand-in, not cusrd.service.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stopUnit,
  systemdRunArgv,
  unitName,
  unitStatus,
  type RunSpec,
} from './runner.ts';

const FAKE = fileURLToPath(
  new URL(
    '../../test/fixtures/runtime/spike-0/bin/fake-harness.js',
    import.meta.url,
  ),
);
const UNIT_KEYS = [
  'ActiveState',
  'SubState',
  'InvocationID',
  'ControlGroup',
  'KillMode',
  'Restart',
  'NRestarts',
] as const;

type Step = {
  readonly step: string;
  readonly at: string;
  readonly [k: string]: unknown;
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

function unit(id: string): Record<string, string> {
  const s = unitStatus(id);
  return Object.fromEntries(UNIT_KEYS.map((k) => [k, s[k] ?? '']));
}

function cgroupProcs(cgroup: string | null): number[] {
  if (cgroup === null) return [];
  try {
    return readFileSync(`/sys/fs/cgroup${cgroup}/cgroup.procs`, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function writeSpec(base: string, opId: string, pidsFile: string): string {
  const spec: RunSpec = {
    schema_version: 1,
    kind: 'operations',
    operation_id: opId,
    attempt_id: null,
    command: [process.execPath, FAKE, 'grandchild', pidsFile],
    cwd: base,
    env: { PATH: '/usr/bin:/bin' },
    stdin_file: null,
    deadline_ms: 120_000,
    redact_files: [],
    binding: null,
    limits: {},
  };
  const file = join(base, `${opId}.spec.json`);
  writeFileSync(file, JSON.stringify(spec));
  return file;
}

async function stopAndCollect(
  base: string,
  opId: string,
  pids: { in_group: number; escaped: number },
  steps: Step[],
): Promise<Record<string, unknown>> {
  const dir = join(base, 'operations', opId);
  const pid = JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8')) as {
    invocation_id: string | null;
    cgroup: string | null;
  };
  const before = cgroupProcs(pid.cgroup);
  const stopExit = stopUnit(opId);
  const dead = await until(
    () => !alive(pids.in_group) && !alive(pids.escaped),
    20_000,
  );
  const exitWritten = await until(
    () => existsSync(join(dir, 'exit.json')),
    15_000,
  );
  const exit = exitWritten
    ? (JSON.parse(readFileSync(join(dir, 'exit.json'), 'utf8')) as Record<
        string,
        unknown
      >)
    : null;
  steps.push({
    step: 'stop runner unit',
    at: new Date().toISOString(),
    systemctl_stop_exit: stopExit,
    cgroup_procs_before_stop: before,
    in_group_alive: alive(pids.in_group),
    escaped_alive: alive(pids.escaped),
    unit_after: unit(opId),
  });
  return {
    pid_json: pid,
    exit_json: exit,
    descendants_dead: dead,
    exit_written: exitWritten,
  };
}

export async function runLifetimeProbe(): Promise<Record<string, unknown>> {
  const manager = spawnSync('systemctl', ['--user', 'is-system-running'], {
    encoding: 'utf8',
  });
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-lifetime-')));
  mkdirSync(join(base, 'locks'));
  const stamp = `${process.pid}-${Date.now()}`;
  const fgOp = `spike-lifetime-fg-${stamp}`;
  const svcOp = `spike-lifetime-svc-${stamp}`;
  const daemonUnit = `cusr-spike-daemon-${stamp}.service`;
  let launcher: ChildProcess | undefined;
  try {
    // Scenario 1: foreground launcher killed after starting the runner unit.
    const fgSteps: Step[] = [];
    const fgPidsFile = join(base, 'fg-pids.json');
    const fgArgv = systemdRunArgv(
      writeSpec(base, fgOp, fgPidsFile),
      base,
      fgOp,
    );
    launcher = spawn(
      '/bin/sh',
      ['-c', '"$@" && exec /bin/sleep 120', 'sh', ...fgArgv],
      { stdio: 'ignore' },
    );
    if (!(await until(() => existsSync(fgPidsFile), 15_000)))
      throw new Error('foreground runner did not start the fake child');
    const fgPids = JSON.parse(readFileSync(fgPidsFile, 'utf8')) as {
      in_group: number;
      escaped: number;
    };
    fgSteps.push({
      step: 'runner unit started',
      at: new Date().toISOString(),
      launcher_pid: launcher.pid,
      descendants: fgPids,
      unit: unit(fgOp),
    });
    const closed = once(launcher, 'close');
    launcher.kill('SIGKILL');
    const [code, signal] = (await closed) as [number | null, string | null];
    fgSteps.push({
      step: 'SIGKILL foreground launcher',
      at: new Date().toISOString(),
      launcher_exit: code,
      launcher_signal: signal,
      unit: unit(fgOp),
      in_group_alive: alive(fgPids.in_group),
      escaped_alive: alive(fgPids.escaped),
    });
    const fg = await stopAndCollect(base, fgOp, fgPids, fgSteps);

    // Scenario 2: disposable daemon unit restarted and stopped while the runner unit keeps running.
    const svcSteps: Step[] = [];
    const svcPidsFile = join(base, 'svc-pids.json');
    const command =
      'if ! /usr/bin/systemctl --user is-active --quiet "$1"; then shift; "$@" || exit $?; fi; exec /bin/sleep 120';
    const start = spawnSync(
      'systemd-run',
      [
        '--user',
        `--unit=${daemonUnit}`,
        '--property=Restart=no',
        '--property=KillMode=control-group',
        '/bin/sh',
        '-c',
        command,
        'sh',
        unitName(svcOp),
        ...systemdRunArgv(writeSpec(base, svcOp, svcPidsFile), base, svcOp),
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    if (
      start.status !== 0 ||
      !(await until(() => existsSync(svcPidsFile), 15_000))
    )
      throw new Error(`daemon stand-in failed: ${start.stderr}`);
    const svcPids = JSON.parse(readFileSync(svcPidsFile, 'utf8')) as {
      in_group: number;
      escaped: number;
    };
    svcSteps.push({
      step: 'runner unit started by daemon unit',
      at: new Date().toISOString(),
      systemd_run_exit: start.status,
      descendants: svcPids,
      unit: unit(svcOp),
    });
    for (const action of ['restart', 'stop']) {
      const r = spawnSync('systemctl', ['--user', action, daemonUnit], {
        encoding: 'utf8',
        timeout: 15_000,
      });
      svcSteps.push({
        step: `${action} daemon unit`,
        at: new Date().toISOString(),
        systemctl_exit: r.status,
        unit: unit(svcOp),
        in_group_alive: alive(svcPids.in_group),
        escaped_alive: alive(svcPids.escaped),
      });
    }
    const svc = await stopAndCollect(base, svcOp, svcPids, svcSteps);

    const invocationStable = (steps: Step[]): boolean =>
      new Set(
        steps
          .slice(0, -1)
          .map((s) => (s['unit'] as Record<string, string>)['InvocationID']),
      ).size === 1;
    const survived = (steps: Step[]): boolean =>
      steps
        .slice(1, -1)
        .every(
          (s) =>
            s['in_group_alive'] === true &&
            s['escaped_alive'] === true &&
            (s['unit'] as Record<string, string>)['ActiveState'] === 'active',
        );
    const finished = (r: Record<string, unknown>): boolean => {
      const exit = r['exit_json'] as {
        outcome?: string;
        termination?: { descendant_scope?: string };
      } | null;
      return (
        r['descendants_dead'] === true &&
        exit?.outcome === 'cancelled' &&
        exit.termination?.descendant_scope === 'unit_cgroup'
      );
    };
    const digest = (path: string): string =>
      createHash('sha256').update(readFileSync(path)).digest('hex');
    return {
      schema_version: 1,
      kind: 'spike-0-runner-lifetime',
      checked_at: new Date().toISOString(),
      scope:
        'Local fake child in transient systemd --user units. Daemon is a disposable stand-in, not cusrd.service. No model, network, sudo or host policy change.',
      user_manager: manager.stdout.trim(),
      systemd: spawnSync('systemctl', ['--version'], {
        encoding: 'utf8',
      }).stdout.split('\n')[0],
      kernel: spawnSync('uname', ['-r'], { encoding: 'utf8' }).stdout.trim(),
      node: process.version,
      hashes: {
        probe: digest(fileURLToPath(import.meta.url)),
        runner: digest(fileURLToPath(new URL('./runner.ts', import.meta.url))),
        fake_child: digest(FAKE),
      },
      foreground: {
        operation_id: fgOp,
        unit: unitName(fgOp),
        unit_argv: fgArgv,
        steps: fgSteps,
        ...fg,
        invocation_stable: invocationStable(fgSteps),
        survived_launcher: survived(fgSteps),
        stopped_all_descendants: finished(fg),
      },
      daemon_unit: {
        operation_id: svcOp,
        unit: unitName(svcOp),
        daemon_unit: daemonUnit,
        steps: svcSteps,
        ...svc,
        invocation_stable: invocationStable(svcSteps),
        survived_daemon: survived(svcSteps),
        stopped_all_descendants: finished(svc),
      },
      passed:
        invocationStable(fgSteps) &&
        survived(fgSteps) &&
        finished(fg) &&
        invocationStable(svcSteps) &&
        survived(svcSteps) &&
        finished(svc),
    };
  } finally {
    launcher?.kill('SIGKILL');
    spawnSync('systemctl', ['--user', 'stop', daemonUnit]);
    for (const id of [fgOp, svcOp]) {
      stopUnit(id);
      spawnSync('systemctl', ['--user', 'reset-failed', unitName(id)]);
    }
    spawnSync('systemctl', ['--user', 'reset-failed', daemonUnit]);
    rmSync(base, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const report = await runLifetimeProbe();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report['passed'] === true ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
