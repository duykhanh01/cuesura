/** Integrate a known target tip locally; the normal gate/review/publish path certifies it afterwards. */
import type { GitPort } from '../ports.ts';
import type { BaseUpdate, BaseConflict, BaseRepairScope } from '../../domain/runtime.ts';
import { takeCheckpoint, type CheckpointSpec } from './checkpoint.ts';
import { commitCheckpoint, type CommitIntentStore } from './commit.ts';

export type BaseUpdateOutcome =
  | { kind: 'updated'; head_sha: string }
  | { kind: 'conflict'; tree: string; files: string[] }
  | { kind: 'blocked' | 'unknown'; detail: string };

class Blocked extends Error {}

export const baseUpdateIntentKey = (
  spec: Pick<CheckpointSpec, 'task_id' | 'revision'>,
  update: BaseUpdate,
): string => `base-update:${spec.task_id}:r${spec.revision}:${update.head_sha}:${update.base_sha}`;

type Git = (args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string }>;

function gitIn(port: GitPort, cwd: string): Git {
  return async (args, timeoutMs = 30_000) => {
    const r = await port.run({
      args,
      cwd,
      timeout_ms: timeoutMs,
      max_output_bytes: 64 * 1024,
      stdin: null,
    });
    if (r.kind !== 'exited' || r.truncated) throw new Error(`git ${args[0]} unreadable: ${r.kind}`);
    return r;
  };
}

/**
 * Whether the local commit `merge` is exactly Git's clean merge of `base` into `head`: parents
 * `[head, base]` in that order, `base` not already in `head`, and the tree `merge-tree` writes without
 * conflicts. A resolved conflict, an edit or a third parent fails it whatever the commit message says.
 */
async function isCleanMerge(git: Git, head: string, base: string, merge: string): Promise<boolean> {
  const parents = await git(['rev-list', '--parents', '-n', '1', merge]);
  if (parents.code !== 0) throw new Error('merge parents unreadable');
  if (parents.stdout.trim() !== `${merge} ${head} ${base}`) return false;
  const contained = await git(['merge-base', '--is-ancestor', base, head]);
  if (contained.code === 0) return false;
  if (contained.code !== 1) throw new Error('base ancestry unreadable');
  const merged = await git(['merge-tree', '--write-tree', head, base]);
  if (merged.code === 1) return false;
  if (merged.code !== 0) throw new Error('merge-tree failed');
  const tree = await git(['rev-parse', `${merge}^{tree}`]);
  if (tree.code !== 0) throw new Error('merge tree unreadable');
  return merged.stdout.trim() === tree.stdout.trim();
}

export type BaseMergeCheck =
  | { kind: 'clean'; base_sha: string }
  | { kind: 'other' }
  | { kind: 'unknown'; detail: string };

/**
 * Whether the PR head `observed` that replaced the checked `expected` is GitHub's "Update branch": a
 * clean merge of a commit of the target branch into `expected` (#110). Both are fetched from the remote
 * into the task's repository; nothing in the worktree or on any branch changes.
 */
export async function checkBaseMerge(
  port: GitPort,
  input: { cwd: string; remote: string; target: string; expected: string; observed: string },
): Promise<BaseMergeCheck> {
  const git = gitIn(port, input.cwd);
  try {
    const fetched = await git(['fetch', '--no-tags', '--', input.remote, input.observed], 60_000);
    if (fetched.code !== 0) return { kind: 'unknown', detail: 'observed head fetch failed' };
    const parents = await git(['rev-list', '--parents', '-n', '1', input.observed]);
    if (parents.code !== 0) return { kind: 'unknown', detail: 'observed parents unreadable' };
    const [, first, base, ...more] = parents.stdout.trim().split(' ');
    if (first !== input.expected || base === undefined || more.length > 0) return { kind: 'other' };
    // The target tip by SHA, never FETCH_HEAD: another fetch in this repository may rewrite that.
    const listed = await git([
      'ls-remote',
      '--refs',
      '--',
      input.remote,
      `refs/heads/${input.target}`,
    ]);
    const tip = listed.code === 0 ? listed.stdout.split('\t')[0]?.trim() : undefined;
    if (tip === undefined || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tip))
      return { kind: 'unknown', detail: 'target tip unreadable' };
    const fetchedTip = await git(['fetch', '--no-tags', '--', input.remote, tip], 60_000);
    if (fetchedTip.code !== 0) return { kind: 'unknown', detail: 'target fetch failed' };
    const onTarget = await git(['merge-base', '--is-ancestor', base, tip]);
    if (onTarget.code === 1) return { kind: 'other' };
    if (onTarget.code !== 0) return { kind: 'unknown', detail: 'target ancestry unreadable' };
    return (await isCleanMerge(git, input.expected, base, input.observed))
      ? { kind: 'clean', base_sha: base }
      : { kind: 'other' };
  } catch (error) {
    return { kind: 'unknown', detail: String(error) };
  }
}

/**
 * Moves the task branch from the checked head to the verified remote merge, worktree included. A branch
 * or worktree that is neither at the checked head nor already at the merge is kept as is.
 */
async function adoptRemoteMerge(
  port: GitPort,
  input: BaseUpdate & { remote_head: string; checkpoint: CheckpointSpec; remote: string },
): Promise<BaseUpdateOutcome> {
  const spec = input.checkpoint;
  const git = gitIn(port, spec.worktree_path);
  const checkpoint = async () => {
    const cp = await takeCheckpoint(port, spec);
    if (!cp.ok) throw new Error(cp.error.detail);
    return cp.value;
  };
  const treeOf = async (sha: string) => {
    const r = await git(['rev-parse', `${sha}^{tree}`]);
    if (r.code !== 0) throw new Error(`tree of ${sha} unreadable`);
    return r.stdout.trim();
  };
  try {
    const fetched = await git(
      ['fetch', '--no-tags', '--', input.remote, input.remote_head],
      60_000,
    );
    if (fetched.code !== 0) throw new Error('remote merge fetch failed');
    if (!(await isCleanMerge(git, input.head_sha, input.base_sha, input.remote_head)))
      throw new Blocked('remote head is not a clean merge of the base into the checked head');
    const headTree = await treeOf(input.head_sha);
    const mergeTree = await treeOf(input.remote_head);
    let before = await checkpoint();
    if (before.parent_oid === input.head_sha) {
      if (before.tree_oid !== headTree)
        throw new Blocked('worktree changed before base update; kept as is');
      const moved = await git([
        'update-ref',
        `refs/heads/${spec.branch}`,
        input.remote_head,
        input.head_sha,
      ]);
      if (moved.code !== 0) throw new Blocked('task branch moved before base update');
      before = await checkpoint();
    }
    if (before.parent_oid !== input.remote_head)
      throw new Blocked('task branch moved before base update');
    if (before.tree_oid !== mergeTree) {
      if (before.tree_oid !== headTree)
        throw new Blocked('worktree changed during base update; kept as is');
      const checkout = await git(['read-tree', '-m', '-u', input.head_sha, input.remote_head]);
      if (checkout.code !== 0) throw new Error('base checkout failed');
    }
    const after = await checkpoint();
    if (after.parent_oid !== input.remote_head || after.tree_oid !== mergeTree)
      throw new Blocked('base checkout does not match the remote merge; kept as is');
    return { kind: 'updated', head_sha: input.remote_head };
  } catch (error) {
    return {
      kind: error instanceof Blocked ? 'blocked' : 'unknown',
      detail: String(error),
    };
  }
}

export async function updateBase(
  port: GitPort,
  store: CommitIntentStore,
  input: BaseUpdate & {
    checkpoint: CheckpointSpec;
    remote: string;
    identity: { name: string; email: string };
    at: number;
  },
): Promise<BaseUpdateOutcome> {
  const remoteHead = input.remote_head;
  if (remoteHead !== undefined)
    return adoptRemoteMerge(port, { ...input, remote_head: remoteHead });
  const spec = input.checkpoint;
  const key = baseUpdateIntentKey(spec, input);
  const git = async (args: string[], timeoutMs = 30_000) => {
    const result = await port.run({
      args,
      cwd: spec.worktree_path,
      timeout_ms: timeoutMs,
      max_output_bytes: 64 * 1024,
      stdin: null,
    });
    if (result.kind !== 'exited' || result.truncated)
      throw new Error(`base update git ${args[0]} unreadable: ${result.kind}`);
    return result;
  };
  const checkpoint = async () => {
    const cp = await takeCheckpoint(port, spec);
    if (!cp.ok) throw new Error(cp.error.detail);
    return cp.value;
  };
  try {
    const prior = store.load(key);
    if (
      prior !== null &&
      (prior.parent !== input.head_sha ||
        prior.merge_parent !== input.base_sha ||
        prior.branch !== spec.branch ||
        prior.worktree_path !== spec.worktree_path)
    )
      throw new Blocked('base update intent does not match this task');
    const before = await checkpoint();
    const headTree = await git(['rev-parse', `${input.head_sha}^{tree}`]);
    if (headTree.code !== 0) throw new Error('checked head tree unreadable');
    if (before.parent_oid !== input.head_sha && before.parent_oid !== prior?.oid)
      throw new Blocked('task branch moved before base update');
    if (before.tree_oid !== headTree.stdout.trim() && before.tree_oid !== prior?.tree)
      throw new Blocked('worktree changed before base update; kept as is');
    let tree = prior?.tree;
    let conflicts = prior?.conflict_files ?? [];
    if (tree === undefined) {
      const fetched = await git(['fetch', '--no-tags', '--', input.remote, input.base_sha], 60_000);
      if (fetched.code !== 0) throw new Error(`base fetch failed: ${fetched.stderr.slice(0, 512)}`);
      const contains = await git(['merge-base', '--is-ancestor', input.base_sha, input.head_sha]);
      if (contains.code === 0)
        throw new Blocked('base is already contained in the checked head; no merge commit created');
      if (contains.code !== 1) throw new Error('base ancestry unreadable');
      const merged = await git([
        'merge-tree',
        '--write-tree',
        '--name-only',
        '-z',
        input.head_sha,
        input.base_sha,
      ]);
      if (merged.code !== 0 && merged.code !== 1)
        throw new Error(`merge-tree failed: ${merged.stderr.slice(0, 512)}`);
      const parts = merged.stdout.split('\0');
      tree = parts.shift()?.trim();
      if (merged.code === 1) {
        const end = parts.indexOf('');
        if (end < 0 || end === 0) throw new Error('merge-tree conflict paths unreadable');
        conflicts = [...new Set(parts.slice(0, end))].sort();
      }
      if (tree === undefined || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tree))
        throw new Error('merge-tree did not return a tree');
    }
    const at = prior?.author.at ?? input.at;
    const committed = await commitCheckpoint(
      port,
      store,
      {
        key,
        worktree_path: spec.worktree_path,
        branch: spec.branch,
        tree,
        parent: input.head_sha,
        merge_parent: input.base_sha,
        ...(conflicts.length === 0 ? {} : { conflict_files: conflicts }),
        author: { ...input.identity, at },
        committer: { ...input.identity, at },
        message: `Merge base ${input.base_sha} into task branch\n`,
      },
      conflicts.length > 0,
    );
    if (committed.kind === 'unknown') throw new Error(committed.detail);
    if (committed.kind === 'prepared') {
      // The unresolved tree is a durable worktree plan only. Never commit it to the task branch.
      const checkout = await git(['read-tree', '-m', '-u', input.head_sha, tree]);
      if (checkout.code !== 0)
        throw new Error(`conflict checkout failed: ${checkout.stderr.slice(0, 512)}`);
      const after = await checkpoint();
      if (after.parent_oid !== input.head_sha || after.tree_oid !== tree)
        throw new Blocked('conflict worktree differs from its plan; kept as is');
      return { kind: 'conflict', tree, files: conflicts };
    }

    if (committed.kind !== 'committed' && committed.kind !== 'recovered')
      throw new Blocked(`base update commit ${committed.kind}; kept as is`);
    // A lost answer after the ref moved is recovered from the same intent. Never reset an outside edit.
    const current = await checkpoint();
    if (current.parent_oid !== committed.intent.oid)
      throw new Blocked('task branch moved during base update');
    if (current.tree_oid !== tree) {
      if (current.tree_oid !== headTree.stdout.trim())
        throw new Blocked('worktree changed during base update; kept as is');
      const checkout = await git(['read-tree', '-m', '-u', input.head_sha, committed.intent.oid]);
      if (checkout.code !== 0)
        throw new Error(`base checkout failed: ${checkout.stderr.slice(0, 512)}`);
    }
    const after = await checkpoint();
    if (after.parent_oid !== committed.intent.oid || after.tree_oid !== tree)
      throw new Blocked('base checkout does not match its intent; kept as is');
    return { kind: 'updated', head_sha: committed.intent.oid };
  } catch (error) {
    return {
      kind: error instanceof Blocked ? 'blocked' : 'unknown',
      detail: String(error),
    };
  }
}

/** Host-observed scope: never trust the worker's description of which files it changed. */
export async function baseRepairScope(
  port: GitPort,
  cwd: string,
  head: string,
  conflict: BaseConflict,
  tree: string,
): Promise<BaseRepairScope> {
  const run = async (args: string[]) => {
    const r = await port.run({
      args,
      cwd,
      timeout_ms: 30_000,
      max_output_bytes: 1024 * 1024,
      stdin: null,
    });
    if (r.kind !== 'exited' || r.truncated) throw new Error('base repair scope unreadable');
    return r;
  };
  try {
    const diff = await run(['diff', '--no-renames', '--name-only', '-z', conflict.tree, tree]);
    if (diff.code !== 0) throw new Error('base repair paths unreadable');
    const files = diff.stdout.split('\0').filter((file) => file !== '');
    const unchanged = conflict.files.filter((file) => !files.includes(file));
    // Quiet grep emits no file contents/diagnostics, regardless of diff or file size.
    // A lone Markdown ======= is not an opening/closing merge marker.
    const check =
      conflict.files.length === 0
        ? { code: 1 }
        : await run([
            'grep',
            '-I',
            '-q',
            '-E',
            '^<{7,}( |$)|^>{7,}( |$)',
            tree,
            '--',
            ...conflict.files.map((file) => `:(literal)${file}`),
          ]);
    if (check.code !== 0 && check.code !== 1)
      throw new Error('base repair marker check unreadable');
    return {
      tree,
      outside_files: files.filter((file) => !conflict.files.includes(file)).sort(),
      unchanged_conflicts: unchanged,
      markers: check.code === 0,
      unresolved: check.code === 0 || unchanged.length > 0,
    };
  } catch (error) {
    // A failed scope read is evidence of unreadiness, not a thrown/stranded worker effect.
    return {
      tree,
      outside_files: [],
      unresolved: true,
      problem: String(error),
    };
  }
}
