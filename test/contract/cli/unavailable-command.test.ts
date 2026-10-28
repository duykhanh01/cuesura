import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Runs the source entrypoints as real processes (Node strips types) against contracts/cli-daemon.md.
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const VERSION = (JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as { version: string }).version;
const BINARIES = ['cusr', 'cusrd', 'cusr-runner'] as const;

function exec(bin: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [`src/cli/${bin}.ts`, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe.each(BINARIES)('%s binary', (bin) => {
  it('--version prints the package version and exits 0', () => {
    expect(exec(bin, ['--version'])).toEqual({ status: 0, stdout: `${VERSION}\n`, stderr: '' });
  });

  it('--json on an unimplemented command prints one error envelope and exits 2', () => {
    const r = exec(bin, ['status', '--json']);
    expect(r.status).toBe(2);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const envelope: unknown = JSON.parse(lines[0] as string);
    expect(envelope).toEqual({
      schema_version: 1,
      ok: false,
      data: null,
      error: {
        code: 'not_available',
        message: expect.any(String) as string,
        details: expect.any(Object) as object,
        request_id: null,
      },
    });
    expect(r.stdout + r.stderr).not.toContain('\u001b[');
  });

  it('an unimplemented command without --json writes only to stderr and exits 2', () => {
    const r = exec(bin, ['status']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('not available');
    expect(r.stderr).not.toContain('\u001b[');
  });
});
