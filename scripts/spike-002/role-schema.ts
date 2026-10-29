/**
 * Spike 0 role result schemas (SPEC §12.3, T003). Zod is the single source; the exchange JSON Schema
 * is exported with `z.toJSONSchema()` and restricted to a conservative keyword subset because which
 * keywords each harness accepts is unproven until S0.2. Length/range rules that the exchange schema
 * does not carry are enforced by `validateRoleResult` after structural parsing.
 *
 * Isolated prototype: no imports from runtime A modules. T013 promotes this file and must keep the
 * digests below equivalent or record a new schema version.
 */
import { z } from 'zod';
import { hashCanonical } from '../../src/shared/hash.ts';

export const ROLES = ['coder', 'fixer', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

export const SUMMARY_MAX = 4_000;
export const TEXT_MAX = 2_000;
export const QUESTIONS_MAX = 10;
export const OPTIONS_MAX = 10;
export const FINDINGS_MAX = 100;

export const QuestionSchema = z.strictObject({
  question: z.string(),
  options: z.array(z.string()),
});

export const CoderResultSchema = z.strictObject({
  schema_version: z.literal(1),
  status: z.enum(['done', 'needs_input', 'needs_context', 'blocked']),
  summary: z.string(),
  questions: z.array(QuestionSchema),
  blocker: z.string().nullable(),
});
export type CoderResult = z.infer<typeof CoderResultSchema>;

export const FindingSchema = z.strictObject({
  severity: z.enum(['critical', 'major', 'minor', 'info']),
  file: z.string(),
  line: z.number().int().nullable(),
  message: z.string(),
});

export const ReviewerResultSchema = z.strictObject({
  schema_version: z.literal(1),
  verdict: z.enum(['approve', 'request_changes']),
  summary: z.string(),
  findings: z.array(FindingSchema),
});
export type ReviewerResult = z.infer<typeof ReviewerResultSchema>;

/** Coder and fixer share one versioned schema; the reviewer has its own verdict schema. */
export const ROLE_SCHEMAS = {
  coder: { id: 'cusr.role.coder-fixer.v1', schema: CoderResultSchema },
  fixer: { id: 'cusr.role.coder-fixer.v1', schema: CoderResultSchema },
  reviewer: { id: 'cusr.role.reviewer.v1', schema: ReviewerResultSchema },
} as const;

/** Keywords the exported schema may use; anything else must be justified by S0.2 evidence first. */
export const PORTABLE_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
]);

export class SchemaPortabilityError extends Error {
  override name = 'SchemaPortabilityError';
}

type JsonObject = { [key: string]: unknown };

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Rejects keywords outside the portable subset and objects that are not closed with every key required. */
export function assertPortableSchema(node: unknown, path = '#'): void {
  if (!isObject(node))
    throw new SchemaPortabilityError(`${path}: schema node must be an object`);
  for (const key of Object.keys(node)) {
    if (!PORTABLE_KEYWORDS.has(key))
      throw new SchemaPortabilityError(
        `${path}: keyword ${key} is not portable`,
      );
  }
  if (node['type'] === 'object') {
    const props = node['properties'];
    if (!isObject(props))
      throw new SchemaPortabilityError(`${path}: object without properties`);
    if (node['additionalProperties'] !== false)
      throw new SchemaPortabilityError(`${path}: object is not closed`);
    const required = node['required'];
    const keys = Object.keys(props).sort();
    if (
      !Array.isArray(required) ||
      [...(required as string[])].sort().join('\0') !== keys.join('\0')
    ) {
      throw new SchemaPortabilityError(
        `${path}: every property must be required (use null or [] for absence)`,
      );
    }
    for (const [k, v] of Object.entries(props))
      assertPortableSchema(v, `${path}/properties/${k}`);
  }
  if (node['items'] !== undefined)
    assertPortableSchema(node['items'], `${path}/items`);
  const anyOf = node['anyOf'];
  if (anyOf !== undefined) {
    if (!Array.isArray(anyOf))
      throw new SchemaPortabilityError(`${path}: anyOf must be an array`);
    anyOf.forEach((v, i) => assertPortableSchema(v, `${path}/anyOf/${i}`));
  }
}

/** Exchange JSON Schema for a role, without integer bounds Zod adds by default. */
export function roleJsonSchema(role: Role): JsonObject {
  const json = z.toJSONSchema(ROLE_SCHEMAS[role].schema, {
    target: 'draft-2020-12',
    io: 'output',
    override: (ctx) => {
      const s = ctx.jsonSchema as JsonObject;
      if (s['type'] === 'integer') {
        delete s['minimum'];
        delete s['maximum'];
      }
    },
  }) as JsonObject;
  assertPortableSchema(json);
  return json;
}

export function roleSchemaDigest(role: Role): string {
  return hashCanonical(roleJsonSchema(role));
}

export type ValidationIssue = {
  readonly layer: 'structure' | 'semantic';
  readonly path: string;
  readonly message: string;
};

export type RoleValidation =
  | {
      readonly ok: true;
      readonly role: Role;
      readonly value: CoderResult | ReviewerResult;
    }
  | {
      readonly ok: false;
      readonly role: Role;
      readonly issues: readonly ValidationIssue[];
    };

function textIssue(
  issues: ValidationIssue[],
  path: string,
  text: string,
  max: number,
): void {
  if (text.trim().length === 0)
    issues.push({ layer: 'semantic', path, message: 'must not be blank' });
  if (text.length > max)
    issues.push({
      layer: 'semantic',
      path,
      message: `longer than ${max} characters`,
    });
}

function coderSemantics(r: CoderResult): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  textIssue(issues, 'summary', r.summary, SUMMARY_MAX);
  if (r.questions.length > QUESTIONS_MAX)
    issues.push({
      layer: 'semantic',
      path: 'questions',
      message: `more than ${QUESTIONS_MAX}`,
    });
  r.questions.forEach((q, i) => {
    textIssue(issues, `questions[${i}].question`, q.question, TEXT_MAX);
    if (q.options.length > OPTIONS_MAX)
      issues.push({
        layer: 'semantic',
        path: `questions[${i}].options`,
        message: `more than ${OPTIONS_MAX}`,
      });
    q.options.forEach((o, j) =>
      textIssue(issues, `questions[${i}].options[${j}]`, o, TEXT_MAX),
    );
  });
  if (r.blocker !== null) textIssue(issues, 'blocker', r.blocker, TEXT_MAX);
  switch (r.status) {
    case 'done':
      if (r.questions.length > 0)
        issues.push({
          layer: 'semantic',
          path: 'questions',
          message: 'done must not ask questions',
        });
      if (r.blocker !== null)
        issues.push({
          layer: 'semantic',
          path: 'blocker',
          message: 'done must not carry a blocker',
        });
      break;
    case 'needs_input':
      if (r.questions.length === 0)
        issues.push({
          layer: 'semantic',
          path: 'questions',
          message: 'needs_input requires a question',
        });
      break;
    case 'needs_context':
    case 'blocked':
      if (r.blocker === null)
        issues.push({
          layer: 'semantic',
          path: 'blocker',
          message: `${r.status} requires a blocker`,
        });
      break;
  }
  return issues;
}

function reviewerSemantics(r: ReviewerResult): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  textIssue(issues, 'summary', r.summary, SUMMARY_MAX);
  if (r.findings.length > FINDINGS_MAX)
    issues.push({
      layer: 'semantic',
      path: 'findings',
      message: `more than ${FINDINGS_MAX}`,
    });
  r.findings.forEach((f, i) => {
    textIssue(issues, `findings[${i}].file`, f.file, TEXT_MAX);
    textIssue(issues, `findings[${i}].message`, f.message, TEXT_MAX);
    if (f.file.startsWith('/') || f.file.split('/').includes('..')) {
      issues.push({
        layer: 'semantic',
        path: `findings[${i}].file`,
        message: 'must be a repo-relative path',
      });
    }
    if (f.line !== null && f.line < 1)
      issues.push({
        layer: 'semantic',
        path: `findings[${i}].line`,
        message: 'must be >= 1 or null',
      });
  });
  const blocking = r.findings.some(
    (f) => f.severity === 'critical' || f.severity === 'major',
  );
  if (r.verdict === 'approve' && blocking) {
    issues.push({
      layer: 'semantic',
      path: 'verdict',
      message: 'approve with critical/major findings',
    });
  }
  if (r.verdict === 'request_changes' && r.findings.length === 0) {
    issues.push({
      layer: 'semantic',
      path: 'findings',
      message: 'request_changes requires a finding',
    });
  }
  return issues;
}

/** Structural (closed schema) then semantic validation. Provenance is checked by the caller. */
export function validateRoleResult(role: Role, value: unknown): RoleValidation {
  if (role === 'reviewer') {
    const parsed = ReviewerResultSchema.safeParse(value);
    if (!parsed.success)
      return { ok: false, role, issues: structureIssues(parsed.error) };
    const issues = reviewerSemantics(parsed.data);
    return issues.length > 0
      ? { ok: false, role, issues }
      : { ok: true, role, value: parsed.data };
  }
  const parsed = CoderResultSchema.safeParse(value);
  if (!parsed.success)
    return { ok: false, role, issues: structureIssues(parsed.error) };
  const issues = coderSemantics(parsed.data);
  return issues.length > 0
    ? { ok: false, role, issues }
    : { ok: true, role, value: parsed.data };
}

function structureIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({
    layer: 'structure',
    path: i.path.map(String).join('.'),
    message: i.message,
  }));
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
