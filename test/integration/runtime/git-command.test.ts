import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  configNames,
  GitCommandRunner,
  GitConfigError,
  refuseArgs,
  untrustedConfigKeys,
  type GitRunnerOptions,
} from '../../../src/adapters/git/command.ts';
import type { GitCommand } from '../../../src/adapters/ports.ts';

// Real git on temp repos; nothing outside the temp dir is read or changed.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-git-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const GIT = realpathSync(
  spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim(),
);
const SETUP_ENV = {
  PATH: process.env.PATH,
  HOME: base,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@x',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@x',
};

function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: SETUP_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

let n = 0;
function repo(): string {
  const dir = join(base, `repo${n++}`);
  sh(base, 'init', '-q', '-b', 'main', dir);
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  sh(dir, 'add', 'a.txt');
  sh(dir, 'commit', '-qm', 'init');
  return dir;
}

const hooks = join(base, 'empty-hooks');
mkdirSync(hooks);
const home = join(base, 'home');
mkdirSync(home);
writeFileSync(join(home, '.gitconfig'), '[user]\n\tsecret = from-global\n[alias]\n\tst = status\n');

function runner(o: Partial<GitRunnerOptions> = {}): GitCommandRunner {
  return new GitCommandRunner({
    git: GIT,
    emptyHooksDir: hooks,
    safeDirectories: [base],
    credentialHelper: null,
    home,
    protocols: ['file'],
    ...o,
  });
}

const cmd = (cwd: string, args: string[], over: Partial<GitCommand> = {}): GitCommand => ({
  args,
  cwd,
  timeout_ms: 10_000,
  max_output_bytes: 64 * 1024,
  stdin: null,
  ...over,
});

/** A script that leaves a marker file when git runs it. */
function trap(name: string): { path: string; marker: string } {
  const marker = join(base, `${name}.ran`);
  const path = join(base, `${name}.sh`);
  writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(path, 0o755);
  return { path, marker };
}

describe('GitCommandRunner (T035)', () => {
  it('runs by argv and returns stdout, exit code and no truncation', async () => {
    const dir = repo();
    const r = await runner().run(cmd(dir, ['rev-parse', 'HEAD']));
    expect(r).toMatchObject({ kind: 'exited', code: 0, truncated: false });
    expect(r.kind === 'exited' && r.stdout.trim()).toBe(sh(dir, 'rev-parse', 'HEAD'));
    expect(
      await runner().run(cmd(dir, ['rev-parse', '--verify', '--quiet', 'refs/heads/nope'])),
    ).toMatchObject({ kind: 'exited', code: 1 });
  });

  it('ignores global config and the caller environment', async () => {
    const dir = repo();
    expect(await runner().run(cmd(dir, ['config', '--get', 'user.secret']))).toMatchObject({
      kind: 'exited',
      code: 1,
    });
    const r = await runner({
      env: { ...process.env, CUSR_LEAK: 'x' },
      passEnv: ['CUSR_LEAK', 'GIT_DIR'],
    }).run(cmd(dir, ['config', '--get', 'core.bare']));
    expect(r).toMatchObject({ kind: 'exited', code: 0 });
  });

  it('never runs repo hooks, even with a repo-local core.hooksPath', async () => {
    const dir = repo();
    const hook = trap('hook');
    mkdirSync(join(dir, '.husky'));
    writeFileSync(
      join(dir, '.husky', 'reference-transaction'),
      `#!/bin/sh\ntouch '${hook.marker}'\n`,
    );
    chmodSync(join(dir, '.husky', 'reference-transaction'), 0o755);
    writeFileSync(
      join(dir, '.git', 'hooks', 'reference-transaction'),
      `#!/bin/sh\ntouch '${hook.marker}'\n`,
    );
    chmodSync(join(dir, '.git', 'hooks', 'reference-transaction'), 0o755);
    sh(dir, 'config', 'core.hooksPath', '.husky');
    const head = sh(dir, 'rev-parse', 'HEAD');
    expect(await runner().run(cmd(dir, ['update-ref', 'refs/heads/copy', head]))).toMatchObject({
      kind: 'exited',
      code: 0,
    });
    expect(sh(dir, 'rev-parse', 'refs/heads/copy')).toBe(head);
    expect(existsSync(hook.marker)).toBe(false);
    // Control: plain git on the same repo does run the hook.
    sh(dir, 'update-ref', 'refs/heads/copy2', head);
    expect(existsSync(hook.marker)).toBe(true);
  });

  it('overrides a repo fsmonitor program instead of running it', async () => {
    const dir = repo();
    const fsm = trap('fsmonitor');
    sh(dir, 'config', 'core.fsmonitor', fsm.path);
    expect(await runner().run(cmd(dir, ['status', '--porcelain']))).toMatchObject({
      kind: 'exited',
      code: 0,
    });
    expect(existsSync(fsm.marker)).toBe(false);
    // Control: plain git runs the configured fsmonitor program.
    spawnSync('git', ['status', '--porcelain'], { cwd: dir, env: SETUP_ENV });
    expect(existsSync(fsm.marker)).toBe(true);
  });

  it.each([
    ['filter.evil.clean', 'cat'],
    ['diff.evil.textconv', 'cat'],
    ['url.https://evil.example/.insteadOf', 'https://github.com/'],
    ['include.path', '/etc/gitconfig'],
    ['remote.origin.uploadpack', 'evil'],
    ['credential.https://github.com.helper', 'store'],
    ['pager.status', 'evil'],
  ])('refuses a repo with %s set', async (key, value) => {
    const dir = repo();
    sh(dir, 'config', key, value);
    expect(await runner().run(cmd(dir, ['status', '--porcelain']))).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('untrusted repo config') as unknown,
    });
  });

  it('refuses a repo whose config is too large to scan in full, even when the bad key comes last', async () => {
    const dir = repo();
    const t = trap('filter-after-padding');
    const padding = Array.from({ length: 80_000 }, (_, i) => `\tk${i} = v\n`).join('');
    writeFileSync(
      join(dir, '.git', 'config'),
      `${readFileSync(join(dir, '.git', 'config'), 'utf8')}[pad]\n${padding}[filter "evil"]\n\tclean = ${t.path}\n`,
    );
    writeFileSync(join(dir, '.gitattributes'), '* filter=evil\n');
    writeFileSync(join(dir, 'b.txt'), 'x\n');
    expect(await runner().run(cmd(dir, ['add', 'b.txt']))).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('cannot be fully checked') as unknown,
    });
    expect(existsSync(t.marker)).toBe(false);
  });

  it('refuses a key hidden behind a tab in its subsection and a repo config git cannot parse', async () => {
    const dir = repo();
    sh(dir, 'config', 'filter.a\tb.clean', 'cat');
    expect(await runner().run(cmd(dir, ['status', '--porcelain']))).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('untrusted repo config') as unknown,
    });
    const broken = repo();
    writeFileSync(join(broken, '.git', 'config'), '[core\n');
    expect(await runner().run(cmd(broken, ['status', '--porcelain']))).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('scan failed') as unknown,
    });
  });

  it('parses only whole scope/name pairs from the config scan', () => {
    expect(configNames('')).toEqual([]);
    expect(configNames('command\0core.pager\0local\0filter.a\tb.clean\0')).toEqual([
      'filter.a\tb.clean',
    ]);
    expect(configNames('local\0core.bare')).toBeNull();
    expect(configNames('local\0')).toBeNull();
  });

  it('refuses subcommands outside the allowlist and config writes', async () => {
    const dir = repo();
    expect(await runner().run(cmd(dir, ['gc']))).toMatchObject({
      kind: 'refused',
    });
    expect(await runner().run(cmd(dir, ['-c', 'core.hooksPath=/x', 'status']))).toMatchObject({
      kind: 'refused',
    });
    expect(await runner().run(cmd(dir, ['st']))).toMatchObject({
      kind: 'refused',
    });
    expect(await runner().run(cmd(dir, ['config', 'user.name', 'x']))).toMatchObject({
      kind: 'refused',
    });
    expect(
      await runner().run(cmd(dir, ['config', '--global', '--get', 'user.name'])),
    ).toMatchObject({ kind: 'refused' });
    expect(refuseArgs(['config', '--get', 'remote.origin.url'])).toBeNull();
  });

  it('caps output and kills a command past its deadline', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(200_000));
    sh(dir, 'add', 'big.txt');
    sh(dir, 'commit', '-qm', 'big');
    const r = await runner().run(
      cmd(dir, ['cat-file', 'blob', 'HEAD:big.txt'], {
        max_output_bytes: 1_000,
      }),
    );
    expect(r).toMatchObject({ kind: 'exited', code: 0, truncated: true });
    expect(r.kind === 'exited' && r.stdout.length).toBe(1_000);
    expect(await runner().run(cmd(dir, ['log', '--all'], { timeout_ms: 1 }))).toEqual({
      kind: 'timeout',
    });
  });

  it('passes stdin and fetches only over allowed transports', async () => {
    const dir = repo();
    const r = await runner().run(cmd(dir, ['hash-object', '--stdin'], { stdin: 'hello\n' }));
    expect(r.kind === 'exited' && r.stdout.trim()).toBe(sh(dir, 'rev-parse', 'HEAD:a.txt'));

    const remote = join(base, `remote${n++}.git`);
    sh(base, 'clone', '-q', '--bare', dir, remote);
    const clone = repo();
    expect(
      await runner().run(
        cmd(clone, ['fetch', '--quiet', remote, '+refs/heads/main:refs/remotes/r/main']),
      ),
    ).toMatchObject({ kind: 'exited', code: 0 });
    const blocked = await runner({ protocols: ['https'] }).run(
      cmd(clone, ['fetch', '--quiet', `file://${remote}`, '+refs/heads/main:refs/remotes/r2/main']),
    );
    expect(blocked).toMatchObject({ kind: 'exited' });
    expect(blocked.kind === 'exited' && blocked.code).not.toBe(0);
  });

  it('rejects wildcard or relative safe.directory and unsafe paths at construction', () => {
    expect(() => runner({ safeDirectories: ['*'] })).toThrow(GitConfigError);
    expect(() => runner({ safeDirectories: ['/'] })).toThrow(GitConfigError);
    expect(() => runner({ safeDirectories: ['repo'] })).toThrow(GitConfigError);
    expect(() => runner({ credentialHelper: '!sh -c evil' })).toThrow(GitConfigError);
    expect(untrustedConfigKeys(['core.hookspath', 'user.name', 'Filter.LFS.Process'])).toEqual([
      'Filter.LFS.Process',
    ]);
  });
});
