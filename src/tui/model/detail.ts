/**
 * What the Task detail screen has read (FR-011–FR-015). It only keeps the daemon's answers and works out when to
 * ask again (R-03): why a task waits and how out come from `task_explain`, never from anything here (FR-012).
 */
import type { PortResult } from '../client/daemon-port.ts';
import { EXPLAIN_REFRESH_MS } from '../client/refresh.ts';
import type {
  TaskContent,
  TaskExplain,
  TaskHistory,
  TaskProgress,
  TaskShow,
} from '../client/schemas.ts';
import { sanitize, uiText, type SafeText } from '../terminal/safe-text.ts';
import type { TuiState } from './state.ts';

/**
 * Read at least every 5 seconds means starting before they are up: reads start on a tick of 250 ms and take time.
 */
export const EXPLAIN_READ_MS = EXPLAIN_REFRESH_MS - 500;
/** The newest events kept; the session stays bounded however long a task's history grows (FR-039). */
export const HISTORY_KEPT = 2_000;
const PAYLOAD_CHARS = 400;

export type Part<T> = {
  readonly data: T | null;
  readonly error: SafeText | null;
  /** When the last read that got an answer, good or bad, was asked: the period runs from there. */
  readonly attemptAt: number | null;
  /** When the last good answer came: what the screen says. */
  readonly readAt: number | null;
};

export const noPart = <T>(): Part<T> => ({
  data: null,
  error: null,
  attemptAt: null,
  readAt: null,
});

export type HistoryLine = {
  readonly seq: number;
  readonly type: SafeText;
  readonly actor: SafeText;
  readonly payload: SafeText;
  /** The payload's `reason`, whole, for the events that end a task. */
  readonly reason?: SafeText;
};

export type TaskDetail = {
  readonly taskId: string;
  /** See `TuiState.screenSession`. */
  readonly session: number;
  readonly title: SafeText;
  /** Whether codes, hashes and counters are shown, for whoever digs in. */
  readonly technical: boolean;
  readonly show: Part<TaskShow>;
  readonly progress: Part<TaskProgress>;
  readonly explain: Part<TaskExplain>;
  /** What the task asks for (`task_content`); shown only, never what a write goes out with. */
  readonly content: Part<TaskContent>;
  /** The watermark `explain` was asked under. */
  readonly explainWatermark: number | null;
  readonly history: {
    readonly events: readonly HistoryLine[];
    readonly next: number;
    readonly more: boolean;
    /** Older events no longer kept. */
    readonly dropped: number;
    readonly version: number | null;
    readonly error: SafeText | null;
    readonly attemptAt: number | null;
  };
  /** One read of `task_show` was asked for while Logs covers this screen, for its list of attempts. */
  readonly showWanted: boolean;
  /** First row on screen. */
  readonly top: number;
};

export function initialDetail(taskId: string, title: SafeText, session: number): TaskDetail {
  return {
    taskId,
    session,
    title,
    technical: false,
    show: noPart(),
    progress: noPart(),
    explain: noPart(),
    content: noPart(),
    explainWatermark: null,
    history: {
      events: [],
      next: 0,
      more: false,
      dropped: 0,
      version: null,
      error: null,
      attemptAt: null,
    },
    showWanted: false,
    top: 0,
  };
}

export type DetailPartName = 'show' | 'progress' | 'explain' | 'history' | 'content';

function versionedDue(
  part: Part<{ readonly version: number }>,
  known: number | null,
  now: number,
): boolean {
  if (part.attemptAt === null) return true;
  // A read that failed is tried again at the pace of the explanation, not at every tick.
  if (part.error !== null) return now - part.attemptAt >= EXPLAIN_READ_MS;
  return known !== null && part.data !== null && part.data.version < known;
}

/**
 * What to read of the open task. `task_show` and `task_progress` follow the version; the version is learned from
 * `task_explain`, which is read when the watermark moved and at least every 5 seconds, because what it says
 * can change while the version stands still (R-03).
 */
export function detailDue(
  d: TaskDetail,
  watermark: number | null,
  now: number,
): readonly DetailPartName[] {
  const known = d.explain.data?.version ?? null;
  const due: DetailPartName[] = [];
  const asked = d.explain.attemptAt;
  if (
    asked === null ||
    now - asked >= EXPLAIN_READ_MS ||
    (watermark !== null && watermark !== d.explainWatermark)
  )
    due.push('explain');
  if (versionedDue(d.show, known, now)) due.push('show');
  if (versionedDue(d.progress, known, now)) due.push('progress');
  const h = d.history;
  const historyDue =
    h.attemptAt === null ||
    (h.error !== null
      ? now - h.attemptAt >= EXPLAIN_READ_MS
      : h.more || (known !== null && (h.version ?? -1) < known));
  if (historyDue) due.push('history');
  return due;
}

/** The request changes only with a new revision, so it is read once and again when the revision moves. */
export function contentDue(d: TaskDetail, now: number): boolean {
  const c = d.content;
  if (c.attemptAt === null) return true;
  if (c.error !== null) return now - c.attemptAt >= EXPLAIN_READ_MS;
  const known = d.explain.data?.revision ?? d.show.data?.revision ?? null;
  return known !== null && c.data !== null && c.data.revision < known;
}

export type DetailMessage = {
  readonly type: 'detail_read';
  readonly taskId: string;
  /** The screen that asked. */
  readonly session: number;
  /** When it was asked, and when the answer came. */
  readonly askedAt: number;
  readonly at: number;
  /** The board's watermark when this was asked. */
  readonly watermark: number | null;
  /** The version known when this was asked. */
  readonly version: number | null;
} & (
  | { readonly part: 'show'; readonly result: PortResult<TaskShow> }
  | { readonly part: 'progress'; readonly result: PortResult<TaskProgress> }
  | { readonly part: 'explain'; readonly result: PortResult<TaskExplain> }
  | { readonly part: 'history'; readonly result: PortResult<TaskHistory> }
  | { readonly part: 'content'; readonly result: PortResult<TaskContent> }
);

function answered<T>(part: Part<T>, r: PortResult<T>, m: DetailMessage): Part<T> {
  return r.ok
    ? { data: r.value, error: null, attemptAt: m.askedAt, readAt: m.at }
    : { ...part, error: r.error.message, attemptAt: m.askedAt };
}

function payloadText(payload: unknown): SafeText {
  const whole = JSON.stringify(payload) ?? '';
  return sanitize(whole.length > PAYLOAD_CHARS ? `${whole.slice(0, PAYLOAD_CHARS)}…` : whole);
}

function reasonOf(payload: unknown): SafeText | undefined {
  if (typeof payload !== 'object' || payload === null || !('reason' in payload)) return undefined;
  const { reason } = payload;
  return typeof reason === 'string' ? sanitize(reason) : undefined;
}

const ENDINGS = new Set(['TaskFailed', 'TaskCancelled']);

/** `system:effect_result` names a part of the daemon, which means nothing to whoever reads this. */
export const actorWords = (actor: SafeText): SafeText =>
  actor === 'system' || actor.startsWith('system:') ? uiText('Cuesura') : actor;

/** How a failed or cancelled task ended, by the event that ended it; `null` until the history has it. */
export function ending(
  d: TaskDetail,
): { readonly actor: SafeText; readonly reason: SafeText | null } | null {
  const e = d.history.events.findLast((ev) => ENDINGS.has(ev.type));
  return e === undefined ? null : { actor: actorWords(e.actor), reason: e.reason ?? null };
}

/** The task failed or was cancelled, by the daemon's latest word: its history has the event that says how. */
export function hasEnding(d: TaskDetail): boolean {
  const status = d.explain.data?.status;
  return status === 'FAILED' || status === 'CANCELLED';
}

function withHistory(
  d: TaskDetail,
  r: PortResult<TaskHistory>,
  at: number,
  version: number | null,
): TaskDetail {
  const h = d.history;
  if (!r.ok)
    return {
      ...d,
      history: { ...h, error: r.error.message, attemptAt: at },
    };
  const all = [
    ...h.events,
    ...r.value.events.map((e): HistoryLine => {
      const line = { seq: e.seq, type: e.type, actor: e.actor, payload: payloadText(e.payload) };
      const reason = ENDINGS.has(e.type) ? reasonOf(e.payload) : undefined;
      return reason === undefined ? line : { ...line, reason };
    }),
  ];
  const drop = Math.max(0, all.length - HISTORY_KEPT);
  return {
    ...d,
    history: {
      events: drop === 0 ? all : all.slice(drop),
      next: r.value.next_cursor,
      more: r.value.more,
      dropped: h.dropped + drop,
      version: version ?? h.version,
      error: null,
      attemptAt: at,
    },
  };
}

/** The request is left out: it is only shown, so failing to read it must not lock writes. */
function partFailed(d: TaskDetail): boolean {
  return (
    d.show.error !== null ||
    d.progress.error !== null ||
    d.explain.error !== null ||
    d.history.error !== null
  );
}

/** A read of the open task came back; one for a task no longer open is dropped. */
export function onDetailRead(state: TuiState, m: DetailMessage): TuiState {
  const d = state.detail;
  if (d === null || d.taskId !== m.taskId || d.session !== m.session) return state;
  // An answer asked before the connection came back says nothing about the task now.
  const since = state.recheck.get(d.taskId);
  const fresh = since === undefined || m.askedAt >= since;
  let next: TaskDetail;
  switch (m.part) {
    case 'show':
      next = {
        ...d,
        show: answered(d.show, m.result, m),
        showWanted: !fresh,
      };
      break;
    case 'progress':
      next = { ...d, progress: answered(d.progress, m.result, m) };
      break;
    case 'explain':
      next = {
        ...d,
        explain: answered(d.explain, m.result, m),
        explainWatermark: m.watermark,
      };
      break;
    case 'history':
      next = withHistory(d, m.result, m.askedAt, m.version);
      break;
    case 'content':
      next = { ...d, content: answered(d.content, m.result, m) };
      break;
  }
  const recheck = new Map(state.recheck);
  if (m.part === 'show' && fresh && m.result.ok) recheck.delete(d.taskId);
  const staleTasks = new Set(state.staleTasks);
  if (partFailed(next)) staleTasks.add(d.taskId);
  // A task that was stale stays so until its `task_show` is read again, whichever part answers first.
  else if (!recheck.has(d.taskId)) staleTasks.delete(d.taskId);
  return { ...state, detail: next, staleTasks, recheck };
}
