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
 * Thời lượng dạng `45s`, `10m`, `6h`, phải lớn hơn 0; đổi sang ms ở normalize.ts. Mọi thời lượng trong
 * cấu hình đều là trần hoặc chu kỳ nên `0s` không có nghĩa và bị FrozenPolicy từ chối.
 */
export const DurationSchema = z.string().refine(
  (s) => {
    const r = parseDuration(s);
    return r.ok && r.value > 0;
  },
  {
    message:
      'thời lượng không hợp lệ (số nguyên dương + ms|s|m|h|d, ví dụ 45s, 10m, 6h)',
  },
);

/** Predicate thô; khoá và kiểu giá trị được kiểm ở checks.ts (FR-003 kiểm tra 6). */
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
        'nấc thang phải đổi ít nhất một trong effort, model, add_context',
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

/** Bước trong cấu hình người dùng: như `StepSchema` nhưng thời lượng là chuỗi và predicate còn thô. */
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
 * Workflow: hoặc tham chiếu `base: software_dev@1` và chỉnh tham số từng bước, hoặc khai báo đủ graph
 * (`start` + `steps`). Đổi graph của workflow dựng sẵn làm `structure_hash` khác, nên bị báo
 * `unsupported_workflow` khi chốt (R-11).
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
        message: 'workflow không có base cần start',
      });
    if (w.steps === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['steps'],
        message: 'workflow không có base cần steps',
      });
  });
export type RawWorkflow = z.infer<typeof UserWorkflowSchema>;

/** `profiles.<name>.limits.backoff.<lớp>`; khai báo thì phải đủ cận trên (contracts/config.md "Backoff"). */
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
    /** Đường dẫn khoá được override khi tạo task, ví dụ `roles.reviewer.binding`, `budgets.max_agent_runs`. */
    overridable: nameList.optional(),
  })
  .strict();
export type RawProfile = z.infer<typeof ProfileSchema>;

/**
 * Đường dẫn tuyệt đối dạng chuẩn: không `.`/`..`, không đoạn rỗng, không NUL. Chỉ kiểm hình dạng; realpath,
 * quyền và git common dir là I/O của preflight/doctor.
 */
export function isCleanAbsolutePath(p: string): boolean {
  if (!p.startsWith('/') || p.includes('\0') || p.length > 4096) return false;
  const segs = p.slice(1).split('/');
  return segs.every((s) => s !== '' && s !== '.' && s !== '..');
}

export const AbsolutePathSchema = z.string().refine(isCleanAbsolutePath, {
  message:
    'cần đường dẫn tuyệt đối dạng chuẩn (không `.`, `..`, đoạn rỗng hay `/` cuối)',
});

/** Slug GitHub `owner/repo`; ID bất biến của repo lấy ở preflight. */
export const RepoSlugSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/,
    { message: 'repo phải là slug GitHub dạng owner/repo' },
  );

export const ProjectEntrySchema = z
  .object({
    path: AbsolutePathSchema.optional(),
    repo: RepoSlugSchema.optional(),
    base_branch: z.string().min(1),
    protected_branches: nameList.optional(),
  })
  .strict();

// ---------- Runtime của daemon 002 (contracts/cli-daemon.md "Cấu hình mở rộng tối thiểu") ----------

export const RUNTIME_TOOLS = [
  'git',
  'gh',
  'systemd-run',
  'bwrap',
  'flock',
] as const;
export type RuntimeTool = (typeof RUNTIME_TOOLS)[number];

const RefNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, {
  message: 'tên chỉ gồm chữ, số, `_`, `.`, `-` (tối đa 64)',
});

function unique<T>(xs: readonly T[]): boolean {
  return new Set(xs).size === xs.length;
}

/** Token riêng (contracts/cli-daemon.md "Token riêng cho assistant"): chỉ metadata và file, không secret. */
export const AccessTokenSchema = z
  .object({
    id: RefNameSchema,
    actor: z.string().min(1).max(128),
    roles: z
      .array(z.enum(AUTHZ_ROLES))
      .min(1)
      .refine(unique, { message: 'roles không được lặp' }),
    projects: z
      .array(z.string().min(1))
      .min(1)
      .refine(unique, { message: 'projects không được lặp' }),
    token_file: AbsolutePathSchema,
  })
  .strict();
export type AccessTokenSpec = z.infer<typeof AccessTokenSchema>;

/**
 * `runtime:` đóng; mọi khoá tuỳ chọn. Trần số trong `limits` là override từng phần trên
 * `DEFAULT_RUNTIME_LIMITS`; ràng buộc chéo kiểm sau khi hợp nhất (checks.ts `checkRuntime`).
 */
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
     * proposes a mode (task-execution-modes.md). cusrd never reads the guidance; absent = both allowed.
     */
    modes: z
      .partialRecord(
        z.enum(EXECUTION_MODES),
        z.object({ when_to_use: z.string().min(1).max(4_000) }).strict(),
      )
      .optional(),
  })
  .strict();
export type RawRuntime = z.infer<typeof RuntimeSchema>;

/** `~/.cusr/config.yaml` (contracts/config.md "Thẩm quyền theo file"). */
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

/** Khoá chỉ thuộc cấu hình người dùng; xuất hiện trong `cusr.yaml` hay pack là `forbidden_key`. */
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
