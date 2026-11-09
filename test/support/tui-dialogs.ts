import type { MutationCommand } from '../../src/tui/client/mutations.ts';
import type { BoardReply, CallerInfo, Health, TaskExplain } from '../../src/tui/client/schemas.ts';
import { InboxSchema } from '../../src/tui/client/schemas.ts';
import type { Effect, Message } from '../../src/tui/model/messages.ts';
import { reduce } from '../../src/tui/model/reduce.ts';
import { initialState, type TuiState } from '../../src/tui/model/state.ts';
import type { Key, KeyName } from '../../src/tui/terminal/keys.ts';
import { sanitize, uiText } from '../../src/tui/terminal/safe-text.ts';
import { renderFrame } from '../../src/tui/views/layout.ts';
import { screenBody } from '../../src/tui/views/screen-body.ts';
import { uuidOf } from './builders.ts';

// What the tests of the Answer, Cancel, Recheck and Approve dialogs share below the PTY: an Actions menu
// that has read its task, keys as messages, and the screen as text.

export const TASK = uuidOf(2);
export const QUESTION = '019a0000-0000-7000-8000-0000000000aa';

export const OWNER: CallerInfo = {
  actor: sanitize('owner'),
  roles: ['read', 'operate', 'admin'],
  trusted_confirmer: true,
};
export const ASSISTANT: CallerInfo = {
  ...OWNER,
  actor: sanitize('assistant'),
  roles: ['read', 'operate'],
};
export const VIEWER: CallerInfo = { ...OWNER, actor: sanitize('viewer'), roles: ['read'] };

export const SIZE = { cols: 100, rows: 40 };
export const HEALTH: Health = {
  healthy: true,
  reason: null,
  slots: [],
  concurrency: 1,
  queue_length: 0,
};
export const BOARD = {
  unchanged: false,
  watermark: 7,
  counts: { by_status: {} },
  queue: { length: 0 },
  attention: { items: [], truncated: false },
  items: [],
  next_cursor: null,
} as unknown as BoardReply;

export function explainOf(
  over: Record<string, unknown> = {},
  actions: string[] = ['answer'],
): TaskExplain {
  return {
    task_id: TASK,
    version: 3,
    revision: 1,
    status: 'WAITING',
    step: null,
    wait: null,
    allowed_actions: actions.map((action) => ({
      action,
      command: sanitize(`cusr ${action}`),
      note: sanitize(`does ${action}`),
    })),
    remaining: { agent_runs: 4, reserved: 0, escalations: 1 },
    pr: { ref: null, head_sha: null, base_sha: null, observed: null, observation_expired: false },
    pending_effects: [],
    cancellation: null,
    merge: null,
    ...over,
  } as unknown as TaskExplain;
}

export function key(name: KeyName): Message {
  return { type: 'key', key: { kind: 'key', name } as Key };
}
export const chars = (text: string): Message[] =>
  [...text].map((c) => ({ type: 'key', key: { kind: 'char', text: c } }));

export type Run = { state: TuiState; effects: Effect[] };
export function run(s: TuiState, ...ms: Message[]): Run {
  const effects: Effect[] = [];
  for (const m of ms) {
    const r = reduce(s, m);
    s = r.state;
    effects.push(...r.effects);
  }
  return { state: s, effects };
}

export function text(s: TuiState): string {
  const f = renderFrame(s, screenBody(s, { color: false }), { color: false });
  return Array.from({ length: f.rows }, (_, y) =>
    // eslint-disable-next-line no-control-regex
    f.rowBytes(y).replace(/\x1b\[[0-9;]*m/g, ''),
  ).join('\n');
}

/** An Actions menu that has read its task, with `caller`, ready for Enter on the first action. */
export function menu(caller: CallerInfo, explain: TaskExplain): TuiState {
  const online = run(initialState(SIZE), {
    type: 'read_succeeded',
    board: BOARD,
    health: HEALTH,
    at: 1,
    projects: { caller, projects: [], profiles: [] },
  }).state;
  const open = reduce(
    {
      ...online,
      selectedTaskId: TASK,
      board: {
        ...BOARD,
        items: [
          { task_id: TASK, project: 'acme', title: uiText('T'), status: 'WAITING', version: 3 },
        ],
      } as unknown as TuiState['board'],
    },
    { type: 'key', key: { kind: 'char', text: 'a' } },
  ).state;
  const session = open.actions?.session ?? 0;
  return run(
    open,
    {
      type: 'actions_read',
      taskId: TASK,
      session,
      askedAt: 10,
      at: 11,
      watermark: 7,
      result: { ok: true, value: explain },
    },
    {
      type: 'actions_show_read',
      taskId: TASK,
      session,
      askedAt: 10,
      at: 11,
      watermark: 7,
      result: { ok: true, value: { project: 'acme', version: 3 } as never },
    },
  ).state;
}

export const inboxMessage = (state: TuiState, body = 'Which database?'): Message => ({
  type: 'dialog_read',
  taskId: TASK,
  session: state.dialog?.session ?? 0,
  askedAt: 20,
  at: 21,
  watermark: 7,
  part: 'inbox',
  result: {
    ok: true,
    value: InboxSchema.parse({
      items: [
        {
          question_id: QUESTION,
          task_id: TASK,
          revision: 1,
          step: 'code',
          body,
          blocking: true,
          task_version: 3,
        },
      ],
      truncated: false,
    }),
  },
});

export const submits = (effects: Effect[]) => effects.filter((e) => e.type === 'submit');
export const sentCommand = (effects: Effect[]): MutationCommand => {
  const e = submits(effects)[0];
  if (e?.type !== 'submit') throw new Error('nothing was sent');
  return e.command;
};
