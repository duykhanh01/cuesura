import { z } from 'zod';
import { HashSchema } from '../shared/brand.ts';
import { WorkflowSchema } from './workflow.ts';

export const POLICY_SCHEMA_VERSION = 1;

export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];
export const EFFORT_RANK: Record<Effort, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export const LevelSchema = z
  .object({ tier: z.number().int(), effort_rank: z.number().int() })
  .strict();
export type Level = z.infer<typeof LevelSchema>;

export function levelKey(l: Level): string {
  return `${l.tier}:${l.effort_rank}`;
}

export function compareLevel(a: Level, b: Level): number {
  return a.tier !== b.tier ? a.tier - b.tier : a.effort_rank - b.effort_rank;
}

export const BindingSchema = z
  .object({
    harness: z.string(),
    model: z.string(),
    model_id: z.string(),
    effort: z.enum(EFFORTS),
    add_context: z.array(z.string()),
    permissions: z.enum(['read_only', 'write']),
    limits: z
      .object({
        max_turns: z.number().int().positive().nullable(),
        stall_timeout_ms: z.number().int().positive().nullable(),
        wall_timeout_ms: z.number().int().positive().nullable(),
      })
      .strict(),
  })
  .strict();
export type Binding = z.infer<typeof BindingSchema>;

export function bindingName(b: Binding): string {
  const ctx = b.add_context.length > 0 ? `+${b.add_context.join('+')}` : '';
  return `${b.model}/${b.effort}${ctx}`;
}

export const RUNG_STATES = ['auto', 'needs_approval', 'denied'] as const;
export type RungState = (typeof RUNG_STATES)[number];

export const RungSchema = z
  .object({
    binding: BindingSchema,
    level: LevelSchema,
    state: z.enum(RUNG_STATES),
  })
  .strict();
export type Rung = z.infer<typeof RungSchema>;

export const StepPolicySchema = z
  .object({
    role: z.string(),
    binding: BindingSchema,
    ladder: z.array(RungSchema).min(1),
    floor_map: z.record(z.string(), z.number().int().nonnegative()),
    escalation_scope: z.enum(['step', 'task']),
  })
  .strict();
export type StepPolicy = z.infer<typeof StepPolicySchema>;

export const CI_CLASSES = ['flaky_or_infra', 'autofix', 'code'] as const;
export type CiClass = (typeof CI_CLASSES)[number];

export const CiRuleSchema = z
  .object({
    match: z
      .object({
        job: z.string().optional(),
        check: z.string().optional(),
        log_pattern: z.string().max(256).optional(),
      })
      .strict(),
    class: z.enum(CI_CLASSES),
  })
  .strict();
export type CiRule = z.infer<typeof CiRuleSchema>;

export const BackoffSchema = z
  .object({
    base_ms: z.number().int().positive(),
    factor: z.number().positive(),
    max_ms: z.number().int().positive(),
    max_attempts: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type Backoff = z.infer<typeof BackoffSchema>;

export const LimitsSchema = z
  .object({
    max_agent_runs: z.number().int().positive().nullable(),
    /** Read-only: present in snapshots frozen before decider support was removed. */
    max_decider_calls: z.number().int().nonnegative().optional(),
    max_wall_ms: z.number().int().positive().nullable(),
    max_escalations: z.number().int().nonnegative().nullable(),
    classes: z
      .object({
        infra_retries: z.number().int().nonnegative().nullable(),
        timeout_retries: z.number().int().nonnegative(),
        invalid_output_repairs: z.number().int().nonnegative(),
        invalid_output_fresh: z.number().int().nonnegative(),
        quality_tries_per_rung: z.number().int().positive(),
      })
      .strict(),
    backoff: z.object({ rate_limit: BackoffSchema, infra: BackoffSchema }).strict(),
    /**
     * Only admin amendments add visits here. A `recheck` may also give back visits spent on attempts
     * that failed before doing any work (`TaskState.visit_credits`); quality failures never.
     */
    extra_visits: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();
export type Limits = z.infer<typeof LimitsSchema>;

export const GatePolicySchema = z
  .object({
    commands: z.record(z.string(), z.string()),
    by_step: z.record(
      z.string(),
      z
        .object({
          run: z.array(z.string()),
          required: z.array(z.string()),
          skipped: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();

export const ConfigHashesSchema = z
  .object({
    user: HashSchema,
    project: HashSchema.nullable(),
    packs: z.record(z.string(), HashSchema),
    effective: HashSchema,
  })
  .strict();

/** policy_hash covers every other field. */
export const FrozenPolicySchema = z
  .object({
    schema_version: z.literal(POLICY_SCHEMA_VERSION),
    task_id: z.string(),
    revision: z.number().int().positive(),
    base_sha: z.string().min(1),
    project: z.string(),
    profile: z.string(),
    workflow_name: z.string(),
    workflow: WorkflowSchema,
    structure_hash: HashSchema,
    steps: z.record(z.string(), StepPolicySchema),
    ci: z
      .object({
        required_checks: z.array(z.string()),
        rules: z.array(CiRuleSchema),
      })
      .strict(),
    gates: GatePolicySchema,
    limits: LimitsSchema,
    /** Read-only: present in snapshots frozen before decider support was removed. */
    decision_modes: z.record(z.string(), z.literal('human')).optional(),
    permissions: z.record(z.string(), z.enum(['read_only', 'write'])),
    protected_branches: z.array(z.string()),
    config_hashes: ConfigHashesSchema,
    policy_version: z.number().int().positive(),
    policy_hash: HashSchema,
  })
  .strict();
export type FrozenPolicy = z.infer<typeof FrozenPolicySchema>;

export const FrozenAttachmentSchema = z
  .object({
    name: z.string(),
    media_type: z.string(),
    content: z.string(),
    content_hash: HashSchema,
  })
  .strict();

export const FrozenDocSchema = z
  .object({
    name: z.string().min(1),
    content: z.string(),
    content_hash: HashSchema,
  })
  .strict();
export type FrozenDoc = z.infer<typeof FrozenDocSchema>;

export const FrozenExecutionContextSchema = z
  .object({
    schema_version: z.literal(POLICY_SCHEMA_VERSION),
    task_id: z.string(),
    revision: z.number().int().positive(),
    base_sha: z.string().min(1),
    request: z
      .object({
        title: z.string(),
        description: z.string(),
        requirements: z.array(z.string()),
        constraints: z.array(z.string()),
        out_of_scope: z.array(z.string()),
      })
      .strict(),
    acceptance: z.array(z.string()),
    attachments: z.array(FrozenAttachmentSchema),

    prompt_refs: z.array(FrozenDocSchema),

    conventions: z.array(FrozenDocSchema),
    context_hash: HashSchema,
  })
  .strict();
export type FrozenExecutionContext = z.infer<typeof FrozenExecutionContextSchema>;

export const AUTHZ_ROLES = ['read', 'operate', 'admin'] as const;
export type AuthzRole = (typeof AUTHZ_ROLES)[number];

export const AuthzContextSchema = z
  .object({
    actor: z.string().min(1),
    roles: z.array(z.enum(AUTHZ_ROLES)),
    issued_by: z.string().min(1),
    issued_at: z.number().int().nonnegative(),
  })
  .strict();
export type AuthzContext = z.infer<typeof AuthzContextSchema>;

export function hasRole(a: AuthzContext | null | undefined, role: AuthzRole): boolean {
  return a !== null && a !== undefined && a.roles.includes(role);
}
