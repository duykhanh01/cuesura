import { z } from 'zod';
import { parseDuration } from '../shared/duration.ts';
import { EFFORTS } from '../domain/policy.ts';
import { HARNESS_INNER_MODES, RuntimeLimitsSchema } from '../domain/runtime.ts';
import { EXECUTION_MODES } from '../domain/run-config.ts';
import { isAgentStep, type StepDef } from '../domain/workflow.ts';
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
  .refine((s) => s.effort !== undefined || s.model !== undefined || s.add_context !== undefined, {
    message: 'A ladder rung must change at least one of: effort, model, add_context',
  });

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
        max_turns: z.number().int().positive().nullable().optional(),
        stall_timeout: DurationSchema.optional(),
        wall_timeout: DurationSchema.nullable().optional(),
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

export const STEP_TUNABLES = [
  'max_visits',
  'max_rung',
  'run',
  'required',
  'poll',
  'timeout',
] as const;
export type StepTunable = (typeof STEP_TUNABLES)[number];

/** `max_visits` only where the built-in step has one, so every bounded step keeps its `on_exhausted`. */
export function tunablesOf(step: StepDef): readonly StepTunable[] {
  const out: StepTunable[] = [];
  if (step.max_visits !== undefined) out.push('max_visits');
  if (isAgentStep(step)) out.push('max_rung');
  if (step.kind === 'gate') out.push('run', 'required');
  if (step.kind === 'wait') out.push('poll', 'timeout');
  return out;
}

export const REMOVED_WORKFLOW_KEYS = ['start', 'decisions'] as const;
export const REMOVED_STEP_KEYS = [
  'kind',
  'role',
  'action',
  'for',
  'rules',
  'uses',
  'on_exhausted',
  'when',
  'skip_when',
  'auto_when',
  'next',
] as const;

/** Loose so `checkWorkflowKeys` can report other keys with a precise message. */
export const UserStepSchema = z.looseObject({
  max_visits: z.number().int().positive().optional(),
  max_rung: z.number().int().nonnegative().optional(),
  run: nameList.optional(),
  required: nameList.optional(),
  poll: DurationSchema.optional(),
  timeout: DurationSchema.optional(),
});
export type RawStep = z.infer<typeof UserStepSchema>;

export const UserWorkflowSchema = z.looseObject({
  base: z.literal(SOFTWARE_DEV_NAME, {
    message: `base is required and must be ${SOFTWARE_DEV_NAME}`,
  }),
  steps: z.record(z.string(), UserStepSchema).optional(),
});
export type RawWorkflow = z.infer<typeof UserWorkflowSchema>;

export const BackoffInputSchema = z
  .object({
    base: DurationSchema,
    factor: z.number().positive().max(100),
    max: DurationSchema,
    max_attempts: z.number().int().nonnegative().max(1000).nullable(),
  })
  .strict();

export const ProfileSchema = z
  .object({
    extends: z.string().min(1).optional(),
    workflow: z.string().min(1).optional(),
    allow_roles: nameList.optional(),
    allow_models: nameList.optional(),
    allow_no_gates: z.boolean().optional(),
    escalation: z
      .object({
        enabled: z.boolean().optional(),
        auto_up_to_tier: z.number().int().nonnegative().optional(),
        above: z.enum(['ask_human', 'deny']).optional(),
        max_escalations_per_task: z.number().int().nonnegative().nullable().optional(),
        trust_agent_signal: z.boolean().optional(),
      })
      .strict()
      .optional(),
    limits: z
      .object({
        classes: z
          .object({
            infra_retries: z.number().int().nonnegative().nullable().optional(),
            timeout_retries: z.number().int().nonnegative().optional(),
            invalid_output_repairs: z.number().int().nonnegative().optional(),
            invalid_output_fresh: z.number().int().nonnegative().optional(),
            quality_tries_per_rung: z.number().int().positive().optional(),
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
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/, {
    message: 'repo must be a GitHub repository in owner/repo format',
  });

const DispatchNameSchema = z.string().regex(/^[^/\s]+$/, {
  message: 'Must not be empty or contain `/` or whitespace',
});

/** One concrete agent to run: joined into the `harness/model/effort` that `--worker` and `--reviewer` take. */
const DispatchAgentSchema = z
  .object({
    harness: DispatchNameSchema,
    model: DispatchNameSchema,
    effort: z.enum(EFFORTS),
  })
  .strict();
export type RawDispatchAgent = z.infer<typeof DispatchAgentSchema>;

const DispatchChoiceSchema = z
  .object({
    /** One agent or ordered alternatives for the assistant to propose from; cusrd never ranks them. */
    use: z.union([DispatchAgentSchema, z.array(DispatchAgentSchema).min(1).max(16)]),
    /** Present means `full-review`, absent means `direct-pr`, so the two can never disagree. */
    reviewer: DispatchAgentSchema.optional(),
    why: z.string().min(1).max(4_000).optional(),
  })
  .strict();
export type RawDispatchChoice = z.infer<typeof DispatchChoiceSchema>;

const DispatchRuleSchema = DispatchChoiceSchema.extend({
  when: z.string().min(1).max(4_000),
  why: z.string().min(1).max(4_000),
}).strict();

export const DispatchSchema = z
  .object({
    profile: z.string().min(1),
    rules: z.array(DispatchRuleSchema).max(100).default([]),
    default: DispatchChoiceSchema,
  })
  .strict();
export type RawDispatch = z.infer<typeof DispatchSchema>;

/**
 * `dispatch.yaml` beside the user config and a repo's `cusr.dispatch.yaml`, which replaces it as a whole.
 * Served by `cusr dispatch`: cusrd checks the choices and never reads `when`; the user still confirms the
 * selection (docs/architecture.md §5.1).
 */
export const DispatchFileSchema = DispatchSchema.extend({ version: z.literal(1) }).strict();

export const ProjectEntrySchema = z
  .object({
    path: AbsolutePathSchema.optional(),
    repo: RepoSlugSchema.optional(),
    base_branch: z.string().min(1),
    protected_branches: nameList.optional(),
    /** Removed: accepted so an old config still starts, and reported as ignored. */
    dispatch: z.unknown().optional(),
  })
  .strict();

export const RUNTIME_TOOLS = [
  'git',
  'gh',
  'systemd-run',
  'bwrap',
  'flock',
  'herdr',
  'orca',
  'paseo',
  'tmux',
] as const;
export type RuntimeTool = (typeof RUNTIME_TOOLS)[number];

const RefNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, {
  message:
    'Names must start with a letter or digit and contain only letters, digits, underscores, periods, or hyphens (maximum: 64 characters)',
});

/**
 * Where agent operations are shown (ADR-0006); only ever a view, the unit stays under systemd. A new backend
 * is one variant here and one case in `terminalHost`; its binary is the tool of the same name.
 */
export const RuntimeTerminalSchema = z.discriminatedUnion('backend', [
  z.object({ backend: z.literal('background') }).strict(),
  z
    .object({
      backend: z.literal('herdr'),
      /** Named herdr session; the default session, the one in daily use, when absent. */
      session: RefNameSchema.optional(),
    })
    .strict(),
  z.object({ backend: z.literal('orca') }).strict(),
  z.object({ backend: z.literal('paseo') }).strict(),
  z.object({ backend: z.literal('tmux') }).strict(),
]);
export type RuntimeTerminal = z.infer<typeof RuntimeTerminalSchema>;
export type AttachedTerminal = Exclude<RuntimeTerminal, { backend: 'background' }>;

export const MAX_CONCURRENCY = 64;
/** Thirty days: a reservation is meant to cover a wait for CI, a merge or a person, not to park a slot. */
export const MAX_SLOT_RESERVATION_HOURS = 720;

/** Runtime limits override defaults individually; check cross-field constraints after merging them. */
export const RuntimeSchema = z
  .object({
    data_dir: AbsolutePathSchema.optional(),
    /** How many tasks may hold an execution slot at once (FR-044.01); read when cusrd starts. */
    concurrency: z.number().int().positive().max(MAX_CONCURRENCY).optional(),
    /**
     * How long a task waiting outside keeps its slot reserved (FR-044.02); read when cusrd starts.
     * Past it the slot is free again and the task queues by priority when it comes back.
     */
    slot_reservation_hours: z.number().int().positive().max(MAX_SLOT_RESERVATION_HOURS).optional(),
    limits: RuntimeLimitsSchema.partial().optional(),
    tool_paths: z.partialRecord(z.enum(RUNTIME_TOOLS), AbsolutePathSchema).optional(),
    credential_refs: z.record(RefNameSchema, AbsolutePathSchema).optional(),
    terminal: RuntimeTerminalSchema.optional(),
    /** Removed: accepted so an old config still starts, and reported as ignored. */
    access_tokens: z.array(z.unknown()).optional(),
    harness_isolation: z.record(z.string().min(1), z.enum(HARNESS_INNER_MODES)).optional(),
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
    /** Removed: accepted so an old config still starts, and reported as ignored. */
    dispatch: z.unknown().optional(),
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
    permissions: z.record(z.string(), z.enum(['read_only', 'write'])).optional(),
    yolo: z.boolean().optional(),
    autonomous: z.boolean().optional(),
    /**
     * Requesters (`requested_by.id`, e.g. `assistant`) whose tasks are accepted without the intake
     * confirmation (SPEC.md intake rules). Read when a task is created; it never confirms a run config.
     */
    intake: z.object({ auto_confirm: nameList }).strict().optional(),
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
  'autonomous',
  'intake',
  'runtime',
] as const;
