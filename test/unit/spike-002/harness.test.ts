import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  HarnessConfigSchema,
  SPIKE_BUDGET,
  checkConfig,
  fileSha256,
  readLedger,
  recordFinished,
  reserveBudget,
  runInvocation,
  type HarnessConfig,
} from '../../../scripts/spike-002/harness.ts';
import { createProbeFixture } from '../../../scripts/spike-002/sandbox.ts';

const templates = ['claude', 'codex'].map((v) =>
  HarnessConfigSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL(`../../../scripts/spike-002/config/${v}.template.json`, import.meta.url)), 'utf8'))),
);
const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-harness-unit-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function ready(over: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    schema_version: 1,
    vendor: 'claude',
    binary: { path: process.execPath, sha256: fileSha256(realpathSync(process.execPath)), version_argv: null, expected_version: null },
    model: 'model-from-owner-config',
    effort: null,
    argv: ['-p', '--json-schema', '{schema_inline}', '--model', '{model}'],
    role_args: {},
    prompt_via: 'stdin',
    result_source: { kind: 'stdout_json', pointer: ['structured_output'] },
    settings: null,
    auth_files: [],
    isolation: { requested_inner_mode: 'internal_required', owner_allows_external_verified: false, native_result: 'not_run', outer_proof_hash: null, permission_policy_hash: null },
    capabilities: {},
    wall_ms: 300_000,
    env: {},
    ...over,
  };
}

describe('spike-002 harness config policy', () => {
  it.each(templates.map((t) => [t.vendor, t] as const))('%s template is not ready until the owner pins binary and model', (_v, t) => {
    const r = checkConfig(t);
    expect(r.ready).toBe(false);
    expect(r.blockers).toEqual(expect.arrayContaining(['model is not configured (never defaulted)', 'binary.sha256 must be pinned']));
  });

  it('an explicit, pinned config is ready', () => {
    expect(checkConfig(ready())).toEqual({ ready: true, blockers: [] });
  });

  it.each([
    ['--dangerously-skip-permissions', { argv: ['-p', '{schema_inline}', '--dangerously-skip-permissions'] }],
    ['--allow-dangerously-skip-permissions', { argv: ['-p', '{schema_inline}', '--allow-dangerously-skip-permissions'] }],
    ['codex bypass flag', { argv: ['exec', '{schema_file}', '--dangerously-bypass-approvals-and-sandbox'] }],
    ['bypassPermissions in settings', { argv: ['{schema_inline}', '--settings', '{settings_file}'], settings: { file_name: 's.json', content: { permissions: { defaultMode: 'bypassPermissions' } } } }],
    ['bypass in role args', { role_args: { coder: ['--yolo'] } }],
  ])('rejects permission bypass: %s', (_name, over) => {
    const r = checkConfig(ready(over));
    expect(r.ready).toBe(false);
    expect(r.blockers.some((b) => b.startsWith('permission bypass'))).toBe(true);
  });

  it.each([
    ['schema not passed', { argv: ['-p'] }, /schema acceptance/],
    ['file result without output path', { argv: ['{schema_file}'], result_source: { kind: 'file' } }, /output_file/],
    ['unknown placeholder', { argv: ['{schema_file}', '{api_key}'] }, /unknown placeholder/],
    ['wall cap above 5 minutes', { wall_ms: 600_000 }, /spike cap/],
    ['proven without evidence', { capabilities: { native_inner_sandbox: { status: 'proven', evidence: null } } }, /without evidence/],
    ['auth through env', { env: { ANTHROPIC_API_KEY: 'x' } }, /private home/],
    ['auth file escaping home', { auth_files: [{ from: '/a/auth.json', to: '../auth.json' }] }, /inside the private home/],
  ])('rejects %s', (_name, over, pattern) => {
    const r = checkConfig(ready(over as Partial<HarnessConfig>));
    expect(r.ready).toBe(false);
    expect(r.blockers.join('\n')).toMatch(pattern);
  });

  it('refuses an inner sandbox switched off while internal_required', () => {
    const off = ready({ argv: ['{schema_inline}', '--settings', '{settings_file}'], settings: { file_name: 's.json', content: { sandbox: { enabled: false } } } });
    expect(checkConfig(off).blockers).toContain('inner sandbox disabled while internal_required');
    expect(checkConfig(ready({ argv: ['exec', '{schema_file}', '--sandbox', 'danger-full-access'] })).ready).toBe(false);
  });

  it('never selects external_verified unless every ADR-0003 condition is recorded', () => {
    const iso = { requested_inner_mode: 'external_verified' as const, owner_allows_external_verified: false, native_result: 'not_run' as const, outer_proof_hash: null, permission_policy_hash: null };
    const r = checkConfig(ready({ isolation: iso }));
    expect(r.blockers).toEqual(
      expect.arrayContaining([
        'external_verified not allowed by owner config',
        'external_verified requires a recorded native failure',
        'external_verified requires outer_proof_hash',
        'external_verified requires permission_policy_hash',
        'external_verified requires proven permission_denial_kept',
      ]),
    );
    const complete = ready({
      isolation: { requested_inner_mode: 'external_verified', owner_allows_external_verified: true, native_result: 'failed', outer_proof_hash: 'sha256:a', permission_policy_hash: 'sha256:b' },
      capabilities: { permission_denial_kept: { status: 'proven', evidence: 'test/fixtures/runtime/spike-0/host/x.json' } },
    });
    expect(checkConfig(complete).ready).toBe(true);
  });
});

describe('spike-002 shared spike budget ledger', () => {
  it(`allows exactly ${SPIKE_BUDGET.max_invocations} reservations and counts failures`, () => {
    const ledger = join(base, 'ledger.jsonl');
    for (let i = 0; i < SPIKE_BUDGET.max_invocations; i++) {
      reserveBudget(ledger, `a${i}`, i % 2 === 0 ? 'claude' : 'codex', 'coder', 300_000);
      recordFinished(ledger, `a${i}`, 'claude', 'coder', i === 0 ? 'spawn_failed/missing_output' : 'exited/valid');
    }
    expect(() => reserveBudget(ledger, 'a-extra', 'claude', 'reviewer', 1_000)).toThrow(/budget exhausted/);
    expect(readLedger(ledger).filter((e) => e.event === 'reserved')).toHaveLength(SPIKE_BUDGET.max_invocations);
  });

  it('rejects duplicate attempts and wall caps above 5 minutes', () => {
    const ledger = join(base, 'ledger2.jsonl');
    reserveBudget(ledger, 'b1', 'codex', 'fixer', 1_000);
    expect(() => reserveBudget(ledger, 'b1', 'codex', 'fixer', 1_000)).toThrow(/already reserved/);
    expect(() => reserveBudget(ledger, 'b2', 'codex', 'fixer', 300_001)).toThrow(/5 minutes/);
  });

  it('a paid vendor without --allow-paid is refused before any reservation or spawn', async () => {
    const fx = createProbeFixture(mkdtempSync(join(base, 'fx-')));
    const ledger = join(base, 'ledger3.jsonl');
    const r = await runInvocation(
      { config: ready(), role: 'coder', root: join(base, 'root'), attemptId: 'paid-1', worktree: fx.worktree, gitDirs: [fx.gitCommon], toolchain: [], prompt: 'p' },
      { ledger, allowPaid: false },
    );
    expect(r.refused).toBe('paid vendor requires --allow-paid');
    expect(readLedger(ledger)).toEqual([]);
    expect(r.exit).toBeNull();
  });
});
