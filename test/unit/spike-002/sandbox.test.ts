import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  IN_SANDBOX,
  SandboxPolicyError,
  buildSandbox,
  defaultHostPolicy,
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
