import { mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ok, type Result } from '../../../src/shared/result.ts';
import type { ClientError, DaemonReply } from '../../../src/cli/client.ts';
import {
  createDaemonPort,
  type PortError,
  type PortResult,
} from '../../../src/tui/client/daemon-port.ts';
import {
  BACKOFF_MAX_MS,
  backoffMs,
  BOARD_TIMEOUT_MS,
  DETAIL_TIMEOUT_MS,
  HEALTH_TIMEOUT_MS,
  REFRESH_INTERVAL_MS,
  RefreshScheduler,
  RUN_OPTIONS_TIMEOUT_MS,
  type RefreshClock,
  type RoundResult,
} from '../../../src/tui/client/refresh.ts';
import type { BoardReply, Health, ProjectList } from '../../../src/tui/client/schemas.ts';
import { reduce } from '../../../src/tui/model/reduce.ts';
import {
  boardQueryKey,
  initialState,
  nextConnection,
  RECONNECT_ATTEMPTS,
  retryConnection,
  type Connection,
  type TuiState,
} from '../../../src/tui/model/state.ts';
import { uiText } from '../../../src/tui/terminal/safe-text.ts';

const HEALTH: Health = {
  healthy: true,
  reason: null,
  slot: null,
  queue_length: 0,
};
const BOARD = { unchanged: true, watermark: 1 } as BoardReply;
const REFUSED: PortError = {
  kind: 'connection',
  message: uiText('ECONNREFUSED'),
};

class FakeClock implements RefreshClock {
  t = 0;
  #next = 1;
  readonly timers = new Map<number, { at: number; run: () => void }>();
  now = (): number => this.t;
  setTimeout = (run: () => void, ms: number): number => {
    const id = this.#next++;
    this.timers.set(id, { at: this.t + ms, run });
    return id;
  };
  clearTimeout = (h: unknown): void => {
    this.timers.delete(h as number);
  };
  /** Moves time forward, firing what falls due, letting promise callbacks run in between. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await settle();
      const due = [...this.timers.entries()]
        .filter(([, v]) => v.at <= end)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].run();
    }
    this.t = end;
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function harness(
  answer: {
    board?: (fresh: boolean) => Promise<PortResult<BoardReply>>;
    health?: () => Promise<PortResult<Health>>;
    projects?: (
      fresh: boolean,
      timeoutMs: number,
      signal: AbortSignal,
    ) => Promise<PortResult<ProjectList | null>>;
  } = {},
) {
  const clock = new FakeClock();
  let connection: Connection = { kind: 'connecting' };
  const boards: {
    at: number;
    fresh: boolean;
    timeoutMs: number;
    signal: AbortSignal;
  }[] = [];
  const healths: { at: number; timeoutMs: number }[] = [];
  const reports: RoundResult[] = [];
  const scheduler = new RefreshScheduler({
    clock,
    reads: {
      ...(answer.projects === undefined ? {} : { projects: answer.projects }),
      board: (fresh, timeoutMs, signal) => {
        boards.push({ at: clock.t, fresh, timeoutMs, signal });
        return answer.board?.(fresh) ?? Promise.resolve({ ok: true, value: BOARD });
      },
      health: (timeoutMs) => {
        healths.push({ at: clock.t, timeoutMs });
        return answer.health?.() ?? Promise.resolve({ ok: true, value: HEALTH });
      },
    },
    report: (r) => {
      reports.push(r);
      connection = nextConnection(connection, r.ok ? { ok: true } : r.failure);
      return connection;
    },
  });
  return {
    clock,
    scheduler,
    boards,
    healths,
    reports,
    connection: () => connection,
    setConnection: (c: Connection) => {
      connection = c;
    },
  };
}

const refused = (): Promise<PortResult<BoardReply>> =>
  Promise.resolve({ ok: false, error: REFUSED });

describe('backoff', () => {
  it('doubles from 250 ms to a 5 second ceiling, with no jitter', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 30].map(backoffMs)).toEqual([
      250, 500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000,
    ]);
    expect(BACKOFF_MAX_MS).toBe(5_000);
  });
});

describe('RefreshScheduler', () => {
  it('uses the timeouts of R-03', () => {
    expect([
      BOARD_TIMEOUT_MS,
      HEALTH_TIMEOUT_MS,
      DETAIL_TIMEOUT_MS,
      RUN_OPTIONS_TIMEOUT_MS,
    ]).toEqual([2_000, 2_000, 3_000, 5_000]);
  });

  it('reads board and health together, once a second while online', async () => {
    const h = harness();
    h.scheduler.start();
    await h.clock.advance(3_100);
    expect(h.boards.map((b) => b.at)).toEqual([0, 1_000, 2_000, 3_000]);
    expect(h.healths.map((x) => x.at)).toEqual([0, 1_000, 2_000, 3_000]);
    expect(h.boards.every((b) => b.timeoutMs === 2_000)).toBe(true);
    expect(h.healths.every((x) => x.timeoutMs === 2_000)).toBe(true);
    h.scheduler.stop();
  });

  it('asks for real data first, and for changes only afterwards', async () => {
    const h = harness();
    h.scheduler.start();
    await h.clock.advance(1_100);
    expect(h.boards.map((b) => b.fresh)).toEqual([true, false]);
    h.scheduler.stop();
  });

  it('never has more than one read of each kind in progress', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((r) => (release = r));
    const h = harness({
      board: async () => {
        await held;
        return { ok: true, value: BOARD };
      },
    });
    h.scheduler.start();
    await h.clock.advance(1_900);
    expect(h.boards).toHaveLength(1);
    expect(h.healths).toHaveLength(1);
    release();
    await h.clock.advance(100);
    h.scheduler.stop();
  });

  it('a read that takes long delays the next, without piling up', async () => {
    const h = harness({
      board: async () => {
        await new Promise<void>((r) => h.clock.setTimeout(r, 1_500));
        return { ok: true, value: BOARD };
      },
    });
    h.scheduler.start();
    await h.clock.advance(1_600);
    expect(h.boards.map((b) => b.at)).toEqual([0, 1_500]);
    h.scheduler.stop();
  });

  it('a read that never answers fails at its timeout', async () => {
    const h = harness({
      board: () => new Promise(() => undefined),
    });
    h.scheduler.start();
    await h.clock.advance(1_999);
    expect(h.reports).toEqual([]);
    await h.clock.advance(1);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({
      ok: false,
      failure: { permanent: null },
    });
    expect(h.connection()).toEqual({ kind: 'reconnecting', attempt: 1 });
    h.scheduler.stop();
  });

  it('cancels the read at its timeout, before the next round starts', async () => {
    const h = harness({ board: () => new Promise(() => undefined) });
    h.scheduler.start();
    await h.clock.advance(1_999);
    expect(h.boards[0]?.signal.aborted).toBe(false);
    await h.clock.advance(1);
    expect(h.boards[0]?.signal.aborted).toBe(true);
    expect(h.boards).toHaveLength(1);
    await h.clock.advance(250);
    expect(h.boards).toHaveLength(2);
    expect(h.boards[1]?.signal.aborted).toBe(false);
    h.scheduler.stop();
  });

  it('stop cancels what is running', async () => {
    const h = harness({ board: () => new Promise(() => undefined) });
    h.scheduler.start();
    await h.clock.advance(1);
    h.scheduler.stop();
    expect(h.boards[0]?.signal.aborted).toBe(true);
  });

  it('a late answer after the timeout is ignored', async () => {
    let answer = (_: PortResult<BoardReply>): void => undefined;
    const h = harness({
      board: () => new Promise((resolve) => (answer = resolve)),
    });
    h.scheduler.start();
    await h.clock.advance(2_000);
    answer({ ok: true, value: BOARD });
    await h.clock.advance(1);
    expect(h.reports).toHaveLength(1);
    h.scheduler.stop();
  });

  it('counts a success only when both reads succeed, and a retry reads for real', async () => {
    let up = false;
    const h = harness({
      board: () => (up ? Promise.resolve({ ok: true, value: BOARD }) : refused()),
    });
    h.scheduler.start();
    await h.clock.advance(1);
    expect(h.connection()).toEqual({ kind: 'reconnecting', attempt: 1 });
    up = true;
    await h.clock.advance(250);
    expect(h.connection()).toEqual({ kind: 'online' });
    expect(h.boards.at(-1)?.fresh).toBe(true);
    h.scheduler.stop();
  });

  it('health failing alone fails the round', async () => {
    const h = harness({
      health: () => Promise.resolve({ ok: false, error: REFUSED }),
    });
    h.scheduler.start();
    await h.clock.advance(1);
    expect(h.reports[0]?.ok).toBe(false);
    h.scheduler.stop();
  });

  it('backs off with each failure and stops after 30 attempts, about two minutes', async () => {
    const h = harness({ board: refused });
    h.scheduler.start();
    await h.clock.advance(600_000);
    expect(h.connection()).toEqual({ kind: 'waiting_retry' });
    // The first read, then one per attempt; each attempt is a real read, there is no probe.
    expect(h.boards).toHaveLength(RECONNECT_ATTEMPTS + 1);
    expect(h.healths).toHaveLength(RECONNECT_ATTEMPTS + 1);
    const gaps = h.boards.slice(1).map((b, i) => b.at - (h.boards[i]?.at ?? 0));
    expect(gaps.slice(0, 7)).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
    expect(Math.max(...gaps)).toBe(5_000);
    const total = h.boards.at(-1)?.at ?? 0;
    expect(total).toBeGreaterThan(110_000);
    expect(total).toBeLessThan(140_000);
    expect(h.clock.timers.size).toBe(0);
    await h.clock.advance(3_600_000);
    expect(h.boards).toHaveLength(RECONNECT_ATTEMPTS + 1);
  });

  it('retry starts a new round with the same limit', async () => {
    const h = harness({ board: refused });
    h.scheduler.start();
    await h.clock.advance(600_000);
    const before = h.boards.length;
    h.setConnection(retryConnection(h.connection()) as Connection);
    h.scheduler.retry();
    await h.clock.advance(600_000);
    expect(h.connection()).toEqual({ kind: 'waiting_retry' });
    expect(h.boards.length - before).toBe(RECONNECT_ATTEMPTS);
  });

  it('retry reads at once and goes online when the daemon is back', async () => {
    let up = false;
    const h = harness({
      board: () => (up ? Promise.resolve({ ok: true, value: BOARD }) : refused()),
    });
    h.scheduler.start();
    await h.clock.advance(600_000);
    up = true;
    h.setConnection(retryConnection(h.connection()) as Connection);
    const at = h.clock.t;
    h.scheduler.retry();
    await h.clock.advance(0);
    expect(h.connection()).toEqual({ kind: 'online' });
    expect(h.boards.at(-1)).toMatchObject({ at, fresh: true });
    h.scheduler.stop();
  });

  it.each(['token', 'unauthenticated', 'incompatible'] as const)(
    'a %s failure stops at once, with no retry on its own',
    async (kind) => {
      const h = harness({
        board: () =>
          Promise.resolve({
            ok: false,
            error: { kind, message: uiText('why') },
          }),
      });
      h.scheduler.start();
      await h.clock.advance(1);
      expect(h.connection()).toEqual({
        kind: 'stopped',
        reason: { kind, message: 'why' },
      });
      await h.clock.advance(600_000);
      expect(h.boards).toHaveLength(1);
    },
  );

  it('a read the token may no longer make stops at once (EC-008)', async () => {
    const message = uiText('requires project beta');
    const h = harness({
      board: () =>
        Promise.resolve({
          ok: false,
          error: { kind: 'rejected', code: 'forbidden', message },
        }),
    });
    h.scheduler.start();
    await h.clock.advance(1);
    expect(h.connection()).toEqual({
      kind: 'stopped',
      reason: { kind: 'forbidden', message },
    });
    await h.clock.advance(600_000);
    expect(h.boards).toHaveLength(1);
  });

  it('a rejected read may pass, so it is retried', async () => {
    const h = harness({
      board: () =>
        Promise.resolve({
          ok: false,
          error: { kind: 'rejected', code: 'x', message: uiText('m') },
        }),
    });
    h.scheduler.start();
    await h.clock.advance(1);
    expect(h.connection()).toEqual({ kind: 'reconnecting', attempt: 1 });
    h.scheduler.stop();
  });

  it('bounds project-list retries even when board and health succeed', async () => {
    let reads = 0;
    const h = harness({
      projects: () => {
        reads += 1;
        return Promise.resolve({ ok: false, error: REFUSED });
      },
    });
    h.scheduler.start();
    await h.clock.advance(600_000);
    expect(h.connection()).toEqual({ kind: 'waiting_retry' });
    expect(reads).toBe(RECONNECT_ATTEMPTS + 1);
    expect(h.boards.every((b) => b.fresh)).toBe(true);
    await h.clock.advance(600_000);
    expect(reads).toBe(RECONNECT_ATTEMPTS + 1);
  });

  it('cancels a stalled project read at its deadline and discards a late answer', async () => {
    let release = (_: PortResult<ProjectList | null>): void => undefined;
    let signal: AbortSignal | undefined;
    const h = harness({
      projects: (_fresh, ms, s) => {
        expect(ms).toBe(BOARD_TIMEOUT_MS);
        signal = s;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    h.scheduler.start();
    await h.clock.advance(BOARD_TIMEOUT_MS - 1);
    expect(h.reports).toEqual([]);
    expect(signal?.aborted).toBe(false);
    await h.clock.advance(1);
    expect(signal?.aborted).toBe(true);
    expect(h.connection()).toEqual({ kind: 'reconnecting', attempt: 1 });
    release({ ok: true, value: null });
    await settle();
    expect(h.reports).toHaveLength(1);
    h.scheduler.stop();
  });

  it('retry while a read is running reads right after it', async () => {
    let release = (_: PortResult<BoardReply>): void => undefined;
    const h = harness({
      board: () => new Promise((r) => (release = r)),
    });
    h.scheduler.start();
    h.scheduler.retry();
    expect(h.boards).toHaveLength(1);
    release({ ok: true, value: BOARD });
    await h.clock.advance(0);
    expect(h.boards).toHaveLength(2);
    expect(h.boards[1]?.fresh).toBe(true);
    h.scheduler.stop();
  });

  it('nothing happens after stop', async () => {
    const h = harness();
    h.scheduler.start();
    await h.clock.advance(1);
    h.scheduler.stop();
    h.scheduler.retry();
    await h.clock.advance(10_000);
    expect(h.boards).toHaveLength(1);
    expect(REFRESH_INTERVAL_MS).toBe(1_000);
  });
});

describe('another token while a round is out (EC-008, EC-009)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Round by round, the scheduler as `runTui` uses it, with a generation a test moves by hand. */
  function rounds(board: () => Promise<PortResult<BoardReply>>) {
    const clock = new FakeClock();
    let credential = 0;
    const fresh: boolean[] = [];
    const reports: RoundResult[] = [];
    let superseded = 0;
    let onBoard = (): void => undefined;
    let onHealth = (): void => undefined;
    const scheduler = new RefreshScheduler({
      clock,
      reads: {
        board: (f) => {
          fresh.push(f);
          onBoard();
          return board();
        },
        health: () => {
          onHealth();
          return Promise.resolve({ ok: true, value: HEALTH });
        },
      },
      credential: {
        generation: () => credential,
        superseded: () => {
          superseded += 1;
        },
      },
      report: (r) => {
        reports.push(r);
        return nextConnection({ kind: 'online' }, r.ok ? { ok: true } : r.failure);
      },
    });
    return {
      clock,
      scheduler,
      fresh,
      reports,
      superseded: () => superseded,
      /** Once, on the next read of that kind, as a token file changing at that moment would. */
      changeOn(read: 'board' | 'health') {
        const change = (): void => {
          credential += 1;
          onBoard = onHealth = () => undefined;
        };
        if (read === 'board') onBoard = change;
        else onHealth = change;
      },
      change() {
        credential += 1;
      },
    };
  }

  const answer = (): Promise<PortResult<BoardReply>> => Promise.resolve({ ok: true, value: BOARD });

  it('throws away a round whose board went out before the change, and reads again at once', async () => {
    const h = rounds(answer);
    h.changeOn('health');
    h.scheduler.start();
    await settle();
    expect(h.superseded()).toBe(1);
    expect(h.fresh).toEqual([true, true]);
    expect(h.reports).toHaveLength(1);
    h.scheduler.stop();
  });

  it('keeps a round whose board is the first to see the change: the new token asked it', async () => {
    const h = rounds(answer);
    h.changeOn('board');
    h.scheduler.start();
    await settle();
    expect(h.superseded()).toBe(0);
    expect(h.reports).toEqual([{ ok: true, board: BOARD, health: HEALTH }]);
    h.scheduler.stop();
  });

  it('a refusal for the old token stops nothing: the new one has not been asked', async () => {
    const forbidden: PortResult<BoardReply> = {
      ok: false,
      error: {
        kind: 'rejected',
        code: 'forbidden',
        message: uiText('requires project beta'),
      },
    };
    const replies = [forbidden, { ok: true, value: BOARD } as const];
    const h = rounds(() => Promise.resolve(replies.shift() ?? { ok: true, value: BOARD }));
    h.changeOn('health');
    h.scheduler.start();
    await settle();
    expect(h.superseded()).toBe(1);
    expect(h.reports).toEqual([{ ok: true, board: BOARD, health: HEALTH }]);
    h.scheduler.stop();
  });

  it('a change while the answer is on its way throws it away too, and leaves one chain of reads', async () => {
    let release = (_: PortResult<BoardReply>): void => undefined;
    const held: Promise<PortResult<BoardReply>> = new Promise((r) => {
      release = r;
    });
    const replies = [held];
    const h = rounds(() => replies.shift() ?? answer());
    h.scheduler.start();
    await settle();
    h.change();
    release({ ok: true, value: BOARD });
    await settle();
    expect(h.superseded()).toBe(1);
    expect(h.reports).toHaveLength(1);
    await h.clock.advance(2_100);
    expect(h.fresh).toHaveLength(4);
    h.scheduler.stop();
  });

  it('nothing runs after stop', async () => {
    let release = (_: PortResult<BoardReply>): void => undefined;
    const h = rounds(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    h.scheduler.start();
    await settle();
    h.change();
    h.scheduler.stop();
    release({ ok: true, value: BOARD });
    await h.clock.advance(5_000);
    expect(h.superseded()).toBe(0);
    expect(h.fresh).toHaveLength(1);
  });

  // The real port, scheduler and reducer: the state the finding was seen in. The file is swapped from inside the
  // board call, which is exactly between the token read for the board and the one for the health.
  it("never shows the old token's list as current beside the new caller", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-rotate-')));
    dirs.push(dir);
    const OLD = 'a'.repeat(43);
    const NEW = 'b'.repeat(43);
    const file = join(dir, 'owner.token');
    const writeToken = (token: string): void => {
      writeFileSync(`${file}.new`, `${token}\n`, { mode: 0o600 });
      renameSync(`${file}.new`, file);
    };
    writeToken(OLD);

    const row = (project: string) => ({
      task_id: `019a0000-0000-7000-8000-00000000000${project === 'acme' ? 1 : 2}`,
      project,
      title: `In ${project}`,
      status: 'WAITING',
      wait_code: 'agent_question',
      step: 'code',
      mode: 'direct-pr',
      status_since: 1,
      version: 3,
      priority: 0,
      pr_ref: null,
      needs_user: false,
    });
    const items: Record<string, unknown[]> = {
      [OLD]: [row('acme'), row('beta')],
      [NEW]: [row('acme')],
    };
    const projects: Record<string, string[]> = {
      [OLD]: ['acme', 'beta'],
      [NEW]: ['acme'],
    };
    const WATERMARK = 7;
    let swapOnBoard = false;
    const envelope = (data: unknown): Result<DaemonReply, ClientError> =>
      ok({
        status: 200,
        envelope: { schema_version: 1, ok: true, data, error: null },
      });
    const port = createDaemonPort({
      dataDir: dir,
      env: {},
      call: (o) => {
        const token = o.token;
        const body = o.body as { kind: string; if_changed_since?: number } | undefined;
        if (body === undefined)
          return Promise.resolve(
            envelope({
              store: { writable: true },
              dispatch: {},
              slot: null,
              queue_length: 0,
              now: 1,
            }),
          );
        if (body.kind === 'project_list')
          return Promise.resolve(
            envelope({
              caller: {
                actor: 'x',
                roles: ['read'],
                scope: token === NEW ? 'limited' : 'all',
                trusted_confirmer: false,
              },
              projects: projects[token]?.map((id) => ({ id, repo: null })),
              profiles: [],
            }),
          );
        if (swapOnBoard) {
          swapOnBoard = false;
          writeToken(NEW);
        }
        return Promise.resolve(
          envelope(
            body.if_changed_since === WATERMARK
              ? { unchanged: true, watermark: WATERMARK }
              : {
                  unchanged: false,
                  watermark: WATERMARK,
                  items: items[token],
                  next_cursor: null,
                  counts: { by_status: { WAITING: items[token]?.length ?? 0 } },
                  attention: { items: [], truncated: false },
                  queue: { length: 0 },
                  terminal_policy: {},
                  slot: null,
                },
          ),
        );
      },
    });

    const clock = new FakeClock();
    let state: TuiState = initialState({ cols: 100, rows: 30 });
    const seen: TuiState[] = [];
    let credential = port.credentialGeneration();
    const dispatch = (m: Parameters<typeof reduce>[1]): void => {
      state = reduce(state, m).state;
      seen.push(state);
    };
    const notice = (): void => {
      if (port.credentialGeneration() === credential) return;
      credential = port.credentialGeneration();
      dispatch({ type: 'credential_changed' });
    };
    const scheduler = new RefreshScheduler({
      clock,
      reads: {
        board: (fresh, ms, signal) =>
          port.board(
            fresh || state.board === null ? {} : { if_changed_since: state.board.watermark },
            ms,
            signal,
          ),
        health: (ms, signal) => port.health(ms, signal),
        projects: (fresh, ms, signal) =>
          fresh || state.caller === null || port.credentialGeneration() !== credential
            ? port.projects(ms, signal)
            : Promise.resolve({ ok: true, value: null }),
      },
      credential: {
        generation: () => port.credentialGeneration(),
        superseded: notice,
      },
      report: (r) => {
        notice();
        dispatch(
          r.ok
            ? {
                type: 'read_succeeded',
                board: r.board,
                health: r.health,
                at: clock.t,
                queryKey: boardQueryKey(state),
                ...(r.projects === undefined ? {} : { projects: r.projects }),
              }
            : { type: 'read_failed', failure: r.failure },
        );
        return state.connection;
      },
    });
    const titles = (s: TuiState): string[] => (s.board?.items ?? []).map((t) => String(t.title));

    scheduler.start();
    await clock.advance(10);
    expect(titles(state)).toEqual(['In acme', 'In beta']);
    expect(state.connection.kind).toBe('online');

    seen.length = 0;
    swapOnBoard = true;
    await clock.advance(1_000);
    scheduler.stop();

    expect(titles(state)).toEqual(['In acme']);
    expect(state.projects?.map((p) => p.id)).toEqual(['acme']);
    expect(state.connection.kind).toBe('online');
    expect(state.stale).toBe(false);
    // Not for one frame: the old list is only ever on screen marked as out of date.
    const claimedCurrent = seen.filter((s) => titles(s).includes('In beta') && !s.stale);
    expect(claimedCurrent).toEqual([]);
  });
});
