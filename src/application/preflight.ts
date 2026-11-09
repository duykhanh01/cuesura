/**
 * Preflight of a task before its snapshot is frozen (FR-002, T030). Reads the latest base revision and
 * the project config from Git objects, checks the project location, remote identity, host prerequisites
 * of the Isolated runtime and what daemon 002 can run. It only reports: it never changes the host, the
 * config or the task's bindings, and its result is a candidate; the single snapshot is frozen at start.
 */
import type { GitHubPort, GitPort, GitResult, HostProbePort } from '../adapters/ports.ts';
import { ROLES, type Role } from '../adapters/harness/result-schema.ts';
import { manifestShortfalls } from './capabilities.ts';
import type { RuntimeConfig } from '../config/normalize.ts';
import { validateConfig, type Validated } from '../config/validate.ts';
import type { ConfigSource } from '../config/yaml-loader.ts';
import type { Diagnostic } from '../domain/config.ts';
import type { CapabilityManifest } from '../domain/runtime.ts';
import type { ExecutionMode } from '../domain/run-config.ts';
import type { Adoption } from '../domain/state.ts';
import type { CanonicalTask } from '../domain/task.ts';
import { evalPredicate, type StepDef } from '../domain/workflow.ts';
import { modeGraph } from '../engine/workflows/software-dev.ts';
import { bindingFacts } from '../policy/binding.ts';
import type { Hash } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';

const RUNBOOK_CAUSES = 'deploy/README.md#host-prerequisites';
const RUNBOOK_SYSTEMD = 'deploy/README.md#systemd-and-wsl2';
const PROBE_TIMEOUT_MS = 5_000;
const GIT_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_BYTES = 64 * 1024;
const PROJECT_CONFIG_BYTES = 1024 * 1024;
const PROJECT_CONFIG_FILE = 'cusr.yaml';
export const DISPATCH_FILE = 'cusr.dispatch.yaml';

export const HOST_CAUSES = ['systemd_user_unavailable'] as const;
export type HostCause = (typeof HOST_CAUSES)[number];

export type PreflightCode = 'config_invalid' | 'capability_missing';

export type PreflightProblem = {
  readonly code: PreflightCode;
  readonly check: string;
  readonly message: string;
  readonly cause: HostCause | null;
  /** Command or edit the user runs; preflight never runs it. */
  readonly fix: string | null;
  readonly runbook: string | null;
  readonly diagnostics: readonly Diagnostic[];
};

/**
 * `infra_unavailable`: a read could not establish a fact (Git transport, GitHub unknown, timeout). It is
 * not a config verdict; the caller handles it as infrastructure (FR-015) and does not change the task.
 */
export type PreflightError =
  | {
      readonly code: PreflightCode;
      readonly problems: readonly PreflightProblem[];
    }
  | {
      readonly code: 'infra_unavailable';
      readonly check: string;
      readonly detail: string;
    };

export type PreflightCandidate = {
  readonly base_sha: string;
  readonly validated: Validated;
  readonly runtime: RuntimeConfig;
  readonly project_path: string;
  readonly common_git_dir: string;
  readonly target: {
    readonly repo: string;
    readonly immutable_repo_id: string;
    readonly base_ref: string;
  };
  /** Harness → `manifest_hash` of the manifest the check accepted. */
  readonly capability_refs: Readonly<Record<string, Hash>>;
};

export type PreflightInput = {
  readonly task: CanonicalTask;
  /** Trusted user config, read by the caller outside the repo. */
  readonly user: ConfigSource;
  readonly packs: Readonly<Record<string, ConfigSource>>;
  /** Current manifest per harness; null when none was recorded. */
  readonly manifests: Readonly<Record<string, CapabilityManifest | null>>;
  /** Why a harness has no manifest here, when the source knows; doctor reports it. */
  readonly manifest_problems?: Readonly<Record<string, string>>;
  /** Mode of the run selection, when one is proposed; reviewer checks apply to `full-review` only. */
  readonly mode?: ExecutionMode | null;
  /** What each harness's sandbox can run; a harness not listed has its tools left unchecked. */
  readonly harness_tools?: Readonly<Record<string, SandboxTools>>;
  /** PATH of the gate sandbox; left unchecked when absent. */
  readonly gate_path?: readonly string[];
  /** The PR head the task continues from: the base it freezes is where that head left the base branch. */
  readonly adoption?: Pick<Adoption, 'head_branch' | 'head_sha'>;
};

/** PATH directories of a harness's sandbox and the commands its binary cannot start without. */
export type SandboxTools = {
  readonly dirs: readonly string[];
  readonly requires: readonly string[];
};

export type PreflightPorts = {
  readonly git: GitPort;
  readonly github: GitHubPort;
  readonly host: HostProbePort;
};

/** Where a failed preflight leaves the task (FR-002.02/04): never PENDING once it has run. */
export function preflightWait(
  code: PreflightCode,
  phase: 'before_running' | 'after_running',
):
  | {
      readonly status: 'PENDING';
      readonly reason: 'needs_info';
      readonly detail: PreflightCode;
    }
  | {
      readonly status: 'WAITING';
      readonly reason: 'policy';
      readonly detail: PreflightCode;
    } {
  return phase === 'before_running'
    ? { status: 'PENDING', reason: 'needs_info', detail: code }
    : { status: 'WAITING', reason: 'policy', detail: code };
}

function problem(
  code: PreflightCode,
  check: string,
  message: string,
  extra: Partial<Omit<PreflightProblem, 'code' | 'check' | 'message'>> = {},
): PreflightProblem {
  return {
    code,
    check,
    message,
    cause: null,
    fix: null,
    runbook: null,
    diagnostics: [],
    ...extra,
  };
}

/** Any config problem decides the code: the user fixes config before capabilities can be judged. */
function failed(problems: readonly PreflightProblem[]): PreflightError {
  return {
    code: problems.some((p) => p.code === 'config_invalid')
      ? 'config_invalid'
      : 'capability_missing',
    problems,
  };
}

class Infra extends Error {
  readonly check: string;
  readonly detail: string;
  constructor(check: string, detail: string) {
    super(`${check}: ${detail}`);
    this.check = check;
    this.detail = detail;
  }
}

/** The Git port refused the call (argv or untrusted repo config): a config verdict, not infrastructure. */
class GitRefused extends Error {
  readonly check: string;
  readonly reason: string;
  constructor(check: string, reason: string) {
    super(`${check}: ${reason}`);
    this.check = check;
    this.reason = reason;
  }
}

export async function preflight(
  ports: PreflightPorts,
  input: PreflightInput,
): Promise<Result<PreflightCandidate, PreflightError>> {
  try {
    return await run(ports, input);
  } catch (e) {
    if (e instanceof Infra)
      return err({
        code: 'infra_unavailable',
        check: e.check,
        detail: e.detail,
      });
    if (e instanceof GitRefused) {
      return err(
        failed([
          problem('config_invalid', e.check, `git refused: ${e.reason}`, {
            fix: 'remove the listed keys from the repo config (.git/config) or run the command yourself',
          }),
        ]),
      );
    }
    throw e;
  }
}

async function run(
  ports: PreflightPorts,
  input: PreflightInput,
): Promise<Result<PreflightCandidate, PreflightError>> {
  const { task } = input;
  const userOnly = validateConfig({ user: input.user, packs: {} });
  if (!userOnly.ok)
    return err(
      failed([
        problem('config_invalid', 'user_config', 'user config is invalid', {
          diagnostics: userOnly.error,
        }),
      ]),
    );
  const runtime = userOnly.value.runtime;
  const location = userOnly.value.locations[task.project];
  const problems: PreflightProblem[] = [];
  if (runtime === null)
    problems.push(
      problem('config_invalid', 'runtime', 'the `runtime:` section is required by cusrd', {
        fix: 'add `runtime:` to the user config',
      }),
    );
  if (location === undefined) {
    problems.push(
      problem('config_invalid', 'project', `project '${task.project}' is not in the allowlist`, {
        fix: `add projects.${task.project} to the user config`,
      }),
    );
  } else {
    if (location.path === null)
      problems.push(
        problem(
          'config_invalid',
          'project_path',
          `projects.${task.project}.path is required by cusrd`,
        ),
      );
    if (location.repo === null)
      problems.push(
        problem(
          'config_invalid',
          'project_repo',
          `projects.${task.project}.repo is required by cusrd`,
        ),
      );
  }
  problems.push(...(await checkHost(ports.host, runtime)));
  if (
    runtime === null ||
    location === undefined ||
    location.path === null ||
    location.repo === null ||
    problems.length > 0
  )
    return err(failed(problems));

  const repo = await checkProjectRepo(ports, location.path, location.repo, task.base_branch);
  if (!repo.ok) return err(failed(repo.error));
  const fork =
    input.adoption === undefined
      ? ok(repo.value.base_sha)
      : await adoptedBase(ports, location.path, repo.value.base_sha, input.adoption);
  if (!fork.ok) return err(failed([fork.error]));
  const base_sha = fork.value;

  const config = await readBaseFile(ports.git, location.path, base_sha, PROJECT_CONFIG_FILE);
  if (!config.ok) return err(failed([config.error]));
  const validated = validateConfig({
    user: input.user,
    ...(config.value === null ? {} : { project: config.value }),
    packs: input.packs,
  });
  if (!validated.ok)
    return err(
      failed([
        problem('config_invalid', 'project_config', `config at base ${base_sha} is invalid`, {
          diagnostics: validated.error,
        }),
      ]),
    );

  const support = checkSupport(validated.value, task, input.manifests, input.mode ?? null);
  support.problems.push(...(await checkTools(ports.host, input, validated.value, support)));
  const remote = await readRepoIdentity(ports.github, location.repo);
  if (!remote.ok) support.problems.push(remote.error);
  else {
    const stacked = await checkStackedBase(ports.github, location.repo, task, remote.value);
    if (stacked !== null) support.problems.push(stacked);
  }
  if (support.problems.length > 0 || !remote.ok) return err(failed(support.problems));

  return ok({
    base_sha,
    validated: validated.value,
    runtime: validated.value.runtime as RuntimeConfig,
    project_path: location.path,
    common_git_dir: repo.value.common_git_dir,
    target: {
      repo: location.repo,
      immutable_repo_id: remote.value.id,
      base_ref: task.base_branch,
    },
    capability_refs: support.capability_refs,
  });
}

// ---- Host prerequisites of native execution (deploy/README.md) ----

function hostProblem(
  cause: HostCause,
  message: string,
  fix: string,
  runbook = RUNBOOK_CAUSES,
): PreflightProblem {
  return problem('capability_missing', 'host', message, {
    cause,
    fix,
    runbook,
  });
}

async function tool(
  host: HostProbePort,
  configured: string | undefined,
  name: string,
): Promise<string | null> {
  return configured === undefined ? host.findExecutable(name) : host.realpath(configured);
}

/** Probes only; never runs sudo, changes a sysctl, loads a profile or falls back to unsandboxed. */
export async function checkHost(
  host: HostProbePort,
  runtime: RuntimeConfig | null,
): Promise<PreflightProblem[]> {
  const paths = runtime?.tool_paths ?? {};
  const out: PreflightProblem[] = [];
  const systemdRun = await tool(host, paths['systemd-run'], 'systemd-run');
  const systemctl = await host.findExecutable('systemctl');
  const userBus =
    systemdRun !== null && systemctl !== null
      ? await host.exec([systemctl, '--user', 'show', '--property=Version'], {
          timeout_ms: PROBE_TIMEOUT_MS,
        })
      : null;
  if (userBus === null || userBus.kind !== 'exited' || userBus.code !== 0) {
    const why =
      userBus === null
        ? 'systemd-run/systemctl not found'
        : userBus.kind === 'exited'
          ? userBus.stderr.trim().slice(0, 512)
          : userBus.kind;
    out.push(
      hostProblem(
        'systemd_user_unavailable',
        `the systemd user manager is unavailable: ${why}`,
        'sudo loginctl enable-linger "$USER"',
        `${RUNBOOK_CAUSES}; ${RUNBOOK_SYSTEMD}`,
      ),
    );
  }
  return out;
}

// ---- Commands a sandbox of this task must be able to run ----

/** What `/bin/sh` answers itself (POSIX keywords and builtins, dash's among them): never a program to look for. */
const SHELL_WORDS: ReadonlySet<string> = new Set(
  `! { } . : [ alias bg break case cd chdir command continue do done echo elif else esac eval exec exit export
   false fc fg fi for getopts hash if in jobs kill local printf pwd read readonly return set shift source test
   then time times trap true type ulimit umask unalias unset until wait while`.split(/\s+/),
);

/** The program a plain `/bin/sh -c` command starts, or null for a path, a keyword or shell syntax. */
export function commandTool(command: string): string | null {
  const words = command.trim().split(/\s+/);
  const first = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? '';
  return /^[A-Za-z0-9._+-]+$/.test(first) && !SHELL_WORDS.has(first) ? first : null;
}

/** Prints each tool (`$2…`) that no directory of `$1` holds as a runnable file. */
export const TOOL_PROBE_SCRIPT =
  'dirs=$1; shift; IFS=:; for t in "$@"; do found=; for d in $dirs; do if [ -f "$d/$t" ] && [ -x "$d/$t" ]; then found=1; fi; done; [ -n "$found" ] || echo "$t"; done; exit 0';

/**
 * Which tools the host can execute with the launcher's PATH, including symlink targets and execute bits.
 */
export async function missingTools(
  host: HostProbePort,
  dirs: readonly string[],
  tools: readonly string[],
): Promise<
  | { readonly ok: true; readonly missing: readonly string[] }
  | { readonly ok: false; readonly detail: string }
> {
  if (tools.length === 0) return { ok: true, missing: [] };
  const r = await host.exec(['/bin/sh', '-c', TOOL_PROBE_SCRIPT, 'sh', dirs.join(':'), ...tools], {
    timeout_ms: PROBE_TIMEOUT_MS,
  });
  if (r.kind !== 'exited') return { ok: false, detail: `the sandbox probe ended: ${r.kind}` };
  if (r.code !== 0)
    return {
      ok: false,
      detail: `the sandbox probe exited ${r.code}: ${r.stderr.trim().slice(0, 512)}`,
    };
  return { ok: true, missing: r.stdout.split('\n').filter((l) => l !== '') };
}

/**
 * Found before any turn is spent: an agent without the project's runtime finishes its code and only then
 * reports blocked, and a gate without it fails with exit 127. Only names are checked, nothing is mounted.
 */
async function checkTools(
  host: HostProbePort,
  input: PreflightInput,
  validated: Validated,
  support: ReturnType<typeof checkSupport>,
): Promise<PreflightProblem[]> {
  const project = validated.config.project;
  const commands = [
    ...(project?.setup ?? []),
    ...Object.values({ ...project?.gates, ...project?.autofix }),
  ];
  const fromGates = commands.flatMap((c) => commandTool(c) ?? []);
  const projectTools = [...new Set([...(project?.tools ?? []), ...fromGates])];
  const out: PreflightProblem[] = [];
  for (const [h, roles] of Object.entries(support.harness_roles).sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const tools = input.harness_tools?.[h];
    if (tools === undefined) continue;
    const works = roles.includes('coder') || roles.includes('fixer');
    const probe = await missingTools(host, tools.dirs, [
      ...new Set([...tools.requires, ...(works ? projectTools : [])]),
    ]);
    if (!probe.ok || probe.missing.length > 0)
      out.push(
        problem(
          'capability_missing',
          'toolchain',
          probe.ok
            ? `harness '${h}' sandbox cannot run ${probe.missing.join(', ')} from its PATH (${tools.dirs.join(':')})`
            : `harness '${h}' sandbox could not be checked: ${probe.detail}`,
          {
            fix: `install it under /usr, or add its directory to toolchain in harnesses/${h}/pin.json and prove the harness again`,
          },
        ),
      );
  }
  if (input.gate_path !== undefined) {
    const probe = await missingTools(host, input.gate_path, [...new Set(fromGates)]);
    if (!probe.ok || probe.missing.length > 0)
      out.push(
        problem(
          'capability_missing',
          'toolchain',
          probe.ok
            ? `the gate sandbox cannot run ${probe.missing.join(', ')} from its PATH (${input.gate_path.join(':')})`
            : `the gate sandbox could not be checked: ${probe.detail}`,
          {
            fix: 'install it under /usr, or run cusrd from a Node that has it',
          },
        ),
      );
  }
  return out;
}

// ---- Project repo, remote identity and base revision ----

async function git(
  port: GitPort,
  cwd: string,
  args: readonly string[],
  check: string,
  opts: { timeout_ms?: number; max_output_bytes?: number } = {},
): Promise<Extract<GitResult, { kind: 'exited' }>> {
  const r = await port.run({
    args,
    cwd,
    timeout_ms: opts.timeout_ms ?? GIT_TIMEOUT_MS,
    max_output_bytes: opts.max_output_bytes ?? GIT_OUTPUT_BYTES,
    stdin: null,
  });
  if (r.kind === 'timeout') throw new Infra(check, `git ${args[0] ?? ''} timed out`);
  if (r.kind === 'spawn_failed') throw new Infra(check, `git could not be started: ${r.message}`);
  if (r.kind === 'refused') throw new GitRefused(check, r.reason);
  return r;
}

/** `owner/repo` of a GitHub remote URL (https, scp-like or ssh); null for anything else. */
export function githubSlugFromRemote(url: string): string | null {
  const m =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return m === null ? null : `${m[1] as string}/${m[2] as string}`;
}

/**
 * The base of a task on an existing PR: the commit where the approved head left the base branch. The
 * task then reads like one that started there and already has the PR's commits: config comes from the
 * base branch, not from the PR, and every diff against the base is the PR's own diff. A head that moved
 * since the approval is refused here, before any worker runs on it.
 */
async function adoptedBase(
  ports: PreflightPorts,
  path: string,
  baseTip: string,
  adoption: NonNullable<PreflightInput['adoption']>,
): Promise<Result<string, PreflightProblem>> {
  const tracking = `refs/remotes/origin/${adoption.head_branch}`;
  const fetch = await git(
    ports.git,
    path,
    [
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      '--quiet',
      'origin',
      `+refs/heads/${adoption.head_branch}:${tracking}`,
    ],
    'adopt_pr',
    { timeout_ms: FETCH_TIMEOUT_MS },
  );
  if (fetch.code !== 0) {
    if (/couldn't find remote ref/i.test(fetch.stderr))
      return err(
        problem(
          'config_invalid',
          'adopt_pr',
          `PR head branch '${adoption.head_branch}' no longer exists on origin`,
        ),
      );
    throw new Infra('adopt_pr', `git fetch failed: ${fetch.stderr.trim().slice(0, 512)}`);
  }
  const tip = await git(
    ports.git,
    path,
    ['rev-parse', '--verify', '--quiet', `${tracking}^{commit}`],
    'adopt_pr',
  );
  if (tip.code !== 0) throw new Infra('adopt_pr', `fetched ${tracking} does not resolve`);
  const observed = tip.stdout.trim();
  if (observed !== adoption.head_sha)
    return err(
      problem(
        'config_invalid',
        'adopt_pr',
        `PR head moved from ${adoption.head_sha} to ${observed} after the approval`,
        { fix: `review the new head, then task approve --kind adopt --head-sha ${observed}` },
      ),
    );
  const fork = await git(ports.git, path, ['merge-base', baseTip, observed], 'adopt_pr');
  if (fork.code !== 0)
    return err(
      problem('config_invalid', 'adopt_pr', 'the PR head shares no history with the base branch'),
    );
  return ok(fork.stdout.trim());
}

async function checkProjectRepo(
  ports: PreflightPorts,
  path: string,
  slug: string,
  baseBranch: string,
): Promise<Result<{ base_sha: string; common_git_dir: string }, PreflightProblem[]>> {
  const real = await ports.host.realpath(path);
  if (real !== path) {
    return err([
      problem(
        'config_invalid',
        'project_path',
        real === null
          ? `project path ${path} does not exist`
          : `project path ${path} is not a realpath (resolves to ${real})`,
      ),
    ]);
  }
  const top = await git(
    ports.git,
    path,
    ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
    'project_path',
  );
  const [toplevel, commonDir] = top.stdout.split('\n');
  if (top.code !== 0 || toplevel === undefined || commonDir === undefined) {
    return err([
      problem('config_invalid', 'project_path', `project path ${path} is not a Git repository`),
    ]);
  }
  if (toplevel !== path)
    return err([
      problem(
        'config_invalid',
        'project_path',
        `project path ${path} is not the repository root (${toplevel})`,
      ),
    ]);
  const common = await ports.host.realpath(commonDir);
  if (common === null)
    return err([
      problem('config_invalid', 'project_path', `Git common dir ${commonDir} does not exist`),
    ]);

  const remote = await git(ports.git, path, ['config', '--get', 'remote.origin.url'], 'remote');
  const remoteSlug = remote.code === 0 ? githubSlugFromRemote(remote.stdout) : null;
  if (remoteSlug === null || remoteSlug.toLowerCase() !== slug.toLowerCase()) {
    const seen = remote.code === 0 ? remote.stdout.trim() : 'none';
    return err([
      problem(
        'config_invalid',
        'remote',
        `remote origin (${seen}) is not the allowlisted GitHub repo ${slug}`,
        {
          fix: `point origin at https://github.com/${slug}.git or fix projects.*.repo`,
        },
      ),
    ]);
  }

  const refOk = await git(
    ports.git,
    path,
    ['check-ref-format', `refs/heads/${baseBranch}`],
    'base',
  );
  if (baseBranch.startsWith('-') || refOk.code !== 0)
    return err([
      problem('config_invalid', 'base', `base branch '${baseBranch}' is not a valid branch name`),
    ]);
  const tracking = `refs/remotes/origin/${baseBranch}`;
  const fetch = await git(
    ports.git,
    path,
    [
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      '--quiet',
      'origin',
      `+refs/heads/${baseBranch}:${tracking}`,
    ],
    'base',
    { timeout_ms: FETCH_TIMEOUT_MS },
  );
  if (fetch.code !== 0) {
    if (/couldn't find remote ref/i.test(fetch.stderr))
      return err([
        problem('config_invalid', 'base', `base branch '${baseBranch}' does not exist on origin`),
      ]);
    throw new Infra('base', `git fetch failed: ${fetch.stderr.trim().slice(0, 512)}`);
  }
  const sha = await git(
    ports.git,
    path,
    ['rev-parse', '--verify', '--quiet', `${tracking}^{commit}`],
    'base',
  );
  if (sha.code !== 0) throw new Infra('base', `fetched ${tracking} does not resolve to a commit`);
  return ok({ base_sha: sha.stdout.trim(), common_git_dir: common });
}

/** A config file of the base commit, never the working tree; null when the commit has none. */
async function readBaseFile(
  port: GitPort,
  path: string,
  sha: string,
  file: string,
): Promise<Result<ConfigSource | null, PreflightProblem>> {
  const entry = await git(port, path, ['ls-tree', sha, '--', file], 'project_config');
  if (entry.code !== 0)
    throw new Infra('project_config', `git ls-tree failed: ${entry.stderr.trim().slice(0, 512)}`);
  const line = entry.stdout.trim();
  if (line === '') return ok(null);
  const mode = line.split(' ')[0];
  if (mode !== '100644' && mode !== '100755') {
    return err(
      problem(
        'config_invalid',
        'project_config',
        `${file} at ${sha} is not a regular file (mode ${mode ?? '?'})`,
      ),
    );
  }
  const blob = await git(port, path, ['cat-file', 'blob', `${sha}:${file}`], 'project_config', {
    max_output_bytes: PROJECT_CONFIG_BYTES,
  });
  if (blob.code !== 0)
    throw new Infra('project_config', `git cat-file failed: ${blob.stderr.trim().slice(0, 512)}`);
  if (blob.truncated)
    return err(
      problem(
        'config_invalid',
        'project_config',
        `${file} at ${sha} is larger than ${PROJECT_CONFIG_BYTES} bytes`,
      ),
    );
  return ok({ file: `${file}@${sha}`, text: blob.stdout });
}

/** Immutable numeric repo ID; a renamed or transferred repo is a mismatch, not a silent follow. */
async function readRepoIdentity(
  port: GitHubPort,
  slug: string,
): Promise<Result<RepoIdentity, PreflightProblem>> {
  const r = await port.request({
    method: 'GET',
    path: `repos/${slug}`,
    query: {},
    body: null,
  });
  if (!r.ok) {
    if (r.error.reason === 'unknown') throw new Infra('github_repo', r.error.detail);
    if (r.error.status === 404)
      return err(
        problem(
          'config_invalid',
          'github_repo',
          `GitHub repo ${slug} was not found or is not visible to the credential`,
        ),
      );
    return err(
      problem(
        'capability_missing',
        'github_repo',
        `GitHub repo ${slug} cannot be read: ${r.error.detail}`,
        {
          fix: 'check the GitHub credential reference in runtime.credential_refs',
        },
      ),
    );
  }
  const body = r.value.body as {
    id?: unknown;
    full_name?: unknown;
    default_branch?: unknown;
  } | null;
  if (typeof body?.id !== 'number' || typeof body.full_name !== 'string')
    throw new Infra('github_repo', 'repo response has no id/full_name');
  if (body.full_name.toLowerCase() !== slug.toLowerCase()) {
    return err(
      problem(
        'config_invalid',
        'github_repo',
        `GitHub repo ${slug} now resolves to ${body.full_name}`,
        {
          fix: 'update projects.*.repo after reviewing the rename/transfer',
        },
      ),
    );
  }
  return ok({
    id: String(body.id),
    default_branch: typeof body.default_branch === 'string' ? body.default_branch : null,
  });
}

type RepoIdentity = { readonly id: string; readonly default_branch: string | null };

/** The label a task carries when its owner chose to build on an unmerged PR's branch (issue #167). */
export const STACKED_BASE_LABEL = 'stacked-base';

const CUSR_TASK_BRANCH =
  /^cusr\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-|$)/;

/**
 * A base branch that is the head of an open PR stacks this task's PR on unmerged work: the PR can only
 * merge after that one, and becomes an orphan if that PR's task was cancelled. Only the owner decides
 * that (AGENTS.md), so preflight stops the task until they opt in with a label on a task they add
 * themselves, or change the base.
 */
async function checkStackedBase(
  port: GitHubPort,
  slug: string,
  task: CanonicalTask,
  repo: RepoIdentity,
): Promise<PreflightProblem | null> {
  if (repo.default_branch === null || task.base_branch === repo.default_branch) return null;
  // The assistant cannot opt in for the owner: only a person's own task request counts.
  if (task.labels.includes(STACKED_BASE_LABEL) && task.requested_by.kind === 'human') return null;
  const owner = slug.split('/')[0] as string;
  const r = await port.request({
    method: 'GET',
    path: `repos/${slug}/pulls`,
    query: { state: 'open', head: `${owner}:${task.base_branch}`, per_page: '10', page: '1' },
    body: null,
  });
  if (!r.ok) {
    if (r.error.reason === 'unknown') throw new Infra('stacked_base', r.error.detail);
    return problem(
      'capability_missing',
      'stacked_base',
      `open PRs of ${slug} cannot be read: ${r.error.detail}`,
    );
  }
  if (!Array.isArray(r.value.body)) throw new Infra('stacked_base', 'unexpected pulls shape');
  const open = r.value.body.flatMap((p: unknown) => {
    const pr = p as { number?: unknown; base?: { ref?: unknown } } | null;
    return typeof pr?.number === 'number' ? [pr] : [];
  });
  const first = open[0];
  if (first === undefined) return null;
  const into = typeof first.base?.ref === 'string' ? first.base.ref : repo.default_branch;
  const owning = CUSR_TASK_BRANCH.exec(task.base_branch)?.[1];
  const owner_note =
    owning === undefined ? '' : ` It is the branch of task ${owning} (cusr task show ${owning}).`;
  return problem(
    'config_invalid',
    'stacked_base',
    `base branch '${task.base_branch}' is the head of open PR ${slug}#${String(first.number)}, which is not merged; this task's PR would stack on it.${owner_note}`,
    {
      fix: `merge ${slug}#${String(first.number)} first, or continue that PR with \`cusr task add --pr ${slug}#${String(first.number)}\` and base '${into}', or add the task again with base '${into}'; to stack on it on purpose, add the task again from a --file whose labels include '${STACKED_BASE_LABEL}'`,
    },
  );
}

export type LocalBaseError = {
  /** `invalid`: the file is there and cannot be used. `unavailable`: the base could not be read. */
  readonly kind: 'invalid' | 'unavailable';
  readonly detail: string;
};

/**
 * A config file at the base as this machine knows it, for a read that must stay quick: unlike preflight it
 * does not fetch, so it may lag the remote. Start fetches and checks `cusr.yaml` again.
 */
export async function readLocalBaseConfig(
  port: GitPort,
  path: string,
  baseBranch: string,
  file: string = PROJECT_CONFIG_FILE,
): Promise<
  Result<{ readonly base_sha: string; readonly config: ConfigSource | null }, LocalBaseError>
> {
  try {
    const sha = await git(
      port,
      path,
      ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${baseBranch}^{commit}`],
      'base',
    );
    if (sha.code !== 0)
      return err({
        kind: 'unavailable',
        detail: `origin/${baseBranch} is not available in ${path}`,
      });
    const base_sha = sha.stdout.trim();
    const config = await readBaseFile(port, path, base_sha, file);
    return config.ok
      ? ok({ base_sha, config: config.value })
      : err({ kind: 'invalid', detail: config.error.message });
  } catch (e) {
    if (e instanceof Infra) return err({ kind: 'unavailable', detail: e.detail });
    if (e instanceof GitRefused)
      return err({ kind: 'unavailable', detail: `git refused: ${e.reason}` });
    throw e;
  }
}

// ---- What daemon 002 can run (the software_dev@1 graph, external confirmation) ----

/** Pure: checks the validated config as is; it never drops a role or rebinds to pass (FR-002.05). */
export function checkSupport(
  validated: Validated,
  task: CanonicalTask,
  manifests: Readonly<Record<string, CapabilityManifest | null>>,
  mode: ExecutionMode | null = null,
): {
  problems: PreflightProblem[];
  capability_refs: Record<string, Hash>;
  harness_roles: Record<string, Role[]>;
} {
  const { config } = validated;
  const problems: PreflightProblem[] = [];
  const capability_refs: Record<string, Hash> = {};
  const harness_roles: Record<string, Role[]> = {};
  const cap = (check: string, message: string): void =>
    void problems.push(problem('capability_missing', check, message));

  if (config.project === null || config.project.required_checks.length === 0) {
    problems.push(
      problem(
        'config_invalid',
        'required_checks',
        'cusr.yaml must declare a non-empty ci.required_checks',
        {
          fix: 'add ci.required_checks to cusr.yaml on the base branch',
        },
      ),
    );
  }

  const profileName = task.profile ?? config.project?.profile ?? null;
  const profile = profileName === null ? undefined : config.profiles[profileName];
  const workflowName = profile?.workflow ?? null;
  const workflow = workflowName === null ? undefined : config.user.workflows[workflowName];
  if (profile === undefined || workflow === undefined) {
    problems.push(
      problem(
        'config_invalid',
        'profile',
        profileName === null
          ? 'neither the task nor the project selects a profile'
          : `profile '${profileName}' or its workflow does not exist`,
      ),
    );
    return { problems, capability_refs, harness_roles };
  }
  if (mode !== null && validated.runtime?.modes[mode] === undefined) {
    problems.push(
      problem('config_invalid', 'mode', `mode '${mode}' is not allowed by runtime.modes`, {
        fix: `add runtime.modes.${mode} or propose another mode`,
      }),
    );
  }
  // The graph of the mode; before a mode is chosen only what both modes need (no reviewer) is checked.
  const graph = modeGraph(workflow, mode ?? 'direct-pr');

  const facts = bindingFacts(task);
  const roles = new Set<Role>();
  for (const [name, step] of Object.entries(graph.steps).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (!activeAgentStep(step, facts)) continue;
    const role = step.role ?? '';
    if (!(ROLES as readonly string[]).includes(role)) {
      cap('role', `step '${name}' needs role '${role}', which cusrd does not run`);
      continue;
    }
    roles.add(role as Role);
    if (profile.allow_roles !== null && !profile.allow_roles.includes(role))
      cap(
        'role',
        `profile '${profileName ?? ''}' does not allow role '${role}' used by step '${name}'`,
      );
  }

  for (const role of [...roles].sort()) {
    for (const h of roleHarnesses(validated, role, profile.allow_models))
      harness_roles[h] = [...(harness_roles[h] ?? []), role];
  }
  for (const [h, hRoles] of Object.entries(harness_roles).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const before = problems.length;
    const m = manifests[h] ?? null;
    if (m === null) {
      cap('harness', `harness '${h}' has no capability manifest; run doctor`);
      continue;
    }
    for (const message of manifestShortfalls(
      h,
      m,
      hRoles,
      validated.runtime?.harness_isolation[h] === 'allow_external_verified',
    ))
      cap('harness', message);
    if (problems.length === before) capability_refs[h] = m.manifest_hash;
  }
  return { problems, capability_refs, harness_roles };
}

/** Agent/review steps that run for this task; a `when` that does not match leaves the step out. */
function activeAgentStep(step: StepDef, facts: ReturnType<typeof bindingFacts>): boolean {
  if (step.kind !== 'agent' && step.kind !== 'review') return false;
  return step.when === undefined || evalPredicate(step.when, facts);
}

/** Every harness a role can reach through its binding rules or ladder, within the profile's models. */
function roleHarnesses(
  validated: Validated,
  role: Role,
  allowModels: readonly string[] | null,
): string[] {
  const { user } = validated.config;
  const r = user.roles[role];
  if (r === undefined) return [];
  const models = [
    ...r.binding.map((b) => b.model),
    ...r.ladder.flatMap((s) => (s.model === undefined ? [] : [s.model])),
  ];
  const out = new Set<string>();
  for (const m of models) {
    if (allowModels !== null && !allowModels.includes(m)) continue;
    const info = user.models[m];
    if (info !== undefined) out.add(info.harness);
  }
  return [...out].sort();
}
