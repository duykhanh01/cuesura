/**
 * `(state, message) → (state, effects)`, pure, so random keys and connection failures can be tested without
 * a terminal. Nothing here decides what a task may do: that stays with the daemon.
 */
import { mutationTarget, QUEUE_TARGET } from '../client/mutations.ts';
import type { Key } from '../terminal/keys.ts';
import { contentHeight } from '../views/disconnected.ts';
import { helpLastTop } from '../views/help.ts';
import { oneLine } from '../views/input.ts';
import { onActionsCommand, onActionsRead, onActionsShowRead, openActions } from './actions.ts';
import {
  onDetailCommand,
  onLogsCommand,
  onGatesMessage,
  onLogsRead,
  openDetail,
} from './detail-keys.ts';
import { onDetailRead } from './detail.ts';
import {
  dialogHasText,
  onDialogCommand,
  onDialogKey,
  onDialogMutation,
  onDialogRead,
  openQueueDialog,
} from './dialog.ts';
import { homeRows, keepSelection, selectRow, selectedRowIndex } from './home-rows.ts';
import { commandFor, keyContext, type Command } from './keymap.ts';
import type { Effect, Message } from './messages.ts';
import {
  boardQueryKey,
  currentScreen,
  mutationLock,
  nextConnection,
  projectChoices,
  retryConnection,
  STATUS_CHOICES,
  type FilterDraft,
  type TuiState,
} from './state.ts';

export type Reduced = {
  readonly state: TuiState;
  readonly effects: readonly Effect[];
};

const same = (state: TuiState): Reduced => ({ state, effects: [] });

/** Rows `PgUp` and `PgDn` move: about one screen; exactness is not worth tying the reducer to the layout. */
const pageStep = (s: TuiState): number => Math.max(1, (s.size.rows - 8) >> 1);

export function reduce(state: TuiState, message: Message): Reduced {
  switch (message.type) {
    case 'resize':
      return same({ ...state, size: message.size });
    case 'tick':
      return same({ ...state, tick: state.tick + 1 });
    case 'read_succeeded': {
      // Coming back from stale data: every task a screen is open on is read again before its writes unlock,
      // whichever screen that is, and a draft stays in the input for the user to send again.
      const open = [state.detail?.taskId, state.logs?.taskId, state.actions?.taskId].filter(
        (id): id is string => id !== undefined,
      );
      const recovering = state.stale && open.length > 0;
      const online: TuiState = {
        ...state,
        ...(recovering
          ? {
              recheck: open.reduce((m, id) => m.set(id, message.at), new Map(state.recheck)),
              ...(state.detail === null ? {} : { detail: { ...state.detail, showWanted: true } }),
              ...(state.actions === null
                ? {}
                : { actions: { ...state.actions, showWanted: true, watermark: null } }),
            }
          : {}),
        connection: nextConnection(state.connection, { ok: true }),
        stale: false,
        queuePaused: message.board.queue_paused ?? null,
        lastError: null,
        health: message.health,
        ...(message.projects === undefined
          ? {}
          : {
              caller: message.projects.caller,
              projects: message.projects.projects,
            }),
      };
      // Asked before the view changed: the connection is fine, the board is not this view's.
      if (message.queryKey !== undefined && message.queryKey !== boardQueryKey(state))
        return { state: online, effects: recovering ? [{ type: 'read_screen' }] : [] };
      return {
        state: keepSelection({
          ...online,
          lastUpdatedAt: message.at,
          // An unchanged board keeps what was already read: that is still the truth.
          board: message.board.unchanged ? state.board : message.board,
        }),
        effects: recovering ? [{ type: 'read_screen' }] : [],
      };
    }
    case 'read_failed':
      return same({
        ...state,
        connection: nextConnection(state.connection, message.failure),
        stale: true,
        lastError: message.failure.message ?? state.lastError,
      });
    case 'draft_changed': {
      const drafts = new Map(state.drafts);
      if (message.text === null || message.text === '') drafts.delete(message.taskId);
      else drafts.set(message.taskId, message.text);
      return same({ ...state, drafts });
    }
    case 'detail_read':
      return same(onDetailRead(state, message));
    case 'logs_read':
      return same(onLogsRead(state, message));
    case 'gates_read':
    case 'gate_log_read':
      return same(onGatesMessage(state, message));
    case 'actions_read':
      return same(onActionsRead(state, message));
    case 'actions_show_read':
      return same(onActionsShowRead(state, message));
    case 'dialog_read':
      return same(onDialogRead(state, message));
    case 'mutation_changed': {
      const m = message.mutation;
      const mutations = new Map(state.mutations).set(mutationTarget(m.command), m);
      const dialog = onDialogMutation({ ...state, mutations }, m);
      // A write that went through moved the task: read the board now instead of at the next tick.
      return {
        state: dialog.state,
        effects: [
          ...dialog.effects,
          ...(m.state === 'accepted' && state.connection.kind === 'online'
            ? [{ type: 'refresh_now' as const }]
            : []),
        ],
      };
    }
    case 'key':
      return onKey(state, message.key);
  }
}

function onKey(given: TuiState, key: Key): Reduced {
  const command = commandFor(given, key);
  // Any other key puts the question about quitting away.
  const state = given.quitArmed && command !== 'quit' ? { ...given, quitArmed: false } : given;
  if (command === null) return onText(state, key);
  switch (command) {
    case 'quit':
      return askToQuit(state);
    case 'help':
      return same({
        ...state,
        screens: [...state.screens, 'help'],
        helpTop: 0,
      });
    case 'retry': {
      const connection = retryConnection(state.connection);
      return connection === null
        ? same(state)
        : {
            state: { ...state, connection },
            effects: [{ type: 'retry_connection' }],
          };
    }
    default:
      break;
  }
  switch (currentScreen(state)) {
    case 'filters':
      return onFilterCommand(state, command);
    case 'home':
      return onHomeCommand(state, command);
    case 'help':
      return onHelpCommand(state, command);
    case 'detail':
      return onDetailCommand(state, command) ?? same(state);
    case 'logs':
      return onLogsCommand(state, command) ?? same(state);
    case 'actions':
      return onActionsCommand(state, command) ?? same(state);
    case 'dialog':
      return onDialogCommand(state, command) ?? same(state);
  }
}

function askToQuit(state: TuiState): Reduced {
  // What was typed is worth one more key press (contracts/tui.md).
  const typed = (state.filterDraft?.query ?? '') !== '' || dialogHasText(state);
  if (typed && !state.quitArmed) return same({ ...state, quitArmed: true });
  return { state, effects: [{ type: 'quit', code: 0 }] };
}

/** A key that is no command: text, where a field takes it, and nothing elsewhere. */
function onText(state: TuiState, key: Key): Reduced {
  if (currentScreen(state) === 'dialog') return onDialogKey(state, key);
  const draft = state.filterDraft;
  if (keyContext(state) !== 'filter_text' || draft === null) return same(state);
  const put = (query: string): Reduced =>
    same({ ...state, filterDraft: { ...draft, query, project: 0 } });
  if (key.kind === 'char') return put(draft.query + key.text);
  if (key.kind === 'paste') return put(draft.query + oneLine(key.text));
  return same(state);
}

function onHelpCommand(state: TuiState, command: Command): Reduced {
  const height = contentHeight(state);
  const last = helpLastTop(state, height);
  const to = (top: number): Reduced =>
    same({ ...state, helpTop: Math.min(Math.max(0, top), last) });
  switch (command) {
    case 'back':
      return same({ ...state, screens: state.screens.slice(0, -1) });
    case 'down':
      return to(state.helpTop + 1);
    case 'up':
      return to(state.helpTop - 1);
    case 'page_down':
      return to(state.helpTop + Math.max(1, height - 1));
    case 'page_up':
      return to(state.helpTop - Math.max(1, height - 1));
    case 'top':
      return to(0);
    case 'end':
      return to(last);
    default:
      return same(state);
  }
}

function onHomeCommand(state: TuiState, command: Command): Reduced {
  if (command === 'filters') return openFilters(state);
  const rows = homeRows(state);
  const at = selectedRowIndex(state, rows);
  const last = rows.length - 1;
  switch (command) {
    case 'down':
      return same(selectRow(state, at + 1, rows));
    case 'up':
      return same(selectRow(state, at - 1, rows));
    case 'top':
      return same(selectRow(state, 0, rows));
    case 'end':
      return same(selectRow(state, last, rows));
    case 'page_down': {
      const next = state.board?.next_cursor ?? null;
      if (at >= last && next !== null)
        return changeView(state, { cursors: [...state.cursors, next] });
      return same(selectRow(state, at + pageStep(state), rows));
    }
    case 'page_up':
      if (at <= 0 && state.cursors.length > 0)
        return changeView(state, { cursors: state.cursors.slice(0, -1) });
      return same(selectRow(state, at - pageStep(state), rows));
    case 'open':
      // Keeps the selection on the row just pressed, which stays where it is.
      if (rows[at]?.kind === 'finished_toggle')
        return changeView(
          state,
          { finishedOpen: !state.finishedOpen, cursors: [] },
          { keepSelection: true },
        );
      return openDetail(state, rows[at]);
    case 'queue':
      return openQueueDialog(state);
    case 'check_again': {
      const m = mutationLock(state, QUEUE_TARGET);
      return m === null || m.state !== 'unresolved'
        ? same(state)
        : { state, effects: [{ type: 'check_again', requestId: m.requestId }] };
    }
    case 'actions': {
      const row = rows[at];
      return row === undefined || row.kind === 'finished_toggle'
        ? same(state)
        : openActions(state, row.task.task_id, row.task.title);
    }
    default:
      return same(state);
  }
}

/**
 * Another question for the board. What was read answers the old one, and a watermark would earn `unchanged`
 * for data never read (R-02, FR-008), so both go. A new read starts only while online: a lost connection has
 * its own round, and after that only the user starts one.
 */
function changeView(
  state: TuiState,
  change: Partial<TuiState>,
  o: { readonly keepSelection?: boolean } = {},
): Reduced {
  const next: TuiState = {
    ...state,
    ...change,
    board: null,
    ...(o.keepSelection === true
      ? {}
      : { selectedTaskId: null, finishedSelected: false, selectedIndex: 0 }),
  };
  return {
    state: next,
    effects: state.connection.kind === 'online' ? [{ type: 'refresh_now' }] : [],
  };
}

function openFilters(state: TuiState): Reduced {
  const choices = projectChoices(state.projects, '');
  return same({
    ...state,
    screens: [...state.screens, 'filters'],
    filterDraft: {
      field: 'project',
      query: '',
      project: Math.max(0, choices.indexOf(state.filters.project)),
      status: Math.max(0, STATUS_CHOICES.indexOf(state.filters.status)),
    },
  });
}

function closeFilters(state: TuiState): TuiState {
  return {
    ...state,
    filterDraft: null,
    screens: state.screens.filter((s) => s !== 'filters'),
  };
}

function onFilterCommand(state: TuiState, command: Command): Reduced {
  const draft = state.filterDraft;
  if (draft === null) return same(state);
  switch (command) {
    case 'back':
      return same(closeFilters(state));
    case 'switch_field':
      return same({
        ...state,
        filterDraft: {
          ...draft,
          field: draft.field === 'project' ? 'status' : 'project',
        },
      });
    case 'up':
    case 'down':
      return moveChoice(state, draft, command);
    case 'apply':
      return applyFilters(state, draft);
    case 'erase':
      return draft.field === 'project'
        ? same({
            ...state,
            filterDraft: {
              ...draft,
              query: [...draft.query].slice(0, -1).join(''),
              project: 0,
            },
          })
        : same(state);
    default:
      return same(state);
  }
}

function moveChoice(state: TuiState, draft: FilterDraft, direction: 'up' | 'down'): Reduced {
  const step = direction === 'down' ? 1 : -1;
  const count =
    draft.field === 'project'
      ? projectChoices(state.projects, draft.query).length
      : STATUS_CHOICES.length;
  const at = draft.field === 'project' ? draft.project : draft.status;
  const next = Math.min(Math.max(0, at + step), Math.max(0, count - 1));
  return same({
    ...state,
    filterDraft: { ...draft, [draft.field]: next },
  });
}

function applyFilters(state: TuiState, draft: FilterDraft): Reduced {
  const choices = projectChoices(state.projects, draft.query);
  // Typed text that matches nothing names no project: it stays on screen to be corrected.
  if (choices.length === 0) return same(state);
  const project = choices[draft.project] ?? null;
  const status = STATUS_CHOICES[draft.status] ?? null;
  const closed = closeFilters(state);
  if (project === state.filters.project && status === state.filters.status) return same(closed);
  return changeView(closed, {
    filters: { project, status },
    finishedOpen: false,
    cursors: [],
  });
}
