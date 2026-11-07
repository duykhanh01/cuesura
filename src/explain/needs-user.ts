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
  cancel_reconcile: true,
  paused: true,
};

export function needsUser(s: Pick<TaskState, 'status' | 'wait' | 'revision' | 'run'>): boolean {
  if (isTerminal(s.status)) return false;
  if (s.status === 'READY' && !runConfigConfirmed(s)) return true;
  return s.wait === null ? false : NEEDS_USER[s.wait.detail.code];
}
