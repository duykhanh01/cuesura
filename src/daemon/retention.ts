/**
 * Artifact retention (T074, FR-016, contracts/execution.md). A run directory is
 * removed only when all of these hold: its task is terminal, its exit.json is complete, every artifact
 * in it was committed by the store (ACK = `ArtifactIngested` for exactly that digest), and it ended
 * more than `terminal_retention_ms` (30 days) ago. What is removed leaves a tombstone with the
 * digests, so the history still says what existed. Command logs of an ended task go sooner, after
 * {@link COMMAND_LOG_RETENTION_MS}, also leaving a tombstone. The production daemon runs a pass at
 * start and whenever a task has ended since the last one (production.ts), never on a timer of its own.
 *
 * Worktrees are never removed by age alone: a worktree whose diff or commits are not preserved (not on
 * the remote at the recorded head) is a local remainder and stays, whatever its age.
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Artifact } from '../domain/runtime.ts';
import { isTerminal, TERMINAL_STATUSES, type TaskState } from '../domain/state.ts';
import { collectArtifacts } from '../runner/artifacts.ts';
import { COMMAND_LOG_DIR } from '../runner/commands.ts';
import { RUN_FILES, RunDir, type RunDirKind } from '../runner/files.ts';
import { RunnerExitSchema } from '../runner/lifecycle.ts';
import type { Redactor } from '../runner/redact.ts';
import type { Uuid } from '../shared/brand.ts';
import type { Store } from '../store/index.ts';

export const TOMBSTONE_FILE = 'tombstone.json';

export type RunEntry = {
  readonly kind: RunDirKind;
  readonly id: string;
  readonly operation_id: string;
  readonly task_terminal: boolean;
  /** exit.json `ended_at`; null when the run has no complete exit record. */
  readonly ended_at: number | null;
  readonly artifacts: readonly Artifact[];
  /** Digest the store committed per artifact id. */
  readonly committed: Readonly<Record<string, string>>;
  readonly tombstoned: boolean;
};

export type WorktreeEntry = {
  readonly task_id: string;
  readonly path: string;
  readonly task_terminal: boolean;
  /** Terminal time of the task. */
  readonly ended_at: number | null;
  /** Clean and its head is on the remote; anything else is a local remainder. */
  readonly preserved: boolean;
};

export type KeepReason =
  | 'task_not_terminal'
  | 'not_finalized'
  | 'not_acked'
  | 'too_recent'
  | 'tombstoned'
  | 'unpreserved_worktree';

export type RetentionPlan = {
  readonly delete_runs: readonly RunEntry[];
  readonly keep_runs: readonly {
    readonly id: string;
    readonly reason: KeepReason;
  }[];
  readonly delete_worktrees: readonly WorktreeEntry[];
  readonly keep_worktrees: readonly {
    readonly path: string;
    readonly reason: KeepReason;
  }[];
};

/** Pure: what may go now. */
export function planRetention(o: {
  readonly runs: readonly RunEntry[];
  readonly worktrees: readonly WorktreeEntry[];
  readonly now: number;
  readonly retention_ms: number;
}): RetentionPlan {
  const del: RunEntry[] = [];
  const keep: { id: string; reason: KeepReason }[] = [];
  for (const r of o.runs) {
    const reason: KeepReason | null = r.tombstoned
      ? 'tombstoned'
      : !r.task_terminal
        ? 'task_not_terminal'
        : r.ended_at === null || r.artifacts.some((a) => !a.finalized)
          ? 'not_finalized'
          : r.artifacts.some((a) => r.committed[a.artifact_id] !== a.digest)
            ? 'not_acked'
            : o.now - r.ended_at < o.retention_ms
              ? 'too_recent'
              : null;
    if (reason === null) del.push(r);
    else keep.push({ id: r.id, reason });
  }
  const delW: WorktreeEntry[] = [];
  const keepW: { path: string; reason: KeepReason }[] = [];
  for (const w of o.worktrees) {
    const reason: KeepReason | null = !w.task_terminal
      ? 'task_not_terminal'
      : !w.preserved
        ? 'unpreserved_worktree'
        : w.ended_at === null || o.now - w.ended_at < o.retention_ms
          ? 'too_recent'
          : null;
    if (reason === null) delW.push(w);
    else keepW.push({ path: w.path, reason });
  }
  return {
    delete_runs: del,
    keep_runs: keep,
    delete_worktrees: delW,
    keep_worktrees: keepW,
  };
}

/**
 * Replaces a run directory's content with its tombstone. The tombstone is written first (atomically),
 * so a crash in between leaves a tombstoned directory with some files still present, never a directory
 * whose history is gone; {@link clearTombstonedRun} finishes such a directory. Returns the bytes freed.
 */
export function tombstoneRun(run: RunDir, entry: RunEntry, now: number): number {
  run.writeJson(TOMBSTONE_FILE, {
    schema_version: 1,
    kind: entry.kind,
    id: entry.id,
    operation_id: entry.operation_id,
    ended_at: entry.ended_at,
    removed_at: now,
    artifacts: entry.artifacts.map((a) => ({
      artifact_id: a.artifact_id,
      kind: a.kind,
      relative_path: a.relative_path,
      digest: a.digest,
      bytes: a.bytes,
    })),
  });
  return clearTombstonedRun(run);
}

/** Removes what a tombstoned run directory still holds besides its tombstone; returns the bytes freed. */
export function clearTombstonedRun(run: RunDir): number {
  let freed = 0;
  // The runner hard-links events.jsonl to its active spool segment: count each inode once.
  const seen = new Set<string>();
  for (const name of readdirSync(run.dir)) {
    if (name === TOMBSTONE_FILE) continue;
    const path = join(run.dir, name);
    const bytes = treeBytes(path, seen);
    rmSync(path, { recursive: true, force: true });
    freed += bytes;
  }
  return freed;
}

function treeBytes(path: string, seen: Set<string>): number {
  const st = lstatSync(path);
  if (!st.isDirectory()) {
    const key = `${st.dev}:${st.ino}`;
    if (seen.has(key)) return 0;
    seen.add(key);
    return st.size;
  }
  let total = 0;
  for (const name of readdirSync(path)) total += treeBytes(join(path, name), seen);
  return total;
}

/** Where an operation's runner files live: its attempt's run directory, or its own. */
export function runLocation(op: { readonly id: string; readonly attempt_id: string | null }): {
  kind: RunDirKind;
  id: string;
} {
  return op.attempt_id === null
    ? { kind: 'operations', id: op.id }
    : { kind: 'runs', id: op.attempt_id };
}

/** The run entries of one task as the store and the run directories describe them. */
export function taskRunEntries(
  s: TaskState,
  o: {
    readonly dataDir: string;
    readonly redactor: Redactor;
    readonly terminal: boolean;
  },
): RunEntry[] {
  const out: RunEntry[] = [];
  for (const op of Object.values(s.operations)) {
    const { kind, id } = runLocation(op);
    let run: RunDir;
    try {
      run = RunDir.open({
        dataDir: o.dataDir,
        kind,
        id,
        redactor: o.redactor,
        create: false,
      });
    } catch {
      continue;
    }
    const tombstoned = run.readFinal(TOMBSTONE_FILE).state === 'valid';
    const exit = run.readFinal(RUN_FILES.exit, RunnerExitSchema);
    const arts = tombstoned ? { ok: true as const, value: [] } : collectArtifacts(run, op.id);
    const committed: Record<string, string> = {};
    for (const a of Object.values(s.artifacts))
      if (a.operation_id === op.id) committed[a.artifact_id] = a.digest;
    out.push({
      kind,
      id,
      operation_id: op.id,
      task_terminal: o.terminal,
      ended_at: exit.state === 'valid' ? exit.value.ended_at : null,
      // A run whose files cannot be indexed is kept: nothing unverifiable is deleted.
      artifacts: arts.ok ? arts.value : [{ ...placeholder(op.id), finalized: false }],
      committed,
      tombstoned,
    });
  }
  return out;
}

function placeholder(operationId: string): Artifact {
  return {
    artifact_id: `${operationId}:unindexable`,
    operation_id: operationId,
    kind: 'evidence',
    relative_path: 'unindexable',
    digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    bytes: 0,
    redaction_version: 1,
    finalized: false,
    acked: false,
  };
}

/** How long an ended task's command logs (setup, gate, autofix) are kept; run artifacts keep `terminal_retention_ms`. */
export const COMMAND_LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Replaces an effect's command logs with a tombstone once the newest is past retention, aged by the
 * newest file, not the directory. Their digests stay in the events; the tombstone goes first, so a crash
 * in between never loses the fact they existed. Returns the bytes freed, or null when nothing expired.
 */
export function expireCommandLogs(dir: string, now: number, retentionMs: number): number | null {
  if (!existsSync(dir)) return null;
  const logs = readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => ({ name: f, stat: statSync(join(dir, f)) }));
  if (logs.length === 0) return null;
  const newest = Math.max(...logs.map((l) => l.stat.mtimeMs));
  if (now - newest < retentionMs) return null;
  // A pass that died between the tombstone and the last removal left a tombstone listing every file.
  const previous = readTombstoneFiles(join(dir, TOMBSTONE_FILE));
  const files = [...new Set([...previous, ...logs.map((l) => l.name)])].sort();
  const temp = join(dir, `${TOMBSTONE_FILE}.tmp`);
  const body = { schema_version: 1, removed_at: now, files };
  writeFileSync(temp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  renameSync(temp, join(dir, TOMBSTONE_FILE));
  let freed = 0;
  for (const l of logs) {
    rmSync(join(dir, l.name), { force: true });
    freed += l.stat.size;
  }
  return freed;
}

function readTombstoneFiles(path: string): string[] {
  try {
    const files: unknown = (JSON.parse(readFileSync(path, 'utf8')) as { files?: unknown }).files;
    return Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

export type RetentionReport = {
  readonly plan: RetentionPlan;
  /** Runs tombstoned by this pass. */
  readonly removed_runs: number;
  /** Effects whose command logs were tombstoned by this pass. */
  readonly expired_logs: number;
  readonly freed_bytes: number;
  /** Removals that failed; each is retried by the next pass. */
  readonly failures: readonly string[];
};

/**
 * One retention pass over the terminal tasks of the store: plans each task's runs with
 * {@link planRetention}, tombstones the runs that may go and expires command logs past
 * `command_log_retention_ms`. It never writes the store, so a failure or a crash mid-pass leaves the
 * store intact and the next pass picks up where this one stopped. `pause` runs between tasks so a pass
 * over many tasks does not hold the event loop. Worktrees are left to their owner.
 */
export async function sweepRetention(o: {
  readonly store: Store;
  readonly dataDir: string;
  readonly redactor: Redactor;
  readonly now: number;
  readonly retention_ms: number;
  readonly command_log_retention_ms: number;
  readonly pause?: () => Promise<void>;
}): Promise<RetentionReport> {
  const pause = o.pause ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const plans: RetentionPlan[] = [];
  const failures: string[] = [];
  let removedRuns = 0;
  let expiredLogs = 0;
  let freed = 0;
  const attempt = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      failures.push(`${what}: ${o.redactor.text(e instanceof Error ? e.message : String(e))}`);
    }
  };
  for (const id of o.store.taskIdsByStatus(TERMINAL_STATUSES)) {
    await pause();
    const s = o.store.readTask(id as Uuid);
    if (s === null || !isTerminal(s.status)) continue;
    let runs: RunEntry[] = [];
    attempt(`task ${id}`, () => {
      runs = taskRunEntries(s, { dataDir: o.dataDir, redactor: o.redactor, terminal: true });
    });
    const plan = planRetention({ runs, worktrees: [], now: o.now, retention_ms: o.retention_ms });
    plans.push(plan);
    for (const r of runs) {
      const remove = plan.delete_runs.includes(r);
      if (!remove && !r.tombstoned) continue;
      attempt(`run ${r.kind}/${r.id}`, () => {
        const run = RunDir.open({
          dataDir: o.dataDir,
          kind: r.kind,
          id: r.id,
          redactor: o.redactor,
          create: false,
        });
        freed += remove ? tombstoneRun(run, r, o.now) : clearTombstonedRun(run);
        if (remove) removedRuns += 1;
      });
    }
    for (const effect of Object.keys(s.effects ?? {}))
      attempt(`command logs of ${effect}`, () => {
        const bytes = expireCommandLogs(
          join(o.dataDir, 'receipts', effect, COMMAND_LOG_DIR),
          o.now,
          o.command_log_retention_ms,
        );
        if (bytes === null) return;
        expiredLogs += 1;
        freed += bytes;
      });
  }
  return {
    plan: {
      delete_runs: plans.flatMap((p) => p.delete_runs),
      keep_runs: plans.flatMap((p) => p.keep_runs),
      delete_worktrees: [],
      keep_worktrees: [],
    },
    removed_runs: removedRuns,
    expired_logs: expiredLogs,
    freed_bytes: freed,
    failures,
  };
}

/**
 * The daemon's retention round: the first call sweeps (daemon start), later calls sweep only when the
 * number of terminal tasks changed since the last pass, i.e. a task ended. It rides the daemon's
 * existing rounds, which never overlap themselves, so no timer of its own is needed.
 */
export function retentionRound(o: {
  readonly store: Store;
  readonly dataDir: string;
  readonly redactor: Redactor;
  readonly now: () => number;
  readonly retention_ms: number;
  readonly command_log_retention_ms?: number;
  readonly log?: (line: string) => void;
  readonly pause?: () => Promise<void>;
}): () => Promise<void> {
  let swept: number | null = null;
  return async () => {
    const counts = o.store.countTasksByStatus({ projects: null, statuses: TERMINAL_STATUSES });
    const terminal = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
    if (terminal === swept) return;
    swept = terminal;
    const r = await sweepRetention({
      store: o.store,
      dataDir: o.dataDir,
      redactor: o.redactor,
      now: o.now(),
      retention_ms: o.retention_ms,
      command_log_retention_ms: o.command_log_retention_ms ?? COMMAND_LOG_RETENTION_MS,
      ...(o.pause === undefined ? {} : { pause: o.pause }),
    });
    if (r.removed_runs > 0 || r.expired_logs > 0 || r.freed_bytes > 0)
      o.log?.(
        `retention: removed ${r.removed_runs} runs and ${r.expired_logs} command log sets, freed ${r.freed_bytes} bytes`,
      );
    for (const f of r.failures) o.log?.(`retention warning: ${f}; retried on the next pass`);
  };
}
