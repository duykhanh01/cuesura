import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Envelope } from '../../../src/cli/output.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Sandbox = 'refuse' | 'allow' | 'allow-read-only';

/**
 * `codex sandbox` stand-in: `refuse` makes the OS deny the outside write, `allow` lets it through, and
 * `allow-read-only` lets it through only in the read-only profile.
 */
const vendor = (modelCalled: string, sandbox: Sandbox, version: string) => `#!/bin/sh
if [ "$1" = "--version" ]; then echo ${version}; exit 0; fi
if [ "$1" = "sandbox" ]; then
  profile="$3"
  while [ "$1" != "--" ]; do shift; done; shift
  if [ "$1" = "/usr/bin/true" ]; then exit 0; fi
  ${
    sandbox === 'refuse'
      ? ''
      : sandbox === 'allow'
        ? `"$@"; exit $?`
        : `if [ "$profile" = ":read-only" ]; then "$@"; exit $?; fi`
  }
  echo "touch: cannot touch '$2': Permission denied" >&2; exit 1
fi
touch '${modelCalled}'; exit 1
`;

function setup(harnesses: readonly string[] = ['codex', 'claude']) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-setup-')));
  dirs.push(dir);
  const data = join(dir, 'data');
  mkdirSync(data, { mode: 0o700 });
  const config = join(dir, 'config.yaml');
  writeFileSync(
    config,
    `version: 1\nharnesses:\n${harnesses.map((h) => `  ${h}: { cmd: ${h}, auth: subscription, pool: p }\n`).join('')}pools: { p: 1 }\nruntime:\n  data_dir: ${data}\n`,
  );
  const modelCalled = join(dir, 'model-called');
  const binary = (name: string, sandbox: Sandbox, version = 'vendor-1') => {
    const path = join(dir, name);
    writeFileSync(path, vendor(modelCalled, sandbox, version), { mode: 0o755 });
    return path;
  };
  const records = join(data, 'harnesses', 'codex');
  const runner = (command: string, ...args: string[]) => {
    const r = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../../src/cli/cusr-runner.ts', import.meta.url)),
        command,
        '--json',
        '--config',
        config,
        ...args,
      ],
      { encoding: 'utf8' },
    );
    return { code: r.status, body: JSON.parse(r.stdout) as Envelope };
  };
  const run = (...args: string[]) => runner('setup-harness', '--harness', 'codex', ...args);
  const check = () => runner('check-records');
  const read = (file: string) => readFileSync(join(records, file), 'utf8');
  /** A stable command path, as a package manager installs one, pointing at `target`. */
  const command = join(dir, 'bin', 'codex');
  const point = (target: string) => {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    rmSync(command, { force: true });
    symlinkSync(target, command);
  };
  return { dir, data, records, modelCalled, binary, run, runner, check, read, command, point };
}

const refusal = (message: string) => ({
  code: 1,
  body: { ok: false, error: { message: expect.stringContaining(message) as string } },
});

describe('setup-harness CLI without model calls', () => {
  it('records the pin with every capability unknown and the sandbox it really ran', () => {
    const h = setup();
    const bin = h.binary('codex', 'refuse');
    expect(h.run('--vendor', 'codex', '--binary', bin, '--dry-run')).toMatchObject({
      code: 0,
      body: { ok: true, data: { native_result: 'passed', pin_exists: false } },
    });
    expect(existsSync(join(h.records, 'pin.json'))).toBe(false);

    expect(h.run('--vendor', 'codex', '--binary', bin)).toMatchObject({
      code: 0,
      body: { ok: true, data: { harness: 'codex', native_result: 'passed' } },
    });
    const manifest = JSON.parse(h.read('manifest.json')) as {
      fixture_refs: string[];
      role_schemas: Record<string, string>;
      capabilities: Record<string, string>;
    };
    expect(manifest.fixture_refs).toEqual(['declared']);
    expect(Object.keys(manifest.role_schemas).sort()).toEqual([
      'coder',
      'decider',
      'deputy',
      'fixer',
      'reviewer',
    ]);
    // Nothing a model would have had to show is claimed.
    expect(manifest.capabilities).toEqual({
      structured_output: 'unknown',
      permission_enforced: 'unknown',
      private_home_auth: 'unknown',
      cost_reporting: 'unknown',
      resume: 'unknown',
    });
    expect((JSON.parse(h.read('pin.json')) as { binary: { path: string } }).binary.path).toBe(bin);
    expect(h.run('--from', 'record-manifest')).toMatchObject({ code: 0 });
    expect(existsSync(h.modelCalled)).toBe(false);
  });

  it('refuses a sandbox that lets the write through and keeps the working pair', () => {
    const h = setup();
    expect(h.run('--vendor', 'codex', '--binary', h.binary('codex', 'refuse'))).toMatchObject({
      code: 0,
    });
    const pin = h.read('pin.json');
    const manifest = h.read('manifest.json');
    expect(
      h.run('--vendor', 'codex', '--binary', h.binary('leaky', 'allow'), '--force'),
    ).toMatchObject({
      code: 1,
      body: {
        ok: false,
        error: {
          code: 'manifest_refused',
          message: expect.stringContaining('native sandbox failed') as string,
          details: { step: 'record-manifest' },
        },
      },
    });
    expect(h.read('pin.json')).toBe(pin);
    expect(h.read('manifest.json')).toBe(manifest);
    expect(existsSync(h.modelCalled)).toBe(false);
  });

  it('records a Claude sandbox as not tried, never passed, and leaves it to fail closed at launch', () => {
    const h = setup();
    const settings = join(h.dir, 'claude-settings.json');
    writeFileSync(settings, JSON.stringify({ permissions: { defaultMode: 'auto' } }));
    const tools = join(h.dir, 'tools');
    mkdirSync(tools);
    for (const tool of ['bwrap', 'socat'])
      writeFileSync(join(tools, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const claude = (...extra: string[]) =>
      h.run(
        '--harness',
        'claude',
        '--vendor',
        'claude',
        '--binary',
        h.binary('claude', 'refuse'),
        '--settings',
        settings,
        '--toolchain',
        tools,
        ...extra,
      );
    expect(claude('--sandbox', 'on')).toMatchObject({
      code: 0,
      body: { ok: true, data: { harness: 'claude', native_result: 'not_tried' } },
    });
    const manifest = JSON.parse(
      readFileSync(join(h.data, 'harnesses', 'claude', 'manifest.json'), 'utf8'),
    ) as { selected_inner_mode: string; native_result: string };
    expect(manifest).toMatchObject({ selected_inner_mode: 'native', native_result: 'not_tried' });
    expect(existsSync(h.modelCalled)).toBe(false);
  });

  it('refuses to replace a pin without --force before writing anything', () => {
    const h = setup();
    const bin = h.binary('codex', 'refuse');
    expect(h.run('--vendor', 'codex', '--binary', bin)).toMatchObject({ code: 0 });
    const manifest = h.read('manifest.json');
    expect(h.run('--vendor', 'codex', '--binary', bin)).toMatchObject({
      code: 1,
      body: { ok: false, error: { code: 'pin_refused', details: { step: 'write-pin' } } },
    });
    expect(h.read('manifest.json')).toBe(manifest);
  });

  it('returns the error of a binary that is not installed', () => {
    const h = setup();
    expect(h.run('--vendor', 'codex', '--binary', '/nonexistent/codex')).toMatchObject({
      code: 1,
      body: {
        ok: false,
        error: {
          code: 'pin_refused',
          message: expect.stringContaining('cannot run /nonexistent/codex --version') as string,
          details: { step: 'write-pin' },
        },
      },
    });
    expect(existsSync(h.records)).toBe(false);
  });

  it('runs an upgraded CLI without a new setup after checking its sandbox, and refuses one that leaks', () => {
    const h = setup(['codex']);
    h.point(h.binary('codex-1', 'refuse'));
    expect(h.run('--vendor', 'codex', '--binary', h.command)).toMatchObject({ code: 0 });
    expect(h.check()).toMatchObject({ code: 0 });

    h.point(h.binary('codex-2', 'refuse', 'vendor-2'));
    expect(h.check()).toMatchObject({ code: 0 });

    h.point(h.binary('codex-3', 'allow', 'vendor-3'));
    expect(h.check()).toMatchObject(refusal('workspace sandbox of'));
    expect(h.check()).toMatchObject(refusal('did not refuse a write outside the worktree'));
    expect(existsSync(h.modelCalled)).toBe(false);
  });

  it('checks the read-only sandbox of a full-access pin too', () => {
    const h = setup(['codex']);
    const bin = h.binary('codex', 'allow-read-only');
    expect(
      h.run('--vendor', 'codex', '--binary', bin, '--permission-mode', 'full-access'),
    ).toMatchObject({
      code: 1,
      body: {
        ok: false,
        error: {
          message: expect.stringContaining('read-only sandbox') as string,
          details: { step: 'record-manifest' },
        },
      },
    });
    expect(existsSync(join(h.records, 'pin.json'))).toBe(false);

    const ok = setup(['codex']);
    ok.point(ok.binary('codex-1', 'refuse'));
    expect(
      ok.run('--vendor', 'codex', '--binary', ok.command, '--permission-mode', 'full-access'),
    ).toMatchObject({ code: 0, body: { data: { native_result: 'not_tried' } } });
    ok.point(ok.binary('codex-2', 'allow-read-only', 'vendor-2'));
    expect(ok.check()).toMatchObject(refusal('read-only sandbox of'));
  });

  it('does not take evidence of the old bytes for an upgraded binary', () => {
    const h = setup(['codex']);
    const old = h.binary('codex-1', 'refuse');
    h.point(old);
    expect(h.run('--vendor', 'codex', '--binary', h.command)).toMatchObject({ code: 0 });
    const evidence = join(h.dir, 'evidence.json');
    const sha = createHash('sha256').update(readFileSync(old)).digest('hex');
    writeFileSync(evidence, JSON.stringify({ vendors: { codex: { binary: { sha256: sha } } } }));
    h.point(h.binary('codex-2', 'refuse', 'vendor-2'));
    expect(h.runner('record-manifest', '--harness', 'codex', '--evidence', evidence)).toMatchObject(
      refusal(`proves another binary (sha256 ${sha})`),
    );
  });

  it('keeps pin and manifest a pair when writing them fails half way, and names the step', () => {
    const h = setup(['codex']);
    expect(h.run('--vendor', 'codex', '--binary', h.binary('codex', 'refuse'))).toMatchObject({
      code: 0,
    });
    // The manifest cannot be replaced; the pin can.
    rmSync(join(h.records, 'manifest.json'));
    mkdirSync(join(h.records, 'manifest.json', 'blocked'), { recursive: true });
    const full = ['--vendor', 'codex', '--binary', h.binary('codex', 'refuse'), '--force'];
    expect(h.run(...full, '--permission-mode', 'full-access')).toMatchObject({
      code: 1,
      body: { ok: false, error: { code: 'commit_failed', details: { step: 'commit' } } },
    });
    // Readers take the new pair from the commit record, never the new pin with an old manifest.
    expect(h.check()).toMatchObject({ code: 0 });
    rmSync(join(h.records, 'manifest.json'), { recursive: true });
    expect(h.runner('record-manifest', '--harness', 'codex')).toMatchObject({ code: 0 });
    expect(existsSync(join(h.records, 'record.next.json'))).toBe(false);
    expect(JSON.parse(h.read('pin.json'))).toMatchObject({ permission_mode: 'full-access' });
    expect(JSON.parse(h.read('manifest.json'))).toMatchObject({
      selected_inner_mode: 'full_access',
    });
    expect(h.check()).toMatchObject({ code: 0 });
  });

  it('asks a pin from before command paths to be set up once, and runs nothing in its place', () => {
    const h = setup(['codex']);
    const old = h.binary('codex-1', 'refuse');
    h.point(old);
    expect(h.run('--vendor', 'codex', '--binary', h.command)).toMatchObject({ code: 0 });
    const pin = JSON.parse(h.read('pin.json')) as { binary: Record<string, unknown> };
    delete pin.binary['path'];
    writeFileSync(join(h.records, 'pin.json'), JSON.stringify(pin), { mode: 0o600 });
    expect(h.check()).toMatchObject({ code: 0 });

    h.point(h.binary('codex-2', 'refuse', 'vendor-2'));
    rmSync(old);
    expect(h.check()).toMatchObject(
      refusal(
        'predates command paths, so set it up once more with cusr-runner setup-harness --force',
      ),
    );
    expect(h.run('--vendor', 'codex', '--binary', h.command, '--force')).toMatchObject({
      code: 0,
    });
    expect(h.check()).toMatchObject({ code: 0 });
  });

  it('says a command that resolves to a directory is not a file', () => {
    const h = setup(['codex']);
    h.point(h.binary('codex-1', 'refuse'));
    expect(h.run('--vendor', 'codex', '--binary', h.command)).toMatchObject({ code: 0 });
    mkdirSync(join(h.dir, 'not-a-cli'));
    h.point(join(h.dir, 'not-a-cli'));
    expect(h.check()).toMatchObject(refusal(`binary ${h.command} is not a file`));
  });

  it('refuses the removed proof step', () => {
    const h = setup();
    expect(h.run('--from', 'prove-harness')).toMatchObject({
      code: 2,
      body: { ok: false, error: { code: 'invalid_arguments' } },
    });
  });
});
