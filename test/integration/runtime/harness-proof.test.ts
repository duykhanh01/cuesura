/**
 * T126 tool on the real unit and sandbox with the vendor stand-in: what it may spend, and that a capability
 * reaches the evidence only when the runs showed it. It proves the tool, never a vendor.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { hashText } from '../../../src/shared/hash.ts';
import { DENIED_COMMAND } from '../../../src/runner/harness-proof.ts';
import type { VendorPin } from '../../../src/adapters/harness/vendor.ts';
import { validateConfig } from '../../../src/config/validate.ts';
import {
  planProof,
  PROOF_LEDGER,
  proveHarness,
} from '../../../src/runner/harness-proof.ts';
import {
  harnessRecordProblem,
  hostSandbox,
  loadHarnessRecord,
  recordManifest,
} from '../../../src/runner/harness-records.ts';
import { homeFileContent, REAL } from '../../support/harness-fixtures.ts';
import { fakeVendorPin } from '../../support/runner-harness.ts';
import {
  copyPrompts,
  hostUsable,
  smokeUserConfig,
  SMOKE_CANARY,
} from '../../support/smoke.ts';

const RUNNER = fileURLToPath(
  new URL('../../../src/cli/cusr-runner.ts', import.meta.url),
);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const REPLAYS = {
  claude: {
    FAKE_VENDOR_REPLAY: 's0-claude-coder-1793172185',
    FAKE_VENDOR_FIXER_REPLAY: 's0-claude-fixer-1793173414',
    FAKE_VENDOR_REVIEWER_REPLAY: 's0-claude-reviewer-1793172547',
  },
  codex: {
    FAKE_VENDOR_REPLAY: 's0-codex-coder-1793178479',
    FAKE_VENDOR_FIXER_REPLAY: 's0-codex-fixer-1793173505',
    FAKE_VENDOR_REVIEWER_REPLAY: 's0-codex-reviewer-1793180367',
  },
} as const;

function setup(
  vendor: 'claude' | 'codex',
  env: Record<string, string> = {
    FAKE_VENDOR_INNER_SANDBOX: '1',
    FAKE_VENDOR_DENY_STDERR: '1',
  },
) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-proof-')));
  dirs.push(base);
  const dataDir = join(base, 'data');
  mkdirSync(dataDir, { mode: 0o700 });
  const bin = join(base, 'bin');
  mkdirSync(bin);
  const replays = Object.fromEntries(
    Object.entries(REPLAYS[vendor]).map(([k, v]) => [k, join(REAL, v)]),
  );
  const original: VendorPin = {
    ...fakeVendorPin(vendor, bin, {
      FAKE_VENDOR_ECHO_MODEL: '1',
      FAKE_VENDOR_REVIEWER_PROBE: '1',
      ...replays,
      ...env,
    }),
    toolchain: [dirname(process.execPath), realpathSync(REAL)],
  };
  const rules = (h: VendorPin['home_files'][number]): string =>
    homeFileContent(
      h,
      JSON.stringify({ accessToken: SMOKE_CANARY }),
    ).replaceAll('/cusr/scratch/', '');
  const pin: VendorPin = {
    ...original,
    settings:
      vendor === 'claude'
        ? {
            ...original.settings,
            permissions: {
              ...(original.settings?.['permissions'] as Record<
                string,
                unknown
              >),
              deny: [`Bash(${DENIED_COMMAND})`],
            },
          }
        : null,
    home_files: original.home_files.map((h) =>
      h.sha256 === undefined
        ? h
        : { ...h, sha256: hashText(rules(h)).slice(7) },
    ),
  };
  const credentialRefs: Record<string, string> = {};
  for (const h of pin.home_files) {
    const file = join(base, h.credential);
    writeFileSync(file, rules(h));
    credentialRefs[h.credential] = file;
  }
  const configPath = join(base, 'config.yaml');
  writeFileSync(
    configPath,
    smokeUserConfig({
      dataDir,
      projects: { proof: { path: base, repo: 'acme/proof' } },
      credentialRefs,
      worker: vendor,
    }),
  );
  copyPrompts(configPath);
  const validated = validateConfig({
    user: { file: configPath, text: readFileSync(configPath, 'utf8') },
    packs: {},
  });
  if (!validated.ok) throw new Error(JSON.stringify(validated.error));
  const runtime = validated.value.runtime;
  if (runtime === null) throw new Error('no runtime');
  const records = join(dataDir, 'harnesses', vendor);
  mkdirSync(records, { recursive: true, mode: 0o700 });
  writeFileSync(join(records, 'pin.json'), JSON.stringify(pin), {
    mode: 0o600,
  });
  const outerProofFile = join(base, 'outer-proof.json');
  writeFileSync(outerProofFile, '{"proof":"host"}');
  const out = join(base, 'evidence.json');
  const options = {
    dataDir,
    harness: vendor,
    configPath,
    runtime,
    model: 'proof-model',
    effort: 'low',
    outerProofFile,
    runnerCommand: [process.execPath, RUNNER],
    now: () => Date.now(),
  };
  const budget = { approval: 'owner, test', maxInvocations: 3 };
  const ledger = join(records, PROOF_LEDGER);
  const record = () =>
    recordManifest({
      dataDir,
      harness: vendor,
      configPath,
      runtime,
      evidenceFile: out,
      fixtureRef: out,
      now: Date.now(),
    });
  const problem = () => {
    const r = loadHarnessRecord(dataDir, vendor);
    if (!r.ok) throw new Error(r.error);
    return harnessRecordProblem(r.value, {
      isolation: 'internal_required',
      host_policy_hash: hostSandbox({ dataDir, configPath, runtime })
        .policy_hash,
    });
  };
  return { options, budget, out, ledger, record, problem };
}

const refusal = (r: { ok: boolean; error?: string }): string =>
  r.ok ? 'not refused' : (r.error ?? '');

const entry = (out: string, vendor: string) =>
  (
    JSON.parse(readFileSync(out, 'utf8')) as {
      vendors: Record<
        string,
        {
          native_result: string;
          capabilities: Record<string, { status: string }>;
        }
      >;
    }
  ).vendors[vendor];

describe('what a proof may spend', () => {
  it('a dry run reports the plan and leaves no trace', () => {
    const h = setup('claude');
    const plan = planProof(h.options);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.value.invocations_spent).toBe(0);
    expect(existsSync(h.ledger)).toBe(false);
  });

  it('refuses before the first spawn without an approval or a cap for all three roles', async () => {
    const h = setup('claude');
    const none = await proveHarness({
      ...h.options,
      out: h.out,
      budget: { approval: ' ', maxInvocations: 3 },
    });
    expect(refusal(none)).toContain('approval');
    const low = await proveHarness({
      ...h.options,
      out: h.out,
      budget: { approval: 'owner', maxInvocations: 2 },
    });
    expect(refusal(low)).toContain('exceed the cap');
    expect(existsSync(h.ledger)).toBe(false);
    expect(existsSync(h.out)).toBe(false);
  });

  it('plans without an outer proof and spends no invocation', () => {
    const h = setup('claude');
    const r = planProof({ ...h.options, outerProofFile: '/missing-proof' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.outer_proof_hash).toBeNull();
    expect(existsSync(h.ledger)).toBe(false);
  });
});

describe.skipIf(!hostUsable())('a proof on the real unit and sandbox', () => {
  it.each(['claude', 'codex'] as const)(
    '%s: three roles, evidence record-manifest takes, a record that holds',
    async (vendor) => {
      const h = setup(vendor);
      const r = await proveHarness({
        ...h.options,
        out: h.out,
        budget: h.budget,
      });
      if (!r.ok) throw new Error(r.error);
      expect(
        r.value.runs.map((x) => [x.role, x.outcome.kind]),
        JSON.stringify(r.value.runs),
      ).toEqual([
        ['coder', 'result'],
        ['fixer', 'result'],
        ['reviewer', 'result'],
      ]);
      const e = entry(h.out, vendor);
      expect(e?.native_result).toBe('passed');
      for (const c of [
        'structured_output',
        'permission_denial_kept',
        'private_home_auth',
        'usage_report',
        'schema_acceptance_coder',
        'schema_acceptance_fixer',
        'schema_acceptance_reviewer',
      ])
        expect(e?.capabilities[c]?.status, c).toBe('proven');
      expect(e?.capabilities['session_resume']?.status).toBe('unknown');
      const recorded = h.record();
      if (!recorded.ok) throw new Error(recorded.error);
      expect(h.problem()).toBeNull();
      expect(readFileSync(h.out, 'utf8')).not.toContain(SMOKE_CANARY);
      expect(readFileSync(h.ledger, 'utf8').trim().split('\n')).toHaveLength(3);

      // The next proof of this binary counts the three already spent.
      const again = await proveHarness({
        ...h.options,
        out: h.out,
        budget: h.budget,
      });
      expect(refusal(again)).toContain('exceed the cap');
    },
    120_000,
  );

  it('no inner sandbox and no refusal: both stay unproven and the record does not hold', async () => {
    const h = setup('codex', {});
    const r = await proveHarness({
      ...h.options,
      out: h.out,
      budget: h.budget,
    });
    if (!r.ok) throw new Error(r.error);
    const e = entry(h.out, 'codex');
    expect(e?.native_result).toBe('failed');
    expect(e?.capabilities['permission_denial_kept']?.status).toBe('unknown');
    const recorded = h.record();
    if (!recorded.ok) throw new Error(recorded.error);
    expect(h.problem()).toMatch(/permission_enforced|native sandbox/);
  }, 120_000);

  it('proves Claude auto permissions with the worker sandbox off without claiming native enforcement', async () => {
    const h = setup('claude');
    const pinFile = join(h.options.dataDir, 'harnesses', 'claude', 'pin.json');
    const pin = JSON.parse(readFileSync(pinFile, 'utf8')) as VendorPin;
    const settings = pin.settings as Record<string, unknown>;
    const sandbox = settings['sandbox'] as Record<string, unknown>;
    const { enabled: _enabled, ...defaults } = sandbox;
    writeFileSync(
      pinFile,
      JSON.stringify({ ...pin, settings: { ...settings, sandbox: defaults } }),
    );
    const r = await proveHarness({
      ...h.options,
      out: h.out,
      budget: h.budget,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.runs.map((x) => x.outcome.kind)).toEqual([
      'result',
      'result',
      'result',
    ]);
    expect(r.value.runs.map((x) => x.native_write_blocked)).toEqual([
      false,
      false,
      true,
    ]);
    expect(entry(h.out, 'claude')?.native_result).toBe('not_tried');
    expect(
      entry(h.out, 'claude')?.capabilities['permission_denial_kept']?.status,
    ).toBe('proven');
    const recorded = h.record();
    if (!recorded.ok) throw new Error(recorded.error);
    expect(recorded.value.selected_inner_mode).toBe('permissions_only');
    expect(h.problem()).toBeNull();
  });

  it.each(['claude', 'codex'] as const)(
    '%s: valid answers and a rule refusal do not prove native sandboxing',
    async (vendor) => {
      const h = setup(vendor, { FAKE_VENDOR_DENY_STDERR: '1' });
      // Keep all roles returning valid results so missing native evidence cannot hide behind a failed reviewer.
      const pinFile = join(h.options.dataDir, 'harnesses', vendor, 'pin.json');
      const pin = JSON.parse(readFileSync(pinFile, 'utf8')) as VendorPin;
      const { FAKE_VENDOR_REVIEWER_PROBE: _probe, ...env } = pin.env;
      writeFileSync(pinFile, JSON.stringify({ ...pin, env }));
      const r = await proveHarness({
        ...h.options,
        out: h.out,
        budget: h.budget,
      });
      if (!r.ok) throw new Error(r.error);
      expect(r.value.runs.map((x) => x.outcome.kind)).toEqual([
        'result',
        'result',
        'result',
      ]);
      expect(
        entry(h.out, vendor)?.capabilities['permission_denial_kept']?.status,
      ).toBe('proven');
      expect(entry(h.out, vendor)?.native_result).toBe('failed');
    },
  );

  it.each(['claude', 'codex'] as const)(
    '%s: detects a rule bypass at the same marker path the command writes',
    async (vendor) => {
      const h = setup(vendor, {
        FAKE_VENDOR_INNER_SANDBOX: '1',
        FAKE_VENDOR_DENY_STDERR: '1',
        FAKE_VENDOR_PROOF_ALLOW_RULE: '1',
      });
      const r = await proveHarness({
        ...h.options,
        out: h.out,
        budget: h.budget,
      });
      if (!r.ok) throw new Error(r.error);
      expect(r.value.runs[0]?.marker_absent).toBe(false);
      expect(
        entry(h.out, vendor)?.capabilities['permission_denial_kept']?.status,
      ).toBe('unknown');
    },
  );

  it('a failing binary ends the proof at its first role, counted, and proves nothing', async () => {
    const h = setup('claude', { FAKE_VENDOR_MODE: 'exit1' });
    const r = await proveHarness({
      ...h.options,
      out: h.out,
      budget: h.budget,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.runs.map((x) => x.outcome.kind)).toEqual(['failure']);
    for (const c of ['structured_output', 'usage_report'])
      expect(entry(h.out, 'claude')?.capabilities[c]?.status, c).toBe(
        'unknown',
      );
    expect(readFileSync(h.ledger, 'utf8').trim().split('\n')).toHaveLength(1);
  }, 120_000);
});
