/**
 * Styled pieces of one line. A screen builds a line from segments so a label, a value and a mark can each
 * carry their own style, and both drawing and wrapping keep every piece `SafeText`.
 */
import { uiText, type SafeText } from '../terminal/safe-text.ts';
import type { Color, Frame, Style } from '../terminal/screen.ts';
import { displayWidth, truncate, wrap } from '../terminal/width.ts';

export type Seg = { readonly text: SafeText; readonly style?: Style };

export const seg = (text: SafeText, style?: Style): Seg =>
  style === undefined ? { text } : { text, style };

/** Fixed text of the interface. */
export const ui = (text: string, style?: Style): Seg => seg(uiText(text), style);

export const DIM: Style = { dim: true };
export const BOLD: Style = { bold: true };
export const fg = (color: Color | undefined, extra: Style = {}): Style =>
  color === undefined ? extra : { ...extra, fg: color };

export function segsWidth(segs: readonly Seg[]): number {
  return segs.reduce((n, s) => n + displayWidth(s.text), 0);
}

export function plain(segs: readonly Seg[]): SafeText {
  return uiText(segs.map((s) => s.text).join(''));
}

/** Cuts segments to `cols` cells; the segment that does not fit ends with `…`. */
export function clip(segs: readonly Seg[], cols: number): Seg[] {
  const out: Seg[] = [];
  let used = 0;
  for (const s of segs) {
    const room = cols - used;
    if (room <= 0) break;
    const w = displayWidth(s.text);
    if (w <= room) {
      out.push(s);
      used += w;
      continue;
    }
    out.push(seg(truncate(s.text, room), s.style));
    break;
  }
  return out;
}

/** Draws segments from `x`, never past `cols` cells; returns the column after the last one drawn. */
export function putSegs(
  frame: Frame,
  x: number,
  y: number,
  segs: readonly Seg[],
  cols: number,
  base: Style = {},
): number {
  let at = x;
  for (const s of clip(segs, cols)) {
    // A no-break space only holds words together while wrapping; the terminal gets a plain one.
    frame.put(at, y, uiText(s.text.replaceAll('\u00a0', ' ')), {
      ...base,
      ...s.style,
    });
    at += displayWidth(s.text);
  }
  return at;
}

/**
 * Breaks segments into rows of `cols` cells at spaces, keeping each piece's style; a line feed always
 * breaks. Rows after the first start with `indent` spaces, so a value wraps under itself, not its label.
 */
export function wrapSegs(segs: readonly Seg[], cols: number, indent = 0): Seg[][] {
  const lead = indent > 0 && indent < cols ? indent : 0;
  const rows: Seg[][] = [];
  let row: Seg[] = [];
  let used = 0;
  const newRow = (): void => {
    rows.push(row);
    row = lead > 0 ? [ui(' '.repeat(lead))] : [];
    used = lead;
  };
  const push = (text: string, style: Style | undefined): void => {
    if (text === '') return;
    // A no-break space only holds words together while wrapping; the terminal gets a plain one.
    row.push(seg(uiText(text.replaceAll('\u00a0', ' ')), style));
    used += displayWidth(text);
  };
  for (const s of segs) {
    s.text.split('\n').forEach((line, li) => {
      if (li > 0) newRow();
      for (const word of line.split(/(?<= )/)) {
        const w = displayWidth(word);
        if (used + w <= cols) {
          push(word, s.style);
          continue;
        }
        const bare = word.trimEnd();
        if (used + displayWidth(bare) <= cols) {
          push(bare, s.style);
          newRow();
          continue;
        }
        if (used > lead) newRow();
        const pieces = wrap(uiText(bare), cols - used);
        pieces.forEach((p, i) => {
          push(p, s.style);
          if (i < pieces.length - 1) newRow();
        });
        if (bare !== word && used < cols) push(' ', s.style);
      }
    });
  }
  rows.push(row);
  return rows;
}

/** A section title followed by a faint rule to the edge. */
export function ruleHeading(title: string, cols: number, style: Style = BOLD): Seg[] {
  const room = cols - displayWidth(title) - 1;
  return room > 0 ? [ui(title, style), ui(` ${'─'.repeat(room)}`, DIM)] : [ui(title, style)];
}
