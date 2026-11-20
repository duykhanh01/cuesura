/**
 * T1-R06: pin and manifest are one record a reader sees whole, whatever a writer does meanwhile; writers
 * publish one at a time. Interleavings are forced with a hook on the file calls the real record functions make;
 * concurrent CLI commands are in setup-harness.test.ts.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commitRecord,
  harnessRecordProblems,
  loadHarnessRecord,
  type HarnessRecord,
} from '../../../src/runner/harness-records.ts';
import { loadDaemonConfig } from '../../../src/daemon/main.ts';

const hook = vi.hoisted(() => ({
  afterRead: null as null | ((path: string) => void),
  beforeRename: null as null | ((to: string) => void),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const out = actual.readFileSync(...args);
      const f = hook.afterRead;
      if (f !== null && typeof args[0] === 'string') {
        hook.afterRead = null;
        f(args[0]);
      }
      return out;
    }) as typeof actual.readFileSync,
    renameSync: ((from: fs.PathLike, to: fs.PathLike) => {
      const f = hook.beforeRename;
      if (f !== null) {
        hook.beforeRename = null;
        f(String(to));
      }
      actual.renameSync(from, to);
    }) as typeof actual.renameSync,
  };
});

const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cusr-record-snapshot-')));
const data = join(dir, 'data');
const config = join(dir, 'config.yaml');
const records = join(data, 'harnesses', 'codex');
let A: HarnessRecord;
let B: HarnessRecord;

/** A record made by the real setup command, as `auto` (A) or `full-access` (B). */
function made(mode: 'auto' | 'full-access'): HarnessRecord {
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
      '--vendor',
      'codex',
      '--binary',
      join(dir, 'codex'),
      '--permission-mode',
      mode,
      '--force',
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(r.stdout + r.stderr);
  return JSON.parse(fs.readFileSync(join(records, 'record.json'), 'utf8')) as HarnessRecord;
}

beforeAll(() => {
  fs.mkdirSync(data, { mode: 0o700 });
  fs.writeFileSync(
    config,
    `version: 1\nharnesses:\n  codex: { cmd: codex, auth: subscription, pool: p }\npools: { p: 1 }\nruntime:\n  data_dir: ${data}\n`,
  );
  fs.writeFileSync(
    join(dir, 'codex'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo vendor-1; exit 0; fi
while [ "$1" != "--" ]; do shift; done; shift
if [ "$1" = "/usr/bin/true" ]; then exit 0; fi
echo "touch: cannot touch '$2': Permission denied" >&2; exit 1
`,
    { mode: 0o755 },
  );
  A = made('auto');
  B = made('full-access');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  hook.afterRead = null;
  hook.beforeRename = null;
  fs.rmSync(records, { recursive: true, force: true });
  fs.mkdirSync(records, { recursive: true, mode: 0o700 });
});

const write = (name: string, value: unknown) =>
  fs.writeFileSync(join(records, name), JSON.stringify(value), { mode: 0o600 });
const target = { dataDir: data, harness: 'codex', force: true };
const load = () => {
  const r = loadHarnessRecord(data, 'codex');
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const modes = (r: HarnessRecord) => [r.pin.permission_mode, r.manifest.selected_inner_mode];

describe('one generation for readers and writers', () => {
  it('a reader between the pin and manifest of the old files gets the new record whole', () => {
    write('pin.json', A.pin);
    write('manifest.json', A.manifest);
    // The reader has the old pin when a writer puts the new record down.
    hook.afterRead = (path) => {
      expect(path).toBe(join(records, 'pin.json'));
      expect(commitRecord(target, B).ok).toBe(true);
    };
    expect(modes(load())).toEqual(['full-access', 'full_access']);
  });

  it('a reader of the record file gets the generation it read, whole', () => {
    write('record.json', A);
    hook.afterRead = () => expect(commitRecord(target, B).ok).toBe(true);
    expect(modes(load())).toEqual(['auto', 'native']);
    expect(modes(load())).toEqual(['full-access', 'full_access']);
  });

  it('publishes under the record lock, and the next start accepts what it wrote', async () => {
    write('record.json', A);
    // Another writer would wait here: the check and the rename are one critical section.
    hook.beforeRename = () => expect(fs.existsSync(join(records, 'record.lock'))).toBe(true);
    expect(commitRecord(target, B).ok).toBe(true);
    expect(modes(load())).toEqual(['full-access', 'full_access']);
    expect(fs.readdirSync(records)).toEqual(['record.json']);
    const cfg = await loadDaemonConfig({ config, dataDir: undefined });
    if (!cfg.ok) throw new Error(cfg.error);
    expect(
      harnessRecordProblems({ dataDir: data, harnesses: ['codex'], runtime: cfg.value.runtime }),
    ).toEqual([]);
  });

  it('takes over the lock of a writer that died holding it', () => {
    write('record.json', A);
    write('record.lock', 2 ** 22 + 12_345);
    expect(commitRecord(target, B).ok).toBe(true);
    expect(modes(load())).toEqual(['full-access', 'full_access']);
  });

  it('a writer that crashed before its rename leaves the old record in force', () => {
    write('record.json', A);
    write('record.json.999.dead.tmp', B);
    expect(modes(load())).toEqual(['auto', 'native']);
    expect(commitRecord(target, B).ok).toBe(true);
    expect(modes(load())).toEqual(['full-access', 'full_access']);
  });
});
