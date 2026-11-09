/**
 * What a task is doing, in words, from the fields of a board row (FR-006, FR-007). Only presentation: it adds
 * no status and decides nothing. A code missing from these tables is shown as it came, never guessed at, so a
 * newer daemon cannot make this say something untrue. `Record<DetailCode, …>` makes a new code of this
 * version fail to compile until it has its words.
 */
import type { DetailCode, TaskStatus } from '../../domain/state.ts';
import type { BoardRow } from '../client/schemas.ts';
import type { Color } from '../terminal/screen.ts';
import { joinSafe, sanitize, uiText, type SafeText } from '../terminal/safe-text.ts';

/** `todo` is what going on needs from the user; `null` while the task waits within its limits. */
type WaitWords = { readonly doing: string; readonly todo: string | null };

const DECIDE = 'Decide: recheck or merge on GitHub if offered, else cancel';
const FIX_CONFIG = 'Fix the config, then confirm again';
const NEW_OR_CANCEL = 'Cancel it or add a new task';
const RECONNECT = 'Fix the connection or permission, then recheck';
const SEE_EXPLAIN = 'Open the task for details';

const WAITS: Readonly<Record<DetailCode, WaitWords>> = {
  missing_acceptance: {
    doing: 'Task has no acceptance criteria',
    todo: 'Add a task with acceptance criteria',
  },
  needs_confirmation: {
    doing: 'Waiting for you to confirm the task',
    todo: 'Confirm the task',
  },
  adopt_approval: {
    doing: 'Waiting for an admin to adopt the PR',
    todo: 'Review the PR and approve adopting it',
  },
  dependency_pending: { doing: 'Waiting for prerequisite tasks', todo: null },
  dependency_failed: {
    doing: 'A prerequisite task failed',
    todo: NEW_OR_CANCEL,
  },
  config_invalid: { doing: 'Configuration is invalid', todo: FIX_CONFIG },
  unsupported_workflow: {
    doing: 'Workflow is not supported',
    todo: FIX_CONFIG,
  },
  unsupported_decision_mode: {
    doing: 'Decision mode is not supported',
    todo: FIX_CONFIG,
  },
  no_valid_binding: { doing: 'No agent fits this task', todo: FIX_CONFIG },
  override_exceeds_caller: {
    doing: 'Settings exceed your permission',
    todo: FIX_CONFIG,
  },
  capability_missing: {
    doing: 'A required capability is missing',
    todo: FIX_CONFIG,
  },
  run_config_unconfirmed: {
    doing: 'Run settings not confirmed',
    todo: 'Confirm how to run this task',
  },
  agent_question: {
    doing: 'Agent asked a question',
    todo: 'Answer the question',
  },
  agent_needs_context: {
    doing: 'Agent needs more context',
    todo: 'Answer with what is missing',
  },
  agent_blocked: { doing: 'Agent is blocked', todo: 'Answer to unblock it' },
  review_repeated: { doing: 'Review finding came back unfixed', todo: 'Answer to unblock it' },
  fix_no_src_change: { doing: 'Fix left the reviewed files alone', todo: 'Answer to unblock it' },
  source_drift: { doing: 'Task source changed', todo: NEW_OR_CANCEL },
  auth_config: { doing: 'Login or permission problem', todo: RECONNECT },
  refused: { doing: 'The agent refused the work', todo: RECONNECT },
  timeout: { doing: 'A step timed out', todo: DECIDE },
  base_outdated: { doing: 'Base branch moved ahead', todo: DECIDE },
  ci_unclassified: { doing: 'CI failed for an unknown reason', todo: DECIDE },
  attempt_stopped: { doing: 'Attempt was stopped', todo: DECIDE },
  effect_failed: { doing: 'An operation failed', todo: DECIDE },
  merge_not_done: { doing: 'Merge did not happen', todo: DECIDE },
  gate_tree_unstable: { doing: 'Worktree changed during gates', todo: DECIDE },
  publish_content_invalid: { doing: 'PR content is invalid', todo: DECIDE },
  loop_exhausted: { doing: 'Step repeated too many times', todo: DECIDE },
  ladder_exhausted: { doing: 'No stronger model left to try', todo: DECIDE },
  agent_runs_exhausted: { doing: 'Agent run limit reached', todo: DECIDE },
  agent_runs_insufficient: { doing: 'Too few agent runs left', todo: DECIDE },
  escalations_exhausted: { doing: 'Escalation limit reached', todo: DECIDE },
  deadline: { doing: 'Task deadline passed', todo: DECIDE },
  rung_denied: { doing: 'Stronger model was denied', todo: DECIDE },
  backoff_exhausted: { doing: 'Retries used up', todo: DECIDE },
  escalation_rejected: { doing: 'Escalation was rejected', todo: DECIDE },
  ci_wait_exhausted: { doing: 'CI took too long', todo: DECIDE },
  escalation: {
    doing: 'Wants a stronger model',
    todo: 'Approve the stronger model or cancel',
  },
  merge: { doing: 'PR ready to merge by hand', todo: 'Merge the PR on GitHub' },
  checks_incomplete: { doing: 'Waiting for CI', todo: null },
  effect_unknown: { doing: 'Checking what happened', todo: null },
  infra_backoff: {
    doing: 'Retrying soon after a system error',
    todo: null,
  },
  rate_limited: { doing: 'Rate limited: retrying soon', todo: null },
  execution_slot: { doing: 'Waiting for its turn', todo: null },
  head_changed: {
    doing: 'PR head changed outside the task',
    todo: 'Return the branch to the checked head, or cancel',
  },
  observation_expired: {
    doing: 'Stopped watching the PR',
    todo: 'Recheck the PR',
  },
  required_checks_mismatch: {
    doing: 'Required checks changed on GitHub',
    todo: 'Change the GitHub requirement, or cancel',
  },
  merge_cleanup_pending: { doing: 'Merged; cleaning up', todo: null },
  worktree_changed: {
    doing: 'Worktree changed outside the task',
    todo: 'Recheck to accept the changes, or cancel',
  },
  harness_auth: {
    doing: 'Agent login expired or was refused',
    todo: 'Sign in again, then recheck, or cancel',
  },
  manifest_changed: {
    doing: 'Agent setup changed after the task started',
    todo: 'Recheck to use the new setup, or cancel',
  },
  target_mismatch: {
    doing: 'PR points at the wrong base branch',
    todo: 'Change the PR base back, or cancel',
  },
  pr_closed: { doing: 'PR was closed', todo: 'Reopen the PR, or cancel' },
  observation_unknown: { doing: 'Could not read the PR yet', todo: null },
  merge_evidence_incomplete: {
    doing: 'Could not confirm the merge yet',
    todo: 'Recheck once GitHub shows the merge',
  },
  cancel_reconcile: {
    doing: 'Cancelling: reading the PR first',
    todo: 'If the PR read keeps failing: recheck, or cancel --force',
  },
  paused: { doing: 'Paused', todo: 'Resume the task when ready' },
};

/** Steps of `software_dev@1` and its mode graphs. A workflow with other names shows them as they are. */
const STEPS: Readonly<Record<string, string>> = {
  triage: 'Triaging the task',
  prepare: 'Preparing the worktree',
  scout: 'Scouting the repository',
  code: 'Writing code',
  gates: 'Running gates',
  fix_gates: 'Fixing failed gates',
  review: 'Reviewing the change',
  fix_review: 'Addressing review comments',
  publish: 'Publishing the branch',
  pr: 'Opening the PR',
  post_review: 'Posting the review on the PR',
  post_changes: 'Posting the requested changes on the PR',
  fix_minor: 'Fixing minor review findings',
  minor_gates: 'Running gates on the minor fixes',
  ready: 'Marking the PR ready for CI',
  ci: 'Watching CI',
  ci_triage: 'Classifying a CI failure',
  rerun_ci: 'Rerunning CI',
  ci_autofix: 'Applying a CI autofix',
  ci_fix: 'Fixing CI',
  merge_gate: 'Checking merge conditions',
  merge: 'Waiting for the merge',
  complete: 'Completing',
};

const UNCONFIRMED = WAITS.run_config_unconfirmed;

/** A step of `software_dev` in words, or `null` for a step of a workflow this does not know. */
export function stepWords(step: string): string | null {
  return Object.hasOwn(STEPS, step) ? (STEPS[step] ?? null) : null;
}

export type ActivityRow = Pick<BoardRow, 'status' | 'wait_code' | 'step' | 'mode' | 'needs_user'>;

const waitWords = (code: string): WaitWords | null =>
  Object.hasOwn(WAITS, code) ? WAITS[code as DetailCode] : null;

/** The current activity in plain words; never only a raw status such as `WAITING` (US1 scenario 2). */
export function activity(row: ActivityRow): SafeText {
  switch (row.status) {
    case 'DONE':
      return uiText('Finished');
    case 'FAILED':
      return uiText('Failed');
    case 'CANCELLED':
      return uiText('Cancelled');
    default:
      break;
  }
  // The same order as the daemon's `needsUser`: an unconfirmed READY task is that first.
  if (row.status === 'READY' && row.needs_user) return uiText(UNCONFIRMED.doing);
  if (row.wait_code !== null) {
    const words = waitWords(row.wait_code);
    return words === null ? sanitize(row.wait_code) : uiText(words.doing);
  }
  if (row.status === 'READY') return uiText('Queued');
  if (row.status === 'PENDING') return uiText('Waiting for its checks');
  if (row.step === null) return uiText('Running');
  const step = Object.hasOwn(STEPS, row.step) ? STEPS[row.step] : undefined;
  return step === undefined ? row.step : uiText(step);
}

/**
 * What the user has to do for a task in the `Needs you` group (FR-007). Whether it belongs there is the
 * daemon's word (`needs_user`), not this table's. Without words of its own the code is the most it can say.
 */
export function todo(row: ActivityRow): SafeText | null {
  if (!row.needs_user) return null;
  if (row.status === 'READY') return uiText(UNCONFIRMED.todo ?? SEE_EXPLAIN);
  if (row.wait_code === null) return uiText(SEE_EXPLAIN);
  const words = waitWords(row.wait_code);
  if (words === null) return sanitize(row.wait_code);
  return uiText(words.todo ?? SEE_EXPLAIN);
}

/** Activity, then mode and PR when they exist (FR-006), for one row. */
export function activityLine(row: ActivityRow & Pick<BoardRow, 'pr_ref'>): SafeText {
  const parts = [activity(row)];
  if (row.mode !== null) parts.push(row.mode);
  if (row.pr_ref !== null) parts.push(row.pr_ref);
  return joinSafe(parts, uiText(' · '));
}

/** Each status has a mark of its own and its name, so nothing depends on colour (FR-035, EC-003). */
const MARKS: Readonly<Record<TaskStatus, { mark: string; color: Color | undefined }>> = {
  PENDING: { mark: '○', color: 'blue' },
  READY: { mark: '◇', color: 'magenta' },
  RUNNING: { mark: '▶', color: 'cyan' },
  WAITING: { mark: '‖', color: 'yellow' },
  DONE: { mark: '✓', color: 'green' },
  FAILED: { mark: '✕', color: 'red' },
  CANCELLED: { mark: '■', color: 'orange' },
};

/** The status's mark alone, for a row whose words already say what it is doing. */
export function statusGlyph(status: TaskStatus): {
  readonly mark: string;
  readonly color: Color | undefined;
} {
  return MARKS[status];
}

export function statusMark(status: TaskStatus): {
  readonly text: SafeText;
  readonly color: Color | undefined;
} {
  const { mark, color } = MARKS[status];
  return { text: uiText(`${mark} ${status}`), color };
}

/** For a terminal without colour: says that the marks and names carry the status (T039). */
export function markLegend(): SafeText {
  return uiText(
    `No colour: ${Object.values(MARKS)
      .map((m) => m.mark)
      .join(' ')} mark the status named beside them`,
  );
}

/** `3m 5s`; two units at most. Negative means the clocks disagree: no answer, not a guess. */
export function duration(ms: number): string | null {
  if (ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Time in the current status, up to the last read, so old data does not look like it is still counting. */
export function timeInStatus(row: Pick<BoardRow, 'status_since'>, readAt: number | null): SafeText {
  if (row.status_since === null || readAt === null) return uiText('unavailable');
  return uiText(duration(readAt - row.status_since) ?? 'unavailable');
}
