import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEMA_DIR,
  checkSchemaFiles,
} from '../../../scripts/spike-002/export-role-schemas.ts';
import {
  ROLES,
  SchemaPortabilityError,
  assertPortableSchema,
  isRole,
  roleJsonSchema,
  roleSchemaDigest,
  validateRoleResult,
} from '../../../scripts/spike-002/role-schema.ts';

type Sample = {
  name: string;
  role: string;
  expect: 'valid' | 'structure' | 'semantic';
  value: unknown;
};
const samples = (
  JSON.parse(
    readFileSync(join(DEFAULT_SCHEMA_DIR, 'samples.synthetic.json'), 'utf8'),
  ) as { cases: Sample[] }
).cases;

describe('spike-002 role schemas (SPEC §12.3)', () => {
  it('committed JSON Schema files and digests match the Zod source', () => {
    expect(checkSchemaFiles(DEFAULT_SCHEMA_DIR)).toEqual([]);
    const manifest = JSON.parse(
      readFileSync(join(DEFAULT_SCHEMA_DIR, 'manifest.json'), 'utf8'),
    ) as {
      roles: Record<string, { digest: string; file: string }>;
    };
    for (const role of ROLES) {
      expect(manifest.roles[role]?.digest).toBe(roleSchemaDigest(role));
      const onDisk = JSON.parse(
        readFileSync(
          join(DEFAULT_SCHEMA_DIR, manifest.roles[role]?.file ?? ''),
          'utf8',
        ),
      ) as unknown;
      expect(onDisk).toEqual(roleJsonSchema(role));
    }
  });

  it('coder and fixer share one versioned schema; the reviewer has its own', () => {
    expect(roleSchemaDigest('coder')).toBe(roleSchemaDigest('fixer'));
    expect(roleSchemaDigest('reviewer')).not.toBe(roleSchemaDigest('coder'));
  });

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
    const coder = roleJsonSchema('coder')['properties'] as Record<
      string,
      unknown
    >;
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

  it.each(samples.map((s) => [s.name, s] as const))(
    'synthetic sample: %s',
    (_name, sample) => {
      expect(isRole(sample.role)).toBe(true);
      if (!isRole(sample.role)) return;
      const r = validateRoleResult(sample.role, sample.value);
      if (sample.expect === 'valid') {
        expect(r).toMatchObject({ ok: true });
      } else {
        expect(r.ok).toBe(false);
        if (!r.ok)
          expect(r.issues.every((i) => i.layer === sample.expect)).toBe(true);
      }
    },
  );

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

  it('rejects a model-declared task id instead of trusting it', () => {
    const r = validateRoleResult('coder', {
      schema_version: 1,
      status: 'done',
      summary: 'ok',
      questions: [],
      blocker: null,
      attempt_id: 'x',
    });
    expect(r.ok).toBe(false);
  });
});
