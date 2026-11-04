/**
 * The Actions menu of one task (FR-016, EC-013). What it lists is `allowed_actions` of a `task_explain` read
 * when the menu opens, never the one Task detail holds, and read again whenever anything moved, so a menu
 * that is no longer valid is replaced instead of acted on. Nothing here is sent: dialogs come with US4 and US5.
 */
import type { PortResult } from '../client/daemon-port.ts';
import type { TaskExplain } from '../client/schemas.ts';
import { uiText, type SafeText } from '../terminal/safe-text.ts';
import { actionItems, actionsPaging, enterNotice } from '../views/actions.ts';
import { contentHeight } from '../views/disconnected.ts';
import { EXPLAIN_READ_MS, noPart, type Part } from './detail.ts';
import type { Command } from './keymap.ts';
import type { Effect } from './messages.ts';
import type { TuiState } from './state.ts';

export type ActionsMenu = {
  readonly taskId: string;
  readonly title: SafeText;
  /** See `TuiState.screenSession`. */
  readonly session: number;
  readonly explain: Part<TaskExplain>;
  /** The board's watermark the explanation was asked under. */
  readonly watermark: number | null;
  readonly selected: number;
  /** The task changed while the menu was open, and what it lists was read again. */
  readonly changed: boolean;
  /** What the last Enter did, said where it was pressed. */
  readonly notice: SafeText | null;
  /** Rows of the chosen entry scrolled past, when it is longer than the screen. */
  readonly scroll: number;
};

type Reduced = {
  readonly state: TuiState;
  readonly effects: readonly Effect[];
};

export const CHANGED_NOTICE =
  'The task changed while this menu was open; its actions were read again.';

export function openActions(state: TuiState, taskId: string, title: SafeText): Reduced {
  const session = state.screenSession + 1;
  return {
    state: {
      ...state,
      screens: [...state.screens, 'actions'],
      actions: {
        taskId,
        title,
        session,
        explain: noPart(),
        watermark: null,
        selected: 0,
        changed: false,
        notice: null,
        scroll: 0,
      },
      screenSession: session,
    },
    effects: [{ type: 'read_screen' }],
  };
}

export function leaveActions(state: TuiState): TuiState {
  return {
    ...state,
    screens: state.screens.slice(0, state.screens.lastIndexOf('actions')),
    actions: null,
  };
}

/** Read when opened, after anything in the daemon moved, and again a while after a failure. */
export function actionsDue(m: ActionsMenu, watermark: number | null, now: number): boolean {
  const asked = m.explain.attemptAt;
  if (asked === null) return true;
  if (m.explain.error !== null) return now - asked >= EXPLAIN_READ_MS;
  return watermark !== null && watermark !== m.watermark;
}

export type ActionsMessage = {
  readonly type: 'actions_read';
  readonly taskId: string;
  readonly session: number;
  readonly askedAt: number;
  readonly at: number;
  readonly watermark: number | null;
  readonly result: PortResult<TaskExplain>;
};

export function onActionsRead(state: TuiState, m: ActionsMessage): TuiState {
  const menu = state.actions;
  if (menu === null || menu.taskId !== m.taskId || menu.session !== m.session) return state;
  if (!m.result.ok)
    return {
      ...state,
      actions: {
        ...menu,
        explain: {
          ...menu.explain,
          error: m.result.error.message,
          attemptAt: m.askedAt,
        },
        watermark: m.watermark,
      },
    };
  const before = menu.explain.data;
  const after = m.result.value;
  const changed = before !== null && before.version !== after.version;
  // The selection follows the action, not the row, so a new list cannot move it onto another (EC-013).
  const was =
    before === null ? undefined : actionItems(before, state.caller)[menu.selected]?.action;
  const items = actionItems(after, state.caller);
  const found = was === undefined ? -1 : items.findIndex((i) => i.action === was);
  return {
    ...state,
    actions: {
      ...menu,
      explain: { data: after, error: null, attemptAt: m.askedAt, readAt: m.at },
      watermark: m.watermark,
      selected: found >= 0 ? found : Math.min(menu.selected, Math.max(0, items.length - 1)),
      changed: menu.changed || changed,
      notice: changed ? null : menu.notice,
    },
  };
}

/** `null`: not a command of this screen. */
export function onActionsCommand(state: TuiState, command: Command): Reduced | null {
  const menu = state.actions;
  if (menu === null) return null;
  const items = menu.explain.data === null ? [] : actionItems(menu.explain.data, state.caller);
  const put = (change: Partial<ActionsMenu>): Reduced => ({
    state: { ...state, actions: { ...menu, ...change } },
    effects: [],
  });
  const last = Math.max(0, items.length - 1);
  switch (command) {
    case 'back':
      return { state: leaveActions(state), effects: [] };
    case 'down':
      return put({
        selected: Math.min(last, menu.selected + 1),
        notice: null,
        scroll: 0,
      });
    case 'up':
      return put({
        selected: Math.max(0, menu.selected - 1),
        notice: null,
        scroll: 0,
      });
    case 'page_down':
    case 'page_up': {
      const { last: end, page } = actionsPaging(state, contentHeight(state));
      const step = command === 'page_up' ? -page : page;
      return put({
        scroll: Math.min(end, Math.max(0, Math.min(menu.scroll, end) + step)),
      });
    }
    case 'open': {
      const item = items[menu.selected];
      return item === undefined ? put({}) : put({ notice: uiText(enterNotice(item)) });
    }
    default:
      return null;
  }
}
