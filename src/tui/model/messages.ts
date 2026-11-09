import type { BoardReply, Health, ProjectList } from '../client/schemas.ts';
import type { Key } from '../terminal/keys.ts';
import type { Mutation, MutationCommand } from '../client/mutations.ts';
import type { ActionsMessage, ActionsShowMessage } from './actions.ts';
import type { DetailMessage } from './detail.ts';
import type { DialogReadMessage } from './dialog.ts';
import type { GatesMessage, LogsMessage } from './detail-keys.ts';
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
  /** The user typed in a task's input; `null` text drops the draft (sent, or given up). */
  | { readonly type: 'draft_changed'; readonly taskId: string; readonly text: string | null }
  /** One frame of the animation went by. */
  | { readonly type: 'tick' }
  /** The tracker moved a write on: sent, lost, found, or given up on. */
  | { readonly type: 'mutation_changed'; readonly mutation: Mutation }
  | DetailMessage
  | LogsMessage
  | GatesMessage
  | ActionsMessage
  | ActionsShowMessage
  | DialogReadMessage;

/** What the reducer asks the runtime to do; it does none of it itself. */
export type Effect =
  | { readonly type: 'quit'; readonly code: number }
  | { readonly type: 'retry_connection' }
  /** The view changed while online: read it now instead of at the next tick. */
  | { readonly type: 'refresh_now' }
  /** The open screen has something to read now, not at the next tick. */
  | { readonly type: 'read_screen' }
  /** One new write; the runtime's tracker gives it its request ID. */
  | { readonly type: 'submit'; readonly command: MutationCommand }
  /** `Check again`: a new round for a write whose result stayed unknown. */
  | { readonly type: 'check_again'; readonly requestId: string };
