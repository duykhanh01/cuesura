import { z } from 'zod';
import { EpochMsSchema, HashSchema, UuidSchema, type Hash } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import { CanonicalTaskSchema } from './task.ts';
import { AuthzContextSchema, FrozenExecutionContextSchema, FrozenPolicySchema } from './policy.ts';
import { RunSelectionSchema } from './run-config.ts';
import type { TaskStatus } from './state.ts';
import {
  ArtifactSchema,
  BaseUpdateRequestSchema,
  BaseConflictSchema,
  BaseRepairScopeSchema,
  ExternalSubjectSchema,
  FrozenRuntimeContextSchema,
  MergeProofSchema,
  ObservationSchema,
  OPERATION_OUTCOMES,
  OPERATION_STATUSES,
  ProcessIdentitySchema,
} from './runtime.ts';

export const TRIGGER_SCHEMA_VERSION = 1;
export const MAX_ENVELOPE_IDS = 8;
/** Most fresh requests one grant may pass over for their scope (FR-044.08). */
export const MAX_PASSED_OVER = 1_000;

export const FAILURE_CLASSES = [
  'rate_limit',
  'infra',
  'auth_config',
  'timeout',
  'invalid_output',
  'refused',
  'quality',
  'unknown',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** Unavailable usage never carries numeric metrics. */
export const UsageSchema = z
  .object({
    basis: z.enum(['reported', 'estimated', 'unavailable']),
    tokens: z.number().int().nonnegative().optional(),
    cost: z.number().nonnegative().optional(),
  })
  .strict()
  .refine((u) => u.basis !== 'unavailable' || (u.tokens === undefined && u.cost === undefined), {
    message: 'Unavailable usage must not include numeric metrics',
  });
export type Usage = z.infer<typeof UsageSchema>;

export const BaseRelationSchema = z
  .object({
    head_sha: z.string().min(1),
    base_ref: z.string().min(1),
    base_sha: z.string().min(1),
    head_contains_base: z.boolean(),
  })
  .strict();
export type BaseRelation = z.infer<typeof BaseRelationSchema>;

export const RequiredSetSchema = z
  .object({
    names: z.array(z.string()),
    source: z.enum(['branch_protection', 'policy']),
    complete: z.boolean(),
  })
  .strict();
export type RequiredSet = z.infer<typeof RequiredSetSchema>;

export const CHECK_STATES = [
  'success',
  'failure',
  'pending',
  'cancelled',
  'skipped',
  'unknown',
] as const;
export type CheckState = (typeof CHECK_STATES)[number];

/**
 * Pass predicate over the current checks of one head. Like GitHub branch protection, a check concluded
 * `skipped` or `neutral` (both map to `skipped`) passes, so a workflow that skips a required job on
 * purpose, such as for a docs-only PR, does not block the merge gate forever. Unlike GitHub, `skipped`
 * passes only while no current check of the head, required or not, failed or was cancelled: a job
 * skipped because a job it needs failed also concludes `skipped`, and must not let untested code merge.
 */
export function checkPasser(
  checks: readonly { readonly state: CheckState }[],
): (state: CheckState) => boolean {
  const skipOk = !checks.some((c) => c.state === 'failure' || c.state === 'cancelled');
  return (state) => state === 'success' || (state === 'skipped' && skipOk);
}

export const CheckSchema = z
  .object({
    name: z.string().min(1),
    state: z.enum(CHECK_STATES),
    job: z.string().optional(),
    log_excerpt: z.string().max(65_536).optional(),
  })
  .strict();
export type Check = z.infer<typeof CheckSchema>;

export const AgentDataSchema = z
  .object({
    schema_checked: z.boolean(),
    status: z.enum(['done', 'needs_input', 'needs_context', 'blocked']),
    summary: z.string(),
    questions: z.array(z.string()).optional(),
    // What a needs_context/blocked worker says is missing or blocking (FR-039); additive.
    blocker: z.string().max(65_536).optional(),
    // The context parts a refusal before launch could not supply (`context_budget`, `prompt:<name>`); additive.
    missing: z.array(z.string().max(256)).max(64).optional(),
    usage: UsageSchema,
    invoked: z.boolean().optional(),
    // Worker-prepared commit/PR content, validated and stored by the orchestrator (M05); additive.
    content: z
      .object({ digest: HashSchema, ref: z.string().min(1) })
      .strict()
      .optional(),
    // Harness session of this run, and whether it resumed an earlier one or fell back (M04); additive.
    session_ref: z.string().min(1).nullable().optional(),
    resumed: z.boolean().optional(),
    resume_fallback: z.string().min(1).optional(),
    // The worktree tree after this worker attempt (T072); additive.
    worktree_tree: z.string().min(1).optional(),
    base_repair: BaseRepairScopeSchema.optional(),
  })
  .strict();

/**
 * A reviewer has no status of its own, except this: context that cannot be built, refused before launch.
 * Retrying cannot clear it, so it waits for a person as a worker's does.
 */
export const ReviewRefusedSchema = AgentDataSchema.refine(
  (d) => d.status === 'needs_context' && d.invoked === false,
);

const ChangedSinceSchema = z
  .object({ sha: z.string().min(1), paths: z.array(z.string()) })
  .strict();

export const ReviewDataSchema = z
  .object({
    schema_checked: z.boolean(),
    verdict: z.enum(['approve', 'request_changes']),
    findings: z.array(
      z
        .object({
          severity: z.string(),
          file: z.string().optional(),
          line: z.number().int().optional(),
          msg: z.string(),
        })
        .strict(),
    ),
    head_sha: z.string().min(1),
    usage: UsageSchema,
    invoked: z.boolean().optional(),
    // Additive: the reviewer's own summary, posted to the PR with the findings.
    summary: z.string().optional(),
    // Digest of everything the reviewer saw (base/commit/diff, PR content, frozen context, binding); M03.
    input_digest: HashSchema.optional(),
    // Additive: the files changed since the commit the previous rejecting review of this revision saw.
    changed_since: ChangedSinceSchema.optional(),
    // The reviewer's own session, resumed by the next round of the same revision (#213); additive.
    session_ref: z.string().min(1).nullable().optional(),
    resumed: z.boolean().optional(),
    resume_fallback: z.string().min(1).optional(),
  })
  .strict();

/** The checkpoint commit made after the required gates passed on one final tree (M06). */
export const CheckpointDataSchema = z
  .object({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    tree: z.string().regex(/^[0-9a-f]{40}$/),
    base_sha: z.string().min(1),
    diff_digest: HashSchema,
    content_digest: HashSchema,
    committed: z.boolean(),
    base_conflicts: z
      .object({
        tip_sha: z.string().regex(/^[0-9a-f]{40}$/),
        files: z.array(z.string().min(1)),
      })
      .strict()
      .optional(),
  })
  .strict();

const CommandLogRefSchema = z
  .object({
    ref: z.string().min(1),
    digest: HashSchema,
    bytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    // Logs of earlier releases have no time.
    wall_ms: z.number().nonnegative().optional(),
  })
  .strict();

export const GateDataSchema = z
  .object({
    results: z.array(
      z
        .object({
          gate: z.string(),
          passed: z.boolean(),
          signature: z.string().optional(),
          // Events of earlier releases hold at most 4 KiB here.
          log_excerpt: z.string().max(16_384).optional(),
          log: CommandLogRefSchema.optional(),
        })
        .strict(),
    ),
    // 002, additive: the tree every required gate passed on, whether it held still, and the commit of it.
    tree: z.string().min(1).optional(),
    stable: z.boolean().optional(),
    checkpoint: CheckpointDataSchema.optional(),
    base_conflict: BaseConflictSchema.optional(),
    base_scope: BaseRepairScopeSchema.optional(),
    // Additive (#168): files changed from the commit the last rejecting review saw to the checkpoint.
    // For a minor fix: files changed from the approved commit to the checkpoint.
    changed_since: ChangedSinceSchema.optional(),
  })
  .strict();

export const PrepareDataSchema = z
  .object({
    base_sha: z.string().min(1),
    worktree_ref: z.string().min(1),
    branch: z.string().min(1),
    setup: z.object({ ran: z.boolean(), passed: z.boolean() }).strict(),
    // The worktree tree once prepared (T072); additive.
    worktree_tree: z.string().min(1).optional(),
  })
  .strict();

export const PublishDataSchema = z
  .object({
    head_sha: z.string().min(1),
    base_relation: BaseRelationSchema,
    // The draft PR a failing task's work went up as (#247); additive.
    pr_ref: z.string().min(1).optional(),
  })
  .strict();

export const RerunDataSchema = z
  .object({ head_sha: z.string().min(1), rerun_checks: z.array(z.string()) })
  .strict();

/** `ready_at` is GitHub's time of the draft → ready change this effect made; null when it was ready already. */
export const MarkReadyDataSchema = z
  .object({
    pr_ref: z.string().min(1),
    ready_at: z.number().int().nonnegative().nullable(),
  })
  .strict();

/**
 * Posting a review never blocks the task: a review that could not be posted says why. `unknown` is a send
 * that may still land; that attempt is never sent again.
 */
export const PostReviewDataSchema = z
  .object({
    attempt_id: z.string().min(1),
    outcome: z.enum(['posted', 'not_posted', 'unknown']),
    review_id: z.number().int().nullable(),
    // Always 0 now that the review is one comment; kept so recorded events still parse.
    inline: z.number().int().nonnegative(),
    detail: z.string().nullable(),
  })
  .strict();

export const CreatePrDataSchema = z
  .object({
    pr_ref: z.string().min(1),
    head_sha: z.string().min(1),
    body_digest: z.string().min(1).optional(),
    /** Content and marker the title/body were written from, so a later content change updates the same PR. */
    pr_body: z
      .object({
        content_digest: z.string().min(1),
        body_digest: z.string().min(1),
        operation_key: z.string().min(1),
        revision: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

const PinnedRequirementSchema = z
  .object({
    name: z.string(),
    app: z.union([z.literal('any'), z.number().int().positive()]),
    source: z.enum(['classic', 'rules']),
    ruleset_id: z.number().int().positive().nullable(),
  })
  .strict();

/** Result of comparing GitHub's required checks with the snapshot (engine/required-checks.ts). */
export const RequiredCheckVerdictSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('covered'),
      github_required: z.enum(['known', 'none']),
      github: z.array(z.string()),
      app_pinned: z.array(PinnedRequirementSchema).optional(),
      snapshot_only: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      kind: z.literal('required_checks_mismatch'),
      missing_from_snapshot: z.array(z.string()),
      app_pinned: z.array(PinnedRequirementSchema),
      snapshot_only: z.array(z.string()),
    })
    .strict(),
  z.object({ kind: z.literal('unknown'), basis: z.string() }).strict(),
]);
export type RequiredCheckVerdict = z.infer<typeof RequiredCheckVerdictSchema>;

export const AwaitCiDataSchema = z
  .object({
    head_sha: z.string().min(1),
    required_set: RequiredSetSchema,
    checks: z.array(CheckSchema),
    base_relation: BaseRelationSchema.optional(),
    /** Base branch the PR was seen targeting, set only when it is not the task's target (FR-041.05). */
    target_ref: z.string().min(1).optional(),
    /** The PR was already merged into `target_ref`: re-observing cannot fix it. */
    target_merged: z.boolean().optional(),
    /** The PR was seen closed without a merge (FR-041.07); absent means open. */
    pr_state: z.enum(['open', 'closed']).optional(),
    /** GitHub's requirement compared to the frozen snapshot (FR-042); absent for legacy data. */
    required: RequiredCheckVerdictSchema.optional(),
  })
  .strict();

export const MergeDataSchema = z
  .object({ merged: z.boolean(), merge_sha: z.string().optional() })
  .strict();

export const StopDataSchema = z
  .object({
    stopped: z.boolean(),
    // Whether the in-flight handler was aborted, and the runners stopped through the process port
    // (FR-025.02); additive.
    aborted: z.boolean().optional(),
    stops: z
      .array(
        z
          .object({
            operation_id: UuidSchema,
            outcome: z.enum(['stopped', 'not_running', 'unknown']),
          })
          .strict(),
      )
      .max(64)
      .optional(),
  })
  .strict();

export const FailureDataSchema = z
  .object({
    failure_class: z.enum(FAILURE_CLASSES),
    signature: z.string().optional(),
    reset_at: z.number().int().nonnegative().optional(),
    usage: UsageSchema.optional(),
    invoked: z.boolean().optional(),
    message: z.string().optional(),
    // A turn-limited or stopped worker can continue its persisted transcript on the next attempt.
    session_ref: z.string().min(1).nullable().optional(),
    // T072, additive: the worktree tree after a worker attempt, or the change found before one.
    worktree_tree: z.string().min(1).optional(),
    worktree: z
      .object({ known: z.string().min(1), observed: z.string().min(1) })
      .strict()
      .optional(),
    // Additive: the harness manifest in force differs from the one the task runs with; nothing was invoked.
    manifest: z
      .object({
        harness: z.string().min(1),
        known: z.string().min(1),
        observed: z.string().min(1),
        // Additive (#249): the new manifest still meets what the task froze for; it is taken without asking.
        compatible: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // Additive: the harness ran and its login was refused or expired; a person signs in again.
    auth: z
      .object({ harness: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
export type FailureData = z.infer<typeof FailureDataSchema>;

export const FreezeErrorSchema = z.discriminatedUnion('code', [
  // `problems` (optional, additive) carries the 002 preflight report next to the config diagnostics.
  z
    .object({
      code: z.literal('config_invalid'),
      diagnostics: z.array(z.unknown()),
      problems: z.array(z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      code: z.literal('capability_missing'),
      problems: z.array(z.unknown()),
    })
    .strict(),
  // The confirmed run selection does not match the effective config (M02): a new confirmation is needed.
  z
    .object({
      code: z.literal('run_config_unconfirmed'),
      problems: z.array(z.unknown()),
    })
    .strict(),
  z
    .object({
      code: z.literal('unsupported_workflow'),
      workflow: z.string(),
      structure_hash: HashSchema,
    })
    .strict(),
  z
    .object({
      code: z.literal('unsupported_decision_mode'),
      points: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      code: z.literal('no_valid_binding'),
      step: z.string(),
      role: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal('override_exceeds_caller'),
      keys: z.array(z.string()),
    })
    .strict(),
]);
export type FreezeError = z.infer<typeof FreezeErrorSchema>;

export const FreezeResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      value: z
        .object({
          policy: FrozenPolicySchema,
          context: FrozenExecutionContextSchema,
        })
        .strict(),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: FreezeErrorSchema }).strict(),
]);

export const TriggerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('create_task'),
      task: CanonicalTaskSchema,
      /** Set by cusrd from the user's `intake.auto_confirm`, for a non-human requester only. */
      intake_auto_confirm: z.literal(true).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('confirm_task') }).strict(),
  z.object({ kind: z.literal('source_updated'), task: CanonicalTaskSchema }).strict(),
  z
    .object({
      kind: z.literal('dependency_status'),
      depends_on: UuidSchema,
      status: z.enum(['PENDING', 'READY', 'RUNNING', 'WAITING', 'DONE', 'FAILED', 'CANCELLED']),
      // 002, additive: what the prerequisite's terminal record showed, kept with the trigger for explain.
      provenance: z
        .object({
          prerequisite_version: z.number().int().nonnegative(),
          unverified_reason: z.string().min(1).nullable(),
          // Additive (#249): why a FAILED/CANCELLED prerequisite ended, so a cascade names the root task.
          terminal_reason: z.string().min(1).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  // `runtime` is the 002 snapshot committed with PolicyFrozen; absent for legacy (001) starts.
  z
    .object({
      kind: z.literal('start'),
      freeze: FreezeResultSchema,
      runtime: FrozenRuntimeContextSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('effect_result'),
      effect_id: UuidSchema,
      attempt_id: UuidSchema.optional(),
      outcome: z.enum(['succeeded', 'failed', 'unknown']),
      data: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('effect_reconciled'),
      effect_id: UuidSchema,
      finding: z.enum(['executed_succeeded', 'executed_failed', 'not_executed', 'still_unknown']),
      data: z.unknown().optional(),
      failure_class: z.enum(FAILURE_CLASSES).optional(),
      signature: z.string().optional(),
      // Requests the probe took; a logical effect is counted once however many it needed (T089).
      requests: z
        .object({
          git: z.number().int().nonnegative(),
          github: z.number().int().nonnegative(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal('timer'), timer_id: UuidSchema }).strict(),
  z
    .object({
      kind: z.literal('decider_start'),
      question_id: UuidSchema,
      /** Also the run's reservation, so `decider_ran` settles it without another ID. */
      attempt_id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('decider_ran'),
      question_id: UuidSchema,
      attempt_id: z.string().min(1),
      usage: UsageSchema,
      invoked: z.boolean(),
      decision: z
        .object({
          answer: z.string().min(1),
          reason: z.string(),
          /** What the worker is told about this answer, after the answer itself. */
          note: z.string().min(1),
        })
        .strict()
        .nullable(),
      /** The owner's setting allowed this answer when the run ended; usage is recorded regardless. */
      apply: z.boolean(),
      failure: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('answer'),
      question_id: UuidSchema,
      answer: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('approve'),
      approval_request_id: UuidSchema,
      head_sha: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reject'),
      approval_request_id: UuidSchema,
      head_sha: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('drift_choice'),
      choice: z.enum(['continue_old', 'apply_new', 'new_task']),
      freeze: FreezeResultSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('stop_attempt'),
      attempt_id: UuidSchema,
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      /** A read for the cancel with `read_token` that gave no observation to record (#267). */
      kind: z.literal('cancel_read_failed'),
      read_token: z.string().min(1),
      detail: z.string().max(2048),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cancel'),
      reason: z.string(),
      /** Ends a cancel whose PR read did not settle it, without that read (#179). */
      force: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('amend'),
      policy: FrozenPolicySchema,
      diff: z.unknown(),
      reason: z.string().min(1),
    })
    .strict(),

  z.object({ kind: z.literal('request_execution') }).strict(),
  z
    .object({
      kind: z.literal('grant_execution'),
      request_id: UuidSchema,
      // `cusr queue pause` (issue #142): only started tasks compete for the slot; additive.
      started_only: z.boolean().optional(),
      // `runtime.concurrency` when the grant was asked for (FR-044.01); absent means 1. Additive.
      capacity: z.number().int().positive().optional(),
      // A loan of this task's reserved slot (FR-044.02); only a task that never started borrows. Additive.
      lender_task_id: UuidSchema.optional(),
      // Fresh requests the scheduler passes over because their scope shares files with a task holding a
      // slot or a loan (FR-044.08); the queue head and loan head are read without them. Additive.
      passed_over: z.array(UuidSchema).max(MAX_PASSED_OVER).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('release_execution'),
      request_id: UuidSchema,
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('operation_result'),
      operation_id: UuidSchema,
      status: z.enum(OPERATION_STATUSES).exclude(['registered']),
      outcome: z.enum(OPERATION_OUTCOMES).nullable(),
      invocation_id: z.string().min(1).nullable(),
      processes: z.array(ProcessIdentitySchema),
      started_at: EpochMsSchema.nullable(),
      finished_at: EpochMsSchema.nullable(),
      receipt_digest: HashSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('ingest_record'),
      operation_id: UuidSchema,
      // Null only for final artifacts of a run that never wrote a record (no cursor to stay at).
      cursor: z
        .object({
          generation: z.number().int().nonnegative(),
          segment: z.number().int().nonnegative(),
          byte_offset: z.number().int().nonnegative(),
          last_record_seq: z.number().int().nonnegative(),
        })
        .strict()
        .nullable(),
      records: z.number().int().nonnegative(),
      digest: HashSchema,
      artifacts: z.array(ArtifactSchema).max(16),
    })
    .strict(),
  z
    .object({
      kind: z.literal('observation_due'),
      subject: ExternalSubjectSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('adopt_pr'),
      pr_ref: z.string().min(1),
      head_branch: z.string().min(1),
      head_sha: z.string().regex(/^[0-9a-f]{40}$/),
    })
    .strict(),
  // The daemon read the head of the PR a task waits to adopt, so the approval can name it (#265).
  z
    .object({
      kind: z.literal('adopt_head_observed'),
      pr_ref: z.string().min(1),
      head_sha: z.string().regex(/^[0-9a-f]{40}$/),
    })
    .strict(),
  // Keep the old trigger readable for existing durable envelopes.
  BaseUpdateRequestSchema.extend({ kind: z.literal('yolo_update_base') }).strict(),
  BaseUpdateRequestSchema.extend({ kind: z.literal('update_base') }).strict(),
  z
    .object({
      kind: z.literal('yolo_merge_approve'),
      head_sha: z.string().regex(/^[0-9a-f]{40}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('observation_result'),
      observation: ObservationSchema,
      remote_digest: HashSchema,
      /** CI of the observed head when the PR is open, read in the same round (FR-041.06); additive. */
      ci: AwaitCiDataSchema.optional(),
      /** The branch the PR targets when it is not the task's target, and whether it merged there (FR-041.05); additive. */
      target: z
        .object({ ref: z.string().min(1), merged: z.boolean() })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('external_completion'),
      proof: MergeProofSchema,
      unverified_reason: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('drain_result'),
      pending_operations: z.array(UuidSchema),
      local: z
        .object({
          worktree: z.string().min(1),
          local_head: z.string().nullable(),
          remote_head: z.string().nullable(),
          dirty: z.boolean().nullable(),
          unpushed: z.boolean().nullable(),
          detail: z.string().max(1024).nullable(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('recheck'),
      target: z.enum(['config', 'observation', 'drain', 'worktree', 'manifest', 'auth', 'visits']),
    })
    .strict(),
  // An operator keeps the task on its current model after its quality loop ran out (issue #101).
  z.object({ kind: z.literal('continue') }).strict(),
  // A person holds the task at its next step boundary, and lets it go on (issue #142).
  z
    .object({
      kind: z.literal('pause'),
      reason: z.string().min(1).max(4_096),
      // Also stop the agent attempts already running; they start over in a new session on resume.
      now: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('unpause') }).strict(),
  // A person or the assistant sends guidance to the task's agents (issue #154). `steer` and `interrupt`
  // stop a running coder/fixer turn and continue its session with the message; `queue` waits for the
  // next turn. Absent: `steer` from the assistant, `interrupt` from the owner.
  z
    .object({
      kind: z.literal('message'),
      body: z.string().min(1).max(65_536),
      behavior: z.enum(['steer', 'interrupt', 'queue']).optional(),
    })
    .strict(),
  // Run configuration (task-execution-modes.md M01/M02): proposed by any operator, confirmed by the user.
  z
    .object({
      kind: z.literal('propose_run_config'),
      selection: RunSelectionSchema,
    })
    .strict(),
  z.object({ kind: z.literal('confirm_run_config'), digest: HashSchema }).strict(),
  // A remote head nobody in this task pushed (FR-041.03, H01–H05), from an observation or a publish probe.
  z
    .object({
      kind: z.literal('head_drift'),
      expected: z.string().min(1).nullable(),
      observed: z.string().min(1).nullable(),
      source: z.enum(['observation', 'publish_probe', 'pr_probe', 'worktree']),
      evidence_ref: z.string().min(1),
      /** Set only when the daemon verified `observed` as a clean merge of this target commit (#110). */
      base_merge: z
        .object({ base_sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/) })
        .strict()
        .optional(),
    })
    .strict(),
  // Preflight candidate of a task that has not started (FR-002.02/03): advisory, never a snapshot.
  z
    .object({
      kind: z.literal('config_checked'),
      outcome: z.union([
        z.object({ ok: z.literal(true), base_sha: z.string().min(1) }).strict(),
        z.object({ ok: z.literal(false), error: FreezeErrorSchema }).strict(),
      ]),
    })
    .strict(),
]);
export type Trigger = z.infer<typeof TriggerSchema>;
export type TriggerKind = Trigger['kind'];

export const HUMAN_TRIGGERS: readonly TriggerKind[] = [
  'create_task',
  'confirm_task',
  'answer',
  'approve',
  'adopt_pr',
  'reject',
  'drift_choice',
  'stop_attempt',
  'cancel',
  'amend',
  'recheck',
  'continue',
  'pause',
  'unpause',
  'message',
  'propose_run_config',
  'confirm_run_config',
];

export const TriggerEnvelopeSchema = z
  .object({
    schema_version: z.literal(TRIGGER_SCHEMA_VERSION),
    task_id: UuidSchema,
    dedup_key: z.string().min(1).max(512),
    request_hash: HashSchema,
    expected_version: z.number().int().nonnegative().optional(),
    trigger: TriggerSchema,
    now: EpochMsSchema,
    ids: z.array(UuidSchema).max(MAX_ENVELOPE_IDS),
    authz: AuthzContextSchema.optional(),
  })
  .strict()
  .superRefine((env, ctx) => {
    if (HUMAN_TRIGGERS.includes(env.trigger.kind)) {
      if (env.authz === undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['authz'],
          message: 'Human commands require authz',
        });
      if (env.expected_version === undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['expected_version'],
          message: 'Human commands require expected_version',
        });
    }
  });
export type TriggerEnvelope = z.infer<typeof TriggerEnvelopeSchema>;

/** The store reads these facts in the same transaction so decide remains pure. */
export type RelatedFacts = {
  deps: Record<string, TaskStatus | 'missing'>;
  dependency_cycle: boolean;
  retry_of?: TaskStatus | 'missing';

  source_task?: { task_id: string; same_content: boolean };
  /** Live tasks other than this one that hold the PR an `adopt_pr` names. */
  pr_holders?: string[];
  /** Slot holders and queue head, read in the same transaction as a grant (FR-044). */
  execution?: {
    holders: string[];
    queue_head: string | null;
    /** Tasks running on a loan, the stale ones included. */
    loans?: number;
    /** For a loan grant: whether the lender's reservation is free to lend, and who should borrow it. */
    lender?: { lendable: boolean; loan_head: string | null; reserved_at: number | null };
  };
  /**
   * For a task on a loan: whether the lender still waits outside on its reservation. A loan that is not
   * active ends at the borrower's next slot-bound work (FR-044.04).
   */
  loan?: { active: boolean };
};

export const EMPTY_RELATED: RelatedFacts = {
  deps: {},
  dependency_cycle: false,
};

/**
 * request_hash covers task_id, trigger, expected_version, and actor. Exclude now and ids, which
 * are supplied for each processing attempt rather than identifying the request.
 */
export function computeRequestHash(env: {
  task_id: string;
  trigger: unknown;
  expected_version?: number | undefined;
  authz?: { actor: string } | undefined;
}): Hash {
  return hashCanonical({
    task_id: env.task_id,
    trigger: env.trigger,
    expected_version: env.expected_version ?? null,
    actor: env.authz?.actor ?? null,
  });
}
