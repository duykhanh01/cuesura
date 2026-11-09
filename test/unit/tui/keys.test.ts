import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { KeyDecoder, type Key } from '../../../src/tui/terminal/keys.ts';

const key = (name: string): Key => ({ kind: 'key', name }) as Key;
const char = (text: string): Key => ({ kind: 'char', text });

function decode(input: string): Key[] {
  return new KeyDecoder().feed(input);
}

describe('KeyDecoder', () => {
  it('reads leaving the window as nothing, not as text or Esc', () => {
    expect(decode('\x1b[O')).toEqual([]);
  });

  it.each([
    ['\x1b[A', 'up'],
    ['\x1b[B', 'down'],
    ['\x1b[C', 'right'],
    ['\x1b[D', 'left'],
    ['\x1bOA', 'up'],
    ['\x1bOB', 'down'],
    ['\x1b[5~', 'pageup'],
    ['\x1b[6~', 'pagedown'],
    ['\x1b[H', 'home'],
    ['\x1b[F', 'end'],
    ['\x1b[1~', 'home'],
    ['\x1b[4~', 'end'],
    ['\x1b[3~', 'delete'],
    ['\x1b[Z', 'shift_tab'],
    ['\x1b[I', 'focus_in'],
    ['\x0c', 'ctrl_l'],
    ['\x1b[1;2A', 'up'],
    ['\r', 'enter'],
    ['\n', 'enter'],
    ['\t', 'tab'],
    ['\x7f', 'backspace'],
    ['\x03', 'ctrl_c'],
    ['\x13', 'ctrl_s'],
  ])('reads %j as %s', (input, name) => {
    expect(decode(input)).toEqual([key(name)]);
  });

  it('reads printable text, multi-byte included', () => {
    expect(decode('aế日')).toEqual([char('a'), char('ế'), char('日')]);
  });

  it('a UTF-8 character split across chunks arrives whole', () => {
    const d = new KeyDecoder();
    const bytes = Buffer.from('日');
    expect(d.feed(bytes.subarray(0, 1))).toEqual([]);
    expect(d.feed(bytes.subarray(1))).toEqual([char('日')]);
  });

  it('a sequence split across chunks is one key', () => {
    const d = new KeyDecoder();
    expect(d.feed('\x1b')).toEqual([]);
    expect(d.feed('[')).toEqual([]);
    expect(d.feed('A')).toEqual([key('up')]);
  });

  it('reads Ctrl-O as a key, not as text', () => {
    expect(new KeyDecoder().feed('\x0f')).toEqual([key('ctrl_o')]);
  });

  it('Esc alone waits, and is Esc once flushed', () => {
    const d = new KeyDecoder();
    expect(d.feed('\x1b')).toEqual([]);
    expect(d.pending()).toBe(true);
    expect(d.flush()).toEqual([key('esc')]);
    expect(d.pending()).toBe(false);
    expect(d.flush()).toEqual([]);
  });

  it('an unfinished sequence flushed gives Esc and then reads the rest', () => {
    const d = new KeyDecoder();
    d.feed('\x1b[');
    expect(d.flush()).toEqual([key('esc'), char('[')]);
  });

  it('Esc before another key stands alone', () => {
    expect(decode('\x1bq')).toEqual([key('esc'), char('q')]);
    expect(decode('\x1b\x1b[A')).toEqual([key('esc'), key('up')]);
  });

  it('ignores unknown sequences and control characters', () => {
    expect(decode('\x1b[99~a\x1b[Xb\x01c')).toEqual([char('a'), char('b'), char('c')]);
  });

  it('drops a sequence that never ends, so it cannot block input forever', () => {
    const d = new KeyDecoder();
    const keys = d.feed(`\x1b[${'1'.repeat(64)}`);
    expect(d.pending()).toBe(false);
    expect(keys.filter((k) => k.kind === 'char')).toHaveLength(65);
  });

  it('a bracketed paste is one block, with line feeds and escapes inert', () => {
    expect(decode('\x1b[200~line1\nline2\r\x1b[Aq\x1b[201~')).toEqual([
      { kind: 'paste', text: 'line1\nline2\r\x1b[Aq' },
    ]);
  });

  it('a paste split anywhere arrives the same, end marker included', () => {
    const text = '\x1b[200~abc\ndef\x1b[201~';
    for (let i = 1; i < text.length; i++) {
      const d = new KeyDecoder();
      const keys = [...d.feed(text.slice(0, i)), ...d.feed(text.slice(i))];
      expect(keys, `split at ${i}`).toEqual([{ kind: 'paste', text: 'abc\ndef' }]);
    }
  });

  it('a paste with no end is handed over in bounded parts', () => {
    const d = new KeyDecoder();
    const keys = d.feed(`\x1b[200~${'x'.repeat(1024 * 1024 + 100)}`);
    expect(keys).toHaveLength(1);
    expect(d.pending()).toBe(false);
  });

  it('keys after a paste are read as keys again', () => {
    expect(decode('\x1b[200~a\x1b[201~q')).toEqual([{ kind: 'paste', text: 'a' }, char('q')]);
  });

  it('never throws, and gives the same keys however the input is split', () => {
    const bytes = fc.uint8Array({ maxLength: 200 });
    fc.assert(
      fc.property(bytes, fc.nat(200), (input, at) => {
        const whole = new KeyDecoder();
        const all = [...whole.feed(Buffer.from(input)), ...whole.flush()];
        const cut = new KeyDecoder();
        const split = Math.min(at, input.length);
        const parts = [
          ...cut.feed(Buffer.from(input.subarray(0, split))),
          ...cut.feed(Buffer.from(input.subarray(split))),
          ...cut.flush(),
        ];
        expect(parts).toEqual(all);
      }),
      { numRuns: 500 },
    );
  });
});
