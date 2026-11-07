/**
 * Repo-controlled commands (T038, FR-004, contracts/execution.md): setup,
 * gates and autofix run exactly the frozen command string as `/bin/sh -c <command>` through the selected
 * launch provider (host in production). A declared command wall or task deadline caps the run; both are
 * optional. Every run produces a receipt.
 *
 * Retry safety is declared per role. An `unknown` outcome (the process may have run and written) of a
 * command that is not declared safe must wait for a human instead of being run again.
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  Clock,
  SandboxLaunchPlan,
  SandboxLayout,
  SandboxProvider,
} from '../adapters/ports.ts';
import type { EpochMs, Hash } from '../shared/brand.ts';
import { hashText } from '../shared/hash.ts';
import {
  excerptOf,
  joinCapture,
  OutputCapture,
  type CaptureEnd,
  type Captured,
} from './command-output.ts';
import { operationEnv } from './process-tag.ts';
import type { Redactor } from './redact.ts';
import { ensurePrivateTmpDir, shortTmpDir } from './sandbox.ts';

export const COMMAND_ROLES = ['setup', 'gate', 'autofix'] as const;
export type CommandRole = (typeof COMMAND_ROLES)[number];

/**
 * Setup reinstalls from the frozen lockfile/command and gates only check and build, so re-running them
 * after an unknown outcome is safe; autofix rewrites sources, so an unknown autofix waits for a human.
 */
export const RETRY_SAFETY: Readonly<Record<CommandRole, 'safe' | 'unsafe'>> = {
  setup: 'safe',
  gate: 'safe',
  autofix: 'unsafe',
};

const OUTPUT_BYTES = 16 * 1024 * 1024;
const TAIL_BYTES = 4 * 1024;
/** Lives in an event and repeats with each round of fixes, so it stays far below the whole log. */
export const EXCERPT_BYTES = 16 * 1024;
/** Under an effect's journal directory. */
export const COMMAND_LOG_DIR = 'logs';
/** Beside the journal records, while a command runs: what a reader can say of it before it has a log. */
export const COMMAND_RUNNING_FILE = 'running.state';
const RUNNING_WRITE_MS = 1_000;

export type ExecOutcome =
  | {
      readonly kind: 'exited';
      readonly code: number;
      readonly output: string;
      readonly truncated: boolean;
      readonly end?: CaptureEnd;
    }
  | {
      readonly kind: 'timeout';
      readonly output: string;
      readonly truncated: boolean;
      readonly end?: CaptureEnd;
    }
  /** Provably never started (spawn error before a process existed). */
  | { readonly kind: 'not_launched'; readonly message: string }
  /** Started, but how it ended is not known (killed by a signal we did not send, lost pipe). */
  | {
      readonly kind: 'unknown';
      readonly message: string;
      readonly output: string;
      readonly end?: CaptureEnd;
      /** Set when it was stopped on request: whether its whole process group was seen gone. */
      readonly stop?: 'verified' | 'unverified';
    };

/** Runs a sandbox launch plan; the default spawns it directly, the systemd runner replaces it later. */
export interface CommandExecutor {
  run(
    plan: SandboxLaunchPlan,
    opts: {
      readonly timeout_ms: number | null;
      readonly max_output_bytes: number;
      /** Stop request: nothing is spawned once it fired; a running group gets TERM, then KILL. */
      readonly signal?: AbortSignal;
      /** Called on every chunk of output, before it is captured. */
      readonly on_output?: () => void;
    },
  ): Promise<ExecOutcome>;
}

/** Grace between SIGTERM and SIGKILL when a command is stopped on request (FR-009, FR-025.02). */
export const STOP_TERM_GRACE_MS = 10_000;
/** How long a stopped group may take to disappear after SIGKILL. */
export const STOP_KILL_VERIFY_MS = 5_000;

export const RECEIPT_STATUSES = [
  'passed',
  'failed',
  'timeout',
  'deadline',
  'not_launched',
  'unknown',
] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export type CommandReceipt = {
  readonly role: CommandRole;
  readonly name: string;
  readonly command: string;
  readonly command_digest: Hash;
  readonly layout_digest: Hash | null;
  readonly status: ReceiptStatus;
  readonly exit_code: number | null;
  readonly started_at: EpochMs | null;
  readonly finished_at: EpochMs;
  readonly wall_ms: number | null;
  /** Redacted combined output: digest of what was captured, its tail, and whether capture was capped. */
  readonly output: {
    readonly digest: Hash;
    readonly bytes: number;
    readonly tail: string;
    readonly truncated: boolean;
    /** Both ends of the output. Receipts journaled by earlier releases have only `tail`. */
    readonly excerpt?: string;
    /** The redacted output on disk; null when it could not be written, absent when there is no journal. */
    readonly log?: CommandLogRef | null;
  };
  readonly retry: 'safe' | 'unsafe';
  readonly detail: string | null;
};

/** Where a command's whole redacted output is, relative to its effect's journal directory. */
export type CommandLogRef = {
  readonly ref: string;
  readonly digest: Hash;
  readonly bytes: number;
  readonly truncated: boolean;
  /** How long the command ran. */
  readonly wall_ms: number;
};

export type CommandRunning = {
  readonly gate: string;
  readonly role: CommandRole;
  readonly started_at: number;
  /** Null until the command has written anything. */
  readonly last_output_at: number | null;
};

export type CommandSpec = {
  readonly role: CommandRole;
  readonly name: string;
  readonly command: string;
  readonly layout: Omit<SandboxLayout, 'role' | 'private_home'>;
  /** Frozen per-command wall (runtime.limits.command_wall_ms). */
  readonly wall_ms: number | null;
  readonly deadline_at: EpochMs | null;
};

export type CommandDeps = {
  readonly sandbox: SandboxProvider;
  readonly executor: CommandExecutor;
  readonly clock: Clock;
  readonly redactor: Redactor;
  /** Durable receipts of the operation these commands belong to; recovery reads them (T090). */
  readonly journal?: CommandJournal;
};

export type JournalEntry =
  | {
      readonly kind: 'started';
      readonly role: CommandRole;
      readonly name: string;
      readonly command_digest: Hash;
      readonly at: number;
    }
  | { readonly kind: 'receipt'; readonly receipt: CommandReceipt };

export type JournalRead =
  | {
      readonly ok: true;
      /** Every command that may have run, in order, with its receipt once it ended. */
      readonly commands: readonly {
        readonly name: string;
        readonly role: CommandRole;
        readonly started: boolean;
        readonly receipt: CommandReceipt | null;
      }[];
    }
  | { readonly ok: false; readonly detail: string };

/**
 * One operation's command journal (FR-004): a `started` record is on disk before a command can spawn,
 * and its receipt after it ended. A command with `started` and no receipt may have run and written; a
 * journal with no `started` at all proves nothing was spawned. Records are append-only files, each
 * fsynced with its directory; a crash mid-write leaves a last record that does not parse, and an
 * unreadable journal proves nothing either way.
 */
export class CommandJournal {
  readonly #dir: string;
  constructor(dir: string) {
    this.#dir = dir;
  }

  append(entry: JournalEntry): void {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const seq = readdirSync(this.#dir).filter((f) => f.endsWith('.json')).length;
    const fd = openSync(join(this.#dir, `${String(seq).padStart(6, '0')}.json`), 'wx', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const d = openSync(this.#dir, 'r');
    try {
      fsyncSync(d);
    } finally {
      closeSync(d);
    }
  }

  /** One file per run of a command, so a retry of the effect never overwrites what a person may read. */
  writeLog(name: string, text: string): string {
    const dir = join(this.#dir, COMMAND_LOG_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const seq = String(readdirSync(dir).length).padStart(6, '0');
    const file = `${seq}-${name.replace(/[^A-Za-z0-9._-]+/g, '_')}.log`;
    const fd = openSync(join(dir, file), 'wx', 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return `${COMMAND_LOG_DIR}/${file}`;
  }

  /**
   * What is running now, for readers only: nothing depends on it, so a write that fails is not an error
   * and recovery keeps reading the records above.
   */
  markRunning(running: CommandRunning | null): void {
    const file = join(this.#dir, COMMAND_RUNNING_FILE);
    try {
      if (running === null) rmSync(file, { force: true });
      else writeFileSync(file, JSON.stringify(running), { mode: 0o600 });
    } catch {
      // A reader then sees nothing running.
    }
  }

  read(): JournalRead {
    let files: string[];
    try {
      files = readdirSync(this.#dir)
        .filter((f) => f.endsWith('.json'))
        .sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, commands: [] };
      return { ok: false, detail: `journal unreadable: ${String(e)}` };
    }
    const commands: {
      name: string;
      role: CommandRole;
      started: boolean;
      receipt: CommandReceipt | null;
    }[] = [];
    for (const f of files) {
      let e: JournalEntry;
      try {
        e = JSON.parse(readFileSync(join(this.#dir, f), 'utf8')) as JournalEntry;
      } catch (err) {
        return { ok: false, detail: `journal record ${f}: ${String(err)}` };
      }
      if (e.kind === 'started') {
        commands.push({
          name: e.name,
          role: e.role,
          started: true,
          receipt: null,
        });
        continue;
      }
      const open = commands.at(-1);
      // A receipt closes its own started record; one without (deadline, refused plan) never spawned.
      if (open !== undefined && open.receipt === null && open.name === e.receipt.name)
        open.receipt = e.receipt;
      else
        commands.push({
          name: e.receipt.name,
          role: e.receipt.role,
          started: false,
          receipt: e.receipt,
        });
    }
    return { ok: true, commands };
  }
}

function tail(text: string): string {
  const b = Buffer.from(text, 'utf8');
  return b.length <= TAIL_BYTES
    ? text
    : b
        .subarray(b.length - TAIL_BYTES)
        .toString('utf8')
        .replace(/^�+/, '');
}

/** A log that cannot be written costs the reader the log, not the gate its result. */
function writeLog(
  journal: CommandJournal,
  name: string,
  text: string,
  facts: Omit<CommandLogRef, 'ref'>,
): CommandLogRef | null {
  try {
    return { ref: journal.writeLog(name, text), ...facts };
  } catch {
    return null;
  }
}

/** Whether a receipt may be followed by running the same command again without asking a human. */
export function mayRetry(r: CommandReceipt): boolean {
  if (r.status === 'not_launched') return true;
  return r.status === 'unknown' ? r.retry === 'safe' : true;
}

export async function runCommand(deps: CommandDeps, spec: CommandSpec): Promise<CommandReceipt> {
  const raw = await execute(deps, spec);
  // The receipt is journaled and reported: the command line and diagnostics may carry a secret.
  const receipt: CommandReceipt = {
    ...raw,
    command: deps.redactor.text(raw.command),
    detail: raw.detail === null ? null : deps.redactor.text(raw.detail),
  };
  deps.journal?.append({ kind: 'receipt', receipt });
  return receipt;
}

/**
 * A host command gets a short private TMPDIR: the scratch dir under a long data dir leaves no room for a Unix
 * socket path (108 bytes) that a test makes under it. Commands of one scratch run one at a time.
 */
async function execute(deps: CommandDeps, spec: CommandSpec): Promise<CommandReceipt> {
  if (deps.sandbox.provider !== 'host' || spec.layout.tmp_dir !== undefined)
    return executeIn(deps, spec);
  const tmp = shortTmpDir(spec.layout.scratch);
  try {
    rmSync(tmp, { recursive: true, force: true });
    ensurePrivateTmpDir(tmp);
  } catch (e) {
    return {
      role: spec.role,
      name: spec.name,
      command: spec.command,
      command_digest: hashText(spec.command),
      retry: RETRY_SAFETY[spec.role],
      layout_digest: null,
      status: 'not_launched',
      exit_code: null,
      started_at: null,
      finished_at: deps.clock.now(),
      wall_ms: spec.wall_ms,
      output: { digest: hashText(''), bytes: 0, tail: '', truncated: false },
      detail: `tmp dir: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  try {
    return await executeIn(deps, {
      ...spec,
      layout: { ...spec.layout, tmp_dir: tmp },
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function executeIn(deps: CommandDeps, spec: CommandSpec): Promise<CommandReceipt> {
  const now = deps.clock.now();
  const left = spec.deadline_at === null ? Number.POSITIVE_INFINITY : spec.deadline_at - now;
  const remaining = Math.min(spec.wall_ms ?? Infinity, left);
  const wall = Number.isFinite(remaining) ? remaining : null;
  const base = {
    role: spec.role,
    name: spec.name,
    command: spec.command,
    command_digest: hashText(spec.command),
    retry: RETRY_SAFETY[spec.role],
  };
  const none = { digest: hashText(''), bytes: 0, tail: '', truncated: false };
  if (wall !== null && wall <= 0) {
    return {
      ...base,
      layout_digest: null,
      status: 'deadline',
      exit_code: null,
      started_at: null,
      finished_at: now,
      wall_ms: 0,
      output: none,
      detail: 'task deadline reached before the command started',
    };
  }
  const plan = deps.sandbox.plan({ ...spec.layout, role: spec.role, private_home: null }, [
    '/bin/sh',
    '-c',
    spec.command,
  ]);
  if (!plan.ok) {
    return {
      ...base,
      layout_digest: null,
      status: 'not_launched',
      exit_code: null,
      started_at: null,
      finished_at: deps.clock.now(),
      wall_ms: wall,
      output: none,
      detail: `${plan.error.code}: ${plan.error.message}`,
    };
  }
  const started = deps.clock.now();
  try {
    deps.journal?.append({
      kind: 'started',
      role: spec.role,
      name: spec.name,
      command_digest: base.command_digest,
      at: started,
    });
  } catch (e) {
    // No durable record that it may run: it does not run.
    return {
      ...base,
      layout_digest: plan.value.layout_digest,
      status: 'not_launched',
      exit_code: null,
      started_at: null,
      finished_at: deps.clock.now(),
      wall_ms: wall,
      output: none,
      detail: `journal: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const running: CommandRunning = {
    gate: spec.name,
    role: spec.role,
    started_at: started,
    last_output_at: null,
  };
  deps.journal?.markRunning(running);
  let written: number | null = null;
  const r = await deps.executor.run(plan.value, {
    timeout_ms: wall,
    max_output_bytes: OUTPUT_BYTES,
    on_output: () => {
      const at = deps.clock.now();
      if (written !== null && at - written < RUNNING_WRITE_MS) return;
      written = at;
      deps.journal?.markRunning({ ...running, last_output_at: at });
    },
  });
  deps.journal?.markRunning(null);
  const finished = deps.clock.now();
  const { text: raw, total_bytes: total } =
    r.kind === 'not_launched' ? { text: '', total_bytes: 0 } : joinCapture(r, deps.redactor);
  const redacted = deps.redactor.text(raw);
  const digest = hashText(redacted);
  const truncated =
    r.kind !== 'not_launched' && (r.end !== undefined || ('truncated' in r && r.truncated));
  const bytes = Buffer.byteLength(redacted);
  const output = {
    digest,
    bytes,
    tail: tail(redacted),
    truncated,
    excerpt: excerptOf(redacted, total, EXCERPT_BYTES),
    ...(r.kind === 'not_launched' || deps.journal === undefined
      ? {}
      : {
          log: writeLog(deps.journal, spec.name, redacted, {
            digest,
            bytes,
            truncated,
            wall_ms: finished - started,
          }),
        }),
  };
  const common = {
    ...base,
    layout_digest: plan.value.layout_digest,
    wall_ms: wall,
    finished_at: finished,
    output,
  };
  switch (r.kind) {
    case 'exited':
      return {
        ...common,
        status: r.code === 0 ? 'passed' : 'failed',
        exit_code: r.code,
        started_at: started,
        detail: null,
      };
    case 'timeout':
      return {
        ...common,
        status: 'timeout',
        exit_code: null,
        started_at: started,
        detail: `killed after ${wall} ms`,
      };
    case 'not_launched':
      return {
        ...common,
        status: 'not_launched',
        exit_code: null,
        started_at: null,
        detail: r.message,
      };
    case 'unknown':
      return {
        ...common,
        status: 'unknown',
        exit_code: null,
        started_at: started,
        detail: r.message,
      };
  }
}

const untruncated = (capture: OutputCapture): Omit<Captured, 'truncated'> => {
  const { output, end } = capture.result();
  return { output, ...(end === undefined ? {} : { end }) };
};

/**
 * Spawns the plan's argv directly in its own process group; the group is killed on timeout. A stop
 * request prevents the spawn, or sends the running group SIGTERM and, after the grace, SIGKILL.
 */
export class SpawnExecutor implements CommandExecutor {
  readonly #termGraceMs: number;
  constructor(o: { readonly term_grace_ms?: number } = {}) {
    this.#termGraceMs = o.term_grace_ms ?? STOP_TERM_GRACE_MS;
  }

  run(
    plan: SandboxLaunchPlan,
    opts: {
      readonly timeout_ms: number | null;
      readonly max_output_bytes: number;
      readonly signal?: AbortSignal;
      readonly on_output?: () => void;
    },
  ): Promise<ExecOutcome> {
    const [file, ...args] = plan.argv;
    if (file === undefined) return Promise.resolve({ kind: 'not_launched', message: 'empty argv' });
    if (opts.signal?.aborted === true)
      return Promise.resolve({
        kind: 'not_launched',
        message: 'stopped before start',
      });
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(file, args, {
          cwd: plan.cwd,
          env: { ...plan.env, ...operationEnv() },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
      } catch (e) {
        resolve({
          kind: 'not_launched',
          message: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      const capture = new OutputCapture(opts.max_output_bytes);
      let timedOut = false;
      let spawned = false;
      const take = (b: Buffer): void => {
        opts.on_output?.();
        capture.take(b);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('spawn', () => {
        spawned = true;
      });
      const kill = (sig: NodeJS.Signals): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, sig);
        } catch {
          child.kill(sig);
        }
      };
      const timer =
        opts.timeout_ms === null
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              kill('SIGKILL');
            }, opts.timeout_ms);
      let stoppedAt: number | null = null;
      let grace: NodeJS.Timeout | undefined;
      // TERM now and KILL after the grace, scheduled at the stop itself: a leader that ignores TERM
      // never closes, so nothing may wait for its close to escalate (FR-009).
      const onStop = (): void => {
        stoppedAt = Date.now();
        kill('SIGTERM');
        grace = setTimeout(() => kill('SIGKILL'), this.#termGraceMs);
      };
      opts.signal?.addEventListener('abort', onStop, { once: true });
      const done = (): void => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onStop);
      };
      // The group outlives its leader when a child ignores TERM and holds no pipe of ours: the stop is
      // over only once the whole group is gone, killed after the grace if it must be (FR-009).
      const groupAlive = (): boolean => {
        if (child.pid === undefined) return false;
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const endStop = async (at: number): Promise<boolean> => {
        const pause = (): Promise<void> => new Promise((r) => setTimeout(r, 50));
        while (groupAlive() && Date.now() < at + this.#termGraceMs) await pause();
        clearTimeout(grace);
        if (groupAlive()) kill('SIGKILL');
        const until = Date.now() + STOP_KILL_VERIFY_MS;
        while (groupAlive() && Date.now() < until) await pause();
        return !groupAlive();
      };
      child.on('error', (e) => {
        done();
        resolve(
          spawned
            ? {
                kind: 'unknown',
                message: e.message,
                ...untruncated(capture),
                ...(stoppedAt === null ? {} : { stop: 'unverified' as const }),
              }
            : { kind: 'not_launched', message: e.message },
        );
      });
      child.on('close', (code, signal) => {
        done();
        const captured = capture.result();
        if (timedOut) return resolve({ kind: 'timeout', ...captured });
        if (stoppedAt !== null) {
          void endStop(stoppedAt).then((gone) =>
            resolve({
              kind: 'unknown',
              message: `stopped on request (${signal ?? `exit ${String(code)}`})${gone ? '' : '; process group not verified gone'}`,
              ...untruncated(capture),
              stop: gone ? 'verified' : 'unverified',
            }),
          );
          return;
        }
        if (code === null)
          return resolve({
            kind: 'unknown',
            message: `terminated by ${signal ?? 'unknown signal'}`,
            ...untruncated(capture),
          });
        resolve({ kind: 'exited', code, ...captured });
      });
    });
  }
}
