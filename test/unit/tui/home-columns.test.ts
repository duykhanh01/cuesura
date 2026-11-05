import { describe, expect, it } from 'vitest';
import { shareColumns } from '../../../src/tui/views/home.ts';

describe('shareColumns', () => {
  it('gives the title and the activity all they need when both fit, the rest to the activity', () => {
    expect(shareColumns(150, { title: 70, doing: 46 })).toEqual({ title: 70, doing: 80 });
  });

  it('short of room, the activity gives way first, then the title', () => {
    expect(shareColumns(100, { title: 70, doing: 46 })).toEqual({ title: 60, doing: 40 });
    expect(shareColumns(60, { title: 70, doing: 46 })).toEqual({ title: 36, doing: 24 });
  });

  it('never narrows the title below its minimum, nor widens it past the longest title', () => {
    expect(shareColumns(30, { title: 70, doing: 46 })).toEqual({ title: 14, doing: 16 });
    expect(shareColumns(100, { title: 20, doing: 200 }).title).toBe(20);
  });
});
