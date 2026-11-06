/**
 * Terminal ownership for the interactive interface (R-12). Everything that changes the terminal is here,
 * with one restore function that runs once, synchronously, from every exit path: a process about to end
 * must not lose the restore sequence in an async write queue.
 */
import { writeSync } from 'node:fs';

// 1007 turns the wheel into arrow keys here. Capturing the mouse would do it too, and take from the user the
// terminal's own selection and copy. Saved and restored, since some terminals have it on by default.
// 1004 reports coming back to the window: a terminal hidden meanwhile may not have kept what was drawn.
const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1004h\x1b[?1007s\x1b[?1007h';
const LEAVE = '\x1b[0m\x1b[?1007r\x1b[?1004l\x1b[?2004l\x1b[?25h\x1b[?1049l';
const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;
const STDOUT_FD = 1;
const STDERR_FD = 2;

export type TerminalSize = { readonly cols: number; readonly rows: number };

export type TerminalOptions = {
  readonly onInput: (data: Buffer) => void;
  readonly onResize: () => void;
  /** The screen is gone (the process was resumed after a stop): draw everything again. */
  readonly onRedraw: () => void;
  /** Line printed on stderr after restoring, when a signal or failure ends the process. */
  readonly exitNotice?: () => string | null;
  /** Exit status when a signal or internal failure ends the process while `exitNotice` has something to say (EC-012). */
  readonly exitNoticeCode?: number;
};

export type Terminal = {
  write(text: string): void;
  size(): TerminalSize;
  /** Restores the terminal, prints `notice` on the normal screen and ends the process. */
  exit(code: number, notice?: string): never;
};

function writeAll(fd: number, text: string): void {
  try {
    writeSync(fd, text);
  } catch {
    // The terminal is gone (hung-up SSH): there is nothing left to restore or tell.
  }
}

export function openTerminal(options: TerminalOptions): Terminal {
  const { stdin, stdout } = process;
  let restored = false;

  const setRaw = (raw: boolean): void => {
    try {
      stdin.setRawMode(raw);
    } catch {
      // Same as writeAll: the terminal is gone.
    }
  };

  const restore = (): void => {
    if (restored) return;
    restored = true;
    setRaw(false);
    writeAll(STDOUT_FD, LEAVE);
  };

  const exit = (code: number, notice?: string): never => {
    restore();
    if (notice !== undefined) writeAll(STDERR_FD, notice);
    process.exit(code);
  };

  /** A failure or signal: the session ends here, but pending notices must still reach the user. */
  const abort = (code: number, message: string | null): never => {
    const extra = options.exitNotice?.() ?? null;
    const status = extra !== null ? (options.exitNoticeCode ?? code) : code;
    return exit(status, `${message === null ? '' : `${message}\n`}${extra === null ? '' : extra}`);
  };

  const fail = (cause: unknown): never =>
    abort(1, `cusr: internal error: ${cause instanceof Error ? cause.message : String(cause)}`);

  for (const [signal, number] of Object.entries(SIGNAL_NUMBERS))
    process.on(signal, () => abort(128 + number, null));
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  stdout.on('error', fail);

  stdin.on('data', (data: Buffer) => options.onInput(data));
  stdout.on('resize', () => options.onResize());

  const enter = (): void => {
    // libuv ignores a mode it believes is already set, but a stopped job may have lost it.
    setRaw(false);
    setRaw(true);
    writeAll(STDOUT_FD, ENTER);
  };
  process.on('SIGCONT', () => {
    enter();
    options.onRedraw();
  });

  enter();
  stdin.resume();

  return {
    write(text) {
      if (restored) return;
      // A failed write may reach only this callback, not the stream's `error` event.
      stdout.write(text, (e) => {
        if (e !== null && e !== undefined) fail(e);
      });
    },
    size() {
      return { cols: stdout.columns, rows: stdout.rows };
    },
    exit,
  };
}
