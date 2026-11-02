import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../../src/adapters/harness/claude.ts';
import { codexAdapter } from '../../../src/adapters/harness/codex.ts';
import {
  ensurePrivateTmpDir,
  HostExecutionProvider,
  SandboxPolicyError,
  shortTmpDir,
  snapshotWriteZone,
  writeZoneViolations,
} from '../../../src/runner/sandbox.ts';

const LONG = `/home/someone/cuesura-dogfood/data/runs/${'0'.repeat(36)}/scratch-${process.pid}`;
const SOCKET = 'claude-socks-0123456789abcdef.sock';

afterEach(() => {
  rmSync(shortTmpDir(LONG), { recursive: true, force: true });
});

describe('the short TMPDIR of a run', () => {
  it('leaves room for the bridge socket under any data dir', () => {
    expect(`${LONG}/${SOCKET}`.length).toBeGreaterThan(108);
    expect(`${shortTmpDir(LONG)}/${SOCKET}`.length).toBeLessThanOrEqual(108);
  });

  it('names one directory per scratch dir, so a recovery finds it', () => {
    expect(shortTmpDir(LONG)).toBe(shortTmpDir(LONG));
    expect(shortTmpDir(LONG)).not.toBe(shortTmpDir(`${LONG}x`));
  });

  it('is what TMPDIR becomes when the layout names it, and scratch otherwise', () => {
    const tmpOf = (tmp_dir?: string) => {
      const plan = new HostExecutionProvider().plan(
        {
          role: 'coder',
          worktree: tmpdir(),
          git_dirs: [],
          scratch: LONG,
          ...(tmp_dir === undefined ? {} : { tmp_dir }),
          private_home: tmpdir(),
          context: null,
          schema: null,
          toolchain: [],
          env: {},
          network: 'internet_outbound',
        },
        ['/bin/true'],
      );
      if (!plan.ok) throw new Error(plan.error.message);
      return plan.value.env['TMPDIR'];
    };
    expect(tmpOf()).toBe(LONG);
    expect(tmpOf(shortTmpDir(LONG))).toBe(shortTmpDir(LONG));
  });

  it('only the binary that needs it asks for it', () => {
    expect(claudeAdapter.needs_short_tmpdir).toBe(true);
    expect(codexAdapter.needs_short_tmpdir).toBe(false);
  });

  it('is created private, and accepted again by the same user', () => {
    const dir = shortTmpDir(LONG);
    ensurePrivateTmpDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    ensurePrivateTmpDir(dir);
  });

  it('refuses an entry someone else could have prepared', () => {
    const dir = shortTmpDir(LONG);
    mkdirSync(dir, { mode: 0o755 });
    expect(() => {
      ensurePrivateTmpDir(dir);
    }).toThrow(SandboxPolicyError);
    rmSync(dir, { recursive: true });
    symlinkSync('/tmp', dir);
    expect(() => {
      ensurePrivateTmpDir(dir);
    }).toThrow(SandboxPolicyError);
  });
});

describe('the read-only worktree of a reviewer', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const worktree = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'cusr-zone-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'README.md'), 'hi');
    return dir;
  };
  const changes = (dir: string, act: () => void): string[] => {
    const zone = { role: 'reviewer' as const, worktree: dir, git_dirs: [] };
    const state = claudeAdapter.worktree_state;
    const before = snapshotWriteZone(zone, state);
    act();
    return writeZoneViolations(before, snapshotWriteZone(zone, state));
  };

  it('ignores the empty state directory Claude Code makes for itself', () => {
    const dir = worktree();
    expect(
      changes(dir, () => {
        mkdirSync(join(dir, '.claude', '.cc-writes'), { recursive: true });
      }),
    ).toEqual([]);
  });

  it('keeps ignoring it when the repository tracks other files under .claude', () => {
    const dir = worktree();
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), '{}');
    expect(
      changes(dir, () => {
        mkdirSync(join(dir, '.claude', '.cc-writes'));
      }),
    ).toEqual([]);
  });

  it.each([
    ['a file in that directory', '.claude/.cc-writes/x'],
    ['another file under .claude', '.claude/settings.json'],
    ['a file elsewhere', 'other.txt'],
  ])('reports %s', (_name, file) => {
    const dir = worktree();
    expect(
      changes(dir, () => {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), 'x');
      }),
    ).toHaveLength(1);
  });

  it('reports the same name in a nested directory', () => {
    const dir = worktree();
    expect(
      changes(dir, () => {
        mkdirSync(join(dir, 'pkg', '.claude', '.cc-writes'), {
          recursive: true,
        });
      }),
    ).toHaveLength(1);
  });

  it('reports that directory for a binary that does not declare it', () => {
    const dir = worktree();
    const zone = { role: 'reviewer' as const, worktree: dir, git_dirs: [] };
    const before = snapshotWriteZone(zone, codexAdapter.worktree_state);
    mkdirSync(join(dir, '.claude', '.cc-writes'), { recursive: true });
    expect(
      writeZoneViolations(
        before,
        snapshotWriteZone(zone, codexAdapter.worktree_state),
      ),
    ).toHaveLength(1);
  });

  it('reports a changed file under .claude', () => {
    const dir = worktree();
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), '{}');
    expect(
      changes(dir, () => {
        writeFileSync(join(dir, '.claude', 'settings.json'), '{"a":1}');
      }),
    ).toHaveLength(1);
  });
});
