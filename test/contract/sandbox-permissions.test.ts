/** Private-home auth, post-run write detection and archived permission evidence. */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyManifest } from '../../src/application/capabilities.ts';
import { claudeAdapter } from '../../src/adapters/harness/claude.ts';
import { wireRoleSchema } from '../../src/adapters/harness/result-schema.ts';
import { RunDir } from '../../src/runner/files.ts';
import { assertFreshHome, installAuth } from '../../src/runner/private-home.ts';
import { Redactor } from '../../src/runner/redact.ts';
import {
  IN_SANDBOX,
  SandboxPolicyError,
  snapshotWriteZone,
  writeZoneViolations,
} from '../../src/runner/sandbox.ts';
import { hashCanonical } from '../../src/shared/hash.ts';
import { readRealJson, spikePin, vendorPin } from '../support/harness-fixtures.ts';
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
  for (const fx of fixtures.splice(0)) rmSync(fx.base, { recursive: true, force: true });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture(): SandboxFixture {
  const fx = createSandboxFixture();
  fixtures.push(fx);
  return fx;
}
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
    expect(readFileSync(join(installed.home, '.claude/.credentials.json'), 'utf8')).toContain(
      'selected',
    );
    expect(() => assertFreshHome(run)).toThrow(SandboxPolicyError);
  });

  it('a write to a read-only zone is a boundary violation (runtime canary)', () => {
    const fx = fixture();
    // The read-only boundary (the decider's) covers the worktree and the Git metadata.
    const layout = fixtureLayout('reviewer', fx);
    const before = snapshotWriteZone(layout);
    writeFileSync(join(fx.worktree, 'reviewer-wrote'), 'x');
    mkdirSync(join(fx.gitCommon, 'hooks'), { recursive: true });
    writeFileSync(join(fx.gitCommon, 'hooks', 'pre-push'), '#!/bin/sh\n');
    expect(writeZoneViolations(before, snapshotWriteZone(layout))).toEqual([
      'reviewer changed the read-only worktree',
      'reviewer run changed git metadata',
    ]);
    // A worker edits and commits itself: neither is a violation.
    const coder = fixtureLayout('coder', fx);
    const c0 = snapshotWriteZone(coder);
    writeFileSync(join(fx.worktree, 'coder-wrote'), 'x');
    writeFileSync(join(fx.gitCommon, 'hooks', 'post-commit'), '#!/bin/sh\n');
    expect(writeZoneViolations(c0, snapshotWriteZone(coder))).toEqual([]);
  });
});

describe('permission evidence and refused capabilities (T006/T007)', () => {
  type Iso = {
    vendors: Record<string, { native_result: string; native_result_scope: string }>;
  };
  type Summary = { permission_denials: unknown[] };

  it('the native inner sandbox passed for both vendors and denials were recorded by the vendor', () => {
    const iso = readRealJson<Iso>('isolation-record.json');
    for (const v of ['claude', 'codex']) expect(iso.vendors[v]?.native_result).toBe('passed');
    const stream = readRealJson<Record<string, Record<string, Summary>>>('stream-summary.json');
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
    expect(plan.ok && plan.value.settings_hash).toBe(recorded.vendors.claude.settings_hash);
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
    const observed = observeHarness(pin, settings.value.settings_hash, HOST_POLICY_HASH);
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
    const observed = observeHarness(pin, plan.value.settings_hash, HOST_POLICY_HASH);
    if (!observed.ok) throw new Error('observe');
    const needs = {
      roles: ['coder'] as const,
      isolation: 'internal_required' as const,
      resume: false,
    };
    expect(verifyManifest(m, observed.value, { ...needs, cost: 'reported' }).ok).toBe(true);
    const hard = verifyManifest(m, observed.value, {
      ...needs,
      cost: 'hard_cap',
    });
    expect(!hard.ok && hard.error.map((x) => x.check)).toEqual(['cost']);
  });
});
