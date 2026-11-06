import { describe, expect, it } from 'vitest';
import { initialDetail, type TaskDetail } from '../../../src/tui/model/detail.ts';
import { initialState, type TuiState } from '../../../src/tui/model/state.ts';
import { sanitize, uiText } from '../../../src/tui/terminal/safe-text.ts';
import { renderFrame } from '../../../src/tui/views/layout.ts';
import { screenBody } from '../../../src/tui/views/screen-body.ts';

const TASK = '00000000-0000-7000-8000-000000000001';
const AT = 1_000;

function screen(detail: TaskDetail): string {
  const s: TuiState = {
    ...initialState({ cols: 100, rows: 30 }),
    connection: { kind: 'online' },
    screens: ['home', 'detail'],
    detail,
  };
  const f = renderFrame(s, screenBody(s, { color: false }), { color: false });
  return Array.from({ length: f.rows }, (_, y) => f.rowBytes(y)).join('\n');
}

const failed = { data: null, error: sanitize('unknown shape'), attemptAt: AT, readAt: null };

describe('Task detail before its reads have an answer', () => {
  it('says Reading… while the reads are on their way', () => {
    const text = screen(initialDetail(TASK, uiText('Task'), 1));
    expect(text).toContain('Reading…');
    expect(text).not.toContain('Could not be read');
  });

  it('never says Reading… next to the error of the read it stands for', () => {
    const d = initialDetail(TASK, uiText('Task'), 1);
    const text = screen({ ...d, explain: failed, show: failed, progress: failed });
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
