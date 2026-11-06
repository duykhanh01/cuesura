import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const VIEWS = 'src/tui/views';

describe('styles by role', () => {
  it('no view names a colour of its own', () => {
    const named = readdirSync(VIEWS)
      .filter((f) => f.endsWith('.ts') && f !== 'theme.ts')
      .filter((f) => /\bfg: '/.test(readFileSync(join(VIEWS, f), 'utf8')));
    expect(named).toEqual([]);
  });
});
