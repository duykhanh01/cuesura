/** Host launch planning, pinned layout shapes and post-run write checks (ADR-0005). */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import type {
  SandboxLaunchPlan,
  SandboxLayout,
  SandboxPlanError,
  SandboxProvider,
  SandboxRole,
} from '../adapters/ports.ts';
import type { Hash } from '../shared/brand.ts';
import { hashCanonical, hashText } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';

/** Fallback PATH when the host environment has none. */
export const SANDBOX_SYSTEM_PATH: readonly string[] = ['/usr/local/bin', '/usr/bin', '/bin'];

/** Paths in archived T007 plans; retained for fixture replay and historical record readers. */
export const IN_SANDBOX = {
  home: '/cusr/home',
  scratch: '/cusr/scratch',
  context: '/cusr/context',
  schema: '/cusr/schema',
} as const;

const AGENT_ROLES: ReadonlySet<SandboxRole> = new Set(['coder', 'fixer', 'reviewer']);
const READ_ONLY_REPO_ROLES: ReadonlySet<SandboxRole> = new Set(['reviewer']);

export class SandboxPolicyError extends Error {
  override name = 'SandboxPolicyError';
  readonly code: SandboxPlanError['code'];

  constructor(code: SandboxPlanError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** cusr's control credentials: a worker never calls cusr, so a pin cannot pass them. */
const CUSR_CONTROL_ENV = /^CUSR_(ADMIN|OPERATE|TOKEN)/;
/**
 * Daemon variables a worker does not inherit: cusr's own, and what an enclosing agent session sets
 * (the daemon may run under one in development); a harness started by hand never sees these.
 */
const NOT_INHERITED_ENV = /^(CUSR_|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|CODEX_SANDBOX)/;

/** One path equals or contains the other. */
export function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** A pin may set any variable a shell could, secrets included; only cusr's own stay out. */
function checkEnv(env: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key))
      throw new SandboxPolicyError('policy_violation', `env ${key}: invalid name`);
    if (CUSR_CONTROL_ENV.test(key))
      throw new SandboxPolicyError('policy_violation', `env ${key}: cusr control credential`);
  }
}

export function probeLayoutShapes(
  provider: SandboxProvider,
  o: {
    readonly roles: readonly SandboxRole[];
    readonly toolchain: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  },
): Result<Record<string, Hash>, SandboxPlanError> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-layout-probe-')));
  try {
    const dir = (name: string): string => {
      const p = join(base, name);
      mkdirSync(p);
      return p;
    };
    const worktree = dir('worktree');
    const common = dir('common');
    const admin = dir('admin');
    writeFileSync(join(worktree, '.git'), `gitdir: ${admin}\n`);
    const shapes: Record<string, Hash> = {};
    for (const role of o.roles) {
      const plan = provider.plan(
        {
          role,
          worktree,
          git_dirs: [common, admin],
          scratch: dir(`scratch-${role}`),
          private_home: AGENT_ROLES.has(role) ? dir(`home-${role}`) : null,
          context: dir(`context-${role}`),
          schema: dir(`schema-${role}`),
          toolchain: o.toolchain,
          env: o.env,
          network: 'internet_outbound',
        },
        ['/bin/true'],
      );
      if (!plan.ok) return plan;
      shapes[role] = plan.value.layout_shape;
    }
    return ok(shapes);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// ---- write zone (T072): runtime canary of what a role may not change ----

/** Metadata entries of a git dir that decide behaviour (config, refs, hooks); objects are append-only. */
const GIT_METADATA = [
  'HEAD',
  'config',
  'config.worktree',
  'branches',
  'remotes',
  'packed-refs',
  'refs',
  'hooks',
  'info',
  'commondir',
  'gitdir',
];

export type WriteZoneSnapshot = {
  readonly role: SandboxRole;
  /** Fingerprints for the read-only boundary (the decider); null for a role that may write. */
  readonly worktree: string | null;
  readonly metadata: string | null;
};

/**
 * `state` entries count as absent while empty. Their parents' own size and time are left out too, since making one
 * moves them; a parent's other entries are all recorded separately.
 */
function fingerprint(
  paths: readonly string[],
  state: ReadonlySet<string> = new Set(),
  parents: ReadonlySet<string> = new Set(),
): string {
  const entries: [string, number, number, string][] = [];
  const walk = (p: string, depth: number): void => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      entries.push([p, -1, 0, 'missing']);
      return;
    }
    const type = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file';
    if (
      state.has(p) &&
      ((type === 'dir' && readdirSync(p).length === 0) || (type === 'file' && st.size === 0))
    ) {
      if (depth === 0) entries.push([p, -1, 0, 'missing']);
      return;
    }
    if (!(type === 'dir' && parents.has(p))) entries.push([p, st.size, st.mtimeMs, type]);
    if (type === 'dir' && depth < 8)
      for (const n of readdirSync(p).sort()) walk(join(p, n), depth + 1);
  };
  for (const p of paths) walk(p, 0);
  return hashCanonical(entries);
}

/** Snapshot before and after a read-only run; any change in its zone is a boundary violation. */
export function snapshotWriteZone(
  layout: Pick<SandboxLayout, 'role' | 'worktree' | 'git_dirs'>,
  /** The adapter's `worktree_state`. */
  harnessState: readonly string[] = [],
  /** The adapter's `git_dir_state`. */
  gitDirState: readonly string[] = [],
): WriteZoneSnapshot {
  const meta = [
    join(layout.worktree, '.git'),
    ...layout.git_dirs.flatMap((g) => GIT_METADATA.map((n) => join(g, n))),
  ];
  const state = new Set<string>();
  const parents = new Set<string>();
  for (const g of layout.git_dirs)
    for (const rel of gitDirState) {
      const p = join(g, rel);
      state.add(p);
      for (let up = dirname(p); up !== g; up = dirname(up)) parents.add(up);
    }
  // A worker commits itself; the daemon's own Git refuses repo config that could run code.
  const readOnly = READ_ONLY_REPO_ROLES.has(layout.role);
  return {
    role: layout.role,
    worktree: readOnly ? fingerprintTree(layout.worktree, harnessState) : null,
    metadata: readOnly ? fingerprint(meta, state, parents) : null,
  };
}

/**
 * `harnessState` directories count as absent while they are empty. Their parents' own size and time are left out
 * too, since making one moves them; a parent's other entries are all recorded separately.
 */
function fingerprintTree(dir: string, harnessState: readonly string[]): string {
  const state = new Set(harnessState.map((p) => join(dir, p)));
  const parents = new Set(
    [...state].flatMap((p) => {
      const out: string[] = [];
      for (let up = dirname(p); up !== dir; up = dirname(up)) out.push(up);
      return out;
    }),
  );
  const entries: [string, number, number][] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      if (n === '.git') continue;
      const p = join(d, n);
      const st = lstatSync(p);
      const isDir = st.isDirectory() && !st.isSymbolicLink();
      if (isDir && state.has(p) && readdirSync(p).length === 0) continue;
      if (!(isDir && parents.has(p))) entries.push([p, st.size, st.mtimeMs]);
      if (isDir) walk(p);
    }
  };
  walk(dir);
  return hashCanonical(entries);
}

export function writeZoneViolations(before: WriteZoneSnapshot, after: WriteZoneSnapshot): string[] {
  const out: string[] = [];
  if (before.worktree !== after.worktree) out.push(`${before.role} changed the read-only worktree`);
  if (before.metadata !== after.metadata) out.push(`${before.role} run changed git metadata`);
  return out;
}

/**
 * The TMPDIR of a run whose binary needs a short one. Named from the scratch dir, so a retry or a recovery of the
 * same run finds the same directory.
 */
export function shortTmpDir(scratch: string): string {
  return `/tmp/cusr-${hashText(scratch).slice('sha256:'.length, 'sha256:'.length + 16)}`;
}

/** /tmp is shared, so an existing entry counts only if it is this user's own private directory. */
export function ensurePrivateTmpDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
    throw new SandboxPolicyError(
      'policy_violation',
      `${dir} is not a private directory of this user`,
    );
}

/** Shared by execution and preflight so shell/systemd PATH differences affect tool discovery consistently. */
export function hostExecutionPath(toolchain: readonly string[]): string[] {
  return [...toolchain, ...(process.env['PATH'] ?? SANDBOX_SYSTEM_PATH.join(':')).split(':')];
}

/** Direct host launch; this planner provides no OS isolation. The coding harness owns its sandbox. */
export class HostExecutionProvider implements SandboxProvider {
  readonly provider = 'host' as const;

  plan(
    layout: SandboxLayout,
    command: readonly string[],
  ): Result<SandboxLaunchPlan, SandboxPlanError> {
    if (
      !isAbsolute(layout.worktree) ||
      !existsSync(layout.worktree) ||
      !statSync(layout.worktree).isDirectory()
    )
      return err({
        code: 'source_missing',
        message: 'worktree is not an absolute directory',
      });
    if (command.length === 0) return err({ code: 'policy_violation', message: 'empty command' });
    try {
      checkEnv(layout.env);
    } catch (e) {
      if (e instanceof SandboxPolicyError) return err({ code: e.code, message: e.message });
      throw e;
    }
    // A command runs like one the owner starts in a shell: the daemon's environment and the real
    // HOME (dotfiles, gh, git, ssh). Only the harness config dirs point into the private home, which
    // holds the attempt's login and sessions, as Orca does for its account homes.
    const inherited: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined && !NOT_INHERITED_ENV.test(key)) inherited[key] = value;
    const env = {
      ...inherited,
      ...layout.env,
      PATH: hostExecutionPath(layout.toolchain).join(':'),
      HOME: homedir(),
      ...(layout.private_home === null
        ? {}
        : {
            CLAUDE_CONFIG_DIR: join(layout.private_home, '.claude'),
            CODEX_HOME: join(layout.private_home, '.codex'),
          }),
      TMPDIR: layout.tmp_dir ?? layout.scratch,
    };
    const shape = {
      mode: 'native',
      provider: 'host',
      role: layout.role,
      toolchain: layout.toolchain,
      env: Object.keys(layout.env).sort(),
      home: layout.private_home === null ? 'host' : 'private',
    };
    return ok({
      isolation_mode: 'native',
      provider: 'host',
      role: layout.role,
      argv: [...command],
      cwd: layout.worktree,
      env,
      network: layout.network,
      mount_sources: [],
      proof_refs: [],
      layout_shape: hashCanonical(shape),
      layout_digest: hashCanonical({ shape, layout }),
    });
  }
}
