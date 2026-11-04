import { describe, expect, it } from 'vitest';
import type { TaskShow } from '../../../src/tui/client/schemas.ts';
import { initialDetail } from '../../../src/tui/model/detail.ts';
import { reduce } from '../../../src/tui/model/reduce.ts';
import { animating, initialState, type TuiState } from '../../../src/tui/model/state.ts';
import { progressStages, rowStages } from '../../../src/tui/model/stages.ts';
import { uiText } from '../../../src/tui/terminal/safe-text.ts';
import { plain } from '../../../src/tui/views/ink.ts';
import { markdownRows } from '../../../src/tui/views/markdown.ts';
import { stepper } from '../../../src/tui/views/stepper.ts';

type Step = Parameters<typeof progressStages>[0][number];
const step = (name: string, state: Step['state'], visits = 1): Step => ({
  name: uiText(name),
  state,
  visits,
});

describe('stages', () => {
  it('folds fix steps into their stage and counts how often the stage ran', () => {
    const stages = progressStages(
      [
        step('triage', 'past'),
        step('prepare', 'past'),
        step('code', 'past'),
        step('gates', 'past', 2),
        step('fix_gates', 'past'),
        step('publish', 'past'),
        step('pr', 'past'),
        step('review', 'current'),
        step('post_review', 'remaining', 0),
        step('ready', 'remaining', 0),
      ],
      'RUNNING',
    );
    expect(stages?.map((s) => [s.name, s.state, s.runs])).toEqual([
      ['triage', 'done', 1],
      ['prepare', 'done', 1],
      ['code', 'done', 1],
      ['gates', 'done', 2],
      ['pr', 'done', 1],
      ['review', 'current', 1],
      ['ci', 'skipped', 0],
      ['merge', 'skipped', 0],
    ]);
  });

  it('never shows a stage the mode leaves out as one that ran', () => {
    const stages = progressStages(
      [step('code', 'past'), step('review', 'not_required', 0), step('ci', 'current')],
      'WAITING',
    );
    const path = plain(stepper(stages ?? [], 'WAITING'));
    expect(path).toContain('review skipped');
    expect(path).not.toContain('review ✓');
  });

  it('a DONE task has every stage done, still on its last step, and keeps what it skipped', () => {
    const stages = progressStages(
      [
        step('code', 'past'),
        step('review', 'not_required', 0),
        step('merge', 'past'),
        step('complete', 'current'),
      ],
      'DONE',
    );
    expect(stages?.find((st) => st.name === 'merge')?.state).toBe('done');
    expect(stages?.find((st) => st.name === 'review')?.state).toBe('skipped');
    expect(stages?.some((st) => st.state === 'current')).toBe(false);
  });

  it('draws nothing for a workflow it does not know', () => {
    expect(rowStages({ status: 'RUNNING', step: 'paint', mode: null })).toBeNull();
    expect(progressStages([step('paint', 'current')], 'RUNNING')).toBeNull();
  });

  it('marks where a failed task stopped', () => {
    const stages = rowStages({
      status: 'FAILED',
      step: 'ci_fix',
      mode: 'full-review',
    });
    expect(stages?.find((s) => s.name === 'ci')?.state).toBe('failed');
  });
});

describe('markdown', () => {
  const text = (md: string, cols = 60): string[] =>
    markdownRows(uiText(md), cols).map((r) => plain(r));

  it('drops emphasis markers, bullets list items and keeps numbers', () => {
    expect(text('Ran **all** `tests`\n- one\n2. two')).toEqual([
      'Ran all tests',
      '• one',
      '2. two',
    ]);
  });

  it('draws a table in a box when it fits, and as lines when it does not', () => {
    const table = '| a | bb |\n|---|---|\n| 1 | 2 |';
    expect(text(table)).toEqual([
      '┌───┬────┐',
      '│ a │ bb │',
      '├───┼────┤',
      '│ 1 │ 2  │',
      '└───┴────┘',
    ]);
    expect(text(table, 6)).toEqual(['a · bb', '1 · 2']);
  });
});

describe('animation', () => {
  const base = initialState({ cols: 120, rows: 40 });
  const withStatus = (status: string, screens: TuiState['screens']): TuiState => ({
    ...base,
    screens,
    detail: {
      ...initialDetail('t', uiText('T'), 1),
      show: {
        data: { status } as unknown as TaskShow,
        error: null,
        attemptAt: 1,
        readAt: 1,
      },
    },
  });

  it('turns only on the screen of a running task', () => {
    expect(animating(withStatus('RUNNING', ['home', 'detail', 'logs']))).toBe(true);
    expect(animating(withStatus('WAITING', ['home', 'detail', 'logs']))).toBe(false);
    expect(animating(withStatus('RUNNING', ['home']))).toBe(false);
  });

  it('a tick moves the frame and nothing else', () => {
    const s = withStatus('RUNNING', ['home', 'detail', 'logs']);
    const r = reduce(s, { type: 'tick' });
    expect(r.state).toEqual({ ...s, tick: 1 });
    expect(r.effects).toEqual([]);
  });
});
