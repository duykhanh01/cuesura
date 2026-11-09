/**
 * Text fields of forms and dialogs (FR-034, contracts/tui.md "Phím"). Pure: a key gives a new field and,
 * for the few keys a field does not keep, what the user asked for. Every printable key and every paste is
 * text; only Tab, Shift-Tab, Ctrl-S and Esc leave the text, and a line break never submits anything.
 */
import { fieldCommand, type FieldCommand } from '../model/keymap.ts';
import type { Key } from '../terminal/keys.ts';
import { joinSafe, sanitize, uiText, type SafeText } from '../terminal/safe-text.ts';
import type { Frame } from '../terminal/screen.ts';
import { displayWidth, graphemes } from '../terminal/width.ts';

export type FieldKind = 'line' | 'multi';

export type TextField = {
  readonly kind: FieldKind;
  readonly label: string;
  readonly text: string;
  /** In graphemes from the start, so a cursor never sits inside a character. */
  readonly cursor: number;
  /** In graphemes; what goes past it is not taken. */
  readonly max: number | null;
};

export function textField(
  kind: FieldKind,
  label: string,
  text = '',
  max: number | null = null,
): TextField {
  return { kind, label, text, cursor: graphemes(text).length, max };
}

/** What a key that is not text asks of the form around the field. Submitting is only ever Ctrl-S. */
export type FieldSignal = Extract<FieldCommand, 'next' | 'previous' | 'submit' | 'leave'>;

export type Edited = {
  readonly field: TextField;
  readonly signal: FieldSignal | null;
  /** False: not a key of the field, for the screen around it (Ctrl-C, paging). */
  readonly handled: boolean;
};

/**
 * A paste is text as it came, but a one-line field cannot hold a line break; the one a copied line ends
 * with is no part of it.
 */
function pasted(kind: FieldKind, text: string): string {
  const lines = text.replace(/\r\n?/g, '\n');
  return kind === 'multi' ? lines : lines.replace(/\n+$/, '').replace(/[\n\t]+/g, ' ');
}

function insert(f: TextField, text: string): TextField {
  const gs = graphemes(f.text);
  const head = gs.slice(0, f.cursor).join('');
  const tail = gs.slice(f.cursor).join('');
  const add = graphemes(text);
  // The limit counts the joined text: a mark or skin tone typed after the last character takes no room.
  const fits = (n: number): boolean =>
    f.max === null || graphemes(head + add.slice(0, n).join('') + tail).length <= f.max;
  let taken = add.length;
  if (!fits(taken)) {
    // Taking more never makes the joined text shorter, so the most that fits is found by halving: one
    // segmentation per grapheme dropped would stall a large paste for seconds.
    let low = 0;
    let high = taken - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid;
      else high = mid - 1;
    }
    taken = low;
  }
  if (taken === 0) return f;
  const before = head + add.slice(0, taken).join('');
  const joined = before + tail;
  // What was typed can join the character before it into one grapheme (a skin tone, a combining mark,
  // which the decoder gives as keys of their own), so the cursor is counted again in the joined text.
  let cursor = 0;
  let at = 0;
  for (const g of graphemes(joined)) {
    if (at >= before.length) break;
    at += g.length;
    cursor += 1;
  }
  return { ...f, text: joined, cursor };
}

function remove(f: TextField, at: number): TextField {
  const gs = graphemes(f.text);
  if (at < 0 || at >= gs.length) return f;
  gs.splice(at, 1);
  return { ...f, text: gs.join(''), cursor: Math.min(f.cursor, at) };
}

/** Start of each line, in graphemes, and where the cursor is among them. */
function lineOf(f: TextField): {
  starts: number[];
  ends: number[];
  line: number;
} {
  const gs = graphemes(f.text);
  const starts = [0];
  const ends: number[] = [];
  gs.forEach((g, i) => {
    if (g === '\n') {
      ends.push(i);
      starts.push(i + 1);
    }
  });
  ends.push(gs.length);
  let line = 0;
  while (line + 1 < starts.length && (starts[line + 1] as number) <= f.cursor) line += 1;
  return { starts, ends, line };
}

/** The row above or below as the field shows it, at the same display column or the nearest left of it. */
function moveLine(f: TextField, step: number, width: number): TextField {
  const { at } = layout(f.text, width, f.cursor);
  const from = at[f.cursor];
  if (from === undefined) return f;
  let best: number | null = null;
  at.forEach((p, i) => {
    if (p.row !== from.row + step) return;
    if (best === null || p.col <= from.col) best = i;
  });
  return best === null ? f : { ...f, cursor: best };
}

/** `width`: the cells the field is drawn in, so ↑ and ↓ follow its wrapped rows. */
export function editField(f: TextField, key: Key, width = Number.POSITIVE_INFINITY): Edited {
  const kept = (field: TextField): Edited => ({
    field,
    signal: null,
    handled: true,
  });
  if (key.kind === 'char') return kept(insert(f, key.text));
  if (key.kind === 'paste') return kept(insert(f, pasted(f.kind, key.text)));
  const command = fieldCommand(key);
  const length = graphemes(f.text).length;
  const { starts, ends, line } = lineOf(f);
  switch (command) {
    case 'next':
    case 'previous':
    case 'submit':
    case 'leave':
      return { field: f, signal: command, handled: true };
    case 'enter':
      return f.kind === 'multi'
        ? kept(insert(f, '\n'))
        : { field: f, signal: 'next', handled: true };
    case 'delete_back':
      return kept(remove(f, f.cursor - 1));
    case 'delete_forward':
      return kept(remove(f, f.cursor));
    case 'left':
      return kept({ ...f, cursor: Math.max(0, f.cursor - 1) });
    case 'right':
      return kept({ ...f, cursor: Math.min(length, f.cursor + 1) });
    case 'line_start':
      return kept({ ...f, cursor: starts[line] as number });
    case 'line_end':
      return kept({ ...f, cursor: ends[line] as number });
    case 'line_up':
    case 'line_down':
      return f.kind === 'multi'
        ? kept(moveLine(f, command === 'line_up' ? -1 : 1, width))
        : { field: f, signal: null, handled: false };
    case null:
      return { field: f, signal: null, handled: false };
  }
}

export type Form = {
  readonly fields: readonly TextField[];
  readonly focus: number;
};

export type FormOutcome = 'submit' | 'leave';

/** Tab and Shift-Tab go round the fields; Enter of a one-line field goes on and never submits. */
export function editForm(
  form: Form,
  key: Key,
  width?: number,
): { form: Form; outcome: FormOutcome | null; handled: boolean } {
  const field = form.fields[form.focus];
  if (field === undefined) return { form, outcome: null, handled: false };
  const r = editField(field, key, width);
  const count = form.fields.length;
  const fields = form.fields.map((f, i) => (i === form.focus ? r.field : f));
  const at = (focus: number) => ({
    form: { fields, focus: (focus + count) % count },
    outcome: null,
    handled: true,
  });
  switch (r.signal) {
    case 'next':
      return at(form.focus + 1);
    case 'previous':
      return at(form.focus - 1);
    case 'submit':
    case 'leave':
      return { form, outcome: r.signal, handled: true };
    case null:
      return {
        form: { fields, focus: form.focus },
        outcome: null,
        handled: r.handled,
      };
  }
}

type Cell = { readonly text: SafeText; readonly width: number };

type Position = { readonly row: number; readonly col: number };

/**
 * The rows of a field `width` cells wide, broken at line feeds and where a row is full, and where each cursor
 * position `0..length` stands among them. Drawing and ↑/↓ both read it, so the cursor moves as it is shown.
 */
function layout(text: string, width: number, cursor: number) {
  const rows: Cell[][] = [[]];
  const at: Position[] = [];
  let used = 0;
  const newRow = (): void => {
    rows.push([]);
    used = 0;
  };
  // Before a line feed or at the end, a full row has no cell left: the cursor there takes a row of its own.
  // Elsewhere no such row is drawn, and the position counts as past the end of the full row.
  const place = (i: number): void => {
    if (used >= width && used > 0 && i === cursor) newRow();
    at.push({ row: rows.length - 1, col: used });
  };
  for (const [i, g] of graphemes(text).entries()) {
    if (g === '\n') {
      place(i);
      newRow();
      continue;
    }
    const cell = sanitize(g === '\t' ? ' ' : g);
    const w = displayWidth(cell);
    if (used + w > width && used > 0) newRow();
    at.push({ row: rows.length - 1, col: used });
    (rows.at(-1) as Cell[]).push({ text: cell, width: w });
    used += w;
  }
  place(at.length);
  return { rows, at };
}

function layoutRows(f: TextField, width: number) {
  const { rows, at } = layout(f.text, width, f.cursor);
  // A cursor past the end, as no edit leaves it, stands at the end.
  const cursor = at[Math.min(f.cursor, at.length - 1)] ?? { row: 0, col: 0 };
  return { rows, cursor };
}

export type FieldView = {
  readonly rows: readonly SafeText[];
  /** Where the cursor stands among `rows`. */
  readonly cursor: { readonly row: number; readonly col: number } | null;
};

/**
 * What a field shows in a box `width` × `height`. A one-line field shows the part around the cursor; a
 * multi-line field wraps and scrolls so the row of the cursor stays in view.
 */
export function fieldRows(f: TextField, width: number, height: number): FieldView {
  if (width <= 0 || height <= 0) return { rows: [], cursor: null };
  if (f.kind === 'line') {
    const cells = graphemes(f.text).map((g) => {
      const text = sanitize(g);
      return { text, width: displayWidth(text) };
    });
    // Room for the cursor after the last character.
    let first = 0;
    let used = cells.slice(0, f.cursor).reduce((n, c) => n + c.width, 0);
    while (used >= width && first < f.cursor) {
      used -= (cells[first] as Cell).width;
      first += 1;
    }
    let row = '';
    let w = 0;
    for (const c of cells.slice(first)) {
      if (w + c.width > width) break;
      row += c.text;
      w += c.width;
    }
    return {
      rows: [uiText(row)],
      cursor: { row: 0, col: Math.min(used, width - 1) },
    };
  }
  const { rows, cursor } = layoutRows(f, width);
  const top = Math.max(0, Math.min(cursor.row - height + 1, rows.length - height));
  const shown = rows.slice(top, top + height).map((r) => uiText(r.map((c) => c.text).join('')));
  // A character wider than the box can still push the cursor past it; it never leaves the box.
  return {
    rows: shown,
    cursor: { row: cursor.row - top, col: Math.min(cursor.col, width - 1) },
  };
}

export type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** Draws `f` in `box`; the terminal cursor stays hidden, so a focused field marks its cursor cell itself. */
export function drawField(frame: Frame, box: Box, f: TextField, focused: boolean): void {
  const view = fieldRows(f, box.width, box.height);
  view.rows.forEach((row, i) => {
    let col = 0;
    for (const { text, width } of boxCells(row, box.width)) {
      frame.put(box.x + col, box.y + i, text);
      col += width;
    }
  });
  if (!focused || view.cursor === null) return;
  const row = view.rows[view.cursor.row] ?? uiText('');
  // The character under the cursor, or a space after the end.
  let col = 0;
  let under: SafeText = uiText(' ');
  for (const cell of boxCells(row, box.width)) {
    if (col === view.cursor.col) {
      under = cell.text;
      break;
    }
    col += cell.width;
  }
  frame.put(box.x + view.cursor.col, box.y + view.cursor.row, under, {
    inverse: true,
  });
}

/**
 * The cells of `row` that fit `width`, each put on its own. A mark with no character before it in the row
 * would join the cell left of the box, so it is not drawn; a character wider than what is left of the box
 * shows as a space, as at the edge of the screen.
 */
function boxCells(row: SafeText, width: number): Cell[] {
  const cells: Cell[] = [];
  let used = 0;
  // Pieces of a safe text are safe.
  for (const g of graphemes(row) as SafeText[]) {
    const w = displayWidth(g);
    if (w === 0) {
      const last = cells.at(-1);
      if (last !== undefined) cells[cells.length - 1] = { ...last, text: joinSafe([last.text, g]) };
      continue;
    }
    if (used + w > width) {
      if (used < width) cells.push({ text: uiText(' '), width: 1 });
      break;
    }
    cells.push({ text: g, width: w });
    used += w;
  }
  return cells;
}

/** A paste into a field that keeps one line, for a field not built from `TextField`. */
export const oneLine = (text: string): string => pasted('line', text);
