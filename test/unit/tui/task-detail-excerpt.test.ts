import { describe, expect, it } from 'vitest';
import { sanitizeLines } from '../../../src/tui/terminal/safe-text.ts';
import { lastLines } from '../../../src/tui/views/task-detail.ts';

describe('the excerpt of a failed gate on Task detail', () => {
  it('shows only the end, so a long excerpt does not bury the rest of the page', () => {
    const text = sanitizeLines(Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'));
    const shown = lastLines(text).split('\n');
    expect(shown).toHaveLength(20);
    expect(shown.at(-1)).toBe('line 299');
  });
});
