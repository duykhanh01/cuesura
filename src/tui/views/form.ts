/**
 * What the form screens share: fields laid out as blocks of rows, scrolled so the focused one is whole on
 * screen, and the lines that say what became of a send.
 */
import type { Mutation } from '../client/mutations.ts';
import { uiText, type SafeText } from '../terminal/safe-text.ts';
import type { Frame, Style } from '../terminal/screen.ts';
import { truncate } from '../terminal/width.ts';
import { BAD_STRONG, FOCUS, WARN } from './theme.ts';

/** Column of the labels and where the field boxes start; `reduce.ts` sizes text fields from the same numbers. */
export const LABEL_X = 1;
export const BOX_X = 15;

export type Block = {
  readonly height: number;
  draw(frame: Frame, y: number): void;
};

/** Draws as many whole blocks as fit, starting early enough that the block at `focus` is among them. */
export function drawBlocks(
  frame: Frame,
  top: number,
  height: number,
  blocks: readonly Block[],
  focus: number,
): void {
  let first = 0;
  const used = (from: number, to: number): number =>
    blocks.slice(from, to + 1).reduce((n, b) => n + b.height, 0);
  while (first < focus && used(first, focus) > height) first += 1;
  let y = top;
  for (const b of blocks.slice(first)) {
    if (y + b.height > top + height) break;
    b.draw(frame, y);
    y += b.height;
  }
}

export function putLabel(
  frame: Frame,
  y: number,
  label: string,
  focused: boolean,
  required: boolean,
  boxX = BOX_X,
): void {
  frame.put(
    LABEL_X,
    y,
    uiText(`${focused ? '› ' : '  '}${label}${required ? ' *' : ''}`.slice(0, boxX - 2)),
    focused ? FOCUS : {},
  );
}

/** One row under a field, in the style of an error, when it has one. */
export function putError(frame: Frame, y: number, text: SafeText | undefined, cols: number): void {
  if (text !== undefined) frame.put(BOX_X, y, truncate(text, cols - BOX_X - 1), BAD_STRONG);
}

/** What is known of a write this screen sent and has no answer to yet; `null` once it has one. */
export function sendingLine(m: Mutation | undefined): { text: SafeText; style: Style } | null {
  if (m === undefined) return null;
  const id = `request ${m.requestId}`;
  switch (m.state) {
    case 'sending':
      return { text: uiText(`Sending (${id})…`), style: { bold: true } };
    case 'unknown':
      return { text: uiText(`Result unknown - checking (${id})`), style: WARN };
    case 'unresolved':
      return {
        text: uiText(
          `Result unknown - could not be confirmed (${id}). Press Ctrl-S to check again.`,
        ),
        style: WARN,
      };
    default:
      return null;
  }
}

export type Line = { readonly text: SafeText; readonly style: Style };
