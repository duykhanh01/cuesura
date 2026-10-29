/**
 * T065 permission and boundary contract (FR-013/032/033). The plan the provider builds for each role:
 * reviewer read-only, coder/fixer writable worktree only, Git metadata read-only for every role, no
 * host home/admin/operate/GitHub/socket/proc mount or variable, a private home with the selected auth
 * for agent roles only, nothing that lets an agent push. Proof side (T006/T007 evidence): the native
 * inner sandbox passed, permission rules denied independently of the outer boundary for both vendors,
 * the pinned settings hash is the one the manifest records, and external_verified changes only the
 * inner sandbox switch, never the permission rules or the approval policy.
 *
 * The real bwrap run of the same plans is in test/integration/runtime/sandbox-bwrap.test.ts (skipped
 * where bwrap is not installed).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyManifest } from '../../src/application/capabilities.ts';
import { claudeAdapter } from '../../src/adapters/harness/claude.ts';
import { codexAdapter } from '../../src/adapters/harness/codex.ts';
import { wireRoleSchema } from '../../src/adapters/harness/result-schema.ts';
import { SANDBOX_ROLES, type SandboxRole } from '../../src/adapters/ports.ts';
import { RunDir } from '../../src/runner/files.ts';
import { assertFreshHome, installAuth } from '../../src/runner/private-home.ts';
import { Redactor } from '../../src/runner/redact.ts';
import {
  buildBwrap,
  defaultHostPolicy,
  IN_SANDBOX,
  SandboxPolicyError,
  snapshotWriteZone,
  writeZoneViolations,
} from '../../src/runner/sandbox.ts';
import { hashCanonical } from '../../src/shared/hash.ts';
import {
  readRealJson,
  spikePin,
  vendorPin,
} from '../support/harness-fixtures.ts';
import {
  createSandboxFixture,
  fixtureLayout,
  type SandboxFixture,
} from '../support/sandbox-fixture.ts';
import {
  evidenceManifest,
  fakeVendorPin,
  HOST_POLICY_HASH,
  tempDir,
} from '../support/runner-harness.ts';
import { observeHarness } from '../../src/application/capabilities.ts';

const fixtures: SandboxFixture[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const fx of fixtures.splice(0))
    rmSync(fx.base, { recursive: true, force: true });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture(): SandboxFixture {
  const fx = createSandboxFixture();
  fixtures.push(fx);
  return fx;
}
const policy = defaultHostPolicy('/var/lib/cusr-test');

function mountKind(
  plan: ReturnType<typeof buildBwrap>,
  source: string,
): string[] {
  return plan.mounts.filter((m) => m.source === source).map((m) => m.kind);
}

describe('per-role mounts (reviewer ro, coder rw, Git metadata ro)', () => {
  it.each(SANDBOX_ROLES.map((r) => [r] as const))('%s', (role: SandboxRole) => {
    const fx = fixture();
    const plan = buildBwrap(fixtureLayout(role, fx), policy);
    expect(mountKind(plan, fx.worktree)).toEqual([
      role === 'reviewer' ? 'ro' : 'rw',
    ]);
    expect(mountKind(plan, join(fx.worktree, '.git'))).toEqual(['ro']);
    expect(mountKind(plan, fx.gitCommon)).toEqual(['ro']);
    expect(mountKind(plan, fx.scratch)).toEqual(['rw']);
    const agent = role === 'coder' || role === 'fixer' || role === 'reviewer';
    expect(
      plan.mounts.some((m) => m.target === IN_SANDBOX.home && m.kind === 'rw'),
    ).toBe(agent);
    expect(plan.bwrap_args).toEqual(
      expect.arrayContaining([
        '--unshare-pid',
        '--new-session',
        '--die-with-parent',
      ]),
    );
    expect(plan.bwrap_args.join(' ')).toContain('--cap-drop ALL');
    expect(plan.bwrap_args).toContain('--clearenv');
    // A fresh /proc of the sandbox PID namespace, never the host /proc.
    expect(plan.mounts.some((m) => m.source === '/proc')).toBe(false);
  });

  it('setup/gate/autofix are refused a harness home: no model auth outside agent roles', () => {
    const fx = fixture();
    for (const role of ['setup', 'gate', 'autofix'] as const)
      expect(() =>
        buildBwrap(
          { ...fixtureLayout(role, fx), private_home: fx.home },
          policy,
        ),
      ).toThrow(SandboxPolicyError);
  });
});

describe('host, admin, operate, GitHub, socket and proc stay outside', () => {
  const home = homedir();
  it.each([
    ['host home', home],
    ['gh config', join(home, '.config/gh')],
    ['ssh', join(home, '.ssh')],
    ['claude auth of the owner', join(home, '.claude')],
    ['codex auth of the owner', join(home, '.codex')],
    ['store', '/var/lib/cusr-test/cusr.db'],
    ['control socket', '/var/lib/cusr-test/control.sock'],
    ['owner/operate tokens', '/var/lib/cusr-test/tokens'],
    ['docker socket', '/var/run/docker.sock'],
    ['host proc', '/proc'],
  ])('%s is never mounted', (_n, path) => {
    const fx = fixture();
    expect(() =>
      buildBwrap({ ...fixtureLayout('coder', fx), toolchain: [path] }, policy),
    ).toThrow(SandboxPolicyError);
  });

  it.each([
    ['GH_TOKEN'],
    ['GITHUB_TOKEN'],
    ['SSH_AUTH_SOCK'],
    ['DBUS_SESSION_BUS_ADDRESS'],
    ['XDG_RUNTIME_DIR'],
    ['CUSR_ADMIN_TOKEN'],
    ['ANTHROPIC_API_KEY'],
    ['OPENAI_API_KEY'],
  ])('env %s is never passed', (name) => {
    const fx = fixture();
    expect(() =>
      buildBwrap(
        { ...fixtureLayout('coder', fx), env: { [name]: 'x' } },
        policy,
      ),
    ).toThrow(SandboxPolicyError);
  });

  it('an agent cannot push: no GitHub credential enters and the remote config is read-only', () => {
    const fx = fixture();
    const plan = buildBwrap(fixtureLayout('coder', fx), policy);
    expect(
      Object.keys(plan.env).some((k) =>
        /^(GH_|GITHUB_|GIT_ASKPASS|SSH_)/.test(k),
      ),
    ).toBe(false);
    expect(mountKind(plan, fx.gitCommon)).toEqual(['ro']);
  });
});

describe('selected auth only, in a fresh home of an agent run', () => {
  it('installs only the listed files and refuses a home that is not empty', () => {
    const d = tempDir('cusr-perm-', dirs);
    const cred = join(d, 'cred.json');
    const other = join(d, 'other.json');
    writeFileSync(cred, '{"token":"cusr-selected-0123456789"}');
    writeFileSync(other, '{"token":"cusr-other-0123456789"}');
    const run = RunDir.open({
      dataDir: join(d, 'data'),
      kind: 'runs',
      id: 'at-1',
      redactor: new Redactor(),
    });
    assertFreshHome(run);
    const installed = installAuth(run, [
      { ref: { name: 'claude', file: cred }, to: '.claude/.credentials.json' },
    ]);
    expect(installed.files).toEqual(['.claude/.credentials.json']);
    expect(
      readFileSync(join(installed.home, '.claude/.credentials.json'), 'utf8'),
    ).toContain('selected');
    expect(() => assertFreshHome(run)).toThrow(SandboxPolicyError);
  });

  it('a write to a read-only zone is a boundary violation (runtime canary)', () => {
    const fx = fixture();
    const layout = fixtureLayout('reviewer', fx);
    const before = snapshotWriteZone(layout);
    writeFileSync(join(fx.worktree, 'reviewer-wrote'), 'x');
    expect(writeZoneViolations(before, snapshotWriteZone(layout))).toEqual([
      'reviewer changed the read-only worktree',
    ]);
    const coder = fixtureLayout('coder', fx);
    const c0 = snapshotWriteZone(coder);
    writeFileSync(join(fx.worktree, 'coder-wrote'), 'x');
    expect(writeZoneViolations(c0, snapshotWriteZone(coder))).toEqual([]);
    mkdirSync(join(fx.gitCommon, 'hooks'), { recursive: true });
    writeFileSync(join(fx.gitCommon, 'hooks', 'pre-push'), '#!/bin/sh\n');
    expect(writeZoneViolations(c0, snapshotWriteZone(coder))).toEqual([
      'coder run changed git metadata',
    ]);
  });
});

describe('permission rules hold independently of the outer boundary (T006/T007)', () => {
  type Iso = {
    vendors: Record<
      string,
      { native_result: string; native_result_scope: string }
    >;
  };
  type Summary = { permission_denials: unknown[] };

  it('the native inner sandbox passed for both vendors and denials were recorded by the vendor', () => {
    const iso = readRealJson<Iso>('isolation-record.json');
    for (const v of ['claude', 'codex'])
      expect(iso.vendors[v]?.native_result).toBe('passed');
    const stream = readRealJson<Record<string, Record<string, Summary>>>(
      'stream-summary.json',
    );
    expect(JSON.stringify(stream)).toContain('claude_event');
    expect(JSON.stringify(stream)).toContain('codex_stderr');
  });

  it('the pinned Claude settings hash is the one the T007 manifest proved', () => {
    const plan = claudeAdapter.plan(vendorPin('claude'), {
      role: 'coder',
      model: spikePin('claude').model,
      effort: 'low',
      schema: wireRoleSchema('coder', { omit_meta_schema: true }),
      cwd: '/w',
      paths: IN_SANDBOX,
      inner_mode: 'native',
      session: null,
    });
    const recorded = readRealJson<{
      vendors: { claude: { settings_hash: string } };
    }>('capability-manifest.json');
    expect(plan.ok && plan.value.settings_hash).toBe(
      recorded.vendors.claude.settings_hash,
    );
  });

  it('external_verified keeps permission rules and approval; only the inner switch differs', () => {
    const p = (
      inner: 'native' | 'external_verified',
      vendor: 'claude' | 'codex',
    ) => {
      const adapter = vendor === 'claude' ? claudeAdapter : codexAdapter;
      const r = adapter.plan(vendorPin(vendor), {
        role: 'coder',
        model: 'm',
        effort: null,
        schema: wireRoleSchema('coder', {
          omit_meta_schema: vendor === 'claude',
        }),
        cwd: '/w',
        paths: IN_SANDBOX,
        inner_mode: inner,
        session: null,
      });
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    };
    const cn = JSON.parse(
      p('native', 'claude').context_files[0]?.content ?? '',
    ) as { permissions: unknown };
    const cx = JSON.parse(
      p('external_verified', 'claude').context_files[0]?.content ?? '',
    ) as { permissions: unknown };
    expect(cx.permissions).toEqual(cn.permissions);
    for (const inner of ['native', 'external_verified'] as const) {
      const argv = p(inner, 'codex').argv.join(' ');
      expect(argv).toContain('approval_policy="never"');
      expect(argv).not.toMatch(/dangerously|bypass/);
    }
  });

  it('a manifest claiming external_verified without native failure and both proofs is refused', () => {
    const d = tempDir('cusr-perm-', dirs);
    const pin = fakeVendorPin('claude', d);
    const m = evidenceManifest(pin);
    const settings = claudeAdapter.plan(pin, {
      role: 'coder',
      model: 'm',
      effort: null,
      schema: wireRoleSchema('coder', { omit_meta_schema: true }),
      cwd: '/w',
      paths: IN_SANDBOX,
      inner_mode: 'native',
      session: null,
    });
    if (!settings.ok) throw new Error('plan');
    const observed = observeHarness(
      pin,
      settings.value.settings_hash,
      HOST_POLICY_HASH,
    );
    if (!observed.ok) throw new Error('observe');
    const forged = {
      ...m,
      selected_inner_mode: 'external_verified' as const,
      native_result: 'passed' as const,
    };
    const r = verifyManifest(
      {
        ...forged,
        manifest_hash: hashCanonical({
          ...forged,
          manifest_hash: undefined,
        }),
      },
      observed.value,
      {
        roles: ['coder'],
        isolation: 'allow_external_verified',
        cost: 'none',
        resume: false,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.map((x) => x.check)).toContain('isolation');
  });

  it('a hard USD cap is never proven: capability_missing, not an estimate', () => {
    const d = tempDir('cusr-perm-', dirs);
    const pin = fakeVendorPin('claude', d);
    const m = evidenceManifest(pin);
    const plan = claudeAdapter.plan(pin, {
      role: 'coder',
      model: 'm',
      effort: null,
      schema: wireRoleSchema('coder', { omit_meta_schema: true }),
      cwd: '/w',
      paths: IN_SANDBOX,
      inner_mode: 'native',
      session: null,
    });
    if (!plan.ok) throw new Error('plan');
    const observed = observeHarness(
      pin,
      plan.value.settings_hash,
      HOST_POLICY_HASH,
    );
    if (!observed.ok) throw new Error('observe');
    const needs = {
      roles: ['coder'] as const,
      isolation: 'internal_required' as const,
      resume: false,
    };
    expect(
      verifyManifest(m, observed.value, { ...needs, cost: 'reported' }).ok,
    ).toBe(true);
    const hard = verifyManifest(m, observed.value, {
      ...needs,
      cost: 'hard_cap',
    });
    expect(!hard.ok && hard.error.map((x) => x.check)).toEqual(['cost']);
  });
});
