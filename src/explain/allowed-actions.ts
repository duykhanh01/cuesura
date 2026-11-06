import type { DetailCode, TaskState } from '../domain/state.ts';
import { continuable } from '../engine/continue.ts';
import { exhaustedByInfra } from '../engine/recheck.ts';
import { runConfigConfirmed } from '../engine/run-config.ts';

/**
 * Expose only actions implemented by the daemon. Include recheck only when recheckTarget finds
 * useful work.
 */
export type AllowedAction = {
  readonly action:
    | 'merge_manually'
    | 'recheck'
    | 'continue'
    | 'cancel'
    | 'answer'
    | 'approve'
    | 'confirm'
    | 'propose'
    | 'wait'
    | 'task_add'
    | 'fix_external';

  readonly command: string | null;
  readonly note: string;
};

type Ctx = {
  readonly id: string;
  readonly version: number;
  readonly s: TaskState;
  readonly hasPr: boolean;
  readonly recheckable: boolean;
};
type Row = (c: Ctx) => (AllowedAction | null)[];

const cancel = (c: Ctx): AllowedAction => ({
  action: 'cancel',
  command: `cusr task cancel ${c.id} --expected-version ${c.version}`,
  note: 'Cancel reconciles the PR first; a merge already made still ends DONE.',
});
const recheck = (c: Ctx, note: string): AllowedAction | null =>
  c.recheckable
    ? {
        action: 'recheck',
        command: `cusr task recheck ${c.id} --expected-version ${c.version}`,
        note,
      }
    : null;
const merge = (c: Ctx): AllowedAction | null =>
  c.hasPr
    ? {
        action: 'merge_manually',
        command: null,
        note: 'Merge the PR on GitHub into the target branch; observation or recheck then records DONE.',
      }
    : null;
const external = (note: string): AllowedAction => ({
  action: 'fix_external',
  command: null,
  note,
});
const wait = (note: string): AllowedAction => ({
  action: 'wait',
  command: null,
  note,
});
const newTask: AllowedAction = {
  action: 'task_add',
  command: 'cusr task add --file FILE',
  note: 'To do the work again, add an independent task; it goes through triage, config and permissions anew.',
};
const answer = (c: Ctx): AllowedAction => ({
  action: 'answer',
  command: `cusr answer ${typeof c.s.wait?.detail['question_id'] === 'string' ? c.s.wait.detail['question_id'] : 'QUESTION'} --file FILE --expected-version ${c.version}`,
  note: 'Answer or supply what is missing.',
});
const confirm = (c: Ctx): AllowedAction => ({
  action: 'confirm',
  command: `cusr task confirm ${c.id} --expected-version ${c.version}`,
  note: 'Reads the newest base and checks the config again; nothing retries on its own.',
});

/**
 * An unconfirmed run is never queued. Confirmation must carry the displayed digest; after start,
 * the frozen run selection cannot be proposed or confirmed again.
 */
const runSelection: Row = (c) => {
  if (c.s.policy_ref !== null) return [cancel(c), newTask];
  const propose: AllowedAction = {
    action: 'propose',
    command: `cusr task propose ${c.id} --profile PROFILE --mode MODE --worker HARNESS/MODEL/EFFORT --expected-version ${c.version}`,
    note: 'Name the mode and bindings; the task does not queue until a selection is confirmed.',
  };
  const p = c.s.run.proposal;
  if (p === null || p.selection.revision !== c.s.revision) return [propose, cancel(c)];
  return [
    {
      action: 'confirm',
      command: `cusr task confirm ${c.id} --run-config ${p.digest} --expected-version ${c.version}`,
      note: 'Confirms the selection task show lists under run_config; needs the operate role.',
    },
    propose,
    cancel(c),
  ];
};

const proceedSameModel = (c: Ctx): AllowedAction | null =>
  continuable(c.s) === null
    ? null
    : {
        action: 'continue',
        command: `cusr task continue ${c.id} --expected-version ${c.version}`,
        note: 'Keeps the current model: the step gets a fresh set of quality tries and visits, then runs again from here with gates and review as usual. Budget, deadline, ladder and floor stay as they are.',
      };
const continuableExhausted: Row = (c) => [proceedSameModel(c), ...exhausted(c)];

const exhausted: Row = (c) => [
  merge(c),
  recheck(c, 'Reads the PR once; it adds no attempts or time.'),
  cancel(c),
  newTask,
];
const configFix: Row = (c) => [
  external('Fix the reported config or capability.'),
  confirm(c),
  recheck(c, 'Same check as confirm, under its own request ID.'),
  cancel(c),
];
const humanInput: Row = (c) => [answer(c), cancel(c)];
const reconnect: Row = (c) => [
  external(
    'Fix the connection or permission, or wait for the bounded cooldown; it is then reconciled within its limits. A read error does not prove the PR is unmerged.',
  ),
  recheck(c, 'Reads the PR once.'),
  cancel(c),
];
const stuck: Row = (c) => [merge(c), recheck(c, 'Reads the PR once.'), cancel(c), newTask];

const ROWS: Readonly<Record<DetailCode, Row>> = {
  missing_acceptance: (c) => [external('Add a task with acceptance criteria.'), cancel(c), newTask],
  needs_confirmation: (c) => [confirm(c), cancel(c)],
  dependency_pending: (c) => [
    wait('Starts its own checks once every prerequisite has a terminal status.'),
    cancel(c),
  ],
  dependency_failed: (c) => [cancel(c), newTask],
  config_invalid: configFix,
  capability_missing: configFix,
  unsupported_workflow: configFix,
  unsupported_decision_mode: configFix,
  no_valid_binding: configFix,
  override_exceeds_caller: configFix,
  run_config_unconfirmed: runSelection,
  agent_question: humanInput,
  agent_needs_context: humanInput,
  agent_blocked: humanInput,
  review_repeated: humanInput,
  source_drift: (c) => [cancel(c), newTask],
  auth_config: reconnect,
  refused: reconnect,
  effect_unknown: reconnect,
  infra_backoff: reconnect,
  rate_limited: reconnect,
  observation_unknown: reconnect,
  timeout: stuck,
  base_outdated: stuck,
  ci_unclassified: stuck,
  attempt_stopped: stuck,
  effect_failed: stuck,
  merge_not_done: stuck,
  gate_tree_unstable: stuck,
  publish_content_invalid: stuck,
  loop_exhausted: (c) =>
    exhaustedByInfra(c.s) === null
      ? continuableExhausted(c)
      : [
          recheck(
            c,
            'The latest visits were spent on infrastructure, rate-limit or login failures: gives those back and runs the step again. Fix the cause first.',
          ),
          cancel(c),
        ],
  ladder_exhausted: continuableExhausted,
  agent_runs_exhausted: exhausted,
  agent_runs_insufficient: exhausted,
  escalations_exhausted: continuableExhausted,
  deadline: exhausted,
  rung_denied: continuableExhausted,
  backoff_exhausted: exhausted,
  escalation_rejected: exhausted,
  ci_wait_exhausted: exhausted,
  escalation: (c) => {
    const open = Object.values(c.s.approvals).find(
      (x) => x.kind === 'escalation' && x.status === 'requested' && x.revision === c.s.revision,
    );
    return [
      {
        action: 'approve',
        command: `cusr task approve ${c.id} --kind escalation --step ${open?.step ?? 'STEP'} --rung ${open?.rung ?? 'N'} --expected-version ${c.version}`,
        note: 'Admin only, while budget remains; an approval adds no attempts that are already spent.',
      },
      cancel(c),
    ];
  },
  merge: (c) => [merge(c), recheck(c, 'Reads the PR once.'), cancel(c)],
  checks_incomplete: (c) => [wait('CI is being observed within its limits.'), merge(c), cancel(c)],
  execution_slot: (c) => [
    wait(
      'Waits for the execution slot by priority, resumed before fresh, then request order (FR-044).',
    ),
    cancel(c),
  ],
  head_changed: (c) => [
    external(
      'Return the branch to the checked head; it is then reconciled within its limits. Closing the PR leads to pr_closed.',
    ),
    recheck(c, 'Reads the PR once; it does not check or accept the new head.'),
    merge(c),
    cancel(c),
  ],
  target_mismatch: (c) => [
    external(
      'Change the PR base back to the target branch in the snapshot. A merge into another branch is not evidence for DONE.',
    ),
    recheck(c, 'Reads the PR once.'),
    cancel(c),
  ],
  required_checks_mismatch: (c) => [
    external(
      'Change the GitHub requirement so that the snapshot covers it; the snapshot is not edited in place.',
    ),
    recheck(c, 'Reads the PR once.'),
    merge(c),
    cancel(c),
    newTask,
  ],
  pr_closed: (c) => [
    external(
      'Reopen the PR; it is then reconciled within its limits. A closed PR is not terminal.',
    ),
    recheck(c, 'Reads the PR once.'),
    cancel(c),
  ],
  observation_expired: (c) => [
    recheck(
      c,
      'One bounded read; a merge then ends DONE. It does not restart polling or extend the window.',
    ),
    merge(c),
    cancel(c),
  ],
  merge_evidence_incomplete: (c) => [
    recheck(c, 'Run it once GitHub shows the merge in full.'),
    cancel(c),
  ],
  // Cancellation neither bypasses reconciliation nor changes a confirmed merge to CANCELLED.
  merge_cleanup_pending: (c) => [
    wait('Stopping and reconciling continues within its limits, then DONE.'),
    recheck(
      c,
      'One bounded stop/reconcile round for what is listed under merge_cleanup; fix anything unclear there first.',
    ),
  ],
  worktree_changed: (c) => [
    recheck(
      c,
      'Takes the observed tree as the task’s own (recorded as your change) and runs the step again.',
    ),
    cancel(c),
  ],
  harness_auth: (c) => [
    external(
      `Sign in to the ${typeof c.s.wait?.detail['harness'] === 'string' ? `${c.s.wait.detail['harness']} ` : ''}harness again on the daemon host, in the credential file runtime.credential_refs names.`,
    ),
    recheck(
      c,
      'Runs the same step again; the attempts that failed on the login give their visits back.',
    ),
    cancel(c),
  ],
  manifest_changed: (c) => [
    recheck(
      c,
      'Runs the task with the re-proved harness manifest from now on and runs the step again.',
    ),
    cancel(c),
  ],
  cancel_reconcile: (c) => [
    recheck(c, 'The cancel ends only after a read of the PR made after the request.'),
    merge(c),
  ],
};

export function allowedActions(
  s: TaskState,
  o: { readonly recheckable: boolean },
): AllowedAction[] {
  const c: Ctx = {
    id: s.id,
    version: s.version,
    s,
    hasPr: s.pr_ref !== null,
    recheckable: o.recheckable,
  };
  if (s.terminal !== null) return [newTask];
  const detail = s.wait?.detail.code;
  if (detail !== undefined) return ROWS[detail](c).filter((a): a is AllowedAction => a !== null);
  // Once merge is proven, completion waits only for drain and reconciliation.
  if (s.completion !== null)
    return ROWS.merge_cleanup_pending(c).filter((a): a is AllowedAction => a !== null);
  if (s.status === 'READY')
    return runConfigConfirmed(s)
      ? [wait('Waits for its turn at the execution slot.'), cancel(c)]
      : runSelection(c).filter((a): a is AllowedAction => a !== null);
  return [cancel(c)];
}
