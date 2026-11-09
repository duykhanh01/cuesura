import { describe, expect, it } from 'vitest';
import type {
  BoardReply,
  CallerInfo,
  Health,
  TaskExplain,
} from '../../../src/tui/client/schemas.ts';
import type { ActionsMessage } from '../../../src/tui/model/actions.ts';
import { openDialog } from '../../../src/tui/model/dialog.ts';
import {
  FIELD_KEYS,
  bindings,
  commandFor,
  hintBar,
  keyContext,
  ownBindings,
  type Context,
} from '../../../src/tui/model/keymap.ts';
import type { Message } from '../../../src/tui/model/messages.ts';
import { reduce } from '../../../src/tui/model/reduce.ts';
import { initialLogs, type LogState } from '../../../src/tui/model/logs.ts';
import { initialState, type TuiState } from '../../../src/tui/model/state.ts';
import type { Key, KeyName } from '../../../src/tui/terminal/keys.ts';
import { sanitize, sanitizeLines, uiText } from '../../../src/tui/terminal/safe-text.ts';
import { helpLines } from '../../../src/tui/views/help.ts';
import { renderFrame } from '../../../src/tui/views/layout.ts';
import { screenBody } from '../../../src/tui/views/screen-body.ts';

// T050–T052 below the PTY: one keymap behind the keys, the bar and Help; Help returns where it was; the
// Actions menu. Regression only; US3 is accepted by test/contract/tui/us3-navigation.test.ts.
const SMALL = { cols: 80, rows: 24 };
const TASK = (n: number) => `00000000-0000-7000-8000-00000000000${n}`;

const HEALTH: Health = {
  healthy: true,
  reason: null,
  slots: [],
  concurrency: 1,
  queue_length: 0,
};

function row(n: number) {
  return {
    task_id: TASK(n),
    project: 'acme',
    title: sanitize(`Task ${n}`),
    status: 'RUNNING',
    wait_code: null,
    step: sanitize('code'),
    mode: sanitize('direct-pr'),
    status_since: null,
    version: 3,
    priority: 0,
    pr_ref: null,
    needs_user: false,
  };
}

const BOARD = {
  unchanged: false,
  watermark: 7,
  counts: { by_status: { RUNNING: 3 } },
  queue: { length: 0 },
  attention: { items: [], truncated: false },
  items: [row(1), row(2), row(3)],
  next_cursor: null,
} as unknown as BoardReply;

const OWNER: CallerInfo = {
  actor: uiText('owner'),
  roles: ['read', 'operate', 'admin'],
  trusted_confirmer: true,
};

const k = (name: KeyName): Message => ({
  type: 'key',
  key: { kind: 'key', name },
});
const ch = (text: string): Message => ({
  type: 'key',
  key: { kind: 'char', text },
});

function run(state: TuiState, ...messages: Message[]): TuiState {
  return messages.reduce((s, m) => reduce(s, m).state, state);
}

function home(size = SMALL, caller: CallerInfo | null = OWNER): TuiState {
  return {
    ...run(initialState(size), {
      type: 'read_succeeded',
      board: BOARD,
      health: HEALTH,
      at: 1,
      projects: { caller: caller ?? OWNER, projects: [], profiles: [] },
    }),
    caller,
  };
}

/** The screen as text, the way a PTY shows it. */
function screen(s: TuiState): string {
  const f = renderFrame(s, screenBody(s, { color: false }), { color: false });
  return Array.from({ length: f.rows }, (_, y) =>
    // eslint-disable-next-line no-control-regex
    f.rowBytes(y).replace(/\x1b\[[0-9;]*m/g, ''),
  ).join('\n');
}

const bar = (s: TuiState): string => screen(s).split('\n').at(-1) ?? '';

function explain(
  actions: TaskExplain['allowed_actions'],
  version = 3,
  waitCode?: string,
): TaskExplain {
  return {
    task_id: TASK(2),
    version,
    status: 'NEEDS_INPUT',
    ...(waitCode === undefined ? {} : { wait: { reason: 'approval', detail: { code: waitCode } } }),
    allowed_actions: actions,
    merge: null,
  } as unknown as TaskExplain;
}

const QUESTION = [
  {
    action: 'answer',
    command: sanitize('cusr answer Q --file FILE --expected-version 3'),
    note: sanitize('Answer or supply what is missing (FR-037–039).'),
  },
  {
    action: 'cancel',
    command: sanitize('cusr task cancel T --expected-version 3'),
    note: sanitize('Cancel reconciles the PR first (FR-025).'),
  },
];

function answered(s: TuiState, value: TaskExplain, watermark = 7): TuiState {
  const m = s.actions;
  if (m === null) throw new Error('no menu');
  const msg: ActionsMessage = {
    type: 'actions_read',
    taskId: m.taskId,
    session: m.session,
    askedAt: 10,
    at: 11,
    watermark,
    result: { ok: true, value },
  };
  return reduce(s, msg).state;
}

/** One state for each context, as keys from Home leave it. */
function contexts(): Record<Context, TuiState> {
  const h = home();
  const logs = run(h, k('enter'));
  const detail = run(logs, ch('d'));
  const menu = answered(run(h, ch('a')), explain(QUESTION));
  const dialog = (kind: 'answer' | 'recheck' | 'approve'): TuiState =>
    openDialog(menu, kind, explain(QUESTION), 3, 'acme').state;
  return {
    home: h,
    detail,
    logs,
    attempts: run(logs, ch('t')),
    actions: menu,
    dialog_text: dialog('answer'),
    dialog_confirm: dialog('approve'),
    dialog_plain: dialog('recheck'),
    filter_text: run(h, ch('f')),
    filter_choice: run(h, ch('f'), k('tab')),
    help: run(h, ch('?')),
  };
}

function keyOf(p: { name: KeyName } | { char: string }): Key {
  return 'name' in p ? { kind: 'key', name: p.name } : { kind: 'char', text: p.char };
}

/** Contexts where a printable key is text, so only Ctrl-C quits. */
const TYPING: readonly Context[] = ['filter_text', 'dialog_text', 'dialog_confirm'];

describe('the keymap is the one source of keys, hints and Help (T050)', () => {
  const all = contexts();

  it('each state is the context it stands for', () => {
    for (const [ctx, s] of Object.entries(all)) expect(keyContext(s), ctx).toBe(ctx);
  });

  it('every key a binding names acts as that binding says, where it applies', () => {
    for (const [ctx, s] of Object.entries(all) as [Context, TuiState][])
      for (const b of bindings(ctx)) {
        if (b.when !== undefined && !b.when(s)) continue;
        for (const [p, command] of b.press) {
          // An earlier binding of the same key wins; that is the one shown first.
          const first = bindings(ctx).find(
            (o) =>
              (o.when === undefined || o.when(s)) &&
              o.press.some(([q]) => JSON.stringify(q) === JSON.stringify(p)),
          );
          const expected = first?.press.find(([q]) => JSON.stringify(q) === JSON.stringify(p))?.[1];
          expect(commandFor(s, keyOf(p)), `${ctx} ${b.keys}`).toBe(expected ?? command);
        }
      }
  });

  it('the bar shows only keys that act here, and fits 80 columns with back, help and quit', () => {
    for (const [ctx, s] of Object.entries(all) as [Context, TuiState][]) {
      const shown = bar(s);
      expect(shown.length, ctx).toBeLessThanOrEqual(80);
      expect(shown, ctx).toMatch(TYPING.includes(ctx) ? /Ctrl-C quit/ : /q quit/);
      if (ctx !== 'home') expect(shown, ctx).toContain('Esc back');
      if (ctx !== 'help' && !TYPING.includes(ctx)) expect(shown, ctx).toContain('? help');
    }
    expect(bar(all.home)).toContain('a actions');
    expect(bar(all.home)).toContain('f filter');
    expect(bar(all.detail)).toContain('a actions');
    expect(bar(all.detail)).toContain('l logs');
  });

  it('waiting for the user, the bar still has back, help, quit and the retry', () => {
    for (const [ctx, s] of Object.entries(all) as [Context, TuiState][]) {
      const waiting: TuiState = {
        ...s,
        connection: { kind: 'waiting_retry' },
        stale: true,
      };
      const shown = hintBar(waiting, 80);
      expect(shown.length, ctx).toBeLessThanOrEqual(80);
      if (!TYPING.includes(ctx)) {
        expect(shown, ctx).toContain('R retry connection');
        expect(shown, ctx).toContain('q quit');
      }
      if (ctx !== 'home') expect(shown, ctx).toContain('Esc back');
    }
  });

  it('a key that does nothing is not offered: no Enter open without a task', () => {
    const empty = run(initialState(SMALL), {
      type: 'read_succeeded',
      board: { ...BOARD, items: [] } as unknown as BoardReply,
      health: HEALTH,
      at: 1,
    });
    expect(bar(empty)).not.toContain('Enter');
    expect(bar(empty)).not.toContain('a actions');
    expect(commandFor(empty, { kind: 'char', text: 'a' })).toBeNull();
  });

  it('Help lists every binding of every context, the one it came from first', () => {
    const big = { cols: 140, rows: 100 };
    const s = run(home(big), k('enter'), ch('d'), ch('?'));
    const text = screen(s);
    expect(text.indexOf('Keys on Task detail')).toBeLessThan(text.indexOf('Keys on Home'));
    for (const ctx of Object.keys(all) as Context[])
      for (const b of ownBindings(ctx)) expect(text, ctx).toContain(b.help);
    expect(text).toContain('Keys in a text field');
    expect(text).toContain('Every printable key, and a paste, is text');
    for (const f of FIELD_KEYS) expect(text).toContain(f.help);
  });

  it('Help names Home and End wherever they move to the top and end', () => {
    for (const ctx of Object.keys(all) as Context[])
      for (const b of ownBindings(ctx))
        if (b.press.some(([p]) => 'name' in p && p.name === 'home'))
          expect(b.helpKeys, `${ctx}: ${b.help}`).toBe('g G Home End');
    const text = screen(run(home({ cols: 140, rows: 70 }), ch('?')));
    expect(text).toContain('g G Home End');
  });

  it('in a text field printable keys and paste are text, never commands', () => {
    const s = all.filter_text;
    for (const c of [...'q?aRfljkgGFt C'])
      expect(commandFor(s, { kind: 'char', text: c }), c).toBeNull();
    const typed = run(s, ch('q'), ch('?'), ch('R'), {
      type: 'key',
      key: { kind: 'paste', text: 'x\ny\r\n' },
    });
    expect(typed.filterDraft?.query).toBe('q?Rx y');
    expect(typed.screens).toEqual(['home', 'filters']);
  });

  it('Backspace in the project name is a keymap command, listed in Help', () => {
    const s = run(all.filter_text, ch('a'), ch('b'));
    expect(commandFor(s, { kind: 'key', name: 'backspace' })).toBe('erase');
    expect(run(s, k('backspace')).filterDraft?.query).toBe('a');
    const choice = run(s, k('tab'));
    expect(commandFor(choice, { kind: 'key', name: 'backspace' })).toBeNull();
    expect(run(choice, k('backspace')).filterDraft?.query).toBe('ab');
    const help = helpLines(run(all.filter_text, k('tab'), ch('?')));
    expect(help.map((l) => l.text).join('\n')).toContain(
      'Delete the last character of the project name',
    );
  });
});

describe('the keys of a finished log', () => {
  const on = (logs: Partial<LogState>): TuiState => ({
    ...initialState({ cols: 120, rows: 30 }),
    screens: ['home', 'logs'],
    logs: { ...initialLogs('t1', uiText('A task'), 1), ...logs },
  });

  it('offers no pausing or following, which have nothing left to do', () => {
    const bar = hintBar(on({ complete: true }), 120);
    expect(bar).not.toContain('pause');
    expect(bar).not.toContain('live');
    expect(hintBar(on({}), 120)).toContain('Space pause/live');
  });

  it('offers hiding the progress column only where there is one', () => {
    expect(hintBar(on({}), 130)).toContain('p progress');
    const narrow = { ...on({}), size: { cols: 90, rows: 30 } };
    expect(hintBar(narrow, 90)).not.toContain('p progress');
  });

  it('keeps the way back from one attempt to the whole log', () => {
    expect(hintBar(on({ complete: true, attemptFilter: 'a1' }), 120)).toContain('Space pause/live');
  });
});

describe('task navigation after the TUI redesign', () => {
  it('opens Logs first, exposes details through the keymap and returns to Home with Esc', () => {
    const logs = run(home(), k('enter'));
    expect(logs.screens).toEqual(['home', 'logs']);
    expect(logs.detail).not.toBeNull();
    expect(commandFor(logs, { kind: 'char', text: 'd' })).toBe('details');
    expect(bar(logs)).toContain('d details');
    const back = run(logs, k('esc'));
    expect(back.screens).toEqual(['home']);
    expect(back.detail).toBeNull();
    expect(back.logs).toBeNull();
    expect(back.actions).toBeNull();
  });

  it('opens Task detail over Logs, and Esc or `l` comes back to the log as it was left', () => {
    const logs = run(home(), k('enter'));
    const reading: TuiState = {
      ...logs,
      logs: { ...(logs.logs as LogState), mode: 'paused', anchor: { seq: 7, row: 0 } },
    };
    const details = reduce(reading, ch('d'));
    expect(details.state.screens).toEqual(['home', 'logs', 'detail']);
    expect(details.state.logs).toBe(reading.logs);
    expect(details.effects).toEqual([{ type: 'read_screen' }]);
    for (const leave of [k('esc'), ch('l')]) {
      const r = reduce(details.state, leave);
      expect(r.state.screens).toEqual(['home', 'logs']);
      expect(r.state.logs).toBe(reading.logs);
      expect(r.state.detail).toBe(details.state.detail);
      expect(r.effects).toEqual([{ type: 'read_screen' }]);
    }
  });

  it('keeps Actions over Task detail over Logs one Esc apart', () => {
    const actions = run(home(), k('enter'), ch('d'), ch('a'));
    expect(actions.screens).toEqual(['home', 'logs', 'detail', 'actions']);
    const detail = run(actions, k('esc'));
    expect(detail.screens).toEqual(['home', 'logs', 'detail']);
    expect(detail.actions).toBeNull();
    expect(run(detail, k('esc')).screens).toEqual(['home', 'logs']);
    expect(run(detail, k('esc'), k('esc')).screens).toEqual(['home']);
  });

  it('goes `d` and `l` back and forth without growing the stack', () => {
    const s = run(home(), k('enter'), ch('d'), ch('l'), ch('d'), ch('l'), ch('d'));
    expect(s.screens).toEqual(['home', 'logs', 'detail']);
    expect(run(s, k('esc'), k('esc')).screens).toEqual(['home']);
  });

  it('keeps the screen legend alongside context Help and the field keys', () => {
    const lines = helpLines(run(home(), ch('?')));
    const text = lines.map((line) => line.text).join('\n');
    expect(text).toContain('Reading the screen');
    expect(text).toContain('skipped by mode');
    expect(text).toContain('Needs you');
    expect(text).toContain('Keys in a text field');
  });
});

describe('Help closes where it was (T051)', () => {
  it('on Home, Task detail, Logs and the filter, nothing under it moves', () => {
    const h = run(home(), k('down'));
    const detail = run(h, k('enter'), ch('d'), k('down'), k('down'));
    const logs = run(detail, ch('l'));
    const filter = run(h, ch('f'), ch('x'), k('tab'), k('down'));
    for (const s of [h, detail, logs, filter]) {
      const open = run(s, ch('?'), k('down'), k('pagedown'));
      expect(open.screens.at(-1)).toBe('help');
      const back = run(open, k('esc'));
      expect({ ...back, helpTop: 0 }).toEqual({ ...s, helpTop: 0 });
      expect(screen(back)).toBe(screen(s));
    }
  });

  it('q on Help over a filter with text asks again on Help itself', () => {
    const open = run(home(), ch('f'), ch('x'), k('tab'), ch('?'));
    const asked = reduce(open, ch('q'));
    expect(asked.effects).toEqual([]);
    expect(asked.state.quitArmed).toBe(true);
    expect(screen(asked.state)).toContain('Quitting loses what you typed.');
    expect(screen(asked.state)).toContain('Keys on Filter');
    // Any other key puts the question away; the same key again quits.
    expect(screen(run(asked.state, k('down')))).not.toContain('Quitting loses');
    expect(reduce(asked.state, ch('q')).effects).toEqual([{ type: 'quit', code: 0 }]);
  });

  it('? on Help does not stack another', () => {
    const s = run(home(), ch('?'), ch('?'));
    expect(s.screens).toEqual(['home', 'help']);
  });
});

describe('the Actions menu (T052)', () => {
  it('opens from Home and from Task detail, with nothing until its own read', () => {
    const fromHome = run(home(), k('down'), ch('a'));
    expect(fromHome.screens).toEqual(['home', 'actions']);
    expect(fromHome.actions?.taskId).toBe(TASK(2));
    expect(screen(fromHome)).toContain('Reading the actions of this task…');
    const r = reduce(run(home(), k('enter'), ch('d')), ch('a'));
    expect(r.state.screens).toEqual(['home', 'logs', 'detail', 'actions']);
    expect(r.effects).toEqual([{ type: 'read_screen' }]);
  });

  it('lists each allowed action with what it does, and the CLI command as text', () => {
    const s = answered(run(home(SMALL), k('down'), ch('a')), explain(QUESTION));
    const text = screen(s);
    expect(text).toContain('› Answer the question');
    expect(text).not.toContain('dialog in a later version');
    expect(text).toContain('Answer or supply what is missing (FR-037–039).');
    expect(text).toContain('Cancel task');
    expect(text).toContain('CLI: cusr task cancel T --expected-version 3');
    expect(text).toContain('Read at');
  });

  it('dims what the token may not take, and says why', () => {
    const viewer: CallerInfo = {
      ...OWNER,
      roles: ['read'],
      trusted_confirmer: false,
    };
    const s = answered(
      run(home(SMALL, viewer), ch('a')),
      explain(
        [
          ...QUESTION,
          {
            action: 'approve',
            command: sanitize('cusr task approve T --kind adopt --head-sha SHA'),
            note: sanitize('Admin only.'),
          },
        ],
        3,
        'adopt_approval',
      ),
    );
    const text = screen(s);
    expect(text).toContain('Not available: needs the operate role; you have: read');
    expect(text).toContain('Not available: needs the admin role; you have: read');
    const operator: CallerInfo = { ...OWNER, roles: ['operate'] };
    const op = { ...s, caller: operator };
    expect(screen(op)).not.toContain('needs the operate role');
    expect(screen(op)).toContain('needs the admin role; you have: operate');
    expect(screen({ ...s, caller: null })).toContain('permissions are not read yet');
  });

  it('an escalation approval needs only the operate role (#205)', () => {
    const operator: CallerInfo = { ...OWNER, roles: ['read', 'operate'] };
    const s = answered(
      run(home(SMALL, operator), ch('a')),
      explain([
        {
          action: 'approve',
          command: sanitize('cusr task approve T --kind escalation --step code --rung 1'),
          note: sanitize('Approves the requested rung.'),
        },
      ]),
    );
    expect(screen(s)).not.toContain('Not available');
  });

  it('Enter confirms nothing: it sends nothing and says so', () => {
    const s = answered(run(home(), ch('a')), explain(QUESTION));
    const r = reduce(run(s, k('down')), k('enter'));
    expect(r.effects).toEqual([]);
    expect(r.state.actions?.notice).toContain('Nothing was sent');
    const twice = reduce(r.state, k('enter'));
    expect(twice.effects).toEqual([]);
  });

  it('guidance and lines to read are what the note says; an unknown action is shown as it came', () => {
    const s = answered(
      run(home(), ch('a')),
      explain([
        {
          action: 'merge_manually',
          command: null,
          note: sanitize('Merge the PR on GitHub.'),
        },
        {
          action: 'wait',
          command: null,
          note: sanitize('Waits for the slot.'),
        },
        {
          action: 'something_new',
          command: null,
          note: sanitize('From a newer daemon.'),
        },
      ]),
    );
    const text = screen(s);
    expect(text).toContain('Merge on GitHub');
    expect(text).not.toContain('Merge on GitHub · dialog');
    expect(text).toContain('Waits for the slot.');
    expect(text).toContain('something_new');
    expect(reduce(s, k('enter')).state.actions?.notice).toContain('Nothing to send');
  });

  it('the merge guide gives the method and the proposed title and message, all of it by keyboard', () => {
    const message = Array.from({ length: 40 }, (_, i) => `body line ${i + 1}`);
    const merge = {
      ...explain([
        {
          action: 'wait',
          command: null,
          note: sanitize('Waits for the merge.'),
        },
        {
          action: 'merge_manually',
          command: null,
          note: sanitize('Merge the PR on GitHub.'),
        },
      ]),
      merge: {
        method: sanitize('squash'),
        proposed: {
          title: sanitize('feat: the proposed title'),
          message: sanitizeLines(message.join('\n')),
        },
        observed_method: null,
      },
    } as unknown as TaskExplain;
    const s = answered(run(home(), ch('a')), merge);
    // Shown under the entry while it is chosen.
    expect(screen(s)).not.toContain('Merge method');
    const on = run(s, k('down'));
    const text = screen(on);
    expect(text).toContain('Merge method: squash');
    expect(text).toContain('Proposed title: feat: the proposed title');
    expect(text).toContain('Proposed message:');
    expect(text).toContain('body line 1');
    expect(text).not.toContain('body line 40');
    expect(bar(on)).toContain('PgUp/PgDn read on');
    expect(reduce(on, k('enter')).state.actions?.notice).toContain('method, title and message');
    // PgDn reads the rest of a message longer than the screen, PgUp goes back.
    let seen = text;
    let at = on;
    for (let i = 0; i < 5; i += 1) {
      at = run(at, k('pagedown'));
      seen += screen(at);
    }
    for (const line of message) expect(seen).toContain(line);
    expect(screen(run(at, k('pagedown')))).toBe(screen(at));
    const back = run(at, k('pageup'), k('pageup'), k('pageup'), k('pageup'));
    expect(screen(run(back, k('pageup')))).toBe(text);
    // ↑ and ↓ start the next entry from its top.
    expect(run(at, k('up')).actions?.scroll).toBe(0);
  });

  it('without a merge proposal the guide says so', () => {
    const s = answered(
      run(home(), ch('a')),
      explain([
        {
          action: 'merge_manually',
          command: null,
          note: sanitize('Merge the PR on GitHub.'),
        },
      ]),
    );
    const text = screen(s);
    expect(text).toContain('Merge method: not set');
    expect(text).toContain('No proposed title or message.');
  });

  it('EC-013: reads again when anything moved; a new version says so and keeps the chosen action', () => {
    const open = answered(run(home(), ch('a')), explain(QUESTION));
    const onCancel = run(open, k('down'));
    expect(onCancel.actions?.selected).toBe(1);
    const reordered = answered(
      onCancel,
      explain([QUESTION[1] as never, QUESTION[0] as never], 4),
      8,
    );
    expect(reordered.actions?.changed).toBe(true);
    expect(reordered.actions?.selected).toBe(0);
    expect(screen(reordered)).toContain('The task changed while this menu was open');
    expect(screen(reordered)).toMatch(/› Cancel task/);
  });

  it('an answer for a menu since closed or reopened is dropped', () => {
    const open = run(home(), ch('a'));
    const stale = open.actions;
    const reopened = run(open, k('esc'), ch('a'));
    const msg: ActionsMessage = {
      type: 'actions_read',
      taskId: TASK(1),
      session: stale?.session ?? 0,
      askedAt: 1,
      at: 2,
      watermark: 7,
      result: { ok: true, value: explain(QUESTION) },
    };
    expect(reduce(reopened, msg).state.actions?.explain.data).toBeNull();
    expect(reduce(run(open, k('esc')), msg).state.actions).toBeNull();
  });

  it('Esc goes back to where it was opened, and leaving Task detail closes nothing else', () => {
    const detail = run(home(), k('down'), k('enter'), ch('d'));
    const back = run(detail, ch('a'), k('esc'));
    expect(back.screens).toEqual(['home', 'logs', 'detail']);
    expect(back.actions).toBeNull();
    expect(back.selectedTaskId).toBe(TASK(2));
  });
});

describe('the Actions menu draws only sanitized text', () => {
  it('a role name from the daemon cannot reach the terminal raw', () => {
    const odd: CallerInfo = { ...OWNER, roles: ['read\x1b[2J'] };
    const s = answered(run(home(SMALL, odd), ch('a')), explain(QUESTION));
    const f = renderFrame(s, screenBody(s, { color: false }), { color: false });
    const bytes = Array.from({ length: f.rows }, (_, y) => f.rowBytes(y)).join('\n');
    expect(bytes).not.toContain('\x1b[2J');
    expect(bytes).toContain('read␛[2J');
  });
});
