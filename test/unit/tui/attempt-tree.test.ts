import { describe, expect, it } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import type { TaskLogs, TaskProgress, TaskShow } from '../../../src/tui/client/schemas.ts';
import {
  attemptGroups,
  attemptKey,
  formatTokens,
  groupFlow,
  pickerStart,
  treeRows,
  withDeputyRuns,
} from '../../../src/tui/model/attempt-tree.ts';
import { initialDetail } from '../../../src/tui/model/detail.ts';
import { onLogsCommand } from '../../../src/tui/model/detail-keys.ts';
import { openGates } from '../../../src/tui/model/gates.ts';
import type { Command } from '../../../src/tui/model/keymap.ts';
import {
  applyLogPage,
  filterAttempt,
  initialLogs,
  logRows,
  type LogEntry,
  type LogState,
} from '../../../src/tui/model/logs.ts';
import { initialState, type TuiState } from '../../../src/tui/model/state.ts';
import { sanitize, uiText } from '../../../src/tui/terminal/safe-text.ts';
import { Frame } from '../../../src/tui/terminal/screen.ts';
import { logsBody } from '../../../src/tui/views/logs.ts';
import { uuidOf } from '../../support/builders.ts';

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

  it('opens on the latest step when there are no attempts', () => {
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
      screens: ['home', 'logs'],
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

  it('Enter on the first row follows the latest step', () => {
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
      screens: ['home', 'logs'],
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

  it('Esc from the chooser, after reading an attempt, returns to the latest step', () => {
    const back = run(state(), 'attempts', 'end', 'open', 'back', 'back');
    expect(back.logs?.picker).toBeNull();
    expect(back.logs?.attemptFilter).toBeNull();
    expect(back.screens.at(-1)).toBe('logs');
  });

  it('← and → go through the attempts; forward to the last one is following it', () => {
    const first = run(state(), 'attempts', 'end', 'up', 'open');
    expect(first.logs?.attemptFilter).toBe('attempt-1');
    expect(run(first, 'previous_step').logs?.attemptFilter).toBe('attempt-0');
    expect(run(first, 'previous_step', 'next_step').logs?.attemptFilter).toBe('attempt-1');

    const last = run(first, 'next_step');
    expect(last.logs?.attemptFilter).toBeNull();
    expect(last.logs?.mode).toBe('live');
  });

  it('← from the latest step reads the attempt before it, also when the list lags the log', () => {
    const latest = (attempt: string): TuiState => {
      const s = state();
      return {
        ...s,
        logs: {
          ...(s.logs as LogState),
          buffer: [{ attemptId: attempt, gap: false } as LogEntry],
        },
      };
    };
    expect(run(latest('attempt-2'), 'previous_step').logs?.attemptFilter).toBe('attempt-1');
    expect(run(latest('attempt-9'), 'previous_step').logs?.attemptFilter).toBe('attempt-2');
    expect(run(latest('attempt-0'), 'previous_step').logs?.attemptFilter).toBeNull();
  });

  it('→ goes through each attempt the list names before following one it does not name yet', () => {
    const s = state();
    const lagging: TuiState = {
      ...s,
      logs: {
        ...(s.logs as LogState),
        buffer: [{ attemptId: 'attempt-9', gap: false } as LogEntry],
      },
    };
    const back = run(lagging, 'previous_step', 'previous_step');
    expect(back.logs?.attemptFilter).toBe('attempt-1');
    const forward = run(back, 'next_step');
    expect(forward.logs?.attemptFilter).toBe('attempt-2');
    expect(run(forward, 'next_step').logs?.attemptFilter).toBeNull();
    expect(run(forward, 'next_step').logs?.mode).toBe('live');
  });

  it('→ to the last attempt follows once the list has caught up with the log', () => {
    const s = state();
    const latest: TuiState = {
      ...s,
      logs: {
        ...(s.logs as LogState),
        buffer: [{ attemptId: 'attempt-2', gap: false } as LogEntry],
      },
    };
    expect(run(latest, 'previous_step', 'next_step').logs?.attemptFilter).toBeNull();
  });

  it('→ while following stays on the latest step', () => {
    const s = state();
    expect(run(s, 'next_step').logs).toBe(s.logs);
  });

  it('Esc from the latest step leaves the task', () => {
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
        screens: ['home', 'logs'],
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

  it('sets the latest step apart from the rounds by one empty row', () => {
    const screen = drawn(20, steps);
    expect(at(screen, 'Build')).toBe(at(screen, 'Latest step') + 2);
  });

  it('keeps every row in reach when the list only just fits', () => {
    // Header, latest step, the empty row, Build, two rounds, the two attempts of the open one, the foot.
    expect(at(drawn(3 + 7 + 1, steps), 'Fix review')).toBeGreaterThan(0);
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
    expect(frame.rowBytes(1)).toContain('Finished · latest step');
    expect(frame.rowBytes(2)).toBe('');
  });
});

describe('agent attempts on the Logs screen', () => {
  const task = uuidOf(1);
  const title = uiText('A task');
  const [first, second] = usage(['code', 'code']) as [Usage, Usage];
  const raised = { ...second, binding: uiText('sonnet/high') };
  const initial = initialLogs(task, title, 2);
  const record = (seq: number, attempt_id: string): TaskLogs['records'][number] => ({
    seq,
    cursor: seq,
    operation_id: 'op',
    attempt_id,
    step: uiText('code'),
    at: uiText('2026-11-01T10:20:30.000Z'),
    kind: uiText('stdout'),
    data: `output ${seq}`,
  });
  const tail = (logs: LogState, seq: number, id: string) =>
    applyLogPage(
      logs,
      { kind: 'tail', after: 0 },
      { task_id: task, records: [record(seq, id)], next_cursor: seq, complete: false },
      0,
    );

  function draw(
    cols: number,
    logs: LogState,
    attempts: readonly Usage[],
    activeAttemptId?: string,
  ): string[] {
    const detail = initialDetail(task, title, 1);
    const show = {
      status: 'RUNNING',
      version: 1,
      provenance: { usage: attempts, active_attempt_id: activeAttemptId },
    } as unknown as TaskShow;
    const progress: TaskProgress = {
      task_id: task,
      version: 1,
      mode: uiText('direct-pr'),
      steps: [{ name: uiText('code'), state: 'current', visits: 2 }],
      reason: null,
      needs_user: false,
      worktree_path: null,
    };
    const rows = 24;
    const frame = new Frame(cols, rows, { color: false });
    logsBody({
      ...initialState({ cols, rows }),
      detail: {
        ...detail,
        show: { ...detail.show, data: show },
        progress: { ...detail.progress, data: progress },
      },
      logs,
    })(frame, 0, rows);
    return Array.from({ length: rows }, (_, y) => stripVTControlCharacters(frame.rowBytes(y)));
  }

  it.each([80, 120])('shows the binding of each run of the same step at %i columns', (cols) => {
    const live = tail(initial, 2, raised.attempt_id);
    const screen = draw(cols, live, [first, raised]);
    expect(screen.slice(0, 3).join('\n')).toContain('Live · latest step · sonnet/high');
    expect(screen.find((line) => line.includes('── code'))).toContain('sonnet/high');
    expect(screen.join('\n')).not.toContain('opus/medium');

    const historic = tail(filterAttempt(live, first.attempt_id), 1, first.attempt_id);
    const archived = draw(
      cols,
      { ...historic, newActivity: true },
      [first, raised],
      raised.attempt_id,
    );
    expect(archived.slice(0, 3).join('\n')).toContain('Code · opus/medium');
    expect(archived.slice(0, 3).join('\n')).toContain('New activity');
    expect(archived.find((line) => line.includes('── code'))).toContain('opus/medium');
    expect(archived.join('\n')).not.toContain('sonnet/high');
  });

  it('shows the new active binding before its first record and keeps the previous separator', () => {
    const logs = tail(initial, 1, first.attempt_id);
    const screen = draw(80, logs, [first, raised], raised.attempt_id);
    expect(screen.slice(0, 3).join('\n')).toContain('Live · latest step · sonnet/high');
    const separator = screen.find((line) => line.includes('── code'));
    expect(separator).toContain('opus/medium');
    expect(separator).not.toContain('sonnet/high');
    expect(screen.join('\n')).toContain('output 1');
    expect(screen.join('\n')).not.toContain('output 2');
  });

  it('uses the log when its attempt is newer than the task metadata', () => {
    const logs = tail(initial, 2, raised.attempt_id);
    const screen = draw(80, logs, [first], first.attempt_id).join('\n');
    expect(screen).toContain('Live · latest step');
    expect(screen).toContain('output 2');
    expect(screen).not.toContain('opus/medium');
  });

  it('keeps archived output readable without metadata and shows model-only metadata as given', () => {
    const logs = tail(filterAttempt(initial, first.attempt_id), 1, first.attempt_id);
    const archive = draw(80, logs, [raised]).join('\n');
    expect(archive).toContain('One attempt');
    expect(archive).toContain('output 1');
    expect(archive).not.toContain('sonnet/high');
    expect(draw(80, logs, [{ ...first, binding: uiText('opus') }]).join('\n')).toContain(
      'Code · opus',
    );
  });

  it('keeps the agent binding out of gate logs', () => {
    const logs = tail(initial, 2, raised.attempt_id);
    const screen = draw(
      80,
      { ...logs, gates: openGates(null) },
      [first, raised],
      raised.attempt_id,
    ).join('\n');
    expect(screen).toContain('Gates · Live');
    expect(screen).not.toContain('sonnet/high');
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

describe('the progress column hidden', () => {
  it('leaves the log the first column, so a selection takes nothing else', () => {
    const title = uiText('A task');
    const rows = (paneHidden: boolean) => {
      const record = { ...initialLogs('t1', title, 2), filling: false, paneHidden };
      const frame = new Frame(120, 8);
      logsBody({ ...initialState({ cols: 120, rows: 40 }), logs: record })(frame, 0, 8);
      return Array.from({ length: 8 }, (_, y) => frame.rowBytes(y)).join('\n');
    };
    expect(rows(false)).toContain('│');
    expect(rows(true)).not.toContain('│');
    expect(rows(true)).not.toContain('Progress');
  });
});

describe('the end of the log on screen', () => {
  it('leaves an empty row above the key bar, and the scrolling counts it', () => {
    const records = Array.from({ length: 40 }, (_, i) => ({
      seq: i + 1,
      cursor: i + 1,
      operation_id: 'op',
      attempt_id: null,
      step: null,
      at: sanitize('2026-11-01T10:20:30.000Z'),
      kind: sanitize('stdout'),
      data: `line ${i + 1}`,
    }));
    const start = { ...initialLogs('t1', uiText('A task'), 2), tailing: false, paneHidden: true };
    const page = {
      task_id: 't1',
      records,
      next_cursor: 40,
      complete: false,
    } as unknown as TaskLogs;
    const logs = applyLogPage(start, { kind: 'forward', after: 0 }, page, 0);
    const frame = new Frame(120, 12);
    logsBody({ ...initialState({ cols: 120, rows: 40 }), logs })(frame, 0, 12);
    expect(frame.rowBytes(10)).toContain('line 40');
    expect(frame.rowBytes(11)).toBe('');
    expect(logRows(12)).toBe(8);
  });
});

describe('the runs of deputy turns among the attempts', () => {
  // A finished task: the coder, a deputy turn retried once, then the reviewer.
  const state = (): TuiState => {
    const title = uiText('A task');
    const detail = initialDetail('t1', title, 1);
    const show = {
      status: 'DONE',
      provenance: { usage: usage(['code', 'review']) },
      deputy_runs: [
        { attempt_id: 'deputy-0', binding: sanitize('claude'), at: 1 },
        { attempt_id: 'deputy-1', binding: sanitize('claude'), at: 1 },
      ],
    } as unknown as TaskShow;
    return {
      ...initialState({ cols: 120, rows: 40 }),
      screens: ['home', 'logs'],
      detail: { ...detail, show: { ...detail.show, data: show } },
      logs: { ...initialLogs('t1', title, 2), complete: true },
    };
  };
  const run = (s: TuiState, ...commands: Command[]): TuiState =>
    commands.reduce((acc, c) => onLogsCommand(acc, c)?.state ?? acc, s);

  it('takes each run where the log shows it, between the workers', () => {
    const reviewer = run(state(), 'attempts', 'end', 'open');
    expect(reviewer.logs?.attemptFilter).toBe('attempt-1');
    const second = run(reviewer, 'previous_step');
    expect(second.logs?.attemptFilter).toBe('deputy-1');
    expect(run(second, 'previous_step').logs?.attemptFilter).toBe('deputy-0');
    expect(run(second, 'previous_step', 'previous_step').logs?.attemptFilter).toBe('attempt-0');
  });

  it('lists the runs of the retried turn in the chooser, each one to open', () => {
    const rows = treeRows(attemptGroups(withDeputyRuns(state().detail?.show.data)), [
      'g:0',
      'r:deputy-0',
    ]);
    expect(rows.map((r) => (r.kind === 'attempt' ? r.attempt.id : r.kind))).toEqual([
      'live',
      'group',
      'attempt-0',
      'run',
      'deputy-0',
      'deputy-1',
      'group',
    ]);
  });
});
