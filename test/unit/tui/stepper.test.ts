import { describe, expect, it } from 'vitest';
import { STAGES, type Stage, type StageState } from '../../../src/tui/model/stages.ts';
import { displayWidth } from '../../../src/tui/terminal/width.ts';
import { plain, segsWidth } from '../../../src/tui/views/ink.ts';
import { stepperRow } from '../../../src/tui/views/stepper.ts';

const stages = (current: number, state: StageState = 'current'): Stage[] =>
  STAGES.map((name, i) => ({
    name,
    state: i < current ? 'done' : i === current ? state : 'todo',
    runs: i < current ? 9 : 1,
  }));

const text = (s: Stage[], status: 'RUNNING' | 'WAITING' | 'FAILED', cols: number): string =>
  plain(stepperRow(s, status, cols)).replace(/\u00a0/g, ' ');

describe('stepperRow', () => {
  it('leaves a path that fits as it is', () => {
    const row = text(stages(1), 'RUNNING', 300);
    expect(row).not.toContain('…');
  });

  it.each([40, 60, 79, 119])('keeps the stage that matters whole in %i cells', (cols) => {
    STAGES.forEach((_, i) => {
      for (const [state, status, word] of [
        ['current', 'RUNNING', ''],
        ['current', 'WAITING', ' waiting ‖'],
        ['failed', 'FAILED', ' failed ✕'],
      ] as const) {
        const s = stages(i, state);
        const row = stepperRow(s, status, cols);
        const shown = text(s, status, cols);
        expect(shown).toContain(word === '' ? ' ●' : word);
        expect(segsWidth(row)).toBeLessThanOrEqual(cols);
        expect(displayWidth(plain(row))).toBe(segsWidth(row));
      }
    });
  });

  it('gives up what is behind the task before what is to come', () => {
    const last = STAGES.length - 1;
    const row = text(stages(last - 1, 'current'), 'WAITING', 60);
    expect(row.startsWith('…')).toBe(true);
    expect(row).not.toMatch(/… $/);
  });
});
