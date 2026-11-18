import { uiText } from '../../../src/tui/terminal/safe-text.ts';
import { describe, expect, it } from 'vitest';
import type { TaskStatus } from '../../../src/domain/state.ts';
import type { BoardData, BoardRow } from '../../../src/tui/client/schemas.ts';
import { homeRows, keepSelection, selectedRowIndex } from '../../../src/tui/model/home-rows.ts';
import { initialState, type TuiState } from '../../../src/tui/model/state.ts';

let n = 0;
function row(status: TaskStatus, extra: Partial<BoardRow> = {}): BoardRow {
  n += 1;
  return {
    task_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    project: 'acme',
    title: `T${n}`,
    status,
    wait_code: null,
    step: null,
    mode: null,
    status_since: null,
    version: 1,
    priority: 0,
    pr_ref: null,
    needs_user: false,
    ...extra,
  } as unknown as BoardRow;
}

function stateOf(
  items: BoardRow[],
  attention: BoardRow[] = [],
  by: Record<string, number> = {},
): TuiState {
  const board = {
    unchanged: false,
    watermark: 1,
    counts: { by_status: by },
    queue: { length: 0 },
    attention: { items: attention, truncated: false },
    items,
    next_cursor: null,
  } as unknown as BoardData;
  return { ...initialState({ cols: 120, rows: 40 }), board };
}

const shape = (s: TuiState): string[] =>
  homeRows(s).map((r) =>
    r.kind === 'task' ? r.group : r.kind === 'finished_toggle' ? 'toggle' : r.kind,
  );

describe('Home groups', () => {
  it('orders Needs you, In progress, Waiting, Open, Finished and places each task once', () => {
    const need = row('WAITING', { needs_user: true, wait_code: 'needs_confirmation' });
    const items = [
      row('DONE'),
      row('READY'),
      row('PENDING', { wait_code: 'dependency_pending' }),
      row('WAITING', { wait_code: 'ci' }),
      row('READY', { wait_code: 'slot' }),
      row('RUNNING'),
      need,
    ];
    const s = { ...stateOf(items, [need], { DONE: 1 }), finishedOpen: true };
    expect(shape(s)).toEqual([
      'attention',
      'progress',
      'waiting',
      'waiting',
      'waiting',
      'open',
      'toggle',
      'finished',
    ]);
    const ids = homeRows(s)
      .filter((r) => r.kind !== 'finished_toggle')
      .map((r) => (r as { task: BoardRow }).task.task_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('puts a task queued for a slot, or held by a queue pause, in Waiting; an unqueued one in Open', () => {
    const queued = row('READY', { queued: true });
    const fresh = row('READY', { queued: false });
    const old = row('READY'); // an older daemon sends no `queued`
    expect(shape(stateOf([queued, fresh, old]))).toEqual(['waiting', 'open', 'open']);
    const pause = { reason: uiText('r'), by: uiText('b'), at: 1 };
    const held = { ...stateOf([fresh]), queuePaused: pause };
    expect(shape(held)).toEqual(['waiting']);
    const own = row('READY', { paused: pause });
    expect(shape({ ...held, board: { ...held.board!, items: [own] } })).toEqual(['open']);
  });

  it('leaves out empty groups, and keeps the Finished fold when only it is left', () => {
    const s = stateOf([row('READY')]);
    expect(shape(s)).toEqual(['open']);
    expect(shape(stateOf([], [], { DONE: 3 }))).toEqual(['toggle']);
  });

  it('puts a needs_user task past the attention cap in Needs you only', () => {
    const late = row('RUNNING', { needs_user: true });
    expect(shape(stateOf([late]))).toEqual(['attention']);
  });

  it('under a status filter shows that group with no fold', () => {
    // The daemon already narrows `items` by status; the fixture lists what it would return.
    const base = stateOf([row('FAILED')]);
    expect(shape({ ...base, filters: { ...base.filters, status: 'FAILED' } })).toEqual([
      'finished',
    ]);
    const running = stateOf([row('RUNNING')]);
    expect(shape({ ...running, filters: { ...running.filters, status: 'RUNNING' } })).toEqual([
      'progress',
    ]);
  });

  it('follows the selected task when it moves to another group', () => {
    const t = row('READY');
    const other = row('RUNNING');
    let s = stateOf([t, other]);
    s = { ...s, selectedTaskId: t.task_id };
    s = keepSelection(s);
    expect(selectedRowIndex(s)).toBe(1);
    const running = { ...t, status: 'RUNNING' } as BoardRow;
    s = keepSelection({ ...s, board: { ...s.board!, items: [other, running] } });
    expect(s.selectedTaskId).toBe(t.task_id);
    expect(selectedRowIndex(s)).toBe(1);
    const waiting = { ...t, status: 'WAITING', wait_code: 'ci' } as BoardRow;
    s = keepSelection({ ...s, board: { ...s.board!, items: [other, waiting] } });
    expect(s.selectedTaskId).toBe(t.task_id);
    expect(homeRows(s)[selectedRowIndex(s)]).toMatchObject({ kind: 'task', group: 'waiting' });
  });
});
