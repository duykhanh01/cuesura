/**
 * When to read (R-03, FR-009, FR-039). The clock is injected so the limits are tested without waiting. There
 * is no probe: each attempt is a real read, so "connected" always comes with data. Which connection state
 * follows a read is the reducer's call; this only asks and plans the next read from the answer.
 */
import type { Connection, ReadOutcome, StopReason } from '../model/state.ts';
import type { BoardReply, Health, ProjectList } from './schemas.ts';
import type { PortError, PortResult } from './daemon-port.ts';
import { sanitize } from '../terminal/safe-text.ts';

export const REFRESH_INTERVAL_MS = 1_000;
export const BOARD_TIMEOUT_MS = 2_000;
export const HEALTH_TIMEOUT_MS = 2_000;
/** Other reads on an open screen. */
export const DETAIL_TIMEOUT_MS = 3_000;
/** `run_options` reads Git locally. */
export const RUN_OPTIONS_TIMEOUT_MS = 5_000;
export const LOG_POLL_INTERVAL_MS = 1_000;
export const EXPLAIN_REFRESH_MS = 5_000;
export const BACKOFF_START_MS = 250;
export const BACKOFF_MAX_MS = 5_000;

/** Doubles from 250 ms up to 5 seconds, no jitter: there is one client, so no crowd to spread out. */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_START_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
}

export type RefreshClock = {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
};

export const systemRefreshClock: RefreshClock = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  now: () => Date.now(),
};

/** The signal fires when the scheduler stops waiting; the read must close its connection then. */
export type RefreshReads = {
  /** `fresh`: no watermark, after a failure the data must be read for real. */
  board(fresh: boolean, timeoutMs: number, signal: AbortSignal): Promise<PortResult<BoardReply>>;
  health(timeoutMs: number, signal: AbortSignal): Promise<PortResult<Health>>;
  /** Read metadata on first load or reconnect; otherwise reuse the cached value. */
  projects?(
    fresh: boolean,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<PortResult<ProjectList | null>>;
};

export type RoundResult =
  | {
      readonly ok: true;
      readonly board: BoardReply;
      readonly health: Health;
      readonly projects?: ProjectList;
    }
  | {
      readonly ok: false;
      readonly failure: Extract<ReadOutcome, { ok: false }>;
    };

/** Failures that retrying cannot fix end the automatic attempts at once. */
function stopReason(e: PortError): StopReason | null {
  // The caller may not read this: asking again gets the same answer until someone changes that (EC-008).
  if (e.kind === 'rejected' && e.code === 'forbidden')
    return { kind: 'forbidden', message: e.message };
  return e.kind === 'actor' || e.kind === 'unauthenticated' || e.kind === 'incompatible'
    ? { kind: e.kind, message: e.message }
    : null;
}

export class RefreshScheduler {
  readonly #clock: RefreshClock;
  readonly #reads: RefreshReads;
  readonly #report: (r: RoundResult) => Connection;
  #timer: unknown = null;
  readonly #inFlight = new Set<AbortController>();
  #reading = false;
  #retryAfterRead = false;
  #stopped = false;
  /** After a failure or at the start the next read must bring real data. */
  #fresh = true;

  constructor(opts: {
    clock: RefreshClock;
    reads: RefreshReads;
    /** Hands the result to the reducer and returns the connection state that follows. */
    report: (r: RoundResult) => Connection;
  }) {
    this.#clock = opts.clock;
    this.#reads = opts.reads;
    this.#report = opts.report;
  }

  start(): void {
    this.#read();
  }

  /** The user asked to try again: at once, or right after the read in progress. */
  retry(): void {
    if (this.#stopped) return;
    this.#clearTimer();
    this.#fresh = true;
    if (this.#reading) this.#retryAfterRead = true;
    else this.#read();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimer();
    for (const read of this.#inFlight) read.abort();
  }

  #clearTimer(): void {
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  /**
   * A read cannot outlast its timeout, even if the response trickles in or never ends, and it does not go on
   * behind the next one: its request is cancelled before the round can end (R-03).
   */
  #bounded<T>(
    read: (signal: AbortSignal) => Promise<PortResult<T>>,
    timeoutMs: number,
  ): Promise<PortResult<T>> {
    const controller = new AbortController();
    this.#inFlight.add(controller);
    return new Promise((settle) => {
      const timer = this.#clock.setTimeout(() => {
        this.#inFlight.delete(controller);
        controller.abort();
        settle({
          ok: false,
          error: {
            kind: 'timeout',
            message: sanitize(`no answer within ${timeoutMs} ms`),
          },
        });
      }, timeoutMs);
      void read(controller.signal).then((r) => {
        this.#clock.clearTimeout(timer);
        this.#inFlight.delete(controller);
        settle(r);
      });
    });
  }

  #read(): void {
    if (this.#stopped || this.#reading) return;
    this.#reading = true;
    const startedAt = this.#clock.now();
    const fresh = this.#fresh;
    const board = this.#bounded(
      (signal) => this.#reads.board(fresh, BOARD_TIMEOUT_MS, signal),
      BOARD_TIMEOUT_MS,
    );
    const health = this.#bounded(
      (signal) => this.#reads.health(HEALTH_TIMEOUT_MS, signal),
      HEALTH_TIMEOUT_MS,
    );
    const projects = this.#reads.projects?.bind(this.#reads);
    const metadata =
      projects === undefined
        ? Promise.resolve({ ok: true, value: null } as const)
        : this.#bounded((signal) => projects(fresh, BOARD_TIMEOUT_MS, signal), BOARD_TIMEOUT_MS);
    void Promise.all([board, health, metadata]).then(([b, h, p]) => {
      this.#reading = false;
      if (this.#stopped) return;
      this.#finish(b, h, p, startedAt);
    });
  }

  #finish(
    board: PortResult<BoardReply>,
    health: PortResult<Health>,
    projects: PortResult<ProjectList | null>,
    startedAt: number,
  ): void {
    const result = toResult(board, health, projects);
    this.#fresh = !result.ok;
    const connection = this.#report(result);
    if (this.#retryAfterRead) {
      this.#retryAfterRead = false;
      this.#fresh = true;
      this.#read();
      return;
    }
    if (connection.kind === 'online')
      this.#schedule(Math.max(0, startedAt + REFRESH_INTERVAL_MS - this.#clock.now()));
    else if (connection.kind === 'reconnecting') this.#schedule(backoffMs(connection.attempt));
    // `waiting_retry` and `stopped` wait for `retry()`: nothing starts a new round on its own.
  }

  #schedule(ms: number): void {
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      this.#read();
    }, ms);
  }
}

function toResult(
  board: PortResult<BoardReply>,
  health: PortResult<Health>,
  projects: PortResult<ProjectList | null>,
): RoundResult {
  if (board.ok && health.ok && projects.ok)
    return {
      ok: true,
      board: board.value,
      health: health.value,
      ...(projects.value === null ? {} : { projects: projects.value }),
    };
  const errors = [board, health, projects].flatMap((r) => (r.ok ? [] : [r.error]));
  const permanent = errors.map(stopReason).find((reason) => reason !== null) ?? null;
  const message = errors[0]?.message;
  return {
    ok: false,
    failure: {
      ok: false,
      permanent,
      ...(message === undefined ? {} : { message }),
    },
  };
}
