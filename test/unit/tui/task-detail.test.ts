import { describe, expect, it } from 'vitest';
import type { TaskContent } from '../../../src/tui/client/schemas.ts';
import { initialDetail, type TaskDetail } from '../../../src/tui/model/detail.ts';
import { initialState, type TuiState } from '../../../src/tui/model/state.ts';
import { sanitize, sanitizeLines, uiText } from '../../../src/tui/terminal/safe-text.ts';
import { renderFrame } from '../../../src/tui/views/layout.ts';
import { screenBody } from '../../../src/tui/views/screen-body.ts';

const TASK = '00000000-0000-7000-8000-000000000001';
const AT = 1_000;

function screen(detail: TaskDetail, rows = 30): string {
  const s: TuiState = {
    ...initialState({ cols: 100, rows }),
    connection: { kind: 'online' },
    screens: ['home', 'detail'],
    detail,
  };
  const f = renderFrame(s, screenBody(s, { color: false }), { color: false });
  return Array.from({ length: f.rows }, (_, y) => f.rowBytes(y)).join('\n');
}

// Without styles, so a label and its value read as one string.
// eslint-disable-next-line no-control-regex
const tall = (detail: TaskDetail): string => screen(detail, 80).replace(/\x1b\[[0-9;]*m/g, '');

const failed = { data: null, error: sanitize('unknown shape'), attemptAt: AT, readAt: null };

describe('Task detail before its reads have an answer', () => {
  it('says Reading… while the reads are on their way', () => {
    const text = screen(initialDetail(TASK, uiText('Task'), 1));
    expect(text).toContain('Reading…');
    expect(text).not.toContain('Could not be read');
  });

  it('never says Reading… next to the error of the read it stands for', () => {
    const d = initialDetail(TASK, uiText('Task'), 1);
    const text = screen({ ...d, explain: failed, show: failed, progress: failed, content: failed });
    expect(text).toContain('Could not read the explanation: unknown shape');
    expect(text).toContain('Could not be read');
    expect(text).not.toContain('Reading…');
  });

  it('keeps Reading… for a section whose own read has not failed', () => {
    const d = initialDetail(TASK, uiText('Task'), 1);
    const text = screen({ ...d, explain: failed });
    expect(text).toContain('Could not be read');
    expect(text).toContain('Reading…');
  });
});

describe('Task detail says what the task asks for (FR-015.01)', () => {
  const content = (over: Partial<TaskContent> = {}): TaskContent => ({
    task_id: TASK as TaskContent['task_id'],
    project: 'cuesura',
    version: 3,
    revision: 1,
    base_branch: sanitize('main'),
    title: sanitize('Task'),
    description: sanitize('Show the request on Task detail.'),
    requirements: [sanitize('Read task_content')],
    acceptance: [sanitize('The description is on screen')],
    constraints: [sanitize('No new daemon query')],
    out_of_scope: [sanitize('The Review screen')],
    depends_on: [],
    priority: 0,
    intake_pending: false,
    run_config: null,
    ...over,
  });
  const withContent = (c: TaskContent, technical = false): TaskDetail => ({
    ...initialDetail(TASK, uiText('Task'), 1),
    technical,
    content: { data: c, error: null, attemptAt: AT, readAt: AT },
  });

  it('shows the description, requirements and acceptance, and keeps the rest behind i', () => {
    const plain = tall(withContent(content()));
    expect(plain).toContain('Request');
    expect(plain).toContain('Show the request on Task detail.');
    expect(plain).toContain('• Read task_content');
    expect(plain).toContain('• The description is on screen');
    expect(plain).not.toContain('No new daemon query');
    const technical = tall(withContent(content(), true));
    expect(technical).toContain('• No new daemon query');
    expect(technical).toContain('• The Review screen');
    expect(technical).toMatch(/Base branch\s+main/);
  });

  it('cuts a long description on the plain screen and says how to see it whole', () => {
    const long = content({
      description: sanitizeLines(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')),
    });
    const plain = tall(withContent(long));
    expect(plain).toContain('line 6');
    expect(plain).not.toContain('line 7');
    expect(plain).toContain('14 more lines: press i to see the whole request');
    expect(tall(withContent(long, true))).toContain('line 20');
  });

  it('says no acceptance rather than nothing', () => {
    expect(tall(withContent(content({ acceptance: [] })))).toMatch(/Acceptance\s+none/);
  });

  it('says why the request could not be read', () => {
    const d = { ...initialDetail(TASK, uiText('Task'), 1), content: failed };
    expect(tall(d)).toContain('Could not be read: unknown shape');
  });
});
