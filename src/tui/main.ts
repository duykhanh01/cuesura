/**
 * The interactive interface's runtime: terminal, timers and daemon port around a pure reducer and pure views.
 * Quitting only ends this process: tasks, the daemon and runners do not depend on it (FR-004).
 */
import { MutationTracker, type Mutation } from './client/mutations.ts';
import { RefreshScheduler, systemRefreshClock } from './client/refresh.ts';
import { createDaemonPort } from './client/daemon-port.ts';
import { planScreenReads, ScreenReads } from './client/screen-reads.ts';
import type { Effect, Message } from './model/messages.ts';
import { sendingDraftNotice } from './model/dialog.ts';
import { reduce } from './model/reduce.ts';
import {
  animating,
  boardQuery,
  boardQueryKey,
  initialState,
  type TuiState,
} from './model/state.ts';
import { KeyDecoder, type Key } from './terminal/keys.ts';
import { colorEnabled, diffFrames, has256Colors, type Frame } from './terminal/screen.ts';
import { openTerminal } from './terminal/terminal.ts';
import { renderFrame } from './views/layout.ts';
import { screenBody } from './views/screen-body.ts';

/** Nothing following an Esc for this long means it was the key, not the start of a sequence. */
const ESC_WAIT_MS = 30;
/** One frame of the spinner; only the cells that change are written. */
const TICK_MS = 120;

/** How often a write whose result is unknown is looked up; each look counts only while connected. */
const MUTATION_POLL_MS = 1_000;
/** Exit status when a write's result is still unknown at exit (EC-012). */
const EXIT_UNKNOWN_RESULT = 3;

/** What goes to stderr after the terminal is restored, for each write whose result is not known. */
function unknownResultNotice(mutations: Iterable<Mutation>): string | null {
  const lines = [...mutations]
    .filter((m) => m.state === 'sending' || m.state === 'unknown' || m.state === 'unresolved')
    .map(
      (m) =>
        `cusr: the result of ${m.command.kind} ${m.command.task_id === null ? 'on the queue' : `on task ${m.command.task_id}`} is not known.\n` +
        `  request ID: ${m.requestId}\n  look it up with: cusr request show ${m.requestId}\n`,
    );
  return lines.length === 0 ? null : lines.join('');
}

/** Everything stderr must carry at exit: writes of unknown result, then a draft whose write was on its way. */
export function exitNotice(state: TuiState, mutations: Iterable<Mutation>): string | null {
  const parts = [unknownResultNotice(mutations), sendingDraftNotice(state)].filter(
    (p) => p !== null,
  );
  return parts.length === 0 ? null : parts.join('');
}

export function runTui(): void {
  const port = createDaemonPort();
  const known = new Map<string, Mutation>();
  const decoder = new KeyDecoder();
  const color = colorEnabled();
  const colors256 = has256Colors();
  let screen: Frame | null = null;
  let escTimer: NodeJS.Timeout | null = null;

  const terminal = openTerminal({
    onInput(data) {
      for (const key of decoder.feed(data)) press(key);
      if (escTimer !== null) clearTimeout(escTimer);
      escTimer = decoder.pending()
        ? setTimeout(() => {
            for (const key of decoder.flush()) press(key);
          }, ESC_WAIT_MS)
        : null;
    },
    onResize() {
      screen = null;
      dispatch({ type: 'resize', size: terminal.size() });
    },
    onRedraw: redraw,
    exitNotice: () => exitNotice(state, known.values()),
    exitNoticeCode: EXIT_UNKNOWN_RESULT,
  });

  let state: TuiState = initialState(terminal.size());
  /** The question the board read in progress asked, so its answer cannot land on another view. */
  let askedKey = boardQueryKey(state);
  const scheduler = new RefreshScheduler({
    clock: systemRefreshClock,
    reads: {
      // A watermark asks "anything new?"; it means nothing for data not yet read (R-02).
      board: (fresh, timeoutMs, signal) => {
        askedKey = boardQueryKey(state);
        return port.board(
          {
            ...boardQuery(state),
            ...(fresh || state.board === null ? {} : { if_changed_since: state.board.watermark }),
          },
          timeoutMs,
          signal,
        );
      },
      health: (timeoutMs, signal) => port.health(timeoutMs, signal),
      projects: (fresh, timeoutMs, signal) =>
        fresh || state.caller === null
          ? port.projects(timeoutMs, signal)
          : Promise.resolve({ ok: true, value: null }),
    },
    report(r) {
      dispatch(
        r.ok
          ? {
              type: 'read_succeeded',
              board: r.board,
              health: r.health,
              at: Date.now(),
              queryKey: askedKey,
              ...(r.projects === undefined ? {} : { projects: r.projects }),
            }
          : { type: 'read_failed', failure: r.failure },
      );
      return state.connection;
    },
  });

  const tracker = new MutationTracker({
    port,
    connected: () => state.connection.kind === 'online',
    onChange(mutation) {
      known.set(mutation.requestId, mutation);
      dispatch({ type: 'mutation_changed', mutation });
    },
  });
  const pollWrites = setInterval(() => {
    for (const m of tracker.open()) if (m.state === 'unknown') void tracker.poll(m.requestId);
  }, MUTATION_POLL_MS);
  pollWrites.unref();

  const screenReads = new ScreenReads({
    clock: systemRefreshClock,
    plan: (now) => planScreenReads(state, port, systemRefreshClock, now),
    report: (message) => dispatch(message),
  });

  function redraw(): void {
    screen = null;
    draw();
  }

  /** Redrawing belongs to no screen, and must not count as an answer to one: "press again to quit", say. */
  function press(key: Key): void {
    if (key.kind === 'key' && (key.name === 'ctrl_l' || key.name === 'focus_in')) redraw();
    else dispatch({ type: 'key', key });
  }

  function draw(): void {
    const body = screenBody(state, { color });
    const next = renderFrame(state, body, { color, colors256 });
    const bytes = diffFrames(screen, next);
    screen = next;
    if (bytes !== '') terminal.write(bytes);
  }

  function run(effect: Effect): void {
    switch (effect.type) {
      case 'quit': {
        clearInterval(animation);
        clearInterval(pollWrites);
        scheduler.stop();
        screenReads.stop();
        const notice = exitNotice(state, known.values());
        if (notice === null) terminal.exit(effect.code);
        else terminal.exit(EXIT_UNKNOWN_RESULT, notice);
        break;
      }
      case 'submit':
        void tracker.submit(effect.command);
        break;
      case 'check_again':
        if (tracker.checkAgain(effect.requestId)?.state === 'unknown')
          void tracker.poll(effect.requestId);
        break;
      case 'retry_connection':
      case 'refresh_now':
        scheduler.retry();
        break;
      case 'read_screen':
        screenReads.kick();
        break;
    }
  }

  function dispatch(message: Message): void {
    const r = reduce(state, message);
    state = r.state;
    draw();
    for (const effect of r.effects) run(effect);
  }

  const animation = setInterval(() => {
    if (animating(state)) dispatch({ type: 'tick' });
  }, TICK_MS);
  animation.unref();

  draw();
  scheduler.start();
  screenReads.start();
}
