import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { PROOF_LEDGER } from '../../../src/runner/harness-proof.ts';

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
  const out = join(dir, 'evidence.json');
  const pinArgs = ['--vendor', 'codex', '--binary', binary];
  const proofArgs = ['--model', 'proof-model', '--out', out];
  const invoke = (command: string, args: string[]) => {
    const r = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../../src/cli/cusr-runner.ts', import.meta.url)),
        command,
        '--json',
        '--config',
        config,
        '--harness',
        'codex',
        ...args,
      ],
      { encoding: 'utf8' },
    );
    return {
      code: r.status,
      stderr: r.stderr,
      body: JSON.parse(r.stdout) as Envelope,
    };
  };
  const run = (...extra: string[]) => invoke('setup-harness', [...pinArgs, ...proofArgs, ...extra]);
  const seed = () => {
    expect(invoke('write-pin', pinArgs).code).toBe(0);
    writeFileSync(join(records, 'manifest.json'), 'previous manifest', {
      mode: 0o600,
    });
    const pin = readFileSync(join(records, 'pin.json'), 'utf8');
    const parsed = JSON.parse(pin) as { binary: { sha256: string } };
    const rows = `${JSON.stringify({ binary_sha256: parsed.binary.sha256 })}\n`.repeat(2);
    writeFileSync(join(records, PROOF_LEDGER), rows, { mode: 0o600 });
    return { pin, rows };
  };
  return { dir, records, out, modelCalled, run, invoke, pinArgs, seed };
}

describe('setup-harness CLI without model calls', () => {
  it('previews a first setup without creating pin, evidence, manifest, or ledger', () => {
    const h = setup();
    expect(h.run('--dry-run')).toMatchObject({
      code: 0,
      stderr: '',
      body: {
        ok: true,
        data: {
          invocations_spent: 0,
          invocations_needed: 4,
          pin_exists: false,
        },
      },
    });
    expect(existsSync(h.records)).toBe(false);
    expect(existsSync(h.out)).toBe(false);
    expect(existsSync(h.modelCalled)).toBe(false);
    expect(h.run('--dry-run', '--prove-resume')).toMatchObject({
      code: 0,
      body: { ok: true, data: { invocations_needed: 5, pin_exists: false } },
    });
    expect(existsSync(h.records)).toBe(false);
  });

  it('leaves no pin behind when the initial budget cannot cover the proof', () => {
    const h = setup();
    expect(h.run('--approval', 'owner, test', '--max-invocations', '1')).toMatchObject({
      code: 1,
      body: { error: { details: { step: 'prove-harness' } } },
    });
    expect(existsSync(h.records)).toBe(false);
    expect(existsSync(h.modelCalled)).toBe(false);
  });

  it('previews without --force and retains existing pin, manifest, and ledger on every preflight refusal', () => {
    const h = setup();
    const { pin, rows } = h.seed();
    expect(h.run('--dry-run')).toMatchObject({
      code: 0,
      body: {
        data: { invocations_spent: 2, invocations_needed: 4, pin_exists: true },
      },
    });
    expect(h.run('--approval', 'owner, test', '--max-invocations', '6')).toMatchObject({
      code: 1,
      body: { error: { code: 'pin_refused', details: { step: 'write-pin' } } },
    });
    for (const extra of [
      ['--max-invocations', '4'],
      // 6 covers the four roles after the 2 spent, but not the resume probe.
      ['--max-invocations', '6', '--prove-resume'],
    ]) {
      expect(h.run('--force', '--approval', 'owner, test', ...extra)).toMatchObject({
        code: 1,
        body: {
          error: { code: 'proof_refused', details: { step: 'prove-harness' } },
        },
      });
    }
    expect(
      h.invoke('setup-harness', [
        ...h.pinArgs,
        '--out',
        h.out,
        '--force',
        '--approval',
        'owner, test',
        '--max-invocations',
        '9',
      ]),
    ).toMatchObject({
      code: 2,
      body: {
        error: {
          code: 'invalid_arguments',
          details: { step: 'prove-harness' },
        },
      },
    });
    expect(readFileSync(join(h.records, 'pin.json'), 'utf8')).toBe(pin);
    expect(readFileSync(join(h.records, 'manifest.json'), 'utf8')).toBe('previous manifest');
    expect(readFileSync(join(h.records, PROOF_LEDGER), 'utf8')).toBe(rows);
    expect(existsSync(h.out)).toBe(false);
    expect(existsSync(h.modelCalled)).toBe(false);
  });

  it('does not overwrite an existing pin with a different candidate when preflight rejects its deny rule', () => {
    const h = setup();
    const { pin, rows } = h.seed();
    const settings = join(h.dir, 'settings.json');
    writeFileSync(settings, JSON.stringify({ permissions: { defaultMode: 'auto' } }));
    const tools = join(h.dir, 'tools');
    mkdirSync(tools);
    for (const tool of ['socat', 'bwrap'])
      writeFileSync(join(tools, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(
      h.run(
        '--force',
        '--vendor',
        'claude',
        '--settings',
        settings,
        '--tools',
        'Bash',
        '--toolchain',
        tools,
        '--approval',
        'owner, test',
        '--max-invocations',
        '9',
      ),
    ).toMatchObject({
      code: 1,
      body: {
        error: {
          code: 'proof_refused',
          message: expect.stringContaining('does not deny') as string,
          details: { step: 'prove-harness' },
        },
      },
    });
    expect(readFileSync(join(h.records, 'pin.json'), 'utf8')).toBe(pin);
    expect(readFileSync(join(h.records, 'manifest.json'), 'utf8')).toBe('previous manifest');
    expect(readFileSync(join(h.records, PROOF_LEDGER), 'utf8')).toBe(rows);
    expect(existsSync(h.modelCalled)).toBe(false);
  });

  it('uses the trusted existing pin when retrying the proof, with no overwrite permission required', () => {
    const h = setup();
    const { pin, rows } = h.seed();
    expect(
      h.invoke('setup-harness', [
        '--from',
        'prove-harness',
        '--model',
        'proof-model',
        '--out',
        h.out,
        '--approval',
        'owner, test',
        '--max-invocations',
        '4',
      ]),
    ).toMatchObject({
      code: 1,
      body: {
        error: {
          code: 'proof_refused',
          message: expect.stringContaining('2 invocations already spent') as string,
        },
      },
    });
    expect(
      h.invoke('setup-harness', ['--from', 'prove-harness', '--model', 'proof-model', '--dry-run']),
    ).toMatchObject({
      code: 0,
      body: {
        data: { invocations_spent: 2, invocations_needed: 4, pin_exists: true },
      },
    });
    expect(readFileSync(join(h.records, 'pin.json'), 'utf8')).toBe(pin);
    expect(readFileSync(join(h.records, PROOF_LEDGER), 'utf8')).toBe(rows);
    expect(existsSync(h.modelCalled)).toBe(false);
  });

  it('validates existing pin permissions on retries before any model invocation', () => {
    const h = setup();
    const { pin, rows } = h.seed();
    const path = join(h.records, 'pin.json');
    rmSync(path);
    writeFileSync(path, pin, { mode: 0o600 });
    chmodSync(path, 0o666);
    expect(
      h.invoke('setup-harness', ['--from', 'prove-harness', '--model', 'proof-model', '--dry-run']),
    ).toMatchObject({
      code: 1,
      body: {
        error: {
          code: 'proof_refused',
          message: expect.stringContaining('writable by group or others') as string,
        },
      },
    });
    expect(readFileSync(join(h.records, PROOF_LEDGER), 'utf8')).toBe(rows);
    expect(existsSync(h.modelCalled)).toBe(false);
  });
});
