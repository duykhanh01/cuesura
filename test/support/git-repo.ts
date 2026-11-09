import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitCommandRunner, type GitRunnerOptions } from '../../src/adapters/git/command.ts';

// Temp Git repos driven by real git for adapter tests; nothing outside the temp dir is touched.

export const GIT_BIN = realpathSync(
  spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim(),
);

export type GitSandbox = {
  readonly base: string;
  readonly env: NodeJS.ProcessEnv;
  sh(cwd: string, ...args: string[]): string;
  /** A repo with one commit on `main`; returns its path. */
  repo(name?: string, files?: Record<string, string>): string;
  runner(o?: Partial<GitRunnerOptions>): GitCommandRunner;
  cleanup(): void;
};

export function gitSandbox(prefix = 'cusr-git-'): GitSandbox {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const env = {
    PATH: process.env.PATH,
    HOME: base,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@x',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@x',
    // Fixed times keep identical repos identical, so commit OIDs compare across repos.
    GIT_AUTHOR_DATE: '@1800000000 +0000',
    GIT_COMMITTER_DATE: '@1800000000 +0000',
  };
  const hooks = join(base, '.empty-hooks');
  mkdirSync(hooks);
  let n = 0;
  const sh = (cwd: string, ...args: string[]): string => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  return {
    base,
    env,
    sh,
    repo(name = `repo${n++}`, files = { 'a.txt': 'hello\n' }) {
      const dir = join(base, name);
      sh(base, 'init', '-q', '-b', 'main', dir);
      for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
      sh(dir, 'add', '-A');
      sh(dir, 'commit', '-qm', 'init');
      return dir;
    },
    runner: (o = {}) =>
      new GitCommandRunner({
        git: GIT_BIN,
        emptyHooksDir: hooks,
        safeDirectories: [base],
        credentialHelper: null,
        home: base,
        protocols: ['file'],
        env: { ...process.env, ...env },
        passEnv: [],
        ...o,
      }),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
