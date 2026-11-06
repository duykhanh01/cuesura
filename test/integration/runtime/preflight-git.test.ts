import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GitCommandRunner } from '../../../src/adapters/git/command.ts';
import { checkHost, preflight } from '../../../src/application/preflight.ts';
import { fakeCapabilityManifest } from '../../../src/adapters/harness/fake.ts';
import type { GitPort, GitResult, HostProbePort } from '../../../src/adapters/ports.ts';
import { NodeHostProbe } from '../../../src/runner/host-probe.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';
import { ok } from '../../../src/shared/result.ts';
import { buildTask } from '../../support/builders.ts';
import { PACKS, source } from '../../support/config-fixtures.ts';

// Real Git objects in a temp repo whose origin is a local bare repo behind a github.com insteadOf.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-preflight-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@x',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@x',
};

function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const testGit: GitPort = {
  run: (c) =>
    new Promise<GitResult>((resolve) => {
      execFile(
        'git',
        [...c.args],
        {
          cwd: c.cwd,
          env: GIT_ENV,
          timeout: c.timeout_ms,
          maxBuffer: c.max_output_bytes,
          encoding: 'utf8',
        },
        (e, stdout, stderr) => {
          if (e === null)
            return resolve({
              kind: 'exited',
              code: 0,
              stdout,
              stderr,
              truncated: false,
            });
          resolve(
            typeof e.code === 'number'
              ? {
                  kind: 'exited',
                  code: e.code,
                  stdout,
                  stderr,
                  truncated: false,
                }
              : { kind: 'spawn_failed', message: e.message },
          );
        },
      );
    }),
};

const passingHost: HostProbePort = {
  findExecutable: (n) => Promise.resolve(`/usr/bin/${n}`),
  realpath: (p) =>
    Promise.resolve(spawnSync('realpath', ['-e', p], { encoding: 'utf8' }).stdout.trim() || null),
  readText: () => Promise.resolve(null),
  exec: () => Promise.resolve({ kind: 'exited', code: 0, stdout: '', stderr: '' }),
};

const github = {
  request: () =>
    Promise.resolve(
      ok({
        status: 200,
        headers: {},
        body: { id: 77, full_name: 'acme/app' },
        evidence_digest: hashCanonical('r'),
      }),
    ),
};
const manifests = {
  claude: fakeCapabilityManifest(),
  codex: fakeCapabilityManifest(),
};
const CUSR = source('configs/valid/cusr.yaml').text;

describe('preflight on real Git objects (T030)', () => {
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  const repo = join(base, 'acme');
  sh(base, 'init', '--bare', '-b', 'main', remote);
  sh(base, 'clone', '-q', remote, seed);
  writeFileSync(join(seed, 'cusr.yaml'), CUSR);
  sh(seed, 'add', 'cusr.yaml');
  sh(seed, 'commit', '-qm', 'config');
  sh(seed, 'push', '-q', 'origin', 'main');
  sh(base, 'clone', '-q', remote, repo);
  sh(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git');
  sh(repo, 'config', `url.${remote}.insteadOf`, 'https://github.com/acme/app.git');

  const user = source('configs/valid/user.yaml');
  user.text = `${user.text.replace('  acme: { base_branch: main }', `  acme: { base_branch: main, path: ${repo}, repo: acme/app }`)}runtime: {}\n`;

  it('freezes against the newest base on origin and its cusr.yaml, ignoring the working tree', async () => {
    // A newer commit on origin that the local clone has not fetched, and a dirty local cusr.yaml.
    writeFileSync(
      join(seed, 'cusr.yaml'),
      CUSR.replace('required_checks: [build, test]', 'required_checks: [build, test, e2e]'),
    );
    sh(seed, 'commit', '-qam', 'newer config');
    sh(seed, 'push', '-q', 'origin', 'main');
    const newest = sh(seed, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'cusr.yaml'), 'version: 1\n');

    const r = await preflight(
      { git: testGit, github, host: passingHost },
      { task: buildTask(), user, packs: PACKS, manifests },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.base_sha).toBe(newest);
    expect(r.value.common_git_dir).toBe(join(repo, '.git'));
    expect(r.value.validated.config.project?.required_checks).toEqual(['build', 'test', 'e2e']);
    expect(r.value.target).toEqual({
      repo: 'acme/app',
      immutable_repo_id: '77',
      base_ref: 'main',
    });
    expect(sh(repo, 'rev-parse', 'HEAD')).not.toBe(newest);
  });

  it('with the real Git port, a repo-config URL rewrite is refused as config_invalid before any fetch', async () => {
    const hooks = join(base, 'hooks');
    mkdirSync(hooks, { recursive: true });
    const gitBin = realpathSync(
      spawnSync('sh', ['-c', 'command -v git'], {
        encoding: 'utf8',
      }).stdout.trim(),
    );
    const realGit = new GitCommandRunner({
      git: gitBin,
      emptyHooksDir: hooks,
      safeDirectories: [repo],
      credentialHelper: null,
      home: base,
      protocols: ['file'],
    });
    const r = await preflight(
      { git: realGit, github, host: passingHost },
      { task: buildTask(), user, packs: PACKS, manifests },
    );
    expect(r.ok ? null : r.error).toMatchObject({
      code: 'config_invalid',
      problems: [
        {
          check: 'project_path',
          message: expect.stringContaining('url.') as unknown,
        },
      ],
    });
  });

  it('a task on a PR freezes where the approved head left the base, with the config of that commit', async () => {
    const fork = sh(seed, 'rev-parse', 'HEAD');
    sh(seed, 'checkout', '-q', '-b', 'feature/pr');
    writeFileSync(join(seed, 'pr.txt'), 'pr\n');
    // A PR cannot rewrite the rules it runs under: this config is never read.
    writeFileSync(join(seed, 'cusr.yaml'), 'version: 1\n');
    sh(seed, 'add', '.');
    sh(seed, 'commit', '-qm', 'pr work');
    sh(seed, 'push', '-q', 'origin', 'feature/pr');
    const head = sh(seed, 'rev-parse', 'HEAD');
    sh(seed, 'checkout', '-q', 'main');
    writeFileSync(join(seed, 'later.txt'), 'later\n');
    sh(seed, 'add', '.');
    sh(seed, 'commit', '-qm', 'base moved on');
    sh(seed, 'push', '-q', 'origin', 'main');

    const check = (head_sha: string, head_branch = 'feature/pr') =>
      preflight(
        { git: testGit, github, host: passingHost },
        {
          task: buildTask(),
          user,
          packs: PACKS,
          manifests,
          adoption: { head_branch, head_sha },
        },
      );
    const r = await check(head);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.base_sha).toBe(fork);
    // The head is in the project's objects for the worktree.
    expect(sh(repo, 'rev-parse', `${head}^{commit}`)).toBe(head);

    const moved = await check(fork);
    expect(moved.ok ? null : moved.error).toMatchObject({
      code: 'config_invalid',
      problems: [{ check: 'adopt_pr', message: expect.stringContaining(head) as unknown }],
    });
    const gone = await check(head, 'feature/deleted');
    expect(gone.ok ? null : gone.error).toMatchObject({
      code: 'config_invalid',
      problems: [{ check: 'adopt_pr' }],
    });
  });

  it('a base branch missing on origin is config_invalid', async () => {
    const r = await preflight(
      { git: testGit, github, host: passingHost },
      {
        task: buildTask({ base_branch: 'release' }),
        user: {
          ...user,
          text: user.text.replace('base_branch: main, path', 'base_branch: release, path'),
        },
        packs: PACKS,
        manifests,
      },
    );
    expect(r.ok ? null : r.error).toMatchObject({
      code: 'config_invalid',
      problems: [{ check: 'base' }],
    });
  });
});

const host = new NodeHostProbe();
const bwrapUsable =
  spawnSync('bwrap', ['--unshare-user', '--ro-bind', '/', '/', '/usr/bin/true']).status === 0;
const userBus = spawnSync('systemctl', ['--user', 'show', '--property=Version']).status === 0;

describe.skipIf(!bwrapUsable || !userBus)('host probe on this host (T030)', () => {
  it('finds no missing prerequisite where bwrap and the user manager already work', async () => {
    expect(await checkHost(host, null)).toEqual([]);
  });
});
