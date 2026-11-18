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
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  PROOF_ROLES,
  proveHarness,
} from '../../../src/runner/harness-proof.ts';
import {
  harnessRecordProblems,
  harnessRecordProblem,
  hostSandbox,
  loadHarnessRecord,
  recordManifest,
} from '../../../src/runner/harness-records.ts';
import type { ProcessPort } from '../../../src/adapters/ports.ts';
import { deputyCheck } from '../../../src/application/doctor.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import { SystemdSupervisor } from '../../../src/runner/supervisor.ts';
import { homeFileContent, REAL } from '../../support/harness-fixtures.ts';
import { fakeVendorPin } from '../../support/runner-harness.ts';
import { copyPrompts, hostUsable, smokeUserConfig, SMOKE_CANARY } from '../../support/smoke.ts';

const RUNNER = fileURLToPath(new URL('../../../src/cli/cusr-runner.ts', import.meta.url));
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
    homeFileContent(h, JSON.stringify({ accessToken: SMOKE_CANARY })).replaceAll(
      '/cusr/scratch/',
      '',
    );
  const pin: VendorPin = {
    ...original,
    settings:
      vendor === 'claude'
        ? {
            ...original.settings,
            permissions: {
              ...(original.settings?.['permissions'] as Record<string, unknown>),
              deny: [`Bash(${DENIED_COMMAND})`],
            },
          }
        : null,
    home_files: original.home_files.map((h) =>
      h.sha256 === undefined ? h : { ...h, sha256: hashText(rules(h)).slice(7) },
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
  const budget = { approval: 'owner, test', maxInvocations: 5 };
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
      host_policy_hash: hostSandbox().policy_hash,
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
  it('reserves a sixth invocation for resume, for either vendor', async () => {
    const h = setup('claude');
    const refused = await proveHarness({
      ...h.options,
      proveResume: true,
      out: h.out,
      budget: h.budget,
    });
    expect(refusal(refused)).toContain('6 more exceed the cap');
    expect(existsSync(h.ledger)).toBe(false);
    const codex = setup('codex');
    expect(planProof({ ...codex.options, proveResume: true }).ok).toBe(true);
  });

  it('a dry run reports the plan and leaves no trace', () => {
    const h = setup('claude');
    const plan = planProof(h.options);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.value.invocations_spent).toBe(0);
    expect(existsSync(h.ledger)).toBe(false);
  });

  it('refuses before the first spawn without an approval or a cap for all five roles', async () => {
    const h = setup('claude');
    const none = await proveHarness({
      ...h.options,
      out: h.out,
      budget: { approval: ' ', maxInvocations: 5 },
    });
    expect(refusal(none)).toContain('approval');
    const low = await proveHarness({
      ...h.options,
      out: h.out,
      budget: { approval: 'owner', maxInvocations: 4 },
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
  it('records why a requested resume was not attempted after coder failure', async () => {
    const h = setup('claude', { FAKE_VENDOR_MODE: 'exit1' });
    const r = await proveHarness({
      ...h.options,
      proveResume: true,
      out: h.out,
      budget: { ...h.budget, maxInvocations: 6 },
    });
    expect(r.ok).toBe(true);
    const raw = readFileSync(h.out, 'utf8');
    expect(raw).toContain('coder failed: process_failed');
    expect(raw).not.toContain('this proof runs no resume');
  }, 120_000);

  it.each(
    (['claude', 'codex'] as const).flatMap((vendor) =>
      ['success', 'failure', 'no_session', 'missing'].map((mode) => [vendor, mode] as const),
    ),
  )(
    '%s: records the real resume probe outcome: %s',
    async (vendor, mode) => {
      const h = setup(vendor, {
        FAKE_VENDOR_INNER_SANDBOX: '1',
        FAKE_VENDOR_DENY_STDERR: '1',
        FAKE_VENDOR_RESUME: mode,
      });
      const r = await proveHarness({
        ...h.options,
        proveResume: true,
        out: h.out,
        budget: { ...h.budget, maxInvocations: 6 },
      });
      if (!r.ok) throw new Error(r.error);
      const raw = JSON.parse(readFileSync(h.out, 'utf8')) as {
        vendors: Record<
          string,
          {
            resume_probe: {
              attempt_id: string | null;
              reason: string;
              outcome?: { kind: string; resume_fallback?: string };
            };
            capabilities: Record<string, { status: string; evidence: string }>;
          }
        >;
      };
      const e = raw.vendors[vendor];
      if (e === undefined) throw new Error(`no ${vendor} evidence`);
      expect(e.capabilities['session_resume']?.status).toBe(
        mode === 'success' ? 'proven' : 'unknown',
      );
      if (mode === 'success') {
        expect(e.resume_probe.outcome?.kind).toBe('result');
        const seed = r.value.runs[0];
        if (seed === undefined) throw new Error('missing seed attempt');
        const launch = JSON.parse(
          readFileSync(join(h.options.dataDir, 'runs', seed.attempt_id, 'invocation.json'), 'utf8'),
        ) as { argv: string[] };
        expect(launch.argv).not.toContain('--no-session-persistence');
        expect(launch.argv).not.toContain('--ephemeral');
        const resumed = JSON.parse(
          readFileSync(
            join(h.options.dataDir, 'runs', String(e.resume_probe.attempt_id), 'invocation.json'),
            'utf8',
          ),
        ) as { argv: string[] };
        expect(resumed.argv.join(' ')).toContain(vendor === 'claude' ? '--resume ' : ' resume ');
        expect(h.record().ok).toBe(true);
        expect(h.problem()).toBeNull();
      }
      if (mode === 'failure')
        expect(e.resume_probe.reason).toContain('fixture resume service unavailable');
      if (mode === 'no_session') {
        expect(e.resume_probe.attempt_id).toBeNull();
        expect(e.resume_probe.reason).toContain('no session reference');
      }
      if (mode === 'missing')
        expect(e.resume_probe.outcome?.resume_fallback).toBe('session_missing');
      if (mode !== 'success')
        expect(e.capabilities['session_resume']?.evidence).not.toContain(
          'this proof runs no resume',
        );
    },
    120_000,
  );

  it.each(['claude', 'codex'] as const)(
    '%s: five roles, evidence record-manifest takes, a record that holds',
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
        ['decider', 'result'],
        ['deputy', 'turn_ended'],
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
        'schema_acceptance_decider',
        'schema_acceptance_deputy',
      ])
        expect(e?.capabilities[c]?.status, c).toBe('proven');
      expect(e?.capabilities['session_resume']?.status).toBe('unknown');
      const recorded = h.record();
      if (!recorded.ok) throw new Error(recorded.error);
      expect(h.problem()).toBeNull();
      expect(readFileSync(h.out, 'utf8')).not.toContain(SMOKE_CANARY);
      expect(readFileSync(h.ledger, 'utf8').trim().split('\n')).toHaveLength(5);

      // A failed manifest write can be retried without pin flags, approval, or another model invocation.
      const manifestPath = join(h.options.dataDir, 'harnesses', vendor, 'manifest.json');
      const ledgerBefore = readFileSync(h.ledger, 'utf8');
      const pinPath = join(h.options.dataDir, 'harnesses', vendor, 'pin.json');
      const pinBefore = readFileSync(pinPath, 'utf8');
      rmSync(manifestPath);
      const retry = (...extra: string[]) => {
        const cli = spawnSync(
          process.execPath,
          [
            RUNNER,
            'setup-harness',
            '--json',
            '--from',
            'record-manifest',
            '--config',
            h.options.configPath,
            '--data-dir',
            h.options.dataDir,
            '--harness',
            vendor,
            '--out',
            h.out,
            ...extra,
          ],
          { encoding: 'utf8' },
        );
        return { code: cli.status, body: JSON.parse(cli.stdout) as unknown };
      };
      expect(retry('--dry-run')).toMatchObject({
        code: 0,
        body: { data: { invocations_needed: 0, pin_exists: true } },
      });
      expect(existsSync(manifestPath)).toBe(false);
      expect(retry()).toMatchObject({ code: 0, body: { ok: true } });
      expect(h.problem()).toBeNull();
      const manifestBefore = readFileSync(manifestPath, 'utf8');
      writeFileSync(h.out, '{}');
      expect(retry()).toMatchObject({
        code: 1,
        body: {
          error: {
            code: 'manifest_refused',
            details: { step: 'record-manifest' },
          },
        },
      });
      expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
      expect(readFileSync(pinPath, 'utf8')).toBe(pinBefore);
      expect(readFileSync(h.ledger, 'utf8')).toBe(ledgerBefore);

      // The next proof of this binary counts the four already spent.
      const again = await proveHarness({
        ...h.options,
        out: h.out,
        budget: h.budget,
      });
      expect(refusal(again)).toContain('exceed the cap');
    },
    120_000,
  );

  it.each([
    ['claude', true],
    ['codex', false],
  ] as const)(
    '%s: TMPDIR follows what the adapter asks for and is gone after the run',
    async (vendor, short) => {
      const h = setup(vendor);
      const r = await proveHarness({
        ...h.options,
        out: h.out,
        budget: h.budget,
      });
      if (!r.ok) throw new Error(r.error);
      expect(r.value.failures).toEqual([]);
      for (const { attempt_id } of r.value.runs) {
        const run = join(h.options.dataDir, 'runs', attempt_id);
        const { env } = JSON.parse(readFileSync(join(run, 'invocation.json'), 'utf8')) as {
          env: Record<string, string>;
        };
        const tmp = env['TMPDIR'] as string;
        if (!short) {
          expect(tmp).toBe(join(run, 'scratch'));
          continue;
        }
        expect(tmp.length).toBeLessThan(40);
        expect(existsSync(tmp)).toBe(false);
        expect(readFileSync(join(run, 'context', 'claude-settings.json'), 'utf8')).toContain(tmp);
      }
    },
    120_000,
  );

  it('a proof without a usable result names why, and its evidence is refused', async () => {
    const h = setup('codex', {});
    const r = await proveHarness({
      ...h.options,
      out: h.out,
      budget: h.budget,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.failures.join('; ')).toContain('native sandbox refusal');
    expect(refusal(h.record())).toContain('does not make a usable manifest');
    expect(
      harnessRecordProblems({
        dataDir: h.options.dataDir,
        harnesses: ['codex'],
        runtime: h.options.runtime,
      }).map((p) => p.harness),
    ).toEqual(['codex']);
  });

  it('Codex proves the sandbox directly when its stream hides the refused command', async () => {
    const h = setup('codex', {
      FAKE_VENDOR_INNER_SANDBOX: '1',
      FAKE_VENDOR_DENY_STDERR: '1',
      FAKE_VENDOR_HIDE_REFUSAL: '1',
    });
    const r = await proveHarness({
      ...h.options,
      out: h.out,
      budget: h.budget,
    });
    expect(r.ok).toBe(true);
    expect(entry(h.out, 'codex')?.native_result).toBe('passed');
  });

  it('no inner sandbox and no refusal: both stay unproven and the evidence is refused', async () => {
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
    expect(refusal(h.record())).toMatch(/permission_enforced|native sandbox/);
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
      'result',
      'turn_ended',
    ]);
    // Only the decider keeps the read-only boundary with its own native sandbox; the reviewer works
    // and the deputy like a fixer.
    expect(r.value.runs.map((x) => x.native_write_blocked)).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(entry(h.out, 'claude')?.native_result).toBe('not_tried');
    expect(entry(h.out, 'claude')?.capabilities['permission_denial_kept']?.status).toBe('proven');
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
        'result',
        'turn_ended',
      ]);
      expect(entry(h.out, vendor)?.capabilities['permission_denial_kept']?.status).toBe('proven');
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
      expect(entry(h.out, vendor)?.capabilities['permission_denial_kept']?.status).toBe('unknown');
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
      expect(entry(h.out, 'claude')?.capabilities[c]?.status, c).toBe('unknown');
    expect(readFileSync(h.ledger, 'utf8').trim().split('\n')).toHaveLength(1);
  }, 120_000);
});

type Evidence = {
  vendors: Record<
    string,
    {
      role_schemas: Record<string, { digest: string }>;
      capabilities: Record<string, { status: string; evidence: string }>;
      runs: Record<string, unknown>[];
    }
  >;
};

describe.skipIf(!hostUsable())('a later proof reuses role runs that still hold (#316)', () => {
  const edit = (out: string, vendor: string, f: (e: Evidence['vendors'][string]) => void) => {
    const raw = JSON.parse(readFileSync(out, 'utf8')) as Evidence;
    const e = raw.vendors[vendor];
    if (e === undefined) throw new Error(`no ${vendor} evidence`);
    f(e);
    writeFileSync(out, JSON.stringify(raw));
  };
  const planned = (h: ReturnType<typeof setup>) => {
    const p = planProof({ ...h.options, out: h.out });
    if (!p.ok) throw new Error(p.error);
    return { roles: p.value.roles, reused: p.value.reused.map((r) => r.role) };
  };

  it('adding deputy to a harness proven without it runs only the deputy role', async () => {
    const h = setup('claude');
    const first = await proveHarness({ ...h.options, out: h.out, budget: h.budget });
    if (!first.ok) throw new Error(first.error);
    const before = first.value.runs.slice(0, 4).map((r) => r.attempt_id);
    // Evidence as an earlier release wrote it: four roles, no per-run checks.
    edit(h.out, 'claude', (e) => {
      e.runs = e.runs
        .filter((r) => r['role'] !== 'deputy')
        .map(({ role, attempt_id, kind, native_write_blocked }) => ({
          role,
          attempt_id,
          kind,
          native_write_blocked,
        }));
      e.capabilities['schema_acceptance_deputy'] = { status: 'unknown', evidence: 'none' };
    });
    expect(planned(h)).toEqual({
      roles: ['deputy'],
      reused: ['coder', 'fixer', 'reviewer', 'decider'],
    });
    // The command doctor prints for this store runs as printed and proves only deputy.
    const legacy = h.record();
    if (!legacy.ok) throw new Error(legacy.error);
    expect(legacy.value.role_schemas['deputy']).toBeUndefined();
    const fix = deputyCheck(
      {
        roles: { deputy: { binding: [{ model: 'proof' }] } },
        models: { proof: { harness: 'claude', id: 'proof-model' } },
      } as never,
      { claude: legacy.value },
      new Set(),
      { config: h.options.configPath, dataDir: h.options.dataDir },
    ).fix;
    const line = fix?.split('\n')[0] ?? '';
    expect(line).toMatch(/^cusr-runner setup-harness --from prove-harness .* --out \S+$/);
    const printed = spawnSync(
      'sh',
      [
        '-c',
        `"$0" "$1" ${line.replace(/^cusr-runner /, '')} --dry-run --json`,
        process.execPath,
        RUNNER,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(printed.stdout)).toMatchObject({
      ok: true,
      data: { roles_to_prove: ['deputy'] },
    });

    const preview = spawnSync(
      process.execPath,
      [
        RUNNER,
        'setup-harness',
        '--json',
        '--dry-run',
        '--from',
        'prove-harness',
        '--config',
        h.options.configPath,
        '--data-dir',
        h.options.dataDir,
        '--harness',
        'claude',
        '--model',
        'proof-model',
        '--out',
        h.out,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(preview.stdout)).toMatchObject({
      ok: true,
      data: {
        invocations_needed: 1,
        roles_to_prove: ['deputy'],
        roles_reused: ['coder', 'fixer', 'reviewer', 'decider'],
      },
    });

    const r = await proveHarness({
      ...h.options,
      out: h.out,
      budget: { ...h.budget, maxInvocations: 6 },
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.failures).toEqual([]);
    expect(r.value.runs.map((x) => [x.role, x.outcome.kind])).toEqual([['deputy', 'turn_ended']]);
    expect(r.value.reused.map((x) => x.attempt_id)).toEqual(before);
    expect(readFileSync(h.ledger, 'utf8').trim().split('\n')).toHaveLength(6);
    const e = entry(h.out, 'claude');
    for (const c of ['structured_output', 'permission_denial_kept', 'private_home_auth'])
      expect(e?.capabilities[c]?.status, c).toBe('proven');
    expect(e?.capabilities['schema_acceptance_deputy']?.status).toBe('proven');
    const recorded = h.record();
    if (!recorded.ok) throw new Error(recorded.error);
    expect(recorded.value.role_schemas['deputy']).toBeDefined();
    expect(h.problem()).toBeNull();

    // Nothing left to prove: no spawn, nothing spent, the evidence still makes the same manifest.
    const again = await proveHarness({ ...h.options, out: h.out, budget: h.budget });
    if (!again.ok) throw new Error(again.error);
    expect(again.value.runs).toEqual([]);
    expect(again.value.failures).toEqual([]);
    expect(readFileSync(h.ledger, 'utf8').trim().split('\n')).toHaveLength(6);
    expect(h.record().ok).toBe(true);
  }, 120_000);

  it('proves again a role that failed or changed, and every role for another binary or pin', async () => {
    const h = setup('codex');
    const first = await proveHarness({ ...h.options, out: h.out, budget: h.budget });
    if (!first.ok) throw new Error(first.error);
    expect(planned(h).roles).toEqual([]);
    const saved = readFileSync(h.out, 'utf8');

    edit(h.out, 'codex', (e) => {
      const deputy = e.runs.find((r) => r['role'] === 'deputy');
      if (deputy !== undefined) Object.assign(deputy, { kind: 'failure', valid: false });
      const fixer = e.runs.find((r) => r['role'] === 'fixer');
      if (fixer !== undefined) fixer['native_write_blocked'] = false;
      e.role_schemas['coder'] = { digest: 'sha256:old' };
    });
    expect(planned(h).roles).toEqual(['coder', 'fixer', 'deputy']);

    writeFileSync(h.out, '{not json');
    expect(planned(h).roles).toHaveLength(5);

    writeFileSync(h.out, saved);
    const pinFile = join(h.options.dataDir, 'harnesses', 'codex', 'pin.json');
    const pin = JSON.parse(readFileSync(pinFile, 'utf8')) as VendorPin;
    writeFileSync(pinFile, JSON.stringify({ ...pin, env: { ...pin.env, FAKE_VENDOR_X: '1' } }));
    expect(planned(h)).toEqual({ roles: [...PROOF_ROLES], reused: [] });

    const moved = `${pin.binary.realpath}.next.js`;
    writeFileSync(moved, `${readFileSync(pin.binary.realpath, 'utf8')}\n// next\n`, {
      mode: 0o755,
    });
    writeFileSync(
      pinFile,
      JSON.stringify({
        ...pin,
        binary: {
          ...pin.binary,
          realpath: moved,
          sha256: createHash('sha256').update(readFileSync(moved)).digest('hex'),
        },
      }),
    );
    expect(planned(h)).toEqual({ roles: [...PROOF_ROLES], reused: [] });
  }, 120_000);

  it('judges each role on its own, against the same rules as the recorder (R1, R3)', async () => {
    const h = setup('claude');
    const first = await proveHarness({ ...h.options, out: h.out, budget: h.budget });
    if (!first.ok) throw new Error(first.error);
    const saved = readFileSync(h.out, 'utf8');
    const reset = () => writeFileSync(h.out, saved);
    const row = (e: Evidence['vendors'][string], role: string) => {
      const r = e.runs.find((x) => x['role'] === role);
      if (r === undefined) throw new Error(`no ${role} run`);
      return r;
    };

    // A failed outcome keeps no role, whatever its other checks claim.
    edit(h.out, 'claude', (e) => {
      Object.assign(row(e, 'deputy'), { kind: 'failure', failure: 'process_failed' });
    });
    expect(planned(h).roles).toEqual(['deputy']);

    // A legacy row with an empty attempt id matches no verdict.
    reset();
    edit(h.out, 'claude', (e) => {
      e.runs = e.runs.map(({ role, attempt_id, kind, native_write_blocked }) => ({
        role,
        attempt_id: role === 'fixer' ? '' : attempt_id,
        kind,
        native_write_blocked,
      }));
    });
    expect(planned(h).roles).toEqual(['fixer']);

    // A verdict that names another attempt does not prove this one.
    reset();
    edit(h.out, 'claude', (e) => {
      e.capabilities['schema_acceptance_reviewer'] = {
        status: 'proven',
        evidence: 'valid result: 00000000-0000-4000-8000-000000000000',
      };
    });
    expect(planned(h).roles).toEqual(['reviewer']);

    // A result kind its role never returns proves nothing for that role.
    reset();
    edit(h.out, 'claude', (e) => {
      row(e, 'coder')['kind'] = 'turn_ended';
      row(e, 'deputy')['kind'] = 'result';
    });
    expect(planned(h).roles).toEqual(['coder', 'deputy']);

    // A null row is skipped; a malformed duplicate still makes its role ambiguous.
    reset();
    edit(h.out, 'claude', (e) => {
      e.runs = e.runs.map((r) => (r['role'] === 'deputy' ? null : r)) as typeof e.runs;
      e.runs.push({ role: 'fixer', attempt_id: 'not-a-uuid' });
    });
    expect(planned(h)).toEqual({
      roles: ['fixer', 'deputy'],
      reused: ['coder', 'reviewer', 'decider'],
    });

    // Evidence the recorder would refuse reuses nothing.
    reset();
    edit(h.out, 'claude', (e) => {
      (e as unknown as Record<string, unknown>)['isolation_mode'] = 'isolated';
    });
    expect(planned(h).roles).toHaveLength(5);
    expect(refusal(h.record())).toContain('native host execution');

    // One malformed row or an unrelated malformed entry costs only what it touches.
    reset();
    edit(h.out, 'claude', (e) => {
      row(e, 'deputy')['valid'] = 'yes';
      (e as unknown as Record<string, unknown>)['resume_probe'] = { remembered: 'maybe' };
    });
    const raw = JSON.parse(readFileSync(h.out, 'utf8')) as Evidence;
    writeFileSync(h.out, JSON.stringify({ ...raw, vendors: { ...raw.vendors, codex: 7 } }));
    expect(planned(h)).toEqual({
      roles: ['deputy'],
      reused: ['coder', 'fixer', 'reviewer', 'decider'],
    });
  }, 120_000);

  it('keeps a completed role on disk when a later launch throws (R2)', async () => {
    const h = setup('claude');
    const real = new SystemdSupervisor({
      dataDir: h.options.dataDir,
      runnerCommand: h.options.runnerCommand,
      redactor: new Redactor({ values: [] }),
    });
    let launches = 0;
    const process: ProcessPort = {
      launch: (spec) =>
        ++launches === 2
          ? Promise.resolve({ ok: false, error: { code: 'unknown', message: 'lost observation' } })
          : real.launch(spec),
      inspect: (id) => real.inspect(id),
      stop: (id, o) => real.stop(id, o),
    };
    await expect(
      proveHarness({ ...h.options, process, out: h.out, budget: h.budget }),
    ).rejects.toThrow('lost observation');
    expect(readFileSync(h.ledger, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(planned(h)).toEqual({
      roles: ['fixer', 'reviewer', 'decider', 'deputy'],
      reused: ['coder'],
    });
  }, 120_000);

  it('carries a resume probe only with its coder, its continuation and a verdict naming it (R4)', async () => {
    const h = setup('codex', {
      FAKE_VENDOR_INNER_SANDBOX: '1',
      FAKE_VENDOR_DENY_STDERR: '1',
      FAKE_VENDOR_RESUME: 'success',
    });
    const r = await proveHarness({
      ...h.options,
      proveResume: true,
      out: h.out,
      budget: { ...h.budget, maxInvocations: 6 },
    });
    if (!r.ok) throw new Error(r.error);
    const resumed = () => {
      const p = planProof({ ...h.options, out: h.out });
      if (!p.ok) throw new Error(p.error);
      return p.value.reused_resume?.remembered === true;
    };
    expect(planned(h).roles).toEqual([]);
    expect(resumed()).toBe(true);
    // Nothing to prove: the proof keeps the probe, and the manifest keeps resume.
    const again = await proveHarness({ ...h.options, out: h.out, budget: h.budget });
    if (!again.ok) throw new Error(again.error);
    expect(entry(h.out, 'codex')?.capabilities['session_resume']?.status).toBe('proven');
    const recorded = h.record();
    if (!recorded.ok) throw new Error(recorded.error);
    expect(recorded.value.capabilities.resume).toBe('proven');
    const saved = readFileSync(h.out, 'utf8');

    edit(h.out, 'codex', (e) => {
      (e as unknown as { resume_probe: Record<string, unknown> }).resume_probe['attempt_id'] = null;
    });
    expect(resumed()).toBe(false);
    writeFileSync(h.out, saved);
    edit(h.out, 'codex', (e) => {
      e.capabilities['session_resume'] = { status: 'unknown', evidence: 'not shown' };
    });
    expect(resumed()).toBe(false);
    writeFileSync(h.out, saved);
    edit(h.out, 'codex', (e) => {
      e.role_schemas['fixer'] = { digest: 'sha256:old' };
    });
    expect(resumed()).toBe(false);
    writeFileSync(h.out, saved);
    edit(h.out, 'codex', (e) => {
      (e as unknown as { resume_probe: Record<string, unknown> }).resume_probe['seed_attempt_id'] =
        '00000000-0000-4000-8000-000000000000';
    });
    expect(resumed()).toBe(false);
    writeFileSync(h.out, saved);
    edit(h.out, 'codex', (e) => {
      (e as unknown as { resume_probe: Record<string, unknown> }).resume_probe['outcome'] = {
        kind: 'failure',
        failure: 'process_failed',
      };
    });
    expect(resumed()).toBe(false);
    writeFileSync(h.out, saved);
    edit(h.out, 'codex', (e) => {
      const probe = (e as unknown as { resume_probe: { outcome: Record<string, unknown> } })
        .resume_probe;
      probe.outcome['resume_fallback'] = 'session_missing';
    });
    expect(resumed()).toBe(false);
    writeFileSync(h.out, saved);
    edit(h.out, 'codex', (e) => {
      const probe = (e as unknown as { resume_probe: { outcome: Record<string, unknown> } })
        .resume_probe;
      expect(probe.outcome['session_ref']).toEqual(expect.any(String));
      probe.outcome['session_ref'] = null;
    });
    expect(resumed()).toBe(false);
    // A probe written before it named its seed still counts with the coder of the same evidence.
    writeFileSync(h.out, saved);
    edit(h.out, 'codex', (e) => {
      delete (e as unknown as { resume_probe: Record<string, unknown> }).resume_probe[
        'seed_attempt_id'
      ];
    });
    expect(resumed()).toBe(true);
  }, 120_000);
});
