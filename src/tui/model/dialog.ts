/**
 * Every dialog of the TUI (feature 004 TUI contract, "Confirmation", "Pause and resume"): Answer, Cancel, Recheck and
 * Approve (US4), pausing, resuming and continuing a task, and pausing or resuming the queue (issue #155). A task
 * dialog sits on top of the Actions menu of its task; the queue dialog on Home. Each sends one write, through the
 * runtime's tracker, only when the user has done what the contract asks: `Ctrl-S` where no word is asked for, a
 * typed word and Enter for a thing with consequences. A task write carries the version the dialog opened on, so
 * a task that moved since is a conflict, never a write on a state the user did not see. Nothing is sent again.
 */
import type { PortResult } from '../client/daemon-port.ts';
import {
  mutationTarget,
  QUEUE_TARGET,
  type Mutation,
  type MutationCommand,
} from '../client/mutations.ts';
import type { Inbox, QuestionShow, TaskExplain, TaskProgress } from '../client/schemas.ts';
import type { Key } from '../terminal/keys.ts';
import { uiText, type SafeText } from '../terminal/safe-text.ts';
import { graphemes } from '../terminal/width.ts';
import { unavailable } from '../views/actions.ts';
import { contentHeight } from '../views/disconnected.ts';
import { dialogPaging } from '../views/dialog.ts';
import { editField, textField, type TextField } from '../views/input.ts';
import { writeBlock } from './actions.ts';
import { EXPLAIN_READ_MS, noPart, type Part } from './detail.ts';
import type { Effect } from './messages.ts';
import { mutationLock, writeLock, type TuiState } from './state.ts';

export type TaskDialogKind =
  | 'answer'
  | 'cancel'
  | 'recheck'
  | 'approve'
  | 'pause'
  | 'resume'
  | 'continue';
export type DialogKind = TaskDialogKind | 'queue_pause' | 'queue_resume';

/** The entries of the Actions menu that open a dialog, by `allowed_actions[].action`. */
export const DIALOG_ACTIONS: Readonly<Record<string, TaskDialogKind>> = {
  answer: 'answer',
  cancel: 'cancel',
  recheck: 'recheck',
  approve: 'approve',
  pause: 'pause',
  resume: 'resume',
  continue: 'continue',
};

/** The words the contract asks for, by dialog; the others send with `Ctrl-S`. */
export const CONFIRM_WORDS = { cancel: 'cancel', approve: 'approve', worktree: 'accept' } as const;

/** Mirror `COMMAND_PAYLOADS` of `src/application/commands.ts`. */
export const ANSWER_MAX = 65_536;
export const REASON_MAX = 4_096;
/** More than any word asked for: what is typed past it can never match. */
const TYPED_MAX = 24;

/** `now`: the `--now` choice of pausing a task. */
export type DialogFocus = 'text' | 'now' | 'confirm' | 'none';

export type Dialog = {
  readonly kind: DialogKind;
  /** `null`: the queue. */
  readonly taskId: string | null;
  readonly title: SafeText;
  readonly session: number;
  readonly project: string | null;
  /** The version of the task when the dialog opened; what a task write is sent with. `null` for the queue. */
  readonly version: number | null;
  /** What the daemon says the action does (`note` of `allowed_actions`), or what the queue dialog does. */
  readonly note: SafeText | null;
  /** Why the caller may not take it; the queue dialog still opens to say so. */
  readonly unavailable: string | null;
  /** `Recheck` of a task waiting on `worktree_changed`: the one with a warning and the word `accept`. */
  readonly worktree: boolean;
  /** `Approve` of a task waiting on `adopt_approval`: adopting its pull request, not an escalation. */
  readonly adopt: boolean;
  /** Answer's answer, and the reason of Cancel and of pausing. */
  readonly field: TextField | null;
  /** `--now`: also stop the agent turn running now. Pausing a task only. */
  readonly now: boolean;
  readonly focus: DialogFocus;
  /** What was typed in the confirmation box. */
  readonly typed: string;
  /** The write is on its way; keys do nothing until it is answered. */
  readonly sending: boolean;
  /** Rows of the text above the field scrolled past; the field and the box stay in view. */
  readonly scroll: number;
  /** What went wrong, said where it was pressed. */
  readonly error: SafeText | null;
  /** The daemon said the question was answered or withdrawn elsewhere. */
  readonly elsewhere: boolean;
  /**
   * The question this dialog answers: the one the task waited on when the dialog opened, or else the first the
   * inbox shows open. When it leaves the inbox it is followed with `question_show`, never swapped for another
   * question the task opened meanwhile, even one asked before the first inbox read came back.
   */
  readonly known: { readonly id: string; readonly body: SafeText | null } | null;
  readonly inbox: Part<Inbox>;
  readonly inboxWatermark: number | null;
  readonly question: Part<QuestionShow>;
  readonly progress: Part<TaskProgress>;
  readonly progressWatermark: number | null;
};

type Reduced = {
  readonly state: TuiState;
  readonly effects: readonly Effect[];
};

const same = (state: TuiState): Reduced => ({ state, effects: [] });

export function confirmWord(d: Dialog): string | null {
  switch (d.kind) {
    case 'cancel':
      return CONFIRM_WORDS.cancel;
    case 'approve':
      return CONFIRM_WORDS.approve;
    case 'recheck':
      return d.worktree ? CONFIRM_WORDS.worktree : null;
    default:
      return null;
  }
}

const COMMAND_KIND: Readonly<Record<DialogKind, string>> = {
  answer: 'answer',
  cancel: 'task_cancel',
  recheck: 'task_recheck',
  approve: 'approve_escalation',
  pause: 'task_pause',
  resume: 'task_resume',
  continue: 'task_continue',
  queue_pause: 'queue_pause',
  queue_resume: 'queue_resume',
};

export const commandKind = (d: Dialog): string =>
  d.kind === 'approve' && d.adopt ? 'approve_adopt' : COMMAND_KIND[d.kind];

/** The step and rung an escalation waits for, from the wait the daemon explains. */
export function approvalTarget(
  explain: TaskExplain,
): { readonly step: string; readonly rung: number } | null {
  const detail = explain.wait?.detail;
  if (detail === undefined || detail.code !== 'escalation') return null;
  const step: unknown = detail['step'];
  const rung: unknown = detail['rung'];
  return typeof step === 'string' && step !== '' && typeof rung === 'number' && rung >= 0
    ? { step, rung }
    : null;
}

/** The pull request an adoption waits on, and the head the daemon last read of it (`null`: not read yet). */
export function adoptTarget(
  explain: TaskExplain,
): { readonly prRef: string | null; readonly headSha: string | null } | null {
  const detail = explain.wait?.detail;
  if (detail === undefined || detail.code !== 'adopt_approval') return null;
  const ref: unknown = detail['pr_ref'];
  const sha: unknown = detail['head_sha'];
  return {
    prRef: typeof ref === 'string' && ref !== '' ? ref : null,
    headSha: typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null,
  };
}

export type QuestionView = {
  readonly id: string | null;
  readonly body: SafeText | null;
  /** The question can still be answered, as far as the reads so far say. */
  readonly open: boolean;
  readonly reading: boolean;
  /** How the question ended elsewhere, when the daemon says it did. */
  readonly ended: {
    readonly status: 'answered' | 'withdrawn';
    readonly answer: SafeText | null;
    readonly by: SafeText | null;
  } | null;
};

export function questionView(d: Dialog, explain: TaskExplain | null): QuestionView {
  const items = d.inbox.data?.items ?? [];
  // The question being answered is the one first seen open; a newer one the task asks later is not it.
  const pinned = d.known;
  const listed =
    pinned === null
      ? (items.find((i) => i.blocking) ?? items[0])
      : items.find((i) => i.question_id === pinned.id);
  const waiting: unknown = explain?.wait?.detail['question_id'];
  const id =
    pinned?.id ??
    listed?.question_id ??
    d.question.data?.question_id ??
    (typeof waiting === 'string' ? waiting : null);
  const shown = d.question.data?.question_id === id ? d.question.data : null;
  const ended =
    shown !== null && shown.status !== 'open'
      ? {
          status: shown.status,
          answer: shown.answer ?? null,
          by: shown.answered_by ?? null,
        }
      : null;
  const inboxRead = d.inbox.data !== null;
  const closed = ended !== null || (inboxRead && listed === undefined) || d.elsewhere;
  return {
    id,
    body: listed?.body ?? shown?.body ?? pinned?.body ?? null,
    open: !closed && listed !== undefined,
    reading: !inboxRead && d.inbox.error === null,
    ended,
  };
}

const withReason = (k: DialogKind): boolean =>
  k === 'cancel' || k === 'pause' || k === 'queue_pause';

function newDialog(
  state: TuiState,
  o: Pick<
    Dialog,
    | 'kind'
    | 'taskId'
    | 'title'
    | 'project'
    | 'version'
    | 'note'
    | 'unavailable'
    | 'worktree'
    | 'adopt'
  > & { readonly known: Dialog['known'] },
): Reduced {
  const session = state.screenSession + 1;
  const field =
    o.kind === 'answer'
      ? textField('multi', 'Answer', '', ANSWER_MAX)
      : o.kind === 'cancel'
        ? textField('multi', 'Reason', '', REASON_MAX)
        : withReason(o.kind)
          ? textField('line', 'Reason', '', REASON_MAX)
          : null;
  const dialog: Dialog = {
    ...o,
    session,
    field,
    now: false,
    focus:
      field !== null
        ? 'text'
        : o.kind === 'approve' || (o.kind === 'recheck' && o.worktree)
          ? 'confirm'
          : 'none',
    typed: '',
    sending: false,
    scroll: 0,
    error: null,
    elsewhere: false,
    inbox: noPart(),
    inboxWatermark: null,
    question: noPart(),
    progress: noPart(),
    progressWatermark: null,
  };
  return {
    state: {
      ...state,
      screens: [...state.screens, 'dialog'],
      dialog,
      screenSession: session,
    },
    effects: [{ type: 'read_screen' }],
  };
}

/** A dialog of the task whose Actions menu is open, on the version both of the menu's reads agree on. */
export function openDialog(
  state: TuiState,
  kind: TaskDialogKind,
  explain: TaskExplain,
  version: number,
  project: string,
): Reduced {
  const waiting: unknown = explain.wait?.detail['question_id'];
  return newDialog(state, {
    kind,
    taskId: explain.task_id,
    title: state.actions?.title ?? uiText(''),
    project,
    version,
    note: explain.allowed_actions.find((a) => a.action === kind)?.note ?? null,
    unavailable: null,
    worktree: kind === 'recheck' && explain.wait?.detail.code === 'worktree_changed',
    adopt: kind === 'approve' && explain.wait?.detail.code === 'adopt_approval',
    known:
      kind === 'answer' && typeof waiting === 'string' && waiting !== ''
        ? { id: waiting, body: null }
        : null,
  });
}

export function openQueueDialog(state: TuiState): Reduced {
  const paused = state.queuePaused !== null;
  return newDialog(state, {
    kind: paused ? 'queue_resume' : 'queue_pause',
    taskId: null,
    title: uiText('the queue'),
    project: null,
    version: null,
    note: uiText(
      paused
        ? 'Tasks that have not started are queued and started again.'
        : 'Tasks that have not started stay queued; started tasks go on. Kept across daemon restarts.',
    ),
    unavailable: unavailable('operate', state.caller),
    worktree: false,
    adopt: false,
    known: null,
  });
}

export function closeDialog(state: TuiState): TuiState {
  const at = state.screens.lastIndexOf('dialog');
  return {
    ...state,
    dialog: null,
    screens: at < 0 ? state.screens : state.screens.slice(0, at),
  };
}

/** Anything typed that leaving would lose, for the question quitting asks. */
export function dialogHasText(state: TuiState): boolean {
  const d = state.dialog;
  return d !== null && !d.sending && d.field !== null && d.field.text !== '';
}

/**
 * What was typed in a dialog whose write is on its way, for stderr when the TUI ends before the daemon answers
 * (Ctrl-C or a signal): a refusal would otherwise lose the draft with the screen.
 */
export function sendingDraftNotice(state: TuiState): string | null {
  const d = state.dialog;
  const text = d?.sending === true ? (d.field?.text ?? '') : '';
  if (d === null || text.trim() === '') return null;
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  const where = d.taskId === null ? 'the queue' : `task ${d.taskId}`;
  return `cusr: what you typed in ${commandKind(d)} on ${where}, kept in case it was not taken:\n${plain
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n')}\n`;
}

export function onDialogCommand(state: TuiState, command: string): Reduced | null {
  if (state.dialog === null) return null;
  if (command !== 'back') return null;
  // Leaving while the write is on its way would lose what was typed and the daemon's answer to it.
  return same(state.dialog.sending ? state : closeDialog(state));
}

const put = (state: TuiState, d: Dialog, change: Partial<Dialog>): Reduced =>
  same({ ...state, dialog: { ...d, ...change } });

const refuse = (state: TuiState, d: Dialog, message: string): Reduced =>
  put(state, d, { error: uiText(message) });

/** Where Tab goes from `focus`: the field and the box, or the field and `--now`. */
function nextFocus(d: Dialog): DialogFocus {
  if (d.kind === 'pause') return d.focus === 'text' ? 'now' : 'text';
  if (confirmWord(d) !== null && d.field !== null) return d.focus === 'text' ? 'confirm' : 'text';
  return d.focus;
}

/** Every key the keymap does not take while a dialog is on top. */
export function onDialogKey(state: TuiState, key: Key): Reduced {
  const d = state.dialog;
  if (d === null) return same(state);
  if (key.kind === 'key' && (key.name === 'pageup' || key.name === 'pagedown')) {
    const { last, page } = dialogPaging(state, contentHeight(state));
    const step = key.name === 'pageup' ? -page : page;
    return put(state, d, { scroll: Math.min(last, Math.max(0, Math.min(d.scroll, last) + step)) });
  }
  if (d.sending) return same(state);
  switch (d.focus) {
    case 'confirm':
      return onConfirmKey(state, d, key);
    case 'text':
      return onFieldKey(state, d, key);
    case 'now':
    case 'none':
      return onChoiceKey(state, d, key);
  }
}

function onChoiceKey(state: TuiState, d: Dialog, key: Key): Reduced {
  if (key.kind === 'char' && key.text === ' ' && d.focus === 'now')
    return put(state, d, { now: !d.now, error: null });
  if (key.kind !== 'key') return same(state);
  switch (key.name) {
    case 'ctrl_s':
      return send(state, d);
    case 'tab':
    case 'shift_tab':
      return put(state, d, { focus: nextFocus(d) });
    default:
      return same(state);
  }
}

function onFieldKey(state: TuiState, d: Dialog, key: Key): Reduced {
  if (d.field === null) return same(state);
  const r = editField(d.field, key, Math.max(1, state.size.cols - 4));
  if (!r.handled) return same(state);
  const asked = confirmWord(d);
  switch (r.signal) {
    case 'submit':
      // Ctrl-S sends only what asks no word; a thing with consequences is confirmed in its own box.
      return asked === null
        ? send(state, { ...d, field: r.field })
        : refuse(
            state,
            { ...d, field: r.field },
            `Ctrl-S does not send this. Press Tab, type ${asked} and press Enter.`,
          );
    case 'next':
    case 'previous':
      return put(state, d, { focus: nextFocus(d) });
    case 'leave':
      return same(closeDialog(state));
    case null:
      return put(state, d, { field: r.field, error: null });
  }
}

function onConfirmKey(state: TuiState, d: Dialog, key: Key): Reduced {
  const word = confirmWord(d);
  if (word === null) return same(state);
  if (key.kind === 'char') {
    const typed = graphemes(d.typed + key.text)
      .slice(0, TYPED_MAX)
      .join('');
    return put(state, d, { typed, error: null });
  }
  // The word is typed by hand, so that nothing already on the clipboard can confirm anything.
  if (key.kind === 'paste')
    return refuse(state, d, `Paste is not accepted here: type ${word} yourself.`);
  switch (key.name) {
    case 'backspace':
      return put(state, d, { typed: graphemes(d.typed).slice(0, -1).join(''), error: null });
    case 'tab':
    case 'shift_tab':
      return put(state, d, { focus: nextFocus(d), error: null });
    case 'ctrl_s':
      return refuse(state, d, `Ctrl-S does not send this: type ${word} and press Enter.`);
    case 'enter':
      return d.typed === word
        ? send(state, d)
        : refuse(state, d, `Nothing was sent: type ${word} exactly, then press Enter.`);
    default:
      return same(state);
  }
}

const reasonOf = (d: Dialog): string => (d.field?.text ?? '').trimEnd();

/** The payload of a task write, or why there is none yet. */
function taskPayload(
  d: Dialog,
  explain: TaskExplain,
): { readonly payload: Readonly<Record<string, unknown>> } | { readonly problem: string } {
  switch (d.kind) {
    case 'answer': {
      const q = questionView(d, explain);
      if (q.id === null || q.reading) return { problem: 'The question is still being read.' };
      if (!q.open)
        return {
          problem: 'This question is no longer open. Your text is kept; nothing was sent.',
        };
      const answer = reasonOf(d);
      if (answer.trim() === '') return { problem: 'Write an answer first. Nothing was sent.' };
      return { payload: { question_id: q.id, answer } };
    }
    case 'cancel': {
      const reason = reasonOf(d);
      if (reason.trim() === '')
        return { problem: 'A reason is required: press Tab to go back to it. Nothing was sent.' };
      return { payload: { reason } };
    }
    case 'recheck':
      // The contract wants the worktree's place before the tree is accepted: no path read, no send.
      if (d.worktree && (d.progress.data?.worktree_path ?? null) === null)
        return {
          problem:
            d.progress.data === null
              ? 'Nothing was sent: the worktree location has not been read yet. Wait for it, or press Esc and try again.'
              : 'Nothing was sent: the daemon gave no worktree location, so what would be accepted cannot be named. Use the CLI after looking at the worktree.',
        };
      return { payload: {} };
    case 'approve': {
      if (d.adopt) {
        const adopt = adoptTarget(explain);
        if (adopt === null)
          return {
            problem:
              'This task is not waiting for an approval to adopt its pull request now. Nothing was sent; press Esc to read it again.',
          };
        if (adopt.headSha === null)
          return {
            problem:
              'Nothing was sent: the daemon has not read the pull request head yet, so what would be approved cannot be named. Wait for it, or use the CLI with the full head SHA (see the CLI line in Actions).',
          };
        return { payload: { head_sha: adopt.headSha } };
      }
      const target = approvalTarget(explain);
      if (target === null)
        return {
          problem:
            'This task is not waiting for an escalation approval now. Nothing was sent; press Esc to read it again.',
        };
      return { payload: target };
    }
    case 'pause': {
      const reason = reasonOf(d).trim();
      if (reason === '') return { problem: 'Nothing was sent: give a reason first.' };
      return { payload: { reason, ...(d.now ? { now: true } : {}) } };
    }
    default:
      return { payload: {} };
  }
}

function buildTask(state: TuiState, d: Dialog): MutationCommand | string {
  const menu = state.actions;
  const explain = menu?.explain.data ?? null;
  const show = menu?.show.data ?? null;
  if (menu === null || menu.taskId !== d.taskId || explain === null || show === null)
    return 'Nothing was sent: this task is still being read.';
  // The user agreed to what they saw: a task that moved since is not acted on, here or by the daemon.
  if (explain.version !== d.version || show.version !== d.version)
    return 'Nothing was sent: the task changed since this dialog opened. Press Esc and open it again to read what is new.';
  const blocked = writeBlock(state, menu);
  if (blocked !== null) return blocked;
  const built = taskPayload(d, explain);
  if ('problem' in built) return built.problem;
  return {
    kind: commandKind(d),
    project: d.project,
    task_id: d.taskId,
    expected_version: d.version,
    payload: built.payload,
  };
}

function buildQueue(state: TuiState, d: Dialog): MutationCommand | string {
  if (d.unavailable !== null)
    return `Nothing was sent: ${d.kind === 'queue_pause' ? 'Pause the queue' : 'Resume the queue'} ${d.unavailable}.`;
  const reason = reasonOf(d).trim();
  if (d.field !== null && reason === '') return 'Nothing was sent: give a reason first.';
  const open = mutationLock(state, QUEUE_TARGET);
  if (open !== null)
    return open.state === 'unresolved'
      ? `Nothing was sent: the result of an earlier change to the queue could not be confirmed (request ${open.requestId}). Press Esc, then C on Home to check again.`
      : `Nothing was sent: an earlier change to the queue is not settled yet (request ${open.requestId}).`;
  if (writeLock(state, QUEUE_TARGET) !== null)
    return 'Nothing was sent: the data on screen may be out of date. Try again once it has been read again.';
  return {
    kind: commandKind(d),
    project: null,
    task_id: null,
    expected_version: null,
    payload: d.kind === 'queue_pause' ? { reason } : {},
  };
}

function send(state: TuiState, d: Dialog): Reduced {
  const command = d.taskId === null ? buildQueue(state, d) : buildTask(state, d);
  if (typeof command === 'string') return refuse(state, d, command);
  const menu = state.actions;
  return {
    state: {
      ...state,
      dialog: { ...d, sending: true, error: null },
      // The menu under says what becomes of this write, not what an earlier Enter said.
      actions: menu !== null && menu.taskId === d.taskId ? { ...menu, notice: null } : menu,
    },
    effects: [{ type: 'submit', command }],
  };
}

/**
 * A conflict on Answer that is about the question, not the task's version: `stale_version` is the daemon
 * saying the task moved while the question may still be open, which `question_show` then tells.
 */
function closedElsewhere(d: Dialog, result: NonNullable<Mutation['result']>): boolean {
  return d.kind === 'answer' && result.ok === false && result.message !== 'stale_version';
}

/** What the daemon's refusal means for this dialog, in words. */
function rejection(d: Dialog, result: Mutation['result']): string {
  if (result === null || result.ok) return 'The daemon did not accept it.';
  if (result.code === 'conflict' && d.taskId !== null)
    return closedElsewhere(d, result)
      ? 'Nothing was sent again: the question was already answered or withdrawn. What the daemon holds is below; your text is kept.'
      : `Nothing was sent again: the task changed since this dialog opened (${result.message}). Press Esc and open it again to read what is new.`;
  return `The daemon refused it (${result.code}: ${result.message}). Nothing was sent again.`;
}

/** The tracker moved the write this dialog sent: close on the daemon's word, or show why it was refused. */
export function onDialogMutation(state: TuiState, m: Mutation): Reduced {
  const d = state.dialog;
  if (d === null || !d.sending) return same(state);
  if (mutationTarget(m.command) !== (d.taskId ?? QUEUE_TARGET)) return same(state);
  if (m.command.kind !== commandKind(d)) return same(state);
  switch (m.state) {
    case 'sending':
      return same(state);
    case 'accepted':
    case 'unknown':
    case 'unresolved':
      // The screen under says what is known of it, and goes on checking what is not.
      return same(closeDialog(state));
    case 'rejected': {
      const r = m.result;
      const elsewhere = r?.ok === false && r.code === 'conflict' && closedElsewhere(d, r);
      return {
        state: {
          ...state,
          dialog: {
            ...d,
            sending: false,
            error: uiText(rejection(d, m.result)),
            elsewhere: d.elsewhere || elsewhere,
            question: elsewhere ? noPart() : d.question,
          },
        },
        effects: elsewhere ? [{ type: 'read_screen' }] : [],
      };
    }
  }
}

export type DialogReadMessage = {
  readonly type: 'dialog_read';
  readonly taskId: string;
  readonly session: number;
  readonly askedAt: number;
  readonly at: number;
  readonly watermark: number | null;
} & (
  | { readonly part: 'inbox'; readonly result: PortResult<Inbox> }
  | { readonly part: 'question'; readonly result: PortResult<QuestionShow> }
  | { readonly part: 'progress'; readonly result: PortResult<TaskProgress> }
);

export type DialogPartName = 'inbox' | 'question' | 'progress';

/** Which reads the dialog needs now; none for what it never shows. */
export function dialogDue(
  d: Dialog,
  explain: TaskExplain | null,
  watermark: number | null,
  now: number,
): readonly DialogPartName[] {
  const due: DialogPartName[] = [];
  const stale = (p: Part<unknown>, seen: number | null): boolean => {
    if (p.attemptAt === null) return true;
    if (p.error !== null) return now - p.attemptAt >= EXPLAIN_READ_MS;
    return watermark !== null && watermark !== seen;
  };
  if (d.kind === 'answer') {
    if (stale(d.inbox, d.inboxWatermark)) due.push('inbox');
    const q = questionView(d, explain);
    const listed = d.inbox.data?.items.some((i) => i.question_id === q.id) ?? false;
    const wanted = q.id !== null && (d.elsewhere || (d.inbox.data !== null && !listed));
    // A question that ended is final; one still open is asked again until the daemon says it ended.
    if (wanted && q.ended === null) {
      const p = d.question;
      if (p.attemptAt === null || now - p.attemptAt >= EXPLAIN_READ_MS) due.push('question');
    }
  }
  if (d.kind === 'recheck' && d.worktree && stale(d.progress, d.progressWatermark))
    due.push('progress');
  return due;
}

function pin(known: Dialog['known'], items: Inbox['items']): Dialog['known'] {
  if (known === null) {
    const open = items.find((i) => i.blocking) ?? items[0];
    return open === undefined ? null : { id: open.question_id, body: open.body };
  }
  if (known.body !== null) return known;
  const listed = items.find((i) => i.question_id === known.id);
  return listed === undefined ? known : { id: known.id, body: listed.body };
}

export function onDialogRead(state: TuiState, m: DialogReadMessage): TuiState {
  const d = state.dialog;
  if (d === null || d.taskId !== m.taskId || d.session !== m.session) return state;
  const failed = <T>(p: Part<T>, message: SafeText): Part<T> => ({
    ...p,
    error: message,
    attemptAt: m.askedAt,
  });
  switch (m.part) {
    case 'inbox': {
      const items = m.result.ok ? m.result.value.items : [];
      return {
        ...state,
        dialog: {
          ...d,
          known: pin(d.known, items),
          inbox: m.result.ok
            ? { data: m.result.value, error: null, attemptAt: m.askedAt, readAt: m.at }
            : failed(d.inbox, m.result.error.message),
          inboxWatermark: m.watermark,
        },
      };
    }
    case 'question':
      return {
        ...state,
        dialog: {
          ...d,
          // The daemon says it is still open: nothing happened to it elsewhere, whatever was guessed.
          elsewhere: m.result.ok && m.result.value.status === 'open' ? false : d.elsewhere,
          question: m.result.ok
            ? { data: m.result.value, error: null, attemptAt: m.askedAt, readAt: m.at }
            : failed(d.question, m.result.error.message),
        },
      };
    case 'progress':
      return {
        ...state,
        dialog: {
          ...d,
          progress: m.result.ok
            ? { data: m.result.value, error: null, attemptAt: m.askedAt, readAt: m.at }
            : failed(d.progress, m.result.error.message),
          progressWatermark: m.watermark,
        },
      };
  }
}
