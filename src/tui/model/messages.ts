import type { BoardReply, Health, ProjectList } from '../client/schemas.ts';
import type { Key } from '../terminal/keys.ts';
import type { ReadOutcome, Size } from './state.ts';

export type Message =
  | { readonly type: 'key'; readonly key: Key }
  | { readonly type: 'resize'; readonly size: Size }
  | {
      readonly type: 'read_succeeded';
      readonly board: BoardReply;
      readonly health: Health;
      readonly projects?: ProjectList;
      readonly at: number;
      /** The question this board answers; an answer to an older one is not this view's data. */
      readonly queryKey?: string;
    }
  | {
      readonly type: 'read_failed';
      readonly failure: Extract<ReadOutcome, { ok: false }>;
    }
  /** The token file now holds another token: who is asking, and what they may read, must be read again. */
  | { readonly type: 'credential_changed' };

/** What the reducer asks the runtime to do; it does none of it itself. */
export type Effect =
  | { readonly type: 'quit'; readonly code: number }
  | { readonly type: 'retry_connection' }
  /** The view changed while online: read it now instead of at the next tick. */
  | { readonly type: 'refresh_now' };
