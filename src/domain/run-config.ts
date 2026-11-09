import { z } from 'zod';
import { HashSchema, type Hash } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import { EFFORTS, type AuthzContext } from './policy.ts';

/**
 * Execution modes and the run configuration confirmed before the first spawn (task-execution-modes.md,
 * M01/M02). The assistant that takes a task proposes a selection from the configured `when_to_use`
 * guidance; the daemon never picks a mode from size, risk or quota, it only validates an explicit
 * selection against the allowlist and records a confirmation bound to the selection's digest.
 */

export const EXECUTION_MODES = ['direct-pr', 'full-review'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const RunChoiceSchema = z
  .object({
    harness: z.string().min(1).max(64),
    model: z.string().min(1).max(128),
    effort: z.enum(EFFORTS),
  })
  .strict();
export type RunChoice = z.infer<typeof RunChoiceSchema>;

export const MAX_FALLBACKS = 8;

const RunSelectionFields = z
  .object({
    task_id: z.string().min(1),
    revision: z.number().int().positive(),
    profile: z.string().min(1),
    mode: z.enum(EXECUTION_MODES),
    reason: z.string().max(2_000),
    worker: RunChoiceSchema,
    /** Required with `full-review`, absent with `direct-pr`. */
    reviewer: RunChoiceSchema.nullable(),
    /** Worker bindings the user allows without asking again (escalation/fallback within this set). */
    fallbacks: z.array(RunChoiceSchema).max(MAX_FALLBACKS),
    /**
     * Reviewer bindings allowed the same way (#276). Absent in selections made before it existed, which
     * keeps their digest; absent reads as none.
     */
    reviewer_fallbacks: z.array(RunChoiceSchema).max(MAX_FALLBACKS).optional(),
  })
  .strict();

function reviewerMatchesMode(
  s: {
    mode: ExecutionMode;
    reviewer: RunChoice | null;
    reviewer_fallbacks?: RunChoice[] | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (s.mode === 'full-review' && s.reviewer === null)
    ctx.addIssue({
      code: 'custom',
      path: ['reviewer'],
      message: 'full-review needs a reviewer binding',
    });
  if (s.mode === 'direct-pr' && s.reviewer !== null)
    ctx.addIssue({
      code: 'custom',
      path: ['reviewer'],
      message: 'direct-pr runs no reviewer',
    });
  if (s.mode === 'direct-pr' && (s.reviewer_fallbacks ?? []).length > 0)
    ctx.addIssue({
      code: 'custom',
      path: ['reviewer_fallbacks'],
      message: 'direct-pr runs no reviewer',
    });
}

export const RunSelectionSchema = RunSelectionFields.superRefine(reviewerMatchesMode);
/** A selection as a caller proposes it; the server binds it to the task ID and revision. */
export const RunProposalSchema = RunSelectionFields.omit({
  task_id: true,
  revision: true,
})
  .extend({
    /** Absent: the daemon fills the worker's ladder from `run_options`; `[]` allows none (#263). */
    fallbacks: RunSelectionFields.shape.fallbacks.optional(),
  })
  .superRefine(reviewerMatchesMode);
export type RunProposal = z.infer<typeof RunProposalSchema>;
export type RunSelection = z.infer<typeof RunSelectionSchema>;

export function selectionDigest(s: RunSelection): Hash {
  return hashCanonical(s);
}

export function sameChoice(
  a: RunChoice,
  b: { harness: string; model: string; effort: string },
): boolean {
  return a.harness === b.harness && a.model === b.model && a.effort === b.effort;
}

/**
 * Who confirmed, from which channel: the actor the caller declared, never a request field.
 */
export const RunConfirmationSchema = z
  .object({
    digest: HashSchema,
    actor: z.string().min(1),
    channel: z.string().min(1),
    confirmed_at: z.number().int().nonnegative(),
  })
  .strict();
export type RunConfirmation = z.infer<typeof RunConfirmationSchema>;

/** Any caller that may operate tasks may confirm a run, the assistant's included (constitution 4.0.0). */
export function trustedConfirmer(authz: AuthzContext | undefined): boolean {
  return authz !== undefined && authz.roles.includes('operate');
}

/** The confirmed selection frozen into the runtime snapshot at start. */
export const RunConfigSnapshotSchema = z
  .object({
    mode: z.enum(EXECUTION_MODES),
    selection: RunSelectionSchema,
    digest: HashSchema,
    confirmation: RunConfirmationSchema,
  })
  .strict();
export type RunConfigSnapshot = z.infer<typeof RunConfigSnapshotSchema>;

/** PR template read from the frozen base; `null` when the repo has none. */
export const PrTemplateSchema = z
  .object({
    path: z.string().min(1),
    content: z.string().max(64 * 1024),
    content_hash: HashSchema,
  })
  .strict();
export type PrTemplate = z.infer<typeof PrTemplateSchema>;
