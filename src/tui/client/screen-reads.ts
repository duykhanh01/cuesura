/**
 * What the open screen reads, apart from the board and health of `refresh.ts`, which keep the connection (R-03).
 * Only the screen on top reads, and only while connected: a screen under another, or a lost connection, costs
 * the daemon nothing. Each kind of read runs one at a time. A failure stays with its part of the screen.
 */
import { actionsDue } from '../model/actions.ts';
import { detailDue, type DetailPartName } from '../model/detail.ts';
import { logDue, requestAttempt, LOG_PAGE_RECORDS } from '../model/logs.ts';
import type { Message } from '../model/messages.ts';
import { currentScreen, type TuiState } from '../model/state.ts';
import type { DaemonPort } from './daemon-port.ts';
import { DETAIL_TIMEOUT_MS, type RefreshClock } from './refresh.ts';

export type ScreenRead = {
  /** At most one read with the same key runs at a time. */
  readonly key: string;
  run(): Promise<Message>;
};

/** Far shorter than any read's period: this is how late a read may start, not how often one runs. */
const TICK_MS = 250;

export class ScreenReads {
  readonly #clock: RefreshClock;
  readonly #plan: (now: number) => readonly ScreenRead[];
  readonly #report: (m: Message) => void;
  readonly #running = new Set<string>();
  #timer: unknown = null;
  #stopped = false;

  constructor(opts: {
    clock: RefreshClock;
    plan: (now: number) => readonly ScreenRead[];
    report: (m: Message) => void;
  }) {
    this.#clock = opts.clock;
    this.#plan = opts.plan;
    this.#report = opts.report;
  }

  start(): void {
    this.#tick();
  }

  /** Look now: the screen changed, or an answer made the next read due. */
  kick(): void {
    if (this.#stopped) return;
    this.#begin();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #tick(): void {
    if (this.#stopped) return;
    this.#begin();
    this.#timer = this.#clock.setTimeout(() => this.#tick(), TICK_MS);
  }

  #begin(): void {
    for (const read of this.#plan(this.#clock.now())) {
      if (this.#running.has(read.key)) continue;
      this.#running.add(read.key);
      void read.run().then((message) => {
        this.#running.delete(read.key);
        if (this.#stopped) return;
        this.#report(message);
        this.#begin();
      });
    }
  }
}

function detailRead(
  s: TuiState,
  port: DaemonPort,
  clock: RefreshClock,
  part: DetailPartName,
  now: number,
): ScreenRead | null {
  const d = s.detail;
  if (d === null) return null;
  const common = {
    type: 'detail_read' as const,
    taskId: d.taskId,
    session: d.session,
    askedAt: now,
    watermark: s.board?.watermark ?? null,
    version: d.explain.data?.version ?? null,
  };
  const key = `detail:${part}`;
  switch (part) {
    case 'show':
      return {
        key,
        run: async () => ({
          ...common,
          part,
          result: await port.show(d.taskId, DETAIL_TIMEOUT_MS),
          at: clock.now(),
        }),
      };
    case 'progress':
      return {
        key,
        run: async () => ({
          ...common,
          part,
          result: await port.progress(d.taskId, DETAIL_TIMEOUT_MS),
          at: clock.now(),
        }),
      };
    case 'explain':
      return {
        key,
        run: async () => ({
          ...common,
          part,
          result: await port.explain(d.taskId, DETAIL_TIMEOUT_MS),
          at: clock.now(),
        }),
      };
    case 'history':
      return {
        key,
        run: async () => ({
          ...common,
          part,
          result: await port.history(d.taskId, d.history.next, DETAIL_TIMEOUT_MS),
          at: clock.now(),
        }),
      };
  }
}

function logsRead(
  s: TuiState,
  port: DaemonPort,
  clock: RefreshClock,
  now: number,
): ScreenRead | null {
  const logs = s.logs;
  if (logs === null) return null;
  const request = logDue(logs, now);
  if (request === null) return null;
  const attemptId = requestAttempt(logs, request);
  return {
    key: 'logs',
    run: async () => ({
      type: 'logs_read',
      taskId: logs.taskId,
      session: logs.session,
      generation: logs.generation,
      request,
      at: clock.now(),
      result: await port.logs(
        {
          taskId: logs.taskId,
          after: request.after,
          limit: request.kind === 'probe' ? 1 : LOG_PAGE_RECORDS,
          ...(attemptId === null ? {} : { attemptId }),
        },
        DETAIL_TIMEOUT_MS,
      ),
    }),
  };
}

/** `task_explain` of the open menu: its own read, never the one Task detail holds (FR-016). */
function actionsRead(
  s: TuiState,
  port: DaemonPort,
  clock: RefreshClock,
  now: number,
): ScreenRead | null {
  const m = s.actions;
  const watermark = s.board?.watermark ?? null;
  if (m === null || !actionsDue(m, watermark, now)) return null;
  return {
    key: 'actions',
    run: async () => ({
      type: 'actions_read',
      taskId: m.taskId,
      session: m.session,
      askedAt: now,
      watermark,
      result: await port.explain(m.taskId, DETAIL_TIMEOUT_MS),
      at: clock.now(),
    }),
  };
}

/** What is due right now for the screen on top. */
export function planScreenReads(
  s: TuiState,
  port: DaemonPort,
  clock: RefreshClock,
  now: number,
): readonly ScreenRead[] {
  // A new round of the connection is the board's call; after it, the times below bring the screen back.
  if (s.connection.kind !== 'online') return [];
  const reads: (ScreenRead | null)[] = [];
  switch (currentScreen(s)) {
    case 'detail':
      if (s.detail !== null)
        for (const part of detailDue(s.detail, s.board?.watermark ?? null, now))
          reads.push(detailRead(s, port, clock, part, now));
      break;
    case 'logs':
      reads.push(logsRead(s, port, clock, now));
      // The stages beside the log stay as current as Task detail keeps them; its history waits for it.
      if (s.detail !== null) {
        const due = detailDue(s.detail, s.board?.watermark ?? null, now).filter(
          (p) => p !== 'history',
        );
        if (s.detail.showWanted && !due.includes('show')) due.push('show');
        for (const part of due) reads.push(detailRead(s, port, clock, part, now));
      }
      break;
    case 'actions':
      reads.push(actionsRead(s, port, clock, now));
      break;
    default:
      break;
  }
  return reads.filter((r) => r !== null);
}
