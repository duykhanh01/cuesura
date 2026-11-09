import { describe, expect, it } from 'vitest';
import type { TaskHistory, TaskShow } from '../../../src/tui/client/schemas.ts';
import { actorWords, ending, initialDetail, onDetailRead } from '../../../src/tui/model/detail.ts';
import { reduce } from '../../../src/tui/model/reduce.ts';
import { animating, initialState, type TuiState } from '../../../src/tui/model/state.ts';
import { progressStages, rowStages } from '../../../src/tui/model/stages.ts';
import { uiText } from '../../../src/tui/terminal/safe-text.ts';
import { plain } from '../../../src/tui/views/ink.ts';
import { markdownRows } from '../../../src/tui/views/markdown.ts';
import { dots, endBadge, stepper } from '../../../src/tui/views/stepper.ts';

type Step = Parameters<typeof progressStages>[0][number];
const step = (name: string, state: Step['state'], visits = 1): Step => ({
  name: uiText(name),
  state,
  visits,
});

/** The path as read, with the no-break spaces that keep a stage whole made plain. */
const spaced = (segs: Parameters<typeof plain>[0]): string => plain(segs).replaceAll('\u00a0', ' ');

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

  describe('never goes back', () => {
    const steps = (current: string, visits: Readonly<Record<string, number>>): Step[] =>
      [
        'triage',
        'prepare',
        'code',
        'gates',
        'fix_gates',
        'publish',
        'pr',
        'review',
        'post_changes',
        'fix_review',
        'post_review',
        'ready',
        'ci',
        'ci_fix',
        'merge_gate',
      ].map((name) => {
        const n = visits[name] ?? 0;
        return step(name, name === current ? 'current' : n > 0 ? 'past' : 'remaining', n);
      });
    const once = { triage: 1, prepare: 1, code: 1, publish: 1, pr: 1 };
    const states = (stages: readonly { readonly state: string }[] | null | undefined): string[] =>
      (stages ?? []).map((s) => s.state);
    const atReview = ['done', 'done', 'done', 'done', 'done', 'current', 'todo', 'todo'];
    const atCi = ['done', 'done', 'done', 'done', 'done', 'done', 'current', 'todo'];

    it.each([
      ['gates', { ...once, gates: 2, review: 1, post_changes: 1, fix_review: 1 }],
      ['fix_gates', { ...once, gates: 3, fix_gates: 1, review: 1, post_changes: 1, fix_review: 1 }],
      ['publish', { ...once, gates: 2, publish: 2, review: 1, post_changes: 1, fix_review: 1 }],
      ['pr', { ...once, gates: 2, publish: 2, pr: 2, review: 1, post_changes: 1, fix_review: 1 }],
    ])('%s after a review fix stays on review', (current, visits) => {
      expect(states(progressStages(steps(current, visits), 'RUNNING'))).toEqual(atReview);
      const row = { status: 'RUNNING', step: current, step_visits: visits, mode: 'full-review' };
      expect(states(rowStages(row as Parameters<typeof rowStages>[0]))).toEqual(atReview);
    });

    it.each([
      ['gates', { ...once, gates: 2, review: 1, post_review: 1, ready: 1, ci: 1, ci_fix: 1 }],
      ['review', { ...once, gates: 2, review: 2, post_review: 1, ready: 1, ci: 1, ci_fix: 1 }],
      // First time this step runs, but its stage ran before.
      [
        'post_changes',
        { ...once, gates: 2, review: 2, post_review: 1, ready: 1, ci: 1, ci_fix: 1 },
      ],
    ])('%s after a CI fix stays on CI', (current, visits) => {
      expect(states(progressStages(steps(current, visits), 'RUNNING'))).toEqual(atCi);
    });

    it('counts the run of a stage held behind the current one', () => {
      const stages = progressStages(
        steps('gates', { ...once, gates: 2, review: 1, post_changes: 1, fix_review: 1 }),
        'RUNNING',
      );
      expect(stages?.find((s) => s.name === 'gates')).toMatchObject({ state: 'done', runs: 2 });
    });

    it('a first pass through gate fixes stays on gates', () => {
      const visits = { triage: 1, prepare: 1, code: 1, gates: 2, fix_gates: 1 };
      expect(progressStages(steps('gates', visits), 'RUNNING')?.[3]?.state).toBe('current');
    });

    it('marks a task that ended in a recheck at the stage held', () => {
      const visits = { ...once, gates: 2, review: 1, post_changes: 1, fix_review: 1 };
      expect(progressStages(steps('gates', visits), 'FAILED')?.[5]?.state).toBe('failed');
    });

    it('still shows the PR of the graph without modes, which runs after the review', () => {
      const visits = { triage: 1, prepare: 1, code: 1, gates: 1, review: 1, publish: 1, pr: 1 };
      const stages = progressStages(steps('pr', visits), 'RUNNING');
      expect(stages?.find((s) => s.name === 'pr')?.state).toBe('current');
    });

    it('falls back to the current step for a daemon that does not send what ran', () => {
      const stages = rowStages({ status: 'RUNNING', step: 'gates', mode: 'full-review' });
      expect(stages?.[3]?.state).toBe('current');
    });
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

  it('a cancelled task stops at its stage: no stage after it reads as still to come', () => {
    const stages = progressStages(
      [
        step('triage', 'past'),
        step('prepare', 'past'),
        step('code', 'current'),
        step('gates', 'remaining', 0),
      ],
      'CANCELLED',
    );
    expect(stages?.map((st) => st.state)).toEqual([
      'done',
      'done',
      'stopped',
      'abandoned',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
    ]);
    const row = rowStages({ status: 'CANCELLED', step: 'code', mode: 'full-review' });
    expect(row?.slice(2, 4).map((st) => st.state)).toEqual(['stopped', 'abandoned']);
    const path = spaced(stepper(stages ?? [], 'CANCELLED'));
    expect(path).toContain('code cancelled ■');
    expect(path).toContain('gates ·');
    expect(path).not.toContain('○');
  });

  it('tells a pause, a failure and a cancellation apart by mark and word, not by colour alone', () => {
    const at = (status: 'WAITING' | 'FAILED' | 'CANCELLED'): string =>
      spaced(stepper(rowStages({ status, step: 'ci', mode: 'full-review' }) ?? [], status));
    expect(at('WAITING')).toContain('CI waiting ‖');
    expect(at('FAILED')).toContain('CI failed ✕');
    expect(at('CANCELLED')).toContain('CI cancelled ■');
    expect(at('FAILED')).toContain('merge ·');
    expect(at('WAITING')).toContain('merge ○');
    expect(endBadge('CANCELLED')?.text).toBe('■ CANCELLED');
    expect(endBadge('FAILED')?.text).toBe('✕ FAILED');
    expect(endBadge('WAITING')).toBeNull();
  });

  it('on Home the bars stop where the task ended', () => {
    const stages = rowStages({ status: 'CANCELLED', step: 'code', mode: 'full-review' }) ?? [];
    const bars = dots(stages, 'CANCELLED');
    expect(plain(bars)).toBe('▌▌▌     ');
    expect(bars[2]?.style).toEqual({ fg: 'orange' });
    expect(plain(dots(stages, 'CANCELLED', false))).toBe('●●■·····');
  });

  it('says who ended a task and why, from the event that ended it', () => {
    const d = initialDetail('t', uiText('T'), 1);
    const events = [
      {
        seq: 1,
        type: 'TaskCreated',
        revision: 1,
        actor: 'owner',
        payload: { reason: 'not this one' },
      },
      {
        seq: 2,
        type: 'TaskCancelled',
        revision: 2,
        actor: 'assistant',
        payload: { reason: 'superseded' },
      },
    ];
    const s = onDetailRead(
      { ...initialState({ cols: 100, rows: 30 }), detail: d },
      {
        type: 'detail_read',
        taskId: 't',
        session: 1,
        askedAt: 1,
        at: 1,
        watermark: null,
        version: 2,
        part: 'history',
        result: {
          ok: true,
          value: { task_id: 't', events, next_cursor: 2, more: false } as unknown as TaskHistory,
        },
      },
    );
    expect(s.detail === null ? null : ending(s.detail)).toEqual({
      actor: 'assistant',
      reason: 'superseded',
    });
    expect(ending(d)).toBeNull();
  });

  it('draws one bar per stage and gives each state its own colour', () => {
    const stages = (['done', 'current', 'skipped', 'todo'] as const).map((state) => ({
      name: 'code' as const,
      state,
      runs: 1,
    }));
    const bars = dots(stages, 'RUNNING');
    expect(plain(bars)).toBe('▌▌▌▌');
    expect(bars.map((b) => b.style)).toEqual([
      { fg: 'green' },
      { fg: 'cyan', bold: true },
      { fg: 'gray' },
      { dim: true },
    ]);
    expect(plain(dots(stages, 'RUNNING', false))).toBe('●◉–○');
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
    expect(animating(withStatus('RUNNING', ['home', 'logs']))).toBe(true);
    expect(animating(withStatus('WAITING', ['home', 'logs']))).toBe(false);
    expect(animating(withStatus('RUNNING', ['home']))).toBe(false);
  });

  it('a tick moves the frame and nothing else', () => {
    const s = withStatus('RUNNING', ['home', 'logs']);
    const r = reduce(s, { type: 'tick' });
    expect(r.state).toEqual({ ...s, tick: 1 });
    expect(r.effects).toEqual([]);
  });
});

describe('who ended a task', () => {
  it('says Cuesura for a part of the daemon, and keeps a person as named', () => {
    expect(actorWords(uiText('system:effect_result'))).toBe('Cuesura');
    expect(actorWords(uiText('owner'))).toBe('owner');
  });
});
