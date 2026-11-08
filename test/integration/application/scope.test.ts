import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GitPort, GitResult } from '../../../src/adapters/ports.ts';
import {
  effectiveScopes,
  projectScopes,
  SCOPE_BUDGET_MS,
  ScopeCache,
  taskScope,
} from '../../../src/application/scope.ts';
import type { TaskState, TaskStatus } from '../../../src/domain/state.ts';
import type { Store } from '../../../src/store/index.ts';

// Issue #210: overlapping files between live tasks and a branch's standing against its base, read
// from real Git objects with no fetch.
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-scope-')));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@x',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@x',
};

function sh(...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const calls: string[][] = [];
const git: GitPort = {
  run: (c) =>
    new Promise<GitResult>((resolve) => {
      calls.push([...c.args]);
      execFile(
        'git',
        [...c.args],
        { cwd: c.cwd, env: GIT_ENV, maxBuffer: c.max_output_bytes, encoding: 'utf8' },
        (e, stdout, stderr) =>
          resolve(
            e === null || typeof e.code === 'number'
              ? {
                  kind: 'exited',
                  code: e === null ? 0 : (e.code as number),
                  stdout,
                  stderr,
                  truncated: false,
                }
              : { kind: 'spawn_failed', message: e.message },
          ),
      );
    }),
};

function commit(files: Record<string, string>, message: string): string {
  for (const [f, text] of Object.entries(files)) writeFileSync(join(repo, f), text);
  sh('add', '-A');
  sh('commit', '-q', '-m', message);
  return sh('rev-parse', 'HEAD');
}

const heads: Record<string, string> = {};
let fork = '';

beforeAll(() => {
  sh('init', '-q', '-b', 'main');
  fork = commit({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' }, 'init');
  heads['t1'] = commit({ 'a.txt': 'a by t1\n', 'b.txt': 'b by t1\n' }, 't1');
  sh('checkout', '-q', fork);
  heads['t2'] = commit({ 'b.txt': 'b by t2\n' }, 't2');
  sh('checkout', '-q', fork);
  heads['t3'] = commit({ 'c.txt': 'c by t3\n' }, 't3');
  sh('checkout', '-q', fork);
  const tip = commit({ 'a.txt': 'a on main\n' }, 'main moves');
  sh('update-ref', 'refs/remotes/origin/main', tip);
});

function task(id: string, status: TaskStatus, head: string | null, project = 'acme'): TaskState {
  return {
    id,
    project,
    status,
    head_sha: head,
    base_sha: fork,
    runtime_ref: null,
    run: { checkpoint: null },
    task: { base_branch: 'main' },
    execution: { request: null },
  } as unknown as TaskState;
}

function storeOf(tasks: TaskState[]): Store {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return {
    taskIdsByStatus: (statuses: readonly TaskStatus[]) =>
      tasks.filter((t) => statuses.includes(t.status)).map((t) => t.id),
    readTask: (id: string) => byId.get(id) ?? null,
    readRuntimeContext: () => null,
    readSlots: () => [],
    readLoans: () => [],
  } as unknown as Store;
}

const deps = (tasks: TaskState[], cache?: ScopeCache) => ({
  store: storeOf(tasks),
  git,
  projectPath: () => Promise.resolve(repo),
  ...(cache === undefined ? {} : { cache }),
});

describe('task scope (issue #210)', () => {
  it('lists other live tasks changing the same files, and the files a base merge would conflict on', async () => {
    const tasks = [
      task('t1', 'RUNNING', heads['t1'] as string),
      task('t2', 'WAITING', heads['t2'] as string),
      task('t3', 'READY', heads['t3'] as string),
      task('t4', 'READY', null),
      task('done', 'DONE', heads['t2'] as string),
      task('other', 'RUNNING', heads['t2'] as string, 'elsewhere'),
    ];
    const scopes = await projectScopes(deps(tasks));
    expect(scopes.get('t1')).toEqual({
      changed_files: ['a.txt', 'b.txt'],
      base: {
        ref: 'main',
        tip_sha: sh('rev-parse', 'refs/remotes/origin/main'),
        behind: 1,
        conflicts: ['a.txt'],
      },
      overlaps: [{ task_id: 't2', status: 'WAITING', files: ['b.txt'] }],
      unknown: [],
      declared: null,
      unscoped: false,
      slot_block: null,
    });
    expect(scopes.get('t2')?.overlaps).toEqual([
      { task_id: 't1', status: 'RUNNING', files: ['b.txt'] },
    ]);
    expect(scopes.get('t2')?.base?.conflicts).toEqual([]);
    expect(scopes.get('t3')?.overlaps).toEqual([]);
    expect(scopes.get('t4')).toEqual({
      changed_files: null,
      base: null,
      overlaps: [],
      unknown: [],
      declared: null,
      unscoped: true,
      slot_block: null,
    });
    expect(scopes.has('done')).toBe(false);
    expect(scopes.get('other')?.overlaps).toEqual([]);
  });

  it('reads each branch once while its commits stay the same', async () => {
    const cache = new ScopeCache();
    const tasks = [task('t1', 'RUNNING', heads['t1'] as string)];
    await taskScope(deps(tasks, cache), 't1');
    calls.length = 0;
    const again = await taskScope(deps(tasks, cache), 't1');
    expect(again?.base?.conflicts).toEqual(['a.txt']);
    expect(calls.map((c) => c[0])).toEqual(['rev-parse']);
  });

  it('reports what git cannot read as unknown instead of failing', async () => {
    const tasks = [task('t1', 'RUNNING', 'f'.repeat(40))];
    const scope = await taskScope(deps(tasks), 't1');
    expect(scope?.changed_files).toBeNull();
    expect(scope?.base?.conflicts).toBeNull();
    expect(scope?.unknown).toEqual(['changed_files', 'base', 'overlaps']);
  });

  it('marks overlaps unknown when another live branch of the project could not be read', async () => {
    const tasks = [
      task('t1', 'RUNNING', heads['t1'] as string),
      task('t2', 'RUNNING', 'f'.repeat(40)),
    ];
    const scope = await taskScope(deps(tasks), 't1');
    expect(scope?.overlaps).toEqual([]);
    expect(scope?.unknown).toEqual(['overlaps']);
  });

  it('keeps each task its own base name when two bases share a tip (cache key)', async () => {
    sh('update-ref', 'refs/remotes/origin/release', sh('rev-parse', 'refs/remotes/origin/main'));
    const cache = new ScopeCache();
    const onMain = task('m', 'RUNNING', heads['t1'] as string);
    const onRelease = {
      ...task('r', 'RUNNING', heads['t1'] as string),
      task: { base_branch: 'release' },
    } as unknown as TaskState;
    expect((await taskScope(deps([onMain], cache), 'm'))?.base?.ref).toBe('main');
    // Same path, head and tip as the cached read of `m`: only the base name tells them apart.
    expect((await taskScope(deps([onRelease], cache), 'r'))?.base?.ref).toBe('release');
  });

  it('gives up on reads past the shared deadline and answers with what is unknown', async () => {
    const slow: GitPort = {
      run: (c) =>
        new Promise<GitResult>((resolve) => {
          const t = setTimeout(() => resolve({ kind: 'timeout' }), c.timeout_ms);
          t.unref();
        }),
    };
    const tasks = [
      task('t1', 'RUNNING', heads['t1'] as string),
      task('t2', 'RUNNING', heads['t2'] as string),
    ];
    const started = Date.now();
    const scopes = await projectScopes({ ...deps(tasks), git: slow, budget_ms: 300 });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(scopes.get('t1')?.unknown).toEqual(['changed_files', 'base', 'overlaps']);
    expect(scopes.get('t2')?.changed_files).toBeNull();
  });

  it('keeps the default budget well under the CLI request timeout', () => {
    expect(SCOPE_BUDGET_MS).toBeLessThan(15_000 / 2);
  });
});

describe('task scope before publish (issue #210)', () => {
  it('reads the checkpoint commit when the gates passed one, even with no published head', async () => {
    const t = {
      ...task('t1', 'RUNNING', null),
      run: { checkpoint: { sha: heads['t1'] } },
    } as unknown as TaskState;
    const scope = await taskScope(deps([t]), 't1');
    expect(scope?.changed_files).toEqual(['a.txt', 'b.txt']);
  });
});

describe('declared scope and slot blocks (issue #240)', () => {
  const queued = (id: string, scope?: string[]): TaskState =>
    ({
      ...task(id, 'READY', null),
      task: { base_branch: 'main', ...(scope === undefined ? {} : { scope }) },
      execution: { request: { group: 'fresh' } },
    }) as unknown as TaskState;
  const holding = (tasks: TaskState[], holder: string): Store =>
    ({
      ...storeOf(tasks),
      readSlots: () => [{ holder_task_id: holder }],
    }) as unknown as Store;

  it('unions changed and declared files; a task with neither has an unknown scope', async () => {
    const tasks = [
      {
        ...task('t1', 'RUNNING', heads['t1'] as string),
        task: { base_branch: 'main', scope: ['docs/**'] },
      } as unknown as TaskState,
      queued('q', ['c.txt']),
      queued('none'),
    ];
    const scopes = await effectiveScopes(deps(tasks), ['t1', 'q', 'none', 'missing']);
    expect(Object.fromEntries(scopes)).toEqual({
      t1: { project: 'acme', files: ['a.txt', 'b.txt', 'docs/**'] },
      q: { project: 'acme', files: ['c.txt'] },
      none: { project: 'acme', files: null },
    });
  });

  it('explains a queued task passed over for the files a slot holder changed', async () => {
    const tasks = [
      task('t1', 'RUNNING', heads['t1'] as string),
      queued('q', ['b.txt', 'z/**']),
      queued('free', ['c.txt']),
      queued('none'),
    ];
    const scopes = await projectScopes({ ...deps(tasks), store: holding(tasks, 't1') });
    expect(scopes.get('q')).toMatchObject({
      declared: ['b.txt', 'z/**'],
      unscoped: false,
      slot_block: { code: 'scope_overlap', tasks: [{ task_id: 't1', files: ['b.txt'] }] },
    });
    expect(scopes.get('free')?.slot_block).toBeNull();
    expect(scopes.get('none')).toMatchObject({ unscoped: true, slot_block: null });
    expect(scopes.get('t1')?.slot_block).toBeNull();
  });
});
