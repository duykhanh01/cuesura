/**
 * Display width, counted in terminal cells by grapheme (FR-035, EC-004): one Vietnamese letter may be two
 * code points in one cell, and a CJK character or an emoji sequence takes two cells.
 */
import stringWidth from 'string-width';
import { uiText, type SafeText } from './safe-text.ts';

const ELLIPSIS = '…';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function displayWidth(text: string): number {
  return stringWidth(text);
}

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** Fits `text` in `cols` cells, ending with `…` when cut. The result never exceeds `cols`. */
export function truncate(text: SafeText, cols: number): SafeText {
  if (cols <= 0) return uiText('');
  if (displayWidth(text) <= cols) return text;
  const room = cols - displayWidth(ELLIPSIS);
  let used = 0;
  let out = '';
  for (const g of graphemes(text)) {
    const w = displayWidth(g);
    if (used + w > room) break;
    out += g;
    used += w;
  }
  return uiText(out + ELLIPSIS);
}

/**
 * Fits `text` in `cols` cells by cutting its middle, for a message whose end says why: a long path goes, the
 * `ENOENT` after it stays. The result never exceeds `cols`.
 */
export function truncateMiddle(text: SafeText, cols: number): SafeText {
  if (displayWidth(text) <= cols) return text;
  if (cols <= displayWidth(ELLIPSIS)) return truncate(text, cols);
  const room = cols - displayWidth(ELLIPSIS);
  const all = graphemes(text);
  const take = (from: readonly string[], limit: number): string[] => {
    const kept: string[] = [];
    let used = 0;
    for (const g of from) {
      const w = displayWidth(g);
      if (used + w > limit) break;
      kept.push(g);
      used += w;
    }
    return kept;
  };
  const head = take(all, Math.ceil(room / 2));
  const tail = take(all.toReversed(), room - Math.ceil(room / 2)).reverse();
  return uiText(head.join('') + ELLIPSIS + tail.join(''));
}

/**
 * Breaks `text` into rows of at most `cols` cells, at spaces where it can. A word wider than a row, such as a
 * long path, is split by grapheme so nothing is lost. Line feeds stay row breaks.
 */
export function wrap(text: SafeText, cols: number): SafeText[] {
  if (cols <= 0) return [];
  const rows: string[] = [];
  for (const line of text.split('\n')) {
    let row = '';
    let used = 0;
    const flush = (): void => {
      rows.push(row);
      row = '';
      used = 0;
    };
    for (const word of line.split(' ')) {
      const w = displayWidth(word);
      if (used > 0 && used + 1 + w <= cols) {
        row += ` ${word}`;
        used += 1 + w;
        continue;
      }
      if (used > 0) flush();
      for (const g of graphemes(word)) {
        const gw = displayWidth(g);
        if (used + gw > cols && used > 0) flush();
        row += g;
        used += gw;
      }
    }
    flush();
  }
  return rows as SafeText[];
}

/** Fills with spaces up to `cols` cells; text already wider is left as it is. */
export function padEnd(text: SafeText, cols: number): SafeText {
  return uiText(text + ' '.repeat(Math.max(0, cols - displayWidth(text))));
}
