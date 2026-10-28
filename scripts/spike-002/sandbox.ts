/**
 * Spike 0 outer sandbox prototype (T004, contracts/execution.md "Sandbox và Git boundary").
 *
 *   node scripts/spike-002/sandbox.ts argv  --layout FILE        print bwrap argv + mount table (no exec)
 *   node scripts/spike-002/sandbox.ts probe [--role R|--all] [--base DIR] [--apparmor-fixture]
 *
 * `probe` builds a throwaway git repo + linked worktree and runs filesystem/PID/secret/control
 * canaries inside bwrap. A passing probe on a host without the cusr-bwrap AppArmor stack is NOT
 * S0.1 evidence: it only shows the mount layout; capability denial must come from T006 on the
 * provisioned host. The probe never loads policy, uses sudo or touches sysctl.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { hashCanonical } from '../../src/shared/hash.ts';

export const SANDBOX_ROLES = ['coder', 'fixer', 'reviewer', 'setup', 'gate'] as const;
export type SandboxRole = (typeof SANDBOX_ROLES)[number];

/** Fixed in-sandbox locations; worktree and git dirs keep their host paths so gitdir links resolve. */
export const IN_SANDBOX = {
  home: '/cusr/home',
  scratch: '/cusr/scratch',
  context: '/cusr/context',
  schema: '/cusr/schema',
} as const;

export const SandboxLayoutSchema = z.strictObject({
  role: z.enum(SANDBOX_ROLES),
  worktree: z.string(),
  /** Git common dir and per-worktree admin dir; always read-only for every role. */
  git_dirs: z.array(z.string()),
  scratch: z.string(),
  /** Private harness home (agent roles only). setup/gate always get an empty tmpfs home. */
  private_home: z.string().nullable(),
  context: z.string().nullable(),
  schema: z.string().nullable(),
  /** Real (symlink-free) toolchain directories, each mounted read-only. */
  toolchain: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  /** Owner decision 2026-10-28; recorded, not a promise to block LAN/loopback. */
  network: z.literal('internet_outbound'),
});
export type SandboxLayout = z.infer<typeof SandboxLayoutSchema>;

export type HostPolicy = {
  readonly hostHome: string;
  /** Paths that no mount may equal, contain or sit inside (credentials, control sockets, DB). */
  readonly forbidden: readonly string[];
  readonly systemRo: readonly string[];
  readonly systemRoTry: readonly string[];
};

export function defaultHostPolicy(extraForbidden: readonly string[] = []): HostPolicy {
  const home = homedir();
  const uid = userInfo().uid;
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
      `${home}/.cusr/cusrd.lock`,
      `${home}/.cusr/cusr.db`,
      `${home}/.cusr/cusrd.sock`,
      `${home}/.cusr/config.yaml`,
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

export type Mount = {
  readonly kind: 'ro' | 'rw';
  readonly source: string;
  readonly target: string;
  readonly purpose: string;
  readonly optional?: boolean;
};

export type SandboxPlan = {
  readonly role: SandboxRole;
  readonly argv: readonly string[];
  readonly mounts: readonly Mount[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly network: 'internet_outbound';
  readonly layout_digest: string;
};

export class SandboxPolicyError extends Error {
  override name = 'SandboxPolicyError';
}

const AGENT_ROLES: ReadonlySet<SandboxRole> = new Set(['coder', 'fixer', 'reviewer']);
const FORBIDDEN_ENV = /^(GH_|GITHUB_|SSH_AUTH_SOCK$|DBUS_|XDG_RUNTIME_DIR$|DOCKER_|CUSR_(ADMIN|OPERATE|TOKEN))/;
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|CREDENTIAL|PRIVATE_KEY|AUTH)/i;

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Absolute, normalised, symlink-free; callers must pass real paths so mounts cannot be redirected. */
function checkSource(path: string, what: string): string {
  if (!isAbsolute(path) || normalize(path) !== path || path.split(sep).includes('..')) {
    throw new SandboxPolicyError(`${what}: ${path} must be an absolute normalised path`);
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new SandboxPolicyError(`${what}: ${path} does not exist`);
  }
  if (real !== path) throw new SandboxPolicyError(`${what}: ${path} resolves through a symlink to ${real}`);
  return path;
}

function checkNotForbidden(path: string, what: string, policy: HostPolicy): void {
  if (path === '/' || within(policy.hostHome, path) || path === dirname(policy.hostHome)) {
    throw new SandboxPolicyError(`${what}: ${path} would expose the host home`);
  }
  for (const f of policy.forbidden) {
    if (within(path, f) || within(f, path)) throw new SandboxPolicyError(`${what}: ${path} overlaps forbidden ${f}`);
  }
}

function checkEnv(role: SandboxRole, env: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new SandboxPolicyError(`env ${key}: invalid name`);
    if (FORBIDDEN_ENV.test(key)) throw new SandboxPolicyError(`env ${key}: orchestration/control secret is never passed`);
    if (SECRET_ENV.test(key)) {
      // Model auth lives in the private home; no role receives secrets via env in this prototype.
      throw new SandboxPolicyError(`env ${key}: secret-like variable rejected for ${role}`);
    }
  }
}

/** Pure: validates the layout against the host policy and returns the bwrap argv prefix. */
export function buildSandbox(input: SandboxLayout, policy: HostPolicy = defaultHostPolicy()): SandboxPlan {
  const layout = SandboxLayoutSchema.parse(input);
  const role = layout.role;
  const agent = AGENT_ROLES.has(role);
  const mounts: Mount[] = [];

  for (const p of policy.systemRo) mounts.push({ kind: 'ro', source: p, target: p, purpose: 'system' });
  for (const p of policy.systemRoTry) mounts.push({ kind: 'ro', source: p, target: p, purpose: 'system', optional: true });

  for (const t of layout.toolchain) {
    checkNotForbidden(checkSource(t, 'toolchain'), 'toolchain', policy);
    mounts.push({ kind: 'ro', source: t, target: t, purpose: 'toolchain' });
  }

  const worktree = checkSource(layout.worktree, 'worktree');
  checkNotForbidden(worktree, 'worktree', policy);
  mounts.push({ kind: role === 'reviewer' ? 'ro' : 'rw', source: worktree, target: worktree, purpose: 'worktree' });
  // `.git` (file for linked worktrees, dir for a main checkout) is metadata: overlay it read-only.
  const dotGit = join(worktree, '.git');
  if (existsSync(dotGit)) mounts.push({ kind: 'ro', source: dotGit, target: dotGit, purpose: 'git-metadata' });
  for (const g of layout.git_dirs) {
    checkNotForbidden(checkSource(g, 'git_dir'), 'git_dir', policy);
    mounts.push({ kind: 'ro', source: g, target: g, purpose: 'git-metadata' });
  }

  const scratch = checkSource(layout.scratch, 'scratch');
  checkNotForbidden(scratch, 'scratch', policy);
  if (within(scratch, worktree) || within(worktree, scratch)) throw new SandboxPolicyError('scratch must not overlap the worktree');
  mounts.push({ kind: 'rw', source: scratch, target: IN_SANDBOX.scratch, purpose: 'scratch' });

  if (agent) {
    if (layout.private_home === null) throw new SandboxPolicyError(`${role} requires a private home`);
    const home = checkSource(layout.private_home, 'private_home');
    checkNotForbidden(home, 'private_home', policy);
    mounts.push({ kind: 'rw', source: home, target: IN_SANDBOX.home, purpose: 'private-home' });
  } else if (layout.private_home !== null) {
    throw new SandboxPolicyError(`${role} must not receive a harness home (no model auth for setup/gate)`);
  }

  for (const [key, target] of [['context', IN_SANDBOX.context], ['schema', IN_SANDBOX.schema]] as const) {
    const src = layout[key];
    if (src === null) continue;
    checkNotForbidden(checkSource(src, key), key, policy);
    mounts.push({ kind: 'ro', source: src, target, purpose: key });
  }

  checkEnv(role, layout.env);
  const env: Record<string, string> = {
    PATH: [...layout.toolchain, '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: IN_SANDBOX.home,
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    ...layout.env,
  };

  const argv: string[] = [
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
  if (!agent) argv.push('--tmpfs', IN_SANDBOX.home);
  for (const m of mounts) {
    const flag = m.kind === 'rw' ? '--bind' : '--ro-bind';
    argv.push(m.optional === true ? `${flag}-try` : flag, m.source, m.target);
  }
  argv.push('--clearenv');
  for (const [k, v] of Object.entries(env).sort(([a], [b]) => (a < b ? -1 : 1))) argv.push('--setenv', k, v);
  argv.push('--chdir', worktree);

  return {
    role,
    argv,
    mounts,
    env,
    cwd: worktree,
    network: layout.network,
    layout_digest: hashCanonical({ argv, network: layout.network }),
  };
}

/** Full command line: `bwrap <sandbox argv> -- <command>`. */
export function sandboxCommand(plan: SandboxPlan, command: readonly string[], bwrap = '/usr/bin/bwrap'): string[] {
  return [bwrap, ...plan.argv, '--', ...command];
}

export function bwrapUsable(bwrap = '/usr/bin/bwrap'): { usable: boolean; detail: string } {
  if (!existsSync(bwrap)) return { usable: false, detail: `${bwrap} not found` };
  const r = spawnSync(bwrap, ['--unshare-user', '--ro-bind', '/', '/', '/usr/bin/true'], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0
    ? { usable: true, detail: 'bwrap --unshare-user ran /usr/bin/true' }
    : { usable: false, detail: `exit ${String(r.status)}: ${(r.stderr || r.error?.message || '').trim()}` };
}

// --- canary probe -----------------------------------------------------------------------------

export type ProbeExpect = 'allowed' | 'denied';
export type CanaryResult = {
  readonly name: string;
  readonly expect: ProbeExpect | 'record';
  readonly observed: string;
  readonly pass: boolean | null;
};

export type ProbeFixture = {
  readonly base: string;
  readonly repo: string;
  readonly worktree: string;
  readonly gitCommon: string;
  readonly gitAdmin: string;
  readonly scratch: string;
  readonly home: string;
  readonly context: string;
  readonly outside: string;
  readonly control: string;
};

function git(args: readonly string[], cwd: string): void {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

/** Throwaway repo + linked worktree + canary files under `base` (real path, not under host home). */
export function createProbeFixture(baseDir?: string): ProbeFixture {
  const base = realpathSync(baseDir ?? mkdtempSync(join(tmpdir(), 'cusr-spike-sandbox-')));
  const repo = join(base, 'repo');
  const worktree = join(base, 'worktree');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git(['add', 'README.md'], repo);
  git(['-c', 'user.name=cusr', '-c', 'user.email=cusr@invalid', 'commit', '-q', '-m', 'init'], repo);
  git(['worktree', 'add', '-q', '-b', 'cusr/probe', worktree], repo);
  const dirs = {
    scratch: join(base, 'scratch'),
    home: join(base, 'home'),
    context: join(base, 'context'),
    outside: join(base, 'outside'),
    control: join(base, 'control'),
  };
  for (const d of Object.values(dirs)) mkdirSync(d);
  writeFileSync(join(dirs.context, 'prompt.md'), 'prompt\n');
  writeFileSync(join(dirs.outside, 'canary'), 'outside-canary\n');
  writeFileSync(join(dirs.control, 'cusrd.sock'), 'control-canary\n');
  return {
    base,
    repo,
    worktree,
    gitCommon: join(repo, '.git'),
    gitAdmin: join(repo, '.git', 'worktrees', 'worktree'),
    ...dirs,
  };
}

export function probeLayout(role: SandboxRole, fx: ProbeFixture): SandboxLayout {
  return {
    role,
    worktree: fx.worktree,
    git_dirs: [fx.gitCommon],
    scratch: fx.scratch,
    private_home: AGENT_ROLES.has(role) ? fx.home : null,
    context: fx.context,
    schema: null,
    toolchain: [],
    env: { CUSR_ATTEMPT_ID: `probe-${role}` },
    network: 'internet_outbound',
  };
}

// Each check prints one token; the expected token is decided per role on the host side.
const CHECK = String.raw`
op="$1"; p="$2"
case "$op" in
  read) if cat "$p" >/dev/null 2>&1; then echo allowed; else echo denied; fi ;;
  exists) if [ -e "$p" ]; then echo allowed; else echo denied; fi ;;
  write) if (echo canary > "$p") 2>/dev/null; then echo allowed; else echo denied; fi ;;
  pids) n=0; for d in /proc/[0-9]*; do n=$((n+1)); done; echo "$n" ;;
  status) grep -E '^(CapEff|NoNewPrivs):' /proc/self/status | tr '\n' ' ' ;;
  label) (cat /proc/self/attr/current 2>/dev/null || echo unavailable) | tr -d '\000' ;;
  env) env | cut -d= -f1 | sort | tr '\n' ' ' ;;
esac`;

function runCheck(plan: SandboxPlan, op: string, path: string, bwrap: string): string {
  const r = spawnSync(bwrap, [...plan.argv, '--', '/bin/sh', '-c', CHECK, 'sh', op, path], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {},
  });
  if (r.status !== 0) return `error: exit ${String(r.status)} ${(r.stderr || r.error?.message || '').trim()}`;
  return r.stdout.trim();
}

function firstHostHomeEntry(home: string): string | null {
  for (const n of ['.bashrc', '.profile', '.ssh', '.config', '.gitconfig']) {
    if (existsSync(join(home, n))) return join(home, n);
  }
  return null;
}

/** Runs canaries for one role. `pass: null` marks an observation that is recorded, not judged. */
export function probeRole(role: SandboxRole, fx: ProbeFixture, bwrap = '/usr/bin/bwrap'): CanaryResult[] {
  // The fixture lives outside the host home, so the default policy accepts it.
  const plan = buildSandbox(probeLayout(role, fx));
  const writes = role !== 'reviewer';
  const uid = userInfo().uid;
  const checks: Array<[string, string, string, ProbeExpect]> = [
    ['outside canary unreadable', 'read', join(fx.outside, 'canary'), 'denied'],
    ['control socket path absent', 'exists', join(fx.control, 'cusrd.sock'), 'denied'],
    ['user bus absent', 'exists', `/run/user/${uid}/bus`, 'denied'],
    ['docker socket absent', 'exists', '/var/run/docker.sock', 'denied'],
    ['worktree readable', 'read', join(fx.worktree, 'README.md'), 'allowed'],
    ['worktree write', 'write', join(fx.worktree, 'agent-write.txt'), writes ? 'allowed' : 'denied'],
    ['worktree .git file read-only', 'write', join(fx.worktree, '.git'), 'denied'],
    ['git common dir readable', 'read', join(fx.gitCommon, 'HEAD'), 'allowed'],
    ['git common dir read-only', 'write', join(fx.gitCommon, 'HEAD'), 'denied'],
    ['git admin dir read-only', 'write', join(fx.gitAdmin, 'HEAD'), 'denied'],
    ['scratch writable', 'write', join(IN_SANDBOX.scratch, 'x'), 'allowed'],
    ['context readable', 'read', join(IN_SANDBOX.context, 'prompt.md'), 'allowed'],
    ['context read-only', 'write', join(IN_SANDBOX.context, 'prompt.md'), 'denied'],
    ['home writable', 'write', join(IN_SANDBOX.home, 'x'), 'allowed'],
    ['/usr read-only', 'write', '/usr/cusr-canary', 'denied'],
  ];
  const hostHomeEntry = firstHostHomeEntry(homedir());
  if (hostHomeEntry !== null) checks.push(['host home entry absent', 'exists', hostHomeEntry, 'denied']);
  for (const p of [`${homedir()}/.ssh`, `${homedir()}/.config/gh`, `${homedir()}/.claude`, `${homedir()}/.codex`]) {
    checks.push([`credential path absent ${p}`, 'exists', p, 'denied']);
  }

  const results: CanaryResult[] = checks.map(([name, op, path, expect]) => {
    const observed = runCheck(plan, op, path, bwrap);
    return { name, expect, observed, pass: observed === expect };
  });
  const pids = runCheck(plan, 'pids', '', bwrap);
  results.push({ name: 'pid namespace (visible pids <= 4)', expect: 'denied', observed: pids, pass: Number(pids) > 0 && Number(pids) <= 4 });
  const status = runCheck(plan, 'status', '', bwrap);
  results.push({
    name: 'no_new_privs and dropped bounding caps',
    expect: 'record',
    observed: status,
    pass: /NoNewPrivs:\s+1/.test(status) && /CapEff:\s+0+\b/.test(status),
  });
  const env = runCheck(plan, 'env', '', bwrap);
  const leaked = env.split(/\s+/).filter((k) => FORBIDDEN_ENV.test(k) || SECRET_ENV.test(k));
  results.push({ name: 'no secret env', expect: 'denied', observed: env, pass: leaked.length === 0 });
  // AppArmor stack is evidence only on the provisioned host (T006); recorded, never judged here.
  results.push({ name: 'apparmor label', expect: 'record', observed: runCheck(plan, 'label', '', bwrap), pass: null });
  return results;
}

export type ProbeReport = {
  readonly schema_version: 1;
  readonly kind: 'spike-0-sandbox-probe';
  readonly evidence_scope: string;
  readonly bwrap: { readonly path: string; readonly version: string; readonly usable: boolean; readonly detail: string };
  readonly kernel: string;
  readonly roles: Record<string, { readonly layout_digest: string; readonly pass: boolean; readonly canaries: readonly CanaryResult[] }>;
  readonly apparmor_fixture: { readonly ran: boolean; readonly exit: number | null; readonly output: string } | null;
  readonly layout_pass: boolean;
};

function versionOf(cmd: string, args: readonly string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000 });
  return (r.stdout || r.stderr || '').trim() || 'unknown';
}

export function runProbe(roles: readonly SandboxRole[], opts: { base?: string; apparmorFixture?: boolean; bwrap?: string } = {}): ProbeReport {
  const bwrap = opts.bwrap ?? '/usr/bin/bwrap';
  const usable = bwrapUsable(bwrap);
  const report: ProbeReport = {
    schema_version: 1,
    kind: 'spike-0-sandbox-probe',
    evidence_scope:
      'Outer mount/PID/env canaries on this machine only. Not S0.1 proof without the cusr-bwrap AppArmor child stack, capability-denial audit and T006 records.',
    bwrap: { path: bwrap, version: versionOf(bwrap, ['--version']), usable: usable.usable, detail: usable.detail },
    kernel: versionOf('uname', ['-r']),
    roles: {},
    apparmor_fixture: null,
    layout_pass: false,
  };
  if (!usable.usable) return report;
  const fx = createProbeFixture(opts.base);
  try {
    let all = true;
    for (const role of roles) {
      const canaries = probeRole(role, fx, bwrap);
      const pass = canaries.every((c) => c.pass !== false);
      all &&= pass;
      report.roles[role] = { layout_digest: buildSandbox(probeLayout(role, fx)).layout_digest, pass, canaries };
    }
    let fixture: ProbeReport['apparmor_fixture'] = null;
    if (opts.apparmorFixture === true) {
      const script = fileURLToPath(new URL('../../deploy/apparmor/probe-child.py', import.meta.url));
      const dir = dirname(script);
      const plan = buildSandbox({ ...probeLayout('coder', fx), toolchain: [realpathSync(dir)] });
      const r = spawnSync(bwrap, [...plan.argv, '--', '/usr/bin/python3', script], { encoding: 'utf8', timeout: 60_000, env: {} });
      fixture = { ran: true, exit: r.status, output: `${r.stdout}${r.stderr}`.trim().slice(0, 4_000) };
    }
    return { ...report, apparmor_fixture: fixture, layout_pass: all };
  } finally {
    if (opts.base === undefined) rmSync(fx.base, { recursive: true, force: true });
  }
}

function main(argv: readonly string[]): number {
  const [cmd, ...rest] = argv;
  const opt = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd === 'argv') {
    const file = opt('--layout');
    if (file === undefined) return usage();
    const plan = buildSandbox(JSON.parse(readFileSync(resolve(file), 'utf8')) as SandboxLayout);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }
  if (cmd === 'probe') {
    const role = opt('--role');
    const roles = rest.includes('--all') || role === undefined ? SANDBOX_ROLES : [role as SandboxRole];
    if (!roles.every((r) => (SANDBOX_ROLES as readonly string[]).includes(r))) return usage();
    const base = opt('--base');
    const report = runProbe(roles, {
      ...(base !== undefined ? { base: resolve(base) } : {}),
      apparmorFixture: rest.includes('--apparmor-fixture'),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.bwrap.usable && report.layout_pass ? 0 : 1;
  }
  return usage();
}

function usage(): number {
  process.stderr.write(
    'usage: sandbox.ts argv --layout FILE | probe [--role coder|fixer|reviewer|setup|gate | --all] [--base DIR] [--apparmor-fixture]\n',
  );
  return 2;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`);
    process.exitCode = e instanceof SandboxPolicyError ? 2 : 1;
  }
}
