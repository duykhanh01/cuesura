import { describe, expect, it } from 'vitest';
import {
  packageVersion,
  runCli,
  type CliSpec,
} from '../../../src/cli/program.ts';

const spec: CliSpec = {
  name: 'cusr',
  description: 'test binary',
  version: '1.2.3',
};

async function run(
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(spec, argv, {
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
  });
  return { code, stdout, stderr };
}

describe('runCli', () => {
  it('prints the version and exits 0', async () => {
    expect(await run(['--version'])).toEqual({
      code: 0,
      stdout: '1.2.3\n',
      stderr: '',
    });
    expect((await run(['-V'])).stdout).toBe('1.2.3\n');
  });

  it('wraps the version in an ok envelope with --json', async () => {
    const r = await run(['--version', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      schema_version: 1,
      ok: true,
      data: { version: '1.2.3' },
      error: null,
    });
  });

  it('prints help without listing any command', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage: cusr [options]');
    expect(r.stdout).not.toMatch(/^Commands:/m);
    expect(r.stdout).toContain('No commands are available in this build.');
    expect(r.stderr).toBe('');
  });

  it.each([[['task', 'add']], [['status']], [[]], [['--bogus']]])(
    'rejects %j with exit 2 and a stderr diagnostic',
    async (argv) => {
      const r = await run(argv);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^cusr: .* available in this build\n$/);
    },
  );

  it('emits exactly one not_available envelope with --json', async () => {
    const r = await run(['task', 'add', '--file', 'x.json', '--json']);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('');
    expect(r.stdout.endsWith('\n')).toBe(true);
    expect(r.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(r.stdout)).toEqual({
      schema_version: 1,
      ok: false,
      data: null,
      error: {
        code: 'not_available',
        message: 'cusr: command "task" is not available in this build',
        details: { program: 'cusr', argument: 'task' },
        request_id: null,
      },
    });
  });

  it('never writes ANSI escapes', async () => {
    for (const argv of [['--help'], ['task'], ['task', '--json']]) {
      const r = await run(argv);
      expect(r.stdout + r.stderr).not.toContain('\u001b[');
    }
  });
});

describe('packageVersion', () => {
  it('reads the version from package.json', async () => {
    const { default: pkg } = await import('../../../package.json', {
      with: { type: 'json' },
    });
    expect(packageVersion()).toBe(pkg.version);
  });
});
