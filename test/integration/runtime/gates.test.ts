import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  runAutofix,
  runGates,
  runSetup,
  type CommandSetDeps,
  type CommandSetInput,
} from '../../../src/adapters/gates.ts';
import {
  ensureWorktree,
  markerPath,
} from '../../../src/adapters/git/worktree.ts';
import type { SandboxProvider } from '../../../src/adapters/ports.ts';
import {
  RETRY_SAFETY,
  SpawnExecutor,
  type CommandExecutor,
} from '../../../src/runner/commands.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import { HostExecutionProvider } from '../../../src/runner/sandbox.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { hashText } from '../../../src/shared/hash.ts';
import { ok } from '../../../src/shared/result.ts';
import { uuidOf } from '../../support/builders.ts';
import { gitSandbox } from '../../support/git-repo.ts';

const g = gitSandbox('cusr-gates-');
afterAll(() => g.cleanup());

const SECRET = 'gate-secret-value-123';
const now = 1_000_000;
const clock = { now: () => now as EpochMs, monotonic: () => now };

/** Runs `/bin/sh -c` directly: exercises the command logic without bwrap. */
const passthrough: SandboxProvider = {
  provider: 'bwrap',
  plan: (layout, command) =>
    ok({
      isolation_mode: 'isolated',
      provider: 'bwrap',
      role: layout.role,
      argv: [...command],
      cwd: layout.worktree,
      env: { PATH: '/usr/bin:/bin', SECRET_VALUE: SECRET },
      network: 'internet_outbound',
      mount_sources: [],
      layout_digest: hashText(layout.role),
      layout_shape: hashText(layout.role),
      proof_refs: [],
    }),
};

let n = 0;
async function setup(
  sandbox: SandboxProvider = passthrough,
  executor: CommandExecutor = new SpawnExecutor(),
) {
  const project = g.repo(`p${n}`);
  const data = join(g.base, `data${n++}`);
  const spec = {
    task_id: uuidOf(1),
    title: 'gates',
    project_realpath: project,
    common_git_dir: join(project, '.git'),
    base_sha: g.sh(project, 'rev-parse', 'HEAD'),
    worktrees_root: join(data, 'wt'),
    markers_dir: join(data, 'owners'),
    nonce: 'n',
  };
  const wt = await ensureWorktree(g.runner(), spec);
  if (wt.kind !== 'created') throw new Error(JSON.stringify(wt));
  const scratch = join(data, 'scratch');
  mkdirSync(scratch, { recursive: true });
  const deps: CommandSetDeps = {
    sandbox,
    executor,
    clock,
    redactor: new Redactor({ values: [SECRET] }),
    git: g.runner(),
  };
  const input = (
    commands: { name: string; command: string }[],
    over: Partial<CommandSetInput> = {},
  ): CommandSetInput => ({
    commands,
    layout: {
      worktree: wt.worktree_path,
      git_dirs: [spec.common_git_dir],
      scratch,
      context: null,
      schema: null,
      toolchain: [],
      env: {},
      network: 'internet_outbound',
    },
    wall_ms: 10_000,
    deadline_at: null,
    checkpoint: {
      task_id: spec.task_id,
      revision: 1,
      project_realpath: project,
      common_git_dir: spec.common_git_dir,
      worktree_path: wt.worktree_path,
      branch: wt.branch,
      base_sha: spec.base_sha,
      owner_marker: markerPath(spec.markers_dir, spec.task_id),
    },
    ...over,
  });
  return { deps, input, worktree: wt.worktree_path };
}

describe('setup/gate/autofix commands (T038, FR-004)', () => {
  it('runs a gate without an implicit command timeout', async () => {
    const { deps, input } = await setup();
    const r = await runGates(
      deps,
      input([{ name: 'unit', command: 'sleep 0.1; true' }], { wall_ms: null }),
    );
    expect(r.receipts).toHaveLength(1);
    expect(r.receipts[0]).toMatchObject({ status: 'passed', wall_ms: null });
  });

  it('a gate that rewrites the tree makes the whole set run again on the final tree (M06)', async () => {
    const { deps, input, worktree } = await setup();
    // A formatter normalises a file once; the second pass finds nothing to change.
    writeFileSync(join(worktree, 'f.txt'), 'messy\n');
    const r = await runGates(
      deps,
      input([
        { name: 'format', command: 'grep -q tidy f.txt || echo tidy > f.txt' },
        { name: 'unit', command: 'grep -q tidy f.txt' },
      ]),
    );
    expect(r.data).toMatchObject({
      stable: true,
      results: [
        { gate: 'format', passed: true },
        { gate: 'unit', passed: true },
      ],
    });
    expect(r.receipts).toHaveLength(2);
    expect(r.data?.tree).toBe(g.sh(worktree, 'write-tree'));
  });

  it('a tree that keeps moving is reported unstable after a bounded number of passes', async () => {
    const { deps, input, worktree } = await setup();
    const r = await runGates(
      deps,
      input([{ name: 'churn', command: 'date +%s%N >> churn.txt' }]),
    );
    expect(r.data?.stable).toBe(false);
    expect(g.sh(worktree, 'show', ':churn.txt').split('\n')).toHaveLength(3);
  });

  it('runs each frozen gate with /bin/sh -c and reports results with stable failure signatures', async () => {
    const { deps, input } = await setup();
    const r = await runGates(
      deps,
      input([
        { name: 'build', command: 'true' },
        { name: 'unit', command: 'echo "1 failing" >&2; exit 3' },
        { name: 'lint', command: 'test -f a.txt' },
      ]),
    );
    expect(r.kind).toBe('completed');
    expect(r.data?.results).toEqual([
      { gate: 'build', passed: true },
      {
        gate: 'unit',
        passed: false,
        signature: expect.stringMatching(
          /^gate:unit:exit_3:[0-9a-f]{12}$/,
        ) as unknown,
        log_excerpt: '1 failing\n',
      },
      { gate: 'lint', passed: true },
    ]);
    expect(r.receipts.map((x) => x.status)).toEqual([
      'passed',
      'failed',
      'passed',
    ]);
    expect(r.receipts[1]?.output.tail).toContain('1 failing');
  });

  it('checkpoints the worktree before a command writes', async () => {
    const { deps, input, worktree } = await setup();
    const r = await runAutofix(
      deps,
      input([{ name: 'format_fix', command: 'echo formatted > fmt.txt' }]),
    );
    expect(r.kind).toBe('completed');
    expect(existsSync(join(worktree, 'fmt.txt'))).toBe(true);
    if (r.kind !== 'completed') return;
    expect(
      spawnSync('git', ['cat-file', '-e', `${r.checkpoint.tree_oid}:fmt.txt`], {
        cwd: worktree,
        env: g.env,
      }).status,
    ).not.toBe(0);
  });

  it('caps a command by its wall and by the task deadline', async () => {
    const { deps, input } = await setup();
    const slow = await runGates(
      deps,
      input([{ name: 'unit', command: 'sleep 5' }], { wall_ms: 200 }),
    );
    expect(slow.receipts[0]).toMatchObject({ status: 'timeout', wall_ms: 200 });
    expect(slow.data?.results).toEqual([
      { gate: 'unit', passed: false, signature: 'gate:unit:timeout' },
    ]);

    const near = await runGates(
      deps,
      input([{ name: 'unit', command: 'sleep 5' }], {
        deadline_at: (now + 150) as EpochMs,
      }),
    );
    expect(near.receipts[0]).toMatchObject({ status: 'timeout', wall_ms: 150 });

    const past = await runGates(
      deps,
      input([{ name: 'unit', command: 'touch ran.txt' }], {
        deadline_at: (now - 1) as EpochMs,
      }),
    );
    expect(past.receipts[0]).toMatchObject({
      status: 'deadline',
      started_at: null,
    });
  });

  it('redacts secrets from the recorded output', async () => {
    const { deps, input } = await setup();
    const r = await runGates(
      deps,
      input([{ name: 'unit', command: 'echo "token=$SECRET_VALUE"; exit 1' }]),
    );
    expect(r.receipts[0]?.output.tail).not.toContain(SECRET);
    expect(r.receipts[0]?.output.tail).toContain('[REDACTED]');
  });

  it('setup stops at the first failure; an empty setup passes without running anything', async () => {
    const { deps, input } = await setup();
    const r = await runSetup(
      deps,
      input([
        { name: 'install', command: 'exit 1' },
        { name: 'second', command: 'touch second.txt' },
      ]),
    );
    expect(r).toMatchObject({
      kind: 'completed',
      setup: { ran: true, passed: false },
    });
    expect(r.receipts).toHaveLength(1);
    expect(await runSetup(deps, input([]))).toMatchObject({
      kind: 'completed',
      setup: { ran: false, passed: true },
    });
  });

  it('an unknown outcome of autofix waits for a human; of a gate it may be retried', async () => {
    const unknown: CommandExecutor = {
      run: () =>
        Promise.resolve({
          kind: 'unknown',
          message: 'runner lost',
          output: '',
        }),
    };
    const { deps, input } = await setup(passthrough, unknown);
    expect(RETRY_SAFETY).toEqual({
      setup: 'safe',
      gate: 'safe',
      autofix: 'unsafe',
    });
    expect(
      await runAutofix(deps, input([{ name: 'format_fix', command: 'x' }])),
    ).toMatchObject({ kind: 'unknown', retry_allowed: false });
    expect(
      await runGates(deps, input([{ name: 'unit', command: 'x' }])),
    ).toMatchObject({ kind: 'unknown', retry_allowed: true });
  });

  it('a sandbox plan that is refused never launches the command', async () => {
    const refusing: SandboxProvider = {
      provider: 'bwrap',
      plan: () => ({
        ok: false,
        error: { code: 'policy_violation', message: 'no' },
      }),
    };
    const { deps, input } = await setup(refusing);
    const r = await runGates(
      deps,
      input([{ name: 'unit', command: 'touch ran.txt' }]),
    );
    expect(r.receipts[0]).toMatchObject({
      status: 'not_launched',
      detail: 'policy_violation: no',
    });
  });
});

describe('gates through the production host launcher', () => {
  it('runs the configured gate in its worktree and records the result', async () => {
    const { deps, input, worktree } = await setup(new HostExecutionProvider());
    const r = await runGates(
      deps,
      input([{ name: 'build', command: 'echo built > out.txt' }]),
    );
    expect(r.receipts[0]).toMatchObject({ status: 'passed' });
    expect(existsSync(join(worktree, 'out.txt'))).toBe(true);
  });
});
