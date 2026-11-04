import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Terminal } from '@xterm/headless';
import { spawn, type IPty } from 'node-pty';

// Runs a real program on a pseudo-terminal and feeds its output into a headless xterm, so a test reads
// the screen cell by cell (R-04). A small shell holds the PTY open around the program: `stty -g` is
// captured before and after it runs, which is impossible once the PTY's leader has exited.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const CUSR_ENTRY = join(ROOT, 'src/cli/cusr.ts');

export const KEY = {
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  shiftTab: '\x1b[Z',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  pageUp: '\x1b[5~',
  pageDown: '\x1b[6~',
  ctrlC: '\x03',
  ctrlS: '\x13',
} as const;

/** Terminal modes a program may change and must put back. */
export type ModeSnapshot = {
  readonly alternateScreen: boolean;
  readonly cursorHidden: boolean;
  readonly bracketedPaste: boolean;
  readonly mouseTracking: boolean;
};

export type PtyOptions = {
  /** Script run by Node; defaults to `src/cli/cusr.ts`. */
  readonly entry?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cols?: number;
  readonly rows?: number;
  readonly cwd?: string;
  /** Shell redirection for the program, to run it with one of its streams off the terminal. */
  readonly redirect?: string;
};

export type PtyExit = {
  /** Shell-style status: 128 + n when the program died from signal n. */
  readonly status: number;
  readonly sttyBefore: string;
  readonly sttyAfter: string;
};

/** node-pty always sets `TERM` itself, so the holding shell puts it the way the test asked. */
const UNSET_TERM = '__unset__';

/**
 * Written by the holding shell after the program ended. The status file can appear while the program's last
 * bytes still wait in the PTY, so an exit counts only once this has come through them. An OSC xterm ignores.
 */
const EXIT_MARK = '\x1b]7777;cusr-pty-exit\x07';

const HOLD = `
case "$CUSR_PTY_TERM" in
  ${UNSET_TERM}) unset TERM ;;
  *) TERM="$CUSR_PTY_TERM"; export TERM ;;
esac
stty -g > "$CUSR_PTY_DIR/before"
touch "$CUSR_PTY_DIR/started"
eval "\\"\\$@\\" $CUSR_PTY_REDIRECT"
status=$?
stty -g > "$CUSR_PTY_DIR/after"
echo "$status" > "$CUSR_PTY_DIR/status"
printf '${EXIT_MARK.replaceAll('\x1b', '\\033').replaceAll('\x07', '\\007')}'
exec sleep 600
`;

export class PtySession {
  readonly term: Terminal;
  readonly #pty: IPty;
  readonly #dir: string;
  #cursorHidden = false;
  #raw = '';
  #disposed = false;

  constructor(options: PtyOptions = {}) {
    const cols = options.cols ?? 100;
    const rows = options.rows ?? 30;
    this.#dir = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-pty-')));
    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 0,
    });
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) =>
      this.#trackCursor(params, true),
    );
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) =>
      this.#trackCursor(params, false),
    );
    this.#pty = spawn(
      '/bin/sh',
      [
        '-c',
        HOLD,
        'cusr-pty',
        process.execPath,
        options.entry ?? CUSR_ENTRY,
        ...(options.args ?? []),
      ],
      {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: options.cwd ?? ROOT,
        env: {
          ...ptyEnv(options.env ?? {}, this.#dir),
          CUSR_PTY_REDIRECT: options.redirect ?? '',
        },
      },
    );
    this.#pty.onData((data) => {
      this.#raw += data;
      this.term.write(data);
    });
  }

  #trackCursor(params: (number | number[])[], set: boolean): boolean {
    if (params.includes(25)) this.#cursorHidden = !set;
    return false; // Let xterm apply the mode too.
  }

  /** The screen as text, one line per row, without trailing spaces. */
  screenText(): string {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this.term.rows; y++)
      lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '');
    return lines.join('\n');
  }

  /** The character shown at a cell; an empty string for the second cell of a wide character. */
  cell(x: number, y: number): string {
    const buffer = this.term.buffer.active;
    return (
      buffer
        .getLine(buffer.viewportY + y)
        ?.getCell(x)
        ?.getChars() ?? ''
    );
  }

  /** Everything the program wrote, for checks that must see the bytes rather than the screen. */
  rawOutput(): string {
    return this.#raw;
  }

  send(keys: string): void {
    this.#pty.write(keys);
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
    this.#pty.resize(cols, rows);
  }

  /** Current `stty -g` of this PTY, read from outside without touching it. */
  stty(): string {
    return execFileSync('stty', ['-g', '-F', this.#ptsName()], {
      encoding: 'utf8',
    }).trim();
  }

  modes(): ModeSnapshot {
    return {
      alternateScreen: this.term.buffer.active.type === 'alternate',
      cursorHidden: this.#cursorHidden,
      bracketedPaste: this.term.modes.bracketedPasteMode,
      mouseTracking: this.term.modes.mouseTrackingMode !== 'none',
    };
  }

  /** Pid of the program under test (the child of the holding shell), once it has started. */
  async programPid(timeoutMs = 10_000): Promise<number> {
    let pid = 0;
    await this.waitFor(() => {
      pid = this.#childPid();
      return pid !== 0;
    }, timeoutMs);
    return pid;
  }

  #childPid(): number {
    try {
      const out = execFileSync('pgrep', ['-P', String(this.#pty.pid)], {
        encoding: 'utf8',
      }).trim();
      return Number(out.split('\n')[0] ?? 0);
    } catch {
      return 0;
    }
  }

  signal(signal: NodeJS.Signals, pid: number): void {
    process.kill(pid, signal);
  }

  async waitFor(
    predicate: () => boolean,
    timeoutMs = 10_000,
    describe?: () => string,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await flush(this.term);
      if (predicate()) return;
      if (Date.now() > deadline)
        throw new Error(
          `Timed out after ${timeoutMs} ms${describe === undefined ? '' : `: ${describe()}`}\n--- screen ---\n${this.screenText()}`,
        );
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  waitForText(text: string, timeoutMs = 10_000): Promise<void> {
    return this.waitFor(
      () => this.screenText().includes(text),
      timeoutMs,
      () => `waiting for ${JSON.stringify(text)}`,
    );
  }

  /** Waits until the program has exited and the holding shell recorded the terminal state. */
  async waitForExit(timeoutMs = 10_000): Promise<PtyExit> {
    const status = join(this.#dir, 'status');
    await this.waitFor(
      () =>
        this.#raw.includes(EXIT_MARK) &&
        existsSync(status) &&
        readFileSync(status, 'utf8').endsWith('\n'),
      timeoutMs,
      () => 'waiting for the program to exit',
    );
    return {
      status: Number(readFileSync(status, 'utf8').trim()),
      sttyBefore: readFileSync(join(this.#dir, 'before'), 'utf8').trim(),
      sttyAfter: readFileSync(join(this.#dir, 'after'), 'utf8').trim(),
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const child = this.#childPid();
    if (child !== 0) {
      try {
        process.kill(child, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    this.#pty.kill('SIGKILL');
    this.term.dispose();
    rmSync(this.#dir, { recursive: true, force: true });
  }

  #ptsName(): string {
    return (this.#pty as unknown as { ptsName: string }).ptsName;
  }
}

/** A value of `undefined` removes the variable, so a test can run without `TERM` or `NO_COLOR`. */
function ptyEnv(
  env: Readonly<Record<string, string | undefined>>,
  dir: string,
): Record<string, string> {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    ...env,
    CUSR_PTY_DIR: dir,
    CUSR_PTY_TERM: 'TERM' in env ? (env['TERM'] ?? UNSET_TERM) : 'xterm-256color',
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) out[k] = v;
  return out;
}

/** Resolves after xterm has parsed everything written so far. */
function flush(term: Terminal): Promise<void> {
  return new Promise((resolve) => term.write('', resolve));
}

/** A small deterministic generator (mulberry32), so a failing key sequence replays from its seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMED_KEYS: readonly string[] = Object.values(KEY);
const PRINTABLE = 'abcdefghijklmnopqrstuvwxyzACFGR?/ 0123456789';

/** A seeded key sequence for fuzzing; Ctrl-C is left out so the session stays open. */
export function seededKeys(seed: number, count: number): string[] {
  const random = seededRandom(seed);
  const pool = NAMED_KEYS.filter((k) => k !== KEY.ctrlC);
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    keys.push(
      random() < 0.3
        ? (pool[Math.floor(random() * pool.length)] as string)
        : (PRINTABLE[Math.floor(random() * PRINTABLE.length)] as string),
    );
  }
  return keys;
}
