/**
 * `(state, message) → (state, effects)`, pure, so random keys and connection failures can be tested without
 * a terminal. Nothing here decides what a task may do: that stays with the daemon.
 */
import type { Key, KeyName } from '../terminal/keys.ts';
import {
  forgetScreens,
  onDetailKey,
  onLogsKey,
  onLogsRead,
  openDetail,
} from './detail-keys.ts';
import { onDetailRead } from './detail.ts';
import {
  homeRows,
  keepSelection,
  selectRow,
  selectedRowIndex,
} from './home-rows.ts';
import type { Effect, Message } from './messages.ts';
import {
  boardQueryKey,
  currentScreen,
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
    case 'credential_changed':
      return {
        state: {
          ...state,
          // What is on screen was read with the old token: not current until the new one has read it.
          stale: true,
          caller: null,
          projects: null,
          ...forgetScreens(state),
          // Positions in the old list: the new token's list may not have them.
          cursors: [],
          ...(state.cursors.length > 0
            ? { board: null, selectedTaskId: null, selectedIndex: 0 }
            : {}),
          filterDraft:
            state.filterDraft === null
              ? null
              : { ...state.filterDraft, project: 0 },
        },
        effects: [],
      };
    case 'read_succeeded': {
      // Metadata shares the round's failure handling and credential check with board and health.
      const online: TuiState = {
        ...state,
        connection: nextConnection(state.connection, { ok: true }),
        stale: false,
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
      if (
        message.queryKey !== undefined &&
        message.queryKey !== boardQueryKey(state)
      )
        return same(online);
      return {
        state: keepSelection({
          ...online,
          lastUpdatedAt: message.at,
          // An unchanged board keeps what was already read: that is still the truth.
          board: message.board.unchanged ? state.board : message.board,
        }),
        effects: [],
      };
    }
    case 'read_failed':
      return same({
        ...state,
        connection: nextConnection(state.connection, message.failure),
        stale: true,
        lastError: message.failure.message ?? state.lastError,
      });
    case 'detail_read':
      return same(onDetailRead(state, message));
    case 'logs_read':
      return same(onLogsRead(state, message));
    case 'key':
      return onKey(state, message.key);
  }
}

const typingInFilter = (s: TuiState): boolean =>
  currentScreen(s) === 'filters' && s.filterDraft?.field === 'project';

function onKey(given: TuiState, key: Key): Reduced {
  const quitKey =
    (key.kind === 'key' && key.name === 'ctrl_c') ||
    (key.kind === 'char' && key.text === 'q' && !typingInFilter(given));
  // Any other key puts the question about quitting away.
  const state =
    given.quitArmed && !quitKey ? { ...given, quitArmed: false } : given;
  switch (currentScreen(state)) {
    case 'filters':
      return onFilterKey(state, key);
    case 'home':
      return onHomeKey(state, key);
    case 'help':
      return common(state, key);
    case 'detail':
      return onDetailKey(state, key) ?? common(state, key);
    case 'logs':
      return onLogsKey(state, key) ?? common(state, key);
  }
}

function askToQuit(state: TuiState): Reduced {
  // What was typed is worth one more key press (contracts/tui.md).
  if ((state.filterDraft?.query ?? '') !== '' && !state.quitArmed)
    return same({ ...state, quitArmed: true });
  return { state, effects: [{ type: 'quit', code: 0 }] };
}

/** Keys that mean the same on every screen. */
function common(state: TuiState, key: Key): Reduced {
  if (key.kind === 'paste') return same(state);
  if (key.kind === 'key') {
    if (key.name === 'ctrl_c') return askToQuit(state);
    if (key.name === 'esc' && state.screens.length > 1)
      return same({ ...state, screens: state.screens.slice(0, -1) });
    return same(state);
  }
  switch (key.text) {
    case 'q':
      return askToQuit(state);
    case '?':
      return currentScreen(state) === 'help'
        ? same(state)
        : same({ ...state, screens: [...state.screens, 'help'] });
    case 'R': {
      const connection = retryConnection(state.connection);
      return connection === null
        ? same(state)
        : {
            state: { ...state, connection },
            effects: [{ type: 'retry_connection' }],
          };
    }
    default:
      return same(state);
  }
}

const KEY_ALIASES: Readonly<Record<string, KeyName>> = {
  j: 'down',
  k: 'up',
  g: 'home',
  G: 'end',
};

function onHomeKey(state: TuiState, key: Key): Reduced {
  if (key.kind === 'char' && key.text === 'f') return openFilters(state);
  const name =
    key.kind === 'key'
      ? key.name
      : key.kind === 'char'
        ? KEY_ALIASES[key.text]
        : undefined;
  if (name === undefined) return common(state, key);
  const rows = homeRows(state);
  const at = selectedRowIndex(state, rows);
  const last = rows.length - 1;
  switch (name) {
    case 'down':
      return same(selectRow(state, at + 1, rows));
    case 'up':
      return same(selectRow(state, at - 1, rows));
    case 'home':
      return same(selectRow(state, 0, rows));
    case 'end':
      return same(selectRow(state, last, rows));
    case 'pagedown': {
      const next = state.board?.next_cursor ?? null;
      if (at >= last && next !== null)
        return changeView(state, { cursors: [...state.cursors, next] });
      return same(selectRow(state, at + pageStep(state), rows));
    }
    case 'pageup':
      if (at <= 0 && state.cursors.length > 0)
        return changeView(state, { cursors: state.cursors.slice(0, -1) });
      return same(selectRow(state, at - pageStep(state), rows));
    case 'enter':
      // Keeps the selection on the row just pressed, which stays where it is.
      if (rows[at]?.kind === 'finished_toggle')
        return changeView(
          state,
          { finishedOpen: !state.finishedOpen, cursors: [] },
          { keepSelection: true },
        );
      return openDetail(state, rows[at]);
    default:
      return common(state, key);
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
    effects:
      state.connection.kind === 'online' ? [{ type: 'refresh_now' }] : [],
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

function onFilterKey(state: TuiState, key: Key): Reduced {
  const draft = state.filterDraft;
  if (draft === null) return common(state, key);
  const put = (change: Partial<FilterDraft>): Reduced =>
    same({ ...state, filterDraft: { ...draft, ...change } });
  const typing = draft.field === 'project';

  if (key.kind === 'paste')
    return typing
      ? // One line: a pasted line break must not reach the name being looked for.
        put({
          query: draft.query + key.text.replace(/[\r\n\t]+/g, ' '),
          project: 0,
        })
      : same(state);

  if (key.kind === 'char') {
    if (typing) return put({ query: draft.query + key.text, project: 0 });
    const alias = KEY_ALIASES[key.text];
    if (alias === 'down' || alias === 'up')
      return moveChoice(state, draft, alias);
    // Help would open over a form it does not describe yet; T051 brings help by context.
    return key.text === '?' ? same(state) : common(state, key);
  }

  switch (key.name) {
    case 'esc':
      return same(closeFilters(state));
    case 'tab':
    case 'shift_tab':
      return put({ field: typing ? 'status' : 'project' });
    case 'backspace':
      return typing
        ? put({ query: [...draft.query].slice(0, -1).join(''), project: 0 })
        : same(state);
    case 'up':
    case 'down':
      return moveChoice(state, draft, key.name);
    case 'enter':
      return applyFilters(state, draft);
    default:
      return common(state, key);
  }
}

function moveChoice(
  state: TuiState,
  draft: FilterDraft,
  direction: 'up' | 'down',
): Reduced {
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
  if (project === state.filters.project && status === state.filters.status)
    return same(closed);
  return changeView(closed, {
    filters: { project, status },
    finishedOpen: false,
    cursors: [],
  });
}
