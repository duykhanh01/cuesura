import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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

type Sandbox = 'refuse' | 'allow' | 'allow-read-only' | 'read-only-writes-worktree';

/**
 * `codex sandbox` stand-in: `refuse` makes the OS deny every write, `allow` lets it through,
 * `allow-read-only` lets it through only in the read-only profile, and `read-only-writes-worktree` lets the
 * read-only profile write in its worktree, as workspace-write does. `before` runs ahead of each write.
 */
const vendor = (modelCalled: string, sandbox: Sandbox, version: string, before = '') => `#!/bin/sh
if [ "$1" = "--version" ]; then echo ${version}; exit 0; fi
if [ "$1" = "sandbox" ]; then
  profile="$3"
  wt="$5"
  while [ "$1" != "--" ]; do shift; done; shift
  if [ "$1" = "/usr/bin/true" ]; then exit 0; fi
  ${before}
  ${
    {
      refuse: '',
      allow: `"$@"; exit $?`,
      'allow-read-only': `if [ "$profile" = ":read-only" ]; then "$@"; exit $?; fi`,
      'read-only-writes-worktree': `case "$2" in "$wt"/*) "$@"; exit $?;; esac`,
    }[sandbox]
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
  const binary = (name: string, sandbox: Sandbox, version = 'vendor-1', before = '') => {
    const path = join(dir, name);
    writeFileSync(path, vendor(modelCalled, sandbox, version, before), { mode: 0o755 });
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
  const read = (file = 'record.json') => readFileSync(join(records, file), 'utf8');
  /** The pin and manifest as recorded, together. */
  const record = (harness = 'codex') =>
    JSON.parse(readFileSync(join(data, 'harnesses', harness, 'record.json'), 'utf8')) as {
      pin: { binary: Record<string, unknown>; permission_mode: string };
      manifest: Record<string, unknown> & { capabilities: Record<string, string> };
    };
  /** A stable command path, as a package manager installs one, pointing at `target`. */
  const command = join(dir, 'bin', 'codex');
  const point = (target: string) => {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    rmSync(command, { force: true });
    symlinkSync(target, command);
  };
  return {
    dir,
    data,
    records,
    modelCalled,
    binary,
    run,
    runner,
    check,
    read,
    record,
    command,
    point,
  };
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
    expect(existsSync(h.records)).toBe(false);

    expect(h.run('--vendor', 'codex', '--binary', bin)).toMatchObject({
      code: 0,
      body: { ok: true, data: { harness: 'codex', native_result: 'passed' } },
    });
    const manifest = h.record().manifest as {
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
    expect(h.record().pin.binary['path']).toBe(bin);
    expect(h.run('--from', 'record-manifest')).toMatchObject({ code: 0 });
    expect(existsSync(h.modelCalled)).toBe(false);
  });

  it('refuses a sandbox that lets the write through and keeps the working pair', () => {
    const h = setup();
    expect(h.run('--vendor', 'codex', '--binary', h.binary('codex', 'refuse'))).toMatchObject({
      code: 0,
    });
    const before = h.read();
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
    expect(h.read()).toBe(before);
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
    expect(h.record('claude').manifest).toMatchObject({
      selected_inner_mode: 'native',
      native_result: 'not_tried',
    });
    expect(existsSync(h.modelCalled)).toBe(false);
  });

  it('refuses to replace a pin without --force before writing anything', () => {
    const h = setup();
    const bin = h.binary('codex', 'refuse');
    expect(h.run('--vendor', 'codex', '--binary', bin)).toMatchObject({ code: 0 });
    const before = h.read();
    expect(h.run('--vendor', 'codex', '--binary', bin)).toMatchObject({
      code: 1,
      body: { ok: false, error: { code: 'pin_refused', details: { step: 'write-pin' } } },
    });
    expect(h.read()).toBe(before);
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
    expect(h.check()).toMatchObject(refusal('did not refuse a write it must refuse'));
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
    expect(existsSync(join(h.records, 'record.json'))).toBe(false);

    const ok = setup(['codex']);
    ok.point(ok.binary('codex-1', 'refuse'));
    expect(
      ok.run('--vendor', 'codex', '--binary', ok.command, '--permission-mode', 'full-access'),
    ).toMatchObject({ code: 0, body: { data: { native_result: 'not_tried' } } });
    ok.point(ok.binary('codex-2', 'allow-read-only', 'vendor-2'));
    expect(ok.check()).toMatchObject(refusal('read-only sandbox of'));
  });

  it('refuses a read-only sandbox that writes in its own worktree, even for a full-access pin', () => {
    const h = setup(['codex']);
    const bin = h.binary('codex', 'read-only-writes-worktree');
    expect(
      h.run('--vendor', 'codex', '--binary', bin, '--permission-mode', 'full-access'),
    ).toMatchObject(refusal('read-only sandbox of'));
    expect(existsSync(join(h.records, 'record.json'))).toBe(false);
    expect(existsSync(join(h.records, 'record.json'))).toBe(false);
  });

  it('refuses a check whose command was pointed at other bytes while it ran', () => {
    const h = setup(['codex']);
    const broken = join(h.dir, 'broken');
    writeFileSync(broken, '#!/bin/sh\nexit 43\n', { mode: 0o755 });
    // The probed CLI moves the command to an unprobed one on its last write, as an upgrade might.
    h.point(h.binary('codex-1', 'refuse', 'vendor-1', `ln -sfn '${broken}' '${h.command}'`));
    expect(h.run('--vendor', 'codex', '--binary', h.command)).toMatchObject(
      refusal('changed while it was checked'),
    );
    expect(existsSync(join(h.records, 'record.json'))).toBe(false);
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

  it('keeps the whole old record when the new one cannot be written, and names the step', () => {
    const h = setup(['codex']);
    expect(h.run('--vendor', 'codex', '--binary', h.binary('codex', 'refuse'))).toMatchObject({
      code: 0,
    });
    const before = h.read();
    chmodSync(h.records, 0o500);
    try {
      const full = ['--vendor', 'codex', '--binary', h.binary('codex', 'refuse'), '--force'];
      expect(h.run(...full, '--permission-mode', 'full-access')).toMatchObject({
        code: 1,
        body: {
          ok: false,
          error: {
            code: 'commit_failed',
            message: expect.stringContaining('the record on disk is unchanged') as string,
            details: { step: 'commit' },
          },
        },
      });
    } finally {
      chmodSync(h.records, 0o700);
    }
    expect(h.read()).toBe(before);
    expect(readdirSync(h.records)).toEqual(['record.json']);
    expect(h.check()).toMatchObject({ code: 0 });
  });

  it('asks a pin from before command paths to be set up once, and runs nothing in its place', () => {
    const h = setup(['codex']);
    const old = h.binary('codex-1', 'refuse');
    h.point(old);
    expect(h.run('--vendor', 'codex', '--binary', h.command)).toMatchObject({ code: 0 });
    // As an earlier release left it: two files, and a pin without the command path.
    const { pin, manifest } = h.record();
    delete pin.binary['path'];
    writeFileSync(join(h.records, 'pin.json'), JSON.stringify(pin), { mode: 0o600 });
    writeFileSync(join(h.records, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    rmSync(join(h.records, 'record.json'));
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
    expect(h.record().pin.binary['path']).toBe(h.command);
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
