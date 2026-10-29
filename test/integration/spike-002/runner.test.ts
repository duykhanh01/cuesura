import { spawn, spawnSync } from 'node:child_process';
import {
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
import { afterAll, describe, expect, it } from 'vitest';
import {
  RunnerError,
  artifactPath,
  createOnce,
  execOperation,
  flockArgv,
  parseSpec,
  prepareRunDir,
  readReceipt,
  type RunSpec,
} from '../../../scripts/spike-002/runner.ts';

const FAKE = fileURLToPath(
  new URL(
    '../../fixtures/runtime/spike-0/bin/fake-harness.js',
    import.meta.url,
  ),
);
const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-runner-')));
const leftover: number[] = [];

afterAll(() => {
  for (const pid of leftover) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  rmSync(base, { recursive: true, force: true });
});

let n = 0;
function spec(args: string[], over: Partial<RunSpec> = {}): RunSpec {
  n++;
  return {
    schema_version: 1,
    kind: 'operations',
    operation_id: `op-${n}`,
    attempt_id: null,
    command: [process.execPath, FAKE, ...args],
    cwd: base,
    env: { PATH: '/usr/bin:/bin' },
    stdin_file: null,
    deadline_ms: 20_000,
    redact_files: [],
    binding: null,
    limits: {},
    ...over,
  };
}

function events(dir: string): Array<{
  seq: number;
  generation: number;
  data: unknown;
  truncated?: boolean;
}> {
  return readFileSync(join(dir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(
      (l) =>
        JSON.parse(l) as {
          seq: number;
          generation: number;
          data: unknown;
          truncated?: boolean;
        },
    );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('spike-002 runner prototype', () => {
  it('writes the contract file set with marker, identity, bounded events and exit', async () => {
    const s = spec(['echo', '3']);
    const r = await execOperation(s, base);
    expect(r.status).toBe('finished');
    const dir = join(base, 'operations', s.operation_id);
    for (const f of [
      'launch.json',
      'invocation.json',
      'pid.json',
      'events.jsonl',
      'stderr.log',
      'liveness',
      'progress.json',
      'exit.json',
    ]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    const exit = JSON.parse(
      readFileSync(join(dir, 'exit.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(exit).toMatchObject({
      outcome: 'exited',
      exit_code: 0,
      usage: { status: 'unavailable' },
    });
    const launch = JSON.parse(
      readFileSync(join(dir, 'launch.json'), 'utf8'),
    ) as { nonce: string };
    const pid = JSON.parse(
      readFileSync(join(dir, 'pid.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(exit['launch_nonce']).toBe(launch.nonce);
    expect(pid['launch_nonce']).toBe(launch.nonce);
    expect(typeof pid['start_ticks']).toBe('string');
    expect(pid['boot_id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(events(dir).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(events(dir)[1]?.data).toEqual({ type: 'progress', i: 1 });
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('never respawns an operation whose launch marker exists', async () => {
    const s = spec(['echo', '1']);
    await execOperation(s, base);
    const dir = join(base, 'operations', s.operation_id);
    const before = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    const again = await execOperation(s, base);
    expect(again.status).toBe('marker_exists');
    expect(readFileSync(join(dir, 'events.jsonl'), 'utf8')).toBe(before);
  });

  it('redacts selected auth values and token patterns before anything reaches disk', async () => {
    const secret = 'sk-live-0123456789abcdefSECRET';
    const auth = join(base, 'auth.json');
    writeFileSync(auth, JSON.stringify({ tokens: { access_token: secret } }));
    const s = spec(['secret', secret], { redact_files: [auth] });
    await execOperation(s, base);
    const dir = join(base, 'operations', s.operation_id);
    const all = ['events.jsonl', 'stderr.log', 'invocation.json', 'exit.json']
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    expect(all).not.toContain(secret);
    expect(all).not.toMatch(/ghp_a{36}/);
    expect(all).toContain('[REDACTED]');
    expect(readFileSync(join(dir, 'invocation.json'), 'utf8')).not.toContain(
      auth,
    );
  });

  it('enforces the deadline and verifies the group is gone, including during child startup', async () => {
    const s = spec(['ignore-term', '60000'], {
      deadline_ms: 400,
      limits: { term_grace_ms: 300, kill_verify_ms: 2_000 },
    });
    const r = await execOperation(s, base);
    expect(r.status === 'finished' && r.exit).toMatchObject({
      outcome: 'timeout',
      termination: { term_sent: true, group_empty_verified: true },
    });
  });

  it('escalates SIGTERM to SIGKILL after the child confirms its ignore handler is ready', async () => {
    const s = spec(['ignore-term', '60000'], {
      deadline_ms: 30_000,
      limits: { term_grace_ms: 200, kill_verify_ms: 2_000 },
    });
    const file = join(base, `${s.operation_id}.ready.spec.json`);
    writeFileSync(file, JSON.stringify(s));
    const runner = fileURLToPath(
      new URL('../../../scripts/spike-002/runner.ts', import.meta.url),
    );
    const child = spawn(
      process.execPath,
      [runner, 'exec', '--spec', file, '--root', base],
      { stdio: 'ignore' },
    );
    const dir = join(base, 'operations', s.operation_id);
    try {
      const log = join(dir, 'events.jsonl');
      for (const end = Date.now() + 15_000; Date.now() < end;) {
        if (
          existsSync(log) &&
          readFileSync(log, 'utf8').includes('"type":"ready"')
        )
          break;
        await new Promise((done) => setTimeout(done, 50));
      }
      expect(
        existsSync(log) && readFileSync(log, 'utf8').includes('"type":"ready"'),
      ).toBe(true);
      expect(child.kill('SIGTERM')).toBe(true);
      await new Promise((done) => child.once('close', done));
      expect(
        JSON.parse(readFileSync(join(dir, 'exit.json'), 'utf8')),
      ).toMatchObject({
        outcome: 'cancelled',
        termination: {
          term_sent: true,
          kill_sent: true,
          group_empty_verified: true,
        },
      });
    } finally {
      child.kill('SIGKILL');
      const pidFile = join(dir, 'pid.json');
      if (existsSync(pidFile)) {
        const { pid } = JSON.parse(readFileSync(pidFile, 'utf8')) as {
          pid: number;
        };
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* group already gone */
        }
      }
    }
  });

  it('stops descendants left in the process group after the leader exits; reports the scope honestly', async () => {
    const pids = join(base, 'grandchild-pids.json');
    const s = spec(['grandchild', pids, 'exit'], {
      limits: { term_grace_ms: 200 },
    });
    const r = await execOperation(s, base);
    const { in_group, escaped } = JSON.parse(readFileSync(pids, 'utf8')) as {
      in_group: number;
      escaped: number;
    };
    leftover.push(escaped);
    expect(alive(in_group)).toBe(false);
    // Outside a cusr-op unit the runner only owns its process group; setsid escapes need the unit cgroup (T006).
    expect(r.status === 'finished' && r.exit.termination.descendant_scope).toBe(
      'process_group_only',
    );
    expect(alive(escaped)).toBe(true);
  });

  it('caps a record at record_bytes and keeps the following line intact', async () => {
    const s = spec(['big', String(4096)], { limits: { record_bytes: 1024 } });
    await execOperation(s, base);
    const ev = events(join(base, 'operations', s.operation_id));
    expect(ev[0]?.truncated).toBe(true);
    expect(
      Buffer.byteLength(
        readFileSync(
          join(base, 'operations', s.operation_id, 'events.jsonl'),
          'utf8',
        ).split('\n')[0] ?? '',
      ),
    ).toBeLessThanOrEqual(1024);
    expect(ev[1]?.data).toBe('after');
  });

  it('marks a partial final line after process exit as truncated', async () => {
    const s = spec(['partial']);
    await execOperation(s, base);
    const ev = events(join(base, 'operations', s.operation_id));
    expect(ev[0]).toMatchObject({ data: { type: 'complete' } });
    expect(ev[1]).toMatchObject({ data: '{"type":"cut', truncated: true });
  });

  it('rotates segments into spool/ with increasing generation', async () => {
    const s = spec(['echo', '200'], {
      limits: { segment_bytes: 4096, record_bytes: 1024 },
    });
    await execOperation(s, base);
    const dir = join(base, 'operations', s.operation_id);
    const segments = readdirSync(join(dir, 'spool')).sort();
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]).toBe('events.000000.jsonl');
    const last = events(dir);
    expect(last[0]?.generation).toBe(segments.length);
    expect(last.at(-1)?.seq).toBe(199);
  });

  it('stops the operation with artifact_backpressure instead of dropping output at the spool cap', async () => {
    const s = spec(['flood', String(1024 * 1024)], {
      limits: {
        spool_bytes: 64 * 1024,
        segment_bytes: 32 * 1024,
        record_bytes: 4096,
        term_grace_ms: 500,
      },
    });
    const r = await execOperation(s, base);
    expect(r.status === 'finished' && r.exit.outcome).toBe(
      'artifact_backpressure',
    );
  });

  it('records spawn failure without a pid receipt', async () => {
    const s = spec([], { command: ['/nonexistent/harness'] });
    const r = await execOperation(s, base);
    expect(r.status === 'finished' && r.exit.outcome).toBe('spawn_failed');
  });

  it('rejects secrets in the run spec env and unsafe ids', () => {
    expect(() => parseSpec(spec(['echo'], { env: { GH_TOKEN: 'x' } }))).toThrow(
      RunnerError,
    );
    expect(() =>
      parseSpec(spec(['echo'], { env: { ANTHROPIC_API_KEY: 'x' } })),
    ).toThrow(RunnerError);
    expect(() =>
      parseSpec(spec(['echo'], { operation_id: '../escape' })),
    ).toThrow();
    expect(() =>
      parseSpec(spec(['echo'], { kind: 'runs', attempt_id: null })),
    ).toThrow(RunnerError);
  });

  it('guards the artifact root against symlinks and traversal', () => {
    const root = join(base, 'guard');
    mkdirSync(join(root, 'operations'), { recursive: true });
    symlinkSync('/etc', join(root, 'operations', 'evil'));
    expect(() => prepareRunDir(root, 'operations', 'evil')).toThrow(
      RunnerError,
    );
    const dir = prepareRunDir(root, 'operations', 'good');
    expect(() => artifactPath(dir, '../x')).toThrow(RunnerError);
    expect(() => artifactPath(dir, '/etc/passwd')).toThrow(RunnerError);
    symlinkSync('/etc', join(dir, 'out', 'link'));
    expect(() => artifactPath(dir, 'out/link/passwd')).toThrow(RunnerError);
  });

  it('receipt distinguishes not_launched, unknown, lost, running and finished without suggesting respawn', async () => {
    const root = join(base, 'receipts');
    const dir = prepareRunDir(root, 'operations', 'r1');
    expect(readReceipt(dir).state).toBe('not_launched');
    expect(createOnce(dir, 'launch.json', '{}')).toBe(true);
    expect(createOnce(dir, 'launch.json', '{}')).toBe(false);
    expect(readReceipt(dir).state).toBe('unknown');
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    writeFileSync(
      join(dir, 'pid.json'),
      JSON.stringify({ pid: process.pid, start_ticks: '1', boot_id: boot }),
    );
    expect(readReceipt(dir).state).toBe('lost');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)']);
    const ticks = readFileSync(`/proc/${String(child.pid)}/stat`, 'utf8');
    writeFileSync(
      join(dir, 'pid.json'),
      JSON.stringify({
        pid: child.pid,
        start_ticks: ticks.slice(ticks.lastIndexOf(')') + 2).split(' ')[19],
        boot_id: boot,
      }),
    );
    expect(readReceipt(dir).state).toBe('running');
    child.kill('SIGKILL');
    writeFileSync(
      join(dir, 'pid.json'),
      JSON.stringify({ pid: 1, start_ticks: '1', boot_id: 'other-boot' }),
    );
    expect(readReceipt(dir).state).toBe('lost');
    const s = spec(['echo', '1']);
    await execOperation(s, base);
    expect(readReceipt(join(base, 'operations', s.operation_id)).state).toBe(
      'finished',
    );
  });

  it('holds a kernel flock per operation: a concurrent runner exits 75 without touching files', async () => {
    const root = join(base, 'flock');
    const s = spec(['sleep', '1500']);
    const file = join(base, `${s.operation_id}.spec.json`);
    writeFileSync(file, JSON.stringify(s));
    mkdirSync(join(root, 'locks'), { recursive: true });
    const argv = flockArgv(file, root, s.operation_id);
    const first = spawn(argv[0] as string, argv.slice(1), { stdio: 'ignore' });
    const lock = join(root, 'operations', s.operation_id, 'launch.json');
    for (let i = 0; i < 100 && !existsSync(lock); i++)
      await new Promise((r) => setTimeout(r, 50));
    const second = spawnSync(argv[0] as string, argv.slice(1), {
      encoding: 'utf8',
    });
    expect(second.status).toBe(75);
    await new Promise((r) => first.once('exit', r));
    expect(first.exitCode).toBe(0);
  });
});
