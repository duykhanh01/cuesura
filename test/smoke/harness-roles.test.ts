/**
 * T122 (SC-008): three roles on two vendors. Locally, the pinned adapters run each role's recorded T007
 * output inside a real task: right role and vendor, usage and provenance reported, reviewer read-only and
 * the auth canary nowhere the daemon keeps. That checks the setup before a paid invocation and
 * is not SC-008 evidence. The real invocations of T126 were run by `cusr-runner prove-harness`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ROLE_SCHEMA_DIGESTS } from '../../src/adapters/harness/result-schema.ts';
import { readRealJson } from '../support/harness-fixtures.ts';
import { filesUnder, git, hostUsable, Rehearsal, SMOKE_CANARY } from '../support/smoke.ts';

const live: Rehearsal[] = [];
afterEach(async () => {
  for (const r of live.splice(0)) await r.cleanup();
});

const PROOF = fileURLToPath(
  new URL('../fixtures/runtime/spike-0/harness/proof-20261031/', import.meta.url),
);
const VENDORS = ['claude', 'codex'] as const;
const ROLES = ['coder', 'fixer', 'reviewer'] as const;

describe('the setup a paid invocation relies on', () => {
  it('has a recorded run and a current schema for each role on each vendor', () => {
    const evidence = readRealJson<{
      vendors: Record<string, { role_schemas: Record<string, { digest: string }> }>;
    }>('capability-manifest.json');
    for (const vendor of VENDORS)
      for (const role of ROLES)
        expect(evidence.vendors[vendor]?.role_schemas[role]?.digest, `${vendor} ${role}`).toBe(
          ROLE_SCHEMA_DIGESTS[role],
        );
  });

  it('does not treat the recorded evidence as proof of the binaries on this host', () => {
    const evidence = readRealJson<{
      vendors: Record<string, { binary: { sha256: string }; attested?: unknown }>;
    }>('capability-manifest.json');
    for (const vendor of VENDORS) expect(evidence.vendors[vendor]?.attested).toBeUndefined();
  });
});

describe.skipIf(!hostUsable())('local rehearsal of every role on every vendor', () => {
  it.each(VENDORS)(
    'workers on %s, reviewer on the other vendor',
    async (worker) => {
      const reviewer = worker === 'claude' ? 'codex' : 'claude';
      const r = new Rehearsal({
        kind: 'node',
        worker,
        mode: 'full-review',
        coder: 'fail',
        leakHome: true,
      });
      live.push(r);
      await r.startDaemon();
      const id = await r.addTask();
      const waiting = await r.untilMergeWait(id);

      const events = await r.history(id);
      const requested = events
        .filter((e) => e.type === 'AttemptRequested')
        .map((e) => e.payload as { step: string; binding: string });
      expect(requested.map((a) => [a.step, a.binding])).toEqual([
        ['code', `${worker}-worker/low`],
        ['fix_gates', `${worker}-worker/low`],
        ['review', `${reviewer}-worker/low`],
      ]);
      const usage = (waiting['provenance'] as { usage: unknown[] }).usage;
      expect(usage).toHaveLength(3);

      // The reviewer tried to write its worktree and the vendor stand-in ends the run if that landed.
      const head = waiting['head_sha'] as string;
      expect(git(r.remote, 'ls-tree', '-r', '--name-only', head)).not.toContain(
        'reviewer-wrote.txt',
      );

      // The vendor printed its private home on every run. Nothing the daemon keeps holds the auth.
      expect(SMOKE_CANARY).toBeTruthy();
      const leaks = filesUnder(r.dataDir).filter((f) =>
        readFileSync(join(r.dataDir, f)).includes(SMOKE_CANARY),
      );
      expect(leaks).toEqual([]);
      const logs = await r.cli('task', 'logs', id, '--after', '0');
      expect(JSON.stringify(logs.env)).toContain('[REDACTED');
    },
    180_000,
  );
});

// T126. The runs are recorded under PROOF; this checks what they showed, and proves nothing by running.
describe('the recorded real invocations of T126', () => {
  it.each(VENDORS)('%s: every role and capability the manifest needs', (vendor) => {
    const evidence = JSON.parse(readFileSync(join(PROOF, `evidence-${vendor}.json`), 'utf8')) as {
      vendors: Record<
        string,
        {
          native_result: string;
          attested?: unknown;
          capabilities: Record<string, { status: string }>;
          runs: { role: string; kind: string }[];
        }
      >;
    };
    const e = evidence.vendors[vendor];
    expect(e?.attested).toBeDefined();
    expect(e?.native_result).toBe('passed');
    expect(e?.runs.map((r) => [r.role, r.kind])).toEqual(ROLES.map((r) => [r, 'result']));
    for (const c of [
      'structured_output',
      'permission_denial_kept',
      'private_home_auth',
      'usage_report',
      ...ROLES.map((r) => `schema_acceptance_${r}`),
    ])
      expect(e?.capabilities[c]?.status, c).toBe('proven');
  });
});
