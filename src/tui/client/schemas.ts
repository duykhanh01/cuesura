/**
 * What the interface accepts from the daemon (EC-010). A response that does not match is reported as
 * incompatible instead of being guessed at. Every string meant for display comes out as `SafeText`, at this
 * boundary, so it cannot reach the screen unsanitized (FR-037). Identifiers stay plain strings: they go
 * back to the daemon as they came, and a plain string cannot be drawn without passing `sanitize`. Objects
 * are open so an added field from a newer daemon is not an error.
 */
import { z } from 'zod';
import { TASK_STATUSES } from '../../domain/state.ts';
import { UuidSchema } from '../../shared/brand.ts';
import { sanitize, sanitizeLines } from '../terminal/safe-text.ts';

const safe = z.string().transform(sanitize);
const safeBlock = z.string().transform(sanitizeLines);
const taskId = UuidSchema;

const SlotSchema = z.looseObject({
  holder_task_id: taskId,
  request_id: z.string(),
  claimed_at: z.number(),
});

export const HealthDataSchema = z.looseObject({
  store: z.looseObject({ writable: z.boolean() }),
  dispatch: z.looseObject({}),
  slot: SlotSchema.nullable(),
  queue_length: z.number().int().nonnegative(),
  now: z.number(),
});
/** Healthy or not is the daemon's word; `reason` is what it gave (FR-010). */
export type Health = {
  readonly healthy: boolean;
  readonly reason: ReturnType<typeof sanitize> | null;
  readonly slot: z.infer<typeof SlotSchema> | null;
  readonly queue_length: number;
};

const CallerSchema = z.looseObject({
  actor: safe,
  roles: z.array(z.string()),
  scope: z.enum(['all', 'limited']),
  trusted_confirmer: z.boolean(),
});
export type CallerInfo = z.infer<typeof CallerSchema>;

export const ProjectListSchema = z.looseObject({
  caller: CallerSchema,
  projects: z.array(z.looseObject({ id: z.string(), repo: safe.nullable() })),
  profiles: z.array(z.string()),
});
export type ProjectList = z.infer<typeof ProjectListSchema>;

const BoardRowSchema = z.looseObject({
  task_id: taskId,
  project: z.string(),
  title: safe,
  status: z.enum(TASK_STATUSES),
  wait_code: z.string().nullable(),
  step: safe.nullable(),
  mode: safe.nullable(),
  status_since: z.number().nullable(),
  version: z.number().int().nonnegative(),
  priority: z.number().int(),
  pr_ref: safe.nullable(),
  needs_user: z.boolean(),
});
export type BoardRow = z.infer<typeof BoardRowSchema>;

const BoardDataSchema = z.looseObject({
  unchanged: z.literal(false),
  watermark: z.number().int().nonnegative(),
  counts: z.looseObject({
    by_status: z.partialRecord(z.enum(TASK_STATUSES), z.number().int()),
  }),
  queue: z.looseObject({ length: z.number().int().nonnegative() }),
  attention: z.looseObject({
    items: z.array(BoardRowSchema),
    truncated: z.boolean(),
  }),
  items: z.array(BoardRowSchema),
  next_cursor: z.string().nullable(),
});
export type BoardData = z.infer<typeof BoardDataSchema>;

export const BoardSchema = z.union([
  z.looseObject({
    unchanged: z.literal(true),
    watermark: z.number().int().nonnegative(),
  }),
  BoardDataSchema,
]);
export type BoardReply = z.infer<typeof BoardSchema>;

const ChoiceSchema = z.looseObject({
  harness: safe,
  model: safe,
  effort: safe,
});

export const RunOptionsSchema = z.looseObject({
  task_id: taskId,
  revision: z.number().int(),
  version: z.number().int(),
  profile: z.looseObject({ id: safe, source: z.enum(['task', 'project']) }),
  modes: z.array(
    z.looseObject({
      mode: z.enum(['direct-pr', 'full-review']),
      when_to_use: safeBlock.nullable(),
      reviewers: z.array(ChoiceSchema),
      workers: z.array(
        z.looseObject({
          choice: ChoiceSchema,
          fallbacks: z.array(ChoiceSchema),
        }),
      ),
    }),
  ),
  truncated: z.boolean(),
});
export type RunOptions = z.infer<typeof RunOptionsSchema>;

const RunConfigSchema = z.looseObject({
  status: z.enum(['proposed', 'confirmed', 'stale']),
  digest: z.string(),
  mode: safe,
  proposed_by: safe,
  confirmed_by: safe.nullable(),
  selection: z.looseObject({
    revision: z.number().int(),
    profile: safe,
    mode: safe,
    reason: safeBlock,
    worker: ChoiceSchema,
    reviewer: ChoiceSchema.nullable(),
    fallbacks: z.array(ChoiceSchema),
  }),
});

export const TaskContentSchema = z.looseObject({
  task_id: taskId,
  project: z.string(),
  version: z.number().int(),
  revision: z.number().int(),
  base_branch: safe,
  title: safe,
  description: safeBlock,
  requirements: z.array(safeBlock),
  acceptance: z.array(safeBlock),
  constraints: z.array(safeBlock),
  out_of_scope: z.array(safeBlock),
  depends_on: z.array(taskId),
  priority: z.number().int(),
  intake_pending: z.boolean(),
  run_config: RunConfigSchema.nullable(),
});
export type TaskContent = z.infer<typeof TaskContentSchema>;

export const TaskProgressSchema = z.looseObject({
  task_id: taskId,
  version: z.number().int(),
  mode: safe.nullable(),
  steps: z
    .array(
      z.looseObject({
        name: safe,
        state: z.enum(['past', 'current', 'remaining', 'not_required']),
        visits: z.number().int().nonnegative(),
      }),
    )
    .nullable(),
  reason: safe.nullable(),
  needs_user: z.boolean(),
  worktree_path: safe.nullable(),
});
export type TaskProgress = z.infer<typeof TaskProgressSchema>;

const LogRecordSchema = z.union([
  z.looseObject({
    seq: z.number().int(),
    cursor: z.number().int(),
    operation_id: z.string(),
    attempt_id: z.string().nullable(),
    gap: z.looseObject({ records: z.number().int(), reason: safe }),
  }),
  z.looseObject({
    seq: z.number().int(),
    cursor: z.number().int(),
    operation_id: z.string(),
    attempt_id: z.string().nullable(),
    step: safe.nullable(),
    at: safe,
    kind: safe,
    // Free-form: a view turns it into text with `sanitize` when it draws it.
    data: z.unknown(),
  }),
]);

export const TaskLogsSchema = z.looseObject({
  task_id: taskId,
  records: z.array(LogRecordSchema),
  next_cursor: z.number().int(),
  complete: z.boolean(),
});
export type TaskLogs = z.infer<typeof TaskLogsSchema>;

export const RequestShowSchema = z.looseObject({
  request_id: z.string(),
  kind: safe,
  state: z.enum(['completed', 'in_progress', 'interrupted']),
  project: z.string().nullable(),
  task_id: taskId.nullable(),
  admitted_at: z.number(),
  completed_at: z.number().nullable(),
  outcome: z
    .union([
      z.looseObject({ ok: z.literal(true), value: z.unknown() }),
      z.looseObject({
        ok: z.literal(false),
        error: z.looseObject({ code: safe, message: safe }),
      }),
    ])
    .optional(),
  next_step: safe.nullable(),
});
export type RequestShow = z.infer<typeof RequestShowSchema>;

const WaitSchema = z.looseObject({
  reason: safe,
  detail: z.looseObject({ code: z.string() }),
  resume_when: z.array(safeBlock),
  exit_paths: z.array(safeBlock),
});

export const TaskShowSchema = z.looseObject({
  task_id: taskId,
  project: z.string(),
  title: safe,
  status: z.enum(TASK_STATUSES),
  version: z.number().int(),
  revision: z.number().int(),
  wait: WaitSchema.nullable(),
  pr_ref: safe.nullable(),
  head_sha: safe.nullable(),
  step: safe.nullable(),
  run_config: RunConfigSchema.nullable(),
});
export type TaskShow = z.infer<typeof TaskShowSchema>;

export const TaskExplainSchema = z.looseObject({
  task_id: taskId,
  version: z.number().int(),
  revision: z.number().int(),
  status: z.enum(TASK_STATUSES),
  step: safe.nullable(),
  // Unlike `task_show`, the explanation carries no `resume_when`: exits come from `allowed_actions`.
  wait: z
    .looseObject({
      reason: safe,
      detail: z.looseObject({ code: z.string() }),
    })
    .nullable(),
  allowed_actions: z.array(
    z.looseObject({
      action: z.string(),
      command: safe.nullable(),
      note: safeBlock,
    }),
  ),
});
export type TaskExplain = z.infer<typeof TaskExplainSchema>;

export const TaskHistorySchema = z.looseObject({
  task_id: taskId,
  events: z.array(
    z.looseObject({
      seq: z.number().int(),
      type: safe,
      revision: z.number().int(),
      actor: safe,
      // Free-form: a view turns it into text with `sanitize` when it draws it.
      payload: z.unknown(),
    }),
  ),
  next_cursor: z.number().int(),
  more: z.boolean(),
});
export type TaskHistory = z.infer<typeof TaskHistorySchema>;
