import { describe, expect, it } from 'vitest';
import { SANDBOX_ROLES, bwrapUsable, runProbe } from '../../../scripts/spike-002/sandbox.ts';

// Real bwrap on this machine. Skipped (not passed) where unprivileged userns is blocked, e.g. the
// restricted host recorded in spike-0-report.md before AppArmor provisioning.
const bwrap = bwrapUsable();

describe.skipIf(!bwrap.usable)('spike-002 outer sandbox canaries (real bwrap, local fixture)', () => {
  const report = runProbe(SANDBOX_ROLES);

  it.each(SANDBOX_ROLES)('%s: every judged canary matches the role contract', (role) => {
    const r = report.roles[role];
    const failed = r?.canaries.filter((c) => c.pass === false).map((c) => `${c.name}: ${c.observed}`);
    expect(failed).toEqual([]);
  });

  it('reviewer cannot write the worktree; writers cannot touch git metadata', () => {
    const get = (role: string, name: string): string | undefined => report.roles[role]?.canaries.find((c) => c.name === name)?.observed;
    expect(get('reviewer', 'worktree write')).toBe('denied');
    expect(get('coder', 'worktree write')).toBe('allowed');
    for (const role of ['coder', 'fixer', 'setup', 'gate']) {
      expect(get(role, 'git common dir read-only')).toBe('denied');
      expect(get(role, 'worktree .git file read-only')).toBe('denied');
    }
  });

  it('records the AppArmor label without judging it, and scopes the evidence', () => {
    expect(report.roles['coder']?.canaries.find((c) => c.name === 'apparmor label')?.pass).toBeNull();
    expect(report.evidence_scope).toMatch(/Not S0\.1 proof/);
    expect(report.evidence_scope).toContain('AppArmor child-stack hardening is optional');
    expect(report.layout_pass).toBe(true);
  });
});
