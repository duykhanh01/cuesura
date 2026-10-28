import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxLaunchPlan } from '../../../src/adapters/ports.ts';
import { RunDir } from '../../../src/runner/files.ts';
import { installAuth, removeAuth } from '../../../src/runner/private-home.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import { BwrapSandboxProvider, IN_SANDBOX, LAUNCHER, PYTHON, SandboxPolicyError, buildBwrap, defaultHostPolicy } from '../../../src/runner/sandbox.ts';
import { createSandboxFixture, fixtureLayout, type SandboxFixture } from '../../support/sandbox-fixture.ts';

const fixtures: SandboxFixture[] = [];
afterEach(() => {
  for (const fx of fixtures.splice(0)) rmSync(fx.base, { recursive: true, force: true });
});
function fixture(): SandboxFixture {
  const fx = createSandboxFixture();
  fixtures.push(fx);
  return fx;
}

const policy = defaultHostPolicy('/var/lib/cusr-test');

function bindsOf(args: readonly string[], source: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a.startsWith('--') && a.includes('bind') && args[i + 1] === source) out.push(a);
  });
  return out;
}

describe('bwrap layout policy (T020)', () => {
  it('gives coder/fixer/setup/gate/autofix a writable worktree and the reviewer a read-only one; Git metadata is always read-only', () => {
    const fx = fixture();
    for (const role of ['coder', 'fixer', 'setup', 'gate', 'autofix', 'reviewer'] as const) {
      const p = buildBwrap(fixtureLayout(role, fx), policy);
      expect(bindsOf(p.bwrap_args, fx.worktree), role).toEqual([role === 'reviewer' ? '--ro-bind' : '--bind']);
      expect(bindsOf(p.bwrap_args, join(fx.worktree, '.git')), role).toEqual(['--ro-bind']);
      expect(bindsOf(p.bwrap_args, fx.gitCommon), role).toEqual(['--ro-bind']);
      expect(bindsOf(p.bwrap_args, fx.context), role).toEqual(['--ro-bind']);
      expect(bindsOf(p.bwrap_args, fx.scratch), role).toEqual(['--bind']);
      expect(p.bwrap_args).toContain('--unshare-pid');
      expect(p.bwrap_args).toContain('--clearenv');
      expect(p.bwrap_args).not.toContain('--unshare-net');
      expect(p.bwrap_args.join(' ')).not.toMatch(/--bind \/proc|--ro-bind \/proc|--bind \/home |--ro-bind \/home /);
    }
  });

  it('mounts a private home only for agent roles; setup/gate/autofix get none and cannot be given one', () => {
    const fx = fixture();
    expect(bindsOf(buildBwrap(fixtureLayout('coder', fx), policy).bwrap_args, fx.home)).toEqual(['--bind']);
    const gate = buildBwrap(fixtureLayout('gate', fx), policy).bwrap_args;
    expect(bindsOf(gate, fx.home)).toEqual([]);
    expect(gate.join(' ')).toContain(`--tmpfs ${IN_SANDBOX.home}`);
    expect(() => buildBwrap({ ...fixtureLayout('gate', fx), private_home: fx.home }, policy)).toThrow(/must not receive a harness home/);
    expect(() => buildBwrap({ ...fixtureLayout('coder', fx), private_home: null }, policy)).toThrow(/requires a private home/);
  });

  it.each([
    ['a symlinked source', (fx: SandboxFixture) => {
      const link = join(fx.base, 'scratch-link');
      symlinkSync(fx.outside, link);
      return { scratch: link };
    }, 'source_symlink'],
    ['a missing source', (fx: SandboxFixture) => ({ scratch: join(fx.base, 'nope') }), 'source_missing'],
    ['the host home itself', () => ({ toolchain: [homedir()] }), 'policy_violation'],
    ['a parent of the host home', () => ({ toolchain: ['/home'] }), 'policy_violation'],
    ['a credential directory', () => ({ toolchain: [join(homedir(), '.ssh')] }), 'policy_violation'],
    ['scratch inside the worktree', (fx: SandboxFixture) => {
      mkdirSync(join(fx.worktree, 'tmp'));
      return { scratch: join(fx.worktree, 'tmp') };
    }, 'policy_violation'],
    ['a GitHub token in env', () => ({ env: { GH_TOKEN: 'x' } }), 'policy_violation'],
    ['a secret-looking env', () => ({ env: { ANTHROPIC_API_KEY: 'x' } }), 'policy_violation'],
  ] as const)('refuses %s', (_name, change, code) => {
    const fx = fixture();
    const layout = { ...fixtureLayout('coder', fx), ...change(fx) };
    try {
      buildBwrap(layout, policy);
      expect.unreachable('layout accepted');
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxPolicyError);
      expect((e as SandboxPolicyError).code).toBe(code);
    }
  });

  it('refuses mounting the daemon DATA_DIR control files', () => {
    const fx = fixture();
    const data = join(fx.base, 'data');
    mkdirSync(join(data, 'locks'), { recursive: true });
    writeFileSync(join(data, 'cusr.db'), '');
    const p = defaultHostPolicy(data);
    expect(() => buildBwrap({ ...fixtureLayout('coder', fx), toolchain: [data] }, p)).toThrow(/overlaps forbidden/);
    expect(() => buildBwrap({ ...fixtureLayout('coder', fx), toolchain: [join(data, 'locks')] }, p)).toThrow(/overlaps forbidden/);
  });
});

describe('BwrapSandboxProvider plan', () => {
  it('wraps the command in the identity-checking launcher with pinned (dev, ino) and proof refs', () => {
    const fx = fixture();
    const r = new BwrapSandboxProvider({ policy }).plan(fixtureLayout('coder', fx), ['/bin/true']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const plan: SandboxLaunchPlan = r.value;
    expect(plan.argv.slice(0, 3)).toEqual([PYTHON, '-I', LAUNCHER]);
    expect(plan.argv.at(-1)).toBe('/bin/true');
    expect(plan).toMatchObject({ isolation_mode: 'isolated', provider: 'bwrap', network: 'internet_outbound', cwd: fx.worktree });
    const wt = plan.mount_sources.find((m) => m.source === fx.worktree);
    const st = statSync(fx.worktree, { bigint: true });
    expect(wt).toEqual({ source: fx.worktree, realpath: fx.worktree, dev: String(st.dev), ino: String(st.ino) });
    expect(plan.proof_refs.length).toBeGreaterThan(0);
    const again = new BwrapSandboxProvider({ policy }).plan(fixtureLayout('coder', fx), ['/bin/true']);
    expect(again.ok && again.value.layout_digest).toBe(plan.layout_digest);
    const reviewer = new BwrapSandboxProvider({ policy }).plan(fixtureLayout('reviewer', fx), ['/bin/true']);
    expect(reviewer.ok && reviewer.value.layout_digest).not.toBe(plan.layout_digest);
  });

  it('returns policy errors as data and refuses an empty command or missing proof', () => {
    const fx = fixture();
    const provider = new BwrapSandboxProvider({ policy });
    expect(provider.plan({ ...fixtureLayout('coder', fx), env: { GITHUB_TOKEN: 'x' } }, ['/bin/true'])).toMatchObject({ ok: false, error: { code: 'policy_violation' } });
    expect(provider.plan(fixtureLayout('coder', fx), [])).toMatchObject({ ok: false });
    expect(new BwrapSandboxProvider({ policy, proofRefs: [] }).plan(fixtureLayout('coder', fx), ['/bin/true'])).toMatchObject({ ok: false, error: { code: 'proof_missing' } });
  });
});

describe('private home auth', () => {
  it('copies only the selected credential files 0600 and removes them after archive', () => {
    const fx = fixture();
    const cred = join(fx.base, 'claude-credentials.json');
    writeFileSync(cred, '{"token":"secret-value"}');
    const run = RunDir.open({ dataDir: join(fx.base, 'data'), kind: 'runs', id: 'at-1', redactor: new Redactor() });
    const installed = installAuth(run, [{ ref: { name: 'claude', file: cred }, to: '.claude/.credentials.json' }]);
    const target = join(installed.home, '.claude/.credentials.json');
    expect(readFileSync(target, 'utf8')).toBe('{"token":"secret-value"}');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    removeAuth(installed);
    expect(() => statSync(target)).toThrow();
  });

  it('refuses symlinked credentials and targets outside the home before copying anything', () => {
    const fx = fixture();
    const real = join(fx.base, 'real.json');
    writeFileSync(real, '{}');
    const link = join(fx.base, 'link.json');
    symlinkSync(real, link);
    const run = RunDir.open({ dataDir: join(fx.base, 'data'), kind: 'runs', id: 'at-2', redactor: new Redactor() });
    expect(() => installAuth(run, [{ ref: { name: 'a', file: real }, to: 'ok.json' }, { ref: { name: 'b', file: link }, to: 'b.json' }])).toThrow(/symlinks refused/);
    expect(() => installAuth(run, [{ ref: { name: 'a', file: real }, to: '../escape.json' }])).toThrow(/inside the private home/);
    expect(() => statSync(join(run.dir, 'private-home', 'ok.json'))).toThrow();
  });
});
