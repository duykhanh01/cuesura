import { describe, expect, it } from 'vitest';
import {
  DETAIL_CODES,
  TASK_STATUSES,
  type DetailCode,
  type TaskState,
} from '../../../src/domain/state.ts';
import { needsUser } from '../../../src/explain/needs-user.ts';
import {
  activity,
  activityLine,
  duration,
  markLegend,
  statusMark,
  timeInStatus,
  todo,
  type ActivityRow,
} from '../../../src/tui/model/activity.ts';
import { sanitize } from '../../../src/tui/terminal/safe-text.ts';

// Regression only (T035): whether words reach the screen is for test/contract/tui/us1-home.test.ts.

const row = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  status: 'WAITING',
  wait_code: null,
  step: null,
  mode: null,
  needs_user: false,
  ...over,
});

const needsUserOf = (code: DetailCode): boolean =>
  needsUser({
    status: 'WAITING',
    wait: { detail: { code } },
    revision: 1,
    run: { mode: null },
  } as unknown as Pick<TaskState, 'status' | 'wait' | 'revision' | 'run'>);

const coded = (code: string, needs_user = false): ActivityRow =>
  row({ wait_code: sanitize(code), needs_user });

describe('every DetailCode (FR-006)', () => {
  it.each(DETAIL_CODES)('%s has words of its own', (code) => {
    const words = activity(coded(code)) as unknown as string;
    expect(words).not.toBe(code);
    expect(words).not.toContain('_');
    expect(words.length).toBeGreaterThan(0);
  });

  it.each(DETAIL_CODES)(
    "%s tells the user what to do exactly when the daemon's table says it is theirs",
    (code) => {
      const needs = needsUserOf(code);
      const action = todo(coded(code, needs)) as unknown as string | null;
      if (!needs) {
        expect(action).toBeNull();
        return;
      }
      expect(action).not.toBeNull();
      expect(action).not.toBe(code);
      expect(action).not.toBe('Open the task for details');
    },
  );

  it('gives each code its words without two codes of different meaning being told apart only by the raw code', () => {
    const words = DETAIL_CODES.map((c) => activity(coded(c)));
    expect(new Set(words).size).toBe(DETAIL_CODES.length);
  });
});

describe('a code this version does not know', () => {
  it('shows as it came, for activity and for what to do; nothing is guessed', () => {
    const r = coded('brand_new_code', true);
    expect(activity(r)).toBe('brand_new_code');
    expect(todo(r)).toBe('brand_new_code');
  });

  it('is not taken for a property every object has', () => {
    for (const code of ['constructor', 'toString', '__proto__']) {
      expect(activity(coded(code))).toBe(code);
      expect(todo(coded(code, true))).toBe(code);
    }
  });

  it('a step this version does not know shows by its name', () => {
    expect(activity(row({ status: 'RUNNING', step: sanitize('new_step') }))).toBe('new_step');
    expect(activity(row({ status: 'RUNNING', step: sanitize('constructor') }))).toBe('constructor');
  });

  it('is sanitized, so it cannot reach the terminal as a control sequence', () => {
    const words = activity(coded('\x1b[2Jevil')) as unknown as string;
    expect(words).not.toContain('\x1b');
    expect(words).toContain('evil');
  });
});

describe('what a task is doing without a wait', () => {
  it('names the step in words while it runs', () => {
    expect(activity(row({ status: 'RUNNING', step: sanitize('code') }))).toBe('Writing code');
    expect(activity(row({ status: 'RUNNING', step: sanitize('gates') }))).toBe('Running gates');
    expect(activity(row({ status: 'RUNNING' }))).toBe('Running');
  });

  it('says what a finished task is, whatever wait it last had', () => {
    expect(activity(row({ status: 'DONE' }))).toBe('Finished');
    expect(activity(row({ status: 'FAILED' }))).toBe('Failed');
    expect(activity(row({ status: 'CANCELLED' }))).toBe('Cancelled');
  });

  it('tells an unconfirmed READY from a queued one, by what the daemon said', () => {
    expect(activity(row({ status: 'READY', needs_user: true }))).toBe('Run settings not confirmed');
    expect(activity(row({ status: 'READY' }))).toBe('Queued');
    expect(todo(row({ status: 'READY', needs_user: true }))).toBe('Confirm how to run this task');
  });

  it('never returns only the raw status', () => {
    for (const status of TASK_STATUSES) expect(activity(row({ status }))).not.toBe(status);
  });

  it('does not put a task in the group on its own account', () => {
    expect(todo(coded('agent_question', false))).toBeNull();
  });

  it('adds mode and PR only when they exist', () => {
    const r = row({ status: 'RUNNING', step: sanitize('ci') });
    expect(activityLine({ ...r, pr_ref: null })).toBe('Watching CI');
    expect(
      activityLine({
        ...r,
        mode: sanitize('direct-pr'),
        pr_ref: sanitize('acme#7'),
      }),
    ).toBe('Watching CI · direct-pr · acme#7');
  });
});

describe('status without colour (FR-035, EC-003)', () => {
  it('gives each status its own mark, beside its name', () => {
    const marks = TASK_STATUSES.map((s) => statusMark(s).text as string);
    for (const [i, status] of TASK_STATUSES.entries()) expect(marks[i]).toContain(status);
    expect(new Set(marks.map((m) => m.split(' ')[0])).size).toBe(TASK_STATUSES.length);
  });

  it('explains the marks to a terminal without colour', () => {
    const legend = markLegend() as unknown as string;
    expect(legend).toContain('No colour');
    for (const s of TASK_STATUSES)
      expect(legend).toContain((statusMark(s).text as string).split(' ')[0]);
  });
});

describe('time in status (FR-006)', () => {
  it('is "unavailable" when the daemon cannot say, never a guess', () => {
    expect(timeInStatus({ status_since: null }, 1_000)).toBe('unavailable');
    expect(timeInStatus({ status_since: 500 }, null)).toBe('unavailable');
    expect(timeInStatus({ status_since: 2_000 }, 1_000)).toBe('unavailable');
  });

  it('counts up to the last read, not to now', () => {
    expect(timeInStatus({ status_since: 1_000 }, 66_000)).toBe('1m 5s');
  });

  it.each([
    [0, '0s'],
    [59_999, '59s'],
    [60_000, '1m 0s'],
    [3_600_000, '1h 0m'],
    [90_000_000, '1d 1h'],
    [-1, null],
  ])('%d ms reads %s', (ms, words) => {
    expect(duration(ms)).toBe(words);
  });
});
