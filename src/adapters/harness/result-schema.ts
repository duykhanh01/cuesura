/**
 * Role result schemas (SPEC §12.3, contracts/execution.md "Harness contract"). Matches the archived
 * T003 schemas in `test/fixtures/runtime/spike-0/schema/`, accepted by both vendors
 * in S0.2 (T007). Zod is the single source; the exchange JSON Schema is exported with
 * `z.toJSONSchema()` and restricted to a portable keyword subset. Length/range rules the exchange
 * schema does not carry are enforced by {@link validateRoleResult} after structural parsing.
 *
 * Changing a schema here changes its canonical digest: that is a new schema version, never a silent
 * edit of v1 (test/unit/adapters/result-schema.test.ts pins the digests to the T003 fixtures).
 * Provenance (task, attempt, schema, vendor) is attached by the orchestrator, never read from the model.
 */
import { z } from 'zod';
import { assertNever } from '../../shared/assert-never.ts';
import type { Hash } from '../../shared/brand.ts';
import { hashCanonical } from '../../shared/hash.ts';

export const ROLES = ['coder', 'fixer', 'reviewer'] as const;
/** `decider` runs outside the task graph: no workflow step can name it, so it stays out of {@link ROLES}. */
export type Role = (typeof ROLES)[number] | 'decider';

export const SUMMARY_MAX = 4_000;
export const TEXT_MAX = 2_000;
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
export type Finding = z.infer<typeof FindingSchema>;

export const ReviewerResultSchema = z.strictObject({
  schema_version: z.literal(1),
  verdict: z.enum(['approve', 'request_changes']),
  summary: z.string(),
  findings: z.array(FindingSchema),
});
export type ReviewerResult = z.infer<typeof ReviewerResultSchema>;

export const DeciderResultSchema = z.strictObject({
  schema_version: z.literal(1),
  answer: z.string(),
  reason: z.string(),
});
export type DeciderResult = z.infer<typeof DeciderResultSchema>;

export type RoleResult = CoderResult | ReviewerResult | DeciderResult;

/** Coder and fixer share one versioned schema; the reviewer has its own verdict schema. */
export const ROLE_SCHEMAS = {
  coder: { id: 'cusr.role.coder-fixer.v1', schema: CoderResultSchema },
  fixer: { id: 'cusr.role.coder-fixer.v1', schema: CoderResultSchema },
  reviewer: { id: 'cusr.role.reviewer.v1', schema: ReviewerResultSchema },
  decider: { id: 'cusr.role.decider.v1', schema: DeciderResultSchema },
} as const;
export type RoleSchemaId = (typeof ROLE_SCHEMAS)[Role]['id'];

/**
 * Canonical digests proven in S0.2 (test/fixtures/runtime/spike-0/schema/manifest.json). Capability
 * manifests pin these; a mismatch at load time means the schema drifted and attempts must not start.
 */
export const ROLE_SCHEMA_DIGESTS: Readonly<Record<Role, Hash>> = {
  coder: 'sha256:0c1592471ef20ca5a8043c0c24c01b8f9b08593dc65be3686c427ba72e3023f4',
  fixer: 'sha256:0c1592471ef20ca5a8043c0c24c01b8f9b08593dc65be3686c427ba72e3023f4',
  reviewer: 'sha256:0ff4669a1cfda8e2208448032c76fd3428f55124fe5eb3e3e423cbb96ed1c57e',
  decider: 'sha256:4fd09a7720ba5291314e9866a50e89c9f9c9f5d276c411a0541e2681fe634c0e',
};

/** Keywords the exported schema may use; anything else needs new S0.2-grade evidence first. */
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
  if (!isObject(node)) throw new SchemaPortabilityError(`${path}: schema node must be an object`);
  for (const key of Object.keys(node)) {
    if (!PORTABLE_KEYWORDS.has(key))
      throw new SchemaPortabilityError(`${path}: keyword ${key} is not portable`);
  }
  if (node['type'] === 'object') {
    const props = node['properties'];
    if (!isObject(props)) throw new SchemaPortabilityError(`${path}: object without properties`);
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
    for (const [k, v] of Object.entries(props)) assertPortableSchema(v, `${path}/properties/${k}`);
  }
  if (node['items'] !== undefined) assertPortableSchema(node['items'], `${path}/items`);
  const anyOf = node['anyOf'];
  if (anyOf !== undefined) {
    if (!Array.isArray(anyOf)) throw new SchemaPortabilityError(`${path}: anyOf must be an array`);
    anyOf.forEach((v, i) => assertPortableSchema(v, `${path}/anyOf/${i}`));
  }
}

/** Canonical exchange JSON Schema for a role, without the integer bounds Zod adds by default. */
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

export function roleSchemaDigest(role: Role): Hash {
  return hashCanonical(roleJsonSchema(role));
}

/** How the schema is handed to one harness binary; taken from its capability manifest. */
export type WireOptions = {
  /** Claude 2.1.306 rejects the 2020-12 meta-schema declaration; every other keyword stays. */
  readonly omit_meta_schema: boolean;
};

export type WireSchema = {
  readonly role: Role;
  readonly schema_id: RoleSchemaId;
  readonly digest: Hash;
  readonly wire_digest: Hash;
  readonly schema: JsonObject;
  /** Bytes written to the per-attempt read-only schema file; inline argv uses the same value. */
  readonly file_name: string;
  readonly file_content: string;
};

export function wireRoleSchema(role: Role, opts: WireOptions): WireSchema {
  const schema = roleJsonSchema(role);
  if (opts.omit_meta_schema) delete schema['$schema'];
  const id = ROLE_SCHEMAS[role].id;
  return {
    role,
    schema_id: id,
    digest: roleSchemaDigest(role),
    wire_digest: hashCanonical(schema),
    schema,
    file_name: `${id}.schema.json`,
    file_content: `${JSON.stringify(schema, null, 2)}\n`,
  };
}

export type ValidationIssue = {
  readonly layer: 'structure' | 'semantic';
  readonly path: string;
  readonly message: string;
};

export type RoleValidation =
  | { readonly ok: true; readonly role: Role; readonly value: RoleResult }
  | {
      readonly ok: false;
      readonly role: Role;
      readonly issues: readonly ValidationIssue[];
    };

function textIssue(issues: ValidationIssue[], path: string, text: string, max: number): void {
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
  r.questions.forEach((q, i) => {
    textIssue(issues, `questions[${i}].question`, q.question, TEXT_MAX);
    if (q.options.length > OPTIONS_MAX)
      issues.push({
        layer: 'semantic',
        path: `questions[${i}].options`,
        message: `more than ${OPTIONS_MAX}`,
      });
    q.options.forEach((o, j) => textIssue(issues, `questions[${i}].options[${j}]`, o, TEXT_MAX));
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
    default:
      assertNever(r.status);
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
  const blocking = r.findings.some((f) => f.severity === 'critical' || f.severity === 'major');
  if (r.verdict === 'approve' && blocking) {
    issues.push({
      layer: 'semantic',
      path: 'verdict',
      message: 'approve with critical/major findings',
    });
  }
  if (r.verdict === 'request_changes' && !blocking) {
    issues.push({
      layer: 'semantic',
      path: 'verdict',
      message: 'request_changes without a critical/major finding',
    });
  }
  return issues;
}

/** Structural (closed schema) then semantic validation. Provenance is checked by the caller. */
export function validateRoleResult(role: Role, value: unknown): RoleValidation {
  if (role === 'decider') {
    const parsed = DeciderResultSchema.safeParse(value);
    if (!parsed.success) return { ok: false, role, issues: structureIssues(parsed.error) };
    return parsed.data.answer.trim() === ''
      ? {
          ok: false,
          role,
          issues: [
            {
              layer: 'semantic',
              path: 'answer',
              message: 'answer must not be empty',
            },
          ],
        }
      : { ok: true, role, value: parsed.data };
  }
  if (role === 'reviewer') {
    const parsed = ReviewerResultSchema.safeParse(value);
    if (!parsed.success) return { ok: false, role, issues: structureIssues(parsed.error) };
    const issues = reviewerSemantics(parsed.data);
    return issues.length > 0 ? { ok: false, role, issues } : { ok: true, role, value: parsed.data };
  }
  const parsed = CoderResultSchema.safeParse(value);
  if (!parsed.success) return { ok: false, role, issues: structureIssues(parsed.error) };
  const issues = coderSemantics(parsed.data);
  return issues.length > 0 ? { ok: false, role, issues } : { ok: true, role, value: parsed.data };
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
