import { z } from 'zod';
import type { CanonicalTask } from './task.ts';
import type { EffectKind, EffectStatus } from './effect.ts';
import type { Level } from './policy.ts';
import type { BaseRelation, Check, FailureClass, RequiredSet, Usage } from './trigger.ts';

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
] as const;
export type DetailCode = (typeof DETAIL_CODES)[number];

/** Hành động tiếp tục khi điều kiện chờ được thoả. */
export type ResumeAction =
  | { kind: 'start_attempt'; step: string; attempt_kind: AttemptKind }
  | { kind: 'enter_step'; step: string }
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
  gates: { revision: number; step: string; visit: number; passed: boolean; signature: string | null; valid: boolean }[];
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
};

export function streakKey(step: string, rung: number): string {
  return `${step}#${rung}`;
}

export function counterKey(...parts: (string | number)[]): string {
  return parts.join('#');
}
