import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as spike from '../../../scripts/spike-002/role-schema.ts';
import {
  ROLES,
  ROLE_SCHEMAS,
  ROLE_SCHEMA_DIGESTS,
  isRole,
  roleJsonSchema,
  roleSchemaDigest,
  validateRoleResult,
  wireRoleSchema,
} from '../../../src/adapters/harness/result-schema.ts';

const SCHEMA_DIR = fileURLToPath(new URL('../../fixtures/runtime/spike-0/schema/', import.meta.url));
const HARNESS_MANIFEST = fileURLToPath(new URL('../../fixtures/runtime/spike-0/harness/real-20261028/manifest.json', import.meta.url));

type Sample = { name: string; role: string; expect: 'valid' | 'structure' | 'semantic'; value: unknown };
const samples = (JSON.parse(readFileSync(join(SCHEMA_DIR, 'samples.synthetic.json'), 'utf8')) as { cases: Sample[] }).cases;
const manifest = JSON.parse(readFileSync(join(SCHEMA_DIR, 'manifest.json'), 'utf8')) as {
  roles: Record<string, { schema_id: string; file: string; digest: string }>;
};

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('role result schemas promoted from T003 (T013, SPEC §12.3)', () => {
  it.each(ROLES)('%s keeps the schema id, canonical digest and file proven in S0.2', (role) => {
    const pinned = manifest.roles[role];
    expect(ROLE_SCHEMAS[role].id).toBe(pinned?.schema_id);
    expect(roleSchemaDigest(role)).toBe(pinned?.digest);
    expect(ROLE_SCHEMA_DIGESTS[role]).toBe(pinned?.digest);
    expect(JSON.parse(readFileSync(join(SCHEMA_DIR, pinned?.file ?? ''), 'utf8'))).toEqual(roleJsonSchema(role));
    expect(roleJsonSchema(role)).toEqual(spike.roleJsonSchema(role));
  });

  it('wire schema files match, byte for byte, the files sent to both vendors in T007', () => {
    const recorded = new Set(
      [...readFileSync(HARNESS_MANIFEST, 'utf8').matchAll(/"wire_schema_file_sha256": "([0-9a-f]{64})"/g)].map((m) => m[1]),
    );
    const produced = new Set(ROLES.flatMap((role) => [false, true].map((omit) => sha256(wireRoleSchema(role, { omit_meta_schema: omit }).file_content))));
    expect(produced).toEqual(recorded);
  });

  it('omitting the meta-schema changes only $schema and the wire digest', () => {
    for (const role of ROLES) {
      const full = wireRoleSchema(role, { omit_meta_schema: false });
      const bare = wireRoleSchema(role, { omit_meta_schema: true });
      expect(full.digest).toBe(bare.digest);
      expect(full.wire_digest).toBe(full.digest);
      expect(bare.wire_digest).not.toBe(bare.digest);
      const { $schema: _dropped, ...rest } = full.schema;
      expect(bare.schema).toEqual(rest);
      expect(bare.file_name).toBe(`${ROLE_SCHEMAS[role].id}.schema.json`);
    }
  });

  it.each(samples.map((s) => [s.name, s] as const))('validates like the spike prototype: %s', (_name, sample) => {
    expect(isRole(sample.role)).toBe(true);
    if (!isRole(sample.role)) return;
    const r = validateRoleResult(sample.role, sample.value);
    expect(r).toEqual(spike.validateRoleResult(sample.role, sample.value));
    if (sample.expect === 'valid') expect(r.ok).toBe(true);
    else {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.every((i) => i.layer === sample.expect)).toBe(true);
    }
  });

  it('coder/fixer and reviewer schemas stay separate and closed', () => {
    expect(ROLE_SCHEMAS.coder.id).toBe(ROLE_SCHEMAS.fixer.id);
    expect(ROLE_SCHEMAS.reviewer.id).not.toBe(ROLE_SCHEMAS.coder.id);
    expect(validateRoleResult('reviewer', { schema_version: 1, status: 'done', summary: 'x', questions: [], blocker: null }).ok).toBe(false);
    expect(validateRoleResult('coder', { schema_version: 1, status: 'done', summary: 'ok', questions: [], blocker: null, task_id: 't1' }).ok).toBe(false);
  });
});
