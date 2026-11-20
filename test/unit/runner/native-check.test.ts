import { appendFileSync, copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VendorPin } from '../../../src/adapters/harness/vendor.ts';
import { binaryDigest } from '../../../src/application/capabilities.ts';
import {
  nativeCheck,
  sandboxProblem,
  type ObservedBinary,
} from '../../../src/runner/native-check.ts';
import { tempDir } from '../../support/runner-harness.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A `codex sandbox` that logs each call. `leak` lets the outside write through; `inside` lets a read-only
 * profile write in its own worktree, as workspace-write would.
 */
function codex(mode: 'refuse' | 'leak' | 'inside' = 'refuse') {
  const dir = tempDir('cusr-native-check-', dirs);
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  const path = join(dir, 'codex');
  const allow = {
    refuse: 'false',
    leak: 'true',
    inside: 'case "$2" in "$wt"/*) true;; *) false;; esac',
  }[mode];
  writeFileSync(
    path,
    `#!/bin/sh
echo "$3" >> '${calls}'
wt="$5"
while [ "$1" != "--" ]; do shift; done; shift
if [ "$1" = "/usr/bin/true" ]; then exit 0; fi
if ${allow}; then "$@"; exit $?; fi
echo "touch: cannot touch '$2': Permission denied" >&2; exit 1
`,
    { mode: 0o755 },
  );
  const pin = {
    schema_version: 1,
    vendor: 'codex',
    binary: { realpath: path, path, version: 'v', sha256: 'x' },
    toolchain: [],
    env: {},
    home_files: [],
    settings: null,
    permission_mode: 'auto',
    max_turns: null,
    tools: null,
  } as unknown as VendorPin;
  const observed = (file = path): ObservedBinary => ({
    realpath: file,
    digest: binaryDigest(file),
  });
  const count = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean);
  return { dir, path, pin, observed, count };
}

describe('native sandbox check of the binary about to run', () => {
  it('reuses a passing verdict only for the same bytes and profile', () => {
    const c = codex();
    expect(nativeCheck(c.pin, 'coder', c.observed(), c.dir)).toBe(true);
    expect(nativeCheck(c.pin, 'coder', c.observed(), c.dir)).toBe(true);
    expect(c.count()).toEqual([':workspace', ':workspace']);
    // Read-only also tries a write inside its worktree.
    expect(nativeCheck(c.pin, 'reviewer', c.observed(), c.dir)).toBe(true);
    expect(c.count()).toHaveLength(5);
    const copy = join(c.dir, 'codex-2');
    copyFileSync(c.path, copy);
    appendFileSync(copy, '# 2\n');
    expect(nativeCheck(c.pin, 'coder', c.observed(copy), c.dir)).toBe(true);
    expect(c.count()).toHaveLength(7);
  });

  it('checks a failing sandbox again at the next launch', () => {
    const c = codex('leak');
    expect(nativeCheck(c.pin, 'coder', c.observed(), c.dir)).toBe(false);
    expect(nativeCheck(c.pin, 'coder', c.observed(), c.dir)).toBe(false);
    expect(c.count()).toHaveLength(4);
  });

  it('refuses a read-only profile that writes in its own worktree like workspace-write', () => {
    const c = codex('inside');
    expect(nativeCheck(c.pin, 'coder', c.observed(), c.dir)).toBe(true);
    expect(nativeCheck(c.pin, 'reviewer', c.observed(), c.dir)).toBe(false);
  });

  it('does not count a check of bytes that changed while it ran', () => {
    const c = codex();
    const before = c.observed();
    appendFileSync(c.path, '# replaced\n');
    expect(nativeCheck(c.pin, 'coder', before, c.dir)).toBe(false);
  });

  it("takes setup's verdict only for the bytes setup checked", () => {
    const c = codex();
    const check = vi.fn(() => false);
    const at = c.observed();
    const manifest = {
      binary: { realpath: c.path, version: 'v', digest: at.digest },
      native_result: 'passed' as const,
    };
    expect(sandboxProblem(c.pin, manifest, 'coder', at, c.dir, check)).toBeNull();
    expect(check).not.toHaveBeenCalled();
    const other: ObservedBinary = { ...at, digest: `sha256:${'b'.repeat(64)}` };
    expect(sandboxProblem(c.pin, manifest, 'coder', other, c.dir, check)).toContain(
      'workspace sandbox of',
    );
    // Setup's verdict is of the workspace profile; a reviewer is always checked.
    expect(sandboxProblem(c.pin, manifest, 'reviewer', at, c.dir, check)).toContain(
      'read-only sandbox of',
    );
    expect(check).toHaveBeenCalledTimes(2);
  });
});
