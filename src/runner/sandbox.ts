/**
 * The only {@link SandboxProvider}: Isolated rootless bubblewrap (ADR-0004, contracts/execution.md
 * "Sandbox và Git boundary"). Promoted from the S0.1-proven prototype `scripts/spike-002/sandbox.ts`.
 * Every harness, setup, gate and autofix command runs inside it; no backend is selected by
 * configuration and no AppArmor profile name gates it.
 *
 * Mount sources are checked (absolute, normalised, symlink-free, not forbidden) and their (dev, ino)
 * recorded at plan time. bwrap resolves paths again at exec, so the plan runs through
 * `sandbox-exec.py`, which reopens each source with O_PATH|O_NOFOLLOW, compares (dev, ino) and
 * realpath, and binds by inherited FD; any change fails closed with exit {@link LAUNCH_POLICY_EXIT}.
 *
 * Provider output is data only; the runner spawns it under its own supervisor, timeout and cgroup.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  MountSourceIdentity,
  SandboxLaunchPlan,
  SandboxLayout,
  SandboxPlanError,
  SandboxProvider,
  SandboxRole,
} from '../adapters/ports.ts';
import { OWNER_TOKEN_FILE } from '../application/access-tokens.ts';
import { CONTROL_SOCKET } from '../cli/output.ts';
import { hashCanonical } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';

export const BWRAP = '/usr/bin/bwrap';
export const PYTHON = '/usr/bin/python3';
export const LAUNCHER = fileURLToPath(
  new URL('./sandbox-exec.py', import.meta.url),
);
/** Exit code of the launcher when a mount source changed between plan and exec. */
export const LAUNCH_POLICY_EXIT = 125;

/** Outer-boundary evidence this provider relies on (S0.1, T006). */
export const PROOF_REFS: readonly string[] = [
  'test/fixtures/runtime/spike-0/host/manifest.json',
  'test/fixtures/runtime/spike-0/host/mount-toctou.json',
  'test/fixtures/runtime/spike-0/host/local-boundary.json',
];

/** Fixed in-sandbox locations; worktree and git dirs keep their host paths so gitdir links resolve. */
export const IN_SANDBOX = {
  home: '/cusr/home',
  scratch: '/cusr/scratch',
  context: '/cusr/context',
  schema: '/cusr/schema',
} as const;

const AGENT_ROLES: ReadonlySet<SandboxRole> = new Set([
  'coder',
  'fixer',
  'reviewer',
]);
const READ_ONLY_REPO_ROLES: ReadonlySet<SandboxRole> = new Set(['reviewer']);

export type HostPolicy = {
  readonly hostHome: string;
  /** Paths that no mount may equal, contain or sit inside (credentials, control sockets, DB). */
  readonly forbidden: readonly string[];
  readonly systemRo: readonly string[];
  readonly systemRoTry: readonly string[];
};

/** DATA_DIR entries no sandbox may see: store, control socket, owner token, locks and config. */
export const DATA_DIR_CONTROL_FILES: readonly string[] = [
  'cusr.db',
  'cusr.db-wal',
  'cusr.db-shm',
  CONTROL_SOCKET,
  OWNER_TOKEN_FILE,
  'cusrd.sock',
  'cusrd.lock',
  'config.yaml',
  'locks',
  'tokens',
];

/** Control files of this daemon's DATA_DIR are forbidden on top of the host credential locations. */
export function defaultHostPolicy(
  dataDir: string | null,
  extraForbidden: readonly string[] = [],
): HostPolicy {
  const home = homedir();
  const uid = userInfo().uid;
  const control =
    dataDir === null ? [] : DATA_DIR_CONTROL_FILES.map((n) => join(dataDir, n));
  return {
    hostHome: home,
    forbidden: [
      '/proc',
      '/sys',
      '/root',
      '/var/run/docker.sock',
      '/run/docker.sock',
      `/run/user/${uid}`,
      `${home}/.ssh`,
      `${home}/.gnupg`,
      `${home}/.config/gh`,
      `${home}/.docker`,
      `${home}/.aws`,
      `${home}/.claude`,
      `${home}/.claude.json`,
      `${home}/.codex`,
      // Default DATA_DIR control files; run directories below ~/.cusr/runs stay mountable.
      ...DATA_DIR_CONTROL_FILES.map((n) => `${home}/.cusr/${n}`),
      ...control,
      ...extraForbidden,
    ],
    systemRo: ['/usr'],
    systemRoTry: [
      '/etc/resolv.conf',
      '/etc/hosts',
      '/etc/nsswitch.conf',
      '/etc/ssl',
      '/etc/ca-certificates',
      '/etc/passwd',
      '/etc/group',
      '/etc/localtime',
    ],
  };
}

type Mount = {
  readonly kind: 'ro' | 'rw';
  readonly source: string;
  readonly target: string;
  readonly purpose: string;
  readonly optional?: boolean;
};

type SourceEntry = {
  readonly argv_index: number;
  readonly source: string;
  readonly identity: {
    readonly realpath: string;
    readonly dev: string;
    readonly ino: string;
  } | null;
};

/** Validated bwrap invocation before it is wrapped by the launcher. */
export type BwrapPlan = {
  readonly role: SandboxRole;
  readonly bwrap_args: readonly string[];
  readonly mounts: readonly Mount[];
  readonly sources: readonly SourceEntry[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly network: 'internet_outbound';
};

export class SandboxPolicyError extends Error {
  override name = 'SandboxPolicyError';
  readonly code: SandboxPlanError['code'];

  constructor(code: SandboxPlanError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const FORBIDDEN_ENV =
  /^(GH_|GITHUB_|SSH_AUTH_SOCK$|DBUS_|XDG_RUNTIME_DIR$|DOCKER_|CUSR_(ADMIN|OPERATE|TOKEN))/;
const SECRET_ENV =
  /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|CREDENTIAL|PRIVATE_KEY|AUTH)/i;

function within(child: string, parent: string): boolean {
  return (
    child === parent ||
    child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
  );
}

/** Absolute, normalised, symlink-free; callers pass real paths so mounts cannot be redirected. */
function checkSource(path: string, what: string): string {
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    path.split(sep).includes('..')
  ) {
    throw new SandboxPolicyError(
      'policy_violation',
      `${what}: ${path} must be an absolute normalised path`,
    );
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new SandboxPolicyError(
      'source_missing',
      `${what}: ${path} does not exist`,
    );
  }
  if (real !== path)
    throw new SandboxPolicyError(
      'source_symlink',
      `${what}: ${path} resolves through a symlink to ${real}`,
    );
  return path;
}

function checkNotForbidden(
  path: string,
  what: string,
  policy: HostPolicy,
): void {
  if (
    path === '/' ||
    within(policy.hostHome, path) ||
    path === dirname(policy.hostHome)
  ) {
    throw new SandboxPolicyError(
      'policy_violation',
      `${what}: ${path} would expose the host home`,
    );
  }
  for (const f of policy.forbidden) {
    if (within(path, f) || within(f, path))
      throw new SandboxPolicyError(
        'policy_violation',
        `${what}: ${path} overlaps forbidden ${f}`,
      );
  }
}

/** Model auth lives only in the private home; orchestration/control secrets never enter. */
function checkEnv(env: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key))
      throw new SandboxPolicyError(
        'policy_violation',
        `env ${key}: invalid name`,
      );
    if (FORBIDDEN_ENV.test(key))
      throw new SandboxPolicyError(
        'policy_violation',
        `env ${key}: orchestration/control secret is never passed`,
      );
    if (SECRET_ENV.test(key))
      throw new SandboxPolicyError(
        'policy_violation',
        `env ${key}: secret-like variable rejected`,
      );
  }
}

/** Pure validation of a layout against the host policy; throws {@link SandboxPolicyError}. */
export function buildBwrap(
  layout: SandboxLayout,
  policy: HostPolicy,
): BwrapPlan {
  const role = layout.role;
  const agent = AGENT_ROLES.has(role);
  const mounts: Mount[] = [];

  for (const p of policy.systemRo)
    mounts.push({ kind: 'ro', source: p, target: p, purpose: 'system' });
  for (const p of policy.systemRoTry)
    mounts.push({
      kind: 'ro',
      source: p,
      target: p,
      purpose: 'system',
      optional: true,
    });

  for (const t of layout.toolchain) {
    checkNotForbidden(checkSource(t, 'toolchain'), 'toolchain', policy);
    mounts.push({ kind: 'ro', source: t, target: t, purpose: 'toolchain' });
  }

  const worktree = checkSource(layout.worktree, 'worktree');
  checkNotForbidden(worktree, 'worktree', policy);
  mounts.push({
    kind: READ_ONLY_REPO_ROLES.has(role) ? 'ro' : 'rw',
    source: worktree,
    target: worktree,
    purpose: 'worktree',
  });
  // `.git` (file for linked worktrees, dir for a main checkout) is metadata: overlay it read-only.
  const dotGit = join(worktree, '.git');
  if (existsSync(dotGit)) {
    checkNotForbidden(
      checkSource(dotGit, 'worktree .git'),
      'worktree .git',
      policy,
    );
    mounts.push({
      kind: 'ro',
      source: dotGit,
      target: dotGit,
      purpose: 'git-metadata',
    });
  }
  for (const g of layout.git_dirs) {
    checkNotForbidden(checkSource(g, 'git_dir'), 'git_dir', policy);
    mounts.push({ kind: 'ro', source: g, target: g, purpose: 'git-metadata' });
  }

  const scratch = checkSource(layout.scratch, 'scratch');
  checkNotForbidden(scratch, 'scratch', policy);
  if (within(scratch, worktree) || within(worktree, scratch))
    throw new SandboxPolicyError(
      'policy_violation',
      'scratch must not overlap the worktree',
    );
  mounts.push({
    kind: 'rw',
    source: scratch,
    target: IN_SANDBOX.scratch,
    purpose: 'scratch',
  });

  if (agent) {
    if (layout.private_home === null)
      throw new SandboxPolicyError(
        'policy_violation',
        `${role} requires a private home`,
      );
    const home = checkSource(layout.private_home, 'private_home');
    checkNotForbidden(home, 'private_home', policy);
    mounts.push({
      kind: 'rw',
      source: home,
      target: IN_SANDBOX.home,
      purpose: 'private-home',
    });
  } else if (layout.private_home !== null) {
    throw new SandboxPolicyError(
      'policy_violation',
      `${role} must not receive a harness home (no model auth for setup/gate/autofix)`,
    );
  }

  for (const [key, target] of [
    ['context', IN_SANDBOX.context],
    ['schema', IN_SANDBOX.schema],
  ] as const) {
    const src = layout[key];
    if (src === null) continue;
    checkNotForbidden(checkSource(src, key), key, policy);
    mounts.push({ kind: 'ro', source: src, target, purpose: key });
  }

  // Only the worktree's in-place metadata overlay may overlap a writable mount. Any alias of that
  // worktree (including the private home) would bypass the .git overlay at its host path.
  for (const rw of mounts.filter((m) => m.kind === 'rw')) {
    for (const other of mounts) {
      if (
        rw === other ||
        (!within(rw.source, other.source) && !within(other.source, rw.source))
      )
        continue;
      if (
        rw.purpose === 'worktree' &&
        other.purpose === 'git-metadata' &&
        within(other.source, rw.source) &&
        other.target === other.source
      )
        continue;
      throw new SandboxPolicyError(
        'policy_violation',
        `${rw.purpose} overlaps ${other.purpose}: ${rw.source} / ${other.source}`,
      );
    }
  }

  checkEnv(layout.env);
  const env: Record<string, string> = {
    PATH: [...layout.toolchain, '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: IN_SANDBOX.home,
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    ...layout.env,
  };

  const args: string[] = [
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
    '--symlink',
    'usr/bin',
    '/bin',
    '--symlink',
    'usr/sbin',
    '/sbin',
    '--symlink',
    'usr/lib',
    '/lib',
    '--symlink',
    'usr/lib64',
    '/lib64',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
  ];
  if (!agent) args.push('--tmpfs', IN_SANDBOX.home);
  const sources: SourceEntry[] = [];
  for (const m of mounts) {
    let identity: SourceEntry['identity'];
    try {
      const realpath = realpathSync(m.source);
      const st = statSync(m.source, { bigint: true });
      identity = { realpath, dev: String(st.dev), ino: String(st.ino) };
      if (m.purpose !== 'system' && realpath !== m.source)
        throw new SandboxPolicyError(
          'source_symlink',
          `${m.purpose}: source changed during planning`,
        );
    } catch (e) {
      if (m.optional !== true || (e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw e;
      identity = null;
    }
    sources.push({ argv_index: args.length, source: m.source, identity });
    const flag = m.kind === 'rw' ? '--bind' : '--ro-bind';
    args.push(m.optional === true ? `${flag}-try` : flag, m.source, m.target);
  }
  args.push('--clearenv');
  for (const [k, v] of Object.entries(env).sort(([a], [b]) => (a < b ? -1 : 1)))
    args.push('--setenv', k, v);
  args.push('--chdir', worktree);
  return {
    role,
    bwrap_args: args,
    mounts,
    sources,
    env,
    cwd: worktree,
    network: layout.network,
  };
}

export type BwrapProviderOptions = {
  readonly policy: HostPolicy;
  readonly bwrap?: string;
  readonly python?: string;
  readonly proofRefs?: readonly string[];
};

function fileDigest(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

export class BwrapSandboxProvider implements SandboxProvider {
  readonly provider = 'bwrap' as const;
  readonly #policy: HostPolicy;
  readonly #bwrap: string;
  readonly #python: string;
  readonly #proofRefs: readonly string[];
  readonly #launcherDigest: string;

  constructor(opts: BwrapProviderOptions) {
    this.#policy = opts.policy;
    this.#bwrap = opts.bwrap ?? BWRAP;
    this.#python = opts.python ?? PYTHON;
    this.#proofRefs = opts.proofRefs ?? PROOF_REFS;
    this.#launcherDigest = fileDigest(LAUNCHER);
  }

  plan(
    layout: SandboxLayout,
    command: readonly string[],
  ): Result<SandboxLaunchPlan, SandboxPlanError> {
    if (command.length === 0)
      return err({ code: 'policy_violation', message: 'empty command' });
    if (this.#proofRefs.length === 0)
      return err({
        code: 'proof_missing',
        message: 'no outer-boundary proof reference',
      });
    let plan: BwrapPlan;
    try {
      plan = buildBwrap(layout, this.#policy);
    } catch (e) {
      if (e instanceof SandboxPolicyError)
        return err({ code: e.code, message: e.message });
      throw e;
    }
    const mountSources: MountSourceIdentity[] = plan.sources.flatMap((s) =>
      s.identity === null ? [] : [{ source: s.source, ...s.identity }],
    );
    const payload = {
      bwrap: this.#bwrap,
      argv: plan.bwrap_args,
      sources: plan.sources,
    };
    return ok({
      isolation_mode: 'isolated',
      provider: 'bwrap',
      role: plan.role,
      argv: [this.#python, '-I', LAUNCHER, JSON.stringify(payload), ...command],
      cwd: plan.cwd,
      env: plan.env,
      network: plan.network,
      mount_sources: mountSources,
      layout_digest: hashCanonical({
        bwrap_args: plan.bwrap_args,
        sources: plan.sources,
        network: plan.network,
        launcher: this.#launcherDigest,
      }),
      proof_refs: [...this.#proofRefs],
    });
  }
}
