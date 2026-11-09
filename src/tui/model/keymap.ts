/**
 * Every key of the interface, by context (FR-033, contracts/tui.md "Phím"). The reducer turns a key into a
 * command only through `commandFor`, the hint bar and Help are drawn only from these tables, so a key can never
 * work without being shown, or be shown without working. A binding that does not apply right now (`when`)
 * neither acts nor shows.
 */
import type { Key, KeyName } from '../terminal/keys.ts';
import { displayWidth } from '../terminal/width.ts';
import { logColumns } from './logs.ts';
import { QUEUE_TARGET } from '../client/mutations.ts';
import { confirmWord } from './dialog.ts';
import { currentScreen, mutationLock, type TuiState } from './state.ts';

export type Command =
  | 'up'
  | 'down'
  | 'page_up'
  | 'page_down'
  | 'top'
  | 'end'
  | 'open'
  | 'apply'
  | 'back'
  | 'actions'
  | 'filters'
  | 'help'
  | 'retry'
  | 'quit'
  | 'logs'
  | 'details'
  | 'technical'
  | 'pause'
  | 'toggle_output'
  | 'toggle_pane'
  | 'previous_step'
  | 'next_step'
  | 'attempts'
  | 'next_gate'
  | 'previous_gate'
  | 'next_round'
  | 'previous_round'
  | 'expand'
  | 'collapse'
  | 'switch_field'
  | 'erase'
  | 'check_again'
  | 'queue';

export type Context =
  | 'home'
  | 'detail'
  | 'logs'
  | 'attempts'
  | 'actions'
  | 'filter_text'
  | 'filter_choice'
  | 'dialog_text'
  | 'dialog_confirm'
  | 'dialog_plain'
  | 'help';

type Press = { readonly name: KeyName } | { readonly char: string };

export type Binding = {
  /** The keys as the bar shows them. */
  readonly keys: string;
  /** The words after the keys on the bar; `null` shows the binding in Help only. */
  readonly hint: string | null;
  readonly help: string;
  /** The keys as Help lists them, when not as on the bar. */
  readonly helpKeys?: string;
  readonly press: readonly (readonly [Press, Command])[];
  /** Kept on a narrow bar: going back, help, quitting and retrying must always be in sight (US3 scenario 1). */
  readonly essential?: boolean;
  /** Essential only in this state of the screen. */
  readonly keep?: (s: TuiState) => boolean;
  readonly when?: (s: TuiState) => boolean;
};

const n = (name: KeyName): Press => ({ name });
const c = (char: string): Press => ({ char });

const MOVE: Binding['press'] = [
  [n('up'), 'up'],
  [n('down'), 'down'],
  [c('k'), 'up'],
  [c('j'), 'down'],
];
const PAGE: Binding['press'] = [
  [n('pageup'), 'page_up'],
  [n('pagedown'), 'page_down'],
];
const ENDS: Binding['press'] = [
  [c('g'), 'top'],
  [c('G'), 'end'],
  [n('home'), 'top'],
  [n('end'), 'end'],
];
const END_KEYS = 'g G Home End';

const onTask = (s: TuiState): boolean => s.selectedTaskId !== null && !s.finishedSelected;

const readingGates = (s: TuiState): boolean => (s.logs?.gates ?? null) !== null;

/** The dialogs take their keys themselves (`model/dialog.ts`); these say which, for the bar and Help. */
const DIALOG_SEND: Binding = {
  keys: 'Ctrl-S',
  hint: 'send',
  help: 'Send what the dialog describes; nothing goes out before this',
  press: [],
  when: (s) => s.dialog !== null && confirmWord(s.dialog) === null,
};

/** Pausing a task: the reason field and the choice to stop the running agent now take turns. */
const DIALOG_NOW_FIELD: Binding = {
  keys: 'Tab',
  hint: 'next field',
  helpKeys: 'Tab Shift-Tab',
  help: 'Go between the reason and the choice to stop the running agent now',
  press: [],
  when: (s) => s.dialog?.kind === 'pause',
};

const DIALOG_SCROLL: Binding = {
  keys: 'PgUp/PgDn',
  hint: null,
  helpKeys: 'PgUp PgDn',
  help: 'Scroll what the dialog says above its fields',
  press: [],
};

const waiting = (s: TuiState): boolean =>
  s.connection.kind === 'waiting_retry' || s.connection.kind === 'stopped';

const KEYS: Readonly<Record<Context, readonly Binding[]>> = {
  home: [
    {
      keys: '↑↓',
      hint: 'move',
      helpKeys: '↑ ↓ k j',
      help: 'Move the selection',
      press: MOVE,
    },
    {
      keys: 'PgUp/PgDn',
      hint: '',
      help: 'Scroll a page; at the top or end of the list, the page before or after',
      press: PAGE,
    },
    {
      keys: 'g/G',
      hint: null,
      helpKeys: END_KEYS,
      help: 'Top and end of the list',
      press: ENDS,
    },
    {
      keys: 'Enter',
      hint: 'open',
      help: 'Open the selected task',
      press: [[n('enter'), 'open']],
      when: onTask,
    },
    {
      keys: 'Enter',
      hint: 'fold/unfold',
      help: 'On Finished: show or hide finished tasks',
      press: [[n('enter'), 'open']],
      when: (s) => s.finishedSelected,
    },
    {
      keys: 'a',
      hint: 'actions',
      help: 'Actions of the selected task',
      press: [[c('a'), 'actions']],
      when: onTask,
    },
    {
      keys: 'f',
      hint: 'filter',
      help: 'Filter by project and status',
      press: [[c('f'), 'filters']],
    },
    {
      keys: 'p',
      hint: 'pause queue',
      help: 'Pause the queue: tasks that have not started stay queued; asks for a reason first',
      press: [[c('p'), 'queue']],
      when: (s) => s.lastUpdatedAt !== null && s.queuePaused === null,
    },
    {
      keys: 'p',
      hint: 'resume queue',
      help: 'Resume the paused queue; asks before sending',
      press: [[c('p'), 'queue']],
      keep: (s) => s.queuePaused !== null,
      when: (s) => s.lastUpdatedAt !== null && s.queuePaused !== null,
    },
    {
      keys: 'C',
      hint: 'check queue again',
      help: 'Ask again whether an earlier change to the queue went through, when it could not be confirmed',
      press: [
        [c('c'), 'check_again'],
        [c('C'), 'check_again'],
      ],
      // Until it is settled no other queue change can go out, so the way out must stay in sight.
      keep: () => true,
      when: (s) => mutationLock(s, QUEUE_TARGET)?.state === 'unresolved',
    },
  ],
  detail: [
    {
      keys: '↑↓',
      hint: 'scroll',
      helpKeys: '↑ ↓ k j',
      help: 'Scroll',
      press: MOVE,
    },
    { keys: 'PgUp/PgDn', hint: '', help: 'Scroll a page', press: PAGE },
    {
      keys: 'g/G',
      hint: 'top/end',
      helpKeys: END_KEYS,
      help: 'Top and end',
      press: ENDS,
    },
    {
      keys: 'l',
      hint: 'logs',
      help: 'Back to the logs of this task',
      press: [[c('l'), 'logs']],
    },
    {
      keys: 'a',
      hint: 'actions',
      help: 'Actions of this task',
      press: [[c('a'), 'actions']],
    },
    {
      keys: 'i',
      hint: 'technical info',
      help: 'Show or hide codes, commits, attempts and raw history',
      press: [[c('i'), 'technical']],
    },
  ],
  logs: [
    {
      keys: 'd',
      hint: 'details',
      help: 'Show task details: why it waits, what to do, PR, limits and history',
      press: [[c('d'), 'details']],
    },
    {
      keys: '↑↓',
      hint: 'PgUp/PgDn scroll',
      helpKeys: '↑ ↓ k j PgUp PgDn',
      help: 'Scroll; scrolling up holds the place, the end follows again',
      press: [...MOVE, ...PAGE],
    },
    {
      keys: 'g/G',
      hint: null,
      helpKeys: END_KEYS,
      help: 'Top and end of what was read',
      press: ENDS,
    },
    {
      keys: 'Space',
      hint: 'pause/live',
      help: 'Pause following, or go back to following live from anywhere',
      press: [[c(' '), 'pause']],
      // A finished log has nothing to follow, but reading one attempt still needs a way back.
      when: (s) => s.logs?.complete !== true || s.logs.attemptFilter !== null,
    },
    {
      keys: '←→',
      keep: readingGates,
      hint: 'step',
      help: 'The step before or after this one; past the last, following live',
      press: [
        [n('left'), 'previous_step'],
        [n('right'), 'next_step'],
      ],
    },
    {
      keys: 'Tab',
      keep: readingGates,
      hint: 'gate',
      helpKeys: 'Tab Shift-Tab',
      help: 'Reading gates: the next or the previous gate',
      press: [
        [n('tab'), 'next_gate'],
        [n('shift_tab'), 'previous_gate'],
      ],
      when: readingGates,
    },
    {
      keys: '[ ]',
      keep: readingGates,
      hint: 'round',
      help: 'Reading gates: the round before or after this one',
      press: [
        [c('['), 'previous_round'],
        [c(']'), 'next_round'],
      ],
      when: readingGates,
    },
    {
      keys: 't',
      hint: 'attempt',
      help: 'Choose an attempt to read',
      press: [[c('t'), 'attempts']],
    },
    {
      keys: 'Ctrl-O',
      hint: 'output',
      help: 'Show or hide the whole output of each tool call',
      press: [[n('ctrl_o'), 'toggle_output']],
      when: (s) => !readingGates(s),
    },
    {
      keys: 'p',
      hint: 'progress',
      help: 'Hide or show the progress column, to select and copy the log alone',
      press: [[c('p'), 'toggle_pane']],
      when: (s) => logColumns(s.size.cols).pane > 0,
    },
  ],
  attempts: [
    {
      keys: '↑↓',
      hint: 'choose',
      helpKeys: '↑ ↓ k j',
      help: 'Choose an attempt',
      press: MOVE,
    },
    {
      keys: '←→',
      hint: 'fold',
      helpKeys: '← → h l',
      help: 'Fold or unfold a round, or a step run several times in a row',
      press: [
        [n('left'), 'collapse'],
        [n('right'), 'expand'],
        [c('h'), 'collapse'],
        [c('l'), 'expand'],
      ],
    },
    {
      keys: 'g/G',
      hint: null,
      helpKeys: END_KEYS,
      help: 'First and last row',
      press: ENDS,
    },
    {
      keys: 'Enter',
      hint: 'open',
      help: 'Read the chosen attempt; on a round or a run, fold or unfold it',
      press: [[n('enter'), 'open']],
    },
  ],
  actions: [
    {
      keys: '↑↓',
      hint: 'choose',
      helpKeys: '↑ ↓ k j',
      help: 'Choose an action',
      press: MOVE,
    },
    {
      keys: 'PgUp/PgDn',
      hint: 'read on',
      help: 'Read on in a long entry, such as a proposed merge message',
      press: PAGE,
    },
    {
      keys: 'Enter',
      hint: 'open',
      help: 'Open the chosen action; nothing is sent without its own confirmation',
      press: [[n('enter'), 'open']],
    },
    {
      keys: 'C',
      hint: 'check again',
      help: 'Ask again whether an earlier change went through, when it could not be confirmed',
      press: [
        [c('c'), 'check_again'],
        [c('C'), 'check_again'],
      ],
      when: (s) => {
        const id = s.actions?.taskId;
        return id !== undefined && mutationLock(s, id)?.state === 'unresolved';
      },
    },
  ],
  filter_choice: [
    {
      keys: 'Enter',
      hint: 'apply',
      help: 'Apply the filter',
      press: [[n('enter'), 'apply']],
    },
    {
      keys: '↑↓',
      hint: 'choose',
      helpKeys: '↑ ↓ k j',
      help: 'Choose a status',
      press: MOVE,
    },
    {
      keys: 'Tab',
      hint: 'project',
      helpKeys: 'Tab Shift-Tab',
      help: 'Go to the project field',
      press: [
        [n('tab'), 'switch_field'],
        [n('shift_tab'), 'switch_field'],
      ],
    },
  ],
  filter_text: [
    {
      keys: 'Enter',
      hint: 'apply',
      help: 'Apply the filter',
      press: [[n('enter'), 'apply']],
    },
    {
      keys: '↑↓',
      hint: 'choose',
      help: 'Choose a project',
      press: [
        [n('up'), 'up'],
        [n('down'), 'down'],
      ],
    },
    {
      keys: 'Tab',
      hint: 'status',
      helpKeys: 'Tab Shift-Tab',
      help: 'Go to the status list; there q, ? and R are keys again',
      press: [
        [n('tab'), 'switch_field'],
        [n('shift_tab'), 'switch_field'],
      ],
    },
    {
      keys: 'Backspace',
      hint: null,
      help: 'Delete the last character of the project name',
      press: [[n('backspace'), 'erase']],
    },
  ],
  dialog_text: [
    DIALOG_SEND,
    {
      keys: 'Tab',
      hint: 'confirm box',
      helpKeys: 'Tab Shift-Tab',
      help: 'Go to the box where the word is typed',
      press: [],
      when: (s) => s.dialog !== null && confirmWord(s.dialog) !== null,
    },
    DIALOG_NOW_FIELD,
    DIALOG_SCROLL,
  ],
  dialog_confirm: [
    {
      keys: 'Enter',
      hint: 'confirm',
      help: 'Send, when what is typed is exactly the word asked for; nothing else sends it',
      press: [],
    },
    {
      keys: 'Tab',
      hint: 'text',
      helpKeys: 'Tab Shift-Tab',
      help: 'Back to the text above the confirmation box',
      press: [],
      when: (s) => (s.dialog?.field ?? null) !== null,
    },
    DIALOG_SCROLL,
  ],
  dialog_plain: [
    DIALOG_SEND,
    {
      keys: 'Space',
      hint: 'stop now on/off',
      help: 'Also stop the agent turn running now; it starts over in a new session on resume',
      press: [],
      when: (s) => s.dialog?.focus === 'now',
    },
    DIALOG_NOW_FIELD,
    DIALOG_SCROLL,
  ],
  help: [
    {
      keys: '↑↓',
      hint: 'scroll',
      helpKeys: '↑ ↓ k j PgUp PgDn',
      help: 'Scroll this help',
      press: [...MOVE, ...PAGE],
    },
    {
      keys: 'g/G',
      hint: null,
      helpKeys: END_KEYS,
      help: 'Top and end of this help',
      press: ENDS,
    },
  ],
};

/** In a text field a printable key is text, so only keys that are not text are global there. */
const typing = (ctx: Context): boolean =>
  ctx === 'filter_text' || ctx === 'dialog_text' || ctx === 'dialog_confirm';

const GLOBAL_LEAD: readonly Binding[] = [
  {
    keys: 'Esc',
    hint: 'back',
    help: 'Go back; leave a dialog or form without sending',
    press: [[n('esc'), 'back']],
    essential: true,
    when: (s) => s.screens.length > 1,
  },
];

const GLOBAL_TAIL: readonly Binding[] = [
  {
    keys: 'Ctrl-L',
    hint: null,
    help: 'Draw the screen again; coming back to the window does this by itself',
    // Works on every screen, fields too, ahead of them all (`main.ts`).
    press: [],
  },
  {
    keys: 'q',
    hint: 'quit',
    help: 'Quit; tasks and the daemon keep running. Asks again if you typed something',
    press: [
      [c('q'), 'quit'],
      [n('ctrl_c'), 'quit'],
    ],
    essential: true,
  },
  {
    keys: '?',
    hint: 'help',
    help: 'This help, for the screen you are on',
    press: [[c('?'), 'help']],
    essential: true,
    when: (s) => currentScreen(s) !== 'help',
  },
  {
    keys: 'R',
    hint: 'retry connection',
    help: 'Retry the daemon connection once the automatic attempts are used',
    press: [[c('R'), 'retry']],
    essential: true,
    when: waiting,
  },
  {
    keys: 'Ctrl-C',
    hint: null,
    help: 'Quit; does not cancel any task. Asks again if you typed something',
    press: [[n('ctrl_c'), 'quit']],
  },
];

const TYPING_TAIL: readonly Binding[] = [
  {
    keys: 'Ctrl-C',
    hint: 'quit',
    help: 'Quit; does not cancel any task. Asks again if you typed something',
    press: [[n('ctrl_c'), 'quit']],
    essential: true,
  },
];

/** What every field of a form or dialog does with the keys that are not text (`views/input.ts`). */
export type FieldCommand =
  | 'next'
  | 'previous'
  | 'submit'
  | 'leave'
  | 'enter'
  | 'delete_back'
  | 'delete_forward'
  | 'left'
  | 'right'
  | 'line_start'
  | 'line_end'
  | 'line_up'
  | 'line_down';

export const FIELD_KEYS: readonly {
  readonly keys: string;
  readonly help: string;
  readonly press: readonly (readonly [Press, FieldCommand])[];
}[] = [
  { keys: 'Tab', help: 'Next field', press: [[n('tab'), 'next']] },
  {
    keys: 'Shift-Tab',
    help: 'Previous field',
    press: [[n('shift_tab'), 'previous']],
  },
  { keys: 'Ctrl-S', help: 'Send', press: [[n('ctrl_s'), 'submit']] },
  {
    keys: 'Esc',
    help: 'Leave without sending',
    press: [[n('esc'), 'leave']],
  },
  {
    keys: 'Enter',
    help: 'New line in a multi-line field; next field in a one-line field. Never sends',
    press: [[n('enter'), 'enter']],
  },
  {
    keys: 'Backspace Delete',
    help: 'Delete the character before or under the cursor',
    press: [
      [n('backspace'), 'delete_back'],
      [n('delete'), 'delete_forward'],
    ],
  },
  {
    keys: '← →',
    help: 'Move the cursor by one character',
    press: [
      [n('left'), 'left'],
      [n('right'), 'right'],
    ],
  },
  {
    keys: 'Home End',
    help: 'Start and end of the line',
    press: [
      [n('home'), 'line_start'],
      [n('end'), 'line_end'],
    ],
  },
  {
    keys: '↑ ↓',
    help: 'Line above and below, in a multi-line field',
    press: [
      [n('up'), 'line_up'],
      [n('down'), 'line_down'],
    ],
  },
];

/** Help's lines for text fields; the first says what makes a field different. */
export const FIELD_HELP: readonly (readonly [string, string])[] = [
  ['a–z ? q …', 'Every printable key, and a paste, is text'],
  ...FIELD_KEYS.map((k) => [k.keys, k.help] as const),
];

export function fieldCommand(key: Key): FieldCommand | null {
  if (key.kind !== 'key') return null;
  for (const k of FIELD_KEYS)
    for (const [p, command] of k.press) if (matches(p, key)) return command;
  return null;
}

export function keyContext(s: TuiState): Context {
  switch (currentScreen(s)) {
    case 'home':
      return 'home';
    case 'detail':
      return 'detail';
    case 'logs':
      return (s.logs?.picker ?? null) === null ? 'logs' : 'attempts';
    case 'actions':
      return 'actions';
    case 'filters':
      return s.filterDraft?.field === 'project' ? 'filter_text' : 'filter_choice';
    case 'dialog':
      return s.dialog?.focus === 'text'
        ? 'dialog_text'
        : s.dialog?.focus === 'confirm'
          ? 'dialog_confirm'
          : 'dialog_plain';
    case 'help':
      return 'help';
  }
}

/** The bindings of `ctx` in the order the bar shows them, whether they apply now or not. */
export function bindings(ctx: Context): readonly Binding[] {
  return [...GLOBAL_LEAD, ...KEYS[ctx], ...(typing(ctx) ? TYPING_TAIL : GLOBAL_TAIL)];
}

/** The bindings of a context of its own, without those of every screen: for Help. */
export const ownBindings = (ctx: Context): readonly Binding[] => KEYS[ctx];
export const globalBindings = (): readonly Binding[] => [...GLOBAL_LEAD, ...GLOBAL_TAIL];

function matches(p: Press, key: Key): boolean {
  if ('name' in p) return key.kind === 'key' && key.name === p.name;
  return key.kind === 'char' && key.text === p.char;
}

const applies = (b: Binding, s: TuiState): boolean => b.when === undefined || b.when(s);

/** What `key` means where the user is; `null`: nothing, or text for the field being typed in. */
export function commandFor(s: TuiState, key: Key): Command | null {
  for (const b of bindings(keyContext(s))) {
    if (!applies(b, s)) continue;
    for (const [p, command] of b.press) if (matches(p, key)) return command;
  }
  return null;
}

const label = (b: Binding): string => (b.hint === '' ? b.keys : `${b.keys} ${b.hint}`);

/**
 * The bar of the keys that work now, `cols` wide at most. What does not fit goes from the end, but going back,
 * help, quitting and retrying stay; Help still lists the rest.
 */
export function hintBar(s: TuiState, cols: number): string {
  const shown = bindings(keyContext(s)).filter((b) => b.hint !== null && applies(b, s));
  const width = (bs: readonly Binding[]): number => displayWidth(bs.map(label).join('  '));
  let kept = shown;
  while (width(kept) > cols) {
    const drop = kept.findLastIndex((b) => b.essential !== true && b.keep?.(s) !== true);
    if (drop < 0) break;
    kept = kept.filter((_, i) => i !== drop);
  }
  return kept.map(label).join('  ');
}

/** The names Help gives each context. */
export const CONTEXT_TITLES: Readonly<Record<Context, string>> = {
  home: 'Home',
  detail: 'Task detail',
  logs: 'Logs',
  attempts: 'Logs, choosing an attempt',
  actions: 'Actions',
  filter_choice: 'Filter',
  filter_text: 'Filter, typing a project name',
  dialog_text: 'Dialog, typing text',
  dialog_confirm: 'Dialog, confirmation box',
  dialog_plain: 'Dialog',
  help: 'Help',
};
