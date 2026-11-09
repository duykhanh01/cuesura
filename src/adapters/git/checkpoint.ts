/**
 * Worktree checkpoints (T036, FR-003/004). Before a step that may write, the orchestrator records the
 * full working state as Git objects: every change (tracked, untracked, deleted) is staged into the
 * worktree's own index and written as a tree; parent is HEAD. The digest covers the raw diff between
 * parent and tree, so two checkpoints compare by value. Nothing is committed, reset or discarded.
 */
import { WorktreeCheckpointSchema, type WorktreeCheckpoint } from '../../domain/runtime.ts';
import { hashText } from '../../shared/hash.ts';
import type { GitPort, GitResult } from '../ports.ts';

const GIT_TIMEOUT_MS = 120_000;
const RAW_DIFF_BYTES = 8 * 1024 * 1024;

export type CheckpointSpec = {
  readonly task_id: string;
  readonly revision: number;
  readonly project_realpath: string;
  readonly common_git_dir: string;
  readonly worktree_path: string;
  readonly branch: string;
  readonly base_sha: string;
  /** Path of the owner marker that proves this worktree belongs to the task. */
  readonly owner_marker: string;
};

export type CheckpointError = {
  readonly kind: 'unknown' | 'invalid';
  readonly detail: string;
};

async function git(
  port: GitPort,
  cwd: string,
  args: readonly string[],
  maxBytes = 64 * 1024,
): Promise<Extract<GitResult, { kind: 'exited' }> | CheckpointError> {
  const r = await port.run({
    args,
    cwd,
    timeout_ms: GIT_TIMEOUT_MS,
    max_output_bytes: maxBytes,
    stdin: null,
  });
  if (r.kind === 'exited') return r;
  return {
    kind: 'unknown',
    detail:
      r.kind === 'refused'
        ? `refused: ${r.reason}`
        : r.kind === 'spawn_failed'
          ? r.message
          : r.kind,
  };
}

const failed = (r: Extract<GitResult, { kind: 'exited' }>, what: string): CheckpointError => ({
  kind: 'unknown',
  detail: `${what}: ${r.stderr.trim().slice(0, 512)}`,
});

export async function takeCheckpoint(
  port: GitPort,
  spec: CheckpointSpec,
): Promise<{ ok: true; value: WorktreeCheckpoint } | { ok: false; error: CheckpointError }> {
  const cwd = spec.worktree_path;
  const branch = await git(port, cwd, ['symbolic-ref', '--quiet', 'HEAD']);
  if ('detail' in branch) return { ok: false, error: branch };
  if (branch.code !== 0 || branch.stdout.trim() !== `refs/heads/${spec.branch}`) {
    return {
      ok: false,
      error: {
        kind: 'invalid',
        detail: `worktree HEAD is ${branch.code === 0 ? branch.stdout.trim() : 'detached'}, not ${spec.branch}`,
      },
    };
  }
  const add = await git(port, cwd, ['add', '--all', '--', '.']);
  if ('detail' in add) return { ok: false, error: add };
  if (add.code !== 0) return { ok: false, error: failed(add, 'git add') };
  const tree = await git(port, cwd, ['write-tree']);
  if ('detail' in tree) return { ok: false, error: tree };
  if (tree.code !== 0) return { ok: false, error: failed(tree, 'git write-tree') };
  const parent = await git(port, cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if ('detail' in parent) return { ok: false, error: parent };
  if (parent.code !== 0) return { ok: false, error: failed(parent, 'git rev-parse HEAD') };
  const treeOid = tree.stdout.trim();
  const parentOid = parent.stdout.trim();
  const raw = await git(
    port,
    cwd,
    ['diff-tree', '-r', '--raw', '--no-renames', '-z', parentOid, treeOid],
    RAW_DIFF_BYTES,
  );
  if ('detail' in raw) return { ok: false, error: raw };
  if (raw.code !== 0) return { ok: false, error: failed(raw, 'git diff-tree') };
  if (raw.truncated)
    return {
      ok: false,
      error: {
        kind: 'invalid',
        detail: `diff listing exceeds ${RAW_DIFF_BYTES} bytes`,
      },
    };

  const parsed = WorktreeCheckpointSchema.safeParse({
    task_id: spec.task_id,
    revision: spec.revision,
    project_realpath: spec.project_realpath,
    common_git_dir: spec.common_git_dir,
    worktree_path: cwd,
    branch: spec.branch,
    base_sha: spec.base_sha,
    tree_oid: treeOid,
    parent_oid: parentOid,
    diff_digest: hashText(raw.stdout),
    owner_marker: spec.owner_marker,
  });
  if (!parsed.success)
    return {
      ok: false,
      error: {
        kind: 'invalid',
        detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      },
    };
  return { ok: true, value: parsed.data };
}

/**
 * Compares the worktree with a recorded checkpoint by value (tree, parent, digest, ownership), never by
 * path alone. `changed` lists what differs; the caller keeps the diff and waits instead of resetting.
 */
export async function compareCheckpoint(
  port: GitPort,
  recorded: WorktreeCheckpoint,
): Promise<
  | { kind: 'same' }
  | { kind: 'changed'; fields: string[]; current: WorktreeCheckpoint }
  | { kind: 'error'; error: CheckpointError }
> {
  const now = await takeCheckpoint(port, recorded);
  if (!now.ok) return { kind: 'error', error: now.error };
  const fields = (
    ['tree_oid', 'parent_oid', 'diff_digest', 'common_git_dir', 'owner_marker'] as const
  ).filter((k) => now.value[k] !== recorded[k]);
  return fields.length === 0 ? { kind: 'same' } : { kind: 'changed', fields, current: now.value };
}
