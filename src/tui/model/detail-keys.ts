/**
 * Keys and answers of Task detail and Logs, kept apart from the Home reducer. Going up and down needs how many
 * rows there are, and that is worked out by the views that draw them, so the two cannot disagree.
 */
import type { PortResult } from '../client/daemon-port.ts';
import type { TaskLogs } from '../client/schemas.ts';
import type { Key, KeyName } from '../terminal/keys.ts';
import { stepWords } from './activity.ts';
import { joinSafe, uiText, type SafeText } from '../terminal/safe-text.ts';
import { contentHeight } from '../views/disconnected.ts';
import { detailRowCount } from '../views/task-detail.ts';
import { forgetDetail, initialDetail } from './detail.ts';
import type { HomeRow } from './home-rows.ts';
import {
  applyLogPage,
  failLogRead,
  filterAttempt,
  followLogs,
  forgetLogs,
  initialLogs,
  LOG_HEADER_ROWS,
  logColumns,
  logsEnd,
  logsTop,
  pauseLogs,
  scrollLogs,
  shortAttempt,
  type LogRequest,
  type LogState,
} from './logs.ts';
import type { Effect } from './messages.ts';
import type { TuiState } from './state.ts';

type Reduced = {
  readonly state: TuiState;
  readonly effects: readonly Effect[];
};

const READ: readonly Effect[] = [{ type: 'read_screen' }];

const ALIASES: Readonly<Record<string, KeyName>> = {
  j: 'down',
  k: 'up',
  g: 'home',
  G: 'end',
};

function moveName(key: Key): KeyName | undefined {
  if (key.kind === 'key') return key.name;
  return key.kind === 'char' ? ALIASES[key.text] : undefined;
}

/**
 * Enter on Home opens the task where it is most often wanted: its stages beside its log. Task detail lies
 * under the log, one `d` away; it holds what both screens read about the task. A row with no task is not
 * this function's business.
 */
export function openDetail(state: TuiState, row: HomeRow | undefined): Reduced {
  if (row === undefined || row.kind === 'finished_toggle')
    return { state, effects: [] };
  const session = state.screenSession + 1;
  return {
    state: {
      ...state,
      screens: [...state.screens, 'detail', 'logs'],
      detail: initialDetail(row.task.task_id, row.task.title, session),
      logs: initialLogs(row.task.task_id, row.task.title, session + 1),
      screenSession: session + 1,
    },
    effects: READ,
  };
}

/** Esc on either screen of a task goes back to the list, never from one of its screens to the other. */
const leaveTask = (state: TuiState): TuiState => ({
  ...state,
  screens: state.screens.slice(0, state.screens.lastIndexOf('detail')),
  detail: null,
  logs: null,
});

const leave = (state: TuiState, screen: 'detail' | 'logs'): TuiState => ({
  ...state,
  screens: state.screens.slice(0, state.screens.lastIndexOf(screen)),
  ...(screen === 'detail' ? { detail: null } : { logs: null }),
});

/** A change of token: what the open screens hold and are waiting for belongs to the old one. */
export function forgetScreens(
  state: TuiState,
): Pick<TuiState, 'detail' | 'logs' | 'screenSession'> {
  const session = state.screenSession + 1;
  return {
    detail: state.detail === null ? null : forgetDetail(state.detail, session),
    logs: state.logs === null ? null : forgetLogs(state.logs, session),
    screenSession: session,
  };
}

/** `null`: not a key of this screen. */
export function onDetailKey(state: TuiState, key: Key): Reduced | null {
  const d = state.detail;
  if (d === null) return null;
  if (key.kind === 'char' && key.text === 'l')
    return {
      state: {
        ...state,
        screens: [...state.screens, 'logs'],
        logs: initialLogs(
          d.taskId,
          d.show.data?.title ?? d.title,
          state.screenSession + 1,
        ),
        screenSession: state.screenSession + 1,
      },
      effects: READ,
    };
  const height = contentHeight(state);
  const last = Math.max(0, detailRowCount(state) - height);
  const to = (top: number): Reduced => ({
    state: {
      ...state,
      detail: { ...d, top: Math.min(Math.max(0, top), last) },
    },
    effects: [],
  });
  switch (moveName(key)) {
    case 'esc':
      return { state: leaveTask(state), effects: [] };
    case 'down':
      return to(d.top + 1);
    case 'up':
      return to(d.top - 1);
    case 'pagedown':
      return to(d.top + Math.max(1, height - 1));
    case 'pageup':
      return to(d.top - Math.max(1, height - 1));
    case 'home':
      return to(0);
    case 'end':
      return to(last);
    default:
      return null;
  }
}

export type AttemptChoice = {
  readonly label: SafeText;
  /** `null`: the whole log, followed live. */
  readonly attemptId: string | null;
};

/** The attempts of the task, as `task_show` lists them. */
export function attemptChoices(s: TuiState): readonly AttemptChoice[] {
  const attempts = s.detail?.show.data?.provenance.usage ?? [];
  return [
    { label: uiText('Every step, live'), attemptId: null },
    ...attempts.map((a) => {
      const words = stepWords(a.step);
      return {
        attemptId: a.attempt_id,
        label: joinSafe([
          a.step,
          uiText(words === null ? '' : ` — ${words}`),
          uiText(' · '),
          a.binding,
          uiText(` · attempt ${shortAttempt(a.attempt_id)}`),
        ]),
      };
    }),
  ];
}

function onPickerKey(
  state: TuiState,
  logs: LogState,
  key: Key,
): Reduced | null {
  const picker = logs.picker as number;
  const choices = attemptChoices(state);
  const put = (next: LogState, effects: readonly Effect[] = []): Reduced => ({
    state: { ...state, logs: next },
    effects,
  });
  switch (moveName(key)) {
    case 'esc':
      return put({ ...logs, picker: null });
    case 'down':
      return put({
        ...logs,
        picker: Math.min(picker + 1, choices.length - 1),
      });
    case 'up':
      return put({ ...logs, picker: Math.max(0, picker - 1) });
    case 'enter': {
      const chosen = choices[picker]?.attemptId ?? null;
      return put(
        chosen === null ? followLogs(logs) : filterAttempt(logs, chosen),
        READ,
      );
    }
    default:
      // What holds on every screen still holds here; nothing else reaches past the chooser.
      return (key.kind === 'char' && 'q?R'.includes(key.text)) ||
        (key.kind === 'key' && key.name === 'ctrl_c')
        ? null
        : put(logs);
  }
}

/** `null`: not a key of this screen. */
export function onLogsKey(state: TuiState, key: Key): Reduced | null {
  const logs = state.logs;
  if (logs === null) return null;
  if (logs.picker !== null) return onPickerKey(state, logs, key);
  // The same width the screen draws the log at, so a row scrolled to is a row shown.
  const cols = logColumns(state.size.cols).log;
  const height = Math.max(1, contentHeight(state) - LOG_HEADER_ROWS);
  const put = (next: LogState): Reduced => ({
    state: { ...state, logs: next },
    effects:
      next.wantOlder || next.wantForward || next.mode !== logs.mode ? READ : [],
  });
  if (key.kind === 'char') {
    switch (key.text) {
      case ' ':
        return put(
          logs.mode === 'live'
            ? pauseLogs(logs, cols, height)
            : followLogs(logs),
        );
      case 'F':
        return put(followLogs(logs));
      case 'd':
        return { state: leave(state, 'logs'), effects: READ };
      case 't':
        // The list of attempts may have grown since Task detail last read it.
        return {
          state: {
            ...state,
            logs: { ...logs, picker: 0 },
            ...(state.detail === null
              ? {}
              : { detail: { ...state.detail, showWanted: true } }),
          },
          effects: READ,
        };
    }
  }
  switch (moveName(key)) {
    case 'esc':
      return { state: leaveTask(state), effects: [] };
    case 'up':
      return put(scrollLogs(logs, cols, height, -1));
    case 'down':
      return put(scrollLogs(logs, cols, height, 1));
    case 'pageup':
      return put(scrollLogs(logs, cols, height, -Math.max(1, height - 1)));
    case 'pagedown':
      return put(scrollLogs(logs, cols, height, Math.max(1, height - 1)));
    case 'home':
      return put(logsTop(logs));
    case 'end':
      return put(logsEnd(logs, cols, height));
    default:
      return null;
  }
}

export type LogsMessage = {
  readonly type: 'logs_read';
  readonly taskId: string;
  readonly session: number;
  readonly generation: number;
  readonly request: LogRequest;
  readonly at: number;
  readonly result: PortResult<TaskLogs>;
};

/** One answer; one to a question since replaced is dropped. */
export function onLogsRead(state: TuiState, m: LogsMessage): TuiState {
  const logs = state.logs;
  if (
    logs === null ||
    logs.taskId !== m.taskId ||
    logs.session !== m.session ||
    logs.generation !== m.generation
  )
    return state;
  return {
    ...state,
    logs: m.result.ok
      ? applyLogPage(logs, m.request, m.result.value, m.at)
      : failLogRead(logs, m.result.error.message, m.at),
  };
}
