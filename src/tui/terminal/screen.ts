/**
 * A cell buffer and its diff (R-01). `put` takes only `SafeText` and is the one place text enters a frame,
 * so nothing unsanitized can reach the terminal. Only rows that changed are written, which keeps a session
 * with a busy log cheap. A wide character takes two cells; a cell it covers holds an empty string.
 */
import type { SafeText } from './safe-text.ts';
import { displayWidth, graphemes } from './width.ts';

export type Color = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'orange' | 'gray';

export type Style = {
  readonly fg?: Color;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly inverse?: boolean;
};

/**
 * Foreground codes for a 16-colour terminal. Orange and gray have no colour of their own there and take the
 * nearest one: yellow, and bright black.
 */
const FG: Readonly<Record<Color, string>> = {
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  orange: '33',
  gray: '90',
};

/** Where the terminal has 256 colours: a muted orange (173), as 208 glares on dark, and a dark gray (238). */
const FG_256: Readonly<Partial<Record<Color, string>>> = {
  orange: '38;5;173',
  gray: '38;5;238',
};
const RESET = '\x1b[0m';

type Cell = { ch: string; sgr: string };

/** Terminals that take no colour by name: the VT family and the `-m`, `-mono` variants. */
const MONOCHROME_TERM = /^vt\d+|-(m|mono)$/;

/** `NO_COLOR` set to anything but empty turns colour off (https://no-color.org), as does a monochrome `TERM`. */
export function colorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env['NO_COLOR'];
  if (v !== undefined && v !== '') return false;
  return !MONOCHROME_TERM.test(env['TERM'] ?? '');
}

/** `TERM` that names 256 colours, or a `COLORTERM` that promises 24-bit colour, which covers them. */
export function has256Colors(env: NodeJS.ProcessEnv = process.env): boolean {
  const colorterm = env['COLORTERM'] ?? '';
  return /256color/.test(env['TERM'] ?? '') || colorterm === 'truecolor' || colorterm === '24bit';
}

function sgrOf(style: Style, color: boolean, wide: boolean): string {
  const codes: string[] = [];
  if (style.bold === true) codes.push('1');
  if (style.dim === true) codes.push('2');
  if (style.inverse === true) codes.push('7');
  if (color && style.fg !== undefined)
    codes.push((wide ? FG_256[style.fg] : undefined) ?? FG[style.fg]);
  return codes.length === 0 ? '' : `\x1b[${codes.join(';')}m`;
}

export class Frame {
  readonly cols: number;
  readonly rows: number;
  readonly #color: boolean;
  readonly #wide: boolean;
  readonly #cells: Cell[][];

  constructor(cols: number, rows: number, opts: { color?: boolean; colors256?: boolean } = {}) {
    this.cols = Math.max(0, cols);
    this.rows = Math.max(0, rows);
    this.#color = opts.color ?? true;
    this.#wide = opts.colors256 ?? false;
    this.#cells = Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => ({ ch: ' ', sgr: '' })),
    );
  }

  /** Writes from (x, y), clipped at the edge; a wide character that does not fit leaves a space. */
  put(x: number, y: number, text: SafeText, style: Style = {}): void {
    const row = this.#cells[y];
    if (row === undefined) return;
    const sgr = sgrOf(style, this.#color, this.#wide);
    let at = x;
    for (const g of graphemes(text)) {
      const w = displayWidth(g);
      if (w === 0) {
        // Nothing to place on its own: it belongs to the character before it.
        const before = row[at - 1];
        if (before !== undefined && at > 0) before.ch += g;
        continue;
      }
      if (at >= this.cols) return;
      if (at + w > this.cols) {
        this.#set(row, at, ' ', sgr);
        return;
      }
      if (at >= 0) {
        this.#set(row, at, g, sgr);
        for (let i = 1; i < w; i++) this.#set(row, at + i, '', sgr);
      }
      at += w;
    }
  }

  #set(row: Cell[], at: number, ch: string, sgr: string): void {
    const cell = row[at];
    if (cell === undefined) return;
    // Overwriting half of a wide character must not leave the other half behind.
    if (cell.ch === '' && ch !== '') {
      const left = row[at - 1];
      if (left !== undefined) left.ch = ' ';
    }
    const right = row[at + 1];
    if (right !== undefined && right.ch === '' && ch !== '') right.ch = ' ';
    cell.ch = ch;
    cell.sgr = sgr;
  }

  /** The row as bytes for the terminal, without its trailing plain spaces. */
  rowBytes(y: number): string {
    const row = this.#cells[y] ?? [];
    let end = row.length;
    while (end > 0) {
      const c = row[end - 1] as Cell;
      if (c.ch !== ' ' || c.sgr !== '') break;
      end -= 1;
    }
    let out = '';
    let current = '';
    for (let x = 0; x < end; x++) {
      const c = row[x] as Cell;
      if (c.sgr !== current) {
        out += RESET + c.sgr;
        current = c.sgr;
      }
      out += c.ch;
    }
    return current === '' ? out : out + RESET;
  }
}

/**
 * The bytes that turn the screen showing `prev` into `next`; `prev` null redraws everything, which also
 * follows a resize or a resume. The row is cleared before writing, not after: once a line fills the last
 * column the cursor sits on it, and clearing to the end of the line would erase that cell.
 */
export function diffFrames(prev: Frame | null, next: Frame): string {
  const full = prev === null || prev.cols !== next.cols || prev.rows !== next.rows;
  let out = '';
  for (let y = 0; y < next.rows; y++) {
    const bytes = next.rowBytes(y);
    if (!full && prev.rowBytes(y) === bytes) continue;
    out += `\x1b[${y + 1};1H\x1b[2K${bytes}`;
  }
  return out;
}
