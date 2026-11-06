import { describe, expect, it } from 'vitest';
import { boardQuery, initialState } from '../../../src/tui/model/state.ts';

describe('what Home asks the board for', () => {
  it('asks for the newest task first, on every page', () => {
    const s = initialState({ cols: 120, rows: 40 });
    expect(boardQuery(s).order).toBe('newest');
    expect(boardQuery({ ...s, cursors: ['c'] })).toMatchObject({ order: 'newest', cursor: 'c' });
  });
});
