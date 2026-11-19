import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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

/** `codex sandbox` stand-in: `refuse` makes the OS deny the outside write, otherwise the write goes through. */
const vendor = (modelCalled: string, sandbox: 'refuse' | 'allow') => `#!/bin/sh
if [ "$1" = "--version" ]; then echo vendor-1; exit 0; fi
if [ "$1" = "sandbox" ]; then
  while [ "$1" != "--" ]; do shift; done; shift
  if [ "$1" = "/usr/bin/true" ]; then exit 0; fi
  ${sandbox === 'refuse' ? `echo "touch: cannot touch '$2': Permission denied" >&2; exit 1` : `"$@"; exit $?`}
fi
touch '${modelCalled}'; exit 1
`;

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-setup-')));
  dirs.push(dir);
  const data = join(dir, 'data');
  mkdirSync(data, { mode: 0o700 });
  const config = join(dir, 'config.yaml');
  writeFileSync(
    config,
    `version: 1\nharnesses:\n  codex: { cmd: codex, auth: subscription, pool: p }\npools: { p: 1 }\nruntime:\n  data_dir: ${data}\n`,
  );
  const modelCalled = join(dir, 'model-called');
  const binary = (name: string, sandbox: 'refuse' | 'allow') => {
    const path = join(dir, name);
    writeFileSync(path, vendor(modelCalled, sandbox), { mode: 0o755 });
    return path;
  };
  const records = join(data, 'harnesses', 'codex');
  const run = (...args: string[]) => {
    const r = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../../src/cli/cusr-runner.ts', import.meta.url)),
        'setup-harness',
        '--json',
        '--config',
        config,
        '--harness',
        'codex',
        ...args,
      ],
      { encoding: 'utf8' },
    );
    return { code: r.status, body: JSON.parse(r.stdout) as Envelope };
  };
  const read = (file: string) => readFileSync(join(records, file), 'utf8');
  return { records, modelCalled, binary, run, read };
}

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

  it('refuses the removed proof step', () => {
    const h = setup();
    expect(h.run('--from', 'prove-harness')).toMatchObject({
      code: 2,
      body: { ok: false, error: { code: 'invalid_arguments' } },
    });
  });
});
