import { z } from 'zod';
import { MERGE_METHODS } from '../domain/merge-method.ts';
import { CI_CLASSES } from '../domain/policy.ts';

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export const CiRuleInputSchema = z
  .object({
    match: z
      .object({
        job: z.string().min(1).optional(),
        check: z.string().min(1).optional(),
        log_pattern: z
          .string()
          .min(1)
          .max(256)
          .refine(compiles, {
            message: 'log_pattern must be a valid regular expression',
          })
          .optional(),
      })
      .strict()
      .refine((m) => m.job !== undefined || m.check !== undefined || m.log_pattern !== undefined, {
        message: 'match requires at least one of: job, check, log_pattern',
      }),
    class: z.enum(CI_CLASSES),
  })
  .strict();

const nameList = z.array(z.string().min(1));
const commandMap = z.record(z.string(), z.string().min(1));

const sharedProjectKeys = {
  setup: z.union([z.string().min(1), nameList]).optional(),
  /** Commands the project needs that its gates do not name. Names only: a repo never picks a mount. */
  tools: z.array(z.string().regex(/^[A-Za-z0-9._+-]+$/)).optional(),
  gates: commandMap.optional(),
  autofix: commandMap.optional(),
  log_digest: z.record(z.string(), z.unknown()).optional(),
  signature: z.record(z.string(), z.unknown()).optional(),
  ci_rules: z.array(CiRuleInputSchema).optional(),
  hotspots: nameList.optional(),
  conventions: nameList.optional(),
};

export const ProjectConfigSchema = z
  .object({
    version: z.literal(1),
    extends: nameList.optional(),
    ...sharedProjectKeys,
    ci: z.object({ required_checks: nameList.optional() }).strict().optional(),
    pools: z.record(z.string(), z.number().int().positive()).optional(),
    profile: z.string().min(1).optional(),
    pr_template: z.string().min(1).max(255).optional(),
    review_template: z.string().min(1).max(255).optional(),
    /** Closed object: only `method`; absent object or key means squash (SPEC §14.2). */
    merge: z
      .object({ method: z.enum(MERGE_METHODS).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type RawProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const PackSchema = z
  .object({ version: z.literal(1).optional(), ...sharedProjectKeys })
  .strict();

export const PROJECT_ONLY_KEYS = [
  'ci',
  'pools',
  'extends',
  'profile',
  'pr_template',
  'review_template',
  'merge',
] as const;

export const PROJECT_KEYS = [
  ...Object.keys(sharedProjectKeys),
  'ci',
  'extends',
  'profile',
  'pr_template',
  'review_template',
  'merge',
] as const;
