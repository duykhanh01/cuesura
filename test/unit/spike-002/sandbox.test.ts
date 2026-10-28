import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  IN_SANDBOX,
  SandboxPolicyError,
  buildSandbox,
  defaultHostPolicy,
  sandboxCommand,
  type HostPolicy,
  type SandboxLayout,
  type SandboxRole,
} from '../../../scripts/spike-002/sandbox.ts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-sandbox-unit-')));
const d = (name: string): string => {
  const p = join(base, name);
  mkdirSync(p, { recursive: true });
  return p;
};
const fakeHome = d('home/user');
const worktree = d('home/user/.cusr/worktrees/p/t1');
writeFileSync(join(worktree, '.git'), 'gitdir: /x\n');
const gitCommon = d('repo/.git');
const scratch = d('runs/a1/scratch');
const privateHome = d('runs/a1/private-home');
const context = d('runs/a1/context');
d('home/user/.ssh');
const policy: HostPolicy = { ...defaultHostPolicy(), hostHome: fakeHome, forbidden: [...defaultHostPolicy().forbidden, join(fakeHome, '.ssh')] };

afterAll(() => rmSync(base, { recursive: true, force: true }));

function layout(role: SandboxRole, over: Partial<SandboxLayout> = {}): SandboxLayout {
  const agent = role === 'coder' || role === 'fixer' || role === 'reviewer';
  return {
    role,
    worktree,
    git_dirs: [gitCommon],
    scratch,
    private_home: agent ? privateHome : null,
    context,
    schema: null,
    toolchain: [],
    env: {},
    network: 'internet_outbound',
    ...over,
  };
}

function mountOf(argv: readonly string[], target: string): string | undefined {
  for (let i = 0; i < argv.length; i++) if (argv[i + 2] === target && /^--(ro-)?bind$/.test(argv[i] ?? '')) return argv[i];
  return undefined;
}

describe('spike-002 sandbox layout (execution contract)', () => {
  it.each([
    ['coder', '--bind'],
    ['fixer', '--bind'],
    ['reviewer', '--ro-bind'],
    ['setup', '--bind'],
    ['gate', '--bind'],
  ] as const)('%s worktree mount is %s; git metadata and context are read-only', (role, flag) => {
    const plan = buildSandbox(layout(role), policy);
    expect(mountOf(plan.argv, worktree)).toBe(flag);
    expect(mountOf(plan.argv, join(worktree, '.git'))).toBe('--ro-bind');
    expect(mountOf(plan.argv, gitCommon)).toBe('--ro-bind');
    expect(mountOf(plan.argv, IN_SANDBOX.context)).toBe('--ro-bind');
    expect(mountOf(plan.argv, IN_SANDBOX.scratch)).toBe('--bind');
    // The .git overlay must come after the worktree bind so it wins.
    expect(plan.argv.lastIndexOf(join(worktree, '.git'))).toBeGreaterThan(plan.argv.indexOf(worktree));
  });

  it('isolates namespaces, drops capabilities, clears env and shares the host network as recorded', () => {
    const plan = buildSandbox(layout('coder'), policy);
    for (const f of ['--unshare-user', '--unshare-pid', '--die-with-parent', '--new-session', '--clearenv']) expect(plan.argv).toContain(f);
    expect(plan.argv.join(' ')).toContain('--cap-drop ALL');
    expect(plan.argv).not.toContain('--unshare-net');
    expect(plan.argv.join(' ')).toContain('--proc /proc');
    expect(plan.argv.join(' ')).not.toMatch(/bind \/proc /);
    expect(plan.network).toBe('internet_outbound');
    expect(plan.env['HOME']).toBe(IN_SANDBOX.home);
  });

  it('agent roles get the private home; setup/gate get an empty tmpfs home and no harness auth', () => {
    expect(mountOf(buildSandbox(layout('reviewer'), policy).argv, IN_SANDBOX.home)).toBe('--bind');
    const gate = buildSandbox(layout('gate'), policy);
    expect(mountOf(gate.argv, IN_SANDBOX.home)).toBeUndefined();
    expect(gate.argv.join(' ')).toContain(`--tmpfs ${IN_SANDBOX.home}`);
    expect(() => buildSandbox(layout('gate', { private_home: privateHome }), policy)).toThrow(/no model auth/);
    expect(() => buildSandbox(layout('coder', { private_home: null }), policy)).toThrow(/private home/);
  });

  it.each([
    ['the host home itself', { worktree: fakeHome }],
    ['an ancestor of the host home', { toolchain: [join(base, 'home')] }],
    ['the filesystem root', { toolchain: ['/'] }],
    ['a credential directory', { toolchain: [join(fakeHome, '.ssh')] }],
    ['a parent of a credential directory', { scratch: d('home/user/.cusr') }],
    ['/proc', { toolchain: ['/proc'] }],
    ['a relative path', { scratch: 'runs/a1/scratch' }],
    ['a path with ..', { scratch: `${base}/runs/../runs/a1/scratch` }],
    ['scratch inside the worktree', { scratch: d('home/user/.cusr/worktrees/p/t1/tmp') }],
  ])('rejects mounting %s', (_name, over) => {
    expect(() => buildSandbox(layout('coder', over as Partial<SandboxLayout>), policy)).toThrow(SandboxPolicyError);
  });

  it('rejects a symlinked mount source instead of following it', () => {
    const link = join(base, 'link-to-ssh');
    symlinkSync(join(fakeHome, '.ssh'), link);
    expect(() => buildSandbox(layout('coder', { toolchain: [link] }), policy)).toThrow(/symlink/);
  });

  it.each([
    ['reviewer home aliases worktree', 'reviewer', { private_home: worktree }],
    ['coder home aliases worktree and bypasses metadata overlay', 'coder', { private_home: worktree }],
    ['scratch aliases Git common dir', 'coder', { scratch: gitCommon }],
    ['scratch contains Git common dir', 'coder', { scratch: join(base, 'repo') }],
    ['home aliases Git common dir', 'coder', { private_home: gitCommon }],
    ['home is inside Git metadata', 'coder', { private_home: d('repo/.git/private-home') }],
    ['scratch aliases context', 'coder', { scratch: context }],
    ['home aliases schema', 'coder', { schema: privateHome }],
    ['home aliases scratch', 'coder', { private_home: scratch }],
    ['scratch aliases toolchain', 'coder', { toolchain: [scratch] }],
  ] satisfies [string, SandboxRole, Partial<SandboxLayout>][])('rejects writable source overlap: %s', (_name, role, over) => {
    expect(() => buildSandbox(layout(role, over), policy)).toThrow(SandboxPolicyError);
  });

  it.each(['symlink', 'directory', 'ancestor'] as const)('fails closed when a source is replaced by %s after command construction', (kind) => {
    const parent = d(`swap-${kind}`);
    const source = d(`swap-${kind}/scratch`);
    const plan = buildSandbox(layout('coder', { scratch: source }), policy);
    const [exe, ...args] = sandboxCommand(plan, ['/usr/bin/true'], '/usr/bin/true');
    if (kind === 'ancestor') {
      renameSync(parent, `${parent}.aside`);
      mkdirSync(source, { recursive: true });
    } else {
      renameSync(source, `${source}.aside`);
      if (kind === 'symlink') symlinkSync(context, source);
      else mkdirSync(source);
    }
    const r = spawnSync(exe as string, args, { encoding: 'utf8' });
    expect(r.status).toBe(125);
    expect(r.stderr).toMatch(/mount source changed/);
  });

  it('includes source device/inode in the layout digest', () => {
    const source = d('digest-scratch');
    const before = buildSandbox(layout('coder', { scratch: source }), policy);
    renameSync(source, `${source}.aside`);
    mkdirSync(source);
    const after = buildSandbox(layout('coder', { scratch: source }), policy);
    expect(before.argv).toEqual(after.argv);
    expect(before.layout_digest).not.toBe(after.layout_digest);
  });

  it('rejects an optional source appearing between planning and launch', () => {
    const source = join(base, 'optional-file');
    const plan = buildSandbox(layout('coder'), { ...policy, systemRoTry: [source] });
    writeFileSync(source, 'appeared');
    const [exe, ...args] = sandboxCommand(plan, ['/usr/bin/true'], '/usr/bin/true');
    const r = spawnSync(exe as string, args, { encoding: 'utf8' });
    expect(r.status).toBe(125);
    expect(r.stderr).toMatch(/source appeared/);
  });

  it('passes pinned source FDs to bwrap so a later path swap cannot redirect a mount', () => {
    const source = d('pinned-scratch');
    const canary = d('pinned-outside');
    const fakeBwrap = join(base, 'inspect-bwrap.py');
    writeFileSync(fakeBwrap, `#!/usr/bin/python3
import json, os, sys
args = sys.argv[1:]
i = args.index('/cusr/scratch')
assert args[i - 2] == '--bind-fd'
fd = int(args[i - 1])
os.rename(${JSON.stringify(source)}, ${JSON.stringify(`${source}.aside`)})
os.symlink(${JSON.stringify(canary)}, ${JSON.stringify(source)})
with open('/proc/self/fd/' + str(fd) + '/pinned', 'w') as f: f.write('original')
st = os.fstat(fd)
print(json.dumps({'dev': str(st.st_dev), 'ino': str(st.st_ino)}))
`);
    chmodSync(fakeBwrap, 0o700);
    const plan = buildSandbox(layout('coder', { scratch: source }), policy);
    const st = statSync(source, { bigint: true });
    const [exe, ...args] = sandboxCommand(plan, ['/usr/bin/true'], fakeBwrap);
    const r = spawnSync(exe as string, args, { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ dev: String(st.dev), ino: String(st.ino) });
    expect(readFileSync(join(`${source}.aside`, 'pinned'), 'utf8')).toBe('original');
    expect(() => readFileSync(join(canary, 'pinned'))).toThrow();
  });

  it('rejects a worktree .git symlink that would expose an outside file through the metadata mount', () => {
    const wt = d('symlink-worktree');
    const outside = join(d('outside'), 'credential-canary');
    writeFileSync(outside, 'disposable credential fixture');
    symlinkSync(outside, join(wt, '.git'));
    expect(() => buildSandbox(layout('coder', { worktree: wt }), policy)).toThrow(/worktree \.git.*symlink/);
  });

  it.each(['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CUSR_ADMIN_TOKEN'])(
    'never passes %s into the sandbox, for any role',
    (key) => {
      for (const role of ['coder', 'reviewer', 'gate'] as const) {
        expect(() => buildSandbox(layout(role, { env: { [key]: 'x' } }), policy)).toThrow(SandboxPolicyError);
      }
    },
  );

  it('layout digest changes when a mount changes', () => {
    const a = buildSandbox(layout('coder'), policy).layout_digest;
    const b = buildSandbox(layout('reviewer'), policy).layout_digest;
    expect(a).not.toBe(b);
    expect(buildSandbox(layout('coder'), policy).layout_digest).toBe(a);
  });
});
