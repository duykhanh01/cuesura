import { describe, expect, it } from 'vitest';
import { DETAIL_CODES, type DetailCode, type TaskState } from '../../../src/domain/state.ts';
import { allowedActions } from '../../../src/explain/allowed-actions.ts';

const ID = '0192aaaa-0000-7000-8000-000000000001';

function state(code: DetailCode, o: Partial<TaskState> = {}): TaskState {
  return {
    id: ID,
    version: 9,
    revision: 1,
    status: 'WAITING',
    pr_ref: 'acme#7',
    terminal: null,
    completion: null,
    approvals: {},
    blockers: [],
    cancellation: null,
    policy_ref: null,
    run: { proposal: null, confirmation: null, mode: null, content: null },
    wait: {
      reason: 'policy',
      detail: { code },
      resume_when: [],
      exit_paths: [],
      resume: { kind: 'none' },
    },
    ...o,
  } as TaskState;
}

const actions = (code: DetailCode, o: Partial<TaskState> = {}, recheckable = true): string[] =>
  allowedActions(state(code, o), { recheckable }).map((a) => a.action);

describe('cancel --force while a cancel waits for the PR read (#179)', () => {
  it('is offered while only the read holds the cancel', () => {
    const out = allowedActions(state('cancel_reconcile'), { recheckable: true });
    expect(out.map((a) => a.action)).toEqual(['recheck', 'merge_manually', 'cancel']);
    expect(out.at(-1)?.command).toBe(`cusr task cancel ${ID} --force --expected-version 9`);
  });

  it('is not offered once a merge was seen', () => {
    const seen = { cancellation: { merge_seen: 'obs-1' } } as unknown as Partial<TaskState>;
    expect(actions('cancel_reconcile', seen)).toEqual(['recheck', 'merge_manually']);
  });
});

describe('allowed actions for every wait detail (T111, FR-029)', () => {
  it.each(DETAIL_CODES)('%s has a way out and promises nothing out of scope', (code) => {
    const out = allowedActions(state(code), { recheckable: true });
    expect(out.length).toBeGreaterThan(0);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/amend/i);
    expect(text).not.toMatch(/yolo/i);
    expect(text).not.toMatch(/--kind merge/);
    expect(text).not.toMatch(/extend the deadline|more attempts|retry/i);
    for (const a of out) if (a.command !== null) expect(a.command).toMatch(/^cusr /);
  });

  it.each<[DetailCode, string[]]>([
    ['merge', ['merge_manually', 'recheck', 'cancel']],
    ['deadline', ['merge_manually', 'recheck', 'cancel', 'task_add']],
    ['ci_wait_exhausted', ['merge_manually', 'recheck', 'cancel', 'task_add']],
    ['ladder_exhausted', ['merge_manually', 'recheck', 'cancel', 'task_add']],
    ['agent_runs_exhausted', ['merge_manually', 'recheck', 'cancel', 'task_add']],
    ['head_changed', ['fix_external', 'recheck', 'merge_manually', 'cancel']],
    ['target_mismatch', ['fix_external', 'recheck', 'cancel']],
    [
      'required_checks_mismatch',
      ['fix_external', 'recheck', 'merge_manually', 'cancel', 'task_add'],
    ],
    ['pr_closed', ['fix_external', 'recheck', 'cancel']],
    ['observation_expired', ['recheck', 'merge_manually', 'cancel']],
    ['merge_cleanup_pending', ['wait', 'recheck']],
    ['execution_slot', ['wait', 'cancel']],
    ['config_invalid', ['fix_external', 'confirm', 'recheck', 'cancel']],
    ['capability_missing', ['fix_external', 'confirm', 'recheck', 'cancel']],
    ['agent_question', ['answer', 'cancel']],
    ['agent_needs_context', ['answer', 'cancel']],
    ['agent_blocked', ['answer', 'cancel']],
    ['escalation', ['approve', 'cancel']],
    ['effect_unknown', ['fix_external', 'recheck', 'cancel']],
    ['auth_config', ['fix_external', 'recheck', 'cancel']],
    ['rate_limited', ['fix_external', 'recheck', 'cancel']],
  ])('%s lists the FR-029 row', (code, expected) => {
    expect(actions(code)).toEqual(expected);
  });

  it('without a PR the spent limits leave only cancel and an independent task', () => {
    expect(actions('deadline', { pr_ref: null }, false)).toEqual(['cancel', 'task_add']);
  });

  it('never offers a recheck the service would refuse', () => {
    for (const code of DETAIL_CODES) expect(actions(code, {}, false)).not.toContain('recheck');
  });

  it.each<DetailCode>(['ladder_exhausted', 'rung_denied', 'escalations_exhausted'])(
    '%s offers continuing on the current model first, then another model',
    (code) => {
      const o = {
        deadline_passed: false,
        last_fix_step: null,
        wait: {
          reason: 'policy',
          detail: { code, step: 'fix_review' },
          resume_when: [],
          exit_paths: [],
          resume: { kind: 'start_attempt', step: 'fix_review' },
        },
      } as unknown as Partial<TaskState>;
      const out = allowedActions(state(code, o), { recheckable: false });
      expect(out.map((a) => a.action)).toEqual([
        'continue',
        'amend_policy',
        'merge_manually',
        'cancel',
        'task_add',
      ]);
      expect(out[0]?.command).toBe(`cusr task continue ${ID} --expected-version 9`);
      expect(out[1]?.command).toBe(`cusr task amend-policy ${ID} --model MODEL`);
      expect(out[1]?.requires).toBe('admin');
      expect(JSON.stringify(out)).not.toMatch(/more attempts|retry/i);
    },
  );

  it('a confirmed merge still draining cannot be cancelled away', () => {
    expect(actions('merge_cleanup_pending')).not.toContain('cancel');
  });

  it('the approve command names the open request of this revision', () => {
    const [approve] = allowedActions(
      state('escalation', {
        approvals: {
          a: {
            id: 'a',
            kind: 'escalation',
            revision: 1,
            step: 'code',
            rung: 2,
            status: 'requested',
          },
        } as unknown as TaskState['approvals'],
      }),
      { recheckable: false },
    );
    expect(approve?.command).toContain('--step code --rung 2');
  });

  describe('run selection not confirmed (M01/M02)', () => {
    const proposal = (revision = 1) =>
      ({
        digest: 'sha256:abc',
        selection: { revision },
      }) as unknown as TaskState['run']['proposal'];
    const ready = (o: Partial<TaskState['run']>): TaskState =>
      ({
        ...state('merge'),
        status: 'READY',
        wait: null,
        pr_ref: null,
        run: { proposal: null, confirmation: null, ...o },
      }) as TaskState;
    const of = (s: TaskState) => allowedActions(s, { recheckable: false });

    it('READY with no selection cannot queue: propose, never wait', () => {
      expect(of(ready({})).map((a) => a.action)).toEqual(['propose', 'cancel']);
    });

    it('READY with a selection: the confirm command carries its digest', () => {
      const out = of(ready({ proposal: proposal() }));
      expect(out.map((a) => a.action)).toEqual(['confirm', 'propose', 'cancel']);
      expect(out[0]?.command).toContain('--run-config sha256:abc');
    });

    it('a selection of an older revision can only be proposed again', () => {
      expect(of(ready({ proposal: proposal(0) })).map((a) => a.action)).toEqual([
        'propose',
        'cancel',
      ]);
    });

    it('run_config_unconfirmed before the start: same; after it, both are refused by the engine', () => {
      const before = {
        ...state('run_config_unconfirmed'),
        run: { proposal: proposal(), confirmation: null },
      } as TaskState;
      expect(of(before)[0]?.command).toContain('--run-config sha256:abc');
      const started = {
        ...before,
        policy_ref: { revision: 1, hash: 'h', version: 1 },
      } as TaskState;
      expect(of(started).map((a) => a.action)).toEqual(['cancel', 'task_add', 'pause']);
    });
  });

  it('a terminal task only points at an independent task', () => {
    expect(
      actions('merge', {
        status: 'DONE',
        wait: null,
        terminal: { kind: 'DONE', reason: 'merged' },
      }),
    ).toEqual(['task_add']);
  });
});

describe('merge_manually says what records the merge (#209)', () => {
  const note = (o: Partial<TaskState>): string =>
    allowedActions(state('ci_wait_exhausted', o), { recheckable: true }).find(
      (a) => a.action === 'merge_manually',
    )?.note ?? '';
  const DEADLINE = Date.UTC(2026, 11, 7);
  const observing = (o: { next_due_at: number | null; expired?: boolean; count?: number }) =>
    ({
      runtime_ref: 'rt',
      observation: {
        expired: o.expired ?? false,
        budget: {
          next_due_at: o.next_due_at,
          deadline_at: DEADLINE,
          count: o.count ?? 0,
          max_count: 2000,
        },
      },
    }) as unknown as Partial<TaskState>;

  it('names when the next observation round reads the PR', () => {
    const at = Date.UTC(2026, 10, 7, 13, 8, 0);
    expect(note(observing({ next_due_at: at }))).toContain(`due at ${at}, Unix ms`);
  });

  it('asks for a recheck when no observation round will read the PR', () => {
    for (const o of [
      {},
      observing({ next_due_at: null, expired: true }),
      observing({ next_due_at: DEADLINE }),
      observing({ next_due_at: DEADLINE - 1, count: 2000 }),
      { runtime_ref: null } as Partial<TaskState>,
    ]) {
      expect(note(o)).toMatch(/then run recheck/);
      expect(note(o)).not.toMatch(/due at/);
    }
  });
});

const QID = '0192aaaa-0000-7000-8000-0000000000aa';
/** A wait askHuman made: it resumes only on the answer to QID. */
const asked = (code: DetailCode, resume: unknown) =>
  ({
    status: 'WAITING',
    wait: {
      reason: 'human_input',
      detail: { code, question_id: QID },
      resume_when: [`answer(${QID})`],
      exit_paths: [],
      resume,
    },
  }) as unknown as Partial<TaskState>;

describe('a wait on a question offers its answer first (#265)', () => {
  const QUESTION_CODES: DetailCode[] = [
    'loop_exhausted',
    'ci_unclassified',
    'merge_not_done',
    'base_outdated',
    'attempt_stopped',
    'auth_config',
    'refused',
    'timeout',
    'effect_failed',
    'publish_content_invalid',
  ];

  it.each(QUESTION_CODES)('%s with answer(<qid>) in resume_when', (code) => {
    const out = allowedActions(state(code, asked(code, { kind: 'none' })), { recheckable: true });
    expect(out[0]).toMatchObject({
      action: 'answer',
      command: `cusr answer ${QID} --file FILE --expected-version 9`,
      requires: 'operate',
    });
    expect(out.filter((a) => a.action === 'answer')).toHaveLength(1);
    expect(out.map((a) => a.action)).not.toContain('fix_external');
  });

  it('publish_content_invalid: answer, then the other ways out', () => {
    expect(
      actions('publish_content_invalid', asked('publish_content_invalid', { kind: 'none' })),
    ).toEqual(['answer', 'merge_manually', 'recheck', 'cancel', 'task_add']);
  });

  it('base repair names the two answers it takes and offers no recheck', () => {
    const out = allowedActions(
      state('refused', asked('refused', { kind: 'repair_base', mode: 'manual' })),
      { recheckable: true },
    );
    expect(out.map((a) => a.action)).toEqual(['answer', 'cancel']);
    expect(out[0]?.note).toContain('"continue"');
    expect(out[0]?.note).toContain('"retry fixer"');
  });
});

describe('a task already cancelling is not offered cancel again (#265)', () => {
  const cancelling = {
    cancellation: { requested_at: 1, late: false },
  } as unknown as Partial<TaskState>;

  it('a running task waits for the cancel instead', () => {
    const out = allowedActions(
      { ...state('merge'), status: 'RUNNING', wait: null, ...cancelling },
      { recheckable: false },
    );
    expect(out.map((a) => a.action)).toEqual(['wait']);
    expect(out[0]?.note).toMatch(/cancel requested/i);
  });

  it('a waiting task keeps its other ways out, without plain cancel', () => {
    for (const code of DETAIL_CODES) {
      const out = allowedActions(state(code, cancelling), { recheckable: true });
      expect(out.some((a) => a.action === 'cancel' && !a.command?.includes('--force'))).toBe(false);
    }
  });
});

describe('cancel says which dependents it ends (#265, #249)', () => {
  const note = (dependents: number) =>
    allowedActions(state('merge'), { recheckable: false, dependents }).find(
      (a) => a.action === 'cancel',
    )?.note;

  it('cancel --force of cancel_reconcile warns the same way', () => {
    const force = allowedActions(state('cancel_reconcile'), {
      recheckable: true,
      dependents: 2,
    }).find((a) => a.command?.includes('--force') === true);
    expect(force?.note).toContain('also cancels 2 dependent tasks');
  });

  it('names the count only when there are some', () => {
    expect(note(0)).not.toMatch(/dependent/);
    expect(note(1)).toContain('also cancels 1 dependent task listed under dependents');
    expect(note(3)).toContain('also cancels 3 dependent tasks');
  });
});

describe('commands are copyable and say who may run them (#265, #258)', () => {
  it.each(DETAIL_CODES)('%s: no <...> or [...] in a command, and requires matches it', (code) => {
    const all = [
      ...allowedActions(state(code), { recheckable: true }),
      ...allowedActions(state(code, { policy_ref: { revision: 1, hash: 'h', version: 1 } }), {
        recheckable: true,
      }),
    ];
    for (const a of all) {
      expect(a.command ?? '').not.toMatch(/[<>[\]]/);
      expect(a.requires === null).toBe(a.command === null);
    }
  });

  it('pause needs no reason', () => {
    const started = { policy_ref: { revision: 1, hash: 'h', version: 1 } } as Partial<TaskState>;
    const pause = allowedActions(state('merge', started), { recheckable: false }).find(
      (a) => a.action === 'pause',
    );
    expect(pause?.command).toBe(`cusr task pause ${ID} --expected-version 9`);
  });

  it('escalation without a recorded request reads step and rung from the wait, else no command', () => {
    const wait = (detail: Record<string, unknown>) =>
      ({
        wait: {
          reason: 'approval',
          detail: { code: 'escalation', ...detail },
          resume_when: [],
          exit_paths: [],
          resume: { kind: 'none' },
        },
      }) as unknown as Partial<TaskState>;
    const approve = (o: Partial<TaskState>) =>
      allowedActions(state('escalation', o), { recheckable: false })[0];
    expect(approve(wait({ step: 'code', rung: 1 }))?.command).toContain('--step code --rung 1');
    expect(approve(wait({}))).toMatchObject({ command: null, requires: null });
    expect(JSON.stringify(approve(wait({})))).not.toMatch(/STEP|--rung N/);
  });
});

describe('what holds a task that has not started (#256)', () => {
  const confirmed = {
    proposal: { digest: 'sha256:abc', selection: { revision: 1 } },
    confirmation: { digest: 'sha256:abc' },
    mode: null,
    content: null,
  } as unknown as TaskState['run'];
  const ready = { ...state('merge'), status: 'READY', wait: null, pr_ref: null, run: confirmed };

  it('a paused queue replaces waiting for a turn with resuming the queue', () => {
    const s = ready as TaskState;
    expect(allowedActions(s, { recheckable: false }).map((a) => a.note)).toContain(
      'Waits for its turn at the execution slot.',
    );
    const out = allowedActions(s, { recheckable: false, queuePaused: true });
    expect(out.map((a) => a.action)).toEqual(['resume_queue', 'cancel']);
    expect(out[0]).toMatchObject({ command: 'cusr queue resume', requires: 'operate' });
    expect(JSON.stringify(out)).not.toContain('Waits for its turn');
  });

  it('leaves a started task alone', () => {
    const s = { ...ready, policy_ref: { revision: 1, hash: 'h', version: 1 } } as TaskState;
    expect(
      allowedActions(s, { recheckable: false, queuePaused: true }).map((a) => a.action),
    ).not.toContain('resume_queue');
  });

  it('a dependency wait names the prerequisite that will not move on by itself', () => {
    const s = { ...state('dependency_pending'), status: 'PENDING', pr_ref: null } as TaskState;
    const dep = uuidLike(2);
    const other = uuidLike(3);
    const out = allowedActions(s, {
      recheckable: false,
      queuePaused: true,
      prerequisites: [
        { task_id: dep, status: 'WAITING', wait_code: 'paused', paused: true, needs_user: true },
        { task_id: other, status: 'RUNNING', wait_code: null, paused: false, needs_user: false },
      ],
    });
    expect(out.map((a) => a.action)).toEqual(['wait', 'cancel', 'resume_queue']);
    expect(out[0]?.note).toContain(`Blocked by ${dep} (WAITING, paused)`);
    expect(out[0]?.note).not.toContain(other);
  });

  it('with no prerequisite stuck, lists the ones still running', () => {
    const s = { ...state('dependency_pending'), status: 'PENDING', pr_ref: null } as TaskState;
    const out = allowedActions(s, {
      recheckable: false,
      prerequisites: [
        { task_id: uuidLike(2), status: 'DONE', wait_code: null, paused: false, needs_user: false },
        {
          task_id: uuidLike(3),
          status: 'RUNNING',
          wait_code: null,
          paused: false,
          needs_user: false,
        },
      ],
    });
    expect(out[0]?.note).toContain(`Waiting on ${uuidLike(3)} (RUNNING).`);
    expect(out[0]?.note).not.toContain(uuidLike(2));
  });
});

function uuidLike(n: number): string {
  return `0192aaaa-0000-7000-8000-${String(n).padStart(12, '0')}`;
}
