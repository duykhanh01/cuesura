import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { installInitItems } from '../../../src/application/init.ts';

vi.mock('../../../src/application/init-assistant.ts', async (original) => ({
  ...(await original<typeof import('../../../src/application/init-assistant.ts')>()),
  cusrSkillFiles: () => {
    throw new Error('skill missing from this build');
  },
}));

const root = mkdtempSync(join(tmpdir(), 'cusr-init-missing-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('a build without the skill stops before any write, so nothing goes unreported', () => {
  execFileSync('git', ['init', '-q', root]);
  expect(() =>
    installInitItems(root, ['write-pr', 'assistant'], { force: false, dataDir: '/data' }),
  ).toThrow('skill missing from this build');
  expect(existsSync(join(root, '.github'))).toBe(false);
});
