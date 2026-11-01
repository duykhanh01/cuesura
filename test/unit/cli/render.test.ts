import { describe, expect, it } from 'vitest';
import { renderBoard, renderProgress } from '../../../src/cli/render.ts';

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
