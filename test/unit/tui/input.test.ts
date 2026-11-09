import { describe, expect, it } from 'vitest';
import { KeyDecoder, type Key, type KeyName } from '../../../src/tui/terminal/keys.ts';
import { uiText } from '../../../src/tui/terminal/safe-text.ts';
import { Frame } from '../../../src/tui/terminal/screen.ts';
import { displayWidth } from '../../../src/tui/terminal/width.ts';
import { FIELD_KEYS, fieldCommand } from '../../../src/tui/model/keymap.ts';
import {
  drawField,
  editField,
  editForm,
  fieldRows,
  textField,
  type Form,
  type TextField,
} from '../../../src/tui/views/input.ts';

// T053: the text field of every form and dialog (FR-034, contracts/tui.md "Phím").
const char = (text: string): Key => ({ kind: 'char', text });
const named = (name: KeyName): Key => ({ kind: 'key', name });
const paste = (text: string): Key => ({ kind: 'paste', text });

function typed(f: TextField, ...keys: (Key | string)[]): TextField {
  for (const k of keys) {
    const key = typeof k === 'string' ? char(k) : k;
    f = editField(f, key).field;
  }
  return f;
}

describe('every printable key is text', () => {
  it('shortcut letters, ? and digits go into the field and act as nothing', () => {
    for (const kind of ['line', 'multi'] as const) {
      let f = textField(kind, 'Title');
      for (const c of [...'qa?fRClFtjkgG 1']) {
        const r = editField(f, char(c));
        expect(r.signal).toBeNull();
        expect(r.handled).toBe(true);
        f = r.field;
      }
      expect(f.text).toBe('qa?fRClFtjkgG 1');
    }
  });

  it('takes Vietnamese, CJK and emoji whole', () => {
    const f = typed(textField('line', 'Title'), 'Đ', 'ư', 'ờ', 'n', 'g', '漢', '👍🏽');
    expect(f.text).toBe('Đường漢👍🏽');
    // Backspace removes the last grapheme, not half of it.
    expect(typed(f, named('backspace')).text).toBe('Đường漢');
  });

  it('moves and edits inside the text', () => {
    const f = typed(
      textField('line', 'Title'),
      'a',
      'c',
      named('left'),
      'b',
      named('home'),
      '>',
      named('end'),
      '<',
      named('left'),
      named('delete'),
    );
    expect(f.text).toBe('>abc');
  });

  it('keeps a limit, when there is one', () => {
    const f = typed(textField('line', 'Reason', '', 3), 'a', 'b', 'c', 'd');
    expect(f.text).toBe('abc');
    expect(editField(f, paste('xyz')).field.text).toBe('abc');
  });
});

describe('keys as the terminal sends them', () => {
  // The decoder gives one key per code point, so a grapheme can come as several keys.
  const fed = (f: TextField, bytes: string): TextField => {
    for (const key of new KeyDecoder().feed(bytes)) f = editField(f, key).field;
    return f;
  };

  it('a skin tone joins the emoji before it, and Backspace removes both', () => {
    const f = fed(textField('line', 'Title'), 'a👍🏽');
    expect(f.text).toBe('a👍🏽');
    expect(f.cursor).toBe(2);
    expect(fed(f, '\x7f').text).toBe('a');
    expect(fed(f, '\x7f\x7f').text).toBe('');
  });

  it('a combining mark joins the letter before it, also inside the text', () => {
    const f = fed(textField('line', 'Title'), 'ab\x1b[De\u0301');
    expect(f.text).toBe('ae\u0301b');
    expect(f.cursor).toBe(2);
    expect(fed(f, 'X').text).toBe('ae\u0301Xb');
    expect(fed(f, '\x7f').text).toBe('ab');
  });

  it('a limit counts the joined text, typed or pasted alike', () => {
    const typedTone = fed(textField('line', 'Title', '', 1), '👍🏽');
    const pastedTone = editField(textField('line', 'Title', '', 1), paste('👍🏽'));
    expect(typedTone.text).toBe('👍🏽');
    expect(pastedTone.field.text).toBe('👍🏽');
    expect(fed(textField('line', 'Title', '', 1), 'e\u0301').text).toBe('e\u0301');
    expect(fed(typedTone, 'x').text).toBe('👍🏽');
  });
});

describe('paste', () => {
  it('goes in as one block; its line breaks never act as Enter or Ctrl-S', () => {
    const r = editField(textField('multi', 'Description'), paste('one\r\ntwo\rthree\n'));
    expect(r.signal).toBeNull();
    expect(r.field.text).toBe('one\ntwo\nthree\n');
  });

  it('in a one-line field becomes one line', () => {
    const r = editField(textField('line', 'Title'), paste('one\ntwo\r\n\tthree'));
    expect(r.signal).toBeNull();
    expect(r.field.text).toBe('one two three');
  });

  it('lands where the cursor is', () => {
    const f = typed(textField('line', 'Title'), 'a', 'b', named('left'));
    expect(editField(f, paste('XY')).field.text).toBe('aXYb');
  });

  it('a large paste past the limit is cut at once, not one character at a time', () => {
    const f = editField(textField('multi', 'Reason', 'ab', 2000), named('left')).field;
    const started = performance.now();
    const r = editField(f, paste('x'.repeat(20000) + '👍🏽'));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(r.field.text).toBe(`a${'x'.repeat(1998)}b`);
    expect(r.field.cursor).toBe(1999);
  });
});

describe('the keys a field gives back', () => {
  it('Tab, Shift-Tab, Ctrl-S and Esc leave the text alone and say what was asked', () => {
    for (const kind of ['line', 'multi'] as const) {
      const f = typed(textField(kind, 'Body'), 'x');
      expect(editField(f, named('tab'))).toMatchObject({
        signal: 'next',
        field: f,
      });
      expect(editField(f, named('shift_tab'))).toMatchObject({
        signal: 'previous',
        field: f,
      });
      expect(editField(f, named('ctrl_s'))).toMatchObject({
        signal: 'submit',
        field: f,
      });
      expect(editField(f, named('esc'))).toMatchObject({
        signal: 'leave',
        field: f,
      });
    }
  });

  it('Enter is a new line in a multi-line field and the next field in a one-line field', () => {
    const multi = editField(typed(textField('multi', 'Body'), 'a'), named('enter'));
    expect(multi.signal).toBeNull();
    expect(multi.field.text).toBe('a\n');
    const line = editField(typed(textField('line', 'Title'), 'a'), named('enter'));
    expect(line.signal).toBe('next');
    expect(line.field.text).toBe('a');
  });

  it('Ctrl-C and paging are not the field’s keys', () => {
    const f = textField('multi', 'Body');
    for (const name of ['ctrl_c', 'pageup', 'pagedown'] as const)
      expect(editField(f, named(name)).handled).toBe(false);
  });

  it('↑ and ↓ move between lines of a multi-line field', () => {
    const f = typed(textField('multi', 'Body'), 'a', 'b', 'c', named('enter'), 'd');
    const up = typed(f, named('up'), 'X');
    expect(up.text).toBe('aXbc\nd');
    const down = typed(up, named('down'), 'Y');
    expect(down.text).toBe('aXbc\ndY');
  });

  it('↑ and ↓ keep the display column, not the count of characters', () => {
    const f = { ...textField('multi', 'Body', '漢abc\n12345'), cursor: 1 };
    const down = editField(f, named('down'), 20).field;
    expect(down.cursor).toBe(7);
    expect(editField(down, char('X'), 20).field.text).toBe('漢abc\n12X345');
    expect(editField(down, named('up'), 20).field.cursor).toBe(1);
    // Halfway through a wide character is left of it.
    const one = { ...textField('multi', 'Body', '1x\n漢漢'), cursor: 1 };
    expect(editField(one, named('down'), 20).field.cursor).toBe(3);
  });

  it('↑ and ↓ move between the rows a long line wraps into', () => {
    // Four cells wide: 'abcd' | 'efgh' | 'ij'.
    const f = { ...textField('multi', 'Body', 'abcdefghij'), cursor: 1 };
    expect(fieldRows(f, 4, 3).rows).toEqual(['abcd', 'efgh', 'ij']);
    const down = editField(f, named('down'), 4).field;
    expect(down.cursor).toBe(5);
    expect(fieldRows(down, 4, 3).cursor).toEqual({ row: 1, col: 1 });
    const last = editField(down, named('down'), 4).field;
    expect(last.cursor).toBe(9);
    expect(editField(last, named('down'), 4).field.cursor).toBe(9);
    expect(editField(editField(last, named('up'), 4).field, named('up'), 4).field.cursor).toBe(1);
    // Before the line feed of a full row the cursor is drawn on a row of its own; ↑ and ↓ start from there.
    const full = {
      ...textField('multi', 'Body', `${'a'.repeat(80)}\nx`),
      cursor: 80,
    };
    expect(fieldRows(full, 80, 5).cursor).toEqual({ row: 1, col: 0 });
    expect(editField(full, named('up'), 80).field.cursor).toBe(0);
    expect(editField(full, named('down'), 80).field.cursor).toBe(81);
    // Wide characters wrap by width too: '漢漢' | '漢a'.
    const wide = { ...textField('multi', 'Body', '漢漢漢a'), cursor: 4 };
    expect(editField(wide, named('up'), 4).field.cursor).toBe(1);
  });
});

describe('the field keys come from the keymap', () => {
  it('every key the field acts on is declared there, and Help shows it', () => {
    const names: KeyName[] = [
      'enter',
      'backspace',
      'delete',
      'left',
      'right',
      'home',
      'end',
      'up',
      'down',
      'tab',
      'shift_tab',
      'ctrl_s',
      'esc',
    ];
    for (const name of names) expect(fieldCommand(named(name)), name).not.toBeNull();
    const f = textField('multi', 'Body', 'ab');
    for (const name of ['ctrl_c', 'pageup', 'pagedown'] as const) {
      expect(fieldCommand(named(name))).toBeNull();
      expect(editField(f, named(name)).handled).toBe(false);
    }
    expect(FIELD_KEYS.map((k) => k.keys)).toEqual(
      expect.arrayContaining(['Backspace Delete', '← →', 'Home End', '↑ ↓']),
    );
  });
});

describe('a form of fields', () => {
  const form = (): Form => ({
    fields: [
      textField('line', 'Title'),
      textField('multi', 'Description'),
      textField('line', 'Base branch'),
    ],
    focus: 0,
  });

  it('Tab goes forward, Shift-Tab back, round the ends', () => {
    let f = form();
    f = editForm(f, named('tab')).form;
    expect(f.focus).toBe(1);
    f = editForm(f, named('tab')).form;
    f = editForm(f, named('tab')).form;
    expect(f.focus).toBe(0);
    f = editForm(f, named('shift_tab')).form;
    expect(f.focus).toBe(2);
  });

  it('Enter in a one-line field goes to the next field and never submits', () => {
    const r = editForm(form(), named('enter'));
    expect(r.outcome).toBeNull();
    expect(r.form.focus).toBe(1);
    const inMulti = editForm(r.form, named('enter'));
    expect(inMulti.outcome).toBeNull();
    expect(inMulti.form.focus).toBe(1);
    expect(inMulti.form.fields[1]?.text).toBe('\n');
  });

  it('only Ctrl-S submits and Esc leaves; neither changes what was typed', () => {
    const f = editForm(form(), char('t')).form;
    expect(editForm(f, named('ctrl_s'))).toMatchObject({
      outcome: 'submit',
      form: f,
    });
    expect(editForm(f, named('esc'))).toMatchObject({
      outcome: 'leave',
      form: f,
    });
  });

  it('a paste with line breaks never submits a form', () => {
    const r = editForm(form(), paste('a\nb\r\n'));
    expect(r.outcome).toBeNull();
    expect(r.form.fields[0]?.text).toBe('a b');
  });
});

describe('drawing a field', () => {
  it('a one-line field fits its width and keeps the cursor in view', () => {
    const f = typed(textField('line', 'Title'), ...'abcdefghijklmnopqrstuvwxyz');
    const { rows, cursor } = fieldRows(f, 10, 1);
    expect(rows).toHaveLength(1);
    expect(displayWidth(rows[0] ?? '')).toBeLessThanOrEqual(10);
    expect(rows[0]).toContain('z');
    expect(cursor).toEqual({ row: 0, col: displayWidth(rows[0] ?? '') });
  });

  it('measures wide characters by cell, so nothing breaks a column', () => {
    const f = typed(textField('line', 'Title'), ...'漢字漢字漢字漢字');
    const { rows } = fieldRows(f, 9, 1);
    expect(displayWidth(rows[0] ?? '')).toBeLessThanOrEqual(9);
    const multi = typed(textField('multi', 'Body'), ...'漢字漢字漢字');
    for (const row of fieldRows(multi, 5, 5).rows) expect(displayWidth(row)).toBeLessThanOrEqual(5);
  });

  it('a multi-line field wraps, keeps line breaks and scrolls to the cursor', () => {
    const f = typed(
      textField('multi', 'Body'),
      ...'abcdefgh',
      named('enter'),
      ...'1',
      named('enter'),
      ...'2',
      named('enter'),
      ...'3',
    );
    expect(fieldRows(f, 4, 10).rows).toEqual(['abcd', 'efgh', '1', '2', '3']);
    const small = fieldRows(f, 4, 2);
    expect(small.rows).toEqual(['2', '3']);
    expect(small.cursor).toEqual({ row: 1, col: 1 });
  });

  it('the cursor before the line feed of a full row stays inside the box', () => {
    const f: TextField = {
      ...textField('multi', 'Body', 'abcd\nx'),
      cursor: 4,
    };
    const view = fieldRows(f, 4, 5);
    expect(view.cursor?.col).toBeLessThan(4);
    expect(view.rows[0]).toBe('abcd');
    const frame = new Frame(4, 5, { color: false });
    drawField(frame, { x: 0, y: 0, width: 4, height: 5 }, f, true);
    const at = view.cursor?.row ?? -1;
    expect(frame.rowBytes(at)).toContain('\x1b[7m');
    // Typing there goes before the line feed.
    expect(typed(f, 'Z').text).toBe('abcdZ\nx');
  });

  it('a character wider than the box never puts the cursor outside it', () => {
    for (const kind of ['line', 'multi'] as const) {
      const f = textField(kind, 'Title', '漢');
      expect(fieldRows(f, 1, 2).cursor?.col).toBe(0);
    }
  });

  it('a character wider than the box is not drawn past it', () => {
    for (const kind of ['line', 'multi'] as const) {
      const frame = new Frame(4, 1, { color: false });
      frame.put(0, 0, uiText('XXXX'));
      drawField(frame, { x: 1, y: 0, width: 1, height: 1 }, textField(kind, 'T', '漢'), false);
      // The cells either side of the box keep what they held.
      expect(frame.rowBytes(0), kind).toMatch(/^X[ X]XX$/);
    }
  });

  it('a mark at the start of a row does not join the cell left of the box', () => {
    for (const kind of ['line', 'multi'] as const) {
      const frame = new Frame(6, 1, { color: false });
      frame.put(0, 0, uiText('XXXXXX'));
      const f = textField(kind, 'T', '\u0301abc');
      drawField(frame, { x: 1, y: 0, width: 4, height: 1 }, f, false);
      expect(frame.rowBytes(0), kind).toBe('XabcXX');
    }
  });

  it('text from a paste is drawn sanitized', () => {
    const f = editField(textField('line', 'Title'), paste('a\x1b[2Jb‮')).field;
    const row = fieldRows(f, 40, 1).rows[0] ?? '';
    expect(row).not.toContain('\x1b');
    expect(row).not.toContain('‮');
    expect(row).toContain('␛[2Jb');
  });

  it('draws inside its box only, with the cursor marked when focused', () => {
    const frame = new Frame(20, 4, { color: false });
    const f = typed(textField('multi', 'Body'), ...'hello', named('enter'), ...'you');
    drawField(frame, { x: 2, y: 1, width: 6, height: 2 }, f, true);
    expect(frame.rowBytes(1)).toContain('hello');
    expect(frame.rowBytes(2)).toContain('you');
    // Inverse marks the cursor cell, as the terminal cursor stays hidden.
    expect(frame.rowBytes(2)).toContain('\x1b[7m');
    expect(frame.rowBytes(0).trim()).toBe('');
    expect(frame.rowBytes(3).trim()).toBe('');
  });
});
