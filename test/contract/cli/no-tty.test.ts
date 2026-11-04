import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { useTempDir } from '../../support/temp-db.ts';
import { join } from 'node:path';
import { CUSR_ENTRY, PtySession } from '../../support/pty.ts';

// FR-001, FR-002: only `cusr` with no arguments at a real terminal opens the interface. Everything else
// keeps the CLI contract, with no ANSI and no prompt.
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const VERSION = (JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as { version: string })
  .version;
const tempDir = useTempDir('cusr-no-tty-');

function piped(args: string[], env: Record<string, string | undefined> = {}) {
  const r = spawnSync(process.execPath, [CUSR_ENTRY, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: undefined,
      FORCE_COLOR: undefined,
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const session: { current: PtySession | null } = { current: null };
afterEach(() => {
  session.current?.dispose();
  session.current = null;
});

async function onPty(
  args: string[],
  opts: {
    env?: Record<string, string | undefined>;
    redirect?: string;
  } = {},
) {
  const s = new PtySession({ args, ...opts });
  session.current = s;
  const exit = await s.waitForExit(20_000);
  return { s, exit };
}

const NO_COMMAND = 'cusr: no command given\n';

describe('without a terminal', () => {
  it('no arguments: not_available with exit 2, as before', () => {
    expect(piped([])).toEqual({
      status: 2,
      stdout: '',
      stderr: NO_COMMAND,
    });
  });

  it('--json: one error envelope with exit 2', () => {
    const r = piped(['--json']);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toEqual({
      schema_version: 1,
      ok: false,
      data: null,
      error: {
        code: 'not_available',
        message: 'cusr: no command given',
        details: { program: 'cusr', argument: null },
        request_id: null,
      },
    });
    expect(r.stderr).toBe('');
  });

  it('--version and --help are plain text with exit 0', () => {
    expect(piped(['--version'])).toEqual({
      status: 0,
      stdout: `${VERSION}\n`,
      stderr: '',
    });
    const help = piped(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: cusr');
    expect(help.stdout).not.toContain('\x1b[');
  });

  it('a subcommand behaves as usual', () => {
    const r = piped(['status', '--json'], { CUSR_DATA_DIR: tempDir() });
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({
      error: { code: 'daemon_unreachable' },
    });
    expect(r.stdout + r.stderr).not.toContain('\x1b[');
  });
});

describe('at a terminal, but not asking for the interface', () => {
  const NOT_THE_INTERFACE = {
    alternateScreen: false,
    cursorHidden: false,
    bracketedPaste: false,
    mouseTracking: false,
  };

  it.each([
    ['TERM=dumb', { TERM: 'dumb' }],
    ['no TERM', { TERM: undefined }],
    ['an empty TERM', { TERM: '' }],
  ] as const)('%s keeps not_available with exit 2', async (_name, env) => {
    const { s, exit } = await onPty([], { env });
    expect(exit.status).toBe(2);
    expect(s.modes()).toEqual(NOT_THE_INTERFACE);
    expect(s.rawOutput()).toContain('no command given');
    expect(s.rawOutput()).not.toContain('\x1b[');
    expect(exit.sttyAfter).toBe(exit.sttyBefore);
  });

  it('--json prints one envelope, no ANSI', async () => {
    const { s, exit } = await onPty(['--json']);
    expect(exit.status).toBe(2);
    expect(s.rawOutput()).toContain('"code":"not_available"');
    expect(s.rawOutput()).not.toContain('\x1b[');
  });

  it.each([['--version'], ['--help']])('%s stays plain', async (flag) => {
    const { s, exit } = await onPty([flag]);
    expect(exit.status).toBe(0);
    expect(s.modes()).toEqual(NOT_THE_INTERFACE);
    expect(s.rawOutput()).not.toContain('\x1b[');
  });

  it('a subcommand stays a subcommand', async () => {
    const { s, exit } = await onPty(['status', '--json'], {
      env: { CUSR_DATA_DIR: tempDir() },
    });
    expect(exit.status).toBe(3);
    expect(s.modes()).toEqual(NOT_THE_INTERFACE);
  });

  it('stdout to a file keeps not_available', async () => {
    const out = join(tempDir(), 'out.txt');
    const { exit } = await onPty([], { redirect: `> '${out}'` });
    expect(exit.status).toBe(2);
    expect(readFileSync(out, 'utf8')).toBe('');
  });

  it('stdin from elsewhere keeps not_available', async () => {
    const { s, exit } = await onPty([], { redirect: '< /dev/null' });
    expect(exit.status).toBe(2);
    expect(s.modes()).toEqual(NOT_THE_INTERFACE);
  });
});
