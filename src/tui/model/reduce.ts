/**
 * `(state, message) → (state, effects)`, pure, so random keys and connection failures can be tested without
 * a terminal. Nothing here decides what a task may do: that stays with the daemon.
 */
import type { Effect, Message } from './messages.ts';
import {
  currentScreen,
  nextConnection,
  retryConnection,
  type TuiState,
} from './state.ts';

export type Reduced = {
  readonly state: TuiState;
  readonly effects: readonly Effect[];
};

const same = (state: TuiState): Reduced => ({ state, effects: [] });

export function reduce(state: TuiState, message: Message): Reduced {
  switch (message.type) {
    case 'resize':
      return same({ ...state, size: message.size });
    case 'caller_loaded':
      return same({ ...state, caller: message.caller });
    case 'read_succeeded':
      return {
        state: {
          ...state,
          connection: nextConnection(state.connection, { ok: true }),
          stale: false,
          lastUpdatedAt: message.at,
          // An unchanged board keeps what was already read: that is still the truth.
          board: message.board.unchanged ? state.board : message.board,
          health: message.health,
        },
        effects: state.caller === null ? [{ type: 'load_caller' }] : [],
      };
    case 'read_failed':
      return same({
        ...state,
        connection: nextConnection(state.connection, message.failure),
        stale: true,
      });
    case 'key':
      return onKey(state, message.key);
  }
}

function onKey(
  state: TuiState,
  key: Extract<Message, { type: 'key' }>['key'],
): Reduced {
  if (key.kind === 'paste') return same(state);
  if (key.kind === 'key') {
    if (key.name === 'ctrl_c')
      return { state, effects: [{ type: 'quit', code: 0 }] };
    if (key.name === 'esc' && state.screens.length > 1)
      return same({ ...state, screens: state.screens.slice(0, -1) });
    return same(state);
  }
  switch (key.text) {
    case 'q':
      return { state, effects: [{ type: 'quit', code: 0 }] };
    case '?':
      return currentScreen(state) === 'help'
        ? same(state)
        : same({ ...state, screens: [...state.screens, 'help'] });
    case 'R': {
      const connection = retryConnection(state.connection);
      return connection === null
        ? same(state)
        : {
            state: { ...state, connection },
            effects: [{ type: 'retry_connection' }],
          };
    }
    default:
      return same(state);
  }
}
