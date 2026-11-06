/**
 * The Actions menu of one task (FR-016, EC-013). What it lists is `allowed_actions` of a `task_explain` read
 * when the menu opens, never the one Task detail holds, and read again whenever anything moved, so a menu
 * that is no longer valid is replaced instead of acted on. Nothing here is sent: dialogs come with US4 and US5.
 */
import type { PortResult } from '../client/daemon-port.ts';
import type { TaskExplain, TaskShow } from '../client/schemas.ts';
import { uiText, type SafeText } from '../terminal/safe-text.ts';
import type { MutationCommand } from '../client/mutations.ts';
import { actionItems, actionsPaging, enterNotice } from '../views/actions.ts';
import { contentHeight } from '../views/disconnected.ts';
import { EXPLAIN_READ_MS, noPart, type Part } from './detail.ts';
import type { Command } from './keymap.ts';
import type { Effect } from './messages.ts';
import { mutationLock, writeLock, type TuiState } from './state.ts';

export type ActionsMenu = {
  readonly taskId: string;
  readonly title: SafeText;
  /** See `TuiState.screenSession`. */
  readonly session: number;
  readonly explain: Part<TaskExplain>;
  /** `task_show`: the project and version a write is sent with, and what unlocks a stale task. */
  readonly show: Part<TaskShow>;
  /** Read again regardless of the watermark: the connection came back or the task was stale (FR-044). */
  readonly showWanted: boolean;
  readonly showWatermark: number | null;
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
  const stale = state.staleTasks.has(taskId);
  return {
    state: {
      ...state,
      // Reopening a stale task: it unlocks only after a `task_show` asked from now on answers.
      ...(stale ? { recheck: new Map(state.recheck).set(taskId, 0) } : {}),
      screens: [...state.screens, 'actions'],
      actions: {
        taskId,
        title,
        session,
        explain: noPart(),
        show: noPart(),
        showWanted: stale,
        showWatermark: null,
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

export function actionsShowDue(m: ActionsMenu, watermark: number | null, now: number): boolean {
  const asked = m.show.attemptAt;
  if (asked === null) return true;
  // A failed read waits before the next one, whether or not a fresh answer is still wanted.
  if (m.show.error !== null) return now - asked >= EXPLAIN_READ_MS;
  if (m.showWanted) return true;
  return watermark !== null && watermark !== m.showWatermark;
}

export type ActionsShowMessage = {
  readonly type: 'actions_show_read';
  readonly taskId: string;
  readonly session: number;
  readonly askedAt: number;
  readonly at: number;
  readonly watermark: number | null;
  readonly result: PortResult<TaskShow>;
};

export function onActionsShowRead(state: TuiState, m: ActionsShowMessage): TuiState {
  const menu = state.actions;
  if (menu === null || menu.taskId !== m.taskId || menu.session !== m.session) return state;
  // An answer asked before the connection came back says nothing about the task now.
  const since = state.recheck.get(m.taskId);
  const fresh = since === undefined || m.askedAt >= since;
  const recheck = new Map(state.recheck);
  const staleTasks = new Set(state.staleTasks);
  if (!m.result.ok) {
    staleTasks.add(m.taskId);
    return {
      ...state,
      staleTasks,
      actions: {
        ...menu,
        show: { ...menu.show, error: m.result.error.message, attemptAt: m.askedAt },
        showWatermark: m.watermark,
      },
    };
  }
  if (fresh) {
    recheck.delete(m.taskId);
    // Detail under this menu does not read while hidden, so this answer is the one that frees the task.
    staleTasks.delete(m.taskId);
  }
  return {
    ...state,
    recheck,
    staleTasks,
    actions: {
      ...menu,
      show: { data: m.result.value, error: null, attemptAt: m.askedAt, readAt: m.at },
      showWanted: !fresh,
      showWatermark: m.watermark,
    },
  };
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

/** Why a new write on this task stays unsent now; `null` when it may go. Nothing is sent on stale data. */
export function writeBlock(state: TuiState, menu: ActionsMenu): string | null {
  const open = mutationLock(state, menu.taskId);
  if (open !== null) {
    const id = open.requestId;
    return open.state === 'sending'
      ? `Nothing was sent: an earlier change to this task is still being sent (request ${id}).`
      : open.state === 'unknown'
        ? `Nothing was sent: the result of an earlier change to this task is not known yet; it is being checked (request ${id}).`
        : `Nothing was sent: the result of an earlier change to this task could not be confirmed (request ${id}). Press C to check again.`;
  }
  const lock = writeLock(state, menu.taskId);
  if (lock === 'stale')
    return 'Nothing was sent: the data on screen may be out of date. Try again once it has been read again.';
  if (lock === 'task_stale')
    return 'Nothing was sent: this task is being read again after the connection came back.';
  if (menu.show.data === null) return 'Nothing was sent: this task is still being read.';
  return null;
}

function sendRecheck(state: TuiState, menu: ActionsMenu): Reduced {
  const blocked = writeBlock(state, menu);
  const show = menu.show.data;
  if (blocked !== null || show === null)
    return {
      state: { ...state, actions: { ...menu, notice: uiText(blocked ?? '') } },
      effects: [],
    };
  const command: MutationCommand = {
    kind: 'task_recheck',
    project: show.project,
    task_id: menu.taskId,
    expected_version: show.version,
    payload: {},
  };
  return {
    state: { ...state, actions: { ...menu, notice: null } },
    effects: [{ type: 'submit', command }],
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
      if (item === undefined) return put({});
      if (item.action === 'recheck' && item.unavailable === null) return sendRecheck(state, menu);
      return put({ notice: uiText(enterNotice(item)) });
    }
    case 'check_again': {
      const m = mutationLock(state, menu.taskId);
      return m === null || m.state !== 'unresolved'
        ? put({})
        : {
            state: { ...state, actions: { ...menu, notice: null } },
            effects: [{ type: 'check_again', requestId: m.requestId }],
          };
    }
    default:
      return null;
  }
}
