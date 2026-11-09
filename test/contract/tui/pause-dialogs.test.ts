import { describe, expect, it } from 'vitest';
import type { Mutation, MutationCommand } from '../../../src/tui/client/mutations.ts';
import type {
  BoardReply,
  CallerInfo,
  Health,
  TaskExplain,
  TaskShow,
} from '../../../src/tui/client/schemas.ts';
import { initialDetail } from '../../../src/tui/model/detail.ts';
import type { Effect, Message } from '../../../src/tui/model/messages.ts';
import { reduce } from '../../../src/tui/model/reduce.ts';
import { currentScreen, initialState, type TuiState } from '../../../src/tui/model/state.ts';
import type { KeyName } from '../../../src/tui/terminal/keys.ts';
import { sanitize, sanitizeLines, uiText } from '../../../src/tui/terminal/safe-text.ts';
import { renderFrame } from '../../../src/tui/views/layout.ts';
import { screenBody } from '../../../src/tui/views/screen-body.ts';

// Issue #155: pause, resume and continue a task, and pause or resume the queue, from the TUI. Below the PTY:
// what each dialog sends, with which version, what a refusal and a read-only caller see, and how it looks
// at 80×24. `pause-pty.test.ts` sends the same through a real daemon.
const SMALL = { cols: 80, rows: 24 };
const TASK = '00000000-0000-7000-8000-000000000002';
const AT = new Date(2026, 10, 9, 10, 2, 3).getTime();

const HEALTH: Health = { healthy: true, reason: null, slots: [], concurrency: 1, queue_length: 0 };
const OWNER: CallerInfo = {
  actor: uiText('owner'),
  roles: ['read', 'operate', 'admin'],
  trusted_confirmer: true,
};
const READER: CallerInfo = { actor: uiText('viewer'), roles: ['read'], trusted_confirmer: false };

function row(paused: boolean, waitCode: string | null = 'checks_incomplete') {
  return {
    task_id: TASK,
    project: 'acme',
    title: sanitize('Fix the login page'),
    status: 'WAITING',
    wait_code: waitCode,
    step: sanitize('ci'),
    mode: sanitize('direct-pr'),
    status_since: null,
    version: 7,
    priority: 0,
    pr_ref: null,
    needs_user: false,
    paused: paused ? { reason: sanitize('release freeze'), by: sanitize('owner'), at: AT } : null,
  };
}

function board(o: { paused?: boolean; queue?: string | null } = {}): BoardReply {
  return {
    unchanged: false,
    watermark: 7,
    counts: { by_status: { WAITING: 1 } },
    queue: { length: 0 },
    attention: { items: [], truncated: false },
    items: [row(o.paused ?? false)],
    next_cursor: null,
    queue_paused:
      (o.queue ?? null) === null
        ? null
        : { reason: sanitize(o.queue ?? ''), by: sanitize('owner'), at: AT },
  } as unknown as BoardReply;
}

const k = (name: KeyName): Message => ({ type: 'key', key: { kind: 'key', name } });
const ch = (text: string): Message => ({ type: 'key', key: { kind: 'char', text } });
const typed = (text: string): Message[] => [...text].map(ch);

function step(s: TuiState, ...ms: Message[]): { s: TuiState; effects: Effect[] } {
  const effects: Effect[] = [];
  for (const m of ms) {
    const r = reduce(s, m);
    s = r.state;
    effects.push(...r.effects);
  }
  return { s, effects };
}
const run = (s: TuiState, ...ms: Message[]): TuiState => step(s, ...ms).s;

function home(o: { caller?: CallerInfo; paused?: boolean; queue?: string | null } = {}) {
  return run(initialState(SMALL), {
    type: 'read_succeeded',
    board: board(o),
    health: HEALTH,
    at: AT,
    projects: { caller: o.caller ?? OWNER, projects: [], profiles: [] },
  });
}

const ACTIONS = {
  pause: {
    action: 'pause',
    command: sanitize(`cusr task pause ${TASK} --expected-version 7`),
    note: sanitizeLines('Work already started finishes; no new step starts until resumed.'),
  },
  resume: {
    action: 'resume',
    command: sanitize(`cusr task resume ${TASK} --expected-version 7`),
    note: sanitizeLines('Unpauses the task: the step it stopped at runs as it would have.'),
  },
  continue: {
    action: 'continue',
    command: sanitize(`cusr task continue ${TASK} --expected-version 7`),
    note: sanitizeLines('Keeps the current model: the step gets a fresh set of tries.'),
  },
} as const;

function explain(
  actions: readonly (keyof typeof ACTIONS)[],
  o: { version?: number; paused?: boolean } = {},
): TaskExplain {
  return {
    task_id: TASK,
    version: o.version ?? 7,
    revision: 1,
    status: 'WAITING',
    step: sanitize('ci'),
    wait: { reason: sanitize('checks pending'), detail: { code: 'checks_incomplete' } },
    allowed_actions: actions.map((a) => ACTIONS[a]),
    limits_frozen: true,
    bindings_used: [],
    remaining: { agent_runs: null, reserved: 0, escalations: null },
    escalations: [],
    pending_effects: [],
    cancellation: null,
    blockers: [],
    pr: { ref: null, head_sha: null, base_sha: null, observed: null, observation_expired: false },
    deadline: { state: 'not_started', remaining_ms: null, max_wall_ms: null },
    slot: { holding: false, hold: null, queued: null, initial_wait_ms: 0, resumed_wait_ms: 0 },
    prerequisites: [],
    merge_cleanup: null,
    evidence: { gates: [], reviews: [], review_skipped: [], ci: [] },
    merge: null,
    paused:
      o.paused === true
        ? { reason: sanitize('release freeze'), by: sanitize('owner'), at: AT }
        : null,
  } as unknown as TaskExplain;
}

/** Actions open on the task, its explanation and `task_show` read. */
function menu(
  actions: readonly (keyof typeof ACTIONS)[],
  o: { caller?: CallerInfo; version?: number } = {},
): TuiState {
  const s = run(home(o), ch('a'));
  const m = s.actions;
  if (m === null) throw new Error('no menu');
  const read = { taskId: TASK, session: m.session, askedAt: AT, at: AT, watermark: 7 };
  return run(
    s,
    { type: 'actions_read', ...read, result: { ok: true, value: explain(actions, o) } },
    {
      type: 'actions_show_read',
      ...read,
      result: { ok: true, value: { project: 'acme', version: o.version ?? 7 } as TaskShow },
    },
  );
}

/** Moves to the entry whose label is `label` and presses Enter. */
function choose(s: TuiState, label: string): TuiState {
  for (let i = 0; i < 5 && !screen(s).includes(`› ${label}`); i++) s = run(s, k('down'));
  return run(s, k('enter'));
}

function screen(s: TuiState): string {
  const f = renderFrame(s, screenBody(s, { color: false }), { color: false });
  return Array.from({ length: f.rows }, (_, y) =>
    // eslint-disable-next-line no-control-regex
    f.rowBytes(y).replace(/\x1b\[[0-9;]*m/g, ''),
  ).join('\n');
}

const submitted = (effects: readonly Effect[]): MutationCommand[] =>
  effects.flatMap((e) => (e.type === 'submit' ? [e.command] : []));

function settled(command: MutationCommand, state: Mutation['state'], result: Mutation['result']) {
  return {
    type: 'mutation_changed',
    mutation: { requestId: 'req-1', command, state, result, checks: 0, resends: 0 },
  } as const satisfies Message;
}

describe('the pause dialog', () => {
  it('asks for a reason and --now, then sends task_pause with the version on screen', () => {
    const open = choose(menu(['pause', 'resume']), 'Pause task');
    expect(currentScreen(open)).toBe('dialog');
    const shown = screen(open);
    expect(shown).toContain('Pause task — Fix the login page');
    expect(shown).toContain('Sent with version 7');
    expect(shown).toContain('[ ] Also stop the agent turn running now (--now)');
    expect(shown.split('\n').at(-1)).toContain('Ctrl-S send');

    // Nothing goes out without a reason, nor on Enter; q and Space are text in the field.
    const empty = step(open, k('ctrl_s'), k('enter'));
    expect(submitted(empty.effects)).toEqual([]);
    expect(screen(empty.s)).toContain('Nothing was sent: give a reason first.');

    const filled = run(open, ...typed('quiet hours'), k('tab'), ch(' '));
    expect(screen(filled)).toContain('[x] Also stop the agent turn running now');
    const sent = step(filled, k('ctrl_s'));
    expect(submitted(sent.effects)).toEqual([
      {
        kind: 'task_pause',
        project: 'acme',
        task_id: TASK,
        expected_version: 7,
        payload: { reason: 'quiet hours', now: true },
      },
    ]);
    // The dialog waits for the daemon's word, then gives the menu back.
    expect(screen(sent.s)).toContain('Sending…');
    const command = submitted(sent.effects)[0] as MutationCommand;
    expect(currentScreen(run(sent.s, settled(command, 'accepted', { ok: true, value: {} })))).toBe(
      'actions',
    );
  });

  it('leaves --now out unless it is chosen, and Esc sends nothing', () => {
    const open = run(choose(menu(['pause']), 'Pause task'), ...typed('lunch'));
    expect(submitted(step(open, k('esc')).effects)).toEqual([]);
    expect(currentScreen(run(open, k('esc')))).toBe('actions');
    expect(submitted(step(open, k('ctrl_s')).effects)[0]?.payload).toEqual({ reason: 'lunch' });
  });

  it('sends nothing once the task moved since the dialog opened', () => {
    const open = run(choose(menu(['pause']), 'Pause task'), ...typed('lunch'));
    const m = open.actions;
    if (m === null) throw new Error('no menu');
    const moved = run(open, {
      type: 'actions_show_read',
      taskId: TASK,
      session: m.session,
      askedAt: AT + 1,
      at: AT + 1,
      watermark: 8,
      result: { ok: true, value: { project: 'acme', version: 8 } as TaskShow },
    });
    const r = step(moved, k('ctrl_s'));
    expect(submitted(r.effects)).toEqual([]);
    expect(screen(r.s)).toContain('the task changed since this dialog opened');
  });
});

describe('the resume and continue dialogs', () => {
  for (const [action, label, kind] of [
    ['resume', 'Resume task', 'task_resume'],
    ['continue', 'Continue task', 'task_continue'],
  ] as const) {
    it(`${label}: Ctrl-S sends ${kind} with the version, Enter sends nothing`, () => {
      const open = choose(menu([action], { version: 9 }), label);
      expect(screen(open)).toContain(`${label} — Fix the login page`);
      expect(screen(open)).toContain(ACTIONS[action].note);
      expect(submitted(step(open, k('enter')).effects)).toEqual([]);
      expect(submitted(step(open, k('ctrl_s')).effects)).toEqual([
        { kind, project: 'acme', task_id: TASK, expected_version: 9, payload: {} },
      ]);
    });
  }

  it('shows a refusal in the dialog, then under the menu, with its code and message', () => {
    const s = menu(['resume']);
    const r = step(choose(s, 'Resume task'), k('ctrl_s'));
    const command = submitted(r.effects)[0] as MutationCommand;
    const refused = run(
      r.s,
      settled(command, 'rejected', {
        ok: false,
        code: 'stale_version',
        message: 'task is at version 8',
      }),
    );
    expect(currentScreen(refused)).toBe('dialog');
    expect(screen(refused)).toContain('stale_version: task is at version 8');
    expect(screen(run(refused, k('esc')))).toContain(
      'Rejected: stale_version: task is at version 8',
    );
  });
});

describe('a caller with the read role only', () => {
  it('sees the three actions dimmed with why, and Enter opens no dialog', () => {
    const s = menu(['pause', 'resume', 'continue'], { caller: READER });
    const shown = screen(s);
    expect(shown).toContain('Not available: needs the operate role; you have: read');
    const after = step(s, k('enter'));
    expect(currentScreen(after.s)).toBe('actions');
    expect(submitted(after.effects)).toEqual([]);
    expect(screen(after.s)).toContain('Nothing was sent: Pause task needs the operate role');
  });

  it('can open the queue dialog to read it, but Ctrl-S says why nothing was sent', () => {
    const open = run(home({ caller: READER }), ch('p'), ...typed('freeze'));
    expect(screen(open)).toContain('Not available: needs the operate role; you have: read');
    const r = step(open, k('ctrl_s'));
    expect(submitted(r.effects)).toEqual([]);
    expect(screen(r.s)).toContain('Nothing was sent: Pause the queue needs the operate role');
  });
});

describe('the queue on Home', () => {
  it('says the queue is paused, by whom, when and why, and offers p to resume', () => {
    const s = home({ queue: 'maintenance window' });
    const lines = screen(s).split('\n');
    expect(lines.find((l) => l.includes('Queue paused'))).toContain(
      '‖ Queue paused: maintenance window · by owner at 10:02:03 · p to resume',
    );
    // At 80 columns the bar keeps the way out of a pause; pausing it has room on a wider one, and Help.
    expect(lines.at(-1)).toContain('p resume queue');
    expect(screen(home())).not.toContain('Queue paused');
    const wide = { ...home(), size: { cols: 120, rows: 30 } };
    expect(screen(wide).split('\n').at(-1)).toContain('p pause queue');
  });

  it('keeps the queue pause from an unchanged board reply', () => {
    const s = run(home(), {
      type: 'read_succeeded',
      board: {
        unchanged: true,
        watermark: 7,
        queue_paused: { reason: uiText('ops'), by: uiText('owner'), at: AT },
      },
      health: HEALTH,
      at: AT + 1,
    });
    expect(screen(s)).toContain('Queue paused: ops');
  });

  it('p pauses the queue with a reason: queue_pause names no project, task or version', () => {
    const open = run(home(), ch('p'));
    expect(screen(open)).toContain('Pause the queue');
    const r = step(open, ...typed('deploy'), k('ctrl_s'));
    const [command] = submitted(r.effects);
    expect(command).toEqual({
      kind: 'queue_pause',
      project: null,
      task_id: null,
      expected_version: null,
      payload: { reason: 'deploy' },
    });
    expect(currentScreen(r.s)).toBe('dialog');
    // A refusal is said in the dialog, and stays on Home until something else is sent.
    const refused = run(
      r.s,
      settled(command as MutationCommand, 'rejected', {
        ok: false,
        code: 'forbidden',
        message: 'no',
      }),
    );
    expect(screen(refused)).toContain('The daemon refused it (forbidden: no)');
    expect(screen(run(refused, k('esc')))).toContain(
      'Queue (queue_pause): Rejected: forbidden: no',
    );
  });

  it('C on Home checks an unresolved queue change again; once settled the queue can be changed again', () => {
    const r = step(home(), ch('p'), ...typed('deploy'), k('ctrl_s'));
    const command = submitted(r.effects)[0] as MutationCommand;
    const lost = run(r.s, settled(command, 'unresolved', null));
    const lines = screen(lost).split('\n');
    expect(lines.find((l) => l.includes('Queue (queue_pause)'))).toContain(
      'could not be confirmed',
    );
    expect(lines.at(-1)).toContain('C check queue again');

    // Every queue change waits for it, and says how to get out.
    const blocked = step(lost, ch('p'), ...typed('again'), k('ctrl_s'));
    expect(submitted(blocked.effects)).toEqual([]);
    expect(screen(blocked.s)).toContain('then C on Home to check again');

    expect(step(lost, ch('C')).effects).toEqual([{ type: 'check_again', requestId: 'req-1' }]);
    // The new round finds the result: the queue is free again.
    const found = run(lost, settled(command, 'accepted', { ok: true, value: {} }));
    expect(screen(found).split('\n').at(-1)).not.toContain('C check queue again');
    expect(step(found, ch('C')).effects).toEqual([]);
    expect(submitted(step(found, ch('p'), ...typed('again'), k('ctrl_s')).effects)).toHaveLength(1);
  });

  it('p on a paused queue asks to resume it and sends queue_resume', () => {
    const open = run(home({ queue: 'ops' }), ch('p'));
    expect(screen(open)).toContain('Resume the queue');
    expect(screen(open)).toContain('Paused by owner at 10:02:03: ops');
    expect(submitted(step(open, k('ctrl_s')).effects)).toEqual([
      { kind: 'queue_resume', project: null, task_id: null, expected_version: null, payload: {} },
    ]);
  });

  it('sends nothing on the queue while the data may be out of date', () => {
    const stale = run(home(), {
      type: 'read_failed',
      failure: { ok: false, permanent: null },
    });
    const r = step(stale, ch('p'), ...typed('x'), k('ctrl_s'));
    expect(submitted(r.effects)).toEqual([]);
    expect(screen(r.s)).toContain('the data on screen may be out of date');
  });
});

describe('a paused task on Home and in Task detail', () => {
  it('Home marks a paused task waiting on CI and names who paused it, when and why', () => {
    const shown = screen(home({ paused: true }));
    expect(shown).toMatch(/Paused · Waiting for CI/);
    expect(shown).toContain(' Paused  by owner at 10:02:03: release freeze');
  });

  it('Task detail says it is paused while it waits on something else', () => {
    const s0 = home({ paused: true });
    const s: TuiState = {
      ...s0,
      screens: ['home', 'detail'],
      detail: {
        ...initialDetail(TASK, uiText('Fix the login page'), 1),
        explain: {
          data: explain(['resume'], { paused: true }),
          error: null,
          attemptAt: AT,
          readAt: AT,
        },
      },
    };
    expect(screen(s)).toContain('‖ Paused by owner at 10:02:03: release freeze');
  });
});
