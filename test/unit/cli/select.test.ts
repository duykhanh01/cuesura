import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  initialSelect,
  renderSelect,
  renderSelectResult,
  runSelect,
  stepSelect,
  type Choice,
  type SelectState,
  type SelectTty,
} from '../../../src/cli/select.ts';
import type { Key } from '../../../src/tui/terminal/keys.ts';

const choices: Choice[] = [
  { id: 'busy', label: 'Busy', description: 'already there', unavailable: 'repo has one' },
  { id: 'a', label: 'Alpha', description: 'first thing', unavailable: null },
  { id: 'b', label: 'Beta', description: 'second thing', unavailable: null },
];

const key = (name: Extract<Key, { kind: 'key' }>['name']): Key => ({ kind: 'key', name });
const char = (text: string): Key => ({ kind: 'char', text });

function press(state: SelectState, ...keys: Key[]): SelectState {
  for (const k of keys) {
    const next = stepSelect(choices, state, k);
    if (next.kind !== 'state') throw new Error(`closed on ${JSON.stringify(k)}`);
    state = next.state;
  }
  return state;
}

describe('checklist', () => {
  it('starts with every available choice checked and the cursor on the first of them', () => {
    const s = initialSelect(choices);
    expect(s.cursor).toBe(1);
    expect([...s.checked]).toEqual(['a', 'b']);
  });

  it('moves over unavailable choices, toggles with space and a, and confirms in list order', () => {
    let s = press(initialSelect(choices), key('up'));
    expect(s.cursor).toBe(1);
    s = press(s, key('down'), char(' '));
    expect([...s.checked]).toEqual(['a']);
    s = press(s, char('a'));
    expect([...s.checked].sort()).toEqual(['a', 'b']);
    s = press(s, char('a'));
    expect(s.checked.size).toBe(0);
    s = press(s, char(' '), char('k'), char(' '));
    expect(stepSelect(choices, s, key('enter'))).toEqual({ kind: 'done', ids: ['a', 'b'] });
    expect(stepSelect(choices, s, key('esc'))).toEqual({ kind: 'cancel' });
    expect(stepSelect(choices, s, key('ctrl_c'))).toEqual({ kind: 'cancel' });
  });

  it('draws each choice with its description under it, and why an unavailable one is off', () => {
    const lines = renderSelect('Pick', choices, initialSelect(choices), false);
    expect(lines).toEqual([
      '? Pick',
      '  ↑/↓ move · space toggle · a all · enter confirm · esc cancel',
      '  ◯ Busy  (repo has one)',
      '    already there',
      '❯ ◉ Alpha',
      '    first thing',
      '  ◉ Beta',
      '    second thing',
    ]);
    expect(renderSelectResult('Pick', choices, ['b'], false)).toBe('✔ Pick Beta');
    expect(renderSelectResult('Pick', choices, null, false)).toBe('✖ Pick cancelled');
  });
});

/** A terminal that records what the list does to it. */
function fakeTty(opts: { failWrites?: number } = {}) {
  const input = new EventEmitter() as EventEmitter & SelectTty['input'];
  const modes: boolean[] = [];
  let raw = false;
  Object.assign(input, {
    get isRaw() {
      return raw;
    },
    setRawMode(on: boolean) {
      raw = on;
      modes.push(on);
      return input;
    },
    resume: () => input,
    pause: () => input,
  });
  let writes = 0;
  let out = '';
  const output = {
    columns: 80,
    write(chunk: string) {
      writes += 1;
      if (opts.failWrites !== undefined && writes > opts.failWrites) throw new Error('EIO');
      out += chunk;
      return true;
    },
  } as SelectTty['output'];
  const raised: string[] = [];
  const tty: SelectTty = { input, output, raise: (s) => raised.push(s) };
  return { tty, input, modes, raised, out: () => out, raw: () => raw };
}

describe('checklist on a terminal', () => {
  const cursorShown = (out: string) => out.lastIndexOf('\x1b[?25h') > out.lastIndexOf('\x1b[?25l');

  it('Enter resolves with the checked ids and gives the terminal back', async () => {
    const t = fakeTty();
    const done = runSelect('Pick', choices, t.tty);
    t.input.emit('data', Buffer.from(' '));
    t.input.emit('data', Buffer.from('\r'));
    expect(await done).toEqual(['b']);
    expect(t.raw()).toBe(false);
    expect(cursorShown(t.out())).toBe(true);
  });

  it('a signal restores the terminal first, then is delivered again; no listener is left behind', () => {
    const before = process.listenerCount('SIGHUP');
    const t = fakeTty();
    void runSelect('Pick', choices, t.tty);
    expect(t.raw()).toBe(true);
    process.emit('SIGHUP', 'SIGHUP');
    expect(t.raw()).toBe(false);
    expect(cursorShown(t.out())).toBe(true);
    expect(t.raised).toEqual(['SIGHUP']);
    expect(process.listenerCount('SIGHUP')).toBe(before);
  });

  it('an error while drawing rejects and still gives the raw mode back', async () => {
    const t = fakeTty({ failWrites: 2 });
    const done = runSelect('Pick', choices, t.tty);
    t.input.emit('data', Buffer.from(' '));
    await expect(done).rejects.toThrow('EIO');
    expect(t.modes).toEqual([true, false]);
  });
});
