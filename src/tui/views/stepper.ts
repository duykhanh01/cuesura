/**
 * How stages look: a row of dots on Home, a labelled path on Task detail. Every state has its own mark, so
 * the path reads the same without colour (FR-035), and a skipped stage never looks like one that ran (FR-011).
 */
import type { TaskStatus } from '../../domain/state.ts';
import { STAGE_LABEL, type Stage, type StageState } from '../model/stages.ts';
import type { Style } from '../terminal/screen.ts';
import { DIM, segsWidth, ui, type Seg } from './ink.ts';
import {
  ACTIVE,
  BAD,
  BAD_STRONG,
  FAINT,
  FOCUS,
  GOOD,
  NOTICE,
  STOPPED,
  STOPPED_STRONG,
  WARN,
} from './theme.ts';

type Look = {
  readonly dot: string;
  readonly mark: string;
  readonly style: Style;
  /** Said after the label where the mark alone could be missed. */
  readonly word: string | null;
};

/**
 * A stage that waits, failed or was cancelled has a mark, a colour and a word of its own, so neither colour
 * nor the mark alone has to tell a pause from an end. Cancelled is orange: yellow already means a wait, and on
 * a 16-colour terminal orange falls back to yellow, where the marks `‖` and `■` still differ.
 */
function look(state: StageState, status: TaskStatus): Look {
  switch (state) {
    case 'done':
      return { dot: '●', mark: '✓', style: GOOD, word: null };
    case 'current':
      return status === 'WAITING'
        ? { dot: '‖', mark: '‖', style: WARN, word: 'waiting' }
        : { dot: '◉', mark: '●', style: FOCUS, word: null };
    case 'failed':
      return { dot: '✕', mark: '✕', style: BAD_STRONG, word: 'failed' };
    case 'stopped':
      return { dot: '■', mark: '■', style: STOPPED_STRONG, word: 'cancelled' };
    case 'skipped':
      return { dot: '–', mark: '–', style: FAINT, word: 'skipped' };
    case 'todo':
      return { dot: '○', mark: '○', style: DIM, word: null };
    case 'abandoned':
      return { dot: '·', mark: '·', style: DIM, word: null };
  }
}

/** The mark and style of a stage, for a screen that lays stages out its own way. */
export function stageLook(
  stage: Stage,
  status: TaskStatus,
): { readonly mark: string; readonly style: Style; readonly word: string | null } {
  const { mark, style, word } = look(stage.state, status);
  return { mark, style, word };
}

/** Whether the path goes on after this stage; it ends where the task ended. */
export function leadsOn(state: StageState): boolean {
  return state !== 'failed' && state !== 'stopped' && state !== 'abandoned';
}

const DOT_STYLE: Readonly<Record<StageState, (status: TaskStatus) => Style>> = {
  done: () => GOOD,
  current: (status) => (status === 'WAITING' ? WARN : FOCUS),
  failed: () => BAD_STRONG,
  stopped: () => STOPPED,
  // Fainter than a stage still to come, so it reads as absent and never as one that will run (FR-011).
  skipped: () => FAINT,
  todo: () => DIM,
  abandoned: () => DIM,
};

/**
 * Terminals draw block elements themselves rather than from the font, so the bar looks the same whatever
 * font the user has. The empty right half of each cell is the gap between stages; Home keeps a line between
 * tasks so the bars of two rows do not join.
 */
const BAR = '▌';

/**
 * One cell per stage, for a list row. With colour every stage is the same bar and the colour tells the state.
 * Without colour the distinct marks of `look` carry the states (FR-035).
 */
export function dots(stages: readonly Stage[], status: TaskStatus, color = true): Seg[] {
  return stages.map((s) => {
    if (!color) {
      const { dot, style } = look(s.state, status);
      return ui(dot, style);
    }
    // The bars stop where the task ended: a stage it will never reach has none.
    if (s.state === 'abandoned') return ui(' ');
    return ui(BAR, DOT_STYLE[s.state](status));
  });
}

export const DOTS_WIDTH = 8;

/**
 * `triage ✓ ─ code ● ─ PR ○`: the label carries the stage's style, a stage run more than once says how many
 * times. Joined with breakable spaces so a narrow screen wraps between stages, never inside one.
 */
export function stepper(stages: readonly Stage[], status: TaskStatus): Seg[] {
  const out: Seg[] = [];
  stages.forEach((s, i) => {
    const { mark, style, word } = look(s.state, status);
    if (i > 0) out.push(ui(' ─ ', DIM));
    const runs = s.runs > 1 ? `\u00a0×${s.runs}` : '';
    const label = word === null ? STAGE_LABEL[s.name] : `${STAGE_LABEL[s.name]}\u00a0${word}`;
    out.push(ui(`${label}\u00a0${mark}${runs}`, style));
  });
  return out;
}

/** The stage a reader looks for: where the task is, or where it ended. */
function anchorOf(stages: readonly Stage[]): number {
  const here = stages.findIndex(
    (s) => s.state === 'current' || s.state === 'failed' || s.state === 'stopped',
  );
  return here >= 0 ? here : stages.findLastIndex((s) => s.state === 'done');
}

/**
 * {@link stepper} in one row of `cols` cells. Stages behind the task go first, then those still to come;
 * the anchor stage stays whole, so a narrow screen never cuts the stage that says what is going on.
 */
export function stepperRow(stages: readonly Stage[], status: TaskStatus, cols: number): Seg[] {
  const anchor = Math.max(0, anchorOf(stages));
  const view = (first: number, last: number): Seg[] => [
    ...(first > 0 ? [ui('…', DIM), ui(' ─ ', DIM)] : []),
    ...stepper(stages.slice(first, last), status),
    ...(last < stages.length ? [ui(' ─ ', DIM), ui('…', DIM)] : []),
  ];
  let first = 0;
  let last = stages.length;
  while (segsWidth(view(first, last)) > cols) {
    if (first < anchor) first += 1;
    else if (last > anchor + 1) last -= 1;
    else break;
  }
  return view(first, last);
}

/** What the marks mean, for the screens that draw them: what runs on one row, how a task stops on the next. */
export const STAGE_KEY: readonly (readonly Seg[])[] = [
  [
    ui('✓ ran', GOOD),
    ui('  ● now', ACTIVE),
    ui('  ○ to come', DIM),
    ui('  – skipped by mode', FAINT),
    ui('  ×n runs', DIM),
  ],
  [
    ui('‖ waiting', NOTICE),
    ui('  ✕ failed', BAD),
    ui('  ■ cancelled', STOPPED),
    ui('  · will not run', DIM),
  ],
];

/** The end of a failed or cancelled task, in its stage's mark and colour; `null` for any other task. */
export function endBadge(status: TaskStatus): Seg | null {
  if (status === 'FAILED') return ui('✕ FAILED', BAD_STRONG);
  if (status === 'CANCELLED') return ui('■ CANCELLED', STOPPED_STRONG);
  return null;
}
