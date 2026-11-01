import { z } from 'zod';
import { parseDuration } from '../shared/duration.ts';
import {
  AUTHZ_ROLES,
  EFFORTS,
  MAX_QUALITY_TRIES_PER_RUNG,
} from '../domain/policy.ts';
import { HARNESS_INNER_MODES, RuntimeLimitsSchema } from '../domain/runtime.ts';
import { EXECUTION_MODES } from '../domain/run-config.ts';
import {
  ACTIONS,
  DECISION_MODES,
  DECISION_POINTS,
  STEP_KINDS,
  WAIT_FOR,
} from '../domain/workflow.ts';
import { SOFTWARE_DEV_NAME } from '../engine/workflows/software-dev.ts';

/**
 * Configuration durations must be positive: they represent limits or intervals. Normalize to
 * milliseconds later.
 */
export const DurationSchema = z.string().refine(
  (s) => {
    const r = parseDuration(s);
    return r.ok && r.value > 0;
  },
  {
    message:
      'Invalid duration; use a positive integer followed by ms, s, m, h, or d (e.g. 45s, 10m, 6h)',
  },
);

export const RawPredicateSchema = z.record(z.string(), z.unknown());

const nameList = z.array(z.string().min(1));

export const HarnessSchema = z
  .object({
    cmd: z.string().min(1),
    auth: z.enum(['subscription', 'api_key']),
    pool: z.string().min(1),
  })
  .strict();

export const ModelSchema = z
  .object({
    harness: z.string().min(1),
    id: z.string().min(1),
    tier: z.number().int().nonnegative(),
  })
  .strict();

export const BindingRuleSchema = z
  .object({
    when: RawPredicateSchema.optional(),
    model: z.string().min(1),
    effort: z.enum(EFFORTS).optional(),
  })
  .strict();

export const LadderStepSchema = z
  .object({
    effort: z.enum(EFFORTS).optional(),
    model: z.string().min(1).optional(),
    add_context: nameList.min(1).optional(),
  })
  .strict()
  .refine(
    (s) =>
      s.effort !== undefined ||
      s.model !== undefined ||
      s.add_context !== undefined,
    {
      message:
        'A ladder rung must change at least one of: effort, model, add_context',
    },
  );

export const RoleSchema = z
  .object({
    when_use: z.string().optional(),
    prompt: z.string().min(1).optional(),
    context: nameList.optional(),
    output_schema: z.string().min(1).optional(),
    permissions: z.enum(['read_only', 'write']).optional(),
    session: z.string().min(1).optional(),
    binding: z.array(BindingRuleSchema).min(1),
    limits: z
      .object({
        max_turns: z.number().int().positive().optional(),
        stall_timeout: DurationSchema.optional(),
        wall_timeout: DurationSchema.optional(),
      })
      .strict()
      .optional(),
    escalation: z
      .object({
        ladder: z.array(LadderStepSchema).optional(),
        scope: z.enum(['step', 'task']).optional(),
        handoff: z.enum(['fresh_with_dossier', 'resume']).optional(),
        workspace: z.enum(['keep', 'reset_to_checkpoint']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RawRole = z.infer<typeof RoleSchema>;

export const UserStepSchema = z
  .object({
    kind: z.enum(STEP_KINDS).optional(),
    role: z.string().min(1).optional(),
    run: nameList.optional(),
    required: nameList.optional(),
    action: z.enum(ACTIONS).optional(),
    for: z.enum(WAIT_FOR).optional(),
    rules: z.literal('ci_rules').optional(),
    poll: DurationSchema.optional(),
    timeout: DurationSchema.optional(),
    uses: nameList.optional(),
    max_visits: z.number().int().positive().optional(),
    max_rung: z.number().int().nonnegative().optional(),
    on_exhausted: z.string().min(1).optional(),
    when: RawPredicateSchema.optional(),
    skip_when: RawPredicateSchema.optional(),
    auto_when: RawPredicateSchema.optional(),
    next: z.record(z.string(), z.string().min(1)).optional(),
  })
  .strict();
export type RawStep = z.infer<typeof UserStepSchema>;

/**
 * A workflow either extends software_dev@1 or declares a complete graph. A changed built-in graph
 * gets a different structure_hash and is rejected at freeze time.
 */
export const UserWorkflowSchema = z
  .object({
    base: z.literal(SOFTWARE_DEV_NAME).optional(),
    start: z.string().min(1).optional(),
    steps: z.record(z.string(), UserStepSchema).optional(),
    decisions: z
      .partialRecord(z.enum(DECISION_POINTS), z.enum(DECISION_MODES))
      .optional(),
  })
  .strict()
  .superRefine((w, ctx) => {
    if (w.base !== undefined) return;
    if (w.start === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['start'],
        message: 'A workflow without a base requires start',
      });
    if (w.steps === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['steps'],
        message: 'A workflow without a base requires steps',
      });
  });
export type RawWorkflow = z.infer<typeof UserWorkflowSchema>;

export const BackoffInputSchema = z
  .object({
    base: DurationSchema,
    factor: z.number().positive().max(100),
    max: DurationSchema,
    max_attempts: z.number().int().nonnegative().max(1000),
  })
  .strict();

export const ProfileSchema = z
  .object({
    extends: z.string().min(1).optional(),
    workflow: z.string().min(1).optional(),
    allow_roles: nameList.optional(),
    allow_models: nameList.optional(),
    allow_no_gates: z.boolean().optional(),
    budgets: z
      .object({
        max_agent_runs: z.number().int().positive().optional(),
        max_wall: DurationSchema.optional(),
        max_decider_calls: z.number().int().nonnegative().optional(),
        max_cost_usd: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    escalation: z
      .object({
        enabled: z.boolean().optional(),
        auto_up_to_tier: z.number().int().nonnegative().optional(),
        above: z.enum(['ask_human', 'deny']).optional(),
        max_escalations_per_task: z.number().int().nonnegative().optional(),
        trust_agent_signal: z.boolean().optional(),
      })
      .strict()
      .optional(),
    limits: z
      .object({
        classes: z
          .object({
            infra_retries: z.number().int().nonnegative().optional(),
            timeout_retries: z.number().int().nonnegative().optional(),
            invalid_output_repairs: z.number().int().nonnegative().optional(),
            invalid_output_fresh: z.number().int().nonnegative().optional(),
            quality_tries_per_rung: z
              .number()
              .int()
              .positive()
              .max(MAX_QUALITY_TRIES_PER_RUNG)
              .optional(),
          })
          .strict()
          .optional(),
        backoff: z
          .object({
            rate_limit: BackoffInputSchema.optional(),
            infra: BackoffInputSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),

    overridable: nameList.optional(),
  })
  .strict();
export type RawProfile = z.infer<typeof ProfileSchema>;

/**
 * Validate path syntax here; realpath, permissions, and Git-directory checks belong to
 * preflight/doctor.
 */
export function isCleanAbsolutePath(p: string): boolean {
  if (!p.startsWith('/') || p.includes('\0') || p.length > 4096) return false;
  const segs = p.slice(1).split('/');
  return segs.every((s) => s !== '' && s !== '.' && s !== '..');
}

export const AbsolutePathSchema = z.string().refine(isCleanAbsolutePath, {
  message:
    'Expected a normalized absolute path without `.`, `..`, empty segments, or a trailing `/`',
});

export const RepoSlugSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/,
    { message: 'repo must be a GitHub repository in owner/repo format' },
  );

export const ProjectEntrySchema = z
  .object({
    path: AbsolutePathSchema.optional(),
    repo: RepoSlugSchema.optional(),
    base_branch: z.string().min(1),
    protected_branches: nameList.optional(),
  })
  .strict();

export const RUNTIME_TOOLS = [
  'git',
  'gh',
  'systemd-run',
  'bwrap',
  'flock',
] as const;
export type RuntimeTool = (typeof RUNTIME_TOOLS)[number];

const RefNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, {
  message:
    'Names must start with a letter or digit and contain only letters, digits, underscores, periods, or hyphens (maximum: 64 characters)',
});

function unique<T>(xs: readonly T[]): boolean {
  return new Set(xs).size === xs.length;
}

export const AccessTokenSchema = z
  .object({
    id: RefNameSchema,
    actor: z.string().min(1).max(128),
    roles: z
      .array(z.enum(AUTHZ_ROLES))
      .min(1)
      .refine(unique, { message: 'roles must not contain duplicates' }),
    projects: z
      .array(z.string().min(1))
      .min(1)
      .refine(unique, { message: 'projects must not contain duplicates' }),
    token_file: AbsolutePathSchema,
  })
  .strict();
export type AccessTokenSpec = z.infer<typeof AccessTokenSchema>;

/** `harness/model/effort`, the form `--worker` and `--reviewer` take. */
const RunChoiceTextSchema = z
  .string()
  .regex(
    new RegExp(`^[^/\\s]+/[^/\\s]+/(${EFFORTS.join('|')})$`),
    'Use harness/model/effort',
  );

const DispatchChoiceSchema = z
  .object({
    profile: z.string().min(1),
    mode: z.enum(EXECUTION_MODES),
    /** Ordered alternatives for the assistant to propose from; cusrd never ranks them. */
    use: z
      .array(
        z
          .object({
            worker: RunChoiceTextSchema,
            reviewer: RunChoiceTextSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    why: z.string().min(1).max(4_000).optional(),
  })
  .strict();

const DispatchRuleSchema = DispatchChoiceSchema.extend({
  when: z.string().min(1).max(4_000),
  why: z.string().min(1).max(4_000),
}).strict();

export const DispatchSchema = z
  .object({
    rules: z.array(DispatchRuleSchema).max(100),
    default: DispatchChoiceSchema,
  })
  .strict();
export type RawDispatch = z.infer<typeof DispatchSchema>;

/** Runtime limits override defaults individually; check cross-field constraints after merging them. */
export const RuntimeSchema = z
  .object({
    data_dir: AbsolutePathSchema.optional(),
    limits: RuntimeLimitsSchema.partial().optional(),
    tool_paths: z
      .partialRecord(z.enum(RUNTIME_TOOLS), AbsolutePathSchema)
      .optional(),
    credential_refs: z.record(RefNameSchema, AbsolutePathSchema).optional(),
    access_tokens: z.array(AccessTokenSchema).optional(),
    harness_isolation: z
      .record(z.string().min(1), z.enum(HARNESS_INNER_MODES))
      .optional(),
    /**
     * Execution modes the user allows, each with natural-language guidance for the assistant that
     * proposes a mode (task-execution-modes.md). cusrd passes the guidance on as written and never decides
     * anything from it; absent = both allowed.
     */
    modes: z
      .partialRecord(
        z.enum(EXECUTION_MODES),
        z.object({ when_to_use: z.string().min(1).max(4_000) }).strict(),
      )
      .optional(),
    /**
     * Guidance for the assistant that proposes run settings, served by `cusr dispatch`. cusrd checks the
     * choices at load and never reads `when`; the user still confirms the selection (docs/architecture.md §5.1).
     */
    dispatch: DispatchSchema.optional(),
  })
  .strict();
export type RawRuntime = z.infer<typeof RuntimeSchema>;

export const UserConfigSchema = z
  .object({
    version: z.literal(1),
    harnesses: z.record(z.string(), HarnessSchema).optional(),
    pools: z.record(z.string(), z.number().int().positive()).optional(),
    models: z.record(z.string(), ModelSchema).optional(),
    roles: z.record(z.string(), RoleSchema).optional(),
    workflows: z.record(z.string(), UserWorkflowSchema).optional(),
    profiles: z.record(z.string(), ProfileSchema).optional(),
    projects: z.record(z.string(), ProjectEntrySchema).optional(),
    permissions: z
      .record(z.string(), z.enum(['read_only', 'write']))
      .optional(),
    yolo: z.boolean().optional(),
    runtime: RuntimeSchema.optional(),
  })
  .strict();
export type RawUserConfig = z.infer<typeof UserConfigSchema>;

export const USER_ONLY_KEYS = [
  'harnesses',
  'models',
  'roles',
  'workflows',
  'profiles',
  'projects',
  'permissions',
  'yolo',
  'runtime',
] as const;
