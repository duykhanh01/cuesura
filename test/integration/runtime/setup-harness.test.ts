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
  const binary = join(dir, 'vendor');
  const modelCalled = join(dir, 'model-called');
  writeFileSync(
    binary,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo vendor-1; else touch '${modelCalled}'; exit 1; fi\n`,
    { mode: 0o755 },
  );
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
  return { records, modelCalled, binary, run };
}

describe('setup-harness CLI without model calls', () => {
  it('records pin and manifest from the pin and never runs the model', () => {
    const h = setup();
    expect(h.run('--vendor', 'codex', '--binary', h.binary, '--dry-run')).toMatchObject({
      code: 0,
      body: { ok: true, data: { version: 'vendor-1', pin_exists: false } },
    });
    expect(existsSync(h.records)).toBe(false);

    const first = h.run('--vendor', 'codex', '--binary', h.binary);
    expect(first).toMatchObject({ code: 0, body: { ok: true, data: { harness: 'codex' } } });
    const manifest = JSON.parse(readFileSync(join(h.records, 'manifest.json'), 'utf8')) as {
      fixture_refs: string[];
      role_schemas: Record<string, string>;
    };
    expect(manifest.fixture_refs).toEqual(['declared']);
    expect(Object.keys(manifest.role_schemas).sort()).toEqual([
      'coder',
      'decider',
      'deputy',
      'fixer',
      'reviewer',
    ]);
    expect(h.run('--from', 'record-manifest')).toMatchObject({ code: 0 });
    expect(existsSync(h.modelCalled)).toBe(false);
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
