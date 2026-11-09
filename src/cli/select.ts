/**
 * A checkbox list for setup questions: arrows move, Space toggles, `a` toggles all, Enter confirms,
 * Esc or Ctrl-C cancels. Each choice shows its description underneath. The state and the drawing are
 * pure so they are tested without a terminal; `runSelect` wires them to a TTY.
 */
import { KeyDecoder, type Key } from '../tui/terminal/keys.ts';
import { colorEnabled } from '../tui/terminal/screen.ts';
import { displayWidth } from '../tui/terminal/width.ts';

export type Choice = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Why the choice cannot be picked; null when it can. */
  readonly unavailable: string | null;
};

export type SelectState = {
  readonly cursor: number;
  readonly checked: ReadonlySet<string>;
};

export type SelectStep =
  | { readonly kind: 'state'; readonly state: SelectState }
  | { readonly kind: 'done'; readonly ids: readonly string[] }
  | { readonly kind: 'cancel' };

/** Every available choice starts checked, and the cursor on the first one. */
export function initialSelect(choices: readonly Choice[]): SelectState {
  const open = choices.filter((c) => c.unavailable === null);
  return {
    cursor: Math.max(0, choices.indexOf(open[0] as Choice)),
    checked: new Set(open.map((c) => c.id)),
  };
}

function move(choices: readonly Choice[], from: number, step: 1 | -1): number {
  for (let i = from + step; i >= 0 && i < choices.length; i += step)
    if (choices[i]?.unavailable === null) return i;
  return from;
}

export function stepSelect(choices: readonly Choice[], state: SelectState, key: Key): SelectStep {
  const at = (cursor: number, checked = state.checked): SelectStep => ({
    kind: 'state',
    state: { cursor, checked },
  });
  if (key.kind === 'key') {
    switch (key.name) {
      case 'up':
        return at(move(choices, state.cursor, -1));
      case 'down':
      case 'tab':
        return at(move(choices, state.cursor, 1));
      case 'enter':
        return {
          kind: 'done',
          ids: choices.filter((c) => state.checked.has(c.id)).map((c) => c.id),
        };
      case 'esc':
      case 'ctrl_c':
        return { kind: 'cancel' };
      default:
        return at(state.cursor);
    }
  }
  if (key.kind !== 'char') return at(state.cursor);
  if (key.text === 'k') return at(move(choices, state.cursor, -1));
  if (key.text === 'j') return at(move(choices, state.cursor, 1));
  if (key.text === 'a') {
    const open = choices.filter((c) => c.unavailable === null).map((c) => c.id);
    const all = open.every((id) => state.checked.has(id));
    return at(state.cursor, new Set(all ? [] : open));
  }
  if (key.text === ' ') {
    const choice = choices[state.cursor];
    if (choice === undefined || choice.unavailable !== null) return at(state.cursor);
    const checked = new Set(state.checked);
    if (checked.has(choice.id)) checked.delete(choice.id);
    else checked.add(choice.id);
    return at(state.cursor, checked);
  }
  return at(state.cursor);
}

type Paint = (code: string, text: string) => string;

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[0-9;]*m/g;

const painter =
  (color: boolean): Paint =>
  (code, text) =>
    color ? `\x1b[${code}m${text}\x1b[0m` : text;

export const SELECT_HINT = '↑/↓ move · space toggle · a all · enter confirm · esc cancel';

/** Lines of the list while it is open. */
export function renderSelect(
  title: string,
  choices: readonly Choice[],
  state: SelectState,
  color: boolean,
): string[] {
  const p = painter(color);
  const lines = [`${p('36', '?')} ${p('1', title)}`, `  ${p('2', SELECT_HINT)}`];
  choices.forEach((c, i) => {
    const here = i === state.cursor;
    const pointer = here ? p('36', '❯') : ' ';
    if (c.unavailable !== null) {
      lines.push(`${pointer} ${p('2', `◯ ${c.label}  (${c.unavailable})`)}`);
    } else {
      const box = state.checked.has(c.id) ? p('32', '◉') : '◯';
      lines.push(`${pointer} ${box} ${here ? p('36', c.label) : c.label}`);
    }
    lines.push(`    ${p('2', c.description)}`);
  });
  return lines;
}

/** The line left on screen once the list closes. */
export function renderSelectResult(
  title: string,
  choices: readonly Choice[],
  ids: readonly string[] | null,
  color: boolean,
): string {
  const p = painter(color);
  if (ids === null) return `${p('31', '✖')} ${p('1', title)} ${p('2', 'cancelled')}`;
  const picked = choices.filter((c) => ids.includes(c.id)).map((c) => c.label);
  return `${p('32', '✔')} ${p('1', title)} ${p('2', picked.length === 0 ? 'nothing' : picked.join(', '))}`;
}

export type SelectTty = {
  readonly input: Pick<
    NodeJS.ReadStream,
    'isRaw' | 'setRawMode' | 'resume' | 'pause' | 'on' | 'off'
  >;
  readonly output: Pick<NodeJS.WriteStream, 'write' | 'columns'>;
  /** Delivers a signal again once the terminal is restored; by default the process ends as usual. */
  readonly raise?: (signal: NodeJS.Signals) => void;
};

const SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Shows the list on a terminal and resolves with the checked ids, or null when cancelled. Whatever ends
 * it (a key, a signal, an error, the process exiting), the terminal gets its mode and cursor back.
 */
export function runSelect(
  title: string,
  choices: readonly Choice[],
  tty: SelectTty = { input: process.stdin, output: process.stdout },
): Promise<readonly string[] | null> {
  const color = colorEnabled();
  const { input, output } = tty;
  const raise = tty.raise ?? ((signal) => process.kill(process.pid, signal));
  const decoder = new KeyDecoder();
  let state = initialSelect(choices);
  let drawn = 0;
  // A line wider than the terminal wraps, so redrawing moves up by rows, not by lines.
  const rows = (line: string) =>
    Math.max(1, Math.ceil(displayWidth(line.replace(SGR, '')) / Math.max(1, output.columns || 80)));
  const draw = (lines: readonly string[]) => {
    const up = drawn > 0 ? `\x1b[${drawn}F` : '';
    output.write(`${up}\x1b[J${lines.join('\n')}\n`);
    drawn = lines.reduce((n, l) => n + rows(l), 0);
  };
  return new Promise((resolve, reject) => {
    let escTimer: NodeJS.Timeout | undefined;
    let open = true;
    const wasRaw = input.isRaw;
    const restore = () => {
      if (!open) return;
      open = false;
      clearTimeout(escTimer);
      input.off('data', onData);
      for (const s of SIGNALS) process.off(s, onSignal);
      process.off('exit', restore);
      try {
        input.setRawMode(wasRaw);
        output.write('\x1b[?25h');
      } catch {
        // After SIGHUP the terminal may be gone; there is nothing left to restore.
      }
      input.pause();
    };
    const onSignal = (signal: NodeJS.Signals) => {
      restore();
      raise(signal);
    };
    const finish = (ids: readonly string[] | null) => {
      try {
        draw([renderSelectResult(title, choices, ids, color)]);
      } finally {
        restore();
      }
      resolve(ids);
    };
    const guard = (run: () => void) => {
      try {
        run();
      } catch (e) {
        restore();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    const handle = (keys: readonly Key[]) => {
      for (const key of keys) {
        const next = stepSelect(choices, state, key);
        if (next.kind === 'done') return finish(next.ids);
        if (next.kind === 'cancel') return finish(null);
        state = next.state;
      }
      draw(renderSelect(title, choices, state, color));
    };
    const onData = (data: Buffer) =>
      guard(() => {
        clearTimeout(escTimer);
        handle(decoder.feed(data));
        // A lone Esc waits for bytes that would make it a sequence; none came, so it is the Esc key.
        if (open && decoder.pending())
          escTimer = setTimeout(() => guard(() => handle(decoder.flush())), 50);
      });
    for (const s of SIGNALS) process.on(s, onSignal);
    process.on('exit', restore);
    guard(() => {
      output.write('\x1b[?25l');
      input.setRawMode(true);
      input.resume();
      input.on('data', onData);
      draw(renderSelect(title, choices, state, color));
    });
  });
}
