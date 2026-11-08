import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Runs the source entrypoints as real processes (Node strips types) against contracts/cli-daemon.md.
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const VERSION = (JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as { version: string })
  .version;
const BINARIES = ['cusr', 'cusrd', 'cusr-runner'] as const;

function exec(
  bin: string,
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [`src/cli/${bin}.ts`, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    // Node warns on stderr when NO_COLOR and FORCE_COLOR are both set.
    env: { ...process.env, NO_COLOR: undefined, FORCE_COLOR: '1', ...env },
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
      const r = exec('cusr', ['status', '--json'], { CUSR_DATA_DIR: dir });
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

describe('first run without a daemon', () => {
  it('says how to start cusrd, with --data-dir given before the command', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-first-')));
    try {
      const r = exec('cusr', ['--data-dir', dir, 'status', '--json']);
      expect(r.status).toBe(3);
      const env = JSON.parse(r.stdout) as {
        error: { code: string; details: { data_dir: string; guidance: string } };
      };
      expect(env.error.code).toBe('daemon_unreachable');
      expect(env.error.details.data_dir).toBe(dir);
      expect(env.error.details.guidance).toContain(
        `cusrd --config <config.yaml> --data-dir ${dir}`,
      );
      expect(env.error.details.guidance).toContain(join(ROOT, 'deploy/config.example.yaml'));

      const plain = exec('cusr', ['task', 'list', '--data-dir', dir]);
      expect(plain.status).toBe(3);
      expect(plain.stderr).toContain('cusrd --config');

      const follow = exec('cusr', [
        '--data-dir',
        dir,
        'task',
        'logs',
        '019a0000-0000-7000-8000-000000000001',
        '--follow',
        '--after',
        '7',
      ]);
      expect(follow.status).toBe(3);
      expect(follow.stderr).toContain('resume with --after 7');
      expect(follow.stderr).toContain(`cusrd --config <config.yaml> --data-dir ${dir}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('called from a worker', () => {
  const TAG = { CUSR_OPERATION_ID: 'op-1' };

  it('refuses a command with exit 5 before reaching the daemon', () => {
    const r = exec('cusr', ['task', 'list', '--json'], TAG);
    expect(r.status).toBe(5);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: { code: 'worker_refused', details: { variable: 'CUSR_OPERATION_ID' } },
    });
  });

  it.each([['session-start'], ['hook']])('assistant %s exits 0 and prints nothing', (cmd) => {
    const r = spawnSync(process.execPath, ['src/cli/cusr.ts', 'assistant', cmd], {
      cwd: ROOT,
      encoding: 'utf8',
      input: '{"session_id":"s-1"}',
      env: { ...process.env, ...TAG, CUSR_DATA_DIR: join(tmpdir(), 'cusr-none') },
    });
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({
      status: 0,
      stdout: '',
      stderr: '',
    });
  });

  it.each(['cusrd', 'cusr-runner'])('leaves %s alone', (bin) => {
    expect(exec(bin, ['--version'], { ...TAG, CUSR_ATTEMPT_ID: 'a-1' }).status).toBe(0);
  });
});
