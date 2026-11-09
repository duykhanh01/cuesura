/**
 * Help (FR-033): every key, from the keymap only, starting with those of the screen it was opened over. It is
 * a screen on the stack and changes nothing under it, so Esc comes back to the same place (US3 scenario 4).
 */
import {
  CONTEXT_TITLES,
  FIELD_HELP,
  globalBindings,
  keyContext,
  ownBindings,
  type Binding,
  type Context,
} from '../model/keymap.ts';
import type { TuiState } from '../model/state.ts';
import { joinSafe, uiText, type SafeText } from '../terminal/safe-text.ts';
import type { Style } from '../terminal/screen.ts';
import { padEnd, truncate, wrap } from '../terminal/width.ts';
import { TASK_STATUSES } from '../../domain/state.ts';
import { statusGlyph } from '../model/activity.ts';
import { DIM, fg, plain, putSegs, ruleHeading, ui, type Seg } from './ink.ts';
import type { Body } from './layout.ts';
import { STAGE_KEY } from './stepper.ts';
import { WARN } from './theme.ts';

const KEY_COLUMN = 20;
/** Every context Help describes, in this order after the one the user came from. */
const ORDER: readonly Context[] = [
  'home',
  'detail',
  'logs',
  'attempts',
  'actions',
  'filter_choice',
  'filter_text',
  'dialog_text',
  'dialog_confirm',
  'dialog_plain',
  'help',
];

type Line = {
  readonly text: SafeText;
  readonly style: Style;
  readonly segs?: readonly Seg[];
};

const heading = (text: string): Line => ({
  text: uiText(text),
  style: { bold: true },
});

/** Help says all of it: a long description wraps under itself instead of being cut. */
function entry(keys: string, help: string, cols: number): Line[] {
  const room = Math.max(10, cols - KEY_COLUMN - 1);
  return wrap(uiText(help), room).map((row, i) => ({
    text: joinSafe([
      i === 0
        ? uiText(`  ${padEnd(uiText(keys), KEY_COLUMN - 2)} `)
        : uiText(' '.repeat(KEY_COLUMN + 1)),
      row,
    ]),
    style: {},
  }));
}

const entries = (bs: readonly Binding[], cols: number): Line[] =>
  bs.flatMap((b) => entry(b.helpKeys ?? b.keys, b.help, cols));

/** The context Help was opened over. */
export function helpContext(s: TuiState): Context {
  const under = s.screens.slice(0, s.screens.lastIndexOf('help'));
  return keyContext({ ...s, screens: under.length === 0 ? ['home'] : under });
}

export function helpLines(s: TuiState): readonly Line[] {
  const here = helpContext(s);
  const cols = s.size.cols;
  return [
    heading(`Keys on ${CONTEXT_TITLES[here]}`),
    ...entries(ownBindings(here), cols),
    heading('Everywhere, outside a text field'),
    ...entries(globalBindings(), cols),
    ...ORDER.filter((c) => c !== here).flatMap((c) => [
      heading(`Keys on ${CONTEXT_TITLES[c]}`),
      ...entries(ownBindings(c), cols),
    ]),
    ...readingLines(cols),
    heading('Keys in a text field'),
    ...FIELD_HELP.flatMap(([keys, help]) => entry(keys, help, cols)),
  ];
}

function readingLines(cols: number): Line[] {
  const out: Seg[][] = [];
  out.push([], ruleHeading('Reading the screen', cols), []);
  out.push([
    ui('  Status'.padEnd(15), DIM),
    ...TASK_STATUSES.flatMap((s, i) => {
      const { mark, color } = statusGlyph(s);
      return [
        ...(i === 0 ? [] : [ui('   ')]),
        ui(mark, fg(color, { bold: true })),
        ui(` ${s.toLowerCase()}`),
      ];
    }),
  ]);
  out.push([
    ui('  Stages'.padEnd(15), DIM),
    ui('triage, prepare, code, gates, review, PR, CI, merge: one dot each on Home'),
  ]);
  for (const key of STAGE_KEY) out.push([ui(''.padEnd(15)), ...key]);
  out.push([
    ui('  Needs you'.padEnd(15), DIM),
    ui('→ what to do', WARN),
    ui(' for tasks that cannot go on without you'),
  ]);
  return out.map((segs) => ({ text: plain(segs), style: {}, segs }));
}

/** The first row that can be on top: the end of Help is the bottom of the screen. */
export const helpLastTop = (s: TuiState, height: number): number =>
  Math.max(0, helpLines(s).length - height);

export const helpBody =
  (s: TuiState): Body =>
  (frame, top, height) => {
    const lines = helpLines(s);
    const from = Math.min(s.helpTop, Math.max(0, lines.length - height));
    lines.slice(from, from + height).forEach((line, i) => {
      if (line.segs !== undefined) putSegs(frame, 0, top + i, line.segs, s.size.cols);
      else frame.put(0, top + i, truncate(line.text, s.size.cols), line.style);
    });
  };
