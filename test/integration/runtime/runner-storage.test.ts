/**
 * T088 runner storage limits (FR-008/023/030/031): real child processes, no systemd. A runner whose
 * spool reaches its cap, or whose event log or PID receipt cannot be written (disk full), stops the whole
 * tree, writes exit.json with `artifact_backpressure` and the cause, and counts the output it could not
 * store instead of dropping it silently. ENOSPC is injected at `writeSync`/`openSync` for chosen paths.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RUN_FILES,
  RunDir,
  readRecords,
  spoolUsage,
  type FileLimits,
} from '../../../src/runner/files.ts';
import { execOperation, type RunnerExit } from '../../../src/runner/lifecycle.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import { InvocationSpecSchema, type InvocationSpec } from '../../../src/runner/supervisor.ts';

/** Paths whose writes fail with ENOSPC; null = the disk has room. */
const disk = vi.hoisted(() => ({
  full: null as ((path: string) => boolean) | null,
  fds: new Map<number, string>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const openSync = ((...a: Parameters<typeof fs.openSync>) => {
    const fd = fs.openSync(...a);
    disk.fds.set(fd, String(a[0]));
    return fd;
  }) as typeof fs.openSync;
  const writeSync = ((fd: number, ...rest: unknown[]) => {
    const path = disk.fds.get(fd);
    if (disk.full !== null && path !== undefined && disk.full(path))
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
        code: 'ENOSPC',
      });
    return (fs.writeSync as (...a: unknown[]) => number)(fd, ...rest);
  }) as typeof fs.writeSync;
  return {
    ...fs,
    openSync,
    writeSync,
    default: { ...fs, openSync, writeSync },
  };
});

const dirs: string[] = [];
afterEach(() => {
  disk.full = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SMALL: FileLimits = {
  log_record_bytes: 8_192,
  result_bytes: 8_192,
  log_segment_bytes: 16_384,
  spool_bytes: 32_768,
};

function setup(script: string, limits?: FileLimits): RunDir {
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-storage-')));
  dirs.push(data);
  const run = RunDir.open({
    dataDir: data,
    kind: 'operations',
    id: 'op-1',
    redactor: new Redactor(),
    ...(limits === undefined ? {} : { limits }),
  });
  const spec: InvocationSpec = {
    schema_version: 1,
    operation_id: 'op-1',
    kind: 'agent',
    run_dir_kind: 'operations',
    run_id: 'op-1',
    argv: ['/bin/sh', '-c', script],
    cwd: data,
    env: { PATH: '/usr/bin:/bin' },
    wall_ms: 20_000,
    deadline_at: Date.now() + 60_000,
    term_grace_ms: 300,
    kill_verify_ms: 2_000,
    launch_nonce: 'nonce-1',
    stall_ms: null,
  };
  run.writeJson(RUN_FILES.invocation, InvocationSpecSchema.parse(spec));
  return run;
}

async function exec(run: RunDir): Promise<RunnerExit> {
  const r = await execOperation(run, {
    sample_ms: 50,
    onStop: () => () => undefined,
  });
  if (r.state !== 'finished') throw new Error(`not finished: ${r.state}`);
  return r.exit;
}

const FLOOD =
  'i=0; while [ $i -lt 5000 ]; do echo "{\\"line\\":$i,\\"pad\\":\\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\"}"; echo "err $i" >&2; i=$((i+1)); done; sleep 30';

describe('spool cap (FR-031)', () => {
  it('stops the tree with artifact_backpressure at the cap, keeps every stored record and counts what it could not store', async () => {
    const run = setup(FLOOD, SMALL);
    const started = Date.now();
    const exit = await exec(run);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(exit).toMatchObject({
      outcome: 'artifact_backpressure',
      spawned: true,
      termination: { term_sent: true, tree_empty_verified: true },
      error: null,
    });
    expect(exit.artifacts.dropped_bytes).toBeGreaterThan(0);
    expect(spoolUsage(run)).toBeLessThanOrEqual(SMALL.spool_bytes);
    const stored = readRecords(run, 'op-1', null, { final: true });
    if (!stored.ok) throw new Error(stored.error.code);
    expect(stored.value.torn).toEqual([]);
    expect(stored.value.records).toHaveLength(exit.artifacts.records);
    expect(stored.value.records.at(-1)?.seq).toBe(exit.artifacts.last_seq);
    // Rotation kept every segment: nothing is acknowledged while the run is not ingested.
    expect(stored.value.records[0]?.seq).toBe(1);
  });
});

describe('disk full (FR-023)', () => {
  it('an event log that cannot be written stops the tree; exit.json records the cause and the dropped output', async () => {
    const run = setup('echo \'{"first":1}\'; echo oops >&2; sleep 30');
    disk.full = (p) => p.includes('/spool/') || p.endsWith('stderr.log');
    const started = Date.now();
    const exit = await exec(run);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(exit).toMatchObject({
      outcome: 'artifact_backpressure',
      spawned: true,
      termination: { term_sent: true, tree_empty_verified: true },
      artifacts: { records: 0, last_seq: 0 },
    });
    expect(exit.error).toMatch(/^event log write failed: ENOSPC/);
    expect(exit.artifacts.dropped_bytes).toBeGreaterThan(0);
    // The receipts that could be written stay: the launch marker and the PID receipt.
    expect(existsSync(run.resolve(RUN_FILES.launch))).toBe(true);
    expect(existsSync(run.resolve(RUN_FILES.pid))).toBe(true);
  });

  it('a PID receipt that cannot be written stops the tree at once instead of leaving it unadoptable', async () => {
    const run = setup('sleep 30');
    disk.full = (p) => p.includes('.pid.json.tmp');
    const started = Date.now();
    const exit = await exec(run);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(exit).toMatchObject({
      outcome: 'artifact_backpressure',
      spawned: true,
      termination: { term_sent: true, tree_empty_verified: true },
    });
    expect(exit.error).toMatch(/^pid receipt write failed: ENOSPC/);
  });
});
