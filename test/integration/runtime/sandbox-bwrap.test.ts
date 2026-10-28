import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SandboxLaunchPlan, SandboxRole } from '../../../src/adapters/ports.ts';
import { BWRAP, BwrapSandboxProvider, LAUNCH_POLICY_EXIT, defaultHostPolicy } from '../../../src/runner/sandbox.ts';
import { createSandboxFixture, fixtureLayout } from '../../support/sandbox-fixture.ts';

// Real bwrap on a local fixture: no model, network, sudo or host policy change.
const usable = spawnSync(BWRAP, ['--unshare-user', '--ro-bind', '/', '/', '/usr/bin/true']).status === 0;
const fx = createSandboxFixture();
afterAll(() => rmSync(fx.base, { recursive: true, force: true }));

const provider = new BwrapSandboxProvider({ policy: defaultHostPolicy(join(fx.base, 'data')) });

function plan(role: SandboxRole, command: readonly string[]): SandboxLaunchPlan {
  const r = provider.plan(fixtureLayout(role, fx), command);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function run(p: SandboxLaunchPlan): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(p.argv[0] as string, p.argv.slice(1), { encoding: 'utf8', timeout: 20_000, env: {} });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

const sh = (script: string): string[] => ['/bin/sh', '-c', script];
const tryWrite = (path: string): string => `if (echo x > '${path}') 2>/dev/null; then echo allowed; else echo denied; fi`;

describe.skipIf(!usable)('BwrapSandboxProvider under real bwrap (T020)', () => {
  it('coder writes the worktree but not Git metadata; reviewer cannot write the worktree', () => {
    expect(run(plan('coder', sh(tryWrite(join(fx.worktree, 'new.txt')))))).toMatchObject({ status: 0, stdout: 'allowed' });
    expect(existsSync(join(fx.worktree, 'new.txt'))).toBe(true);
    expect(run(plan('coder', sh(tryWrite(join(fx.gitCommon, 'HEAD')))))).toMatchObject({ stdout: 'denied' });
    expect(run(plan('coder', sh(tryWrite(join(fx.worktree, '.git')))))).toMatchObject({ stdout: 'denied' });
    expect(run(plan('reviewer', sh(tryWrite(join(fx.worktree, 'review.txt')))))).toMatchObject({ stdout: 'denied' });
    expect(run(plan('reviewer', sh(tryWrite('/cusr/scratch/notes.txt'))))).toMatchObject({ stdout: 'allowed' });
  });

  it('hides unmounted host paths, host processes and the caller environment', () => {
    const canary = join(fx.outside, 'canary');
    expect(run(plan('gate', sh(`cat '${canary}' 2>/dev/null || echo hidden`)))).toMatchObject({ stdout: 'hidden' });
    const pids = run(plan('gate', sh('ls -d /proc/[0-9]* | wc -l')));
    expect(Number(pids.stdout)).toBeLessThanOrEqual(3);
    expect(run(plan('gate', sh('echo "$HOME"')))).toMatchObject({ stdout: '/cusr/home' });
    expect(run(plan('gate', sh('grep ^CapEff /proc/self/status')))).toMatchObject({ stdout: 'CapEff:\t0000000000000000' });
    expect(readFileSync(canary, 'utf8')).toBe('outside-canary\n');
  });

  it('fails closed when a mount source is swapped for a symlink after planning (S0.1 TOCTOU)', () => {
    for (const which of [fx.scratch, fx.worktree]) {
      const p = plan('coder', sh('ls /cusr/scratch; echo ran'));
      const aside = `${which}.aside`;
      renameSync(which, aside);
      symlinkSync(fx.outside, which);
      try {
        const r = run(p);
        expect(r.status, which).toBe(LAUNCH_POLICY_EXIT);
        expect(r.stdout).not.toContain('ran');
        expect(r.stderr).toMatch(/SandboxPolicyError/);
      } finally {
        rmSync(which);
        renameSync(aside, which);
      }
    }
    expect(readFileSync(join(fx.outside, 'canary'), 'utf8')).toBe('outside-canary\n');
  });
});
