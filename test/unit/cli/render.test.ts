import { describe, expect, it } from 'vitest';
import { renderBoard, renderProgress, renderTaskList } from '../../../src/cli/render.ts';

const TASK = '019a0000-0000-7000-8000-000000000001';

const board = {
  unchanged: false,
  watermark: 1,
  counts: { by_status: { DONE: 2 } },
  queue: { length: 0 },
  attention: { items: [], truncated: false },
  items: [],
  next_cursor: TASK,
};

describe('renderBoard', () => {
  it('keeps every flag in the next page, quoted so it can be pasted', () => {
    const out = renderBoard([
      '--project',
      "it's a project",
      '--scope',
      'all',
      '--data-dir',
      '/data dir',
    ])(board);
    expect(out).toContain(
      `More: cusr task board --project 'it'\\''s a project' --scope all --data-dir '/data dir' --cursor ${TASK}`,
    );
  });

  it('cannot carry a terminal command in a flag', () => {
    const out = renderBoard(['--project', 'a\x1b[2Jb'])(board);
    expect(out).not.toContain('\x1b');
    expect(out).toContain('␛[2J');
  });
});

describe('renderProgress', () => {
  it('does not call a step that ran done: a failed gate has run too', () => {
    const out = renderProgress({
      task_id: TASK,
      version: 1,
      mode: 'direct-pr',
      steps: [
        { name: 'gates', state: 'past', visits: 1 },
        { name: 'fix_gates', state: 'current', visits: 1 },
        { name: 'merge', state: 'remaining', visits: 0 },
        { name: 'review', state: 'not_required', visits: 0 },
      ],
      reason: null,
      needs_user: false,
      worktree_path: null,
    });
    expect(out).toMatch(/^visited\s+gates$/m);
    expect(out).toMatch(/^current\s+fix_gates$/m);
    expect(out).toMatch(/^next\s+merge$/m);
    expect(out).toMatch(/^not required\s+review$/m);
    expect(out).not.toContain('done');
  });
});

describe('renderTaskList', () => {
  it('marks a DONE nobody verified and shows why a task ended (issue #264)', () => {
    const long = `dependency_failed:root=${TASK} via=${TASK} (CANCELLED)`;
    const out = renderTaskList([])({
      items: [
        {
          task_id: 't1',
          project: 'acme',
          title: 'One',
          status: 'DONE',
          terminal: { kind: 'DONE', reason: 'merged' },
          unverified: { reason: 'merged_head_unverified' },
        },
        {
          task_id: 't2',
          project: 'acme',
          title: 'Two',
          status: 'CANCELLED',
          activity: 'code',
          terminal: { kind: 'CANCELLED', reason: long },
        },
        {
          task_id: 't3',
          project: 'acme',
          title: 'Three',
          status: 'DONE',
          terminal: { kind: 'DONE', reason: 'merged' },
        },
      ],
      next_cursor: null,
    });
    const row = (id: string) => out.split('\n').find((l) => l.startsWith(id)) ?? '';
    expect(row('t1')).toMatch(/DONE \(unverified\)\s+merged\s/);
    expect(row('t2')).toContain(`${long.slice(0, 59)}…`);
    expect(row('t2')).not.toContain(' code ');
    expect(row('t3')).not.toContain('unverified');
  });

  it('notes tasks that change the same files or conflict with their base (issue #210)', () => {
    const out = renderTaskList([])({
      items: [
        {
          task_id: 't1',
          project: 'acme',
          title: 'One',
          status: 'RUNNING',
          overlaps: ['t2'],
          base_conflicts: ['src/a.ts'],
        },
        { task_id: 't2', project: 'acme', title: 'Two', status: 'WAITING', overlaps: ['t1'] },
        { task_id: 't3', project: 'acme', title: 'Three', status: 'READY' },
        { task_id: 't4', project: 'acme', title: 'Four', status: 'RUNNING', scope_unknown: true },
      ],
      next_cursor: null,
    });
    expect(out).toContain('Overlap: t1 changes files also changed by t2');
    expect(out).toContain('Overlap: t2 changes files also changed by t1');
    expect(out).toContain('Base conflict: t1 conflicts with its base on src/a.ts');
    expect(out).not.toContain('t3 changes');
    expect(out).toContain("Scope unknown: t4's branch could not be read");
    expect(out).not.toContain('Scope unknown: t1');
  });
});
