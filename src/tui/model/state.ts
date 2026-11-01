import type { BoardData, CallerInfo, Health } from '../client/schemas.ts';
import type { SafeText } from '../terminal/safe-text.ts';

/** Automatic reconnect attempts in one round; after these the session waits for the user (FR-009). */
export const RECONNECT_ATTEMPTS = 30;

export type StopReason = {
  readonly kind: 'token' | 'unauthenticated' | 'incompatible';
  readonly message: SafeText;
};

export type Connection =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'online' }
  | { readonly kind: 'reconnecting'; readonly attempt: number }
  | { readonly kind: 'waiting_retry' }
  | { readonly kind: 'stopped'; readonly reason: StopReason };

/** The outcome of one read of board and health; a failure that will not pass by itself names why. */
export type ReadOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly permanent: StopReason | null };

/** data-model.md "Phiên giao diện". The automatic attempts run out; the user starts a new round. */
export function nextConnection(c: Connection, r: ReadOutcome): Connection {
  if (r.ok) return { kind: 'online' };
  if (r.permanent !== null) return { kind: 'stopped', reason: r.permanent };
  switch (c.kind) {
    case 'connecting':
    case 'online':
      return { kind: 'reconnecting', attempt: 1 };
    case 'reconnecting':
      return c.attempt >= RECONNECT_ATTEMPTS
        ? { kind: 'waiting_retry' }
        : { kind: 'reconnecting', attempt: c.attempt + 1 };
    case 'waiting_retry':
    case 'stopped':
      return c;
  }
}

/** A new round, on the user's word only; `null` when there is nothing to retry. */
export function retryConnection(c: Connection): Connection | null {
  if (c.kind === 'waiting_retry') return { kind: 'reconnecting', attempt: 1 };
  if (c.kind === 'stopped') return { kind: 'connecting' };
  return null;
}

export type Screen = 'home' | 'help';

export type Filters = {
  readonly project: string | null;
  readonly status: string | null;
};

export type Size = { readonly cols: number; readonly rows: number };

/** One session; nothing here outlives the process (FR-038). */
export type TuiState = {
  readonly connection: Connection;
  readonly lastUpdatedAt: number | null;
  /** The latest read of board or health failed; new writes stay locked (FR-044). */
  readonly stale: boolean;
  /** Tasks whose latest detail read failed; new writes on them stay locked (FR-044). */
  readonly staleTasks: ReadonlySet<string>;
  readonly caller: CallerInfo | null;
  readonly screens: readonly Screen[];
  /** Kept by task, not by row, so a reorder cannot move an action to another task (EC-013). */
  readonly selectedTaskId: string | null;
  /** Every session starts unfiltered: where the user stands does not narrow the view (FR-008). */
  readonly filters: Filters;
  readonly board: BoardData | null;
  readonly health: Health | null;
  readonly size: Size;
};

export function initialState(size: Size): TuiState {
  return {
    connection: { kind: 'connecting' },
    lastUpdatedAt: null,
    stale: false,
    staleTasks: new Set(),
    caller: null,
    screens: ['home'],
    selectedTaskId: null,
    filters: { project: null, status: null },
    board: null,
    health: null,
    size,
  };
}

export function currentScreen(s: TuiState): Screen {
  return s.screens.at(-1) ?? 'home';
}

/** The interface works at this size or larger (FR-035). */
export const MIN_SIZE: Size = { cols: 80, rows: 24 };

export function tooSmall(size: Size): boolean {
  return size.cols < MIN_SIZE.cols || size.rows < MIN_SIZE.rows;
}
