import { z } from 'zod';
import type { CanonicalTask } from './task.ts';
import type { EffectKind } from './effect.ts';
import type { FrozenExecutionContext, FrozenPolicy, Level } from './policy.ts';
import type {
  AttemptKind,
  CheckpointState,
  HeadDrift,
  LocalRemainder,
  PublishContentState,
  ResumeAction,
  ReviewEvidence,
  TimerKind,
  Wait,
} from './state.ts';
import type { DeciderRun } from './state.ts';
import type { RunConfirmation, RunSelection } from './run-config.ts';
import type { StepKind } from './workflow.ts';
import type {
  BaseRelation,
  Check,
  FailureClass,
  RequiredSet,
  RequiredCheckVerdict,
  Usage,
} from './trigger.ts';
import type {
  Artifact,
  BaseUpdateRun,
  ExecutionGroup,
  ExternalSubject,
  FrozenRuntimeContext,
  MergeProof,
  Observation,
  OperationKind,
  OperationOutcome,
  OperationStatus,
  ProcessIdentity,
} from './runtime.ts';

export const EVENT_SCHEMA_VERSION = 1;

export type EventPayloads = {
  // Task
  TaskCreated: { task: CanonicalTask; needs_confirmation: boolean };
  TaskRevised: { task: CanonicalTask };
  TaskConfirmed: { by: string };
  TaskReady: Record<string, never>;
  TaskPending: { wait: Wait };
  TaskWaiting: { wait: Wait };
  TaskResumed: { reason: string };

  PolicyFrozen: {
    /** First start time, absent in older event logs. */
    started_at?: number;
    policy: FrozenPolicy;
    context: FrozenExecutionContext;
    policy_hash: string;
    context_hash: string;
    structure_hash: string;
  };
  PolicyAmended: {
    policy: FrozenPolicy;
    diff: unknown;
    reason: string;
    by: string;
    policy_hash: string;
    policy_version: number;
  };
  AmendmentRejected: { code: string; by: string };

  StepEntered: {
    step: string;
    visit: number;
    from: { step: string; outcome: string } | null;
  };
  StepSkipped: {
    step: string;
    kind: StepKind;
    reason:
      | 'when'
      | 'skip_when'
      | 'no_gates'
      | 'pr_exists'
      | 'prepared'
      | 'no_review'
      | 'review_posted';
    outcome: string;
  };
  StepExhausted: { step: string; visits: number; target: string };
  // Attempt
  AttemptRequested: {
    attempt_id: string;
    step: string;
    n: number;
    kind: AttemptKind;
    rung: number;
    binding: string;
    effect_id: string;
    reservation_id: string;
    /** Worker attempt whose session this attempt resumes (FR-038); absent when it starts a new session. */
    resumed_from?: string;
  };
  AttemptFinished: {
    attempt_id: string;
    step: string;
    status: string | null;
    class: FailureClass | null;
    signature: string | null;
    usage: Usage;
    /** Harness session reported by the run, kept so a repair can resume it (M04); additive. */
    session_ref?: string | null;
  };
  FailureClassified: {
    step: string;
    attempt_id: string | null;
    class: FailureClass;
    signature: string | null;
    rung: number | null;
    counter_key: string;
    count: number;
    consecutive: number;
    escalate: boolean;
  };
  /**
   * The step's effect succeeded and its result held up, so the rate-limit/infra outage it was retrying
   * through is over: these counters start again from zero (FR-019 limits apply per outage).
   */
  RetryCountersCleared: { step: string; counter_keys: string[] };

  BudgetReserved: { reservation_id: string; effect_id: string; units: number };
  BudgetConsumed: { reservation_id: string };
  BudgetReleased: { reservation_id: string };
  // Escalation
  RungRaised: {
    step: string;
    from: number;
    to: number;
    reason: string;
    signature: string | null;
  };
  TaskFloorRaised: {
    step: string;
    level: Level;
    reason: 'scope_task' | 'hard';
  };

  GateResultRecorded: {
    step: string;
    visit: number;
    effect_id: string;
    results: {
      gate: string;
      passed: boolean;
      signature?: string | undefined;
      log_excerpt?: string | undefined;
    }[];
    passed: boolean;
    signature: string | null;
    resets_streak_of: string | null;
  };
  ReviewVerdictRecorded: {
    step: string;
    attempt_id: string;
    verdict: 'approve' | 'request_changes';
    head_sha: string;
    signature: string | null;
    resets_streak_of: string | null;
    // 002, additive: what the reviewer saw and said, for reuse (M03) and the fixer packet (M04).
    input_digest?: string;
    findings?: ReviewEvidence['findings'];
    summary?: string;
  };
  PublishRecorded: { head_sha: string };
  CiResultRecorded: {
    head_sha: string;
    required_set: RequiredSet;
    checks: Check[];
    required?: RequiredCheckVerdict;
    resets_streak_of: string | null;
  };
  BaseRelationRecorded: { relation: BaseRelation };
  EvidenceInvalidated: { revision: number; approvals: string[] };
  // Effect
  EffectRequested: {
    effect_id: string;
    kind: EffectKind;
    idem_key: string;
    logical_id: string;
    step: string | null;
    attempt_id: string | null;
    reservation_id: string | null;
    target_effect_id: string | null;
    request: Record<string, unknown>;
  };
  EffectStarted: { effect_id: string; at: number };
  EffectCompleted: {
    effect_id: string;
    status: 'succeeded' | 'failed' | 'unknown';
    result: unknown;
  };
  EffectInvalidated: { effect_id: string; reason: string };
  EffectReconciled: {
    effect_id: string;
    finding: 'executed_succeeded' | 'executed_failed' | 'not_executed' | 'still_unknown';
    status: 'succeeded' | 'failed' | 'unknown' | 'pending';
    result: unknown;
  };
  ReconcileIncomplete: { effect_id: string; issues: string[] };
  // Timer
  TimerArmed: {
    timer_id: string;
    kind: TimerKind;
    due_at: number;
    payload: { step?: string; resume?: ResumeAction };
  };
  TimerCancelled: { timer_id: string };
  TimerFired: { timer_id: string };

  QuestionAsked: {
    question_id: string;
    step: string | null;
    attempt_id: string | null;
    body: string;
    resume: ResumeAction;
  };
  QuestionAnswered: { question_id: string; answer: string; by: string };
  AnswerRejected: { question_id: string; by: string; reason: string };
  DeciderRan: DeciderRun & { attempt_id: string };
  ApprovalRequested: {
    approval_id: string;
    kind: 'escalation' | 'merge';
    step: string | null;
    rung: number | null;
    head_sha: string | null;
    policy_hash: string;
  };
  ApprovalGranted: {
    approval_id: string;
    by: string;
    head_sha: string | null;
    /** Yolo's merge intent: the publish content whose commit message the merge uses. */
    content_digest?: string;
  };
  ApprovalRejected: { approval_id: string; by: string };
  // Revision
  SourceDriftDetected: {
    pending_revision: number;
    task: CanonicalTask;
    at: number;
  };
  SafeBoundaryReached: {
    deferred: ResumeAction | null;
    prior_wait: Wait | null;
  };
  RevisionApplied: { revision: number; task: CanonicalTask };

  CancelRequested: {
    by: string;
    reason: string;
    at: number;
    /**
     * Runtime task: the token a read of the PR must carry (`raw_evidence_ref = cancel:<token>`) to count
     * for this cancel, so only a read requested after the cancel was recorded can end it (FR-025.03).
     */
    read_token?: string;
  };
  CancelRecordedLate: { merge_effect_id: string | null };

  TaskCompleted: { reason: string };
  TaskFailed: { reason: string };
  TaskCancelled: { reason: string };

  SignalIgnored: { reason: string; trigger_kind: string; detail?: unknown };

  RuntimeConfigured: { runtime: FrozenRuntimeContext; runtime_hash: string };
  ExecutionQueued: {
    request_id: string;
    group: ExecutionGroup;
    priority: number;
    resume_action: ResumeAction | null;
    requested_at: number;
  };
  ExecutionIntentUpdated: {
    request_id: string;
    priority: number;
    resume_action: ResumeAction | null;
  };
  ExecutionWithdrawn: { request_id: string; reason: string; at: number };
  ExecutionGranted: { request_id: string; at: number; waited_ms: number };
  ExecutionReleased: { request_id: string; reason: string; at: number };
  OperationRegistered: {
    operation_id: string;
    effect_id: string;
    attempt_id: string | null;
    kind: OperationKind;
    launch_nonce: string;
    unit: string;
    holds_slot: boolean;
    at: number;
  };
  OperationObserved: {
    operation_id: string;
    status: OperationStatus;
    outcome: OperationOutcome | null;
    invocation_id: string | null;
    processes: ProcessIdentity[];
    started_at: number | null;
    finished_at: number | null;
    receipt_digest: string;
  };
  OutputIngested: {
    operation_id: string;
    cursor: {
      generation: number;
      segment: number;
      byte_offset: number;
      last_record_seq: number;
    };
    records: number;
    digest: string;
  };
  ArtifactIngested: { artifact: Artifact };
  ObservationScheduled: {
    subject: ExternalSubject;
    started_at: number;
    deadline_at: number;
    max_count: number;
    next_due_at: number;
    cadence_index: number;
    generation: number;
  };
  ExternalStateObserved: { observation: Observation; remote_digest: string };
  ObservationExpired: { at: number; reason: 'deadline' | 'rounds' };
  ExternalCompletionObserved: {
    proof: MergeProof;
    unverified_reason: string | null;
    at: number;
  };
  DrainStarted: {
    at: number;
    deadline_at: number;
    max_rounds: number;
    pending_operations: string[];
  };
  DrainProgressed: {
    at: number;
    round: number;
    pending_operations: string[];
    local?: LocalRemainder;
  };
  DrainPaused: { at: number; reason: 'deadline' | 'round_limit' };
  DrainFinished: { at: number };
  RecheckRequested: {
    request_id: string;
    target: 'config' | 'observation' | 'drain' | 'worktree' | 'manifest' | 'auth' | 'visits';
    at: number;
  };
  // Execution modes (task-execution-modes.md)
  RunConfigProposed: {
    selection: RunSelection;
    digest: string;
    by: string;
    at: number;
  };
  RunConfigConfirmed: { confirmation: RunConfirmation };
  CheckpointRecorded: { checkpoint: CheckpointState };
  PublishContentRecorded: { content: PublishContentState };
  /** An unchanged review input reused a recorded verdict; no reviewer ran and no usage was spent. */
  ReviewReused: {
    step: string;
    from_attempt_id: string;
    verdict: 'approve' | 'request_changes';
    input_digest: string;
  };
  BaseUpdateRecorded: { update: BaseUpdateRun };
  HeadDriftRecorded: { drift: HeadDrift };
  /** The person took the changed worktree as the task's own; the next worker attempt starts from it (T072). */
  WorktreeChangeAccepted: {
    tree: string;
    previous: string;
    by: string;
    at: number;
  };
  /** The person took a re-proved harness manifest for this task; later attempts run with it. */
  ManifestChangeAccepted: {
    harness: string;
    manifest_hash: string;
    previous: string;
    by: string;
    at: number;
  };
  /**
   * A person gave a step back the visits its attempts spent on failures that say nothing about the work
   * (infrastructure, rate limit, login); the step's limit grows by one per attempt listed.
   */
  VisitsCredited: {
    step: string;
    attempt_ids: string[];
    by: string;
    at: number;
  };
  /**
   * An operator kept the task on its current model after its quality loop ran out (issue #101): the listed
   * streaks start over and each step's limit grows by the visits given.
   */
  TaskContinued: {
    step: string;
    wait_code: string;
    streaks: string[];
    visits: Record<string, number>;
    by: string;
    at: number;
  };
  /** A person paused the task (issue #142): no new step starts until it is unpaused. */
  /** `stopped`: attempts `pause --now` stopped; each starts over in a new session, paused or not. */
  TaskPaused: { reason: string; by: string; at: number; stopped?: string[] };
  TaskUnpaused: { by: string; at: number };
};

export type EventType = keyof EventPayloads;

export const EVENT_TYPES = [
  'TaskCreated',
  'TaskRevised',
  'TaskConfirmed',
  'TaskReady',
  'TaskPending',
  'TaskWaiting',
  'TaskResumed',
  'PolicyFrozen',
  'PolicyAmended',
  'AmendmentRejected',
  'StepEntered',
  'StepSkipped',
  'StepExhausted',
  'AttemptRequested',
  'AttemptFinished',
  'FailureClassified',
  'RetryCountersCleared',
  'BudgetReserved',
  'BudgetConsumed',
  'BudgetReleased',
  'RungRaised',
  'TaskFloorRaised',
  'GateResultRecorded',
  'ReviewVerdictRecorded',
  'PublishRecorded',
  'CiResultRecorded',
  'BaseRelationRecorded',
  'EvidenceInvalidated',
  'EffectRequested',
  'EffectStarted',
  'EffectCompleted',
  'EffectInvalidated',
  'EffectReconciled',
  'ReconcileIncomplete',
  'TimerArmed',
  'TimerCancelled',
  'TimerFired',
  'QuestionAsked',
  'QuestionAnswered',
  'AnswerRejected',
  'DeciderRan',
  'ApprovalRequested',
  'ApprovalGranted',
  'ApprovalRejected',
  'SourceDriftDetected',
  'SafeBoundaryReached',
  'RevisionApplied',
  'CancelRequested',
  'CancelRecordedLate',
  'TaskCompleted',
  'TaskFailed',
  'TaskCancelled',
  'SignalIgnored',
  'RuntimeConfigured',
  'ExecutionQueued',
  'ExecutionIntentUpdated',
  'ExecutionWithdrawn',
  'ExecutionGranted',
  'ExecutionReleased',
  'OperationRegistered',
  'OperationObserved',
  'OutputIngested',
  'ArtifactIngested',
  'ObservationScheduled',
  'ExternalStateObserved',
  'ObservationExpired',
  'ExternalCompletionObserved',
  'DrainStarted',
  'DrainProgressed',
  'DrainPaused',
  'DrainFinished',
  'RecheckRequested',
  'RunConfigProposed',
  'RunConfigConfirmed',
  'CheckpointRecorded',
  'PublishContentRecorded',
  'ReviewReused',
  'BaseUpdateRecorded',
  'HeadDriftRecorded',
  'WorktreeChangeAccepted',
  'ManifestChangeAccepted',
  'VisitsCredited',
  'TaskContinued',
  'TaskPaused',
  'TaskUnpaused',
] as const satisfies readonly EventType[];

type _MissingEventTypes = Exclude<EventType, (typeof EVENT_TYPES)[number]>;
const _allEventTypesListed: _MissingEventTypes extends never ? true : never = true;
void _allEventTypesListed;

type DraftOf<T extends EventType> = {
  type: T;
  revision: number;
  actor: string;
  payload: EventPayloads[T];
};

/** The store assigns seq and global_seq when appending. */
export type DomainEventDraft = { [T in EventType]: DraftOf<T> }[EventType];

type EventOf<T extends EventType> = DraftOf<T> & {
  schema_version: number;
  task_id: string;
  seq: number;
  global_seq: number;
  causation: { dedup_key: string | null; claim?: string };
};

export type DomainEvent = { [T in EventType]: EventOf<T> }[EventType];

export const DomainEventSchema = z
  .object({
    schema_version: z.number().int().positive(),
    task_id: z.string(),
    seq: z.number().int().nonnegative(),
    global_seq: z.number().int().nonnegative(),
    type: z.enum(EVENT_TYPES),
    revision: z.number().int().positive(),
    actor: z.string(),
    causation: z
      .object({
        dedup_key: z.string().nullable(),
        claim: z.string().optional(),
      })
      .strict(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export function draft<T extends EventType>(
  type: T,
  revision: number,
  actor: string,
  payload: EventPayloads[T],
): DomainEventDraft {
  return { type, revision, actor, payload } as DomainEventDraft;
}
