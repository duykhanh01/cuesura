import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  HarnessConfigSchema,
  SPIKE_BUDGET,
  checkConfig,
  fileSha256,
  materialize,
  normalizeResult,
  planInvocation,
  readLedger,
  recordFinished,
  reserveBudget,
  runInvocation,
  type HarnessConfig,
} from '../../../scripts/spike-002/harness.ts';
import { createProbeFixture } from '../../../scripts/spike-002/sandbox.ts';
import { ROLES, roleJsonSchema, roleSchemaDigest } from '../../../scripts/spike-002/role-schema.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';
import { type ExitRecord } from '../../../scripts/spike-002/runner.ts';
import { recordedCodexStderr } from '../../support/spike-stderr.ts';
import { summarizeStream } from '../../../scripts/spike-002/harness-stream.ts';

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

  it.each(ROLES)('Claude %s transmits the same closed schema without the unsupported dialect declaration', (role) => {
    const fx = createProbeFixture(mkdtempSync(join(base, `schema-${role}-`)));
    const config = ready();
    const plan = planInvocation({ config, role, root: join(base, `schema-root-${role}`), attemptId: `schema-${role}`, worktree: fx.worktree, gitDirs: [fx.gitCommon], toolchain: [], prompt: 'local fixture' });
    materialize(plan, config, role, 'local fixture');
    const expected = roleJsonSchema(role);
    delete expected['$schema'];
    const wire = JSON.parse(readFileSync(plan.files.schema, 'utf8')) as unknown;
    expect(wire).toEqual(expected);
    expect(JSON.parse(plan.harness_argv[plan.harness_argv.indexOf('--json-schema') + 1] ?? '')).toEqual(expected);
    expect(plan.manifest['schema']).toMatchObject({ digest: roleSchemaDigest(role), wire_digest: hashCanonical(expected) });
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
  it('an explicit owner-approved extension keeps the original six reservations and stops at eight', () => {
    const ledger = join(base, 'owner-extension.jsonl');
    for (let i = 0; i < 6; i++) reserveBudget(ledger, `original-${i}`, 'codex', 'coder', 300_000);
    expect(() => reserveBudget(ledger, 'extra-1', 'claude', 'fixer', 300_000)).toThrow(/budget exhausted/);
    reserveBudget(ledger, 'extra-1', 'claude', 'fixer', 300_000, 8);
    reserveBudget(ledger, 'extra-2', 'codex', 'fixer', 300_000, 8);
    expect(readLedger(ledger)).toHaveLength(8);
    expect(readLedger(ledger)[6]).toMatchObject({ approved_max_invocations: 8 });
    expect(() => reserveBudget(ledger, 'extra-3', 'codex', 'fixer', 300_000, 8)).toThrow(/budget exhausted/);
    expect(() => reserveBudget(ledger, 'invalid', 'codex', 'fixer', 300_000, Number.NaN)).toThrow(/positive safe integer/);
  });

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

describe('spike-002 result stream facts for every outcome', () => {
  let serial = 0;
  function planned(config: HarnessConfig): ReturnType<typeof planInvocation> {
    const fx = createProbeFixture(mkdtempSync(join(base, 'normalize-')));
    return planInvocation({ config, role: 'coder', root: join(base, 'normalize-root'), attemptId: `normalize-${serial++}`, worktree: fx.worktree, gitDirs: [fx.gitCommon], toolchain: [], prompt: 'p' });
  }
  const exited = (code: number, outcome: ExitRecord['outcome'] = 'exited'): ExitRecord => ({
    schema_version: 1, operation_id: 'op-normalize', attempt_id: 'normalize', launch_nonce: 'nonce',
    started_at: new Date().toISOString(), ended_at: new Date().toISOString(), outcome, exit_code: code,
    signal: null, error: null, usage: { status: 'unavailable', reason: 'runner' },
    duration_ms: 1,
    termination: { term_sent: false, kill_sent: false, group_empty_verified: true, descendant_scope: 'process_group_only', descendants_killed: 0 },
    artifacts: { events: { records: 0, bytes: 0, generations: 0, truncated_records: 0 }, stderr: { bytes: 0, digest: '' } },
  });

  it.each(['present', 'missing', 'timeout'] as const)('retains vendor failure, usage and denials with %s output', (output) => {
    const config = ready({ vendor: 'codex', result_source: { kind: 'file' }, argv: ['{schema_file}', '{output_file}'] });
    const plan = planned(config);
    const events = [{ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }, { type: 'turn.failed', error: { message: '429 Too Many Requests' } }];
    writeFileSync(join(plan.run_dir, 'events.jsonl'), events.map((data) => JSON.stringify({ data })).join('\n'));
    const stderr = recordedCodexStderr('s0-codex-fixer-1793173505');
    writeFileSync(join(plan.run_dir, 'stderr.log'), stderr);
    if (output === 'present') writeFileSync(plan.files.output, JSON.stringify({ schema_version: 1, status: 'done', summary: 'ok', questions: [], blocker: null }));
    const r = normalizeResult(plan, config, 'coder', exited(1, output === 'timeout' ? 'timeout' : 'exited'), false);
    expect(r.status).toBe(output === 'timeout' ? 'timeout' : 'process_failed');
    expect(r.stream.failure?.kind).toBe('rate_limited');
    expect(r.stream.usage).toMatchObject({ status: 'reported', input_tokens: 10, output_tokens: 2 });
    expect(r.stream.permission_denials.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(plan.run_dir, 'out', 'stream-summary.json'), 'utf8'))).toEqual(r.stream);
  });

  it('summarizes rotated Claude records in generation order before the active final result', () => {
    const config = ready();
    const plan = planned(config);
    const events = readFileSync(fileURLToPath(new URL('../../fixtures/runtime/spike-0/harness/real-20261028/s0-claude-fixer-1793173414/events.jsonl', import.meta.url)), 'utf8');
    const lines = events.trimEnd().split('\n');
    const split = lines.findIndex((line) => (JSON.parse(line) as { data: { type: string } }).data.type === 'result');
    expect(split).toBeGreaterThan(0);
    const cut = Math.floor(split / 2);
    writeFileSync(join(plan.run_dir, 'spool', 'events.000000.jsonl'), lines.slice(0, cut).join('\n'));
    writeFileSync(join(plan.run_dir, 'spool', 'events.000001.jsonl'), lines.slice(cut, split).join('\n'));
    writeFileSync(join(plan.run_dir, 'events.jsonl'), lines.slice(split).join('\n'));
    const r = normalizeResult(plan, config, 'coder', exited(1), false);
    expect(r.stream).toEqual(summarizeStream('claude', events, ''));
    expect(r.stream.rate_limit?.status).toBe('allowed');
    expect(r.stream.permission_denials).toHaveLength(1);
  });
});
