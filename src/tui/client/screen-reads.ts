/**
 * What the open screen reads, apart from the board and health of `refresh.ts`, which keep the connection (R-03).
 * Only the screen on top reads, and only while connected: a screen under another, or a lost connection, costs
 * the daemon nothing. Each kind of read runs one at a time. A failure stays with its part of the screen.
 */
import { actionsDue, actionsShowDue } from '../model/actions.ts';
import { contentDue, detailDue, hasEnding, type DetailPartName } from '../model/detail.ts';
import { dialogDue, questionView } from '../model/dialog.ts';
import { gateLogDue, gatesDue } from '../model/gates.ts';
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
    case 'content':
      return {
        key,
        run: async () => ({
          ...common,
          part,
          result: await port.content(d.taskId, DETAIL_TIMEOUT_MS),
          at: clock.now(),
        }),
      };
  }
}

/** The list of rounds and the log of the chosen gate: read while that is what the screen shows. */
function gatesReads(
  s: TuiState,
  port: DaemonPort,
  clock: RefreshClock,
  now: number,
): readonly ScreenRead[] {
  const logs = s.logs;
  const view = logs?.gates ?? null;
  if (logs === null || view === null) return [];
  const reads: ScreenRead[] = [];
  const common = { taskId: logs.taskId, session: logs.session, generation: view.generation };
  if (gatesDue(view, now))
    reads.push({
      key: 'gates',
      run: async () => ({
        ...common,
        type: 'gates_read',
        result: await port.gates(logs.taskId, DETAIL_TIMEOUT_MS),
        at: clock.now(),
      }),
    });
  const request = gateLogDue(view, now);
  if (request !== null)
    reads.push({
      key: 'gate_log',
      run: async () => ({
        ...common,
        type: 'gate_log_read',
        request,
        result: await port.gateLog({ taskId: logs.taskId, ...request }, DETAIL_TIMEOUT_MS),
        at: clock.now(),
      }),
    });
  return reads;
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
          ...(request.kind === 'tail' ? { tail: true } : {}),
          ...(attemptId === null ? {} : { attemptId }),
        },
        DETAIL_TIMEOUT_MS,
      ),
    }),
  };
}

/** `task_explain` of the open menu: its own read, never the one Task detail holds (FR-016). */
function actionsReads(
  s: TuiState,
  port: DaemonPort,
  clock: RefreshClock,
  now: number,
): readonly ScreenRead[] {
  const m = s.actions;
  const watermark = s.board?.watermark ?? null;
  if (m === null) return [];
  const reads: ScreenRead[] = [];
  if (actionsDue(m, watermark, now))
    reads.push({
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
    });
  // `task_show` carries the project and version a write goes out with, and unlocks a stale task.
  if (actionsShowDue(m, watermark, now))
    reads.push({
      key: 'actions:show',
      run: async () => ({
        type: 'actions_show_read',
        taskId: m.taskId,
        session: m.session,
        askedAt: now,
        watermark,
        result: await port.show(m.taskId, DETAIL_TIMEOUT_MS),
        at: clock.now(),
      }),
    });
  return reads;
}

/** What the open dialog shows beyond its task's menu: the question, or where the worktree is. */
function dialogReads(
  s: TuiState,
  port: DaemonPort,
  clock: RefreshClock,
  now: number,
): readonly ScreenRead[] {
  const d = s.dialog;
  const taskId = d?.taskId ?? null;
  if (d === null || taskId === null) return [];
  const watermark = s.board?.watermark ?? null;
  const common = { taskId, session: d.session, askedAt: now, watermark };
  const questionId = (): string => questionView(d, s.actions?.explain.data ?? null).id ?? '';
  return dialogDue(d, s.actions?.explain.data ?? null, watermark, now).map((part): ScreenRead => ({
    key: `dialog:${part}`,
    run: async () => {
      switch (part) {
        case 'inbox':
          return {
            ...common,
            type: 'dialog_read',
            part,
            result: await port.inbox(taskId, DETAIL_TIMEOUT_MS),
            at: clock.now(),
          };
        case 'question':
          return {
            ...common,
            type: 'dialog_read',
            part,
            result: await port.question(questionId(), DETAIL_TIMEOUT_MS),
            at: clock.now(),
          };
        case 'progress':
          return {
            ...common,
            type: 'dialog_read',
            part,
            result: await port.progress(taskId, DETAIL_TIMEOUT_MS),
            at: clock.now(),
          };
      }
    },
  }));
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
      if (s.detail !== null) {
        const due = [...detailDue(s.detail, s.board?.watermark ?? null, now)];
        // A task read again after a lost connection must not wait for its version to change.
        if (s.detail.showWanted && !due.includes('show')) due.push('show');
        if (contentDue(s.detail, now)) due.push('content');
        for (const part of due) reads.push(detailRead(s, port, clock, part, now));
      }
      break;
    case 'logs':
      reads.push(logsRead(s, port, clock, now), ...gatesReads(s, port, clock, now));
      // The stages beside the log stay as current as Task detail keeps them. Its history waits for it,
      // unless the task has ended: how it ended is told only there.
      if (s.detail !== null) {
        const over = hasEnding(s.detail);
        const due = detailDue(s.detail, s.board?.watermark ?? null, now).filter(
          (p) => p !== 'history' || over,
        );
        if (s.detail.showWanted && !due.includes('show')) due.push('show');
        for (const part of due) reads.push(detailRead(s, port, clock, part, now));
      }
      break;
    case 'actions':
      reads.push(...actionsReads(s, port, clock, now));
      break;
    case 'dialog':
      // The menu under a task dialog keeps its version and its list current: the dialog sends with them.
      if (s.dialog?.taskId != null && s.actions !== null)
        reads.push(...actionsReads(s, port, clock, now), ...dialogReads(s, port, clock, now));
      break;
    default:
      break;
  }
  return reads.filter((r) => r !== null);
}
