import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ROLES,
  SchemaPortabilityError,
  assertPortableSchema,
  ROLE_SCHEMAS,
  ROLE_SCHEMA_DIGESTS,
  isRole,
  roleJsonSchema,
  roleSchemaDigest,
  TEXT_MAX,
  validateRoleResult,
  wireRoleSchema,
} from '../../../src/adapters/harness/result-schema.ts';

const SCHEMA_DIR = fileURLToPath(
  new URL('../../fixtures/runtime/spike-0/schema/', import.meta.url),
);
const HARNESS_MANIFEST = fileURLToPath(
  new URL('../../fixtures/runtime/spike-0/harness/real-20261028/manifest.json', import.meta.url),
);

type Sample = {
  name: string;
  role: string;
  expect: 'valid' | 'structure' | 'semantic';
  value: unknown;
};
const samples = (
  JSON.parse(readFileSync(join(SCHEMA_DIR, 'samples.synthetic.json'), 'utf8')) as {
    cases: Sample[];
  }
).cases;
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
    expect(JSON.parse(readFileSync(join(SCHEMA_DIR, pinned?.file ?? ''), 'utf8'))).toEqual(
      roleJsonSchema(role),
    );
  });

  it('wire schema files match, byte for byte, the files sent to both vendors in T007', () => {
    const recorded = new Set(
      [
        ...readFileSync(HARNESS_MANIFEST, 'utf8').matchAll(
          /"wire_schema_file_sha256": "([0-9a-f]{64})"/g,
        ),
      ].map((m) => m[1]),
    );
    const produced = new Set(
      ROLES.flatMap((role) =>
        [false, true].map((omit) =>
          sha256(wireRoleSchema(role, { omit_meta_schema: omit }).file_content),
        ),
      ),
    );
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

  it.each(samples.map((s) => [s.name, s] as const))(
    'validates the recorded sample: %s',
    (_name, sample) => {
      expect(isRole(sample.role)).toBe(true);
      if (!isRole(sample.role)) return;
      const r = validateRoleResult(sample.role, sample.value);
      if (sample.expect === 'valid') expect(r.ok).toBe(true);
      else {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.issues.every((i) => i.layer === sample.expect)).toBe(true);
      }
    },
  );

  it('coder/fixer and reviewer schemas stay separate and closed', () => {
    expect(ROLE_SCHEMAS.coder.id).toBe(ROLE_SCHEMAS.fixer.id);
    expect(ROLE_SCHEMAS.reviewer.id).not.toBe(ROLE_SCHEMAS.coder.id);
    expect(
      validateRoleResult('reviewer', {
        schema_version: 1,
        status: 'done',
        summary: 'x',
        questions: [],
        blocker: null,
      }).ok,
    ).toBe(false);
    expect(
      validateRoleResult('coder', {
        schema_version: 1,
        status: 'done',
        summary: 'ok',
        questions: [],
        blocker: null,
        task_id: 't1',
      }).ok,
    ).toBe(false);
  });
});

describe('role schema portability and sample coverage', () => {
  it.each(ROLES)(
    '%s schema is a closed root object with every key required and null for absence',
    (role) => {
      const s = roleJsonSchema(role);
      expect(s['type']).toBe('object');
      expect(s['additionalProperties']).toBe(false);
      expect(s['required']).toEqual(Object.keys(s['properties'] as object));
      expect(() => assertPortableSchema(s)).not.toThrow();
    },
  );

  it('blocker and line are nullable via null, not optional', () => {
    const coder = roleJsonSchema('coder')['properties'] as Record<string, unknown>;
    expect(coder['blocker']).toEqual({ type: ['string', 'null'] });
    const findings = (
      roleJsonSchema('reviewer')['properties'] as Record<
        string,
        { items: { properties: Record<string, unknown> } }
      >
    )['findings'];
    expect(findings?.items.properties['line']).toEqual({
      type: ['integer', 'null'],
    });
  });

  it.each([
    ['keyword outside the portable subset', { type: 'string', minLength: 1 }],
    [
      'open object',
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
      },
    ],
    [
      'optional property',
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: [],
        additionalProperties: false,
      },
    ],
    [
      'nested open object',
      {
        type: 'array',
        items: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: true,
        },
      },
    ],
  ])('portability check rejects %s', (_name, schema) => {
    expect(() => assertPortableSchema(schema)).toThrow(SchemaPortabilityError);
  });

  it('covers every status, both verdicts and all three failure layers in the sample set', () => {
    const valid = samples
      .filter((s) => s.expect === 'valid')
      .map((s) => s.value as Record<string, unknown>);
    expect(new Set(valid.map((v) => v['status']).filter(Boolean))).toEqual(
      new Set(['done', 'needs_input', 'needs_context', 'blocked']),
    );
    expect(new Set(valid.map((v) => v['verdict']).filter(Boolean))).toEqual(
      new Set(['approve', 'request_changes']),
    );
    expect(new Set(samples.map((s) => s.expect))).toEqual(
      new Set(['valid', 'structure', 'semantic']),
    );
  });
});

describe('number of questions', () => {
  it('accepts any number of questions and still bounds the size of each', () => {
    const result = (text: string, count: number) => ({
      schema_version: 1,
      status: 'needs_input',
      summary: 'Needs answers',
      questions: Array.from({ length: count }, () => ({
        question: text,
        options: [],
      })),
      blocker: null,
    });
    expect(validateRoleResult('coder', result('Which one?', 50)).ok).toBe(true);
    expect(validateRoleResult('coder', result('x'.repeat(TEXT_MAX + 1), 1)).ok).toBe(false);
  });
});

describe('decider result', () => {
  it('keeps its pinned digest and stays out of the step roles', () => {
    expect(ROLE_SCHEMA_DIGESTS.decider).toBe(roleSchemaDigest('decider'));
    expect((ROLES as readonly string[]).includes('decider')).toBe(false);
  });

  it('accepts an answer with a reason and refuses an empty one', () => {
    const value = { schema_version: 1, answer: 'UTF-8', reason: 'default' };
    expect(validateRoleResult('decider', value).ok).toBe(true);
    expect(validateRoleResult('decider', { ...value, answer: ' ' }).ok).toBe(false);
    expect(validateRoleResult('decider', { ...value, extra: 1 }).ok).toBe(false);
  });
});
