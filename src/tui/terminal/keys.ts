/**
 * Turns terminal bytes into keys. A chunk may end anywhere, even inside a UTF-8 character or an escape
 * sequence, so unfinished input waits for the next chunk. Esc on its own looks like the start of a
 * sequence until nothing follows it; the caller asks for `flush()` after a short quiet time. Paste arrives
 * as one block of text whose line feeds can never act as Enter (contracts/tui.md).
 */
import { StringDecoder } from 'node:string_decoder';

export type KeyName =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'pageup'
  | 'pagedown'
  | 'home'
  | 'end'
  | 'enter'
  | 'tab'
  | 'shift_tab'
  | 'esc'
  | 'backspace'
  | 'delete'
  | 'ctrl_c'
  | 'ctrl_l'
  | 'ctrl_o'
  | 'ctrl_s'
  | 'focus_in';

export type Key =
  | { readonly kind: 'key'; readonly name: KeyName }
  | { readonly kind: 'char'; readonly text: string }
  | { readonly kind: 'paste'; readonly text: string };

const ESC = '\x1b';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/** Longer than any sequence this reads: what cannot finish is dropped instead of held forever. */
const MAX_SEQUENCE = 32;
const MAX_PASTE = 1024 * 1024;

const CSI_LETTERS: Readonly<Record<string, KeyName>> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  I: 'focus_in',
  Z: 'shift_tab',
};
const CSI_TILDE: Readonly<Record<string, KeyName>> = {
  '1': 'home',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
};
const SINGLE: Readonly<Record<string, KeyName>> = {
  '\r': 'enter',
  '\n': 'enter',
  '\t': 'tab',
  '\x7f': 'backspace',
  '\b': 'backspace',
  '\x03': 'ctrl_c',
  '\x0c': 'ctrl_l',
  '\x0f': 'ctrl_o',
  '\x13': 'ctrl_s',
};

export class KeyDecoder {
  readonly #utf8 = new StringDecoder('utf8');
  #input = '';
  /** Text of a paste in progress; null outside one. */
  #paste: string | null = null;

  feed(data: Buffer | string): Key[] {
    this.#input += typeof data === 'string' ? data : this.#utf8.write(data);
    return this.#drain();
  }

  /** Whether an unfinished sequence waits, so the caller knows to call `flush` after a quiet time. */
  pending(): boolean {
    return this.#paste === null && this.#input.startsWith(ESC);
  }

  /** Nothing followed: what looked like the start of a sequence was the Esc key. */
  flush(): Key[] {
    if (!this.pending()) return [];
    this.#input = this.#input.slice(1);
    return [{ kind: 'key', name: 'esc' }, ...this.#drain()];
  }

  #drain(): Key[] {
    const keys: Key[] = [];
    for (;;) {
      if (this.#paste !== null) {
        if (!this.#readPaste(keys)) return keys;
        continue;
      }
      if (this.#input === '') return keys;
      if (this.#input.startsWith(ESC)) {
        if (!this.#readEscape(keys)) return keys;
        continue;
      }
      const c = String.fromCodePoint(this.#input.codePointAt(0) as number);
      this.#input = this.#input.slice(c.length);
      const name = SINGLE[c];
      if (name !== undefined) keys.push({ kind: 'key', name });
      else if (isPrintable(c)) keys.push({ kind: 'char', text: c });
    }
  }

  /** False when the sequence is not complete yet. */
  #readEscape(keys: Key[]): boolean {
    const s = this.#input;
    if (s.length === 1) return false;
    if (PASTE_START.startsWith(s)) return false;
    if (s.startsWith(PASTE_START)) {
      this.#input = s.slice(PASTE_START.length);
      this.#paste = '';
      return true;
    }
    if (s[1] === 'O') {
      if (s.length < 3) return false;
      const name = CSI_LETTERS[s[2] as string];
      if (name !== undefined) keys.push({ kind: 'key', name });
      this.#input = s.slice(3);
      return true;
    }
    if (s[1] === '[') {
      const end = s.slice(2).search(/[\x40-\x7e]/);
      if (end < 0) {
        if (s.length > MAX_SEQUENCE) this.#input = s.slice(1);
        return s.length > MAX_SEQUENCE;
      }
      const params = s.slice(2, 2 + end);
      const final = s[2 + end] as string;
      this.#input = s.slice(3 + end);
      const name = final === '~' ? CSI_TILDE[params.split(';')[0] as string] : CSI_LETTERS[final];
      if (name !== undefined) keys.push({ kind: 'key', name });
      return true;
    }
    // Esc followed by something else, Alt+key included: the Esc stands alone.
    this.#input = s.slice(1);
    keys.push({ kind: 'key', name: 'esc' });
    return true;
  }

  /** False while the end of the paste has not arrived. */
  #readPaste(keys: Key[]): boolean {
    const end = this.#input.indexOf(PASTE_END);
    if (end >= 0) {
      this.#paste += this.#input.slice(0, end);
      this.#input = this.#input.slice(end + PASTE_END.length);
      keys.push({ kind: 'paste', text: this.#paste as string });
      this.#paste = null;
      return true;
    }
    // Keep what may be the start of the end marker; a paste past the limit is handed over in parts.
    const keep = Math.min(this.#input.length, PASTE_END.length - 1);
    this.#paste += this.#input.slice(0, this.#input.length - keep);
    this.#input = this.#input.slice(this.#input.length - keep);
    if ((this.#paste as string).length > MAX_PASTE) {
      keys.push({ kind: 'paste', text: this.#paste as string });
      this.#paste = '';
    }
    return false;
  }
}

function isPrintable(c: string): boolean {
  const code = c.codePointAt(0) as number;
  return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0);
}
