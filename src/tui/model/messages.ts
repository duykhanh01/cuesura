import type { BoardReply, CallerInfo, Health } from '../client/schemas.ts';
import type { Key } from '../terminal/keys.ts';
import type { ReadOutcome, Size } from './state.ts';

export type Message =
  | { readonly type: 'key'; readonly key: Key }
  | { readonly type: 'resize'; readonly size: Size }
  | {
      readonly type: 'read_succeeded';
      readonly board: BoardReply;
      readonly health: Health;
      readonly at: number;
    }
  | {
      readonly type: 'read_failed';
      readonly failure: Extract<ReadOutcome, { ok: false }>;
    }
  | { readonly type: 'caller_loaded'; readonly caller: CallerInfo };

/** What the reducer asks the runtime to do; it does none of it itself. */
export type Effect =
  | { readonly type: 'quit'; readonly code: number }
  | { readonly type: 'retry_connection' }
  | { readonly type: 'load_caller' };
