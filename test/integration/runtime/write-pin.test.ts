import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nativeSandboxEnabled } from '../../../src/adapters/harness/vendor.ts';
import type { RuntimeConfig } from '../../../src/config/normalize.ts';
import { notRunnable, writePin, type WritePinInput } from '../../../src/runner/harness-records.ts';

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-write-pin-')));
  const binary = join(dir, 'vendor');
  writeFileSync(binary, '#!/bin/sh\necho "9.9.9 (Vendor)"\n');
  chmodSync(binary, 0o755);
  const tools = join(dir, 'tools');
  mkdirSync(tools);
  const auth = join(dir, 'auth.json');
  writeFileSync(auth, '{}');
  const rule = join(dir, 'spike.rules');
  writeFileSync(rule, 'rule\n');
  const input: WritePinInput = {
    dataDir: join(dir, 'data'),
    harness: 'codex',
    vendor: 'codex',
    binary,
    runtime: {
      credential_refs: [
        { name: 'auth', file: auth },
        { name: 'rule', file: rule },
      ],
    } as unknown as RuntimeConfig,
    toolchain: [tools],
    auth: [{ credential: 'auth', to: '.codex/auth.json' }],
    rules: [{ credential: 'rule', to: '.codex/rules/spike.rules' }],
    settings: null,
    max_turns: null,
    tools: null,
    force: false,
  };
  const path = join(input.dataDir, 'harnesses', 'codex', 'pin.json');
  return { dir, binary, tools, rule, input, path };
}

describe('cusr-runner write-pin', () => {
  it('writes what is on this host, private to the owner, with no environment carried over', () => {
    const { binary, tools, rule, input, path } = setup();
    const r = writePin(input);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const pin = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(pin).toMatchObject({
      vendor: 'codex',
      binary: {
        realpath: binary,
        version: '9.9.9 (Vendor)',
        sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
      },
      toolchain: [tools],
      env: {},
      home_files: [
        { credential: 'auth', to: '.codex/auth.json' },
        {
          credential: 'rule',
          to: '.codex/rules/spike.rules',
          sha256: createHash('sha256').update(readFileSync(rule)).digest('hex'),
        },
      ],
    });
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it('replaces a pin only with --force', () => {
    const { input } = setup();
    expect(writePin(input).ok).toBe(true);
    expect(writePin(input)).toMatchObject({
      ok: false,
      error: expect.stringContaining('--force') as string,
    });
    expect(writePin({ ...input, force: true }).ok).toBe(true);
  });

  it('refuses a path that does not hold on this host', () => {
    const { dir, tools, input, path } = setup();
    const link = join(dir, 'tools-link');
    symlinkSync(tools, link);
    for (const [change, message] of [
      [{ toolchain: ['/tmp/no-such-old-machine/lib'] }, 'does not exist on this host'],
      [{ toolchain: [link] }, `use ${tools}`],
      [{ binary: join(dir, 'missing') }, 'cannot run'],
      [{ auth: [{ credential: 'nope', to: '.a' }] }, 'credential_refs'],
    ] as const) {
      expect(writePin({ ...input, ...change })).toMatchObject({
        ok: false,
        error: expect.stringContaining(message) as string,
      });
    }
    expect(() => statSync(path)).toThrow();
  });

  it('counts only a runnable file, whatever this host has installed', () => {
    const { tools } = setup();
    writeFileSync(join(tools, 'no-exec'), '');
    writeFileSync(join(tools, 'good'), '', { mode: 0o755 });
    mkdirSync(join(tools, 'a-directory'));
    expect(notRunnable([tools], ['good', 'no-exec', 'a-directory', 'absent'])).toEqual([
      'no-exec',
      'a-directory',
      'absent',
    ]);
  });

  it('refuses a claude pin without its fields, and writes one with them', () => {
    const { input } = setup();
    const settings = {
      permissions: { defaultMode: 'dontAsk' },
      sandbox: { allowUnsandboxedCommands: false },
    };
    const claude = { ...input, harness: 'claude', vendor: 'claude' as const };
    // Claude runs with its default tool set, so a pin needs no tool list, but it needs settings.
    expect(writePin({ ...claude, settings: null, max_turns: null, tools: null })).toMatchObject({
      ok: false,
      error: expect.stringContaining('settings') as string,
    });
    const fake = (name: string) => {
      const d = join(input.dataDir, '..', name);
      mkdirSync(d, { recursive: true });
      return d;
    };
    const withTools = fake('with-tools');
    writeFileSync(join(withTools, 'socat'), '', { mode: 0o755 });
    writeFileSync(join(withTools, 'bwrap'), '', { mode: 0o755 });
    const complete = { ...claude, settings, max_turns: null, tools: ['Bash'] };
    const r = writePin({ ...complete, toolchain: [withTools] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(nativeSandboxEnabled(r.value)).toBe(false);
    expect(r.value.permission_mode).toBe('auto');
    for (const sandbox of [true, false]) {
      const changed = writePin({
        ...complete,
        toolchain: [withTools],
        sandbox,
        force: true,
      });
      if (!changed.ok) throw new Error(changed.error);
      expect(nativeSandboxEnabled(changed.value)).toBe(sandbox);
      expect(changed.value.permission_mode).toBe('auto');
      expect(changed.value.settings).toMatchObject({
        sandbox: { enabled: sandbox },
      });
    }
  });

  it('--json prints one envelope on success and on refusal, and nothing else', () => {
    const { dir, binary, input } = setup();
    const refs = input.runtime.credential_refs;
    const config = join(dir, 'config.yaml');
    writeFileSync(
      config,
      [
        'version: 1',
        'harnesses:',
        '  codex: { cmd: codex, auth: subscription, pool: p }',
        'pools: { p: 1 }',
        'runtime:',
        `  data_dir: ${input.dataDir}`,
        '  credential_refs:',
        ...refs.map((r) => `    ${r.name}: ${r.file}`),
        '',
      ].join('\n'),
    );
    mkdirSync(input.dataDir, { mode: 0o700 });
    const run = (...extra: string[]) => {
      const r = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../../../src/cli/cusr-runner.ts', import.meta.url)),
          'write-pin',
          '--config',
          config,
          '--harness',
          'codex',
          '--vendor',
          'codex',
          '--binary',
          binary,
          '--auth',
          'auth:.codex/auth.json',
          '--json',
          ...extra,
        ],
        { encoding: 'utf8' },
      );
      return {
        code: r.status,
        stderr: r.stderr,
        body: JSON.parse(r.stdout) as unknown,
      };
    };
    expect(run()).toMatchObject({
      code: 0,
      stderr: '',
      body: { ok: true, data: { harness: 'codex', version: '9.9.9 (Vendor)' } },
    });
    expect(run()).toMatchObject({
      code: 1,
      stderr: '',
      body: { ok: false, error: { code: 'pin_refused' } },
    });
    expect(run('--sandbox', 'on')).toMatchObject({
      code: 2,
      body: { ok: false, error: { code: 'invalid_arguments' } },
    });
    expect(run('--sandbox', 'invalid')).toMatchObject({
      code: 2,
      body: { ok: false, error: { code: 'invalid_arguments' } },
    });
    expect(run('--max-turns', '3')).toMatchObject({
      code: 2,
      body: { ok: false, error: { code: 'invalid_arguments' } },
    });
  });

  it.each([
    ['record-manifest', 'manifest_refused', ['--harness', 'h', '--evidence', 'nope.json']],
    [
      'prove-harness',
      'proof_refused',
      ['--harness', 'h', '--model', 'm', '--outer-proof', 'nope.json', '--dry-run'],
    ],
  ])('%s --json refuses with one envelope, spending nothing', (command, code, args) => {
    const { dir, input } = setup();
    const config = join(dir, 'config.yaml');
    writeFileSync(
      config,
      `version: 1\nharnesses:\n  h: { cmd: h, auth: subscription, pool: p }\npools: { p: 1 }\nruntime:\n  data_dir: ${input.dataDir}\n`,
    );
    mkdirSync(input.dataDir, { mode: 0o700 });
    const run = (...rest: string[]) => {
      const r = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../../../src/cli/cusr-runner.ts', import.meta.url)),
          command,
          '--json',
          ...rest,
        ],
        { encoding: 'utf8' },
      );
      return {
        code: r.status,
        stderr: r.stderr,
        body: JSON.parse(r.stdout) as unknown,
      };
    };
    expect(run()).toMatchObject({
      code: 2,
      stderr: '',
      body: { ok: false, error: { code: 'invalid_arguments' } },
    });
    expect(run('--config', config, ...args)).toMatchObject({
      code: 1,
      stderr: '',
      body: { ok: false, error: { code } },
    });
  });
});
