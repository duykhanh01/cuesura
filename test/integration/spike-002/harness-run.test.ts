import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { planInvocation, readLedger, runInvocation, type HarnessConfig, type PlanInput } from '../../../scripts/spike-002/harness.ts';
import { roleSchemaDigest } from '../../../scripts/spike-002/role-schema.ts';
import { bwrapUsable, createProbeFixture } from '../../../scripts/spike-002/sandbox.ts';

// End-to-end through real bwrap + runner with the local fixture vendor. No model, no network.
const bwrap = bwrapUsable();
const FAKE = fileURLToPath(new URL('../../fixtures/runtime/spike-0/bin/fake-harness.js', import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-harness-run-')));
const fx = createProbeFixture(mkdtempSync(join(base, 'fx-')));
const root = join(base, 'data');
const ledger = join(base, 'ledger.jsonl');
afterAll(() => rmSync(base, { recursive: true, force: true }));

const DONE = JSON.stringify({ schema_version: 1, status: 'done', summary: 'Implemented', questions: [], blocker: null });

function fixtureConfig(args: string[], over: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    schema_version: 1,
    vendor: 'fixture',
    binary: { path: realpathSync(process.execPath), sha256: null, version_argv: null, expected_version: null },
    model: null,
    effort: null,
    argv: [FAKE, ...args, '{schema_file}', '{output_file}'],
    role_args: {},
    prompt_via: 'stdin',
    result_source: { kind: 'file' },
    settings: null,
    auth_files: [],
    isolation: { requested_inner_mode: 'internal_required', owner_allows_external_verified: false, native_result: 'not_run', outer_proof_hash: null, permission_policy_hash: null },
    capabilities: {},
    wall_ms: 30_000,
    env: {},
    ...over,
  };
}

let n = 0;
function input(config: HarnessConfig, role: PlanInput['role'] = 'coder'): PlanInput {
  n++;
  return { config, role, root, attemptId: `fx-${n}`, worktree: fx.worktree, gitDirs: [fx.gitCommon], toolchain: [dirname(FAKE)], prompt: 'Do the fixture task.' };
}

describe.skipIf(!bwrap.usable)('spike-002 harness run with the fixture vendor (never touches the paid ledger)', () => {
  it('validates a fresh per-attempt result and attaches provenance from runner files', async () => {
    const r = await runInvocation(input(fixtureConfig(['result', '{output_file}', DONE])), { ledger, allowPaid: false });
    expect(r.refused).toBeNull();
    expect(r.result?.status).toBe('valid');
    const out = JSON.parse(readFileSync(r.result?.result_path ?? '', 'utf8')) as { provenance: Record<string, unknown>; value: unknown };
    const launch = JSON.parse(readFileSync(join(r.plan.run_dir, 'launch.json'), 'utf8')) as { nonce: string };
    expect(out.provenance).toMatchObject({ launch_nonce: launch.nonce, schema_digest: roleSchemaDigest('coder'), role: 'coder', vendor: 'fixture', usage: { status: 'unavailable' } });
    expect(out.value).toEqual(JSON.parse(DONE));
    expect(r.plan.manifest['proven']).toBe(false);
    expect(readLedger(ledger)).toEqual([]);
  });

  it('schema files reach the harness read-only and the private home holds only selected auth', async () => {
    const auth = join(base, 'auth.json');
    writeFileSync(auth, JSON.stringify({ token: 'fixture-token-value-0123456789' }));
    const r = await runInvocation(
      input(fixtureConfig(['result', '{output_file}', DONE], { auth_files: [{ from: auth, to: '.vendor/auth.json' }] })),
      { ledger, allowPaid: false },
    );
    expect(r.result?.status).toBe('valid');
    expect(existsSync(join(r.plan.run_dir, 'private-home', '.vendor', 'auth.json'))).toBe(true);
    const logs = ['invocation.json', 'events.jsonl', 'exit.json'].map((f) => readFileSync(join(r.plan.run_dir, f), 'utf8')).join('');
    expect(logs).not.toContain('fixture-token-value-0123456789');
  });

  it.each([
    ['schema-invalid output', ['result', '{output_file}', '{"schema_version":1,"status":"done"}'], 'invalid_output'],
    ['semantically invalid output', ['result', '{output_file}', JSON.stringify({ schema_version: 1, status: 'done', summary: 'x', questions: [], blocker: 'b' })], 'invalid_output'],
    ['truncated output', ['result', '{output_file}', '{"schema_version":1,"sta'], 'invalid_output'],
    ['no output at all', ['echo', '1'], 'missing_output'],
    ['valid output from a failed process', ['result-exit', '{output_file}', DONE, '3'], 'process_failed'],
    ['a crashing process without output', ['exit', '3'], 'process_failed'],
  ])('%s is never accepted as done', async (_name, args, status) => {
    const r = await runInvocation(input(fixtureConfig(args)), { ledger, allowPaid: false });
    expect(r.result?.status).toBe(status);
    expect(existsSync(join(r.plan.run_dir, 'out', 'result.json'))).toBe(false);
  });

  it('rejects a stale result file that existed before launch', async () => {
    const inp = input(fixtureConfig(['echo', '1']));
    const plan = planInvocation(inp);
    writeFileSync(plan.files.output, DONE);
    const r = await runInvocation(inp, { ledger, allowPaid: false });
    expect(r.result).toMatchObject({ status: 'invalid_output', issues: ['output path existed before launch (stale result)'] });
  });

  it('reads a reviewer result from the final stdout record when configured', async () => {
    const verdict = JSON.stringify({ schema_version: 1, verdict: 'approve', summary: 'ok', findings: [] });
    const cfg = fixtureConfig(['stdout-result', JSON.stringify({ structured_output: verdict })], { result_source: { kind: 'stdout_json', pointer: ['structured_output'] } });
    const r = await runInvocation(input(cfg, 'reviewer'), { ledger, allowPaid: false });
    expect(r.result?.status).toBe('valid');
  });

  it('enforces the configured wall deadline as timeout', async () => {
    const r = await runInvocation(input(fixtureConfig(['sleep', '60000'], { wall_ms: 500 })), { ledger, allowPaid: false });
    expect(r.exit?.outcome).toBe('timeout');
    expect(r.result?.status).toBe('timeout');
  });

  it('refuses to relaunch an attempt whose marker exists', async () => {
    const inp = input(fixtureConfig(['result', '{output_file}', DONE]));
    await runInvocation(inp, { ledger, allowPaid: false });
    const again = await runInvocation(inp, { ledger, allowPaid: false });
    expect(again.refused).toMatch(/already launched/);
  });
});
