import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../../../src/config/validate.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import { deputyUserConfig, worktreeMark } from '../../support/deputy.ts';
import { gitSandbox, type GitSandbox } from '../../support/git-repo.ts';

let git: GitSandbox | null = null;
afterEach(() => {
  git?.cleanup();
  git = null;
});

describe('deputy builders', () => {
  it('build valid user configs with and without the deputy roles', () => {
    for (const o of [
      {},
      { deputy: true },
      { decider: true, autonomous: true },
      { autonomous: false },
    ]) {
      const r = validateConfig({ user: deputyUserConfig(o), packs: PACKS });
      expect(r.ok, JSON.stringify(o)).toBe(true);
      if (!r.ok) continue;
      expect(r.value.config.user.roles['deputy'] !== undefined).toBe('deputy' in o);
      expect(r.value.config.user.autonomous ?? false).toBe(
        (o as { autonomous?: boolean }).autonomous ?? false,
      );
    }
  });

  it('marks a worktree so that any edit, new file or commit shows', () => {
    git = gitSandbox('cusr-mark-');
    const dir = git.repo();
    const base = worktreeMark(git, dir);
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    expect(worktreeMark(git, dir)).not.toEqual(base);
    git.sh(dir, 'checkout', '-q', '--', 'a.txt');
    mkdirSync(join(dir, 'new'));
    writeFileSync(join(dir, 'new', 'b.txt'), 'b\n');
    expect(worktreeMark(git, dir)).not.toEqual(base);
    git.sh(dir, 'clean', '-qfd');
    expect(worktreeMark(git, dir)).toEqual(base);
  });
});
