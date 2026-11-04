/**
 * Artifact retention (T074, FR-016, contracts/execution.md). A run directory is
 * removed only when all of these hold: its task is terminal, its exit.json is complete, every artifact
 * in it was committed by the store (ACK = `ArtifactIngested` for exactly that digest), and it ended
 * more than `terminal_retention_ms` (30 days) ago. What is removed leaves a tombstone with the
 * digests, so the history still says what existed.
 *
 * Worktrees are never removed by age alone: a worktree whose diff or commits are not preserved (not on
 * the remote at the recorded head) is a local remainder and stays, whatever its age.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Artifact } from '../domain/runtime.ts';
import { isTerminal, TERMINAL_STATUSES, type TaskState } from '../domain/state.ts';
import { collectArtifacts } from '../runner/artifacts.ts';
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
 * whose history is gone.
 */
export function tombstoneRun(run: RunDir, entry: RunEntry, now: number): void {
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
  for (const name of readdirSync(run.dir))
    if (name !== TOMBSTONE_FILE) rmSync(join(run.dir, name), { recursive: true, force: true });
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

/**
 * One retention pass over the terminal tasks of the store: plans with {@link planRetention} and
 * tombstones the runs that may go. Worktrees are left to their owner (preserved ones are only
 * reported); the daemon schedules this pass once its production effect handlers are wired.
 */
export function sweepRetention(o: {
  readonly store: Store;
  readonly dataDir: string;
  readonly redactor: Redactor;
  readonly now: number;
  readonly retention_ms: number;
}): RetentionPlan {
  const runs: RunEntry[] = [];
  for (const id of o.store.taskIdsByStatus(TERMINAL_STATUSES)) {
    const s = o.store.readTask(id as Uuid);
    if (s === null) continue;
    runs.push(
      ...taskRunEntries(s, {
        dataDir: o.dataDir,
        redactor: o.redactor,
        terminal: isTerminal(s.status),
      }),
    );
  }
  const plan = planRetention({
    runs,
    worktrees: [],
    now: o.now,
    retention_ms: o.retention_ms,
  });
  for (const r of plan.delete_runs) {
    const run = RunDir.open({
      dataDir: o.dataDir,
      kind: r.kind,
      id: r.id,
      redactor: o.redactor,
      create: false,
    });
    tombstoneRun(run, r, o.now);
  }
  return plan;
}
