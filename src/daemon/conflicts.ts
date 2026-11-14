/**
 * Real conflicts between live branches (007, FR-092, R-25). After a task records a checkpoint, the daemon
 * runs `git merge-tree --write-tree` between that checkpoint and the head of every other live task of the
 * project whose changed files overlap it, and keeps what conflicts in `branch_conflicts`. Rows of a task
 * that ended go. Nothing here submits a trigger: a conflict never makes a task wait.
 */
import { mergeTreeConflicts } from '../adapters/git/base-conflicts.ts';
import type { GitPort } from '../adapters/ports.ts';
import { projectScopes } from '../application/scope.ts';
import { isTerminal, TASK_STATUSES, type TaskState } from '../domain/state.ts';
import type { Uuid } from '../shared/brand.ts';
import type { ConflictCheck, Store } from '../store/index.ts';

export type ConflictDeps = {
  readonly store: Store;
  readonly git: GitPort;
  /** Project path from the user config, for a task with no runtime snapshot yet. */
  readonly projectPath: (project: string) => Promise<string | null>;
  readonly now: () => number;
  readonly log?: (line: string) => void;
};

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const headOf = (s: TaskState): string | null => s.run.checkpoint?.sha ?? s.head_sha;

async function pathOf(deps: ConflictDeps, s: TaskState): Promise<string | null> {
  const rt =
    s.runtime_ref === null
      ? null
      : deps.store.readRuntimeContext(s.id as Uuid, s.runtime_ref.revision);
  if (rt?.project_path != null) return rt.project_path;
  try {
    return await deps.projectPath(s.project);
  } catch {
    return null;
  }
}

/** Conflicted files of merging the two heads; null when Git cannot say. */
async function mergeTree(
  git: GitPort,
  cwd: string,
  head: string,
  other: string,
): Promise<string[] | null> {
  try {
    const r = await git.run({
      args: ['merge-tree', '--write-tree', '--name-only', '-z', head, other],
      cwd,
      timeout_ms: 30_000,
      max_output_bytes: 1024 * 1024,
      stdin: null,
    });
    if (r.kind !== 'exited' || r.truncated || (r.code !== 0 && r.code !== 1)) return null;
    return r.code === 0 ? [] : mergeTreeConflicts(r.stdout);
  } catch {
    return null;
  }
}

/** Checks one task's checkpoint against the live branches it overlaps; false when a read failed. */
async function check(deps: ConflictDeps, s: TaskState, head: string): Promise<boolean> {
  const scope = (
    await projectScopes(
      { store: deps.store, git: deps.git, projectPath: deps.projectPath, now: deps.now },
      new Set([s.id]),
    )
  ).get(s.id);
  if (scope === undefined || scope.unknown.includes('overlaps')) return false;
  const cwd = await pathOf(deps, s);
  if (cwd === null) return false;
  const overlapping = new Set(scope.overlaps.map((o) => o.task_id));
  const checks: ConflictCheck[] = [];
  // Every other live task of the project gets a verdict, so a pair that no longer overlaps loses its row.
  for (const id of deps.store.taskIdsByStatus(TASK_STATUSES.filter((st) => !isTerminal(st)))) {
    if (id === s.id) continue;
    const other = deps.store.readTask(id as Uuid);
    const theirs = other === null ? null : headOf(other);
    if (other === null || other.project !== s.project || theirs === null || !SHA.test(theirs))
      continue;
    if (!overlapping.has(id)) {
      checks.push({ other_task_id: id, head, other_head: theirs, files: [] });
      continue;
    }
    const files = await mergeTree(deps.git, cwd, head, theirs);
    if (files === null) return false;
    checks.push({ other_task_id: id, head, other_head: theirs, files });
  }
  deps.store.conflicts.record(s.id, checks, deps.now());
  return true;
}

/** The daemon round: each checkpoint is checked once; a check that could not read runs again. */
export function conflictRound(deps: ConflictDeps): () => Promise<void> {
  const checked = new Map<string, string>();
  return async () => {
    const live = deps.store
      .taskIdsByStatus(TASK_STATUSES.filter((st) => !isTerminal(st)))
      .flatMap((id) => deps.store.readTask(id as Uuid) ?? []);
    const ids = new Set(live.map((s) => s.id));
    deps.store.conflicts.prune(ids);
    for (const id of checked.keys()) if (!ids.has(id)) checked.delete(id);
    for (const s of live) {
      const head = s.run.checkpoint?.sha ?? null;
      if (head === null || !SHA.test(head) || checked.get(s.id) === head) continue;
      try {
        if (await check(deps, s, head)) checked.set(s.id, head);
      } catch (e) {
        deps.log?.(`branch conflicts ${s.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
}
