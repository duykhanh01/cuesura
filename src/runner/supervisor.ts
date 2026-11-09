/**
 * Operation supervisor (contracts/execution.md, ADR-0002). The daemon
 * calls {@link SystemdSupervisor.launch} only after the effect, slot, reservation and operation id are
 * committed. Each operation runs as its own transient user service `cusr-op-<operation>.service`:
 * Restart=no, KillMode=control-group, no PartOf/Requires on the daemon, and no `--collect` before the
 * result is ingested. The unit outlives a killed foreground daemon and a daemon service stop/restart.
 *
 * The supervisor never decides retry: a launch it cannot prove did not happen is `unknown`, and an
 * existing marker or loaded unit is `marker_exists` (recover it, do not spawn again).
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type {
  Clock,
  LaunchError,
  OperationLaunch,
  ProcessPort,
  StopOutcome,
  UnitObservation,
} from '../adapters/ports.ts';
import { RelativePathSchema } from '../domain/runtime.ts';
import { asEpochMs } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import { RUN_FILES, RunDir, RunnerFileError, isSafeId } from './files.ts';
import {
  HOST_PROBE,
  PidRecordSchema,
  checkIdentity,
  toProcessIdentity,
  unitName,
  type IdentityProbe,
} from './identity.ts';
import {
  fenceLaunch,
  flockArgv,
  lockFilePath,
  readLaunchMarker,
  type LockProbe,
} from './operation-lock.ts';
import { Redactor } from './redact.ts';
import { shellJoin, terminalLabel, type TerminalHost } from './terminal-host.ts';

export const SYSTEMD_RUN = '/usr/bin/systemd-run';
export const SYSTEMCTL = '/usr/bin/systemctl';

export type CommandResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timed_out: boolean;
  readonly error: string | null;
};

/** argv-only command execution (no shell); injected so tests can script systemd answers. */
export type CommandExec = (
  file: string,
  args: readonly string[],
  opts: { readonly timeout_ms: number },
) => Promise<CommandResult>;

const OUTPUT_CAP = 64 * 1024;

export const spawnCommand: CommandExec = (file, args, opts) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const done = (r: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(file, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', ...userBusEnv() },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeout_ms);
    child.stdout.on('data', (b: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += b.toString('utf8');
    });
    child.once('error', (e) =>
      done({
        code: null,
        stdout,
        stderr,
        timed_out: timedOut,
        error: e.message,
      }),
    );
    child.once('close', (code) => done({ code, stdout, stderr, timed_out: timedOut, error: null }));
  });

/** systemctl/systemd-run --user need only the user bus address, never the daemon's full environment. */
function userBusEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'HOME', 'USER', 'LANG']) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Exec spec the runner reads from invocation.json inside its unit. */
export const InvocationSpecSchema = z
  .object({
    schema_version: z.literal(1),
    operation_id: z.string().min(1),
    kind: z.string().min(1),
    run_dir_kind: z.enum(['runs', 'operations']),
    run_id: z.string().min(1),
    argv: z.array(z.string()).min(1),
    cwd: z.string().startsWith('/'),
    env: z.record(z.string(), z.string()),
    // Additive: the run also has variables in SECRET_ENV_FILE and must not start without them.
    secret_env: z.literal(true).optional(),
    wall_ms: z.number().int().positive().nullable(),
    deadline_at: z.number().int().nonnegative().nullable(),
    term_grace_ms: z.number().int().positive(),
    kill_verify_ms: z.number().int().positive(),
    launch_nonce: z.string().min(1),
    // Additive: prompt on stdin, stall detection and the directories whose changes count as progress.
    stdin: RelativePathSchema.nullable().optional(),
    stall_ms: z.number().int().positive().nullable().optional(),
    watch: z.array(z.string().startsWith('/')).optional(),
  })
  .strict();
export type InvocationSpec = z.infer<typeof InvocationSpecSchema>;

function seconds(ms: number): number {
  return Math.ceil(ms / 1_000);
}

/**
 * Transient unit argv. flock is the main process and ignores SIGTERM so that, when systemd stops the
 * whole cgroup, the runner can stop the harness group and finalise exit.json before the unit ends;
 * the runner installs its own handler, and spawned children get default dispositions.
 *
 * `pty` attaches the unit to the terminal of the `systemd-run` client (ADR-0006). The unit is the same
 * service; flock then also ignores what the terminal can send, so that Ctrl-C or the terminal going away
 * cannot end the main process and with it the whole cgroup.
 */
export function systemdRunArgv(
  spec: OperationLaunch,
  lockFile: string,
  runnerCommand: readonly string[],
  opts: { readonly pty?: boolean } = {},
): string[] {
  const stopMs = spec.term_grace_ms + spec.kill_verify_ms;
  return [
    SYSTEMD_RUN,
    '--user',
    `--unit=${unitName(spec.operation_id)}`,
    '--property=Restart=no',
    '--property=KillMode=control-group',
    `--property=TimeoutStopSec=${seconds(stopMs)}s`,
    '--property=SendSIGKILL=yes',
    // Backstop only: the runner enforces the wall deadline itself and finalises the outcome.
    ...(spec.wall_ms === null
      ? []
      : [`--property=RuntimeMaxSec=${seconds(spec.wall_ms + stopMs) + 30}s`]),
    '--quiet',
    ...(opts.pty === true ? ['--pty'] : []),
    '--',
    '/bin/sh',
    '-c',
    opts.pty === true ? 'trap "" TERM INT HUP; exec "$@"' : 'trap "" TERM; exec "$@"',
    'sh',
    ...flockArgv(lockFile, runnerCommand),
  ];
}

const ACTIVE_STATES = new Set(['active', 'activating', 'deactivating', 'reloading', 'refreshing']);

export function parseUnitShow(unit: string, stdout: string): UnitObservation {
  const props = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) props.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const load = props.get('LoadState');
  const active = props.get('ActiveState');
  const invocation = props.get('InvocationID') ?? '';
  const cgroup = props.get('ControlGroup') ?? '';
  const facts = {
    unit,
    invocation_id: invocation === '' ? null : invocation,
    cgroup: cgroup === '' ? null : cgroup,
  };
  if (load === 'not-found') return { ...facts, state: 'not_found' };
  if (load !== 'loaded' || active === undefined) return { ...facts, state: 'unknown' };
  if (ACTIVE_STATES.has(active)) return { ...facts, state: 'active' };
  if (active === 'failed') return { ...facts, state: 'failed' };
  if (active === 'inactive') return { ...facts, state: 'exited' };
  return { ...facts, state: 'unknown' };
}

/** `systemctl --user show` of the operation's unit; anything unreadable is `unknown`, never `not_found`. */
export async function inspectUnit(
  operationId: string,
  exec: CommandExec = spawnCommand,
): Promise<UnitObservation> {
  const unit = unitName(operationId);
  const r = await exec(
    SYSTEMCTL,
    [
      '--user',
      'show',
      unit,
      '-p',
      'LoadState,ActiveState,SubState,Result,InvocationID,ControlGroup',
    ],
    { timeout_ms: 15_000 },
  );
  if (r.code !== 0 || r.timed_out)
    return { unit, state: 'unknown', invocation_id: null, cgroup: null };
  return parseUnitShow(unit, r.stdout);
}

export type SupervisorOptions = {
  /** Absolute DATA_DIR holding runs/, operations/ and locks/. */
  readonly dataDir: string;
  /** Runner entrypoint prefix; `exec --data-dir D --kind K --id I` is appended. */
  readonly runnerCommand: readonly string[];
  readonly exec?: CommandExec;
  readonly redactor?: Redactor;
  /** Shows agent operations in a multiplexer; absent or unavailable, they run in the background. */
  readonly terminal?: TerminalHost;
  /** How long a terminal may take to start the unit before the launch goes on without it. */
  readonly terminalWaitMs?: number;
  readonly log?: (line: string) => void;
  readonly clock?: Clock;
};

const SYSTEM_CLOCK: Clock = {
  now: () => asEpochMs(Date.now()),
  monotonic: () => performance.now(),
};

const TERMINAL_WAIT_MS = 15_000;
const TERMINAL_POLL_MS = 100;

export class SystemdSupervisor implements ProcessPort {
  readonly #dataDir: string;
  readonly #runner: readonly string[];
  readonly #exec: CommandExec;
  readonly #redactor: Redactor;
  readonly #terminal: TerminalHost | null;
  readonly #terminalWaitMs: number;
  readonly #log: (line: string) => void;
  readonly #clock: Clock;

  constructor(opts: SupervisorOptions) {
    if (opts.runnerCommand.length === 0)
      throw new RunnerFileError('invalid_argument', 'empty runner command');
    this.#dataDir = opts.dataDir;
    this.#runner = opts.runnerCommand;
    this.#exec = opts.exec ?? spawnCommand;
    this.#redactor = opts.redactor ?? new Redactor();
    this.#terminal = opts.terminal ?? null;
    this.#terminalWaitMs = opts.terminalWaitMs ?? TERMINAL_WAIT_MS;
    this.#log = opts.log ?? (() => undefined);
    this.#clock = opts.clock ?? SYSTEM_CLOCK;
  }

  /**
   * Starts the unit from a terminal. `null` means it was not seen to start and the caller launches it in the
   * background: the unit name, the operation lock and the launch marker refuse a second run of this
   * operation, even if the command typed here runs after all. A replacement attempt is another operation;
   * `fenceLaunch` is what stops this command then.
   */
  async #launchInTerminal(
    terminal: TerminalHost,
    spec: OperationLaunch,
    lock: string,
    command: readonly string[],
    run: RunDir,
  ): Promise<{ unit: string; invocation_id: string | null } | null> {
    const unit = unitName(spec.operation_id);
    const argv = systemdRunArgv(spec, lock, command, { pty: true });
    const opened = await terminal.open({
      label: terminalLabel(spec),
      ...(spec.view === undefined ? {} : { project: spec.view.project }),
      // Not the worktree: this shell runs the user's hooks in the directory it starts in.
      cwd: this.#dataDir,
      // The leading space keeps it out of a shell history that honours it.
      command: ` ${shellJoin(argv)}; exit`,
    });
    if (!opened.ok) {
      this.#log(`${terminal.name} unavailable, ${unit} runs in the background: ${opened.error}`);
      return null;
    }
    const deadline = this.#clock.monotonic() + this.#terminalWaitMs;
    for (;;) {
      const seen = await this.inspect(spec.operation_id);
      if (seen.state !== 'not_found' && seen.state !== 'unknown')
        return { unit, invocation_id: seen.invocation_id };
      if (readLaunchMarker(run).state !== 'missing') return { unit, invocation_id: null };
      if (this.#clock.monotonic() >= deadline) break;
      await delay(TERMINAL_POLL_MS);
    }
    this.#log(`${terminal.name} did not start ${unit} in time, it runs in the background`);
    await opened.value.close();
    return null;
  }

  async launch(
    spec: OperationLaunch,
  ): Promise<
    Result<{ readonly unit: string; readonly invocation_id: string | null }, LaunchError>
  > {
    if (!isSafeId(spec.operation_id) || !isSafeId(spec.run_id))
      return err({
        code: 'spawn_failed',
        message: 'unsafe operation or run id',
      });
    const unit = unitName(spec.operation_id);
    const run = RunDir.open({
      dataDir: this.#dataDir,
      kind: spec.run_dir_kind,
      id: spec.run_id,
      redactor: this.#redactor,
    });
    if (readLaunchMarker(run).state !== 'missing')
      return err({
        code: 'marker_exists',
        message: `${spec.run_dir_kind}/${spec.run_id} already has a launch marker`,
      });
    const before = await this.inspect(spec.operation_id);
    if (before.state === 'unknown')
      return err({
        code: 'unknown',
        message: `cannot read ${unit} before launch`,
      });
    if (before.state !== 'not_found')
      return err({
        code: 'marker_exists',
        message: `${unit} is already loaded (${before.state})`,
      });

    // Whatever the redactor would change goes around invocation.json, or the command gets `[REDACTED]`.
    const shown = this.#redactor.value(spec.env) as Record<string, string>;
    const env: Record<string, string> = {};
    const secret: Record<string, string> = {};
    for (const [key, value] of Object.entries(spec.env))
      (shown[key] === value ? env : secret)[key] = value;
    const hasSecret = Object.keys(secret).length > 0;
    const invocation: InvocationSpec = {
      schema_version: 1,
      operation_id: spec.operation_id,
      kind: spec.kind,
      run_dir_kind: spec.run_dir_kind,
      run_id: spec.run_id,
      argv: [...spec.argv],
      cwd: spec.cwd,
      env,
      ...(hasSecret ? { secret_env: true as const } : {}),
      wall_ms: spec.wall_ms,
      deadline_at: spec.deadline_at,
      term_grace_ms: spec.term_grace_ms,
      kill_verify_ms: spec.kill_verify_ms,
      launch_nonce: spec.launch_nonce,
      ...(spec.stdin === undefined ? {} : { stdin: spec.stdin }),
      ...(spec.stall_ms === undefined ? {} : { stall_ms: spec.stall_ms }),
      ...(spec.watch === undefined ? {} : { watch: [...spec.watch] }),
    };
    if (hasSecret) run.writeSecretEnv(secret);
    run.writeJson(RUN_FILES.invocation, InvocationSpecSchema.parse(invocation));
    const lock = lockFilePath(this.#dataDir, spec.operation_id, true);
    const command = [
      ...this.#runner,
      'exec',
      '--data-dir',
      run.root,
      '--kind',
      spec.run_dir_kind,
      '--id',
      spec.run_id,
    ];
    const viaTerminal = this.#terminal !== null && spec.kind === 'agent';
    if (this.#terminal !== null && viaTerminal) {
      const shown = await this.#launchInTerminal(this.#terminal, spec, lock, command, run);
      if (shown !== null) return ok(shown);
    }
    const argv = systemdRunArgv(spec, lock, command);
    const r = await this.#exec(argv[0] as string, argv.slice(1), {
      timeout_ms: 30_000,
    });
    const after = await this.inspect(spec.operation_id);
    if (r.code === 0 && !r.timed_out) {
      // A short operation may already be finished and collected; the invocation id is then unknown.
      return ok({ unit, invocation_id: after.invocation_id });
    }
    if (
      after.state === 'not_found' &&
      !r.timed_out &&
      r.error === null &&
      readLaunchMarker(run).state === 'missing'
    ) {
      // `spawn_failed` lets a new attempt start; a command left in the terminal must not start beside it.
      if (
        viaTerminal &&
        fenceLaunch(run, {
          operation_id: spec.operation_id,
          attempt_id: spec.run_dir_kind === 'runs' ? spec.run_id : null,
          at: new Date(this.#clock.now()).toISOString(),
        }).state === 'marker_exists'
      )
        return err({
          code: 'unknown',
          message: `${unit} was started from the terminal after all`,
        });
      run.removeSecretEnv();
      return err({
        code: 'spawn_failed',
        message: `systemd-run exit ${String(r.code)}: ${r.stderr.trim()}`,
      });
    }
    return err({
      code: 'unknown',
      message: `systemd-run ${r.timed_out ? 'timed out' : `exit ${String(r.code)}`}; unit ${after.state}`,
    });
  }

  inspect(operationId: string): Promise<UnitObservation> {
    return inspectUnit(operationId, this.#exec);
  }

  /** systemd sends SIGTERM to the whole cgroup, waits TimeoutStopSec, then SIGKILL; we verify after. */
  async stop(
    operationId: string,
    opts: { readonly term_grace_ms: number; readonly kill_verify_ms: number },
  ): Promise<StopOutcome> {
    const unit = unitName(operationId);
    const before = await this.inspect(operationId);
    if (before.state === 'unknown') return 'unknown';
    if (before.state !== 'active') return 'not_running';
    const r = await this.#exec(SYSTEMCTL, ['--user', 'stop', unit], {
      timeout_ms: opts.term_grace_ms + opts.kill_verify_ms + 5_000,
    });
    const after = await this.inspect(operationId);
    if (after.state === 'unknown' || after.state === 'active') return 'unknown';
    return r.timed_out ? 'unknown' : 'stopped';
  }

  /** Releases a failed unit's record; only after its result was ingested and acknowledged. */
  async collect(operationId: string): Promise<boolean> {
    const r = await this.#exec(SYSTEMCTL, ['--user', 'reset-failed', unitName(operationId)], {
      timeout_ms: 15_000,
    });
    return r.code === 0;
  }
}

/**
 * Recovery view of one run directory. Never says "safe to respawn": a marker without exit.json is
 * `running` (identity or lock still held), `lost` (identity gone or other boot) or `unknown`.
 */
export type LaunchState =
  | { readonly state: 'not_launched' }
  | { readonly state: 'finished' }
  | { readonly state: 'running'; readonly reason: string }
  | { readonly state: 'lost'; readonly reason: string }
  | { readonly state: 'unknown'; readonly reason: string };

export function observeLaunch(
  run: RunDir,
  probeLock: () => LockProbe,
  probe: IdentityProbe = HOST_PROBE,
): LaunchState {
  const marker = readLaunchMarker(run);
  if (marker.state === 'missing') return { state: 'not_launched' };
  if (marker.state === 'valid' && marker.value.fence === true) return { state: 'not_launched' };
  if (marker.state === 'invalid')
    return {
      state: 'unknown',
      reason: `launch marker invalid: ${marker.reason}`,
    };
  const exit = run.readFinal(RUN_FILES.exit);
  if (exit.state === 'valid') return { state: 'finished' };
  const lockState = probeLock();
  const pid = run.readFinal(RUN_FILES.pid, PidRecordSchema);
  if (pid.state === 'valid') {
    if (pid.value.launch_nonce !== marker.value.launch_nonce)
      return {
        state: 'unknown',
        reason: 'pid receipt nonce differs from launch marker',
      };
    const check = checkIdentity(toProcessIdentity(pid.value), probe);
    if (check === 'alive') return { state: 'running', reason: 'pid and start ticks match' };
    if (check === 'unknown') return { state: 'unknown', reason: 'process identity unreadable' };
    if (lockState === 'held')
      return {
        state: 'running',
        reason: 'harness gone but runner still holds the operation lock',
      };
    if (lockState === 'unknown')
      return {
        state: 'unknown',
        reason: 'harness gone and lock state unknown',
      };
    return {
      state: 'lost',
      reason:
        check === 'other_boot' ? 'recorded on another boot' : 'process identity no longer present',
    };
  }
  if (lockState === 'held')
    return {
      state: 'running',
      reason: 'runner holds the operation lock; no pid receipt yet',
    };
  if (lockState === 'free')
    return {
      state: 'lost',
      reason: 'launch marker without pid receipt and no runner holds the lock',
    };
  return { state: 'unknown', reason: 'launch marker without pid receipt' };
}
