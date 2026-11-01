/**
 * The interactive interface's runtime: terminal, timers and daemon port around a pure reducer and pure views.
 * Quitting only ends this process: tasks, the daemon and runners do not depend on it (FR-004).
 */
import {
  DETAIL_TIMEOUT_MS,
  RefreshScheduler,
  singleFlight,
  systemRefreshClock,
} from './client/refresh.ts';
import { createDaemonPort } from './client/daemon-port.ts';
import type { Effect, Message } from './model/messages.ts';
import { reduce } from './model/reduce.ts';
import { currentScreen, initialState, type TuiState } from './model/state.ts';
import { KeyDecoder } from './terminal/keys.ts';
import { colorEnabled, diffFrames, type Frame } from './terminal/screen.ts';
import { openTerminal } from './terminal/terminal.ts';
import { helpBody } from './views/help.ts';
import { renderFrame } from './views/layout.ts';
import { countsBody } from './views/placeholder.ts';

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

  const scheduler = new RefreshScheduler({
    clock: systemRefreshClock,
    reads: {
      // A watermark asks "anything new?"; it means nothing for data not yet read (R-02).
      board: (fresh, timeoutMs, signal) =>
        port.board(
          fresh || state.board === null
            ? {}
            : { if_changed_since: state.board.watermark },
          timeoutMs,
          signal,
        ),
      health: (timeoutMs, signal) => port.health(timeoutMs, signal),
    },
    report(r) {
      dispatch(
        r.ok
          ? {
              type: 'read_succeeded',
              board: r.board,
              health: r.health,
              at: Date.now(),
            }
          : { type: 'read_failed', failure: r.failure },
      );
      return state.connection;
    },
  });

  // Only annotates the screen; if it fails the next successful read asks again.
  const loadCaller = singleFlight(async () => {
    const r = await port.projects(DETAIL_TIMEOUT_MS);
    if (r.ok) dispatch({ type: 'caller_loaded', caller: r.value.caller });
  });

  function draw(): void {
    const body =
      currentScreen(state) === 'help'
        ? helpBody(state.size.cols)
        : countsBody(state);
    const next = renderFrame(state, body, { color });
    const bytes = diffFrames(screen, next);
    screen = next;
    if (bytes !== '') terminal.write(bytes);
  }

  function run(effect: Effect): void {
    switch (effect.type) {
      case 'quit':
        scheduler.stop();
        terminal.exit(effect.code);
        break;
      case 'retry_connection':
        scheduler.retry();
        break;
      case 'load_caller':
        loadCaller();
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
}
