import { describe, expect, it } from 'vitest';
import type { TaskShow } from '../../../src/tui/client/schemas.ts';
import {
  attemptGroups,
  attemptKey,
  formatTokens,
  groupFlow,
  pickerStart,
  treeRows,
} from '../../../src/tui/model/attempt-tree.ts';
import { initialDetail } from '../../../src/tui/model/detail.ts';
import { onLogsCommand } from '../../../src/tui/model/detail-keys.ts';
import type { Command } from '../../../src/tui/model/keymap.ts';
import { initialLogs } from '../../../src/tui/model/logs.ts';
import { initialState, type TuiState } from '../../../src/tui/model/state.ts';
import { sanitize, uiText } from '../../../src/tui/terminal/safe-text.ts';
import { Frame } from '../../../src/tui/terminal/screen.ts';
import { logsBody } from '../../../src/tui/views/logs.ts';

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
      ['Round 1', 'review×1 fix_review×1 fix_gates×1'],
      ['Round 2', 'review×1 fix_review×2'],
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

describe('the chooser opens folded, at its top, with the latest round unfolded', () => {
  const groups = attemptGroups(
    usage(['code', 'review', 'fix_review', 'review', 'fix_review', 'fix_review']),
  );

  it('unfolds only what holds the latest attempt', () => {
    const start = pickerStart(groups, null);
    expect(start.cursor).toBe('live');
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
    expect(run(state(), 'attempts').logs?.picker).toBe('live');
    const open = run(state(), 'attempts', 'end');
    expect(open.logs?.picker).toBe(attemptKey('attempt-3'));
    const up = run(open, 'collapse');
    expect(up.logs?.picker).toBe('r:attempt-2');
    const folded = run(up, 'collapse');
    expect(folded.logs?.pickerOpen).not.toContain('r:attempt-2');
    expect(run(folded, 'expand').logs?.pickerOpen).toContain('r:attempt-2');
  });

  it('Enter folds a round and reads an attempt', () => {
    const open = run(state(), 'attempts', 'end', 'collapse', 'collapse', 'collapse');
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

describe('going back between the log, the chooser and an attempt', () => {
  const state = (): TuiState => {
    const title = uiText('A task');
    const detail = initialDetail('t1', title, 1);
    const show = {
      status: 'RUNNING',
      provenance: { usage: usage(['code', 'review', 'fix_review']) },
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

  it('Esc from an attempt returns to the chooser on that attempt', () => {
    const back = run(state(), 'attempts', 'end', 'up', 'open', 'back');
    expect(back.logs?.attemptFilter).toBe('attempt-1');
    expect(back.logs?.picker).toBe(attemptKey('attempt-1'));
  });

  it('Esc from the chooser, after reading an attempt, returns to the whole log', () => {
    const back = run(state(), 'attempts', 'end', 'open', 'back', 'back');
    expect(back.logs?.picker).toBeNull();
    expect(back.logs?.attemptFilter).toBeNull();
    expect(back.screens.at(-1)).toBe('logs');
  });

  it('Esc from the whole log leaves the task', () => {
    expect(run(state(), 'back').logs).toBeNull();
  });
});

describe('several runs of one step in a row', () => {
  it('are numbered, since their step and binding read the same', () => {
    const groups = attemptGroups(usage(['review', 'fix_review', 'fix_review']));
    const open = [groups[0]?.key ?? '', groups[0]?.runs[1]?.key ?? ''];
    const rows = treeRows(groups, open).flatMap((r) => (r.kind === 'attempt' ? [r.ordinal] : []));
    expect(rows).toEqual([undefined, 1, 2]);
  });
});

describe('what a row of the chooser says about its group', () => {
  const flows = (steps: readonly string[]) => attemptGroups(usage(steps)).map(groupFlow);

  it('leaves a usual round blank and names only what sets another apart', () => {
    expect(
      flows([
        'review',
        'fix_review',
        'review',
        'fix_review',
        'fix_review',
        'review',
        'fix_review',
        'fix_gates',
        'review',
      ]),
    ).toEqual(['', 'fix review ×2', 'fix gates', 'review']);
  });

  it('keeps the whole flow outside the review rounds', () => {
    expect(flows(['code', 'fix_gates', 'fix_gates'])).toEqual(['code → fix gates ×2']);
  });
});

describe('the chooser on screen', () => {
  const BOLD_ON = '\u001b[1m';
  const drawn = (rows: number, steps: readonly string[], complete = true): readonly string[] => {
    const title = uiText('A task');
    const detail = initialDetail('t1', title, 1);
    const show = {
      status: 'DONE',
      provenance: { usage: usage(steps) },
    } as unknown as TaskShow;
    const opened = onLogsCommand(
      {
        ...initialState({ cols: 120, rows: 40 }),
        screens: ['home', 'detail', 'logs'],
        detail: { ...detail, show: { ...detail.show, data: show } },
        logs: { ...initialLogs('t1', title, 2), complete },
      },
      'attempts',
    )?.state as TuiState;
    const frame = new Frame(120, rows);
    logsBody(opened)(frame, 0, rows);
    return Array.from({ length: rows }, (_, y) => frame.rowBytes(y));
  };
  const steps = ['code', 'review', 'fix_review', 'review', 'fix_review'];
  const at = (screen: readonly string[], text: string) => screen.findIndex((l) => l.includes(text));

  it('sets the whole log apart from the rounds by one empty row', () => {
    const screen = drawn(20, steps);
    expect(at(screen, 'Build')).toBe(at(screen, 'Whole log') + 2);
  });

  it('keeps every row in reach when the list only just fits', () => {
    // Header, whole log, the empty row, Build, two rounds and the two attempts of the open one.
    expect(at(drawn(3 + 7, steps), 'Fix review')).toBeGreaterThan(0);
  });

  it('marks only the open round in bold', () => {
    const screen = drawn(20, steps);
    const bold = (text: string) => (screen[at(screen, text)] as string).includes(BOLD_ON + text);
    expect(bold('Round 2')).toBe(true);
    expect(bold('Round 1')).toBe(false);
  });

  it('says a finished log is finished, not live, leaving the row for news empty', () => {
    const title = uiText('A task');
    const logs = { ...initialLogs('t1', title, 2), complete: true, filling: false };
    const frame = new Frame(120, 10);
    logsBody({ ...initialState({ cols: 120, rows: 40 }), logs })(frame, 0, 10);
    expect(frame.rowBytes(1)).toContain('Finished · whole log');
    expect(frame.rowBytes(2)).toBe('');
  });
});

describe('a running task that went quiet', () => {
  const MINUTE = 60_000;
  const quiet = (ms: number, status = 'RUNNING', mode: 'live' | 'paused' = 'live') => {
    const title = uiText('A task');
    const detail = initialDetail('t1', title, 1);
    const show = { status, provenance: { usage: [] } } as unknown as TaskShow;
    const logs = {
      ...initialLogs('t1', title, 2),
      mode,
      filling: false,
      lastOutputAt: 0,
      lastReadAt: ms,
    };
    const frame = new Frame(120, 10);
    logsBody({
      ...initialState({ cols: 120, rows: 40 }),
      detail: { ...detail, show: { ...detail.show, data: show } },
      logs,
    })(frame, 0, 10);
    return [frame.rowBytes(1), frame.rowBytes(2)].join('\n');
  };

  it('says nothing for the first minute', () => {
    expect(quiet(MINUTE - 1)).not.toContain('output');
  });

  it('says how long, then that it may be stuck', () => {
    expect(quiet(2 * MINUTE)).toContain('last output 2m 0s ago');
    expect(quiet(6 * MINUTE)).toContain('No output for 6m 0s: it may be stuck');
    expect(quiet(6 * MINUTE)).not.toContain('last output');
  });

  it('says nothing of a task not running, or a log not followed', () => {
    expect(quiet(6 * MINUTE, 'WAITING')).not.toContain('output');
    expect(quiet(6 * MINUTE, 'RUNNING', 'paused')).not.toContain('output');
  });
});
