import type { DetailCode, TaskState } from '../domain/state.ts';
import { continuable } from '../engine/continue.ts';
import { exhaustedByInfra } from '../engine/recheck.ts';
import { runConfigConfirmed } from '../engine/run-config.ts';

/**
 * Expose only actions implemented by the daemon. Include recheck only when recheckTarget finds
 * useful work. A command holds no placeholder for a value the engine knows; what it cannot know is an
 * upper-case word (FILE, REASON, MODEL) the shell leaves alone.
 */
export type AllowedAction = {
  readonly action:
    | 'merge_manually'
    | 'recheck'
    | 'continue'
    | 'amend_policy'
    | 'pause'
    | 'resume'
    | 'cancel'
    | 'answer'
    | 'approve'
    | 'confirm'
    | 'propose'
    | 'wait'
    | 'task_add'
    | 'fix_external'
    | 'resume_queue';

  readonly command: string | null;
  readonly note: string;
  /** Role the command needs; null when there is no command to run. */
  readonly requires: 'operate' | 'admin' | null;
};

type Ctx = {
  readonly id: string;
  readonly version: number;
  readonly s: TaskState;
  readonly hasPr: boolean;
  readonly recheckable: boolean;
  /** Live tasks that end CANCELLED with this one (#249), its dependents' dependents included. */
  readonly dependents: number;
  readonly queuePaused: boolean;
  readonly prerequisites: readonly PrerequisiteState[];
};

/** A prerequisite as it stands now; `wait.detail.deps` is only what triage saw. */
export type PrerequisiteState = {
  readonly task_id: string;
  readonly status: string;
  readonly wait_code: string | null;
  readonly paused: boolean;
  readonly needs_user: boolean;
};
type Row = (c: Ctx) => (AllowedAction | null)[];

const cascade = (c: Ctx): string =>
  c.dependents === 0
    ? ''
    : ` Ending CANCELLED also cancels ${c.dependents} dependent task${c.dependents === 1 ? '' : 's'} listed under dependents; check them with the user first.`;
const cancel = (c: Ctx): AllowedAction => ({
  action: 'cancel',
  command: `cusr task cancel ${c.id} --expected-version ${c.version}`,
  note: 'Cancel reconciles the PR first; a merge already made still ends DONE.' + cascade(c),
  requires: 'operate',
});
/** Offered only while a read is what holds the cancel: a merge seen is decided by the drain. */
const forceCancel = (c: Ctx): AllowedAction | null =>
  c.s.cancellation?.merge_seen !== undefined ||
  c.s.blockers.some((b) => b.code === 'merge_evidence_incomplete')
    ? null
    : {
        action: 'cancel',
        command: `cusr task cancel ${c.id} --force --expected-version ${c.version}`,
        note:
          'Only if the user asks: reads the PR once more, then ends CANCELLED even if the read cannot tell open from closed (the PR may be unread).' +
          cascade(c),
        requires: 'operate',
      };
const recheck = (c: Ctx, note: string): AllowedAction | null =>
  c.recheckable
    ? {
        action: 'recheck',
        command: `cusr task recheck ${c.id} --expected-version ${c.version}`,
        note,
        requires: 'operate',
      }
    : null;
/** Which read records a manual merge: only a runtime task with a live window is observed (#209). */
function mergeNote(s: TaskState): string {
  const ob = s.observation ?? null;
  const due = ob?.budget.next_due_at ?? null;
  // A round due at the window's end or past its round cap only expires the window; it reads nothing.
  if (
    (s.runtime_ref ?? null) === null ||
    ob === null ||
    ob.expired ||
    (due !== null && due >= ob.budget.deadline_at) ||
    ob.budget.count >= ob.budget.max_count
  )
    return 'Merge the PR on GitHub into the target branch, then run recheck to record DONE; no observation round is scheduled.';
  return due === null
    ? 'Merge the PR on GitHub into the target branch; the next read of the PR records DONE, or recheck records it at once.'
    : `Merge the PR on GitHub into the target branch; the next observation round (due at ${due}, Unix ms) records DONE, or recheck records it at once.`;
}
const merge = (c: Ctx): AllowedAction | null =>
  c.hasPr
    ? { action: 'merge_manually', command: null, note: mergeNote(c.s), requires: null }
    : null;
const external = (note: string): AllowedAction => ({
  action: 'fix_external',
  command: null,
  note,
  requires: null,
});
const wait = (note: string): AllowedAction => ({
  action: 'wait',
  command: null,
  note,
  requires: null,
});
const resumeQueue: AllowedAction = {
  action: 'resume_queue',
  command: 'cusr queue resume',
  note: 'The queue is paused (status.queue_paused says by whom and why): no task that has not started gets the execution slot until it is resumed. Ask the user before resuming.',
  requires: 'operate',
};

function dependencyNote(c: Ctx): string {
  const base = 'Starts its own checks once every prerequisite has a terminal status.';
  const open = c.prerequisites.filter((p) => !['DONE', 'FAILED', 'CANCELLED'].includes(p.status));
  if (open.length === 0) return base;
  const stuck = open.filter((p) => p.paused || p.needs_user);
  const listed = (stuck.length > 0 ? stuck : open)
    .map((p) => {
      const why = p.paused
        ? 'paused'
        : p.needs_user
          ? `needs the user: ${p.wait_code ?? 'run config'}`
          : null;
      return `${p.task_id} (${p.status}${why === null ? '' : `, ${why}`})`;
    })
    .join(', ');
  return stuck.length > 0
    ? `${base} Blocked by ${listed}, which will not move on by itself; see cusr task explain on it.`
    : `${base} Waiting on ${listed}.`;
}

const newTask: AllowedAction = {
  action: 'task_add',
  command: 'cusr task add --file FILE',
  note: 'To do the work again, add an independent task; it goes through triage, config and permissions anew.',
  requires: 'operate',
};
/** The question the wait resumes on, from `answer(<qid>)` in resume_when or the detail. */
function questionId(s: TaskState): string | null {
  const w = s.wait;
  if (w === null) return null;
  for (const r of w.resume_when) {
    const m = /^answer\((.+)\)$/.exec(r);
    if (m !== null) return m[1] as string;
  }
  return typeof w.detail['question_id'] === 'string' ? w.detail['question_id'] : null;
}
export const answerCommand = (questionId: string, version: number): string =>
  `cusr answer ${questionId} --file FILE --expected-version ${version}`;
const answer = (c: Ctx, note = 'Answer or supply what is missing.'): AllowedAction => {
  const qid = questionId(c.s);
  return {
    action: 'answer',
    command: qid === null ? null : answerCommand(qid, c.version),
    note: qid === null ? `${note} No open question is recorded yet; run task explain again.` : note,
    requires: qid === null ? null : 'operate',
  };
};
const confirm = (c: Ctx): AllowedAction => ({
  action: 'confirm',
  command: `cusr task confirm ${c.id} --expected-version ${c.version}`,
  note: 'Reads the newest base and checks the config again; nothing retries on its own.',
  requires: 'operate',
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
    requires: 'operate',
  };
  const p = c.s.run.proposal;
  if (p === null || p.selection.revision !== c.s.revision) return [propose, cancel(c)];
  return [
    {
      action: 'confirm',
      command: `cusr task confirm ${c.id} --run-config ${p.digest} --expected-version ${c.version}`,
      note: 'Confirms the selection task show lists under run_config; needs the operate role.',
      requires: 'operate',
    },
    propose,
    cancel(c),
  ];
};

const resume = (c: Ctx): AllowedAction => ({
  action: 'resume',
  command: `cusr task resume ${c.id} --expected-version ${c.version}`,
  note: 'Unpauses the task: the step it stopped at runs as it would have, with the same revision, worktree, PR and evidence.',
  requires: 'operate',
});
const pause = (c: Ctx): AllowedAction => ({
  action: 'pause',
  command: `cusr task pause ${c.id} --expected-version ${c.version}`,
  note: 'Work already started finishes; no new step starts until the task is resumed. Unlike cancel, nothing is lost. Add --reason REASON to record why.',
  requires: 'operate',
});

const proceedSameModel = (c: Ctx): AllowedAction | null =>
  continuable(c.s) === null
    ? null
    : {
        action: 'continue',
        command: `cusr task continue ${c.id} --expected-version ${c.version}`,
        note: 'Keeps the current model: the step gets a fresh set of quality tries and visits, then runs again from here with gates and review as usual. Budget, deadline, ladder and floor stay as they are.',
        requires: 'operate',
      };
const otherModel = (c: Ctx): AllowedAction | null =>
  continuable(c.s) === null
    ? null
    : {
        action: 'amend_policy',
        command: `cusr task amend-policy ${c.id} --model MODEL`,
        note: 'Admin only; add --effort LEVEL to change the effort too. Previews running the waiting step on another configured model and prints the command that applies it (with --confirm POLICY_HASH --reason REASON --expected-version): a new policy version, the same task, worktree and history; gates and review run again. The profile still decides whether the model is allowed or needs approval.',
        requires: 'admin',
      };
const continuableExhausted: Row = (c) => [proceedSameModel(c), otherModel(c), ...exhausted(c)];

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

/** `gh` reads PRs by number and repo, not by the `owner/repo#N` ref the task names. */
function ghHead(s: TaskState): string {
  const [repo, n] = (s.task?.pr_ref ?? '').split('#');
  return repo && n
    ? `gh pr view ${n} -R ${repo} --json headRefOid`
    : 'gh pr view --json headRefOid';
}

const ROWS: Readonly<Record<DetailCode, Row>> = {
  missing_acceptance: (c) => [external('Add a task with acceptance criteria.'), cancel(c), newTask],
  needs_confirmation: (c) => [confirm(c), cancel(c)],
  dependency_pending: (c) => [wait(dependencyNote(c)), cancel(c)],
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
  fix_no_src_change: humanInput,
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
    const d: Record<string, unknown> = c.s.wait?.detail ?? {};
    const step = open?.step ?? (typeof d['step'] === 'string' ? d['step'] : null);
    const rung = open?.rung ?? (typeof d['rung'] === 'number' ? d['rung'] : null);
    const note =
      'Needs the operate role, while budget remains; an approval adds no attempts that are already spent.';
    return [
      step === null || rung === null
        ? {
            action: 'approve',
            command: null,
            note: `${note} No open escalation request of this revision is recorded; run task explain again.`,
            requires: null,
          }
        : {
            action: 'approve',
            command: `cusr task approve ${c.id} --kind escalation --step ${step} --rung ${rung} --expected-version ${c.version}`,
            note,
            requires: 'operate',
          },
      cancel(c),
    ];
  },
  adopt_approval: (c) => {
    const sha = c.s.wait?.detail['head_sha'];
    return [
      typeof sha === 'string'
        ? {
            action: 'approve',
            command: `cusr task approve ${c.id} --kind adopt --head-sha ${sha} --expected-version ${c.version}`,
            note: `Admin only: review the PR at the head the daemon last read (${sha}). It may have moved since (the daemon rereads it on a backoff of up to an hour): check with ${ghHead(c.s)} and approve that head instead. The approval reads the PR again and refuses a head that differs; the task pushes to that PR and stops if the head moves later.`,
            requires: 'admin',
          }
        : {
            action: 'approve',
            command: null,
            note: `Admin only: the daemon has not read the PR head yet. Review the PR, then run cusr task approve ${c.id} --kind adopt --head-sha SHA --expected-version ${c.version} with its full 40-character head SHA (${ghHead(c.s)}). The task pushes to that PR and stops if the head moves.`,
            requires: null,
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
    recheck(
      c,
      'Reads the PR once. A clean "Update branch" merge of the target into the checked head is then taken as a base update and gated, certified and CI-checked again; any other head stays as it is.',
    ),
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
    forceCancel(c),
  ],
  paused: (c) => [resume(c), cancel(c)],
};

export function allowedActions(
  s: TaskState,
  o: {
    readonly recheckable: boolean;
    readonly dependents?: number;
    readonly queuePaused?: boolean;
    readonly prerequisites?: readonly PrerequisiteState[];
  },
): AllowedAction[] {
  const c: Ctx = {
    id: s.id,
    version: s.version,
    s,
    hasPr: s.pr_ref !== null,
    recheckable: o.recheckable,
    dependents: o.dependents ?? 0,
    queuePaused: o.queuePaused ?? false,
    prerequisites: o.prerequisites ?? [],
  };
  if (s.terminal !== null) return [newTask];
  const rows = cancelling(s, queueHeld(c, listed(c)));
  // Pausing is offered to a started task that can still start work; resuming to a paused one that
  // waits on something else first (CI, a person, GitHub), whose outcome then waits for the resume.
  const paused = (s.pause ?? null) !== null;
  if (paused) return rows.some((a) => a.action === 'resume') ? rows : [resume(c), ...rows];
  const pausable = s.policy_ref !== null && s.completion === null && s.cancellation === null;
  return pausable ? [...rows, pause(c)] : rows;
}

/**
 * A repeated cancel is ignored (`already_cancelling`): the task ends once running work stops. Only
 * `--force`, which the cancel's own wait offers, still changes anything.
 */
function cancelling(s: TaskState, rows: AllowedAction[]): AllowedAction[] {
  if (s.cancellation === null) return rows;
  const plain = (a: AllowedAction): boolean =>
    a.action === 'cancel' && a.command?.includes(' --force ') !== true;
  if (!rows.some(plain)) return rows;
  const out = rows.filter((a) => !plain(a));
  return out.some((a) => a.action === 'wait')
    ? out
    : [wait('Cancel requested; the task ends once running work stops.'), ...out];
}

/**
 * A paused queue holds every task that has not started (#256): its turn never comes, so waiting for it
 * is not the way out. A dependency wait keeps its note, since the queue is only the next thing in line.
 */
function queueHeld(c: Ctx, rows: AllowedAction[]): AllowedAction[] {
  const notStarted =
    c.s.policy_ref === null && (c.s.status === 'READY' || c.s.status === 'PENDING');
  if (!c.queuePaused || !notStarted) return rows;
  if (c.s.wait?.detail.code === 'dependency_pending') return [...rows, resumeQueue];
  if (!rows.some((a) => a.action === 'wait')) return rows;
  return [resumeQueue, ...rows.filter((a) => a.action !== 'wait')];
}

const BASE_REPAIR_NOTE =
  'Answer exactly "continue" once the conflicts are resolved in the task worktree (gates and publish run again), or exactly "retry fixer" to let another worker attempt do it. Recheck does not end this wait.';

/**
 * A wait that resumes on `answer(<qid>)` (askHuman) ends only with that answer, whatever its code:
 * the code's own row stays for the other ways out, minus what only a cooldown or a recheck clears.
 */
function questionRow(c: Ctx, rows: AllowedAction[]): AllowedAction[] {
  const w = c.s.wait;
  if (w === null || !w.resume_when.some((r) => r.startsWith('answer('))) return rows;
  const base = w.resume.kind === 'repair_base';
  const first = answer(
    c,
    base
      ? BASE_REPAIR_NOTE
      : `Read the question (cusr inbox --task ${c.id}), fix what it names if that is outside the task, then answer; the task does not move on by itself.`,
  );
  return [
    first,
    ...rows.filter(
      (a) =>
        a.action !== 'answer' && a.action !== 'fix_external' && !(base && a.action === 'recheck'),
    ),
  ];
}

function listed(c: Ctx): AllowedAction[] {
  const s = c.s;
  const detail = s.wait?.detail.code;
  if (detail !== undefined)
    return questionRow(
      c,
      ROWS[detail](c).filter((a): a is AllowedAction => a !== null),
    );
  // Once merge is proven, completion waits only for drain and reconciliation.
  if (s.completion !== null)
    return ROWS.merge_cleanup_pending(c).filter((a): a is AllowedAction => a !== null);
  if (s.status === 'READY')
    return runConfigConfirmed(s)
      ? [wait('Waits for its turn at the execution slot.'), cancel(c)]
      : runSelection(c).filter((a): a is AllowedAction => a !== null);
  return [cancel(c)];
}
