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
  // Absent from a daemon older than the slot reservations (FR-044.02).
  reserved_at: z.number().nullable().optional(),
  borrower_task_id: taskId.nullable().optional(),
});

export const HealthDataSchema = z.looseObject({
  store: z.looseObject({ writable: z.boolean() }),
  dispatch: z.looseObject({}),
  slots: z.array(SlotSchema),
  concurrency: z.number().int().positive().default(1),
  queue_length: z.number().int().nonnegative(),
  now: z.number(),
});
/** Healthy or not is the daemon's word; `reason` is what it gave (FR-010). */
export type Health = {
  readonly healthy: boolean;
  readonly reason: ReturnType<typeof sanitize> | null;
  /** Held slots, in grant order, out of `concurrency` (FR-044.01). */
  readonly slots: readonly z.infer<typeof SlotSchema>[];
  readonly concurrency: number;
  readonly queue_length: number;
};

const CallerSchema = z.looseObject({
  actor: safe,
  roles: z.array(z.string()),
  trusted_confirmer: z.boolean(),
});
export type CallerInfo = z.infer<typeof CallerSchema>;

export const ProjectListSchema = z.looseObject({
  caller: CallerSchema,
  projects: z.array(z.looseObject({ id: z.string(), repo: safe.nullable() })),
  profiles: z.array(z.string()),
});
export type ProjectList = z.infer<typeof ProjectListSchema>;

/** Who paused a task or the queue, when and why (`task_pause`, `queue_pause`). */
const PauseSchema = z.looseObject({ reason: safe, by: safe, at: z.number() });
export type PauseInfo = z.infer<typeof PauseSchema>;

const BoardRowSchema = z.looseObject({
  task_id: taskId,
  project: z.string(),
  title: safe,
  status: z.enum(TASK_STATUSES),
  wait_code: z.string().nullable(),
  step: safe.nullable(),
  /** Absent from a daemon older than this TUI. */
  step_visits: z.record(z.string(), z.number().int().nonnegative()).optional(),
  mode: safe.nullable(),
  status_since: z.number().nullable(),
  version: z.number().int().nonnegative(),
  priority: z.number().int(),
  pr_ref: safe.nullable(),
  needs_user: z.boolean(),
  /** Absent from a daemon older than this TUI. */
  paused: PauseSchema.nullable().optional(),
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
  /** Absent from a daemon older than this TUI. */
  queue_paused: PauseSchema.nullable().optional(),
});
export type BoardData = z.infer<typeof BoardDataSchema>;

export const BoardSchema = z.union([
  z.looseObject({
    unchanged: z.literal(true),
    watermark: z.number().int().nonnegative(),
    // The queue pause lives outside the store: it changes without the watermark moving.
    queue_paused: PauseSchema.nullable().optional(),
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
    // Absent in selections made before reviewer fallbacks existed (#276).
    reviewer_fallbacks: z.array(ChoiceSchema).optional(),
  }),
  // What the mode means for review, by the daemon's word; absent or `null` before the run is frozen.
  review: safe.nullable().optional(),
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
  /** Where a `tail` page starts. */
  after: z.number().int().optional(),
  /** Records after `next_cursor` that did not fit in this page. */
  more: z.boolean().optional(),
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

/** The `data` of an accepted command; its shape depends on the command, so only the envelope is checked. */
export const CommandReplySchema = z.unknown();
export type CommandReply = z.infer<typeof CommandReplySchema>;

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
  completion: z
    .looseObject({
      merged_head_sha: safe,
      checked_head_sha: safe.nullable(),
      merge_commit_sha: safe.nullable(),
      unverified: z.looseObject({ reason: safe }).nullable(),
      finalized_at: z.number().nullable(),
    })
    .nullable(),
  provenance: z.looseObject({
    usage: z.array(
      z.looseObject({
        attempt_id: z.string(),
        step: safe,
        binding: safe,
        usage: z
          .looseObject({
            basis: z.enum(['reported', 'estimated', 'unavailable']),
            tokens: z.number().optional(),
            cost: z.number().optional(),
          })
          .nullable(),
      }),
    ),
  }),
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
  limits_frozen: z.boolean(),
  /** Absent from a daemon older than this TUI. */
  paused: PauseSchema.nullable().optional(),
  bindings_used: z.array(
    z.looseObject({
      step: safe,
      rung: z.number().int(),
      binding: safe,
      requested: z.number().int(),
      invoked: z.number().int(),
    }),
  ),
  remaining: z.looseObject({
    // Null when the policy sets no limit.
    agent_runs: z.number().nullable(),
    reserved: z.number(),
    escalations: z.number().nullable(),
  }),
  escalations: z.array(
    z.looseObject({
      step: safe,
      from: z.number().int(),
      to: z.number().int(),
      reason: safe,
      signature: safe.nullable(),
    }),
  ),
  pending_effects: z.array(z.looseObject({ kind: safe, status: safe })),
  cancellation: z.looseObject({ requested_at: z.number(), late: z.boolean() }).nullable(),
  blockers: z.array(z.looseObject({ code: safe, source: safe })),
  pr: z.looseObject({
    ref: safe.nullable(),
    head_sha: safe.nullable(),
    base_sha: safe.nullable(),
    observed: z.looseObject({ status: safe, observed_head: safe.nullable() }).nullable(),
    observation_expired: z.boolean(),
  }),
  deadline: z.looseObject({
    state: z.enum(['not_started', 'running', 'passed', 'ended']),
    remaining_ms: z.number().nullable(),
    max_wall_ms: z.number().nullable(),
  }),
  slot: z.looseObject({
    holding: z.boolean(),
    // Absent from a daemon older than the slot reservations (FR-044.07).
    hold: z
      .looseObject({ kind: z.enum(['running', 'reserved', 'borrowed']) })
      .nullable()
      .optional(),
    queued: z.looseObject({ position: z.number().nullable() }).nullable(),
    initial_wait_ms: z.number(),
    resumed_wait_ms: z.number(),
  }),
  prerequisites: z.array(
    z.looseObject({
      task_id: z.string(),
      status: safe,
      unverified: z.looseObject({ reason: safe }).nullable(),
      merged_head_sha: safe.nullable(),
      checked_head_sha: safe.nullable(),
    }),
  ),
  merge_cleanup: z
    .looseObject({
      merged_head_sha: safe,
      pending_operations: z.array(z.looseObject({ kind: safe, status: safe })),
    })
    .nullable(),
  merge: z
    .looseObject({
      method: safe.nullable(),
      proposed: z.looseObject({ title: safe, message: safeBlock }).nullable(),
      observed_method: safe.nullable(),
    })
    .nullable(),
  evidence: z.looseObject({
    gates: z.array(
      z.looseObject({
        revision: z.number().int(),
        step: safe,
        visit: z.number().int(),
        passed: z.boolean(),
        valid: z.boolean(),
        failed: z
          .array(z.looseObject({ gate: safe, log_excerpt: safeBlock.nullable() }))
          .optional(),
      }),
    ),
    reviews: z.array(
      z.looseObject({
        revision: z.number().int(),
        head_sha: safe,
        verdict: safe,
        valid: z.boolean(),
      }),
    ),
    review_skipped: z.array(z.looseObject({ revision: z.number().int(), valid: z.boolean() })),
    ci: z.array(
      z.looseObject({
        revision: z.number().int(),
        head_sha: safe,
        checks: z.array(z.looseObject({ name: safe, state: safe })),
        valid: z.boolean(),
      }),
    ),
  }),
});
export type TaskExplain = z.infer<typeof TaskExplainSchema>;

const GATE_LOG_STATES = ['available', 'expired', 'missing'] as const;

export const TaskGatesSchema = z.looseObject({
  task_id: taskId,
  running: z
    .looseObject({
      gate: safe,
      started_at: z.number(),
      last_output_at: z.number().nullable(),
    })
    .nullish()
    .transform((v) => v ?? null),
  rounds: z.array(
    z.looseObject({
      round: z.number().int(),
      passed: z.boolean(),
      gates: z.array(
        z.looseObject({
          // Kept as sent: `task_gate_log` is asked by this exact name.
          gate: z.string(),
          passed: z.boolean(),
          log: z.enum(GATE_LOG_STATES),
          bytes: z.number().optional(),
          wall_ms: z.number().optional(),
        }),
      ),
    }),
  ),
});
export type TaskGates = z.infer<typeof TaskGatesSchema>;

export const TaskGateLogSchema = z.looseObject({
  gate: z.string(),
  round: z.number().int(),
  state: z.enum(GATE_LOG_STATES),
  text: z.string().optional(),
  offset: z.number().int().optional(),
  next_offset: z.number().int().optional(),
  size: z.number().int().optional(),
});
export type TaskGateLog = z.infer<typeof TaskGateLogSchema>;

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

const InboxItemSchema = z.looseObject({
  question_id: z.string(),
  task_id: taskId,
  revision: z.number().int(),
  step: safe.nullable(),
  body: safeBlock,
  blocking: z.boolean(),
  task_version: z.number().int(),
});

/** `inbox` of one task: the questions still open for the current revision. */
export const InboxSchema = z.looseObject({
  items: z.array(InboxItemSchema),
  truncated: z.boolean(),
});
export type Inbox = z.infer<typeof InboxSchema>;
export type InboxItem = z.infer<typeof InboxItemSchema>;

/** `question_show`: where a question lives and how it ended, answered or not. */
export const QuestionShowSchema = z.looseObject({
  question_id: z.string(),
  task_id: taskId,
  project: z.string(),
  status: z.enum(['open', 'answered', 'withdrawn']),
  revision: z.number().int(),
  task_version: z.number().int(),
  /** Absent from a daemon older than this TUI. */
  body: safeBlock.optional(),
  answer: safeBlock.nullable().optional(),
  answered_by: safe.nullable().optional(),
});
export type QuestionShow = z.infer<typeof QuestionShowSchema>;
