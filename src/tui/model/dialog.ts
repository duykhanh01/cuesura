/**
 * Dialogs that pause or resume a task or the queue (issue #155). Nothing goes out before Ctrl-S, and a task
 * write carries the version of the `task_show` the Actions menu under it read, as Recheck does.
 */
import { mutationTarget, QUEUE_TARGET, type MutationCommand } from '../client/mutations.ts';
import type { Key } from '../terminal/keys.ts';
import { uiText, type SafeText } from '../terminal/safe-text.ts';
import { unavailable } from '../views/actions.ts';
import { editField, textField, type TextField } from '../views/input.ts';
import { writeBlock } from './actions.ts';
import type { Command } from './keymap.ts';
import type { Effect } from './messages.ts';
import { mutationLock, writeLock, type TuiState } from './state.ts';

export type DialogAction = 'pause' | 'resume' | 'continue' | 'queue_pause' | 'queue_resume';

export type Dialog = {
  readonly action: DialogAction;
  /** `null`: the queue. */
  readonly taskId: string | null;
  readonly title: SafeText;
  /** The task version the user looked at when the dialog opened; what a task write is sent with. */
  readonly version: number | null;
  /** What the daemon says the action does (`note` of `allowed_actions`). */
  readonly effect: SafeText | null;
  /** Pausing only. */
  readonly reason: TextField | null;
  /** `--now`: also stop the agent turn running now. Pausing a task only. */
  readonly now: boolean;
  readonly focus: 'reason' | 'now' | null;
  /** Why the last Ctrl-S sent nothing, said in the dialog. */
  readonly error: string | null;
  /** Why the caller may not take it; the dialog still opens to say so. */
  readonly unavailable: string | null;
};

/** Mirrors `COMMAND_PAYLOADS` of `src/application/commands.ts`. */
export const REASON_MAX = 4_096;

const KIND: Readonly<Record<DialogAction, string>> = {
  pause: 'task_pause',
  resume: 'task_resume',
  continue: 'task_continue',
  queue_pause: 'queue_pause',
  queue_resume: 'queue_resume',
};

export const DIALOG_LABEL: Readonly<Record<DialogAction, string>> = {
  pause: 'Pause task',
  resume: 'Resume task',
  continue: 'Continue task',
  queue_pause: 'Pause the queue',
  queue_resume: 'Resume the queue',
};

const withReason = (a: DialogAction): boolean => a === 'pause' || a === 'queue_pause';

type Reduced = { readonly state: TuiState; readonly effects: readonly Effect[] };

export function openDialog(
  state: TuiState,
  o: {
    readonly action: DialogAction;
    readonly taskId: string | null;
    readonly title: SafeText;
    readonly effect: SafeText | null;
    readonly unavailable: string | null;
  },
): Reduced {
  const version =
    o.taskId !== null && state.actions?.taskId === o.taskId
      ? (state.actions.show.data?.version ?? null)
      : null;
  const reason = withReason(o.action) ? textField('line', 'Reason', '', REASON_MAX) : null;
  return {
    state: {
      ...state,
      screens: [...state.screens, 'dialog'],
      dialog: {
        ...o,
        version,
        reason,
        now: false,
        focus: reason === null ? null : 'reason',
        error: null,
      },
    },
    effects: [],
  };
}

export function openQueueDialog(state: TuiState): Reduced {
  const paused = state.queuePaused !== null;
  return openDialog(state, {
    action: paused ? 'queue_resume' : 'queue_pause',
    taskId: null,
    title: uiText('the queue'),
    effect: uiText(
      paused
        ? 'Tasks that have not started are queued and started again.'
        : 'Tasks that have not started stay queued; started tasks go on. Kept across daemon restarts.',
    ),
    unavailable: unavailable('operate', state.caller),
  });
}

function closeDialog(state: TuiState): TuiState {
  return {
    ...state,
    screens: state.screens.slice(0, state.screens.lastIndexOf('dialog')),
    dialog: null,
  };
}

function queueBlock(state: TuiState): string | null {
  const open = mutationLock(state, QUEUE_TARGET);
  if (open !== null)
    return open.state === 'unresolved'
      ? `Nothing was sent: the result of an earlier change to the queue could not be confirmed (request ${open.requestId}). Press Esc, then C on Home to check again.`
      : `Nothing was sent: an earlier change to the queue is not settled yet (request ${open.requestId}).`;
  if (writeLock(state, QUEUE_TARGET) !== null)
    return 'Nothing was sent: the data on screen may be out of date. Try again once it has been read again.';
  return null;
}

/** The write, or why nothing goes out. */
function build(state: TuiState, d: Dialog): MutationCommand | string {
  const label = DIALOG_LABEL[d.action];
  if (d.unavailable !== null) return `Nothing was sent: ${label} ${d.unavailable}.`;
  const reason = d.reason?.text.trim() ?? '';
  if (d.reason !== null && reason === '') return 'Nothing was sent: give a reason first.';
  const payload =
    d.action === 'pause'
      ? { reason, ...(d.now ? { now: true } : {}) }
      : d.action === 'queue_pause'
        ? { reason }
        : {};
  if (d.taskId === null) {
    const blocked = queueBlock(state);
    if (blocked !== null) return blocked;
    return {
      kind: KIND[d.action],
      project: null,
      task_id: null,
      expected_version: null,
      payload,
    };
  }
  const menu = state.actions;
  if (menu === null || menu.taskId !== d.taskId) return 'Nothing was sent: this task is not open.';
  const blocked = writeBlock(state, menu);
  const show = menu.show.data;
  if (blocked !== null || show === null) return blocked ?? '';
  // The user agreed to what they saw: a task that moved since is not acted on, here or by the daemon.
  if (d.version === null || show.version !== d.version)
    return 'Nothing was sent: the task changed since this dialog opened. Press Esc and choose again from the new list.';
  return {
    kind: KIND[d.action],
    project: show.project,
    task_id: d.taskId,
    expected_version: d.version,
    payload,
  };
}

function send(state: TuiState, d: Dialog): Reduced {
  const command = build(state, d);
  if (typeof command === 'string')
    return { state: { ...state, dialog: { ...d, error: command } }, effects: [] };
  const closed = closeDialog(state);
  return {
    state:
      closed.actions !== null && closed.actions.taskId === mutationTarget(command)
        ? { ...closed, actions: { ...closed.actions, notice: null } }
        : closed,
    effects: [{ type: 'submit', command }],
  };
}

const otherField = (d: Dialog): Dialog['focus'] =>
  d.action !== 'pause' ? d.focus : d.focus === 'reason' ? 'now' : 'reason';

/** `null`: not a command of this screen. */
export function onDialogCommand(state: TuiState, command: Command): Reduced | null {
  const d = state.dialog;
  if (d === null) return null;
  const put = (change: Partial<Dialog>): Reduced => ({
    state: { ...state, dialog: { ...d, ...change } },
    effects: [],
  });
  switch (command) {
    case 'back':
      return { state: closeDialog(state), effects: [] };
    case 'send':
      return send(state, d);
    case 'switch_field':
      return put({ focus: otherField(d) });
    case 'toggle':
      return d.focus === 'now' ? put({ now: !d.now, error: null }) : put({});
    default:
      return null;
  }
}

/** A key that is no command, while the reason field has the focus. */
export function onDialogText(state: TuiState, key: Key): Reduced {
  const d = state.dialog;
  if (d === null || d.reason === null || d.focus !== 'reason') return { state, effects: [] };
  const r = editField(d.reason, key);
  if (r.signal === 'next' || r.signal === 'previous')
    return { state: { ...state, dialog: { ...d, focus: otherField(d) } }, effects: [] };
  return {
    state: {
      ...state,
      dialog: { ...d, reason: r.field, error: r.field === d.reason ? d.error : null },
    },
    effects: [],
  };
}
