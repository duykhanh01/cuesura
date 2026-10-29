import { z } from 'zod';
import type { CanonicalTask } from './task.ts';
import type { EffectKind, EffectStatus } from './effect.ts';
import type { Level } from './policy.ts';
import type { ExecutionMode, RunConfirmation, RunSelection } from './run-config.ts';
import type { BaseRelation, Check, FailureClass, RequiredSet, Usage } from './trigger.ts';
import type {
  Artifact,
  ExecutionGroup,
  ExternalSubject,
  MergeProof,
  ObservationBudget,
  OperationKind,
  OperationOutcome,
  OperationStatus,
  ProcessIdentity,
} from './runtime.ts';

export const STATE_SCHEMA_VERSION = 1;

export const TASK_STATUSES = ['PENDING', 'READY', 'RUNNING', 'WAITING', 'DONE', 'FAILED', 'CANCELLED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['DONE', 'FAILED', 'CANCELLED'];

export function isTerminal(s: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

/** Tập `wait_reason` giữ nguyên SPEC.md §6.1. */
export const PENDING_REASONS = ['confirmation', 'needs_info', 'dependency'] as const;
export const WAITING_REASONS = ['human_input', 'approval', 'ci', 'rate_limit', 'policy', 'infra'] as const;
export const WAIT_REASONS = [...PENDING_REASONS, ...WAITING_REASONS] as const;
export type WaitReason = (typeof WAIT_REASONS)[number];
export const WaitReasonSchema = z.enum(WAIT_REASONS);

/** `detail.code` theo bảng research R-13, cộng các mã chi tiết cho PENDING/WAITING khác. */
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
  'publish_content_invalid',
  // PR retargeted away from the task's base branch (FR-041.05); additive only.
  'target_mismatch',
] as const;
export type DetailCode = (typeof DETAIL_CODES)[number];

/** Hành động tiếp tục khi điều kiện chờ được thoả. */
export type ResumeAction =
  | { kind: 'start_attempt'; step: string; attempt_kind: AttemptKind }
  | { kind: 'enter_step'; step: string }
  /** Chạy lại bước mà không tính lượt vào bước (sau khi người trả lời hoặc duyệt). */
  | { kind: 'run_step'; step: string }
  | { kind: 'route'; step: string; outcome: string }
  | { kind: 'retry_effect'; step: string }
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
  /** Người đã yêu cầu dừng attempt; kết quả về sau không làm qua bước. */
  stop_requested: boolean;
  outcome: { class: FailureClass | null; status: string | null; signature: string | null } | null;
  usage: Usage | null;
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
};

export const TIMER_KINDS = ['deadline', 'backoff', 'ci_poll', 'ci_timeout'] as const;
export type TimerKind = (typeof TIMER_KINDS)[number];

export type TimerMirror = {
  id: string;
  kind: TimerKind;
  due_at: number;
  status: 'armed' | 'fired' | 'cancelled';
  payload: { step?: string; resume?: ResumeAction };
};

export type Reservation = { effect_id: string; units: number; status: 'held' | 'consumed' | 'released' };

export type Counter = { limit: number; used: number; reserved: number };

export type Budget = {
  agent_runs: Counter;
  decider_calls: Counter;
  escalations: { limit: number; used: number };
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
};

export type FailureStreak = { signature: string | null; consecutive: number; quality_tries: number; escalate: boolean };

export type Evidence = {
  gates: {
    revision: number;
    step: string;
    visit: number;
    passed: boolean;
    signature: string | null;
    valid: boolean;
    /** 002: failing gates with a redacted log tail, for the repair packet (M04). */
    failed?: { gate: string; signature: string | null; log_excerpt: string | null }[];
  }[];
  reviews: { revision: number; head_sha: string; verdict: 'approve' | 'request_changes'; valid: boolean }[];
  review_skipped: { revision: number; valid: boolean }[];
  ci: { revision: number; head_sha: string; required_set: RequiredSet; checks: Check[]; valid: boolean }[];
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
  holding: { request_id: string; granted_at: number } | null;
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
  cursor: { generation: number; segment: number; byte_offset: number; last_record_seq: number } | null;
  artifact_ids: string[];
};

export type Blocker = { code: DetailCode; source: string; since: number; until: number | null };

export type ObservationState = {
  subject: ExternalSubject;
  budget: ObservationBudget;
  last: { observation_id: string; status: 'open' | 'closed' | 'merged' | 'unknown'; observed_head: string | null; observed_at: number } | null;
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
};

/** Worker-prepared commit message and PR title/body, validated and stored outside the code (M05). */
export type PublishContentState = { revision: number; digest: string; ref: string; attempt_id: string | null };

/** Review evidence with everything the reviewer saw, so an unchanged input reuses the verdict (M03). */
export type ReviewEvidence = {
  revision: number;
  attempt_id: string;
  verdict: 'approve' | 'request_changes';
  sha: string;
  input_digest: string;
  signature: string | null;
  findings: { severity: string; file?: string | undefined; line?: number | undefined; msg: string }[];
  valid: boolean;
};

/** A remote head nobody in this task expected: blocks business work until reconciled (FR-041.03, H01–H05). */
export type HeadDrift = { expected: string | null; observed: string | null; source: string; evidence_ref: string; at: number };

export type RunState = {
  proposal: { selection: RunSelection; digest: string; by: string; at: number } | null;
  confirmation: RunConfirmation | null;
  /** Mode and selection digest frozen at start; null before start and for snapshots without modes. */
  mode: ExecutionMode | null;
  frozen_digest: string | null;
  checkpoint: CheckpointState | null;
  content: PublishContentState | null;
  reviews: ReviewEvidence[];
  head_drift: HeadDrift | null;
};

/** Projection `TaskState` (data-model.md). `version` tăng mỗi sự kiện (FR-028). */
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
  approvals: Record<string, Approval>;
  evidence: Evidence;
  head_sha: string | null;
  pr_ref: string | null;
  base_sha: string | null;
  ci_polls: number;
  merged: boolean;
  source_drift: SourceDrift | null;
  cancellation: { requested_at: number; by: string; reason: string; late: boolean } | null;
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
