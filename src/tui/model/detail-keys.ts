/**
 * Keys and answers of Task detail and Logs, kept apart from the Home reducer. Going up and down needs how many
 * rows there are, and that is worked out by the views that draw them, so the two cannot disagree.
 */
import type { PortResult } from '../client/daemon-port.ts';
import type { TaskGateLog, TaskGates, TaskLogs } from '../client/schemas.ts';
import { contentHeight } from '../views/disconnected.ts';
import { detailRowCount } from '../views/task-detail.ts';
import { openActions } from './actions.ts';
import { initialDetail } from './detail.ts';
import {
  gateLogRows,
  gatesCommand,
  GATES_STOP,
  onGateLogRead,
  onGatesRead,
  openGates,
  type GateLogRead,
} from './gates.ts';
import type { HomeRow } from './home-rows.ts';
import {
  applyLogPage,
  failLogRead,
  filterAttempt,
  followLogs,
  initialLogs,
  LOG_HEADER_ROWS,
  logColumns,
  logRows,
  logsEnd,
  latestAttempt,
  logsTop,
  pauseLogs,
  scrollLogs,
  toggleOutput,
  togglePane,
  type LogRequest,
  type LogState,
} from './logs.ts';
import {
  attemptGroups,
  groupAttempts,
  cursorIndex,
  pickerStart,
  treeRows,
  type AttemptGroup,
} from './attempt-tree.ts';
import type { Command } from './keymap.ts';
import type { Effect } from './messages.ts';
import { progressStages, STAGES, stageOf } from './stages.ts';
import type { TuiState } from './state.ts';

type Reduced = {
  readonly state: TuiState;
  readonly effects: readonly Effect[];
};

const READ: readonly Effect[] = [{ type: 'read_screen' }];

/**
 * Enter opens the task's stages and log. Task detail is read along with it, because the log's stages and its
 * chooser of attempts come from there, but it is drawn only over the log, one `d` away.
 */
export function openDetail(state: TuiState, row: HomeRow | undefined): Reduced {
  if (row === undefined || row.kind === 'finished_toggle') return { state, effects: [] };
  const session = state.screenSession + 1;
  return {
    state: {
      ...state,
      screens: [...state.screens, 'logs'],
      // Parts start without errors, so a task that was stale must be read again before it unlocks.
      ...(state.staleTasks.has(row.task.task_id)
        ? { recheck: new Map(state.recheck).set(row.task.task_id, 0) }
        : {}),
      detail: {
        ...initialDetail(row.task.task_id, row.task.title, session),
        showWanted: state.staleTasks.has(row.task.task_id),
      },
      logs: initialLogs(row.task.task_id, row.task.title, session + 1),
      screenSession: session + 1,
    },
    effects: READ,
  };
}

const isTaskScreen = (screen: string): boolean => screen === 'logs' || screen === 'detail';

/** Leaves the task for the screen it was opened from, and drops everything held by it. */
const leaveTask = (state: TuiState): TuiState => {
  const first = state.screens.findIndex(isTaskScreen);
  return {
    ...state,
    screens: first < 0 ? state.screens : state.screens.slice(0, first),
    detail: null,
    logs: null,
    actions: null,
  };
};

/** Task detail over the log goes back to it as it was left; the log catches up at once. */
const backToLogs = (state: TuiState): Reduced => ({
  state: { ...state, screens: state.screens.slice(0, state.screens.lastIndexOf('detail')) },
  effects: READ,
});

const overLogs = (state: TuiState): boolean =>
  state.screens.slice(0, state.screens.lastIndexOf('detail')).includes('logs');

/** `null`: not a command of this screen. */
export function onDetailCommand(state: TuiState, command: Command): Reduced | null {
  const d = state.detail;
  if (d === null) return null;
  if (command === 'actions') return openActions(state, d.taskId, d.show.data?.title ?? d.title);
  if (command === 'logs') {
    if (overLogs(state)) return backToLogs(state);
    return {
      state: {
        ...state,
        screens: [...state.screens, 'logs'],
        logs: initialLogs(d.taskId, d.show.data?.title ?? d.title, state.screenSession + 1),
        screenSession: state.screenSession + 1,
      },
      effects: READ,
    };
  }
  const height = contentHeight(state);
  const last = Math.max(0, detailRowCount(state) - height);
  const to = (top: number): Reduced => ({
    state: {
      ...state,
      detail: { ...d, top: Math.min(Math.max(0, top), last) },
    },
    effects: [],
  });
  switch (command) {
    case 'back':
      return overLogs(state) ? backToLogs(state) : { state: leaveTask(state), effects: [] };
    case 'down':
      return to(d.top + 1);
    case 'up':
      return to(d.top - 1);
    case 'page_down':
      return to(d.top + Math.max(1, height - 1));
    case 'page_up':
      return to(d.top - Math.max(1, height - 1));
    case 'top':
      return to(0);
    case 'end':
      return to(last);
    case 'technical':
      return {
        state: { ...state, detail: { ...d, technical: !d.technical, top: 0 } },
        effects: [],
      };
    default:
      return null;
  }
}

/** The chooser's groups, from the attempts `task_show` lists. */
export const pickerGroups = (s: TuiState): readonly AttemptGroup[] =>
  attemptGroups(s.detail?.show.data?.provenance.usage ?? []);

function onPickerCommand(state: TuiState, logs: LogState, command: Command): Reduced | null {
  const rows = treeRows(pickerGroups(state), logs.pickerOpen);
  const at = cursorIndex(rows, logs.picker);
  const row = rows[at];
  const put = (next: Partial<LogState>, effects: readonly Effect[] = []): Reduced => ({
    state: { ...state, logs: { ...logs, ...next } },
    effects,
  });
  const moveTo = (i: number): Reduced =>
    put({ picker: rows[Math.min(Math.max(0, i), rows.length - 1)]?.key ?? null });
  const fold = (key: string, open: boolean): Reduced =>
    put({
      pickerOpen: open
        ? [...logs.pickerOpen.filter((k) => k !== key), key]
        : logs.pickerOpen.filter((k) => k !== key),
    });
  const page = Math.max(1, contentHeight(state) - LOG_HEADER_ROWS - 1);
  switch (command) {
    case 'back':
      // The chooser sits between the latest step and one attempt: going back from it goes to the latest step.
      return logs.attemptFilter === null
        ? put({ picker: null })
        : { state: { ...state, logs: followLogs(logs) }, effects: READ };
    case 'down':
      return moveTo(at + 1);
    case 'up':
      return moveTo(at - 1);
    case 'page_down':
      return moveTo(at + page);
    case 'page_up':
      return moveTo(at - page);
    case 'top':
      return moveTo(0);
    case 'end':
      return moveTo(rows.length - 1);
    case 'expand':
      if (row?.kind !== 'group' && row?.kind !== 'run') return put({});
      return row.open ? moveTo(at + 1) : fold(row.key, true);
    case 'collapse':
      if ((row?.kind === 'group' || row?.kind === 'run') && row.open) return fold(row.key, false);
      if (row?.kind === 'run' || row?.kind === 'attempt') return put({ picker: row.parent });
      return put({});
    case 'open':
      if (row === undefined || row.kind === 'live')
        return { state: { ...state, logs: followLogs(logs) }, effects: READ };
      if (row.kind === 'attempt')
        return { state: { ...state, logs: filterAttempt(logs, row.attempt.id) }, effects: READ };
      return fold(row.key, !row.open);
    default:
      return null;
  }
}

/** Opens the chooser on the attempt being read, or on its first row. */
/** The attempt beside the one being read. Forward to the last one is following: that is the latest step. */
function neighbourAttempt(state: TuiState, logs: LogState, direction: 1 | -1): Reduced {
  const stops = stepStops(state);
  const reading = logs.gates !== null ? GATES_STOP : (logs.attemptFilter ?? latestAttempt(logs));
  const at = stops.indexOf(reading ?? '');
  // The list can lag the log: the attempt being followed is then newer than all it names.
  const behind = at < 0 && logs.attemptFilter === null;
  const next = behind ? stops.at(-1) : at < 0 ? undefined : stops[at + direction];
  if (next === GATES_STOP)
    return {
      state: { ...state, logs: { ...logs, gates: openGates(logs.gates) } },
      effects: READ,
    };
  // The last of a list that lags is not the latest step: it has its own place before that one.
  const caughtUp = logs.latestSeen === null || stops.includes(logs.latestSeen);
  const follows = direction > 0 && (next === undefined || (caughtUp && next === stops.at(-1)));
  if (next === undefined && !follows) return { state, effects: [] };
  const moved = next === undefined || follows ? followLogs(logs) : filterAttempt(logs, next);
  return { state: { ...state, logs: { ...moved, gates: null } }, effects: READ };
}

/** What `←`/`→` stop at, in order: the attempts, with the gates where their stage comes. */
function stepStops(state: TuiState): readonly string[] {
  const attempts = pickerGroups(state).flatMap(groupAttempts);
  const ids = attempts.map((a) => a.id);
  const d = state.detail;
  const status = d?.explain.data?.status ?? d?.show.data?.status;
  const steps = d?.progress.data?.steps ?? null;
  const stages = steps === null || status === undefined ? null : progressStages(steps, status);
  const reached = stages?.find((s) => s.name === 'gates');
  if (reached === undefined || !['done', 'current', 'failed', 'stopped'].includes(reached.state))
    return ids;
  const after = STAGES.indexOf('gates');
  const later = attempts.findIndex((a) => {
    const stage = stageOf(a.step);
    return stage !== null && STAGES.indexOf(stage) > after;
  });
  const at = later < 0 ? ids.length : later;
  return [...ids.slice(0, at), GATES_STOP, ...ids.slice(at)];
}

function openPicker(state: TuiState, logs: LogState): Reduced {
  const start = pickerStart(pickerGroups(state), logs.attemptFilter);
  // The list of attempts may have grown since Task detail last read it.
  return {
    state: {
      ...state,
      logs: { ...logs, picker: start.cursor, pickerOpen: start.open },
      ...(state.detail === null ? {} : { detail: { ...state.detail, showWanted: true } }),
    },
    effects: READ,
  };
}

/** `null`: not a command of this screen. */
export function onLogsCommand(state: TuiState, command: Command): Reduced | null {
  const logs = state.logs;
  if (logs === null) return null;
  if (logs.picker !== null) return onPickerCommand(state, logs, command);
  const { log: cols, pane } = logColumns(state.size.cols, logs.paneHidden);
  const height = logRows(contentHeight(state));
  if (logs.gates !== null) {
    const rows = gateLogRows(logs.gates, height, pane > 0);
    const view = gatesCommand(logs.gates, command, cols, rows);
    if (view !== null)
      return { state: { ...state, logs: { ...logs, gates: view } }, effects: READ };
    if (command === 'back')
      return { state: { ...state, logs: { ...logs, gates: null } }, effects: READ };
    if (command === 'attempts') return openPicker(state, { ...logs, gates: null });
  }
  const put = (next: LogState): Reduced => ({
    state: { ...state, logs: next },
    effects: next.wantOlder || next.wantForward || next.mode !== logs.mode ? READ : [],
  });
  switch (command) {
    case 'pause':
      return put(logs.mode === 'live' ? pauseLogs(logs, cols, height) : followLogs(logs));
    case 'toggle_output':
      return put(toggleOutput(logs));
    case 'toggle_pane':
      return put(togglePane(logs));
    case 'previous_step':
    case 'next_step': {
      const direction = command === 'next_step' ? 1 : -1;
      // Already on the latest step, there is no step after it, only its end.
      const last = stepStops(state).at(-1);
      if (
        logs.attemptFilter === null &&
        direction > 0 &&
        logs.gates === null &&
        last !== GATES_STOP
      )
        return put(logsEnd(logs, cols, height));
      return neighbourAttempt(state, logs, direction);
    }
    case 'back':
      // Reading one attempt, back is the chooser it was picked from.
      return logs.attemptFilter === null
        ? { state: leaveTask(state), effects: [] }
        : openPicker(state, logs);
    case 'attempts':
      return openPicker(state, logs);
    case 'details': {
      // Over the log, not instead of it: Esc comes back to the place being read.
      const session = state.screenSession + 1;
      return {
        state: {
          ...state,
          screens: [...state.screens, 'detail'],
          ...(state.detail === null
            ? {
                detail: initialDetail(logs.taskId, logs.title, session),
                screenSession: session,
              }
            : {}),
        },
        effects: READ,
      };
    }
    case 'up':
      return put(scrollLogs(logs, cols, height, -1));
    case 'down':
      return put(scrollLogs(logs, cols, height, 1));
    case 'page_up':
      return put(scrollLogs(logs, cols, height, -Math.max(1, height - 1)));
    case 'page_down':
      return put(scrollLogs(logs, cols, height, Math.max(1, height - 1)));
    case 'top':
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

export type GatesMessage = {
  readonly taskId: string;
  readonly session: number;
  readonly generation: number;
  readonly at: number;
} & (
  | { readonly type: 'gates_read'; readonly result: PortResult<TaskGates> }
  | {
      readonly type: 'gate_log_read';
      readonly request: GateLogRead;
      readonly result: PortResult<TaskGateLog>;
    }
);

/** An answer about the gates; one to a question since replaced is dropped. */
export function onGatesMessage(state: TuiState, m: GatesMessage): TuiState {
  const logs = state.logs;
  const view = logs?.gates ?? null;
  if (
    logs === null ||
    view === null ||
    logs.taskId !== m.taskId ||
    logs.session !== m.session ||
    view.generation !== m.generation
  )
    return state;
  return {
    ...state,
    logs: {
      ...logs,
      gates:
        m.type === 'gates_read'
          ? onGatesRead(view, m.result, m.at)
          : onGateLogRead(
              view,
              m.request,
              m.result,
              m.at,
              logColumns(state.size.cols, logs.paneHidden).log,
            ),
    },
  };
}

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
