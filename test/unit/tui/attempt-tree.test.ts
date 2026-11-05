import { describe, expect, it } from 'vitest';
import type { TaskShow } from '../../../src/tui/client/schemas.ts';
import {
  attemptGroups,
  attemptKey,
  formatTokens,
  pickerStart,
  treeRows,
} from '../../../src/tui/model/attempt-tree.ts';
import { initialDetail } from '../../../src/tui/model/detail.ts';
import { onLogsCommand } from '../../../src/tui/model/detail-keys.ts';
import type { Command } from '../../../src/tui/model/keymap.ts';
import { initialLogs } from '../../../src/tui/model/logs.ts';
import { initialState, type TuiState } from '../../../src/tui/model/state.ts';
import { sanitize, uiText } from '../../../src/tui/terminal/safe-text.ts';

type Usage = TaskShow['provenance']['usage'][number];

const usage = (steps: readonly string[]): Usage[] =>
  steps.map((step, i) => ({
    attempt_id: `attempt-${i}`,
    step: sanitize(step),
    binding: sanitize(step === 'review' ? 'sol/high' : 'opus/medium'),
    usage: { basis: 'reported', tokens: 1_000 * (i + 1) },
  }));

const shape = (steps: readonly string[]) =>
  attemptGroups(usage(steps)).map((g) => [
    g.title,
    g.runs.map((r) => `${r.step}×${r.attempts.length}`).join(' '),
  ]);

describe('attempts grouped into the build and review rounds', () => {
  it('opens a round at each review, keeping the fixes it sent back to earlier stages', () => {
    expect(
      shape([
        'code',
        'fix_gates',
        'review',
        'fix_review',
        'fix_gates',
        'review',
        'fix_review',
        'fix_review',
        'ci_fix',
        'fix_gates',
      ]),
    ).toEqual([
      ['Build', 'code×1 fix_gates×1'],
      ['Review round 1', 'review×1 fix_review×1 fix_gates×1'],
      ['Review round 2', 'review×1 fix_review×2'],
      ['CI', 'ci_fix×1 fix_gates×1'],
    ]);
  });

  it('keeps steps of a workflow it does not know, in order', () => {
    expect(shape(['plan', 'plan', 'write'])).toEqual([['Steps', 'plan×2 write×1']]);
  });

  it('writes token counts short', () => {
    expect([950, 12_400, 2_140_000].map(formatTokens)).toEqual(['950', '12k', '2.1M']);
  });
});

describe('the chooser opens folded, on the latest attempt', () => {
  const groups = attemptGroups(
    usage(['code', 'review', 'fix_review', 'review', 'fix_review', 'fix_review']),
  );

  it('unfolds only what holds the latest attempt', () => {
    const start = pickerStart(groups, null);
    expect(start.cursor).toBe(attemptKey('attempt-5'));
    const rows = treeRows(groups, start.open).map((r) => `${r.kind}:${r.key}`);
    expect(rows).toEqual([
      'live:live',
      'group:g:0',
      'group:g:1',
      'group:g:2',
      'attempt:a:attempt-3',
      'run:r:attempt-4',
      'attempt:a:attempt-4',
      'attempt:a:attempt-5',
    ]);
  });

  it('opens on the attempt being read', () => {
    expect(pickerStart(groups, 'attempt-0')).toEqual({
      cursor: attemptKey('attempt-0'),
      open: ['g:0'],
    });
  });

  it('opens on the whole log when there are no attempts', () => {
    expect(pickerStart([], null)).toEqual({ cursor: 'live', open: [] });
  });
});

describe('keys of the chooser', () => {
  const state = (): TuiState => {
    const title = uiText('A task');
    const detail = initialDetail('t1', title, 1);
    const show = {
      status: 'RUNNING',
      provenance: { usage: usage(['code', 'review', 'fix_review', 'fix_review']) },
    } as unknown as TaskShow;
    return {
      ...initialState({ cols: 120, rows: 40 }),
      screens: ['home', 'detail', 'logs'],
      detail: { ...detail, show: { ...detail.show, data: show } },
      logs: initialLogs('t1', title, 2),
    };
  };
  const run = (s: TuiState, ...commands: Command[]): TuiState =>
    commands.reduce((acc, c) => onLogsCommand(acc, c)?.state ?? acc, s);

  it('← goes up to the run, then folds it; → unfolds it again', () => {
    const open = run(state(), 'attempts');
    expect(open.logs?.picker).toBe(attemptKey('attempt-3'));
    const up = run(open, 'collapse');
    expect(up.logs?.picker).toBe('r:attempt-2');
    const folded = run(up, 'collapse');
    expect(folded.logs?.pickerOpen).not.toContain('r:attempt-2');
    expect(run(folded, 'expand').logs?.pickerOpen).toContain('r:attempt-2');
  });

  it('Enter folds a round and reads an attempt', () => {
    const open = run(state(), 'attempts', 'collapse', 'collapse', 'collapse');
    expect(open.logs?.picker).toBe('g:1');
    const folded = run(open, 'open');
    expect(folded.logs?.pickerOpen).not.toContain('g:1');
    const read = run(folded, 'up', 'expand', 'down', 'open');
    expect(read.logs?.picker).toBeNull();
    expect(read.logs?.attemptFilter).toBe('attempt-0');
  });

  it('Enter on the first row follows the whole log', () => {
    const read = run(state(), 'attempts', 'top', 'open');
    expect(read.logs?.picker).toBeNull();
    expect(read.logs?.attemptFilter).toBeNull();
    expect(read.logs?.mode).toBe('live');
  });
});
