import { TASK_STATUSES, type TaskStatus } from '../../domain/state.ts';
import type { Mutation } from '../client/mutations.ts';
import type { BoardData, CallerInfo, Health, PauseInfo, ProjectList } from '../client/schemas.ts';
import type { SafeText } from '../terminal/safe-text.ts';
import type { ActionsMenu } from './actions.ts';
import type { Dialog } from './dialog.ts';
import type { TaskDetail } from './detail.ts';
import type { LogState } from './logs.ts';

/** Automatic reconnect attempts in one round; after these the session waits for the user (FR-009). */
export const RECONNECT_ATTEMPTS = 30;

export type StopReason = {
  readonly kind: 'actor' | 'unauthenticated' | 'forbidden' | 'incompatible';
  readonly message: SafeText;
};

export type Connection =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'online' }
  | { readonly kind: 'reconnecting'; readonly attempt: number }
  | { readonly kind: 'waiting_retry' }
  | { readonly kind: 'stopped'; readonly reason: StopReason };

/** The outcome of a Home refresh; a failure that will not pass by itself names why. */
export type ReadOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly permanent: StopReason | null;
      /** What went wrong, for the disconnected panel. */
      readonly message?: SafeText;
    };

/** Feature 004 data model, "UI session". The automatic attempts run out; the user starts a new round. */
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

export type Screen = 'home' | 'help' | 'filters' | 'detail' | 'logs' | 'actions' | 'dialog';

export type Filters = {
  readonly project: string | null;
  readonly status: TaskStatus | null;
};

/** The filter screen before it is applied. `query` is the only text a user can type at this stage. */
export type FilterDraft = {
  readonly field: 'project' | 'status';
  readonly query: string;
  /** Into `projectChoices`. */
  readonly project: number;
  /** Into `STATUS_CHOICES`. */
  readonly status: number;
};

export const STATUS_CHOICES: readonly (TaskStatus | null)[] = [null, ...TASK_STATUSES];

/** A daemon page; also its largest (`task_board`). */
export const PAGE_LIMIT = 100;

export type Size = { readonly cols: number; readonly rows: number };

/** One session; nothing here outlives the process (FR-038). */
export type TuiState = {
  readonly connection: Connection;
  readonly lastUpdatedAt: number | null;
  /** The latest Home refresh failed; new writes stay locked (FR-044). */
  readonly stale: boolean;
  /** Tasks whose latest detail read failed; new writes on them stay locked (FR-044). */
  readonly staleTasks: ReadonlySet<string>;
  /**
   * Tasks that must be read again after the connection came back, by when it did. Their writes stay
   * locked until a `task_show` asked at or after that time answers (FR-044).
   */
  readonly recheck: ReadonlyMap<string, number>;
  /**
   * What the user is typing, by task. Memory only (FR-038): nothing here is sent by itself, not even after
   * the connection comes back.
   */
  readonly drafts: ReadonlyMap<string, string>;
  /** The latest write of each task and what is known of its result (FR-018, FR-019). */
  readonly mutations: ReadonlyMap<string, Mutation>;
  readonly caller: CallerInfo | null;
  /** Projects the config declares, when `project_list` answered. */
  readonly projects: ProjectList['projects'] | null;
  readonly screens: readonly Screen[];
  /** Kept by task, not by row, so a reorder cannot move an action to another task (EC-013). */
  readonly selectedTaskId: string | null;
  /** The `Finished` row has the selection; it is no task, so it never counts as one. */
  readonly finishedSelected: boolean;
  /** Where the selection was, for when its task leaves the list. */
  readonly selectedIndex: number;
  /** Every session starts unfiltered: where the user stands does not narrow the view (FR-008). */
  readonly filters: Filters;
  readonly filterDraft: FilterDraft | null;
  /** Finished tasks are folded until asked for (EC-005). */
  readonly finishedOpen: boolean;
  /** Cursors of the pages before this one and of this one; empty on the first page. */
  readonly cursors: readonly string[];
  /** The user was asked whether to quit and lose what they typed; the next quit key goes through. */
  readonly quitArmed: boolean;
  /** Why the latest read failed. */
  readonly lastError: SafeText | null;
  readonly board: BoardData | null;
  /** From every board reply, `unchanged` too: the queue pause does not move the watermark. */
  readonly queuePaused: PauseInfo | null;
  readonly health: Health | null;
  readonly size: Size;
  /** The open Task detail; only while it is on the screen stack. */
  readonly detail: TaskDetail | null;
  /** The open Logs; only while it is on the screen stack. */
  readonly logs: LogState | null;
  /** The open Actions menu; only while it is on the screen stack. */
  readonly actions: ActionsMenu | null;
  /** The open dialog: on top of the Actions menu of its task, or of Home for the queue. */
  readonly dialog: Dialog | null;
  /** First row of Help on screen; the screen under Help keeps its own place. */
  readonly helpTop: number;
  /**
   * Counts every opening of Task detail, Logs or Actions. Each screen keeps the value it got, so
   * an answer to a read of a former one can never pass for its own.
   */
  readonly screenSession: number;
  /** Frames of the running animation; only what is drawn depends on it. */
  readonly tick: number;
};

export function initialState(size: Size): TuiState {
  return {
    connection: { kind: 'connecting' },
    lastUpdatedAt: null,
    stale: false,
    staleTasks: new Set(),
    recheck: new Map(),
    drafts: new Map(),
    mutations: new Map(),
    caller: null,
    projects: null,
    screens: ['home'],
    selectedTaskId: null,
    finishedSelected: false,
    selectedIndex: 0,
    filters: { project: null, status: null },
    filterDraft: null,
    finishedOpen: false,
    cursors: [],
    quitArmed: false,
    lastError: null,
    board: null,
    queuePaused: null,
    health: null,
    size,
    detail: null,
    logs: null,
    actions: null,
    dialog: null,
    helpTop: 0,
    screenSession: 0,
    tick: 0,
  };
}

export type WriteLock = 'stale' | 'task_stale';

/**
 * Why a write on `taskId` may not go out now (FR-044). Before the first successful read nothing is known
 * yet, which counts as stale. `null` means the data is fresh enough to act on.
 */
export function writeLock(s: TuiState, taskId: string): WriteLock | null {
  if (s.stale || s.lastUpdatedAt === null) return 'stale';
  return s.staleTasks.has(taskId) || s.recheck.has(taskId) ? 'task_stale' : null;
}

/**
 * The write on `taskId` that keeps new ones out: one being sent, or one whose result is not known. Resends
 * stay `sending`, so one in flight counts too.
 */
export function mutationLock(s: TuiState, taskId: string): Mutation | null {
  const m = s.mutations.get(taskId);
  return m !== undefined &&
    (m.state === 'sending' || m.state === 'unknown' || m.state === 'unresolved')
    ? m
    : null;
}

/** A task's screen is open on a task that is running: its current stage turns. */
export function animating(s: TuiState): boolean {
  const screen = currentScreen(s);
  if (screen !== 'logs' && screen !== 'detail') return false;
  const status = s.detail?.explain.data?.status ?? s.detail?.show.data?.status;
  return status === 'RUNNING';
}

export function currentScreen(s: TuiState): Screen {
  return s.screens.at(-1) ?? 'home';
}

/** The interface works at this size or larger (FR-035). */
export const MIN_SIZE: Size = { cols: 80, rows: 24 };

export function tooSmall(size: Size): boolean {
  return size.cols < MIN_SIZE.cols || size.rows < MIN_SIZE.rows;
}

/** What the board is asked for, without the watermark, which belongs to one exact question (R-02). */
export type ViewQuery = {
  readonly project?: string;
  readonly status?: TaskStatus;
  readonly scope?: 'active' | 'all';
  readonly limit: number;
  readonly cursor?: string;
  readonly order: 'newest';
};

export function boardQuery(s: TuiState): ViewQuery {
  const cursor = s.cursors.at(-1);
  const { project, status } = s.filters;
  return {
    limit: PAGE_LIMIT,
    order: 'newest',
    ...(project === null ? {} : { project }),
    // A status names what the user wants to see, finished or not, so it takes no scope.
    ...(status === null
      ? { scope: s.finishedOpen ? ('all' as const) : ('active' as const) }
      : { status }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

export const boardQueryKey = (s: TuiState): string => JSON.stringify(boardQuery(s));

/** `All projects` first, or the projects whose name contains what was typed. */
export function projectChoices(
  projects: TuiState['projects'],
  query: string,
): readonly (string | null)[] {
  const q = query.toLowerCase();
  const names = (projects ?? []).map((p) => p.id).filter((id) => id.toLowerCase().includes(q));
  return q === '' ? [null, ...names] : names;
}
