import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxLayout, SandboxRole } from '../../src/adapters/ports.ts';

export type SandboxFixture = {
  readonly base: string;
  readonly repo: string;
  readonly worktree: string;
  readonly gitCommon: string;
  readonly scratch: string;
  readonly home: string;
  readonly context: string;
  readonly outside: string;
};

function git(args: readonly string[], cwd: string): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

/** Throwaway repo + linked worktree + canary dir under a real tmp path (outside the host home). */
export function createSandboxFixture(): SandboxFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-sandbox-')));
  const repo = join(base, 'repo');
  const worktree = join(base, 'worktree');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git(['add', 'README.md'], repo);
  git(
    ['-c', 'user.name=cusr', '-c', 'user.email=cusr@invalid', 'commit', '-q', '-m', 'init'],
    repo,
  );
  git(['worktree', 'add', '-q', '-b', 'cusr/probe', worktree], repo);
  const dirs = {
    scratch: join(base, 'scratch'),
    home: join(base, 'home'),
    context: join(base, 'context'),
    outside: join(base, 'outside'),
  };
  for (const d of Object.values(dirs)) mkdirSync(d);
  writeFileSync(join(dirs.context, 'prompt.md'), 'prompt\n');
  writeFileSync(join(dirs.outside, 'canary'), 'outside-canary\n');
  return { base, repo, worktree, gitCommon: join(repo, '.git'), ...dirs };
}

export function fixtureLayout(role: SandboxRole, fx: SandboxFixture): SandboxLayout {
  return {
    role,
    worktree: fx.worktree,
    git_dirs: [fx.gitCommon],
    scratch: fx.scratch,
    private_home: role === 'coder' || role === 'fixer' || role === 'reviewer' ? fx.home : null,
    context: fx.context,
    schema: null,
    toolchain: [],
    env: {},
    network: 'internet_outbound',
  };
}
