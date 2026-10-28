import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, HarnessConfigSchema, checkConfig } from '../../../scripts/spike-002/harness.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';

const dir = 'test/fixtures/runtime/spike-0/harness/real-20261028';
const read = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../${dir}/${name}`, import.meta.url)), 'utf8')) as unknown;

type Capability = { status: string; evidence: string | null };
type VendorManifest = { manifest_hash: string; pinned_config: string; capabilities: Record<string, Capability>; capability_missing: string[]; outer_proof_hash: string; permission_policy_hash: string };
const manifest = read('capability-manifest.json') as { vendors: Record<string, VendorManifest> };

describe('spike-002 T007 capability manifest', () => {
  it.each(['claude', 'codex'])('%s: manifest hash recomputes and pinned config is ready', (vendor) => {
    const entry = manifest.vendors[vendor];
    if (entry === undefined) throw new Error(`missing ${vendor}`);
    const { manifest_hash: hash, ...body } = entry;
    expect(hashCanonical(body)).toBe(hash);

    const pinned = HarnessConfigSchema.parse(read(entry.pinned_config.slice(dir.length + 1)));
    expect(checkConfig(pinned)).toEqual({ ready: true, blockers: [] });
    expect(pinned.capabilities).toEqual(entry.capabilities);
    expect(pinned.isolation).toMatchObject({ requested_inner_mode: 'internal_required', native_result: 'passed', outer_proof_hash: entry.outer_proof_hash, permission_policy_hash: entry.permission_policy_hash });
  });

  it.each(['claude', 'codex'])('%s: every capability is stated, proven ones carry evidence, unproven ones are listed as missing', (vendor) => {
    const entry = manifest.vendors[vendor];
    if (entry === undefined) throw new Error(`missing ${vendor}`);
    expect(Object.keys(entry.capabilities).sort()).toEqual([...CAPABILITIES].sort());
    for (const c of Object.values(entry.capabilities)) if (c.status === 'proven') expect(c.evidence).toBeTruthy();
    expect(entry.capability_missing.sort()).toEqual(Object.entries(entry.capabilities).filter(([, c]) => c.status !== 'proven').map(([k]) => k).sort());
    // Owner decision 2026-10-28: no resume runs and no hard USD cap proof, so neither may be claimed.
    expect(entry.capabilities['session_resume']?.status).toBe('unknown');
    expect(entry.capabilities['cost_limit']?.status).toBe('unknown');
  });
});
