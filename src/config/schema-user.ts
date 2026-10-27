import { z } from 'zod';
import { parseDuration } from '../shared/duration.ts';
import { EFFORTS } from '../domain/policy.ts';
import { ACTIONS, DECISION_MODES, DECISION_POINTS, STEP_KINDS, WAIT_FOR } from '../domain/workflow.ts';
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
  { message: 'thời lượng không hợp lệ (số nguyên dương + ms|s|m|h|d, ví dụ 45s, 10m, 6h)' },
);

/** Predicate thô; khoá và kiểu giá trị được kiểm ở checks.ts (FR-003 kiểm tra 6). */
export const RawPredicateSchema = z.record(z.string(), z.unknown());

const nameList = z.array(z.string().min(1));

export const HarnessSchema = z
  .object({ cmd: z.string().min(1), auth: z.enum(['subscription', 'api_key']), pool: z.string().min(1) })
  .strict();

export const ModelSchema = z
  .object({ harness: z.string().min(1), id: z.string().min(1), tier: z.number().int().nonnegative() })
  .strict();

export const BindingRuleSchema = z
  .object({ when: RawPredicateSchema.optional(), model: z.string().min(1), effort: z.enum(EFFORTS).optional() })
  .strict();

export const LadderStepSchema = z
  .object({
    effort: z.enum(EFFORTS).optional(),
    model: z.string().min(1).optional(),
    add_context: nameList.min(1).optional(),
  })
  .strict()
  .refine((s) => s.effort !== undefined || s.model !== undefined || s.add_context !== undefined, {
    message: 'nấc thang phải đổi ít nhất một trong effort, model, add_context',
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
    decisions: z.partialRecord(z.enum(DECISION_POINTS), z.enum(DECISION_MODES)).optional(),
  })
  .strict()
  .superRefine((w, ctx) => {
    if (w.base !== undefined) return;
    if (w.start === undefined) ctx.addIssue({ code: 'custom', path: ['start'], message: 'workflow không có base cần start' });
    if (w.steps === undefined) ctx.addIssue({ code: 'custom', path: ['steps'], message: 'workflow không có base cần steps' });
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
            quality_tries_per_rung: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        backoff: z
          .object({ rate_limit: BackoffInputSchema.optional(), infra: BackoffInputSchema.optional() })
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

export const ProjectEntrySchema = z
  .object({
    repo: z.string().min(1).optional(),
    base_branch: z.string().min(1),
    protected_branches: nameList.optional(),
  })
  .strict();

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
    permissions: z.record(z.string(), z.enum(['read_only', 'write'])).optional(),
    yolo: z.boolean().optional(),
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
] as const;
