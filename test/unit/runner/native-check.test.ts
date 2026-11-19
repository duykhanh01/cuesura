import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VendorPin } from '../../../src/adapters/harness/vendor.ts';
import { nativeCheck, sandboxProblem } from '../../../src/runner/native-check.ts';
import type { Hash } from '../../../src/shared/brand.ts';
import { tempDir } from '../../support/runner-harness.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A `codex sandbox` that logs each call; `leak` lets the outside write through. */
function codex(leak: boolean) {
  const dir = tempDir('cusr-native-check-', dirs);
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  const path = join(dir, 'codex');
  writeFileSync(
    path,
    `#!/bin/sh
echo "$3" >> '${calls}'
while [ "$1" != "--" ]; do shift; done; shift
if [ "$1" = "/usr/bin/true" ]; then exit 0; fi
${leak ? '"$@"; exit $?' : `echo "touch: cannot touch '$2': Permission denied" >&2; exit 1`}
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
  const count = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean);
  return { dir, pin, count };
}

const A = 'sha256:aaaa' as Hash;
const B = 'sha256:bbbb' as Hash;

describe('native sandbox check of the binary about to run', () => {
  it('reuses a passing verdict only for the same bytes and profile', () => {
    const c = codex(false);
    expect(nativeCheck(c.pin, 'coder', A, c.dir)).toBe(true);
    expect(nativeCheck(c.pin, 'coder', A, c.dir)).toBe(true);
    expect(c.count()).toEqual([':workspace', ':workspace']);
    expect(nativeCheck(c.pin, 'reviewer', A, c.dir)).toBe(true);
    expect(nativeCheck(c.pin, 'coder', B, c.dir)).toBe(true);
    expect(c.count()).toHaveLength(6);
  });

  it('checks a failing sandbox again at the next launch', () => {
    const c = codex(true);
    expect(nativeCheck(c.pin, 'coder', A, c.dir)).toBe(false);
    expect(nativeCheck(c.pin, 'coder', A, c.dir)).toBe(false);
    expect(c.count()).toHaveLength(4);
  });

  it("takes setup's verdict only for the bytes setup checked", () => {
    const { pin, dir } = codex(false);
    const check = vi.fn(() => false);
    const manifest = {
      binary: { realpath: '/x', version: 'v', digest: A },
      native_result: 'passed' as const,
    };
    expect(sandboxProblem(pin, manifest, 'coder', A, dir, check)).toBeNull();
    expect(check).not.toHaveBeenCalled();
    expect(sandboxProblem(pin, manifest, 'coder', B, dir, check)).toContain('workspace sandbox of');
    // Setup's verdict is of the workspace profile; a reviewer is always checked.
    expect(sandboxProblem(pin, manifest, 'reviewer', A, dir, check)).toContain(
      'read-only sandbox of',
    );
    expect(check).toHaveBeenCalledTimes(2);
  });
});
