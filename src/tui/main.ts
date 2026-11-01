/**
 * The interactive interface's runtime: terminal, timers and daemon port around a pure reducer and pure views.
 * Quitting only ends this process: tasks, the daemon and runners do not depend on it (FR-004).
 */
import { RefreshScheduler, systemRefreshClock } from './client/refresh.ts';
import { createDaemonPort } from './client/daemon-port.ts';
import { planScreenReads, ScreenReads } from './client/screen-reads.ts';
import type { Effect, Message } from './model/messages.ts';
import { reduce } from './model/reduce.ts';
import {
  boardQuery,
  boardQueryKey,
  currentScreen,
  initialState,
  type TuiState,
} from './model/state.ts';
import { KeyDecoder } from './terminal/keys.ts';
import { colorEnabled, diffFrames, type Frame } from './terminal/screen.ts';
import { openTerminal } from './terminal/terminal.ts';
import { withDisconnected } from './views/disconnected.ts';
import { filtersBody } from './views/filters.ts';
import { helpBody } from './views/help.ts';
import { homeBody } from './views/home.ts';
import { renderFrame, type Body } from './views/layout.ts';
import { logsBody } from './views/logs.ts';
import { detailBody } from './views/task-detail.ts';

/** Nothing following an Esc for this long means it was the key, not the start of a sequence. */
const ESC_WAIT_MS = 30;

export function runTui(): void {
  const port = createDaemonPort();
  const decoder = new KeyDecoder();
  const color = colorEnabled();
  let screen: Frame | null = null;
  let escTimer: NodeJS.Timeout | null = null;

  const terminal = openTerminal({
    onInput(data) {
      for (const key of decoder.feed(data)) dispatch({ type: 'key', key });
      if (escTimer !== null) clearTimeout(escTimer);
      escTimer = decoder.pending()
        ? setTimeout(() => {
            for (const key of decoder.flush()) dispatch({ type: 'key', key });
          }, ESC_WAIT_MS)
        : null;
    },
    onResize() {
      screen = null;
      dispatch({ type: 'resize', size: terminal.size() });
    },
    onRedraw() {
      screen = null;
      draw();
    },
  });

  let state: TuiState = initialState(terminal.size());
  /** The question the board read in progress asked, so its answer cannot land on another view. */
  let askedKey = boardQueryKey(state);
  let credential = port.credentialGeneration();

  function noticeCredential(): void {
    if (port.credentialGeneration() === credential) return;
    credential = port.credentialGeneration();
    dispatch({ type: 'credential_changed' });
  }

  const scheduler = new RefreshScheduler({
    clock: systemRefreshClock,
    reads: {
      // A watermark asks "anything new?"; it means nothing for data not yet read (R-02).
      board: (fresh, timeoutMs, signal) => {
        askedKey = boardQueryKey(state);
        return port.board(
          {
            ...boardQuery(state),
            ...(fresh || state.board === null
              ? {}
              : { if_changed_since: state.board.watermark }),
          },
          timeoutMs,
          signal,
        );
      },
      health: (timeoutMs, signal) => port.health(timeoutMs, signal),
      projects: (fresh, timeoutMs, signal) =>
        fresh ||
        state.caller === null ||
        port.credentialGeneration() !== credential
          ? port.projects(timeoutMs, signal)
          : Promise.resolve({ ok: true, value: null }),
    },
    credential: {
      generation: () => port.credentialGeneration(),
      superseded: noticeCredential,
    },
    report(r) {
      noticeCredential();
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

  const screenReads = new ScreenReads({
    clock: systemRefreshClock,
    plan: (now) => planScreenReads(state, port, systemRefreshClock, now),
    report: (message) => dispatch(message),
    credential: {
      generation: () => port.credentialGeneration(),
      superseded: noticeCredential,
    },
  });

  function bodyOf(s: TuiState): Body {
    switch (currentScreen(s)) {
      case 'help':
        return helpBody(s.size.cols);
      case 'filters':
        return filtersBody(s);
      case 'home':
        return homeBody(s, { color });
      case 'detail':
        return detailBody(s);
      case 'logs':
        return logsBody(s);
    }
  }

  function draw(): void {
    const body = withDisconnected(state, bodyOf(state));
    const next = renderFrame(state, body, { color });
    const bytes = diffFrames(screen, next);
    screen = next;
    if (bytes !== '') terminal.write(bytes);
  }

  function run(effect: Effect): void {
    switch (effect.type) {
      case 'quit':
        scheduler.stop();
        screenReads.stop();
        terminal.exit(effect.code);
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

  draw();
  scheduler.start();
  screenReads.start();
}
