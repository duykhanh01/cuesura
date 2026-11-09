import { z } from 'zod';
import type { CanonicalTask } from './task.ts';
import type { EffectKind, EffectStatus } from './effect.ts';
import type { Level } from './policy.ts';
import type { ExecutionMode, RunChoice, RunConfirmation, RunSelection } from './run-config.ts';
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
  BaseUpdate,
  BaseUpdateRun,
  ExecutionGroup,
  ExternalSubject,
  MergeProof,
  ObservationBudget,
  OperationKind,
  OperationOutcome,
  OperationStatus,
  ProcessIdentity,
  RuntimeLimits,
} from './runtime.ts';

export const STATE_SCHEMA_VERSION = 1;

export const TASK_STATUSES = [
  'PENDING',
  'READY',
  'RUNNING',
  'WAITING',
  'DONE',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['DONE', 'FAILED', 'CANCELLED'];

export function isTerminal(s: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

export const PENDING_REASONS = ['confirmation', 'needs_info', 'dependency'] as const;
export const WAITING_REASONS = [
  'human_input',
  'approval',
  'ci',
  'rate_limit',
  'policy',
  'infra',
] as const;
export const WAIT_REASONS = [...PENDING_REASONS, ...WAITING_REASONS] as const;
export type WaitReason = (typeof WAIT_REASONS)[number];
export const WaitReasonSchema = z.enum(WAIT_REASONS);

export const DETAIL_CODES = [
  // PENDING
  'missing_acceptance',
  'needs_confirmation',
  'dependency_pending',
  'dependency_failed',
  'config_invalid',
  'unsupported_workflow',
  'unsupported_decision_mode',
  'no_valid_binding',
  'override_exceeds_caller',
  // WAITING human_input
  'agent_question',
  'source_drift',
  'auth_config',
  'refused',
  'timeout',
  'loop_exhausted',
  'base_outdated',
  'ci_unclassified',
  'attempt_stopped',
  'effect_failed',
  'merge_not_done',
  // WAITING policy
  'ladder_exhausted',
  'agent_runs_exhausted',
  'agent_runs_insufficient',
  'escalations_exhausted',
  'deadline',
  'rung_denied',
  'backoff_exhausted',
  'escalation_rejected',
  // WAITING approval
  'escalation',
  'merge',
  // WAITING ci / infra / rate_limit
  'checks_incomplete',
  'effect_unknown',
  'infra_backoff',
  'rate_limited',
  // Runtime 002 (data-model.md "State transitions"); additive only.
  'execution_slot',
  'capability_missing',
  'head_changed',
  'observation_expired',
  'ci_wait_exhausted',
  'required_checks_mismatch',
  'merge_cleanup_pending',
  // Execution modes (task-execution-modes.md); additive only.
  'run_config_unconfirmed',
  'gate_tree_unstable',
  'worktree_changed',
  // The harness manifest was re-proved after the task froze its runtime snapshot; additive only.
  'manifest_changed',
  // The harness ran but its login was refused or expired; additive only.
  'harness_auth',
  'publish_content_invalid',
  // PR retargeted away from the task's base branch (FR-041.05); additive only.
  'target_mismatch',
  // PR observation (FR-041.07/08, FR-042.06); additive only.
  'pr_closed',
  'observation_unknown',
  // GitHub reports a merge whose evidence is incomplete (FR-040.12); additive only.
  'merge_evidence_incomplete',
  // An invoked worker reports missing context or a blocker it cannot clear (FR-039); additive only.
  'agent_needs_context',
  'agent_blocked',
  // A cancel waits for a read of its PR made after the request before it may end CANCELLED (FR-025.03).
  'cancel_reconcile',
  // A blocking review finding came back on a file the fix since the last review did not touch.
  'review_repeated',
  // The fix since the last rejecting review touched none of the files it blocked on (#168).
  'fix_no_src_change',
  // A person paused the task and the next step waits for them to unpause it (issue #142).
  'paused',
  // A task on an existing PR waits for an admin to adopt that PR at a named head (issue #174).
  'adopt_approval',
] as const;
export type DetailCode = (typeof DETAIL_CODES)[number];

export type TaskPause = { reason: string; by: string; at: number };

export type MessageBehavior = 'steer' | 'interrupt' | 'queue';

/** Guidance sent with `cusr task message` (issue #154); never widens the task. */
export type TaskMessage = {
  id: string;
  body: string;
  by: string;
  at: number;
  revision: number;
  behavior: MessageBehavior;
  delivery: 'interrupt' | 'next_turn';
};

export type ResumeAction =
  | { kind: 'start_attempt'; step: string; attempt_kind: AttemptKind }
  | { kind: 'enter_step'; step: string; base_update?: BaseUpdate }
  /** Rerun without counting another step visit after a human answer or approval. */
  | { kind: 'run_step'; step: string; base_update?: BaseUpdate }
  | { kind: 'repair_base'; mode: 'manual' | 'retry_fixer' }
  | { kind: 'route'; step: string; outcome: string }
  | { kind: 'retry_effect'; step: string; base_update?: BaseUpdate }
  | { kind: 'poll_ci'; step: string }
  | { kind: 'merge_check'; step: string }
  | { kind: 'triage' }
  | { kind: 'none' };

export type Wait = {
  reason: WaitReason;
  detail: { code: DetailCode; [k: string]: unknown };
  resume_when: string[];
  exit_paths: string[];
  resume: ResumeAction;
};

export const ATTEMPT_KINDS = ['initial', 'retry', 'repair', 'fresh_session'] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

export type Attempt = {
  id: string;
  step: string;
  n: number;
  kind: AttemptKind;
  revision: number;
  rung: number;
  binding: string;
  effect_id: string;
  reservation_id: string;
  status: 'running' | 'finished';
  /** A stopped attempt cannot advance the workflow when its result arrives. */
  stop_requested: boolean;
  outcome: {
    class: FailureClass | null;
    status: string | null;
    signature: string | null;
  } | null;
  usage: Usage | null;
  /** Harness session the attempt ran in, when the harness reported one (resume, M04). */
  session_ref?: string | null;
  /** Attempt whose session this one was asked to resume (FR-038). */
  resumed_from?: string;
  /** A finished coder/fixer's own report of what it did (#215); a claim, not evidence. */
  summary?: string;
};

export type EffectMirror = {
  id: string;
  kind: EffectKind;
  idem_key: string;
  status: EffectStatus;
  revision: number;
  step: string | null;
  attempt_id: string | null;
  reservation_id: string | null;
  target_effect_id: string | null;
  base_update?: BaseUpdate;
};

export const TIMER_KINDS = [
  'deadline',
  'backoff',
  'ci_poll',
  'ci_timeout',
  'wait_timeout',
] as const;
export type TimerKind = (typeof TIMER_KINDS)[number];

export type TimerMirror = {
  id: string;
  kind: TimerKind;
  due_at: number;
  status: 'armed' | 'fired' | 'cancelled';
  payload: { step?: string; resume?: ResumeAction; reason?: string; question_id?: string };
};

export type Reservation = {
  effect_id: string;
  units: number;
  status: 'held' | 'consumed' | 'released';
};

export type Counter = { limit: number | null; used: number; reserved: number };

export type Budget = {
  agent_runs: Counter;
  escalations: { limit: number | null; used: number };
  reservations: Record<string, Reservation>;
};

export type Question = {
  id: string;
  step: string | null;
  attempt_id: string | null;
  revision: number;
  body: string;
  status: 'open' | 'answered' | 'withdrawn';
  answer: string | null;
  answered_by: string | null;
  resume: ResumeAction;
};

/** The existing PR a task continues, as an admin approved it; `head_sha` is the head they approved. */
export type Adoption = {
  pr_ref: string;
  head_branch: string;
  head_sha: string;
  by: string;
  at: number;
};

export type Approval = {
  id: string;
  kind: 'escalation' | 'merge';
  revision: number;
  step: string | null;
  rung: number | null;
  head_sha: string | null;
  policy_hash: string;
  status: 'requested' | 'granted' | 'rejected';
  granted_by: string | null;
  revoked: boolean;
  /** Yolo's merge intent: the publish content whose commit message the merge uses. */
  content_digest?: string;
};

export type FailureStreak = {
  signature: string | null;
  consecutive: number;
  quality_tries: number;
  escalate: boolean;
};

export type Evidence = {
  gates: {
    revision: number;
    step: string;
    visit: number;
    passed: boolean;
    signature: string | null;
    valid: boolean;
    /** 002: failing gates with a redacted log tail, for the repair packet (M04). */
    failed?: {
      gate: string;
      signature: string | null;
      log_excerpt: string | null;
    }[];
  }[];
  reviews: {
    revision: number;
    head_sha: string;
    verdict: 'approve' | 'request_changes';
    valid: boolean;
  }[];
  review_skipped: { revision: number; valid: boolean }[];
  ci: {
    revision: number;
    head_sha: string;
    required_set: RequiredSet;
    checks: Check[];
    required?: RequiredCheckVerdict;
    valid: boolean;
  }[];
  base_relations: (BaseRelation & { revision: number; valid: boolean })[];
  publishes: { revision: number; head_sha: string; valid: boolean }[];
};

export type SourceDrift = {
  pending_revision: number;
  detected_at: number;
  safe_boundary_reached: boolean;
  task: CanonicalTask;
  deferred: ResumeAction | null;
  prior_wait: Wait | null;
};

/** One waiting or granted request for the daemon-wide execution slot. */
export type ExecutionState = {
  request: {
    request_id: string;
    requested_at: number;
    request_global_seq: number;
    group: ExecutionGroup;
    priority: number;
    resume_action: ResumeAction | null;
  } | null;
  holding: {
    request_id: string;
    granted_at: number;
    /** Set while the task waits outside on its own slot and may lend it (FR-044.02). */
    reserved_at?: number;
    /** Set when the slot is on loan from this task's reservation; a loan is never reserved or lent. */
    lender_task_id?: string;
  } | null;
  /** Wait closed by grants/withdrawals; an open request adds `now - requested_at` on top. */
  accumulated_wait_ms: number;
};

export type OperationMirror = {
  id: string;
  effect_id: string;
  attempt_id: string | null;
  kind: OperationKind;
  revision: number;
  launch_nonce: string;
  unit: string;
  holds_slot: boolean;
  status: OperationStatus;
  outcome: OperationOutcome | null;
  invocation_id: string | null;
  processes: ProcessIdentity[];
  registered_at: number;
  started_at: number | null;
  finished_at: number | null;
  cursor: {
    generation: number;
    segment: number;
    byte_offset: number;
    last_record_seq: number;
  } | null;
  artifact_ids: string[];
};

export type Blocker = {
  code: DetailCode;
  source: string;
  since: number;
  until: number | null;
};

export type ObservationState = {
  subject: ExternalSubject;
  budget: ObservationBudget;
  last: {
    observation_id: string;
    status: 'open' | 'closed' | 'merged' | 'unknown';
    observed_head: string | null;
    observed_at: number;
  } | null;
  expired: boolean;
};

export type Completion = {
  proof: MergeProof;
  unverified: { reason: string } | null;
  recorded_at: number;
  drain: {
    started_at: number | null;
    deadline_at: number | null;
    count: number;
    max_rounds: number;
    auto_exhausted: boolean;
    paused: boolean;
  };
  pending_operations: string[];
  finalized_at: number | null;
  /** What the worktree still held at the last drain round (FR-040.06); absent before the first one. */
  local_remainder?: LocalRemainder;
};

/**
 * The task's local work after a merge (FR-040.06): kept as it is, never reset, deleted or pushed to
 * match the merged head. Null fields are facts that could not be read.
 */
export type LocalRemainder = {
  worktree: string;
  local_head: string | null;
  remote_head: string | null;
  /** Uncommitted changes, untracked files included. */
  dirty: boolean | null;
  /** Local commits the remote branch does not have. */
  unpushed: boolean | null;
  detail: string | null;
  observed_at: number;
};

/** Commit the gates passed on, made by the orchestrator with the worker's message (M06). */
export type CheckpointState = {
  revision: number;
  sha: string;
  tree: string;
  base_sha: string;
  diff_digest: string;
  /** Digest of the worker's publish content the commit message came from. */
  content_digest: string;
  /** False when the tree did not change and the previous checkpoint commit was kept. */
  committed: boolean;
  gate_visit: number;
  /**
   * Files a merge of the local base tip into this commit would conflict on, read when the commit was
   * made (#210); absent when the base tip could not be read. Empty means no conflict.
   */
  base_conflicts?: BaseConflicts;
};

export type BaseConflicts = { tip_sha: string; files: string[] };

/** Worker-prepared commit message and PR title/body, validated and stored outside the code (M05). */
export type PublishContentState = {
  revision: number;
  digest: string;
  ref: string;
  attempt_id: string | null;
};

/** Review evidence with everything the reviewer saw, so an unchanged input reuses the verdict (M03). */
export type ReviewEvidence = {
  revision: number;
  attempt_id: string;
  verdict: 'approve' | 'request_changes';
  sha: string;
  input_digest: string;
  signature: string | null;
  findings: {
    severity: string;
    file?: string | undefined;
    line?: number | undefined;
    msg: string;
  }[];
  /** The reviewer's summary; absent for verdicts recorded before it was kept. */
  summary?: string;
  valid: boolean;
};

/**
 * A fix of the minor findings an approving review left, carried by that approval: its gates passed on
 * the checkpoint `sha` and it changed only the findings' files and tests since `approved_sha`.
 */
export type MinorFix = {
  revision: number;
  review_attempt_id: string;
  approved_sha: string;
  sha: string;
  tree: string;
  paths: string[];
};

/** A remote head nobody in this task expected: blocks business work until reconciled (FR-041.03, H01–H05). */
export type HeadDrift = {
  expected: string | null;
  observed: string | null;
  source: string;
  evidence_ref: string;
  at: number;
};

export type RunState = {
  base_update?: BaseUpdateRun;
  proposal: {
    selection: RunSelection;
    digest: string;
    by: string;
    at: number;
  } | null;
  confirmation: RunConfirmation | null;
  /** Bindings an admin's policy amendment confirmed per role after start (issue #105); absent when none. */
  amended_choices?: { role: string; choice: RunChoice }[];
  /** Mode and selection digest frozen at start; null before start and for snapshots without modes. */
  mode: ExecutionMode | null;
  frozen_digest: string | null;
  checkpoint: CheckpointState | null;
  content: PublishContentState | null;
  reviews: ReviewEvidence[];
  head_drift: HeadDrift | null;
  /** Daemon caps frozen in the runtime snapshot; null for tasks without one. */
  limits: RuntimeLimits | null;
  /** CI wait per head (FR-043.08): first poll time and polls requested; never reset by a recheck. */
  ci_wait: Record<string, CiWait>;
  /** What the PR title/body were last written from, and the marker they carry (M05/M07). */
  pr_body: PrBodyState | null;
  /**
   * When the daemon turned the task's draft PR ready (GitHub's clock). CI waits ignore skipped check runs
   * that finished before it: a draft run skipped by the repo's CI is not a result. Absent when never set.
   */
  pr_ready_at?: number | null;
  /** Review attempt whose verdict the review step last routed on, recorded or reused. */
  verdict_attempt_id?: string;
  /** Review attempts posted on the PR, or sent with an outcome never confirmed: not sent again. */
  posted_reviews?: string[];
  /**
   * The worktree tree the orchestrator last saw as the task's own: after prepare, after each worker
   * attempt, after the gates and after an accepted user change (T072). A worker attempt starting on
   * another tree waits instead of taking someone else's change as its own. Null before the first.
   */
  worktree_tree?: string | null;
  /**
   * Harness manifests a person accepted after the runtime snapshot froze (re-proved harness), by harness;
   * they replace the snapshot's `capability_refs` for later attempts. Absent until the first accept.
   */
  manifest_refs?: Record<string, string>;
  /**
   * CI reads still out when a remote merge was taken as a base update (#110): their answers are history.
   * Kept here, not in `base_update`, so a later base update does not forget them. Absent until the first.
   */
  superseded_reads?: string[];
  /** The latest minor fix carried by an approval; absent until the first one. */
  minor_fix?: MinorFix;
  /** Approving review attempts whose one minor fixer run started or was dropped. */
  minor_started?: string[];
  /** Set while a failing task publishes its work as a draft PR before it ends (#247). */
  salvage?: { reason: string };
};

export type PrBodyState = {
  content_digest: string;
  body_digest: string;
  operation_key: string;
  revision: number;
};

export type CiWait = { started_at: number; polls: number };

/** version increases with every event. */
/** One decider run on this task: what it cost, what it said and whether that answered the question. */
export type DeciderRun = {
  question_id: string;
  usage: Usage;
  invoked: boolean;
  answer: string | null;
  reason: string | null;
  failure: string | null;
  applied: boolean;
  at: number;
};

export type TaskState = {
  schema_version: number;
  id: string;
  project: string;
  source_key: string;
  revision: number;
  version: number;
  status: TaskStatus;
  wait: Wait | null;
  task: CanonicalTask;
  needs_confirmation: boolean;
  confirmed: boolean;
  policy_ref: { revision: number; hash: string; version: number } | null;
  context_ref: { revision: number; hash: string } | null;
  current_step: string | null;
  step_visits: Record<string, number>;
  /**
   * Visits given back per step (`VisitsCredited`): `visits` extends the step's limit and `through` is
   * the highest attempt number credited, so no attempt is credited twice. Absent until the first.
   */
  visit_credits?: Record<string, { visits: number; through: number }>;
  /** Streaks that already had the turn of an automatic answer (#247). Absent until the first. */
  auto_turns?: string[];
  /** Set while a person has the task paused (issue #142); absent when it never was. */
  pause?: TaskPause | null;
  /** Attempts stopped by `pause --now`: kept past the resume, so their end restarts the step. */
  pause_stops?: string[];
  /** Messages in the order sent (issue #154); absent until the first. */
  messages?: TaskMessage[];
  /** Attempts a message interrupted: their end continues the same session with the message. */
  message_stops?: string[];
  attempts: Record<string, Attempt>;
  current_attempt: Record<string, string>;
  rungs: { by_step: Record<string, number>; floor_level: Level | null };
  failure_streaks: Record<string, FailureStreak>;
  class_counters: Record<string, number>;
  escalated_steps: string[];
  last_fix_step: string | null;
  budget: Budget;
  effects: Record<string, EffectMirror>;
  timers: Record<string, TimerMirror>;
  questions: Record<string, Question>;
  /** Absent until the decider first runs, so tasks without it replay to the same state. */
  decider_runs?: Record<string, DeciderRun>;
  approvals: Record<string, Approval>;
  /** Absent unless an existing PR was adopted, so other tasks replay to the same state. */
  adoption?: Adoption;
  evidence: Evidence;
  head_sha: string | null;
  pr_ref: string | null;
  base_sha: string | null;
  ci_polls: number;
  merged: boolean;
  source_drift: SourceDrift | null;
  cancellation: {
    requested_at: number;
    by: string;
    reason: string;
    late: boolean;
    /** See `CancelRequested.read_token`; absent on a task without a runtime snapshot. */
    read_token?: string;
    /** The newest read that carried `read_token`. */
    pr_read?: {
      observation_id: string;
      status: string;
      /** Set when the read found the PR on another base than the task's target (#179). */
      target?: { ref: string; merged: boolean };
    };
    /** How many reads carrying `read_token` were recorded; the daemon backs off and the person is told by it. */
    reads?: number;
    /** A read of any source showed the PR merged while this cancel was open (or just before it). */
    merge_seen?: string;
    /** See `CancelForced`: the PR read is no longer required. */
    forced?: { by: string; at: number };
  } | null;
  started_at: number | null;
  deadline_at: number | null;
  deadline_passed: boolean;
  terminal: { kind: 'DONE' | 'FAILED' | 'CANCELLED'; reason: string } | null;
  // Runtime 002. Replaying a v1 log leaves these at their defaults; `runtime_ref === null` marks a legacy
  // task the 002 daemon only reads and never dispatches.
  runtime_ref: { revision: number; hash: string } | null;
  execution: ExecutionState;
  operations: Record<string, OperationMirror>;
  artifacts: Record<string, Artifact>;
  observation: ObservationState | null;
  completion: Completion | null;
  blockers: Blocker[];
  run: RunState;
};

export function streakKey(step: string, rung: number): string {
  return `${step}#${rung}`;
}

export function counterKey(...parts: (string | number)[]): string {
  return parts.join('#');
}
