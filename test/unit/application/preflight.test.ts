import { describe, expect, it } from 'vitest';
import {
  checkHost,
  commandTool,
  githubSlugFromRemote,
  preflight,
  preflightWait,
  type PreflightError,
  type SandboxTools,
} from '../../../src/application/preflight.ts';
import type { CapabilityManifest } from '../../../src/domain/runtime.ts';
import type { ExecutionMode } from '../../../src/domain/run-config.ts';
import type { ConfigSource } from '../../../src/config/yaml-loader.ts';
import { buildTask } from '../../support/builders.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import {
  CUSR,
  fakeGit,
  fakeGitHub,
  fakeHost,
  manifest,
  MANIFESTS,
  REPO,
  SHA,
  userConfig,
  type GitOpts,
  type HostOpts,
} from '../../support/preflight-fakes.ts';

async function runPreflight(
  o: {
    user?: ConfigSource;
    host?: HostOpts;
    git?: GitOpts;
    github?: Parameters<typeof fakeGitHub>[0];
    manifests?: Record<string, CapabilityManifest | null>;
    task?: Parameters<typeof buildTask>[0];
    mode?: ExecutionMode | null;
    harness_tools?: Record<string, SandboxTools>;
    gate_path?: string[];
  } = {},
) {
  const ports = {
    git: fakeGit(o.git),
    github: fakeGitHub(o.github),
    host: fakeHost(o.host),
  };
  const result = await preflight(ports, {
    task: buildTask(o.task),
    user: o.user ?? userConfig(),
    packs: PACKS,
    manifests: o.manifests ?? MANIFESTS,
    mode: o.mode === undefined ? 'full-review' : o.mode,
    ...(o.harness_tools === undefined ? {} : { harness_tools: o.harness_tools }),
    ...(o.gate_path === undefined ? {} : { gate_path: o.gate_path }),
  });
  return { result, ports };
}

function failure(r: Awaited<ReturnType<typeof runPreflight>>['result']): PreflightError {
  if (r.ok) throw new Error('expected preflight to fail');
  return r.error;
}

function checks(e: PreflightError): string[] {
  return 'problems' in e
    ? e.problems.map((p) => `${p.code}:${p.check}${p.cause === null ? '' : `:${p.cause}`}`)
    : [`infra:${e.check}`];
}

describe('preflight (T030, FR-002)', () => {
  it('returns a candidate from the fetched base: config read from the base commit, repo id, manifest refs', async () => {
    const { result, ports } = await runPreflight();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      base_sha: SHA,
      project_path: REPO,
      common_git_dir: `${REPO}/.git`,
      target: { repo: 'acme/app', immutable_repo_id: '4242', base_ref: 'main' },
      capability_refs: {
        claude: MANIFESTS.claude.manifest_hash,
        codex: MANIFESTS.codex.manifest_hash,
      },
    });
    expect(result.value.validated.config.files.project).toBe(`cusr.yaml@${SHA}`);
    expect(result.value.validated.config.project?.required_checks).toEqual(['build', 'test']);
    expect(ports.git.calls).toContainEqual([
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      '--quiet',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
    ]);
    expect(ports.git.calls).toContainEqual(['cat-file', 'blob', `${SHA}:cusr.yaml`]);
    expect(ports.github.requests).toEqual([
      { method: 'GET', path: 'repos/acme/app', query: {}, body: null },
    ]);
  });

  it('maps failures before RUNNING to PENDING/needs_info and after RUNNING to WAITING/policy', () => {
    expect(preflightWait('config_invalid', 'before_running')).toEqual({
      status: 'PENDING',
      reason: 'needs_info',
      detail: 'config_invalid',
    });
    expect(preflightWait('capability_missing', 'before_running')).toEqual({
      status: 'PENDING',
      reason: 'needs_info',
      detail: 'capability_missing',
    });
    expect(preflightWait('capability_missing', 'after_running')).toEqual({
      status: 'WAITING',
      reason: 'policy',
      detail: 'capability_missing',
    });
  });

  describe('host prerequisites for native harness execution', () => {
    it('does not probe outer bwrap or require namespaces globally', async () => {
      const host = fakeHost({
        bwrap: false,
        sysctl: { '/proc/sys/user/max_user_namespaces': '0' },
      });
      expect(await checkHost(host, null)).toEqual([]);
      expect(host.execs).toEqual([['/usr/bin/systemctl', '--user', 'show', '--property=Version']]);
    });
    it.each([{ userBus: false }, { systemd: false }])(
      'requires a working systemd user manager',
      async (opts) => {
        const p = await checkHost(fakeHost(opts), null);
        expect(p.map((x) => x.cause)).toEqual(['systemd_user_unavailable']);
        expect(p[0]?.runbook).toContain('deploy/README.md');
      },
    );
    it('rejects host problems before any Git or GitHub read', async () => {
      const { result, ports } = await runPreflight({
        host: { userBus: false },
      });
      expect(failure(result)).toMatchObject({ code: 'capability_missing' });
      expect(ports.git.calls).toEqual([]);
      expect(ports.github.requests).toEqual([]);
    });
  });

  describe('config and project location', () => {
    it('requires runtime, path and repo for the task project', async () => {
      expect(
        checks(failure((await runPreflight({ user: userConfig({ runtime: null }) })).result)),
      ).toEqual(['config_invalid:runtime']);
      expect(
        checks(
          failure(
            (
              await runPreflight({
                user: userConfig({ project: 'acme: { base_branch: main }' }),
              })
            ).result,
          ),
        ),
      ).toEqual(['config_invalid:project_path', 'config_invalid:project_repo']);
      expect(checks(failure((await runPreflight({ task: { project: 'other' } })).result))).toEqual([
        'config_invalid:project',
      ]);
    });

    it('reports user config diagnostics as config_invalid', async () => {
      const e = failure(
        (
          await runPreflight({
            user: { file: 'config.yaml', text: 'version: 2\n' },
          })
        ).result,
      );
      expect(e).toMatchObject({ code: 'config_invalid' });
      expect('problems' in e && e.problems[0]?.diagnostics.length).toBeGreaterThan(0);
    });

    it('rejects a non-root path and a remote that is not the allowlisted repo', async () => {
      expect(
        checks(failure((await runPreflight({ git: { toplevel: '/srv/repos' } })).result)),
      ).toEqual(['config_invalid:project_path']);
      expect(
        checks(
          failure(
            (
              await runPreflight({
                git: { remote: 'https://github.com/evil/app.git' },
              })
            ).result,
          ),
        ),
      ).toEqual(['config_invalid:remote']);
      expect(
        checks(
          failure(
            (
              await runPreflight({
                git: { remote: 'https://gitlab.com/acme/app.git' },
              })
            ).result,
          ),
        ),
      ).toEqual(['config_invalid:remote']);
    });

    it('a missing base branch is config_invalid; a transport failure is infra, not a config verdict', async () => {
      expect(
        checks(
          failure(
            (
              await runPreflight({
                git: {
                  fetch: {
                    code: 128,
                    stderr: "fatal: couldn't find remote ref main",
                  },
                },
              })
            ).result,
          ),
        ),
      ).toEqual(['config_invalid:base']);
      expect(
        failure(
          (
            await runPreflight({
              git: {
                fetch: {
                  code: 128,
                  stderr: 'fatal: unable to access: Could not resolve host',
                },
              },
            })
          ).result,
        ),
      ).toMatchObject({
        code: 'infra_unavailable',
        check: 'base',
      });
    });

    it('reads cusr.yaml only as a regular blob of the base commit', async () => {
      expect(checks(failure((await runPreflight({ git: { mode: '120000' } })).result))).toEqual([
        'config_invalid:project_config',
      ]);
      expect(checks(failure((await runPreflight({ git: { cusr: null } })).result))).toEqual([
        'config_invalid:required_checks',
        'config_invalid:profile',
      ]);
      expect(
        checks(
          failure(
            (
              await runPreflight({
                git: {
                  cusr: CUSR.replace('required_checks: [build, test]', 'required_checks: []'),
                },
              })
            ).result,
          ),
        ),
      ).toEqual(['config_invalid:required_checks']);
      const bad = failure((await runPreflight({ git: { cusr: `${CUSR}yolo: true\n` } })).result);
      expect(checks(bad)).toEqual(['config_invalid:project_config']);
    });

    it('pins the immutable GitHub repo id and does not follow a rename', async () => {
      expect(checks(failure((await runPreflight({ github: 'renamed' })).result))).toEqual([
        'config_invalid:github_repo',
      ]);
      expect(checks(failure((await runPreflight({ github: 404 })).result))).toEqual([
        'config_invalid:github_repo',
      ]);
      expect(checks(failure((await runPreflight({ github: 403 })).result))).toEqual([
        'capability_missing:github_repo',
      ]);
      expect(failure((await runPreflight({ github: 'unknown' })).result)).toMatchObject({
        code: 'infra_unavailable',
        check: 'github_repo',
      });
    });
  });

  describe('commands a sandbox of this task can run', () => {
    const NONE = { dirs: ['/nowhere'], requires: [] };
    const FULL = { dirs: ['/usr/bin'], requires: [] };
    const toolchainProblems = (r: Awaited<ReturnType<typeof runPreflight>>['result']): string[] => {
      const e = failure(r);
      return 'problems' in e
        ? e.problems.filter((p) => p.check === 'toolchain').map((p) => p.message)
        : [];
    };

    it('reads the program of a plain gate command, and nothing from shell syntax or a path', () => {
      expect(commandTool('node --test')).toBe('node');
      expect(commandTool('PYTHONPATH=src python3 -m unittest')).toBe('python3');
      expect(commandTool('./scripts/check.sh')).toBeNull();
      expect(commandTool('(cd web && npm test)')).toBeNull();
      expect(commandTool('cd web && npm test')).toBeNull();
      expect(commandTool('umask 077 && npm test')).toBeNull();
      expect(commandTool('printf x')).toBeNull();
    });

    it('refuses a worker whose sandbox lacks what the gates run, before any agent turn', async () => {
      const { result } = await runPreflight({
        harness_tools: { claude: NONE, codex: FULL },
      });
      const [message, ...rest] = toolchainProblems(result);
      expect(rest).toEqual([]);
      expect(message).toContain("harness 'claude' sandbox cannot run npm");
      expect((await runPreflight({ harness_tools: { claude: FULL, codex: FULL } })).result.ok).toBe(
        true,
      );
    });

    it('checks what the project declares and what the binary needs', async () => {
      const declared = await runPreflight({
        git: { cusr: `${CUSR}\ntools: [pnpm]\n` },
        harness_tools: {
          claude: { dirs: ['/nowhere'], requires: ['socat'] },
          codex: FULL,
        },
      });
      expect(toolchainProblems(declared.result)[0]).toContain('cannot run socat, pnpm, npm');
    });

    it('asks the same of setup, which runs in the gate sandbox', async () => {
      const { result } = await runPreflight({
        git: { cusr: CUSR.replace('setup: "npm ci"', 'setup: "uv sync"') },
        gate_path: ['/nowhere'],
      });
      expect(toolchainProblems(result)[0]).toContain('cannot run uv, npm');
    });

    it('refuses gates the gate sandbox cannot run', async () => {
      const { result } = await runPreflight({ gate_path: ['/nowhere'] });
      expect(toolchainProblems(result)).toEqual([
        'the gate sandbox cannot run npm from its PATH (/nowhere)',
      ]);
    });
  });

  describe('what daemon 002 runs (FR-002.05: never drops a role or rebinds)', () => {
    it('never skips review by size; a task that needs scout is still refused', async () => {
      // software_dev@2 has no size skip: an XS task in full-review is reviewed, not refused or skipped.
      expect((await runPreflight({ task: { size: 'XS' } })).result.ok).toBe(true);
      expect(
        checks(failure((await runPreflight({ task: { labels: ['needs_scout'] } })).result)),
      ).toEqual(['capability_missing:role']);
    });

    it('direct-pr needs no reviewer capability, binding or role; full-review does (M01/M03)', async () => {
      const noReviewer = { claude: MANIFESTS.claude, codex: null };
      expect((await runPreflight({ manifests: noReviewer, mode: 'direct-pr' })).result.ok).toBe(
        true,
      );
      expect(
        checks(
          failure((await runPreflight({ manifests: noReviewer, mode: 'full-review' })).result),
        ),
      ).toEqual(['capability_missing:harness']);
      const user = userConfig({ extra: '' });
      user.text = user.text.replace(
        'allow_roles: [scout, coder, reviewer, fixer]',
        'allow_roles: [coder, fixer]',
      );
      expect((await runPreflight({ user, mode: 'direct-pr' })).result.ok).toBe(true);
      // Before any selection is proposed only what both modes need is checked.
      expect((await runPreflight({ manifests: noReviewer, mode: null })).result.ok).toBe(true);
    });

    it('a mode outside runtime.modes is refused as config, not swapped for another', async () => {
      const user = userConfig({
        runtime: 'runtime:\n  modes: { full-review: { when_to_use: "always review" } }',
      });
      expect(checks(failure((await runPreflight({ user, mode: 'direct-pr' })).result))).toEqual([
        'config_invalid:mode',
      ]);
      expect((await runPreflight({ user, mode: 'full-review' })).result.ok).toBe(true);
    });

    it('rejects a profile that does not allow a role the workflow runs', async () => {
      const user = userConfig({ extra: '' });
      user.text = user.text.replace(
        'allow_roles: [scout, coder, reviewer, fixer]',
        'allow_roles: [coder, fixer]',
      );
      expect(checks(failure((await runPreflight({ user })).result))).toEqual([
        'capability_missing:role',
      ]);
    });

    it('accepts yolo in the user config', async () => {
      const { result } = await runPreflight({
        user: userConfig({ extra: 'yolo: true\n' }),
      });
      expect(result.ok).toBe(true);
    });

    it('requires a usable manifest for every harness a used role can reach', async () => {
      expect(
        checks(
          failure(
            (
              await runPreflight({
                manifests: { claude: MANIFESTS.claude, codex: null },
              })
            ).result,
          ),
        ),
      ).toEqual(['capability_missing:harness']);
      expect(
        checks(
          failure(
            (
              await runPreflight({
                manifests: {
                  ...MANIFESTS,
                  codex: manifest({ role_schemas: {} }),
                },
              })
            ).result,
          ),
        ),
      ).toEqual(['capability_missing:harness']);
      expect(
        checks(
          failure(
            (
              await runPreflight({
                manifests: {
                  ...MANIFESTS,
                  claude: manifest({
                    capabilities: { permission_enforced: 'unsupported' },
                  }),
                },
              })
            ).result,
          ),
        ),
      ).toEqual(['capability_missing:harness']);
      expect(
        checks(
          failure(
            (
              await runPreflight({
                manifests: {
                  ...MANIFESTS,
                  claude: manifest({
                    selected_inner_mode: 'external_verified',
                  }),
                },
              })
            ).result,
          ),
        ),
      ).toEqual(['capability_missing:harness']);
    });
  });

  it('parses GitHub remote URLs and nothing else', () => {
    expect(githubSlugFromRemote('https://github.com/acme/app.git')).toBe('acme/app');
    expect(githubSlugFromRemote('https://github.com/acme/app')).toBe('acme/app');
    expect(githubSlugFromRemote('git@github.com:acme/app.git\n')).toBe('acme/app');
    expect(githubSlugFromRemote('ssh://git@github.com/acme/app.git')).toBe('acme/app');
    expect(githubSlugFromRemote('https://github.com.evil.io/acme/app.git')).toBeNull();
    expect(githubSlugFromRemote('https://github.com/acme/app/extra')).toBeNull();
    expect(githubSlugFromRemote('/srv/mirror/app.git')).toBeNull();
  });
});

describe('preflight: base branch of an unmerged PR (issue #167)', () => {
  const branch = 'cusr/01a1acf5-8a48-75ad-a6be-c073da7c7580-feat-x';
  const stacked = { default_branch: 'main', pulls: [{ number: 139, base: { ref: 'main' } }] };

  it('stops the task when its base is the head of an open PR, naming the PR and its task', async () => {
    const { result, ports } = await runPreflight({
      task: { base_branch: branch },
      github: stacked,
    });
    const e = failure(result);
    expect(checks(e)).toEqual(['config_invalid:stacked_base']);
    const p = 'problems' in e ? e.problems[0] : undefined;
    expect(p?.message).toContain('acme/app#139');
    expect(p?.message).toContain('task 01a1acf5-8a48-75ad-a6be-c073da7c7580');
    expect(p?.fix).toContain('cusr task add --pr acme/app#139');
    expect(p?.fix).toContain("labels include 'stacked-base'");
    expect(ports.github.requests.at(-1)).toMatchObject({
      path: 'repos/acme/app/pulls',
      query: { state: 'open', head: `acme:${branch}` },
    });
  });

  it('lets the owner stack on purpose with the stacked-base label', async () => {
    const { result, ports } = await runPreflight({
      task: { base_branch: branch, labels: ['stacked-base'] },
      github: stacked,
    });
    expect(result.ok).toBe(true);
    expect(ports.github.requests.map((r) => r.path)).toEqual(['repos/acme/app']);
  });

  it('ignores the label on a task the assistant added: only the owner opts in', async () => {
    const { result } = await runPreflight({
      task: {
        base_branch: branch,
        labels: ['stacked-base'],
        requested_by: { kind: 'assistant', id: 'assistant' },
      },
      github: stacked,
    });
    expect(checks(failure(result))).toEqual(['config_invalid:stacked_base']);
  });

  it('passes a non-default base that no open PR has as its head', async () => {
    const { result } = await runPreflight({
      task: { base_branch: 'release' },
      github: { default_branch: 'main', pulls: [] },
    });
    expect(result.ok).toBe(true);
  });

  it('does not read PRs for a task on the default branch', async () => {
    const { result, ports } = await runPreflight({ github: stacked });
    expect(result.ok).toBe(true);
    expect(ports.github.requests.map((r) => r.path)).toEqual(['repos/acme/app']);
  });
});
