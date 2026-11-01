import { describe, expect, it } from 'vitest';
import type {
  BoardReply,
  ProjectList,
  Health,
} from '../../../src/tui/client/schemas.ts';
import { reduce } from '../../../src/tui/model/reduce.ts';
import {
  initialState,
  nextConnection,
  RECONNECT_ATTEMPTS,
  retryConnection,
  type Connection,
  type StopReason,
  type TuiState,
} from '../../../src/tui/model/state.ts';
import { uiText } from '../../../src/tui/terminal/safe-text.ts';

const FAILED = { ok: false, permanent: null } as const;
const OK = { ok: true } as const;
const REVOKED: StopReason = {
  kind: 'unauthenticated',
  message: uiText('token revoked'),
};
const SIZE = { cols: 100, rows: 30 };
const HEALTH: Health = {
  healthy: true,
  reason: null,
  slot: null,
  queue_length: 0,
};
const BOARD = {
  unchanged: false,
  watermark: 4,
  counts: { by_status: {} },
  queue: { length: 0 },
  attention: { items: [], truncated: false },
  items: [],
  next_cursor: null,
} as unknown as BoardReply;

const succeeded = (at = 1, board: BoardReply = BOARD) =>
  ({ type: 'read_succeeded', board, health: HEALTH, at }) as const;
const failed = { type: 'read_failed', failure: FAILED } as const;
const char = (text: string) =>
  ({ type: 'key', key: { kind: 'char', text } }) as const;

function run(state: TuiState, ...messages: Parameters<typeof reduce>[1][]) {
  return messages.reduce((s, m) => reduce(s, m).state, state);
}

describe('nextConnection', () => {
  it('connecting goes online on success', () => {
    expect(nextConnection({ kind: 'connecting' }, OK)).toEqual({
      kind: 'online',
    });
  });

  it('a failed first read starts reconnecting', () => {
    expect(nextConnection({ kind: 'connecting' }, FAILED)).toEqual({
      kind: 'reconnecting',
      attempt: 1,
    });
  });

  it('online goes to reconnecting attempt 1 on a failed read', () => {
    expect(nextConnection({ kind: 'online' }, FAILED)).toEqual({
      kind: 'reconnecting',
      attempt: 1,
    });
  });

  it('counts attempts and waits for the user after the last', () => {
    let c: Connection = { kind: 'online' };
    const seen: number[] = [];
    for (let i = 0; i < RECONNECT_ATTEMPTS; i++) {
      c = nextConnection(c, FAILED);
      if (c.kind === 'reconnecting') seen.push(c.attempt);
    }
    expect(seen).toHaveLength(RECONNECT_ATTEMPTS);
    expect(seen.at(-1)).toBe(RECONNECT_ATTEMPTS);
    expect(nextConnection(c, FAILED)).toEqual({ kind: 'waiting_retry' });
  });

  it('a reconnect that succeeds goes online from any attempt', () => {
    expect(nextConnection({ kind: 'reconnecting', attempt: 7 }, OK)).toEqual({
      kind: 'online',
    });
  });

  it('a failure that will not pass stops from any state', () => {
    const permanent = { ok: false, permanent: REVOKED } as const;
    for (const c of [
      { kind: 'connecting' },
      { kind: 'online' },
      { kind: 'reconnecting', attempt: 3 },
      { kind: 'waiting_retry' },
    ] as const)
      expect(nextConnection(c, permanent)).toEqual({
        kind: 'stopped',
        reason: REVOKED,
      });
  });

  it('waiting_retry and stopped never restart on their own', () => {
    expect(nextConnection({ kind: 'waiting_retry' }, FAILED)).toEqual({
      kind: 'waiting_retry',
    });
    const stopped: Connection = { kind: 'stopped', reason: REVOKED };
    expect(nextConnection(stopped, FAILED)).toEqual(stopped);
  });
});

describe('retryConnection', () => {
  it('starts a new round from waiting_retry', () => {
    expect(retryConnection({ kind: 'waiting_retry' })).toEqual({
      kind: 'reconnecting',
      attempt: 1,
    });
  });

  it('asks again from stopped', () => {
    expect(retryConnection({ kind: 'stopped', reason: REVOKED })).toEqual({
      kind: 'connecting',
    });
  });

  it.each([
    [{ kind: 'connecting' }],
    [{ kind: 'online' }],
    [{ kind: 'reconnecting', attempt: 2 }],
  ] as const)('does nothing while %j', (c) => {
    expect(retryConnection(c)).toBeNull();
  });
});

describe('reduce', () => {
  it('a first read brings data, clears staleness', () => {
    const r = reduce(initialState(SIZE), succeeded(5));
    expect(r.state).toMatchObject({
      connection: { kind: 'online' },
      stale: false,
      lastUpdatedAt: 5,
      board: { watermark: 4 },
      health: HEALTH,
    });
    expect(r.effects).toEqual([]);
  });

  it('loads caller and projects with the successful round', () => {
    const projects: ProjectList = {
      caller: {
        actor: uiText('owner'),
        roles: ['read'],
        scope: 'all',
        trusted_confirmer: false,
      },
      projects: [{ id: 'acme', repo: null }],
      profiles: [],
    };
    const r = reduce(initialState(SIZE), { ...succeeded(), projects });
    expect(r.state.caller).toEqual(projects.caller);
    expect(r.state.projects).toEqual(projects.projects);
    expect(r.effects).toEqual([]);
  });

  it('a failed read marks the data stale at once and keeps it', () => {
    const state = run(initialState(SIZE), succeeded(5), failed);
    expect(state).toMatchObject({
      connection: { kind: 'reconnecting', attempt: 1 },
      stale: true,
      lastUpdatedAt: 5,
      board: { watermark: 4 },
    });
  });

  it('coming back clears stale and moves the time; an unchanged board keeps what it had', () => {
    const state = run(
      initialState(SIZE),
      succeeded(5),
      failed,
      succeeded(9, { unchanged: true, watermark: 4 }),
    );
    expect(state).toMatchObject({
      connection: { kind: 'online' },
      stale: false,
      lastUpdatedAt: 9,
      board: { watermark: 4, items: [] },
    });
  });

  it('R starts a new round only when waiting for the user', () => {
    const waiting = {
      ...initialState(SIZE),
      connection: { kind: 'waiting_retry' },
    } as const;
    expect(reduce(waiting, char('R'))).toMatchObject({
      state: { connection: { kind: 'reconnecting', attempt: 1 } },
      effects: [{ type: 'retry_connection' }],
    });
    const online = run(initialState(SIZE), succeeded());
    expect(reduce(online, char('R'))).toEqual({ state: online, effects: [] });
  });

  it('q and Ctrl-C quit', () => {
    const s = initialState(SIZE);
    expect(reduce(s, char('q')).effects).toEqual([{ type: 'quit', code: 0 }]);
    expect(
      reduce(s, { type: 'key', key: { kind: 'key', name: 'ctrl_c' } }).effects,
    ).toEqual([{ type: 'quit', code: 0 }]);
  });

  it('? opens help and Esc returns, without stacking', () => {
    const open = run(initialState(SIZE), char('?'), char('?'));
    expect(open.screens).toEqual(['home', 'help']);
    const back = reduce(open, {
      type: 'key',
      key: { kind: 'key', name: 'esc' },
    }).state;
    expect(back.screens).toEqual(['home']);
    expect(
      reduce(back, { type: 'key', key: { kind: 'key', name: 'esc' } }).state
        .screens,
    ).toEqual(['home']);
  });

  it('a resize keeps everything else', () => {
    const state = run(initialState(SIZE), succeeded(5), {
      type: 'resize',
      size: { cols: 120, rows: 40 },
    });
    expect(state).toMatchObject({
      size: { cols: 120, rows: 40 },
      lastUpdatedAt: 5,
    });
  });

  describe('another token', () => {
    const CHANGED = { type: 'credential_changed' } as const;
    const loaded: TuiState = {
      ...run(initialState(SIZE), succeeded(5)),
      caller: {
        actor: uiText('owner'),
        roles: ['read'],
        scope: 'all',
        trusted_confirmer: false,
      },
      projects: [],
    };

    it('forgets who was asking, keeping the list until the new answer', () => {
      const r = reduce(loaded, CHANGED);
      expect(r.effects).toEqual([]);
      expect(r.state).toMatchObject({ caller: null, projects: null });
      expect(r.state.board).toBe(loaded.board);
      // Until the new token has read it, what is on screen is not current.
      expect(r.state.stale).toBe(true);
    });

    it('leaves a page of the old list: its position means nothing to the new token', () => {
      const r = reduce({ ...loaded, cursors: ['c1', 'c2'] }, CHANGED);
      expect(r.state).toMatchObject({ cursors: [], board: null });
    });

    it('keeps what is being typed in the filter, but not a choice from the old list', () => {
      const r = reduce(
        {
          ...loaded,
          screens: ['home', 'filters'],
          filterDraft: {
            field: 'project',
            query: 'be',
            project: 2,
            status: 3,
          },
        },
        CHANGED,
      );
      expect(r.state.filterDraft).toEqual({
        field: 'project',
        query: 'be',
        project: 0,
        status: 3,
      });
    });
  });

  it('a paste outside any input does nothing', () => {
    const s = initialState(SIZE);
    expect(
      reduce(s, { type: 'key', key: { kind: 'paste', text: 'q\r' } }),
    ).toEqual({ state: s, effects: [] });
  });
});
