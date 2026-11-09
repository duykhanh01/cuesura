import type { DetailCode, TaskState } from '../domain/state.ts';
import { isTerminal } from '../domain/state.ts';
import { runConfigConfirmed } from '../engine/run-config.ts';

/**
 * Whether going on depends on the user, for each wait detail (FR-007, R-10). `allowed_actions` cannot
 * tell this: a task waiting on CI or a cooldown also offers actions, yet it is progressing within its
 * limits. A `Record` makes a new code fail to compile until it is classified here.
 */
const NEEDS_USER: Record<DetailCode, boolean> = {
  missing_acceptance: true,
  needs_confirmation: true,
  adopt_approval: true,
  dependency_pending: false,
  dependency_failed: true,
  config_invalid: true,
  unsupported_workflow: true,
  unsupported_decision_mode: true,
  no_valid_binding: true,
  override_exceeds_caller: true,
  agent_question: true,
  source_drift: true,
  auth_config: true,
  refused: true,
  timeout: true,
  loop_exhausted: true,
  base_outdated: true,
  ci_unclassified: true,
  attempt_stopped: true,
  effect_failed: true,
  merge_not_done: true,
  ladder_exhausted: true,
  agent_runs_exhausted: true,
  agent_runs_insufficient: true,
  escalations_exhausted: true,
  deadline: true,
  rung_denied: true,
  backoff_exhausted: true,
  escalation_rejected: true,
  escalation: true,
  merge: true,
  checks_incomplete: false,
  effect_unknown: false,
  infra_backoff: false,
  rate_limited: false,
  execution_slot: false,
  capability_missing: true,
  head_changed: true,
  observation_expired: true,
  ci_wait_exhausted: true,
  required_checks_mismatch: true,
  merge_cleanup_pending: false,
  run_config_unconfirmed: true,
  gate_tree_unstable: true,
  worktree_changed: true,
  manifest_changed: true,
  harness_auth: true,
  publish_content_invalid: true,
  target_mismatch: true,
  pr_closed: true,
  observation_unknown: false,
  merge_evidence_incomplete: true,
  agent_needs_context: true,
  agent_blocked: true,
  review_repeated: true,
  fix_no_src_change: true,
  cancel_reconcile: false,
  paused: true,
};

/**
 * How long an `effect_unknown` wait reconciles by itself before the person is told (#249). It keeps
 * reconciling either way; the person only learns that it is taking long.
 */
export const EFFECT_UNKNOWN_ATTENTION_MS = 60 * 60 * 1000;

type Waiting = Pick<TaskState, 'status' | 'wait' | 'revision' | 'run'>;

/**
 * When the task entered its current status, read lazily: a wait recorded before `detail.since` existed
 * (#249) has no time of its own, and the status change is the closest durable mark for it.
 */
export type StatusSinceOf = () => number | null;

/** When an `effect_unknown` wait reaches the threshold; null for any other wait or an unknown start. */
export function effectUnknownDueAt(s: Waiting, statusSince?: StatusSinceOf): number | null {
  if (isTerminal(s.status) || s.wait?.detail.code !== 'effect_unknown') return null;
  const recorded = s.wait.detail['since'];
  const since = typeof recorded === 'number' ? recorded : (statusSince?.() ?? null);
  return since === null ? null : since + EFFECT_UNKNOWN_ATTENTION_MS;
}

/** An `effect_unknown` wait that has gone on past the threshold at `now`. */
export function effectUnknownOverdue(
  s: Waiting,
  now: number,
  statusSince?: StatusSinceOf,
): boolean {
  const due = effectUnknownDueAt(s, statusSince);
  return due !== null && now >= due;
}

/**
 * Cancel reads of the PR the daemon makes before the person is told (#267). It keeps reading after that;
 * the person only learns that the PR stays unreadable and that `cancel --force` exists.
 */
export const CANCEL_READS_BEFORE_ATTENTION = 5;

function cancelReadsStuck(s: Waiting): boolean {
  const reads = s.wait?.detail.code === 'cancel_reconcile' ? s.wait.detail['cancel_reads'] : null;
  return typeof reads === 'number' && reads >= CANCEL_READS_BEFORE_ATTENTION;
}

/** `now` lets a wait that has gone on too long count; without it only the table decides. */
export function needsUser(s: Waiting, now?: number, statusSince?: StatusSinceOf): boolean {
  if (isTerminal(s.status)) return false;
  if (s.status === 'READY' && !runConfigConfirmed(s)) return true;
  if (s.wait === null) return false;
  if (now !== undefined && effectUnknownOverdue(s, now, statusSince)) return true;
  if (cancelReadsStuck(s)) return true;
  return NEEDS_USER[s.wait.detail.code];
}
