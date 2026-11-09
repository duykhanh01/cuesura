import { z } from 'zod';
import { UuidSchema } from '../shared/brand.ts';

export const TASK_SCHEMA_VERSION = 1;

export const TASK_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;
export type TaskSize = (typeof TASK_SIZES)[number];

export const AttachmentRefSchema = z
  .object({
    name: z.string().min(1),
    media_type: z.string().min(1),
    content_ref: z.string().min(1),
  })
  .strict();

export const RequesterSchema = z
  .object({
    kind: z.enum(['human', 'assistant', 'source']),
    id: z.string().min(1),
  })
  .strict();
export type Requester = z.infer<typeof RequesterSchema>;

/** `owner/repo#number` of an existing pull request. */
export const PR_REF_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/;

export const CanonicalTaskSchema = z
  .object({
    schema_version: z.literal(TASK_SCHEMA_VERSION),
    id: UuidSchema,
    title: z.string().min(1),
    type: z.string().min(1),
    project: z.string().min(1),
    base_branch: z.string().min(1),
    description: z.string(),
    requirements: z.array(z.string()),
    acceptance: z.array(z.string().min(1)),
    constraints: z.array(z.string()),
    out_of_scope: z.array(z.string()),
    attachments: z.array(AttachmentRefSchema),
    group: z.string().nullable(),
    parent: UuidSchema.nullable(),
    depends_on: z.array(UuidSchema),
    priority: z.number().int(),
    size: z.enum(TASK_SIZES).nullable(),
    labels: z.array(z.string()),
    profile: z.string().nullable(),
    requested_by: RequesterSchema,
    revision: z.number().int().positive(),
    source_key: z.string().min(1),
    retry_of: UuidSchema.nullable(),
    /** The existing PR this task continues; absent on every other task, so their hashes do not change. */
    pr_ref: z.string().regex(PR_REF_PATTERN).optional(),
    /**
     * Paths or globs the task expects to change (issue #240), normalized; absent when none was declared,
     * so the hashes of other tasks do not change.
     */
    scope: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type CanonicalTask = z.infer<typeof CanonicalTaskSchema>;

/** Canonical request content used for source_key deduplication. */
export function taskContent(t: CanonicalTask): unknown {
  const { id: _id, revision: _rev, schema_version: _sv, ...rest } = t;
  return rest;
}
