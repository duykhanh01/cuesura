/**
 * Spike 0 runner prototype (T004, contracts/execution.md "Operation và runner ownership", "Files và output").
 *
 *   node scripts/spike-002/runner.ts systemd-argv --spec FILE --root DIR   print unit argv only
 *   node scripts/spike-002/runner.ts start --spec FILE --root DIR [--systemd]
 *   node scripts/spike-002/runner.ts exec  --spec FILE --root DIR          (normally under flock)
 *   node scripts/spike-002/runner.ts receipt --root DIR --kind runs|operations --id ID
 *   node scripts/spike-002/runner.ts status|stop --operation-id ID       systemctl --user query/stop
 *
 * No daemon/store: the runner never writes a DB and never decides retry. Usage is always recorded as
 * `unavailable` here; a harness adapter may fill it from vendor output.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { hashCanonical } from '../../src/shared/hash.ts';

const KiB = 1024;
const MiB = 1024 * KiB;

export const DEFAULT_LIMITS = {
  record_bytes: 256 * KiB,
  result_bytes: 1 * MiB,
  segment_bytes: 8 * MiB,
  spool_bytes: 64 * MiB,
  term_grace_ms: 10_000,
  kill_verify_ms: 5_000,
  liveness_ms: 5_000,
} as const;
export type Limits = { -readonly [K in keyof typeof DEFAULT_LIMITS]: number };

export const SafeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).refine((s) => !s.includes('..'));

const LimitsSchema = z
  .strictObject({
    record_bytes: z.number().int().positive(),
    result_bytes: z.number().int().positive(),
    segment_bytes: z.number().int().positive(),
    spool_bytes: z.number().int().positive(),
    term_grace_ms: z.number().int().nonnegative(),
    kill_verify_ms: z.number().int().positive(),
    liveness_ms: z.number().int().positive(),
  })
  .partial();

export const RunSpecSchema = z.strictObject({
  schema_version: z.literal(1),
  kind: z.enum(['runs', 'operations']),
  operation_id: SafeIdSchema,
  attempt_id: SafeIdSchema.nullable(),
  command: z.array(z.string()).min(1),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
  stdin_file: z.string().nullable(),
  deadline_ms: z.number().int().positive().max(24 * 3_600_000),
  /** Files whose secret values (e.g. selected model auth) must never reach logs. Values are read, not stored. */
  redact_files: z.array(z.string()),
  /** Opaque binding/hashes recorded in invocation.json after redaction. */
  binding: z.record(z.string(), z.unknown()).nullable(),
  limits: LimitsSchema,
});
export type RunSpec = z.infer<typeof RunSpecSchema>;

export class RunnerError extends Error {
  override name = 'RunnerError';
}

// --- redaction ---------------------------------------------------------------------------------

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /([?&]token=)[^&\s"'<>\\#]+/gi,
  /(\b(?:authorization|proxy-authorization)\s*:\s*)(?:bearer|token|basic)\s+[^\s"',]+/gi,
  /(\b(?:access_token|refresh_token|id_token|api_key|apikey|client_secret|password)"?\s*[:=]\s*"?)[^"\s,}]{8,}/gi,
];

export class Redactor {
  readonly #values: readonly string[];

  constructor(values: readonly string[] = []) {
    this.#values = [...new Set(values.filter((v) => v.length >= 8))].sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let out = text;
    for (const v of this.#values) out = out.split(v).join('[REDACTED]');
    for (const p of SECRET_PATTERNS) {
      out = out.replace(p, (_m, prefix?: unknown) => `${typeof prefix === 'string' ? prefix : ''}[REDACTED]`);
    }
    return out;
  }
}

/** Secret values inside an auth file: JSON string leaves >= 12 chars, else non-trivial lines. */
export function secretValuesFromFile(path: string): string[] {
  const text = readFileSync(path, 'utf8');
  const values: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.length >= 12) values.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walk);
  };
  try {
    walk(JSON.parse(text));
  } catch {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t.length >= 12) values.push(t, ...t.split('=').slice(1).filter((x) => x.length >= 12));
    }
  }
  return values;
}

// --- files ------------------------------------------------------------------------------------

function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeTemp(dir: string, name: string, data: string): string {
  const tmp = join(dir, `.${name}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return tmp;
}

/** temp → fsync → rename → fsync directory. */
export function writeAtomic(dir: string, name: string, data: string): void {
  renameSync(writeTemp(dir, name, data), join(dir, name));
  fsyncDir(dir);
}

/** Like writeAtomic but fails with EEXIST instead of replacing: the launch marker is written once. */
export function createOnce(dir: string, name: string, data: string): boolean {
  const tmp = writeTemp(dir, name, data);
  try {
    linkSync(tmp, join(dir, name));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    unlinkSync(tmp);
    fsyncDir(dir);
  }
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

/** Run directory under DATA_DIR/{runs|operations}/ID; rejects symlinks anywhere below the root. */
export function prepareRunDir(root: string, kind: RunSpec['kind'], id: string): string {
  if (!isAbsolute(root)) throw new RunnerError(`root ${root} must be absolute`);
  if (!SafeIdSchema.safeParse(id).success) throw new RunnerError(`unsafe id ${id}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = realpathSync(root);
  let dir = realRoot;
  for (const part of [kind, id]) {
    dir = join(dir, part);
    if (existsSync(dir)) {
      if (!lstatSync(dir).isDirectory()) throw new RunnerError(`${dir} is not a plain directory`);
    } else mkdirSync(dir, { mode: 0o700 });
  }
  if (realpathSync(dir) !== dir || !within(dir, realRoot)) throw new RunnerError(`${dir} escapes ${realRoot}`);
  for (const sub of ['out', 'spool']) {
    const p = join(dir, sub);
    if (existsSync(p) && !lstatSync(p).isDirectory()) throw new RunnerError(`${p} is not a plain directory`);
    mkdirSync(p, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/** Resolves a relative artifact path inside `dir`, refusing traversal and symlinked components. */
export function artifactPath(dir: string, rel: string): string {
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || rel === '') throw new RunnerError(`bad artifact path ${rel}`);
  const full = join(dir, rel);
  let p = dir;
  for (const part of rel.split('/')) {
    p = join(p, part);
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new RunnerError(`symlink in artifact path ${rel}`);
  }
  return full;
}

// --- process identity ---------------------------------------------------------------------------

export function bootId(): string {
  return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
}

/** Field 22 of /proc/PID/stat (start time in clock ticks); null if the process is gone. */
export function startTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function ownCgroup(): string | null {
  try {
    const line = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'));
    return line === undefined ? null : line.slice(3);
  } catch {
    return null;
  }
}

export function unitName(operationId: string): string {
  return `cusr-op-${operationId}.service`;
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Kills every other process in our cgroup, but only when that cgroup is this operation's own unit. */
function sweepOwnUnitCgroup(operationId: string): { scope: 'unit_cgroup' | 'process_group_only'; killed: number } {
  const cg = ownCgroup();
  if (cg === null || !cg.endsWith(`/${unitName(operationId)}`)) return { scope: 'process_group_only', killed: 0 };
  let killed = 0;
  try {
    const procs = readFileSync(`/sys/fs/cgroup${cg}/cgroup.procs`, 'utf8').split('\n').filter(Boolean).map(Number);
    for (const pid of procs) {
      if (pid === process.pid || pid === process.ppid) continue;
      try {
        process.kill(pid, 'SIGKILL');
        killed++;
      } catch {
        // already gone
      }
    }
  } catch {
    return { scope: 'process_group_only', killed };
  }
  return { scope: 'unit_cgroup', killed };
}

// --- exec ---------------------------------------------------------------------------------------

export type Outcome = 'exited' | 'signaled' | 'timeout' | 'cancelled' | 'artifact_backpressure' | 'spawn_failed';

export type ExitRecord = {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly attempt_id: string | null;
  readonly launch_nonce: string;
  readonly outcome: Outcome;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly started_at: string;
  readonly ended_at: string;
  readonly duration_ms: number;
  readonly termination: {
    readonly term_sent: boolean;
    readonly kill_sent: boolean;
    readonly group_empty_verified: boolean;
    readonly descendant_scope: 'unit_cgroup' | 'process_group_only';
    readonly descendants_killed: number;
  };
  readonly usage: { readonly status: 'unavailable'; readonly reason: string };
  readonly artifacts: {
    readonly events: { readonly records: number; readonly bytes: number; readonly generations: number; readonly truncated_records: number };
    readonly stderr: { readonly bytes: number; readonly digest: string };
  };
  readonly error: string | null;
};

export type ExecResult = { readonly status: 'finished'; readonly exit: ExitRecord } | { readonly status: 'marker_exists'; readonly dir: string };

function redactSpec(spec: RunSpec, r: Redactor): unknown {
  return JSON.parse(r.redact(JSON.stringify({ ...spec, redact_files: spec.redact_files.map(() => '[path]') }))) as unknown;
}

class EventLog {
  records = 0;
  bytes = 0;
  generation = 0;
  truncated = 0;
  seq = 0;
  readonly #dir: string;
  readonly #spec: RunSpec;
  readonly #limits: Limits;

  constructor(dir: string, spec: RunSpec, limits: Limits) {
    this.#dir = dir;
    this.#spec = spec;
    this.#limits = limits;
  }

  /** Returns false when the spool cap would be exceeded (caller stops the operation). */
  append(kind: string, text: string, truncated: boolean, spoolUsed: () => number): boolean {
    let data: unknown = text;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      // keep as string
    }
    const render = (): string => {
      const base = { schema_version: 1, operation_id: this.#spec.operation_id, generation: this.generation, seq: this.seq, at: new Date().toISOString(), kind };
      const full = `${JSON.stringify({ ...base, data, ...(truncated ? { truncated: true } : {}) })}\n`;
      if (Buffer.byteLength(full) <= this.#limits.record_bytes) return full;
      truncated = true;
      const room = Math.max(0, this.#limits.record_bytes - 512);
      const cut = `${JSON.stringify({ ...base, data: Buffer.from(text).subarray(0, room).toString('utf8'), truncated: true })}\n`;
      return Buffer.byteLength(cut) <= this.#limits.record_bytes ? cut : `${JSON.stringify({ ...base, data: '', truncated: true })}\n`;
    };
    let line = render();
    const size = Buffer.byteLength(line);
    if (spoolUsed() + size > this.#limits.spool_bytes) return false;
    const path = join(this.#dir, 'events.jsonl');
    if (existsSync(path) && statSync(path).size + size > this.#limits.segment_bytes) {
      renameSync(path, join(this.#dir, 'spool', `events.${String(this.generation).padStart(6, '0')}.jsonl`));
      fsyncDir(join(this.#dir, 'spool'));
      fsyncDir(this.#dir);
      this.generation++;
      line = render();
    }
    appendFileSync(path, line, { mode: 0o600 });
    this.seq++;
    this.records++;
    this.bytes += size;
    if (truncated) this.truncated++;
    return true;
  }
}

/** Splits a byte stream into lines capped at `max` bytes; oversize lines are truncated, not split. */
class LineSplitter {
  #pending = Buffer.alloc(0);
  #discarding = false;
  readonly #max: number;
  readonly #emit: (line: Buffer, truncated: boolean) => void;

  constructor(max: number, emit: (line: Buffer, truncated: boolean) => void) {
    this.#max = max;
    this.#emit = emit;
  }

  push(chunk: Buffer): void {
    let buf = Buffer.concat([this.#pending, chunk]);
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) break;
      if (!this.#discarding) this.#emit(buf.subarray(0, nl), false);
      this.#discarding = false;
      buf = buf.subarray(nl + 1);
    }
    if (buf.length > this.#max && !this.#discarding) {
      this.#emit(buf.subarray(0, this.#max), true);
      this.#discarding = true;
    }
    this.#pending = this.#discarding ? Buffer.alloc(0) : buf;
  }

  /** Partial final line after process death is kept and marked truncated. */
  end(): void {
    if (this.#pending.length > 0 && !this.#discarding) this.#emit(this.#pending, true);
    this.#pending = Buffer.alloc(0);
  }
}

export function resolveLimits(spec: RunSpec): Limits {
  const l: Limits = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(spec.limits)) if (v !== undefined) l[k as keyof Limits] = v;
  if (l.segment_bytes > l.spool_bytes) throw new RunnerError('segment_bytes must not exceed spool_bytes');
  if (l.record_bytes > l.segment_bytes) throw new RunnerError('record_bytes must not exceed segment_bytes');
  return l;
}

const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|CREDENTIAL|PRIVATE_KEY)/i;

export function parseSpec(raw: unknown): RunSpec {
  const spec = RunSpecSchema.parse(raw);
  for (const key of Object.keys(spec.env)) {
    if (SECRET_ENV.test(key) || /^(GH_|GITHUB_|SSH_AUTH_SOCK$)/.test(key)) {
      throw new RunnerError(`env ${key}: secrets are not passed through the run spec`);
    }
  }
  if (!isAbsolute(spec.cwd)) throw new RunnerError('cwd must be absolute');
  if (spec.kind === 'runs' && spec.attempt_id === null) throw new RunnerError('runs/ requires attempt_id');
  return spec;
}

/**
 * Runs one operation to completion. Writes launch.json (exclusive, before spawn), invocation.json,
 * pid.json, events.jsonl/stderr.log (redacted, bounded), liveness/progress.json and exit.json.
 */
export async function execOperation(rawSpec: unknown, root: string): Promise<ExecResult> {
  const spec = parseSpec(rawSpec);
  const limits = resolveLimits(spec);
  const id = spec.kind === 'runs' ? (spec.attempt_id as string) : spec.operation_id;
  const dir = prepareRunDir(root, spec.kind, id);
  const redactor = new Redactor(spec.redact_files.flatMap((f) => secretValuesFromFile(f)));
  const nonce = randomBytes(16).toString('hex');
  const startedAt = new Date();
  const deadlineUtc = new Date(startedAt.getTime() + spec.deadline_ms).toISOString();

  const marker = { schema_version: 1, operation_id: spec.operation_id, attempt_id: spec.attempt_id, nonce, at: startedAt.toISOString(), runner_pid: process.pid };
  if (!createOnce(dir, 'launch.json', `${JSON.stringify(marker)}\n`)) return { status: 'marker_exists', dir };

  writeAtomic(
    dir,
    'invocation.json',
    `${JSON.stringify({
      schema_version: 1,
      spec: redactSpec(spec, redactor),
      spec_digest: hashCanonical(spec),
      limits,
      deadline_utc: deadlineUtc,
      launch_nonce: nonce,
      artifacts: ['events.jsonl', 'stderr.log', 'liveness', 'progress.json', 'exit.json', 'out/', 'spool/'],
    })}\n`,
  );

  const t0 = performance.now();
  const log = new EventLog(dir, spec, limits);
  let stderrBytes = 0;
  const stderrPath = join(dir, 'stderr.log');
  const spoolUsed = (): number => log.bytes + stderrBytes;
  let stopReason: Outcome | null = null;
  let termSent = false;
  let killSent = false;
  let lastOutputAt: string | null = null;

  const writeProgress = (): void => {
    writeAtomic(dir, 'progress.json', `${JSON.stringify({ last_output_at: lastOutputAt, records: log.records, stderr_bytes: stderrBytes })}\n`);
  };
  writeAtomic(dir, 'liveness', `${new Date().toISOString()}\n`);
  const liveness = setInterval(() => writeAtomic(dir, 'liveness', `${new Date().toISOString()}\n`), limits.liveness_ms);

  let child: ChildProcess;
  try {
    child = spawn(spec.command[0] as string, spec.command.slice(1), {
      cwd: spec.cwd,
      env: { ...spec.env, CUSR_OPERATION_ID: spec.operation_id, ...(spec.attempt_id !== null ? { CUSR_ATTEMPT_ID: spec.attempt_id } : {}) },
      stdio: [spec.stdin_file !== null ? openSync(spec.stdin_file, 'r') : 'ignore', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (e) {
    clearInterval(liveness);
    return finish(null, null, 'spawn_failed', e instanceof Error ? e.message : String(e), { scope: 'process_group_only', killed: 0 }, false);
  }

  const terminate = (reason: Outcome): void => {
    if (stopReason !== null || child.pid === undefined) return;
    stopReason = reason;
    const pgid = child.pid;
    termSent = signalGroup(pgid, 'SIGTERM');
    setTimeout(() => {
      if (groupAlive(pgid)) killSent = signalGroup(pgid, 'SIGKILL');
    }, limits.term_grace_ms).unref();
  };

  const stdoutLines = new LineSplitter(limits.record_bytes, (line, truncated) => {
    lastOutputAt = new Date().toISOString();
    if (stopReason === 'artifact_backpressure') return;
    if (!log.append('stdout', redactor.redact(line.toString('utf8')), truncated, spoolUsed)) terminate('artifact_backpressure');
  });
  const stderrLines = new LineSplitter(limits.record_bytes, (line, truncated) => {
    if (stopReason === 'artifact_backpressure') return;
    const text = `${redactor.redact(line.toString('utf8'))}${truncated ? ' [truncated]' : ''}\n`;
    const size = Buffer.byteLength(text);
    if (spoolUsed() + size > limits.spool_bytes || stderrBytes + size > limits.segment_bytes) {
      terminate('artifact_backpressure');
      return;
    }
    appendFileSync(stderrPath, text, { mode: 0o600 });
    stderrBytes += size;
  });
  let progressTimer: NodeJS.Timeout | null = null;
  const onOutput = (): void => {
    progressTimer ??= setTimeout(() => {
      progressTimer = null;
      writeProgress();
    }, 1_000);
  };
  child.stdout?.on('data', (b: Buffer) => {
    stdoutLines.push(b);
    onOutput();
  });
  child.stderr?.on('data', (b: Buffer) => {
    stderrLines.push(b);
    onOutput();
  });

  const closed = new Promise<void>((res) => child.once('close', () => res()));
  const spawned = await new Promise<{ ok: true } | { ok: false; error: string }>((res) => {
    child.once('spawn', () => res({ ok: true }));
    child.once('error', (e) => res({ ok: false, error: e.message }));
  });
  if (!spawned.ok || child.pid === undefined) {
    clearInterval(liveness);
    return finish(null, null, 'spawn_failed', spawned.ok ? 'no pid' : spawned.error, { scope: 'process_group_only', killed: 0 }, false);
  }
  const pid = child.pid;
  writeAtomic(
    dir,
    'pid.json',
    `${JSON.stringify({
      schema_version: 1,
      pid,
      pgid: pid,
      start_ticks: startTicks(pid),
      boot_id: bootId(),
      runner_pid: process.pid,
      runner_start_ticks: startTicks(process.pid),
      invocation_id: process.env['INVOCATION_ID'] ?? null,
      cgroup: ownCgroup(),
      launch_nonce: nonce,
    })}\n`,
  );

  const deadline = setTimeout(() => terminate('timeout'), spec.deadline_ms);
  const onSignal = (): void => terminate('cancelled');
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => child.once('exit', (c, s) => res([c, s])));
  clearTimeout(deadline);
  // The leader is gone; anything left in its group is part of this operation and is stopped too.
  if (groupAlive(pid)) {
    termSent = signalGroup(pid, 'SIGTERM') || termSent;
    await sleep(Math.min(limits.term_grace_ms, 1_000));
    if (groupAlive(pid)) killSent = signalGroup(pid, 'SIGKILL') || killSent;
  }
  let verified = !groupAlive(pid);
  for (const until = performance.now() + limits.kill_verify_ms; !verified && performance.now() < until; ) {
    await sleep(50);
    verified = !groupAlive(pid);
  }
  // stdio may stay open in an escaped descendant; do not wait for it indefinitely.
  await Promise.race([closed, sleep(1_000)]);
  stdoutLines.end();
  stderrLines.end();
  const sweep = sweepOwnUnitCgroup(spec.operation_id);
  process.removeListener('SIGTERM', onSignal);
  process.removeListener('SIGINT', onSignal);
  clearInterval(liveness);
  if (progressTimer !== null) clearTimeout(progressTimer);
  writeProgress();
  const outcome: Outcome = stopReason ?? (signal !== null ? 'signaled' : 'exited');
  return finish(code, signal, outcome, null, sweep, verified);

  function finish(
    exitCode: number | null,
    sig: NodeJS.Signals | null,
    outcome: Outcome,
    error: string | null,
    sweep: { scope: 'unit_cgroup' | 'process_group_only'; killed: number },
    verified: boolean,
  ): ExecResult {
    const stderrText = existsSync(stderrPath) ? readFileSync(stderrPath) : Buffer.alloc(0);
    const exit: ExitRecord = {
      schema_version: 1,
      operation_id: spec.operation_id,
      attempt_id: spec.attempt_id,
      launch_nonce: nonce,
      outcome,
      exit_code: exitCode,
      signal: sig,
      started_at: startedAt.toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: Math.round(performance.now() - t0),
      termination: { term_sent: termSent, kill_sent: killSent, group_empty_verified: verified, descendant_scope: sweep.scope, descendants_killed: sweep.killed },
      usage: { status: 'unavailable', reason: 'runner does not parse harness usage' },
      artifacts: {
        events: { records: log.records, bytes: log.bytes, generations: log.generation + 1, truncated_records: log.truncated },
        stderr: { bytes: stderrBytes, digest: `sha256:${sha256(stderrText)}` },
      },
      error: error === null ? null : redactor.redact(error),
    };
    writeAtomic(dir, 'exit.json', `${JSON.stringify(exit)}\n`);
    return { status: 'finished', exit };
  }
}

function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// --- receipt ------------------------------------------------------------------------------------

export type Receipt = {
  readonly state: 'not_launched' | 'unknown' | 'running' | 'lost' | 'finished';
  readonly reason: string;
  readonly exit: ExitRecord | null;
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/**
 * Projection from files + live identity. Never says "safe to respawn": a marker without exit is
 * running (identity matches), lost (identity gone) or unknown (no pid receipt).
 */
export function readReceipt(dir: string): Receipt {
  if (!existsSync(join(dir, 'launch.json'))) return { state: 'not_launched', reason: 'no launch marker', exit: null };
  if (existsSync(join(dir, 'exit.json'))) return { state: 'finished', reason: 'exit.json present', exit: readJson(join(dir, 'exit.json')) as ExitRecord };
  if (!existsSync(join(dir, 'pid.json'))) return { state: 'unknown', reason: 'launch marker without pid receipt', exit: null };
  const pid = readJson(join(dir, 'pid.json')) as { pid: number; start_ticks: string | null; boot_id: string };
  if (pid.boot_id !== bootId()) return { state: 'lost', reason: 'different boot', exit: null };
  if (pid.start_ticks !== null && startTicks(pid.pid) === pid.start_ticks) return { state: 'running', reason: 'pid and start ticks match', exit: null };
  return { state: 'lost', reason: 'process identity no longer present', exit: null };
}

// --- systemd ------------------------------------------------------------------------------------

const RUNNER = fileURLToPath(import.meta.url);

export function lockPath(root: string, operationId: string): string {
  return join(root, 'locks', `${operationId}.lock`);
}

/** flock-wrapped runner argv; flock exits 75 if another runner holds the operation lock. */
export function flockArgv(specFile: string, root: string, operationId: string): string[] {
  return ['/usr/bin/flock', '--exclusive', '--nonblock', '--conflict-exit-code', '75', lockPath(root, operationId), process.execPath, RUNNER, 'exec', '--spec', specFile, '--root', root];
}

/**
 * Transient user service, not bound to the daemon, no restart, whole cgroup stopped; no --collect.
 * KillMode=control-group signals every process on stop, so flock (the main process) ignores SIGTERM
 * and keeps the unit alive while the runner stops the harness group and finalises exit.json; the
 * runner's own handler replaces the inherited ignore, and spawned children get default dispositions.
 */
export function systemdRunArgv(specFile: string, root: string, operationId: string): string[] {
  return [
    '/usr/bin/systemd-run',
    '--user',
    `--unit=${unitName(operationId)}`,
    '--property=Restart=no',
    '--property=KillMode=control-group',
    '--property=TimeoutStopSec=15s',
    '--property=SendSIGKILL=yes',
    '--quiet',
    '--',
    '/bin/sh',
    '-c',
    'trap "" TERM; exec "$@"',
    'sh',
    ...flockArgv(specFile, root, operationId),
  ];
}

function systemctl(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('/usr/bin/systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function unitStatus(operationId: string): Record<string, string> {
  const r = systemctl(['show', unitName(operationId), '-p', 'LoadState,ActiveState,SubState,Result,InvocationID,ControlGroup,MainPID']);
  return Object.fromEntries(r.stdout.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

export function stopUnit(operationId: string): number | null {
  return systemctl(['stop', unitName(operationId)]).status;
}

function main(argv: readonly string[]): Promise<number> | number {
  const [cmd, ...rest] = argv;
  const opt = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const out = (v: unknown): void => void process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
  const root = opt('--root');
  const specFile = opt('--spec');
  switch (cmd) {
    case 'exec': {
      if (root === undefined || specFile === undefined) return usage();
      return execOperation(readJson(resolve(specFile)), resolve(root)).then((r) => {
        out(r);
        if (r.status === 'marker_exists') return 3;
        return r.exit.outcome === 'exited' && r.exit.exit_code === 0 ? 0 : 1;
      });
    }
    case 'systemd-argv':
    case 'start': {
      if (root === undefined || specFile === undefined) return usage();
      const spec = parseSpec(readJson(resolve(specFile)));
      const absRoot = resolve(root);
      mkdirSync(dirname(lockPath(absRoot, spec.operation_id)), { recursive: true, mode: 0o700 });
      const useSystemd = cmd === 'systemd-argv' || rest.includes('--systemd');
      const full = useSystemd ? systemdRunArgv(resolve(specFile), absRoot, spec.operation_id) : flockArgv(resolve(specFile), absRoot, spec.operation_id);
      if (cmd === 'systemd-argv') {
        out({ unit: unitName(spec.operation_id), argv: full });
        return 0;
      }
      const r = spawnSync(full[0] as string, full.slice(1), { stdio: 'inherit' });
      return r.status ?? 1;
    }
    case 'receipt': {
      const kind = opt('--kind');
      const id = opt('--id');
      if (root === undefined || (kind !== 'runs' && kind !== 'operations') || id === undefined) return usage();
      out(readReceipt(artifactPath(realpathSync(resolve(root)), `${kind}/${id}`)));
      return 0;
    }
    case 'status':
    case 'stop': {
      const op = opt('--operation-id');
      if (op === undefined || !SafeIdSchema.safeParse(op).success) return usage();
      if (cmd === 'status') out(unitStatus(op));
      else out({ unit: unitName(op), exit: stopUnit(op) });
      return 0;
    }
    default:
      return usage();
  }
}

function usage(): number {
  process.stderr.write(
    'usage: runner.ts systemd-argv|start|exec --spec FILE --root DIR [--systemd] | receipt --root DIR --kind runs|operations --id ID | status|stop --operation-id ID\n',
  );
  return 2;
}

export const _internal = { LineSplitter };

if (process.argv[1] !== undefined && resolve(process.argv[1]) === RUNNER) {
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`);
      process.exitCode = e instanceof RunnerError || e instanceof z.ZodError ? 2 : 1;
    });
}
