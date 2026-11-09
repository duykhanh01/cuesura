/**
 * Who a wait goes to (007, FR-001, R-02). A `Record` makes a new wait code fail to compile until it is
 * routed here. `auto` is exactly the codes `NEEDS_USER` marks false, kept equal by a property test.
 */
import type { DetailCode, TaskState } from '../domain/state.ts';
import { isTerminal } from '../domain/state.ts';
import {
  cancelReadsStuck,
  effectUnknownOverdue,
  needsUser,
  type StatusSinceOf,
} from '../explain/needs-user.ts';

export type DeputyRoute = 'deputy' | 'owner' | 'worker_question' | 'auto';

export const DEPUTY_ROUTE: Readonly<Record<DetailCode, DeputyRoute>> = {
  // PENDING: the owner's, except a dependency that is still running.
  missing_acceptance: 'owner',
  needs_confirmation: 'owner',
  dependency_pending: 'auto',
  dependency_failed: 'owner',
  config_invalid: 'owner',
  unsupported_workflow: 'owner',
  unsupported_decision_mode: 'owner',
  no_valid_binding: 'owner',
  override_exceeds_caller: 'owner',
  adopt_approval: 'owner',
  // Always a person's (constitution V): credentials, refusals, confirmation, merge, pausing.
  auth_config: 'owner',
  harness_auth: 'owner',
  refused: 'owner',
  run_config_unconfirmed: 'owner',
  paused: 'owner',
  escalation_rejected: 'owner',
  merge: 'owner',
  plan_amendment: 'owner',
  // Questions of the worker follow `autonomous`.
  agent_question: 'worker_question',
  agent_needs_context: 'worker_question',
  agent_blocked: 'worker_question',
  // Progressing within limits: nobody is woken.
  checks_incomplete: 'auto',
  effect_unknown: 'auto',
  infra_backoff: 'auto',
  rate_limited: 'auto',
  execution_slot: 'auto',
  merge_cleanup_pending: 'auto',
  observation_unknown: 'auto',
  cancel_reconcile: 'auto',
  // Everything else is the deputy's.
  source_drift: 'deputy',
  timeout: 'deputy',
  loop_exhausted: 'deputy',
  base_outdated: 'deputy',
  ci_unclassified: 'deputy',
  attempt_stopped: 'deputy',
  effect_failed: 'deputy',
  merge_not_done: 'deputy',
  ladder_exhausted: 'deputy',
  agent_runs_exhausted: 'deputy',
  agent_runs_insufficient: 'deputy',
  escalations_exhausted: 'deputy',
  deadline: 'deputy',
  rung_denied: 'deputy',
  backoff_exhausted: 'deputy',
  escalation: 'deputy',
  capability_missing: 'deputy',
  head_changed: 'deputy',
  observation_expired: 'deputy',
  ci_wait_exhausted: 'deputy',
  required_checks_mismatch: 'deputy',
  gate_tree_unstable: 'deputy',
  worktree_changed: 'deputy',
  manifest_changed: 'deputy',
  publish_content_invalid: 'deputy',
  target_mismatch: 'deputy',
  pr_closed: 'deputy',
  merge_evidence_incomplete: 'deputy',
  review_repeated: 'deputy',
  fix_no_src_change: 'deputy',
};

type Routed = Pick<TaskState, 'status' | 'wait' | 'revision' | 'run'>;

/**
 * Who handles the task's current wait at `now`: the deputy, the owner, or nobody (`null`) while it
 * goes on by itself. `autonomous` is the owner's flag as it is now (FR-003).
 */
export function routeOf(
  s: Routed,
  autonomous: boolean,
  now: number,
  statusSince?: StatusSinceOf,
): 'deputy' | 'owner' | null {
  if (isTerminal(s.status)) return null;
  // A READY task whose run is not confirmed waits on its owner without a wait record.
  if (s.wait === null) return needsUser(s, now, statusSince) ? 'owner' : null;
  const code = s.wait.detail.code;
  if (effectUnknownOverdue(s, now, statusSince)) return 'deputy';
  // A cancel is the owner's request; one that cannot read the PR goes back to them.
  if (cancelReadsStuck(s)) return 'owner';
  if (code === 'effect_failed' && s.wait.detail['failure'] === 'boundary_violation') return 'owner';
  switch (DEPUTY_ROUTE[code]) {
    case 'auto':
      return null;
    case 'owner':
      return 'owner';
    case 'worker_question':
      return autonomous ? 'deputy' : 'owner';
    case 'deputy':
      return 'deputy';
  }
}
