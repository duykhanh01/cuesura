/**
 * Runner side of one operation (T073, FR-007/009, contracts/execution.md). Runs inside the operation's own transient unit, under the operation's kernel lock held
 * by `flock` (see supervisor.ts), and never touches the store or the engine:
 *
 * 1. reads invocation.json, claims launch.json exactly once (an existing marker means a previous
 *    runner owned the operation: recover, never spawn again) and refuses to start past the durable
 *    deadline;
 * 2. spawns the command as its own process group, records pid.json (boot id, start ticks, unit
 *    invocation/cgroup) and streams stdout records and stderr through the redacting event log;
 * 3. tells liveness from progress: CPU of the whole process tree, process count, output and file
 *    changes are progress (progress.ts); the wall budget is min(monotonic, durable UTC), so sleep and
 *    clock jumps never extend it;
 * 4. stops on deadline, stall, backpressure or SIGTERM: SIGTERM to the tree, `term_grace_ms`, SIGKILL,
 *    then verifies for at most `kill_verify_ms` that the tree is empty. Only processes of this
 *    operation are signalled: its group, descendants identified by (pid, start ticks), and the unit
 *    cgroup only when that cgroup is this operation's own unit;
 * 5. writes exit.json atomically, once.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { err, ok, type Result } from '../shared/result.ts';
import { EventLogWriter, RUN_FILES, type AppendError, type RunDir } from './files.ts';
import { bootId, captureIdentity, ownCgroup, unitName } from './identity.ts';
import { claimLaunch } from './operation-lock.ts';
import {
  assessProgress,
  fileFingerprint,
  initialProgress,
  isStalled,
  PROC,
  processTree,
  remainingMs,
  type ProcReader,
  type ProgressState,
} from './progress.ts';
import { InvocationSpecSchema, type InvocationSpec } from './supervisor.ts';

export const RUN_OUTCOMES = [
  'exited',
  'signaled',
  'timeout',
  'stalled',
  'cancelled',
  'artifact_backpressure',
  'spawn_failed',
] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const RunnerExitSchema = z
  .object({
    schema_version: z.literal(1),
    operation_id: z.string().min(1),
    run_id: z.string().min(1),
    launch_nonce: z.string().min(1),
    outcome: z.enum(RUN_OUTCOMES),
    exit_code: z.number().int().nullable(),
    signal: z.string().nullable(),
    /** False only when the command provably never started (deadline passed, spawn error). */
    spawned: z.boolean(),
    started_at: z.number().int().nonnegative(),
    ended_at: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
    deadline_at: z.number().int().nonnegative().nullable(),
    termination: z
      .object({
        term_sent: z.boolean(),
        kill_sent: z.boolean(),
        tree_empty_verified: z.boolean(),
        scope: z.enum(['unit_cgroup', 'process_tree']),
        killed_after_exit: z.number().int().nonnegative(),
      })
      .strict(),
    progress: z
      .object({
        last_progress_at: z.number().int().nonnegative().nullable(),
        last_reasons: z.array(z.string()),
        samples: z.number().int().nonnegative(),
      })
      .strict(),
    artifacts: z
      .object({
        records: z.number().int().nonnegative(),
        last_seq: z.number().int().nonnegative(),
        truncated_records: z.number().int().nonnegative(),
        /**
         * Output received but not stored once the spool was full or could not be written: counted, never
         * dropped silently (FR-031). Absent in exit records written before it existed.
         */
        dropped_bytes: z.number().int().nonnegative().optional(),
      })
      .strict(),
    error: z.string().nullable(),
  })
  .strict();
export type RunnerExit = z.infer<typeof RunnerExitSchema>;

export type LifecycleClock = {
  /** Wall time (epoch ms) for durable deadlines and record times. */
  readonly now: () => number;
  /** Monotonic ms for elapsed time; does not advance across suspend. */
  readonly monotonic: () => number;
};

export const SYSTEM_CLOCK: LifecycleClock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
};

export type LifecycleDeps = {
  readonly clock?: LifecycleClock;
  readonly proc?: ProcReader;
  /** Progress/deadline sampling period. */
  readonly sample_ms?: number;
  /** Subscribes to the runner's own stop signal; returns an unsubscribe. */
  readonly onStop?: (stop: () => void) => () => void;
  /** Each stored stdout record, for a terminal showing this run; must not throw or block. */
  readonly onRecord?: (data: unknown) => void;
};

export type ExecResult =
  | { readonly state: 'finished'; readonly exit: RunnerExit }
  | { readonly state: 'marker_exists' }
  | { readonly state: 'invalid_spec'; readonly reason: string };

const processStop = (stop: () => void): (() => void) => {
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return () => {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  };
};

/** Whole lines up to `cap` bytes; a longer line is reported once as truncated and skipped to its end. */
class LineSplitter {
  #buf = Buffer.alloc(0);
  #skipping = false;
  readonly cap: number;
  readonly emit: (line: Buffer | null) => void;
  constructor(cap: number, emit: (line: Buffer | null) => void) {
    this.cap = cap;
    this.emit = emit;
  }
  push(chunk: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      const nl = this.#buf.indexOf(0x0a);
      if (nl < 0) {
        if (!this.#skipping && this.#buf.length > this.cap) {
          this.#skipping = true;
          this.emit(null);
        }
        if (this.#skipping) this.#buf = Buffer.alloc(0);
        return;
      }
      const line = this.#buf.subarray(0, nl);
      this.#buf = this.#buf.subarray(nl + 1);
      if (this.#skipping) this.#skipping = false;
      else if (line.length > this.cap) this.emit(null);
      else this.emit(line);
    }
  }
  end(): void {
    if (this.#buf.length > 0 && !this.#skipping)
      this.emit(this.#buf.length > this.cap ? null : this.#buf);
    this.#buf = Buffer.alloc(0);
  }
}

function signalPid(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/** Every other process of this operation's own unit cgroup; empty when the cgroup is not ours. */
function ownUnitProcesses(operationId: string): number[] | null {
  const cg = ownCgroup();
  if (cg === null || !cg.endsWith(`/${unitName(operationId)}`)) return null;
  try {
    return readFileSync(`/sys/fs/cgroup${cg}/cgroup.procs`, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(Number)
      .filter((p) => p !== process.pid && p !== process.ppid);
  } catch {
    return null;
  }
}

function readSpec(run: RunDir): Result<InvocationSpec, string> {
  const r = run.readFinal(RUN_FILES.invocation, InvocationSpecSchema);
  if (r.state === 'valid') return ok(r.value);
  return err(r.state === 'missing' ? 'invocation.json missing' : r.reason);
}

/**
 * Runs the operation of `run` to its end and writes exit.json. The caller (the unit) already holds
 * the operation lock.
 */
export async function execOperation(run: RunDir, deps: LifecycleDeps = {}): Promise<ExecResult> {
  const clock = deps.clock ?? SYSTEM_CLOCK;
  const proc = deps.proc ?? PROC;
  const sampleMs = deps.sample_ms ?? 1_000;
  // First, so the secrets are gone from disk whatever this run turns out to be.
  const secretEnv = run.takeSecretEnv();
  const specRead = readSpec(run);
  if (!specRead.ok) return { state: 'invalid_spec', reason: specRead.error };
  const spec = specRead.value;
  if (spec.run_id !== run.id || spec.run_dir_kind !== run.kind)
    return { state: 'invalid_spec', reason: 'invocation names another run' };

  const claim = claimLaunch(run, {
    schema_version: 1,
    operation_id: spec.operation_id,
    attempt_id: spec.run_dir_kind === 'runs' ? spec.run_id : null,
    launch_nonce: spec.launch_nonce,
    boot_id: bootId(),
    runner_pid: process.pid,
    at: new Date(clock.now()).toISOString(),
  });
  if (claim.state === 'marker_exists') return { state: 'marker_exists' };

  const startedAt = clock.now();
  const startMono = clock.monotonic();
  const log = EventLogWriter.open(run, spec.operation_id, {
    now: () => new Date(clock.now()),
  });
  let records = 0;
  let truncated = 0;
  let dropped = 0;
  /** First event log write error (disk full, I/O): the run is stopped as `artifact_backpressure`. */
  let storageError: string | null = null;
  let stopReason: RunOutcome | null = null;
  let termSent = false;
  let killSent = false;
  let samples = 0;
  let progress: ProgressState | null = null;
  let progressAt: number | null = null;
  const known = new Map<number, number>();

  const finish = (
    outcome: RunOutcome,
    o: {
      code?: number | null;
      signal?: string | null;
      spawned: boolean;
      verified?: boolean;
      scope?: 'unit_cgroup' | 'process_tree';
      killed?: number;
      error?: string | null;
    },
  ): ExecResult => {
    try {
      log.flushStderr();
      log.sync();
    } catch {
      // A full disk keeps the facts below; exit.json still records the outcome if it can be written.
    }
    dropped += log.pendingStderrBytes;
    log.close();
    const ended = clock.now();
    const exit: RunnerExit = {
      schema_version: 1,
      operation_id: spec.operation_id,
      run_id: spec.run_id,
      launch_nonce: spec.launch_nonce,
      outcome,
      exit_code: o.code ?? null,
      signal: o.signal ?? null,
      spawned: o.spawned,
      started_at: startedAt,
      ended_at: ended,
      duration_ms: Math.max(0, Math.round(clock.monotonic() - startMono)),
      deadline_at: spec.deadline_at,
      termination: {
        term_sent: termSent,
        kill_sent: killSent,
        tree_empty_verified: o.verified ?? !o.spawned,
        scope: o.scope ?? 'process_tree',
        killed_after_exit: o.killed ?? 0,
      },
      progress: {
        last_progress_at: progressAt,
        last_reasons: [...(progress?.last_reasons ?? [])],
        samples,
      },
      artifacts: {
        records,
        last_seq: log.seq,
        truncated_records: truncated,
        dropped_bytes: dropped,
      },
      error:
        (o.error ?? storageError) === null
          ? null
          : run.redactor.text((o.error ?? storageError) as string),
    };
    run.writeExit(RunnerExitSchema.parse(exit));
    return { state: 'finished', exit };
  };

  if (
    remainingMs({
      start_mono: startMono,
      now_mono: startMono,
      wall_ms: spec.wall_ms,
      now_utc: startedAt,
      deadline_at: spec.deadline_at,
    }) === 0
  )
    return finish('timeout', {
      spawned: false,
      error: 'deadline passed before start',
    });

  if (spec.secret_env === true && secretEnv === null)
    return finish('spawn_failed', { spawned: false, error: 'secret environment missing' });

  let stdinFd: number | null = null;
  let child: ChildProcess;
  try {
    if (spec.stdin !== null && spec.stdin !== undefined)
      stdinFd = openSync(run.resolve(spec.stdin), 'r');
    child = spawn(spec.argv[0] as string, spec.argv.slice(1), {
      cwd: spec.cwd,
      env: { ...spec.env, ...secretEnv },
      stdio: [stdinFd ?? 'ignore', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (e) {
    if (stdinFd !== null) closeSync(stdinFd);
    return finish('spawn_failed', {
      spawned: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  const spawned = await new Promise<{ ok: true } | { ok: false; error: string }>((res) => {
    child.once('spawn', () => res({ ok: true }));
    child.once('error', (e) => res({ ok: false, error: e.message }));
  });
  if (stdinFd !== null) closeSync(stdinFd);
  if (!spawned.ok || child.pid === undefined)
    return finish('spawn_failed', {
      spawned: false,
      error: spawned.ok ? 'no pid' : spawned.error,
    });
  const pid = child.pid;
  const identity = captureIdentity(pid, spec);
  if (identity !== null) {
    known.set(pid, identity.start_ticks);
    try {
      run.writeJson(RUN_FILES.pid, identity);
    } catch (e) {
      // Without a PID receipt nobody can adopt the tree later: it is stopped below, while this runner
      // still knows it.
      storageError = `pid receipt write failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** The event log cannot be written (disk full, I/O error): stop the operation, keep what is stored. */
  function storageFailed(e: unknown): void {
    storageError ??= `event log write failed: ${e instanceof Error ? e.message : String(e)}`;
    terminate('artifact_backpressure');
  }
  /** Output no longer stored is counted, so a stopped run never looks complete. */
  const storing = (bytes: number): boolean => {
    if (stopReason !== 'artifact_backpressure') return true;
    dropped += bytes;
    return false;
  };
  const append = (kind: string, data: unknown, bytes: number): boolean => {
    let r: Result<unknown, AppendError>;
    try {
      r = log.append(kind, data);
    } catch (e) {
      dropped += bytes;
      storageFailed(e);
      return false;
    }
    if (r.ok) return true;
    if (r.error.code === 'artifact_backpressure') {
      dropped += bytes;
      terminate('artifact_backpressure');
    } else truncated++;
    return false;
  };
  const stdout = new LineSplitter(run.limits.log_record_bytes - 4096, (line) => {
    if (!storing(line?.length ?? 0)) return;
    if (line === null) {
      truncated++;
      append('stdout.truncated', { reason: 'record over cap' }, 0);
      return;
    }
    const text = line.toString('utf8');
    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = { text };
    }
    if (append('stdout', data, line.length)) {
      records++;
      deps.onRecord?.(data);
    }
  });
  // Both streams are buffered into whole lines, so log.seq misses output that has not ended a line
  // yet; every chunk received counts as progress.
  let outputChunks = 0;
  child.stdout?.on('data', (b: Buffer) => {
    outputChunks++;
    stdout.push(b);
  });
  child.stderr?.on('data', (b: Buffer) => {
    outputChunks++;
    if (!storing(b.length)) return;
    try {
      // On backpressure the text stays buffered in the writer and is counted when the run ends.
      if (!log.appendStderr(b).ok) terminate('artifact_backpressure');
    } catch (e) {
      dropped += b.length;
      storageFailed(e);
    }
  });

  const tree = (): number[] => {
    const t = processTree(pid, proc) ?? [];
    for (const s of t) if (!known.has(s.pid)) known.set(s.pid, s.start_ticks);
    return t.map((s) => s.pid);
  };
  /** Signals the group and every known descendant whose start ticks still match. */
  const signalTree = (sig: NodeJS.Signals): boolean => {
    let sent = signalPid(-pid, sig);
    tree();
    for (const [p, ticks] of known) {
      const t = proc.stat(p);
      const now = t === null ? null : t.slice(t.lastIndexOf(')') + 2).split(' ')[19];
      if (now !== undefined && now !== null && Number(now) === ticks)
        sent = signalPid(p, sig) || sent;
    }
    return sent;
  };
  const alive = (): number[] => {
    const out: number[] = [];
    for (const [p, ticks] of known) {
      const t = proc.stat(p);
      if (t === null) continue;
      const f = t.slice(t.lastIndexOf(')') + 2).split(' ');
      // A zombie has finished; it holds no resources the operation could still use.
      if (f[0] !== 'Z' && Number(f[19]) === ticks) out.push(p);
    }
    return out;
  };
  let killTimer: NodeJS.Timeout | null = null;
  function terminate(reason: RunOutcome): void {
    if (stopReason !== null) return;
    stopReason = reason;
    termSent = signalTree('SIGTERM') || termSent;
    killTimer = setTimeout(() => {
      if (alive().length > 0) killSent = signalTree('SIGKILL') || killSent;
    }, spec.term_grace_ms);
  }

  const watch = spec.watch ?? [];
  const sample = (): void => {
    const t = processTree(pid, proc);
    for (const s of t ?? []) if (!known.has(s.pid)) known.set(s.pid, s.start_ticks);
    const now = clock.monotonic();
    const s = {
      cpu_ticks: t === null ? null : t.reduce((a, x) => a + x.cpu_ticks, 0),
      processes: t?.length ?? 0,
      output_seq: log.seq + outputChunks,
      files: fileFingerprint(watch),
    };
    samples++;
    const prev = progress;
    progress = prev === null ? initialProgress(s, now) : assessProgress(prev, s, now);
    if (prev === null || progress.last_progress_mono !== prev.last_progress_mono)
      progressAt = clock.now();
    try {
      run.writeJson(RUN_FILES.progress, {
        last_progress_at: progressAt,
        last_reasons: progress.last_reasons,
        cpu_ticks: s.cpu_ticks,
        processes: s.processes,
        output_seq: s.output_seq,
      });
      run.writeLiveness(new Date(clock.now()));
    } catch {
      // Liveness/progress are diagnostics; the deadline and the exit record do not depend on them.
    }
    if (
      remainingMs({
        start_mono: startMono,
        now_mono: now,
        wall_ms: spec.wall_ms,
        now_utc: clock.now(),
        deadline_at: spec.deadline_at,
      }) === 0
    )
      terminate('timeout');
    else if (
      spec.stall_ms !== null &&
      spec.stall_ms !== undefined &&
      isStalled(progress, now, spec.stall_ms)
    )
      terminate('stalled');
  };
  if (storageError !== null) terminate('artifact_backpressure');
  sample();
  const sampler = setInterval(sample, sampleMs);
  const unsubscribe = (deps.onStop ?? processStop)(() => terminate('cancelled'));

  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) =>
    child.once('exit', (c, s) => res([c, s])),
  );
  clearInterval(sampler);
  unsubscribe();
  // The leader is gone; anything left of its tree is part of this operation and is stopped too.
  let killedAfter = 0;
  if (alive().length > 0) {
    const left = alive().length;
    termSent = signalTree('SIGTERM') || termSent;
    const until = clock.monotonic() + Math.min(spec.term_grace_ms, 1_000);
    while (alive().length > 0 && clock.monotonic() < until) await sleep(25);
    if (alive().length > 0) killSent = signalTree('SIGKILL') || killSent;
    killedAfter = left;
  }
  if (killTimer !== null) clearTimeout(killTimer);
  let verified = alive().length === 0;
  for (
    const until = clock.monotonic() + spec.kill_verify_ms;
    !verified && clock.monotonic() < until;
  ) {
    await sleep(25);
    verified = alive().length === 0;
  }
  let scope: 'unit_cgroup' | 'process_tree' = 'process_tree';
  const unitProcs = ownUnitProcesses(spec.operation_id);
  if (unitProcs !== null) {
    scope = 'unit_cgroup';
    for (const p of unitProcs) if (signalPid(p, 'SIGKILL')) killedAfter++;
  }
  // stdio may stay open in an escaped descendant; do not wait for it indefinitely.
  await Promise.race([
    new Promise<void>((r) =>
      (child.stdout?.readableEnded ?? true) ? r() : child.stdout?.once('end', () => r()),
    ),
    sleep(500),
  ]);
  stdout.end();
  const outcome: RunOutcome = stopReason ?? (signal !== null ? 'signaled' : 'exited');
  return finish(outcome, {
    code,
    signal,
    spawned: true,
    verified,
    scope,
    killed: killedAfter,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
