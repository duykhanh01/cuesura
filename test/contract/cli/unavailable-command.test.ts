import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Runs the source entrypoints as real processes (Node strips types) against contracts/cli-daemon.md.
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const VERSION = (
  JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as { version: string }
).version;
const BINARIES = ['cusr', 'cusrd', 'cusr-runner'] as const;

function exec(
  bin: string,
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [`src/cli/${bin}.ts`, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '1', ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe.each(BINARIES)('%s binary', (bin) => {
  it('--version prints the package version and exits 0', () => {
    expect(exec(bin, ['--version'])).toEqual({
      status: 0,
      stdout: `${VERSION}\n`,
      stderr: '',
    });
  });

  it('--json on an unimplemented command prints one error envelope and exits 2', () => {
    const r = exec(bin, ['no-such-command', '--json']);
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
    const r = exec(bin, ['no-such-command']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('not available');
    expect(r.stderr).not.toContain('\u001b[');
  });
});

describe('cusr status', () => {
  it('reports an unreachable daemon as exit 3 with one envelope, without opening the database', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-status-')));
    try {
      const token = join(dir, 'client.token');
      writeFileSync(token, `${randomBytes(32).toString('base64url')}\n`, {
        mode: 0o600,
      });
      const r = exec('cusr', ['status', '--json'], {
        CUSR_DATA_DIR: dir,
        CUSR_TOKEN_FILE: token,
      });
      expect(r.status).toBe(3);
      expect(JSON.parse(r.stdout)).toMatchObject({
        schema_version: 1,
        ok: false,
        error: { code: 'daemon_unreachable' },
      });
      expect(existsSync(join(dir, 'cusr.db'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
