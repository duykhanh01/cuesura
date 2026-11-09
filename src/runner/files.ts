/**
 * Runner file protocol (contracts/execution.md, research R-11). Promoted from the
 * archived runner protocol fixtures. The runner owns these files; it never touches the store or the engine.
 *
 *   DATA_DIR/runs/<attempt_id>/            DATA_DIR/operations/<operation_id>/
 *   ├── launch.json, invocation.json, pid.json, liveness, progress.json, exit.json, out/result.json
 *   ├── events.jsonl     hard link to the active spool segment
 *   ├── stderr.log
 *   └── spool/events.<generation>.<segment>.jsonl
 *
 * Every write goes through the directory's {@link Redactor}; every path is checked against traversal
 * and symlinks; final files are written temp → fsync → rename → fsync directory.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import {
  DEFAULT_RUNTIME_LIMITS,
  RelativePathSchema,
  type IngestCursor,
  type RuntimeLimits,
} from '../domain/runtime.ts';
import type { Hash } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Redactor } from './redact.ts';

export const LOG_SCHEMA_VERSION = 1;

export const RUN_DIR_KINDS = ['runs', 'operations'] as const;
export type RunDirKind = (typeof RUN_DIR_KINDS)[number];

export const RUN_FILES = {
  launch: 'launch.json',
  invocation: 'invocation.json',
  pid: 'pid.json',
  events: 'events.jsonl',
  stderr: 'stderr.log',
  liveness: 'liveness',
  progress: 'progress.json',
  exit: 'exit.json',
  result: 'out/result.json',
} as const;
export type RunFileName = (typeof RUN_FILES)[keyof typeof RUN_FILES];

/** The only unredacted file of a run dir: hands secret variables to the runner, see `takeSecretEnv`. */
export const SECRET_ENV_FILE = 'secret-env.json';
const SecretEnvSchema = z.record(z.string(), z.string());

export const SPOOL_DIR = 'spool';
/** Segments behind the committed cursor; `task logs` still reads them, the spool cap no longer counts them. */
export const ACKED_DIR = 'acked';
const RUN_SUBDIRS = ['out', SPOOL_DIR] as const;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export const SafeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .refine((s) => !s.includes('..'), 'id must not contain ..');

export function isSafeId(id: string): boolean {
  return SafeIdSchema.safeParse(id).success;
}

export const RUNNER_FILE_ERROR_CODES = [
  'unsafe_id',
  'unsafe_path',
  'symlink',
  'not_directory',
  'not_regular_file',
  'escapes_root',
  'not_found',
  'invalid_limits',
  'invalid_argument',
  'too_large',
  'layout_mismatch',
  'writer_failed',
] as const;
export type RunnerFileErrorCode = (typeof RUNNER_FILE_ERROR_CODES)[number];

/** Guard or layout violation: a bug or tampering, never an expected outcome. */
export class RunnerFileError extends Error {
  override name = 'RunnerFileError';
  readonly code: RunnerFileErrorCode;

  constructor(code: RunnerFileErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// ---- limits -----------------------------------------------------------------------------------

/** The snapshot caps this module enforces; a full {@link RuntimeLimits} is accepted as is. */
export type FileLimits = Pick<
  RuntimeLimits,
  'log_record_bytes' | 'result_bytes' | 'log_segment_bytes' | 'spool_bytes'
>;

export function fileLimits(l: FileLimits = DEFAULT_RUNTIME_LIMITS): FileLimits {
  const out: FileLimits = {
    log_record_bytes: l.log_record_bytes,
    result_bytes: l.result_bytes,
    log_segment_bytes: l.log_segment_bytes,
    spool_bytes: l.spool_bytes,
  };
  for (const [k, v] of Object.entries(out)) {
    if (!Number.isSafeInteger(v) || v <= 0)
      throw new RunnerFileError('invalid_limits', `${k} must be a positive integer`);
  }
  if (out.log_record_bytes > out.log_segment_bytes)
    throw new RunnerFileError('invalid_limits', 'log_record_bytes must be <= log_segment_bytes');
  if (out.log_segment_bytes > out.spool_bytes)
    throw new RunnerFileError('invalid_limits', 'log_segment_bytes must be <= spool_bytes');
  return out;
}

// ---- low-level fs helpers ---------------------------------------------------------------------

function errno(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch (e) {
    if (errno(e) === 'ENOENT') return null;
    throw e;
  }
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

function readAll(fd: number, start: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const n = readSync(fd, buf, off, length - off, start + off);
    if (n === 0) break;
    off += n;
  }
  return off === length ? buf : buf.subarray(0, off);
}

function sha256(buf: Buffer): Hash {
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

const O_CREATE_EXCL =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const O_APPEND_EXISTING = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW;
const O_READ = constants.O_RDONLY | constants.O_NOFOLLOW;

/** Writes `data` to a fresh, fsynced temp file next to `name`; returns its path. */
function writeTempIn(dir: string, name: string, data: Buffer): string {
  const tmp = join(dir, `.${name}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const fd = openSync(tmp, O_CREATE_EXCL, FILE_MODE);
  try {
    writeAll(fd, data);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    unlinkSync(tmp);
    throw e;
  }
  closeSync(fd);
  return tmp;
}

/** temp → fsync → rename → fsync directory. */
export function writeAtomicIn(dir: string, name: string, data: Buffer): void {
  const tmp = writeTempIn(dir, name, data);
  try {
    renameSync(tmp, join(dir, name));
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }
  fsyncDir(dir);
}

/** Like {@link writeAtomicIn} but never replaces an existing file; false when it already exists. */
function createOnceIn(dir: string, name: string, data: Buffer): boolean {
  const tmp = writeTempIn(dir, name, data);
  try {
    linkSync(tmp, join(dir, name));
    return true;
  } catch (e) {
    if (errno(e) === 'EEXIST') return false;
    throw e;
  } finally {
    unlinkSync(tmp);
    fsyncDir(dir);
  }
}

/** Opens or creates `name` under `parent` as a plain directory (never a symlink). */
function plainDir(parent: string, name: string, create: boolean): string {
  const p = join(parent, name);
  let st = lstatOrNull(p);
  if (st === null) {
    if (!create) throw new RunnerFileError('not_found', `${p} does not exist`);
    try {
      mkdirSync(p, { mode: DIR_MODE });
    } catch (e) {
      if (errno(e) !== 'EEXIST') throw e;
    }
    st = lstatSync(p);
  }
  if (st.isSymbolicLink()) throw new RunnerFileError('symlink', `${p} is a symlink`);
  if (!st.isDirectory()) throw new RunnerFileError('not_directory', `${p} is not a directory`);
  return p;
}

// ---- run directory ----------------------------------------------------------------------------

export interface WrittenFile {
  readonly relative_path: string;
  readonly bytes: number;
  readonly digest: Hash;
  readonly redaction_version: number;
}

export type FinalRead<T> =
  | { readonly state: 'missing' }
  | { readonly state: 'invalid'; readonly reason: string }
  | {
      readonly state: 'valid';
      readonly value: T;
      readonly bytes: number;
      readonly digest: Hash;
    };

export interface ResultTooLarge {
  readonly code: 'result_too_large';
  readonly bytes: number;
  readonly limit: number;
}

export interface OpenRunDirOptions {
  /** Absolute DATA_DIR; it may itself be a symlink, nothing below it may be. */
  readonly dataDir: string;
  readonly kind: RunDirKind;
  /** attempt_id for `runs`, operation_id for `operations`. */
  readonly id: string;
  readonly redactor: Redactor;
  /** Snapshot limits; defaults to {@link DEFAULT_RUNTIME_LIMITS}. */
  readonly limits?: FileLimits;
  /** Create missing directories (runner side). Readers pass false. Default true. */
  readonly create?: boolean;
}

export class RunDir {
  readonly root: string;
  readonly kind: RunDirKind;
  readonly id: string;
  /** Absolute, symlink-free path of this run directory. */
  readonly dir: string;
  readonly redactor: Redactor;
  readonly limits: FileLimits;

  private constructor(
    root: string,
    kind: RunDirKind,
    id: string,
    dir: string,
    redactor: Redactor,
    limits: FileLimits,
  ) {
    this.root = root;
    this.kind = kind;
    this.id = id;
    this.dir = dir;
    this.redactor = redactor;
    this.limits = limits;
  }

  static open(opts: OpenRunDirOptions): RunDir {
    const create = opts.create ?? true;
    if (!isAbsolute(opts.dataDir))
      throw new RunnerFileError('unsafe_path', `data dir ${opts.dataDir} must be absolute`);
    if (!(RUN_DIR_KINDS as readonly string[]).includes(opts.kind))
      throw new RunnerFileError('invalid_argument', `unknown run dir kind ${opts.kind}`);
    if (!isSafeId(opts.id))
      throw new RunnerFileError('unsafe_id', `unsafe id ${JSON.stringify(opts.id)}`);
    const limits = fileLimits(opts.limits);
    if (create) mkdirSync(opts.dataDir, { recursive: true, mode: DIR_MODE });
    let root: string;
    try {
      root = realpathSync(opts.dataDir);
    } catch (e) {
      if (errno(e) === 'ENOENT')
        throw new RunnerFileError('not_found', `data dir ${opts.dataDir} does not exist`);
      throw e;
    }
    const dir = plainDir(plainDir(root, opts.kind, create), opts.id, create);
    if (realpathSync(dir) !== dir)
      throw new RunnerFileError('escapes_root', `${dir} resolves outside ${root}`);
    if (create) for (const sub of RUN_SUBDIRS) plainDir(dir, sub, true);
    return new RunDir(root, opts.kind, opts.id, dir, opts.redactor, limits);
  }

  /**
   * Absolute path of `rel` inside this directory. Rejects absolute paths, `..`, empty segments and any
   * existing symlink component. Missing components are allowed (the caller may be about to create them).
   */
  resolve(rel: string): string {
    if (!RelativePathSchema.safeParse(rel).success || rel.includes('\\'))
      throw new RunnerFileError('unsafe_path', `unsafe relative path ${JSON.stringify(rel)}`);
    const parts = rel.split('/');
    let p = this.dir;
    for (let i = 0; i < parts.length; i++) {
      p = join(p, parts[i] as string);
      const st = lstatOrNull(p);
      if (st === null) break;
      if (st.isSymbolicLink()) throw new RunnerFileError('symlink', `symlink in path ${rel}`);
      if (i < parts.length - 1 && !st.isDirectory())
        throw new RunnerFileError(
          'not_directory',
          `${parts.slice(0, i + 1).join('/')} is not a directory`,
        );
    }
    // Checking stops at the first missing component; the result is always the full path.
    return join(this.dir, ...parts);
  }

  /** Creates `rel` (and its parents) as plain directories inside this run directory. */
  ensureDir(rel: string): string {
    this.resolve(rel);
    let p = this.dir;
    for (const part of rel.split('/')) p = plainDir(p, part, true);
    return p;
  }

  #parentOf(rel: string): { dir: string; name: string } {
    this.resolve(rel);
    const i = rel.lastIndexOf('/');
    return i < 0
      ? { dir: this.dir, name: rel }
      : { dir: this.ensureDir(rel.slice(0, i)), name: rel.slice(i + 1) };
  }

  #encodeJson(value: unknown, maxBytes: number, rel: string): Buffer {
    const buf = Buffer.from(`${JSON.stringify(this.redactor.value(value))}\n`, 'utf8');
    if (buf.length > maxBytes)
      throw new RunnerFileError('too_large', `${rel} is ${buf.length} bytes, limit ${maxBytes}`);
    return buf;
  }

  #written(rel: string, buf: Buffer): WrittenFile {
    return {
      relative_path: rel,
      bytes: buf.length,
      digest: sha256(buf),
      redaction_version: this.redactor.version,
    };
  }

  /** Redacted JSON, written atomically. Control files are bounded by `result_bytes`. */
  writeJson(rel: string, value: unknown, maxBytes: number = this.limits.result_bytes): WrittenFile {
    const buf = this.#encodeJson(value, maxBytes, rel);
    const { dir, name } = this.#parentOf(rel);
    writeAtomicIn(dir, name, buf);
    return this.#written(rel, buf);
  }

  /**
   * A command needs its secrets as they are, but invocation.json is redacted and stays on disk for the
   * whole retention. So they cross in a file of their own that is never redacted and never read back as
   * an artifact: the runner deletes it before it spawns anything.
   */
  writeSecretEnv(env: Readonly<Record<string, string>>): void {
    const { dir, name } = this.#parentOf(SECRET_ENV_FILE);
    writeAtomicIn(dir, name, Buffer.from(`${JSON.stringify(env)}\n`, 'utf8'));
  }

  /** Reads and deletes the handed-over secrets; null when there are none to read. */
  takeSecretEnv(): Record<string, string> | null {
    const read = this.readFinal(SECRET_ENV_FILE, SecretEnvSchema);
    this.removeSecretEnv();
    return read.state === 'valid' ? read.value : null;
  }

  removeSecretEnv(): void {
    rmSync(this.resolve(SECRET_ENV_FILE), { force: true });
  }

  /** Redacted text, written atomically. */
  writeText(rel: string, text: string, maxBytes: number = this.limits.result_bytes): WrittenFile {
    const buf = Buffer.from(this.redactor.text(text), 'utf8');
    if (buf.length > maxBytes)
      throw new RunnerFileError('too_large', `${rel} is ${buf.length} bytes, limit ${maxBytes}`);
    const { dir, name } = this.#parentOf(rel);
    writeAtomicIn(dir, name, buf);
    return this.#written(rel, buf);
  }

  /** Writes redacted JSON only if `rel` does not exist yet (the launch marker); null when it does. */
  createJsonOnce(rel: string, value: unknown): WrittenFile | null {
    const buf = this.#encodeJson(value, this.limits.result_bytes, rel);
    const { dir, name } = this.#parentOf(rel);
    return createOnceIn(dir, name, buf) ? this.#written(rel, buf) : null;
  }

  createLaunchMarker(value: unknown): WrittenFile | null {
    return this.createJsonOnce(RUN_FILES.launch, value);
  }

  writeLiveness(at: Date): WrittenFile {
    return this.writeText(RUN_FILES.liveness, `${at.toISOString()}\n`);
  }

  writeExit(value: unknown): WrittenFile {
    return this.writeJson(RUN_FILES.exit, value);
  }

  /** out/result.json; a result over `result_bytes` after redaction is rejected, never truncated. */
  writeResult(value: unknown): Result<WrittenFile, ResultTooLarge> {
    const buf = Buffer.from(`${JSON.stringify(this.redactor.value(value))}\n`, 'utf8');
    if (buf.length > this.limits.result_bytes)
      return err({
        code: 'result_too_large',
        bytes: buf.length,
        limit: this.limits.result_bytes,
      });
    const { dir, name } = this.#parentOf(RUN_FILES.result);
    writeAtomicIn(dir, name, buf);
    return ok(this.#written(RUN_FILES.result, buf));
  }

  /**
   * Reads a final JSON file (exit.json, out/result.json). Anything but a complete, newline-terminated,
   * bounded, schema-valid file is `invalid` — a partial file after a crash is never a success.
   */
  readFinal<T = unknown>(rel: string, schema?: z.ZodType<T>): FinalRead<T> {
    let path: string;
    try {
      path = this.resolve(rel);
    } catch (e) {
      if (e instanceof RunnerFileError) return { state: 'invalid', reason: e.message };
      throw e;
    }
    let fd: number;
    try {
      fd = openSync(path, O_READ);
    } catch (e) {
      if (errno(e) === 'ENOENT') return { state: 'missing' };
      if (errno(e) === 'ELOOP') return { state: 'invalid', reason: `${rel} is a symlink` };
      throw e;
    }
    let buf: Buffer;
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return { state: 'invalid', reason: `${rel} is not a regular file` };
      if (st.size > this.limits.result_bytes)
        return {
          state: 'invalid',
          reason: `${rel} is ${st.size} bytes, limit ${this.limits.result_bytes}`,
        };
      buf = readAll(fd, 0, st.size);
    } finally {
      closeSync(fd);
    }
    if (buf.length === 0 || buf[buf.length - 1] !== 0x0a)
      return { state: 'invalid', reason: `${rel} is incomplete` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf));
    } catch {
      return { state: 'invalid', reason: `${rel} is not valid JSON` };
    }
    if (schema === undefined)
      return {
        state: 'valid',
        value: parsed as T,
        bytes: buf.length,
        digest: sha256(buf),
      };
    const r = schema.safeParse(parsed);
    if (!r.success)
      return {
        state: 'invalid',
        reason: `${rel} does not match its schema: ${r.error.issues.map((i) => i.message).join('; ')}`,
      };
    return {
      state: 'valid',
      value: r.data,
      bytes: buf.length,
      digest: sha256(buf),
    };
  }
}

// ---- event log --------------------------------------------------------------------------------

const KindSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/);

export const LogRecordSchema = z
  .object({
    schema_version: z.literal(LOG_SCHEMA_VERSION),
    operation_id: SafeIdSchema,
    generation: z.number().int().nonnegative(),
    seq: z.number().int().positive(),
    at: z.string().min(1),
    kind: KindSchema,
    data: z.unknown(),
  })
  .strict();
export type LogRecord = z.infer<typeof LogRecordSchema>;

export type IngestPosition = Omit<IngestCursor, 'acked_at'>;

export interface RecordTooLarge {
  readonly code: 'record_too_large';
  readonly bytes: number;
  readonly limit: number;
}

/** Spool cap reached: the runner stops the operation; un-ingested output is never dropped. */
export interface ArtifactBackpressure {
  readonly code: 'artifact_backpressure';
  readonly spool_bytes: number;
  readonly requested_bytes: number;
  readonly limit: number;
}

export type AppendError = RecordTooLarge | ArtifactBackpressure;

export interface AppendedRecord {
  readonly generation: number;
  readonly segment: number;
  readonly seq: number;
  readonly byte_offset: number;
  readonly bytes: number;
}

export interface SegmentInfo {
  readonly generation: number;
  readonly segment: number;
  readonly name: string;
  readonly bytes: number;
}

const SEGMENT_RE = /^events\.(\d{1,9})\.(\d{1,9})\.jsonl$/;

export function segmentFileName(generation: number, segment: number): string {
  return `events.${String(generation).padStart(6, '0')}.${String(segment).padStart(6, '0')}.jsonl`;
}

/** Spool segments ordered by segment number; the last one is active, every earlier one is sealed. */
export function listSegments(run: RunDir): SegmentInfo[] {
  const spool = run.resolve(SPOOL_DIR);
  let names: string[];
  try {
    names = readdirSync(spool);
  } catch (e) {
    if (errno(e) === 'ENOENT') return [];
    throw e;
  }
  const out: SegmentInfo[] = [];
  for (const name of names) {
    const m = SEGMENT_RE.exec(name);
    if (m === null) continue;
    const st = lstatSync(join(spool, name));
    if (st.isSymbolicLink())
      throw new RunnerFileError('symlink', `spool segment ${name} is a symlink`);
    if (!st.isFile())
      throw new RunnerFileError('not_regular_file', `spool segment ${name} is not a regular file`);
    out.push({
      generation: Number(m[1]),
      segment: Number(m[2]),
      name,
      bytes: st.size,
    });
  }
  out.sort((a, b) => a.segment - b.segment);
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1] as SegmentInfo;
    const cur = out[i] as SegmentInfo;
    if (cur.segment === prev.segment || cur.generation < prev.generation)
      throw new RunnerFileError(
        'layout_mismatch',
        `spool segments ${prev.name} and ${cur.name} are out of order`,
      );
  }
  return out;
}

/** Bytes held for this operation: every un-acked segment plus stderr.log. */
export function spoolUsage(run: RunDir): number {
  let total = 0;
  for (const s of listSegments(run)) total += s.bytes;
  const st = lstatOrNull(run.resolve(RUN_FILES.stderr));
  if (st !== null && st.isFile()) total += st.size;
  return total;
}

function readSegment(run: RunDir, name: string, from: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(join(run.resolve(SPOOL_DIR), name), O_READ);
  } catch (e) {
    if (errno(e) === 'ENOENT') return null;
    if (errno(e) === 'ELOOP')
      throw new RunnerFileError('symlink', `spool segment ${name} is a symlink`);
    throw e;
  }
  try {
    const size = fstatSync(fd).size;
    if (from > size) return null;
    return readAll(fd, from, size - from);
  } finally {
    closeSync(fd);
  }
}

function parseRecord(line: Buffer): LogRecord | string {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
  } catch {
    return 'not valid JSON';
  }
  const r = LogRecordSchema.safeParse(raw);
  return r.success
    ? r.data
    : `bad record: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`;
}

function lastSeqIn(run: RunDir, segments: readonly SegmentInfo[]): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    const buf = readSegment(run, (segments[i] as SegmentInfo).name, 0);
    if (buf === null) continue;
    let last = 0;
    let pos = 0;
    for (let nl = buf.indexOf(0x0a); nl >= 0; nl = buf.indexOf(0x0a, pos)) {
      const rec = parseRecord(buf.subarray(pos, nl));
      if (typeof rec !== 'string') last = Math.max(last, rec.seq);
      pos = nl + 1;
    }
    if (last > 0) return last;
  }
  return 0;
}

export interface EventLogWriterOptions {
  /** Clock for the record `at` field. */
  readonly now?: () => Date;
}

/**
 * Single writer (the runner holds the operation flock) for events and stderr of one operation.
 *
 * `seq` starts at 1 and is monotonic for the operation, so `last_record_seq: 0` means "nothing read".
 * `segment` grows on every rotation; `generation` grows each time a writer re-opens an existing log,
 * which seals the previous segment (any torn tail stays behind and is reported by the reader).
 * events.jsonl is always a hard link to the active segment; segments are deleted only by
 * {@link ackThrough}.
 */
export class EventLogWriter {
  readonly #run: RunDir;
  readonly #operationId: string;
  readonly #now: () => Date;
  #generation: number;
  #segment: number;
  #seq: number;
  /** Active segment fd; null until the first append of a re-opened log. */
  #fd: number | null;
  #size = 0;
  #usage: number;
  #stderrFd: number;
  #stderrPending = '';
  readonly #decoder = new StringDecoder('utf8');
  #failed = false;
  #closed = false;

  private constructor(
    run: RunDir,
    operationId: string,
    now: () => Date,
    state: {
      generation: number;
      segment: number;
      seq: number;
      fd: number | null;
    },
  ) {
    this.#run = run;
    this.#operationId = operationId;
    this.#now = now;
    this.#generation = state.generation;
    this.#segment = state.segment;
    this.#seq = state.seq;
    this.#fd = state.fd;
    this.#stderrFd = openSync(
      run.resolve(RUN_FILES.stderr),
      O_APPEND_EXISTING | constants.O_CREAT,
      FILE_MODE,
    );
    this.#usage = spoolUsage(run);
  }

  static open(run: RunDir, operationId: string, opts: EventLogWriterOptions = {}): EventLogWriter {
    if (!isSafeId(operationId))
      throw new RunnerFileError('unsafe_id', `unsafe operation id ${JSON.stringify(operationId)}`);
    const now = opts.now ?? ((): Date => new Date());
    const segments = listSegments(run);
    const last = segments.at(-1);
    if (last === undefined) {
      if (lstatOrNull(run.resolve(RUN_FILES.events)) !== null)
        throw new RunnerFileError('layout_mismatch', 'events.jsonl exists without a spool segment');
      const fd = createSegment(run, 0, 0, Buffer.alloc(0));
      return new EventLogWriter(run, operationId, now, {
        generation: 0,
        segment: 0,
        seq: 0,
        fd,
      });
    }
    linkEvents(run, last.name);
    return new EventLogWriter(run, operationId, now, {
      generation: last.generation + 1,
      segment: last.segment + 1,
      seq: lastSeqIn(run, segments),
      fd: null,
    });
  }

  get generation(): number {
    return this.#generation;
  }

  get segment(): number {
    return this.#segment;
  }

  /** Seq of the last appended record (0 when none). */
  get seq(): number {
    return this.#seq;
  }

  /** Stderr text received but not written yet (an unfinished line, or held back by backpressure). */
  get pendingStderrBytes(): number {
    return Buffer.byteLength(this.#stderrPending);
  }

  #ensureUsable(): void {
    if (this.#closed) throw new RunnerFileError('writer_failed', 'event log writer is closed');
    if (this.#failed)
      throw new RunnerFileError(
        'writer_failed',
        'event log writer failed; re-open to continue in a new generation',
      );
  }

  /** Reserves `bytes` of spool; re-measures from disk first, since the daemon may have acked segments. */
  #reserve(bytes: number): ArtifactBackpressure | null {
    const limit = this.#run.limits.spool_bytes;
    if (this.#usage + bytes > limit) this.#usage = spoolUsage(this.#run);
    if (this.#usage + bytes > limit)
      return {
        code: 'artifact_backpressure',
        spool_bytes: this.#usage,
        requested_bytes: bytes,
        limit,
      };
    return null;
  }

  /** Appends one redacted record. Oversize records are rejected; nothing is truncated. */
  append(kind: string, data: unknown): Result<AppendedRecord, AppendError> {
    this.#ensureUsable();
    if (!KindSchema.safeParse(kind).success)
      throw new RunnerFileError('invalid_argument', `invalid record kind ${JSON.stringify(kind)}`);
    const limits = this.#run.limits;
    const seq = this.#seq + 1;
    const record: LogRecord = {
      schema_version: LOG_SCHEMA_VERSION,
      operation_id: this.#operationId,
      generation: this.#generation,
      seq,
      at: this.#now().toISOString(),
      kind,
      data: this.#run.redactor.value(data),
    };
    const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    if (line.length > limits.log_record_bytes)
      return err({
        code: 'record_too_large',
        bytes: line.length,
        limit: limits.log_record_bytes,
      });
    const full = this.#reserve(line.length);
    if (full !== null) return err(full);
    const needsNew =
      this.#fd === null || (this.#size > 0 && this.#size + line.length > limits.log_segment_bytes);
    let offset: number;
    try {
      if (needsNew) {
        const segment = this.#fd === null ? this.#segment : this.#segment + 1;
        const fd = createSegment(this.#run, this.#generation, segment, line);
        if (this.#fd !== null) closeSync(this.#fd);
        this.#fd = fd;
        this.#segment = segment;
        this.#size = 0;
      } else {
        writeAll(this.#fd as number, line);
      }
      offset = this.#size;
    } catch (e) {
      this.#failed = true;
      throw e;
    }
    this.#size += line.length;
    this.#usage += line.length;
    this.#seq = seq;
    return ok({
      generation: this.#generation,
      segment: this.#segment,
      seq,
      byte_offset: offset,
      bytes: line.length,
    });
  }

  /**
   * Buffers stderr and appends whole lines, redacted. An unterminated run longer than `log_record_bytes`
   * is flushed up to a cut no secret can straddle (see {@link Redactor.safeCut}); the remainder stays
   * buffered. On backpressure the text stays buffered and is reported, not dropped.
   */
  appendStderr(chunk: string | Uint8Array): Result<number, ArtifactBackpressure> {
    this.#ensureUsable();
    this.#stderrPending +=
      typeof chunk === 'string' ? chunk : this.#decoder.write(Buffer.from(chunk));
    return this.#drainStderr(false);
  }

  /** Writes any buffered partial stderr line (process ended). */
  flushStderr(): Result<number, ArtifactBackpressure> {
    this.#ensureUsable();
    this.#stderrPending += this.#decoder.end();
    return this.#drainStderr(true);
  }

  #drainStderr(final: boolean): Result<number, ArtifactBackpressure> {
    const pending = this.#stderrPending;
    const redactor = this.#run.redactor;
    const cap = this.#run.limits.log_record_bytes;
    let cut = pending.length;
    if (!final) {
      const line = pending.lastIndexOf('\n') + 1;
      const force = Buffer.byteLength(pending.slice(line)) > cap;
      cut = redactor.safeCut(pending, force ? pending.length : line, 2 * redactor.carry + cap);
    }
    if (cut === 0) return ok(0);
    const buf = Buffer.from(redactor.text(pending.slice(0, cut)), 'utf8');
    const full = this.#reserve(buf.length);
    if (full !== null) return err(full);
    try {
      writeAll(this.#stderrFd, buf);
    } catch (e) {
      this.#failed = true;
      throw e;
    }
    this.#usage += buf.length;
    this.#stderrPending = pending.slice(cut);
    return ok(buf.length);
  }

  sync(): void {
    if (this.#fd !== null) fsyncSync(this.#fd);
    fsyncSync(this.#stderrFd);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#fd !== null) closeSync(this.#fd);
    closeSync(this.#stderrFd);
  }
}

/** Points events.jsonl at a spool segment via a hard link replaced atomically. */
function linkEvents(run: RunDir, segmentName: string): void {
  const target = run.resolve(RUN_FILES.events);
  const tmp = join(
    run.dir,
    `.${RUN_FILES.events}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
  );
  linkSync(join(run.resolve(SPOOL_DIR), segmentName), tmp);
  try {
    renameSync(tmp, target);
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }
  fsyncDir(run.dir);
}

/**
 * Creates a segment already holding `initial` (fsynced before it becomes visible, so a rotated segment
 * is never empty), switches events.jsonl to it and returns an append fd.
 */
function createSegment(run: RunDir, generation: number, segment: number, initial: Buffer): number {
  const spool = run.ensureDir(SPOOL_DIR);
  const name = segmentFileName(generation, segment);
  if (!createOnceIn(spool, name, initial))
    throw new RunnerFileError('layout_mismatch', `spool segment ${name} already exists`);
  linkEvents(run, name);
  return openSync(join(spool, name), O_APPEND_EXISTING);
}

// ---- reader -----------------------------------------------------------------------------------

export interface TornTail {
  readonly generation: number;
  readonly segment: number;
  readonly byte_offset: number;
  readonly bytes: number;
}

export interface ReadBatch {
  readonly records: LogRecord[];
  /** Position after the last complete record; null only when nothing exists yet and no cursor was given. */
  readonly cursor: IngestPosition | null;
  /**
   * Partial tails that were skipped: of sealed segments (a writer died mid-record), and with `final`
   * also of the last segment.
   */
  readonly torn: TornTail[];
}

export type ReadError =
  | { readonly code: 'cursor_mismatch'; readonly message: string }
  | { readonly code: 'cursor_not_found'; readonly message: string }
  | {
      readonly code: 'corrupt_record';
      readonly generation: number;
      readonly segment: number;
      readonly byte_offset: number;
      readonly reason: string;
    };

export interface ReadOptions {
  readonly maxRecords?: number;
  /**
   * The writer is gone for good (exit.json is final): a partial tail of the last segment will never be
   * completed, so it is reported as torn instead of being left for a next read (FR-031).
   */
  readonly final?: boolean;
}

/**
 * Reads complete records after `from` (null = from the oldest segment). Never mutates anything, so
 * re-reading from the same cursor returns the same records. A trailing partial line of the active
 * segment is left for the next read, unless `final` says no writer will ever finish it.
 */
export function readRecords(
  run: RunDir,
  operationId: string,
  from: IngestPosition | null,
  opts: ReadOptions = {},
): Result<ReadBatch, ReadError> {
  if (from !== null && from.operation_id !== operationId)
    return err({
      code: 'cursor_mismatch',
      message: `cursor is for operation ${from.operation_id}`,
    });
  const segments = listSegments(run);
  if (segments.length === 0) return ok({ records: [], cursor: from, torn: [] });
  let i = 0;
  if (from !== null) {
    i = segments.findIndex((s) => s.generation === from.generation && s.segment === from.segment);
    if (i < 0)
      return err({
        code: 'cursor_not_found',
        message: `segment ${from.generation}.${from.segment} is not in the spool`,
      });
  }
  const max = opts.maxRecords ?? Number.POSITIVE_INFINITY;
  const records: LogRecord[] = [];
  const torn: TornTail[] = [];
  let cursor = from;
  let offset = from?.byte_offset ?? 0;
  let lastSeq = from?.last_record_seq ?? 0;
  for (; i < segments.length; i++) {
    const seg = segments[i] as SegmentInfo;
    const buf = readSegment(run, seg.name, offset);
    if (buf === null)
      return err({
        code: 'cursor_not_found',
        message: `segment ${seg.name} has no byte ${offset}`,
      });
    let pos = 0;
    while (records.length < max) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl < 0) break;
      const rec = parseRecord(buf.subarray(pos, nl));
      const at = {
        generation: seg.generation,
        segment: seg.segment,
        byte_offset: offset + pos,
      };
      if (typeof rec === 'string') return err({ code: 'corrupt_record', ...at, reason: rec });
      if (rec.operation_id !== operationId)
        return err({
          code: 'corrupt_record',
          ...at,
          reason: `operation_id ${rec.operation_id}`,
        });
      if (rec.generation !== seg.generation)
        return err({
          code: 'corrupt_record',
          ...at,
          reason: `generation ${rec.generation} in segment of generation ${seg.generation}`,
        });
      if (rec.seq <= lastSeq)
        return err({
          code: 'corrupt_record',
          ...at,
          reason: `seq ${rec.seq} after ${lastSeq}`,
        });
      records.push(rec);
      lastSeq = rec.seq;
      pos = nl + 1;
      cursor = {
        operation_id: operationId,
        generation: seg.generation,
        segment: seg.segment,
        byte_offset: offset + pos,
        last_record_seq: lastSeq,
      };
    }
    const next = segments[i + 1];
    if (records.length >= max) break;
    if (next === undefined) {
      if (opts.final === true && pos < buf.length)
        torn.push({
          generation: seg.generation,
          segment: seg.segment,
          byte_offset: offset + pos,
          bytes: buf.length - pos,
        });
      break;
    }
    if (pos < buf.length)
      torn.push({
        generation: seg.generation,
        segment: seg.segment,
        byte_offset: offset + pos,
        bytes: buf.length - pos,
      });
    offset = 0;
    cursor = {
      operation_id: operationId,
      generation: next.generation,
      segment: next.segment,
      byte_offset: 0,
      last_record_seq: lastSeq,
    };
  }
  return ok({ records, cursor, torn });
}

/**
 * Deletes the sealed segments the cursor has moved past. Call only after the records and the cursor
 * were committed. Never deletes the cursor's own segment or the active one; repeating is a no-op.
 */
export function ackThrough(
  run: RunDir,
  operationId: string,
  cursor: IngestPosition,
): Result<string[], ReadError> {
  if (cursor.operation_id !== operationId)
    return err({
      code: 'cursor_mismatch',
      message: `cursor is for operation ${cursor.operation_id}`,
    });
  const segments = listSegments(run);
  const i = segments.findIndex(
    (s) => s.generation === cursor.generation && s.segment === cursor.segment,
  );
  if (i < 0) {
    const first = segments[0];
    if (first !== undefined && cursor.segment < first.segment) return ok([]);
    return err({
      code: 'cursor_not_found',
      message: `segment ${cursor.generation}.${cursor.segment} is not in the spool`,
    });
  }
  const spool = run.resolve(SPOOL_DIR);
  const acked = run.resolve(ACKED_DIR);
  const deleted: string[] = [];
  for (const s of segments.slice(0, i)) {
    mkdirSync(acked, { recursive: true, mode: DIR_MODE });
    renameSync(join(spool, s.name), join(acked, s.name));
    deleted.push(s.name);
  }
  if (deleted.length > 0) {
    fsyncDir(acked);
    fsyncDir(spool);
  }
  return ok(deleted);
}

/** Every complete record the run still holds, acknowledged segments included, in `seq` order. */
export function readAllRecords(run: RunDir): LogRecord[] {
  const files: { path: string; segment: number }[] = [];
  for (const rel of [ACKED_DIR, SPOOL_DIR]) {
    const dir = run.resolve(rel);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      if (errno(e) === 'ENOENT') continue;
      throw e;
    }
    for (const name of names) {
      const m = SEGMENT_RE.exec(name);
      if (m !== null) files.push({ path: join(dir, name), segment: Number(m[2]) });
    }
  }
  files.sort((a, b) => a.segment - b.segment);
  const out: LogRecord[] = [];
  for (const f of files) {
    const fd = openSync(f.path, O_READ);
    let buf: Buffer;
    try {
      buf = readAll(fd, 0, fstatSync(fd).size);
    } finally {
      closeSync(fd);
    }
    let pos = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl < 0) break;
      const rec = parseRecord(buf.subarray(pos, nl));
      if (typeof rec !== 'string') out.push(rec);
      pos = nl + 1;
    }
  }
  return out;
}

/**
 * What `readAllRecords` would read, as names and sizes: the same stamp means the same records, since
 * segments are only appended to, moved between the two directories, or removed.
 */
export function recordFilesStamp(run: RunDir): string {
  const parts: string[] = [];
  for (const rel of [ACKED_DIR, SPOOL_DIR]) {
    const dir = run.resolve(rel);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      if (errno(e) === 'ENOENT') continue;
      throw e;
    }
    for (const name of names.toSorted())
      if (SEGMENT_RE.test(name)) parts.push(`${rel}/${name}:${lstatSync(join(dir, name)).size}`);
  }
  return parts.join('|');
}
