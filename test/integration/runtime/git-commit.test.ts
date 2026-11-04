import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { takeCheckpoint } from '../../../src/adapters/git/checkpoint.ts';
import {
  commitCheckpoint,
  FileCommitIntentStore,
  type CommitInput,
} from '../../../src/adapters/git/commit.ts';
import { probeCommit } from '../../../src/adapters/git/reconcile.ts';
import { ensureWorktree, markerPath } from '../../../src/adapters/git/worktree.ts';
import type { GitPort } from '../../../src/adapters/ports.ts';
import { uuidOf } from '../../support/builders.ts';
import { gitSandbox } from '../../support/git-repo.ts';

const g = gitSandbox('cusr-commit-');
afterAll(() => g.cleanup());

let n = 0;
async function setup() {
  const project = g.repo(`p${n}`);
  const data = join(g.base, `data${n++}`);
  const base = g.sh(project, 'rev-parse', 'HEAD');
  const spec = {
    task_id: uuidOf(1),
    title: 'commit',
    project_realpath: project,
    common_git_dir: join(project, '.git'),
    base_sha: base,
    worktrees_root: join(data, 'wt'),
    markers_dir: join(data, 'owners'),
    nonce: 'n',
  };
  const git = g.runner();
  const wt = await ensureWorktree(git, spec);
  if (wt.kind !== 'created') throw new Error(JSON.stringify(wt));
  writeFileSync(join(wt.worktree_path, 'feature.txt'), 'done\n');
  const cp = await takeCheckpoint(git, {
    task_id: spec.task_id,
    revision: 1,
    project_realpath: project,
    common_git_dir: spec.common_git_dir,
    worktree_path: wt.worktree_path,
    branch: wt.branch,
    base_sha: base,
    owner_marker: markerPath(spec.markers_dir, spec.task_id),
  });
  if (!cp.ok) throw new Error(JSON.stringify(cp.error));
  const input: CommitInput = {
    key: `${spec.task_id}.r1.code-1`,
    worktree_path: wt.worktree_path,
    branch: wt.branch,
    tree: cp.value.tree_oid,
    parent: cp.value.parent_oid,
    author: { name: 'Cuesura', email: 'cusr@invalid', at: 1_800_000_000_000 },
    committer: {
      name: 'Cuesura',
      email: 'cusr@invalid',
      at: 1_800_000_000_000,
    },
    message: 'feat: add feature\n\nTask 1 revision 1',
  };
  return {
    git,
    input,
    wt,
    store: new FileCommitIntentStore(join(data, 'intents')),
    base,
  };
}

/** Wraps a port so `update-ref` reports a timeout, after applying it or not. */
function flakyUpdateRef(port: GitPort, apply: boolean): GitPort {
  return {
    run: async (c) => {
      if (c.args[0] !== 'update-ref') return port.run(c);
      if (apply) await port.run(c);
      return { kind: 'timeout' };
    },
  };
}

describe('orchestrator commit (T039, FR-017/018)', () => {
  it('commits exactly the checkpoint tree on the task branch by CAS from its parent', async () => {
    const { git, input, wt, store } = await setup();
    const r = await commitCheckpoint(git, store, input);
    expect(r.kind).toBe('committed');
    if (r.kind !== 'committed') return;
    expect(g.sh(wt.worktree_path, 'rev-parse', 'HEAD')).toBe(r.intent.oid);
    expect(g.sh(wt.worktree_path, 'rev-parse', 'HEAD^{tree}')).toBe(input.tree);
    expect(g.sh(wt.worktree_path, 'rev-parse', 'HEAD^')).toBe(input.parent);
    expect(g.sh(wt.worktree_path, 'log', '-1', '--format=%an <%ae> %at %cn %ct%n%B')).toBe(
      'Cuesura <cusr@invalid> 1800000000 Cuesura 1800000000\nfeat: add feature\n\nTask 1 revision 1',
    );
    expect(store.load(input.key)).toEqual(r.intent);

    // Running it again recognizes the commit instead of making another.
    expect(await commitCheckpoint(git, store, input)).toMatchObject({
      kind: 'recovered',
      intent: { oid: r.intent.oid },
    });
    expect(g.sh(wt.worktree_path, 'rev-list', '--count', `${input.parent}..HEAD`)).toBe('1');
  });

  it('after a timeout, recovery finds the same OID whether or not the ref moved', async () => {
    const lost = await setup();
    const first = await commitCheckpoint(flakyUpdateRef(lost.git, false), lost.store, lost.input);
    expect(first).toMatchObject({ kind: 'unknown' });
    expect(await probeCommit(lost.git, lost.store, lost.input.key)).toMatchObject({
      kind: 'not_applied',
    });
    const again = await commitCheckpoint(lost.git, lost.store, lost.input);
    expect(again).toMatchObject({
      kind: 'committed',
      intent: { oid: first.kind === 'unknown' ? first.intent?.oid : '' },
    });

    const applied = await setup();
    const r = await commitCheckpoint(
      flakyUpdateRef(applied.git, true),
      applied.store,
      applied.input,
    );
    expect(r.kind).toBe('committed');
    expect(await probeCommit(applied.git, applied.store, applied.input.key)).toMatchObject({
      kind: 'committed',
      intent: { oid: r.kind === 'committed' ? r.intent.oid : '' },
    });
  });

  it('the commit OID is reproducible from the stored intent', async () => {
    const a = await setup();
    const r = await commitCheckpoint(a.git, a.store, a.input);
    if (r.kind !== 'committed') throw new Error(JSON.stringify(r));
    const b = await setup();
    // Same base content and inputs in another repo give the same OID.
    const r2 = await commitCheckpoint(b.git, b.store, {
      ...b.input,
      key: a.input.key,
    });
    expect(r2.kind === 'committed' && r2.intent.oid).toBe(r.intent.oid);
  });

  it('a branch moved by someone else is reported and left alone', async () => {
    const { git, input, wt, store } = await setup();
    g.sh(wt.worktree_path, 'commit', '-qm', 'outside', '--allow-empty');
    const outside = g.sh(wt.worktree_path, 'rev-parse', 'HEAD');
    expect(await commitCheckpoint(git, store, input)).toMatchObject({
      kind: 'head_changed',
      found: outside,
    });
    expect(g.sh(wt.worktree_path, 'rev-parse', 'HEAD')).toBe(outside);
    expect(store.load(input.key)).toBeNull();
  });

  it('one key never gets a second, different commit', async () => {
    const { git, input, store } = await setup();
    await commitCheckpoint(git, store, input);
    expect(
      await commitCheckpoint(git, store, {
        ...input,
        message: 'something else',
      }),
    ).toMatchObject({ kind: 'intent_conflict' });
  });

  it('the Git port accepts only commit identity variables per call', async () => {
    const { git, wt } = await setup();
    const r = await git.run({
      args: ['rev-parse', 'HEAD'],
      cwd: wt.worktree_path,
      timeout_ms: 5_000,
      max_output_bytes: 1024,
      stdin: null,
      env: { GIT_DIR: '/tmp/x' },
    });
    expect(r).toMatchObject({
      kind: 'refused',
      reason: 'environment not allowed: GIT_DIR',
    });
  });
});
