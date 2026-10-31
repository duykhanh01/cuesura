/**
 * Preflight of a task before its snapshot is frozen (FR-002, T030). Reads the latest base revision and
 * the project config from Git objects, checks the project location, remote identity, host prerequisites
 * of the Isolated runtime and what daemon 002 can run. It only reports: it never changes the host, the
 * config or the task's bindings, and its result is a candidate; the single snapshot is frozen at start.
 */
import type {
  GitHubPort,
  GitPort,
  GitResult,
  HostProbePort,
} from '../adapters/ports.ts';
import {
  ROLE_SCHEMA_DIGESTS,
  ROLES,
  type Role,
} from '../adapters/harness/result-schema.ts';
import { findDaemonUnsupported } from '../config/capabilities.ts';
import type { RuntimeConfig } from '../config/normalize.ts';
import { validateConfig, type Validated } from '../config/validate.ts';
import type { ConfigSource } from '../config/yaml-loader.ts';
import type { Diagnostic } from '../domain/config.ts';
import type { CapabilityManifest } from '../domain/runtime.ts';
import type { ExecutionMode } from '../domain/run-config.ts';
import type { CanonicalTask } from '../domain/task.ts';
import { evalPredicate, type StepDef } from '../domain/workflow.ts';
import { modeGraph } from '../engine/workflows/software-dev.ts';
import { bindingFacts } from '../policy/binding.ts';
import {
  isSupportedStructure,
  unsupportedDecisionPoints,
} from '../policy/support.ts';
import type { Hash } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';

const RUNBOOK_CAUSES =
  'deploy/README.md § Chuẩn bị theo hệ và cách sửa khi preflight báo `capability_missing`';
const RUNBOOK_SYSTEMD = 'deploy/README.md § systemd và WSL2';
const PROBE_TIMEOUT_MS = 5_000;
const GIT_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_BYTES = 64 * 1024;
const PROJECT_CONFIG_BYTES = 1024 * 1024;
const PROJECT_CONFIG_FILE = 'cusr.yaml';

export const HOST_CAUSES = [
  'bwrap_missing',
  'userns_apparmor_restricted',
  'userns_disabled',
  'systemd_user_unavailable',
  /** bwrap failed for a reason none of the known signatures explains; fail closed with its stderr. */
  'bwrap_probe_failed',
] as const;
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
      problem(
        'config_invalid',
        'runtime',
        'the `runtime:` section is required by cusrd',
        { fix: 'add `runtime:` to the user config' },
      ),
    );
  if (location === undefined) {
    problems.push(
      problem(
        'config_invalid',
        'project',
        `project '${task.project}' is not in the allowlist`,
        { fix: `add projects.${task.project} to the user config` },
      ),
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

  const repo = await checkProjectRepo(
    ports,
    location.path,
    location.repo,
    task.base_branch,
  );
  if (!repo.ok) return err(failed(repo.error));

  const config = await readProjectConfig(
    ports.git,
    location.path,
    repo.value.base_sha,
  );
  if (!config.ok) return err(failed([config.error]));
  const validated = validateConfig({
    user: input.user,
    ...(config.value === null ? {} : { project: config.value }),
    packs: input.packs,
  });
  if (!validated.ok)
    return err(
      failed([
        problem(
          'config_invalid',
          'project_config',
          `config at base ${repo.value.base_sha} is invalid`,
          { diagnostics: validated.error },
        ),
      ]),
    );

  const support = checkSupport(
    validated.value,
    task,
    input.manifests,
    input.mode ?? null,
  );
  const remote = await readRepoIdentity(ports.github, location.repo);
  if (!remote.ok) support.problems.push(remote.error);
  if (support.problems.length > 0 || !remote.ok)
    return err(failed(support.problems));

  return ok({
    base_sha: repo.value.base_sha,
    validated: validated.value,
    runtime: validated.value.runtime as RuntimeConfig,
    project_path: location.path,
    common_git_dir: repo.value.common_git_dir,
    target: {
      repo: location.repo,
      immutable_repo_id: remote.value,
      base_ref: task.base_branch,
    },
    capability_refs: support.capability_refs,
  });
}

// ---- Host prerequisites of the Isolated runtime (deploy/README.md) ----

const SYSCTL = {
  maxUserNamespaces: '/proc/sys/user/max_user_namespaces',
  unprivilegedClone: '/proc/sys/kernel/unprivileged_userns_clone',
  apparmorRestrict: '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
} as const;

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
  return configured === undefined
    ? host.findExecutable(name)
    : host.realpath(configured);
}

/** Probes only; never runs sudo, changes a sysctl, loads a profile or falls back to unsandboxed. */
export async function checkHost(
  host: HostProbePort,
  runtime: RuntimeConfig | null,
): Promise<PreflightProblem[]> {
  const paths = runtime?.tool_paths ?? {};
  const out: PreflightProblem[] = [];
  const knob = async (path: string): Promise<string | null> =>
    (await host.readText(path))?.trim() ?? null;

  const bwrap = await tool(host, paths.bwrap, 'bwrap');
  const disabled =
    (await knob(SYSCTL.maxUserNamespaces)) === '0' ||
    (await knob(SYSCTL.unprivilegedClone)) === '0';
  if (bwrap === null) {
    out.push(
      hostProblem(
        'bwrap_missing',
        'bwrap was not found',
        'sudo apt install bubblewrap (or the distro `bubblewrap` package)',
      ),
    );
  }
  if (disabled) {
    out.push(
      hostProblem(
        'userns_disabled',
        `unprivileged user namespaces are disabled (${SYSCTL.maxUserNamespaces} = 0 or ${SYSCTL.unprivilegedClone} = 0)`,
        'an administrator reviews the host hardening policy before re-enabling user namespaces',
      ),
    );
  }
  if (bwrap !== null && !disabled) {
    const trueBin = (await host.findExecutable('true')) ?? '/usr/bin/true';
    const r = await host.exec(
      [bwrap, '--unshare-user', '--ro-bind', '/', '/', trueBin],
      { timeout_ms: PROBE_TIMEOUT_MS },
    );
    if (r.kind !== 'exited' || r.code !== 0) {
      const stderr =
        r.kind === 'exited' ? r.stderr.trim().slice(0, 512) : r.kind;
      if (
        (await knob(SYSCTL.apparmorRestrict)) === '1' &&
        /uid map/i.test(stderr)
      ) {
        out.push(
          hostProblem(
            'userns_apparmor_restricted',
            `bwrap cannot create a user namespace: ${stderr} (kernel.apparmor_restrict_unprivileged_userns = 1)`,
            'load the userns profile for bwrap described in the runbook',
          ),
        );
      } else {
        out.push(
          hostProblem(
            'bwrap_probe_failed',
            `bwrap --unshare-user failed: ${stderr}`,
            'run the runbook checks and review the host policy',
          ),
        );
      }
    }
  }

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
  if (r.kind === 'timeout')
    throw new Infra(check, `git ${args[0] ?? ''} timed out`);
  if (r.kind === 'spawn_failed')
    throw new Infra(check, `git could not be started: ${r.message}`);
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

async function checkProjectRepo(
  ports: PreflightPorts,
  path: string,
  slug: string,
  baseBranch: string,
): Promise<
  Result<{ base_sha: string; common_git_dir: string }, PreflightProblem[]>
> {
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
    [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-common-dir',
    ],
    'project_path',
  );
  const [toplevel, commonDir] = top.stdout.split('\n');
  if (top.code !== 0 || toplevel === undefined || commonDir === undefined) {
    return err([
      problem(
        'config_invalid',
        'project_path',
        `project path ${path} is not a Git repository`,
      ),
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
      problem(
        'config_invalid',
        'project_path',
        `Git common dir ${commonDir} does not exist`,
      ),
    ]);

  const remote = await git(
    ports.git,
    path,
    ['config', '--get', 'remote.origin.url'],
    'remote',
  );
  const remoteSlug =
    remote.code === 0 ? githubSlugFromRemote(remote.stdout) : null;
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
      problem(
        'config_invalid',
        'base',
        `base branch '${baseBranch}' is not a valid branch name`,
      ),
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
        problem(
          'config_invalid',
          'base',
          `base branch '${baseBranch}' does not exist on origin`,
        ),
      ]);
    throw new Infra(
      'base',
      `git fetch failed: ${fetch.stderr.trim().slice(0, 512)}`,
    );
  }
  const sha = await git(
    ports.git,
    path,
    ['rev-parse', '--verify', '--quiet', `${tracking}^{commit}`],
    'base',
  );
  if (sha.code !== 0)
    throw new Infra('base', `fetched ${tracking} does not resolve to a commit`);
  return ok({ base_sha: sha.stdout.trim(), common_git_dir: common });
}

/** `cusr.yaml` of the base commit, never the working tree; null when the commit has none. */
async function readProjectConfig(
  port: GitPort,
  path: string,
  sha: string,
): Promise<Result<ConfigSource | null, PreflightProblem>> {
  const entry = await git(
    port,
    path,
    ['ls-tree', sha, '--', PROJECT_CONFIG_FILE],
    'project_config',
  );
  if (entry.code !== 0)
    throw new Infra(
      'project_config',
      `git ls-tree failed: ${entry.stderr.trim().slice(0, 512)}`,
    );
  const line = entry.stdout.trim();
  if (line === '') return ok(null);
  const mode = line.split(' ')[0];
  if (mode !== '100644' && mode !== '100755') {
    return err(
      problem(
        'config_invalid',
        'project_config',
        `${PROJECT_CONFIG_FILE} at ${sha} is not a regular file (mode ${mode ?? '?'})`,
      ),
    );
  }
  const blob = await git(
    port,
    path,
    ['cat-file', 'blob', `${sha}:${PROJECT_CONFIG_FILE}`],
    'project_config',
    { max_output_bytes: PROJECT_CONFIG_BYTES },
  );
  if (blob.code !== 0)
    throw new Infra(
      'project_config',
      `git cat-file failed: ${blob.stderr.trim().slice(0, 512)}`,
    );
  if (blob.truncated)
    return err(
      problem(
        'config_invalid',
        'project_config',
        `${PROJECT_CONFIG_FILE} at ${sha} is larger than ${PROJECT_CONFIG_BYTES} bytes`,
      ),
    );
  return ok({ file: `${PROJECT_CONFIG_FILE}@${sha}`, text: blob.stdout });
}

/** Immutable numeric repo ID; a renamed or transferred repo is a mismatch, not a silent follow. */
async function readRepoIdentity(
  port: GitHubPort,
  slug: string,
): Promise<Result<string, PreflightProblem>> {
  const r = await port.request({
    method: 'GET',
    path: `repos/${slug}`,
    query: {},
    body: null,
  });
  if (!r.ok) {
    if (r.error.reason === 'unknown')
      throw new Infra('github_repo', r.error.detail);
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
  const body = r.value.body as { id?: unknown; full_name?: unknown } | null;
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
  return ok(String(body.id));
}

// ---- What daemon 002 can run (software_dev@1, human decisions, external confirmation) ----

/** Pure: checks the validated config as is; it never drops a role or rebinds to pass (FR-002.05). */
export function checkSupport(
  validated: Validated,
  task: CanonicalTask,
  manifests: Readonly<Record<string, CapabilityManifest | null>>,
  mode: ExecutionMode | null = null,
): { problems: PreflightProblem[]; capability_refs: Record<string, Hash> } {
  const { config } = validated;
  const problems: PreflightProblem[] = [];
  const capability_refs: Record<string, Hash> = {};
  const cap = (check: string, message: string): void =>
    void problems.push(problem('capability_missing', check, message));

  if (
    findDaemonUnsupported(config.user, () => ({ file: '', line: 0, col: 0 }))
      .length > 0
  )
    cap(
      'completion_mode',
      'yolo is not supported by cusrd; completion is external confirmation only',
    );
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
  const profile =
    profileName === null ? undefined : config.profiles[profileName];
  const workflowName = profile?.workflow ?? null;
  const workflow =
    workflowName === null ? undefined : config.user.workflows[workflowName];
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
    return { problems, capability_refs };
  }
  if (!isSupportedStructure(workflow)) {
    cap('workflow', `workflow '${workflowName ?? ''}' is not software_dev@1`);
    return { problems, capability_refs };
  }
  const points = unsupportedDecisionPoints(workflow);
  if (points.length > 0)
    cap('decision_mode', `decision points must be human: ${points.join(', ')}`);
  if (mode !== null && validated.runtime?.modes[mode] === undefined) {
    problems.push(
      problem(
        'config_invalid',
        'mode',
        `mode '${mode}' is not allowed by runtime.modes`,
        { fix: `add runtime.modes.${mode} or propose another mode` },
      ),
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
      cap(
        'role',
        `step '${name}' needs role '${role}', which cusrd does not run`,
      );
      continue;
    }
    roles.add(role as Role);
    if (profile.allow_roles !== null && !profile.allow_roles.includes(role))
      cap(
        'role',
        `profile '${profileName ?? ''}' does not allow role '${role}' used by step '${name}'`,
      );
  }

  const costCap = (
    config.raw.profiles[profileName ?? '']?.budgets as
      { max_cost_usd?: unknown } | undefined
  )?.max_cost_usd;
  const harnesses = new Map<string, Role[]>();
  for (const role of [...roles].sort()) {
    for (const h of roleHarnesses(validated, role, profile.allow_models))
      harnesses.set(h, [...(harnesses.get(h) ?? []), role]);
  }
  for (const [h, hRoles] of [...harnesses].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const before = problems.length;
    const m = manifests[h] ?? null;
    if (m === null) {
      cap('harness', `harness '${h}' has no capability manifest; run doctor`);
      continue;
    }
    for (const role of hRoles) {
      if (m.role_schemas[role] !== ROLE_SCHEMA_DIGESTS[role])
        cap(
          'harness',
          `harness '${h}' manifest has no current ${role} result schema`,
        );
    }
    for (const k of [
      'structured_output',
      'permission_enforced',
      'private_home_auth',
    ] as const) {
      if (m.capabilities[k] === 'unsupported')
        cap('harness', `harness '${h}' does not support ${k}`);
    }
    if (
      validated.runtime?.harness_isolation[h] !== 'allow_external_verified' &&
      m.selected_inner_mode === 'external_verified'
    ) {
      cap(
        'harness',
        `harness '${h}' only runs with external_verified, but runtime.harness_isolation.${h} is internal_required`,
      );
    }
    if (costCap !== undefined && m.capabilities.cost_reporting !== 'reported') {
      cap(
        'budget',
        `profile '${profileName ?? ''}' caps cost but harness '${h}' cost reporting is ${m.capabilities.cost_reporting}`,
      );
    }
    if (problems.length === before) capability_refs[h] = m.manifest_hash;
  }
  return { problems, capability_refs };
}

/** Agent/review steps that run for this task; a `when` that does not match leaves the step out. */
function activeAgentStep(
  step: StepDef,
  facts: ReturnType<typeof bindingFacts>,
): boolean {
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
