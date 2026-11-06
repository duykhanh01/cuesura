/**
 * The task's own worktree and branch (T036, FR-003, contracts/execution.md).
 * One branch `cusr/<task_id>-<slug>` and one worktree per task, created from the frozen base. An owner
 * marker is written outside every agent-writable area before anything is created, so a crash between
 * the two steps is resumed rather than mistaken for someone else's worktree.
 *
 * A worktree is never adopted by its path alone: marker, branch, worktree registration, common dir and
 * base ancestry must all agree. Anything else is reported as a mismatch and left as found: nothing here
 * removes, resets or force-moves a worktree, a branch or the original repo.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { GitPort, GitResult } from '../ports.ts';

const GIT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_BYTES = 1024 * 1024;
const SLUG_MAX = 40;

export const OwnerMarkerSchema = z
  .object({
    schema_version: z.literal(1),
    task_id: z.string().min(1),
    project_realpath: z.string().startsWith('/'),
    common_git_dir: z.string().startsWith('/'),
    worktree_path: z.string().startsWith('/'),
    branch: z.string().min(1),
    base_sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
    nonce: z.string().min(1),
  })
  .strict();
export type OwnerMarker = z.infer<typeof OwnerMarkerSchema>;

export type WorktreeSpec = {
  readonly task_id: string;
  readonly title: string;
  readonly project_realpath: string;
  readonly common_git_dir: string;
  readonly base_sha: string;
  /** Commit the new worktree checks out, when it is not the base: the head of an adopted PR. */
  readonly start_sha?: string;
  /** Parent of every task worktree, outside the project repo. */
  readonly worktrees_root: string;
  /** Directory of owner markers; never mounted into a sandbox. */
  readonly markers_dir: string;
  readonly nonce: string;
};

export type WorktreeMismatch =
  | 'not_owned'
  | 'marker_conflict'
  | 'branch_mismatch'
  | 'base_not_ancestor'
  | 'worktree_missing'
  | 'common_dir_mismatch';

export type WorktreeOutcome =
  | {
      readonly kind: 'created' | 'adopted';
      readonly worktree_path: string;
      readonly branch: string;
      readonly head: string;
      readonly marker: OwnerMarker;
    }
  | {
      readonly kind: 'mismatch';
      readonly reason: WorktreeMismatch;
      readonly detail: string;
    }
  /** Git did not answer (timeout, spawn, refused): nothing is known, nothing was changed after the marker. */
  | { readonly kind: 'unknown'; readonly detail: string };

/** `cusr/<task_id>-<slug>`: ASCII, lower case, a valid ref component. */
export function taskBranch(taskId: string, title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug === '' ? `cusr/${taskId}` : `cusr/${taskId}-${slug}`;
}

export function markerPath(markersDir: string, taskId: string): string {
  return join(markersDir, `${taskId}.json`);
}

export function readMarker(markersDir: string, taskId: string): OwnerMarker | 'corrupt' | null {
  let text: string;
  try {
    text = readFileSync(markerPath(markersDir, taskId), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const parsed = OwnerMarkerSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : 'corrupt';
  } catch {
    return 'corrupt';
  }
}

/** Creates the marker once (O_EXCL), fsynced with its directory; false when one already exists. */
function createMarker(markersDir: string, m: OwnerMarker): boolean {
  mkdirSync(markersDir, { recursive: true, mode: 0o700 });
  const path = markerPath(markersDir, m.task_id);
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    writeSync(fd, `${JSON.stringify(m)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dfd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
  return true;
}

class GitUnknown extends Error {}

async function git(
  port: GitPort,
  cwd: string,
  args: readonly string[],
): Promise<Extract<GitResult, { kind: 'exited' }>> {
  const r = await port.run({
    args,
    cwd,
    timeout_ms: GIT_TIMEOUT_MS,
    max_output_bytes: GIT_OUTPUT_BYTES,
    stdin: null,
  });
  if (r.kind === 'exited') return r;
  throw new GitUnknown(
    r.kind === 'refused' ? `refused: ${r.reason}` : r.kind === 'spawn_failed' ? r.message : r.kind,
  );
}

type Registered = { path: string; head: string | null; branch: string | null };

/** `git worktree list --porcelain` of the project. */
export async function listWorktrees(port: GitPort, project: string): Promise<Registered[]> {
  const r = await git(port, project, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) throw new GitUnknown(`worktree list failed: ${r.stderr.trim()}`);
  const out: Registered[] = [];
  for (const block of r.stdout.split('\n\n')) {
    const lines = block.split('\n');
    const path = lines.find((l) => l.startsWith('worktree '))?.slice(9);
    if (path === undefined) continue;
    out.push({
      path,
      head: lines.find((l) => l.startsWith('HEAD '))?.slice(5) ?? null,
      branch: lines.find((l) => l.startsWith('branch '))?.slice(7) ?? null,
    });
  }
  return out;
}

async function refOid(port: GitPort, cwd: string, ref: string): Promise<string | null> {
  const r = await git(port, cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Creates the task worktree from the frozen base, or adopts the one this task created before. Never
 * removes or resets anything; a mismatch is returned for the engine to wait on.
 */
export async function ensureWorktree(port: GitPort, spec: WorktreeSpec): Promise<WorktreeOutcome> {
  try {
    return await ensure(port, spec);
  } catch (e) {
    if (e instanceof GitUnknown) return { kind: 'unknown', detail: e.message };
    throw e;
  }
}

async function ensure(port: GitPort, spec: WorktreeSpec): Promise<WorktreeOutcome> {
  const branch = taskBranch(spec.task_id, spec.title);
  const path = join(spec.worktrees_root, spec.task_id);
  const project = spec.project_realpath;
  const wanted: OwnerMarker = {
    schema_version: 1,
    task_id: spec.task_id,
    project_realpath: project,
    common_git_dir: spec.common_git_dir,
    worktree_path: path,
    branch,
    base_sha: spec.base_sha,
    nonce: spec.nonce,
  };

  const existing = readMarker(spec.markers_dir, spec.task_id);
  if (existing === 'corrupt')
    return {
      kind: 'mismatch',
      reason: 'marker_conflict',
      detail: 'owner marker is unreadable',
    };
  const marker = existing ?? wanted;
  if (
    existing !== null &&
    (existing.project_realpath !== project ||
      existing.worktree_path !== path ||
      existing.branch !== branch)
  ) {
    return {
      kind: 'mismatch',
      reason: 'marker_conflict',
      detail: `marker records ${existing.branch} at ${existing.worktree_path}`,
    };
  }
  if (existing !== null && existing.common_git_dir !== spec.common_git_dir) {
    return {
      kind: 'mismatch',
      reason: 'common_dir_mismatch',
      detail: `marker records ${existing.common_git_dir}`,
    };
  }

  const registered = (await listWorktrees(port, project)).find((w) => w.path === path) ?? null;
  const branchOid = await refOid(port, project, `refs/heads/${branch}`);

  if (registered === null && branchOid === null) {
    // Nothing exists yet. Without a marker, first claim ownership; with ours, resume the interrupted create.
    if (existing === null && !createMarker(spec.markers_dir, wanted))
      return {
        kind: 'mismatch',
        reason: 'marker_conflict',
        detail: 'marker appeared concurrently',
      };
    const start = spec.start_sha ?? marker.base_sha;
    const add = await git(port, project, [
      'worktree',
      'add',
      '-b',
      branch,
      path,
      `${start}^{commit}`,
    ]);
    if (add.code !== 0)
      return {
        kind: 'mismatch',
        reason: 'not_owned',
        detail: `worktree add failed: ${add.stderr.trim().slice(0, 512)}`,
      };
    const head = await refOid(port, path, 'HEAD');
    if (head !== start)
      return {
        kind: 'unknown',
        detail: `new worktree HEAD ${head ?? 'none'} is not ${start}`,
      };
    return { kind: 'created', worktree_path: path, branch, head, marker };
  }

  // Something exists: only this task's marker can claim it, and every fact must agree.
  if (existing === null)
    return {
      kind: 'mismatch',
      reason: 'not_owned',
      detail:
        registered !== null
          ? `worktree ${path} exists without an owner marker`
          : `branch ${branch} exists without an owner marker`,
    };
  if (registered === null)
    return {
      kind: 'mismatch',
      reason: 'worktree_missing',
      detail: `branch ${branch} exists but worktree ${path} is not registered`,
    };
  if (registered.branch !== `refs/heads/${branch}`)
    return {
      kind: 'mismatch',
      reason: 'branch_mismatch',
      detail: `worktree is on ${registered.branch ?? 'a detached HEAD'}`,
    };
  const common = await git(port, path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.code !== 0 || common.stdout.trim() !== spec.common_git_dir) {
    return {
      kind: 'mismatch',
      reason: 'common_dir_mismatch',
      detail: common.code === 0 ? common.stdout.trim() : common.stderr.trim(),
    };
  }
  const head = await refOid(port, path, 'HEAD');
  if (head === null) return { kind: 'unknown', detail: 'worktree HEAD does not resolve' };
  const ancestor = await git(port, path, ['merge-base', '--is-ancestor', marker.base_sha, head]);
  if (ancestor.code !== 0)
    return {
      kind: 'mismatch',
      reason: 'base_not_ancestor',
      detail: `${marker.base_sha} is not an ancestor of ${head}`,
    };
  return { kind: 'adopted', worktree_path: path, branch, head, marker };
}
