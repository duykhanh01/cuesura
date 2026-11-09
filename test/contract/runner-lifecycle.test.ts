/**
 * T067 runner lifecycle contract (FR-007/009): real child processes, no systemd and no model. Silent
 * CPU, child-process and file progress are not stalls; a really silent tree is stopped as stalled;
 * wall timeout sends TERM, then KILL after the grace, and verifies the tree is empty; descendants that
 * left the group are stopped too; a passed durable deadline or a UTC jump never starts or extends a
 * run; an existing marker is never re-spawned; secrets are redacted before they reach the run dir.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUN_FILES, RunDir, readRecords } from '../../src/runner/files.ts';
import { checkIdentity } from '../../src/runner/identity.ts';
import {
  execOperation,
  SYSTEM_CLOCK,
  type LifecycleClock,
  type RunnerExit,
} from '../../src/runner/lifecycle.ts';
import {
  assessProgress,
  initialProgress,
  isStalled,
  parseStat,
  remainingMs,
} from '../../src/runner/progress.ts';
import { Redactor } from '../../src/runner/redact.ts';
import { InvocationSpecSchema, type InvocationSpec } from '../../src/runner/supervisor.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-lifecycle-')));
  dirs.push(d);
  return d;
}

function setup(
  script: string,
  over: Partial<InvocationSpec> = {},
  redactor = new Redactor(),
): RunDir {
  const data = tmp();
  const run = RunDir.open({
    dataDir: data,
    kind: 'operations',
    id: 'op-1',
    redactor,
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
    ...over,
  };
  run.writeJson(RUN_FILES.invocation, InvocationSpecSchema.parse(spec));
  return run;
}

async function exec(run: RunDir, clock?: LifecycleClock): Promise<RunnerExit> {
  const r = await execOperation(run, {
    sample_ms: 50,
    onStop: () => () => undefined,
    ...(clock === undefined ? {} : { clock }),
  });
  if (r.state !== 'finished') throw new Error(`not finished: ${r.state}`);
  return r.exit;
}

function stdoutRecords(run: RunDir): unknown[] {
  const r = readRecords(run, 'op-1', null);
  if (!r.ok) throw new Error(r.error.code);
  return r.value.records.map((x) => ({ kind: x.kind, data: x.data }));
}

/** Running, not a zombie waiting for a reaper that is not this test. */
const pidAlive = (pid: number): boolean => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch {
    return false;
  }
};

describe('progress is not liveness, silence is not a stall', () => {
  it('finishes a run without a wall cap or task deadline', async () => {
    const run = setup('sleep 0.2; echo done', {
      wall_ms: null,
      deadline_at: null,
    });
    const exit = await exec(run);
    expect(exit).toMatchObject({
      outcome: 'exited',
      exit_code: 0,
      deadline_at: null,
    });
  });

  it('still detects a stalled worker without a wall cap or task deadline', async () => {
    const run = setup('sleep 30', {
      wall_ms: null,
      deadline_at: null,
      stall_ms: 300,
    });
    const exit = await exec(run);
    expect(exit.outcome).toBe('stalled');
    expect(exit.termination.tree_empty_verified).toBe(true);
  });

  it('applies whichever optional time cap is present', () => {
    const base = { start_mono: 0, now_mono: 100, now_utc: 1000 };
    expect(remainingMs({ ...base, wall_ms: null, deadline_at: null })).toBe(Infinity);
    expect(remainingMs({ ...base, wall_ms: 500, deadline_at: null })).toBe(400);
    expect(remainingMs({ ...base, wall_ms: null, deadline_at: 1500 })).toBe(500);
  });

  it('a silent CPU-busy process is not stalled', async () => {
    const run = setup(
      'end=$(($(date +%s%N)/1000000+900)); while [ $(($(date +%s%N)/1000000)) -lt $end ]; do :; done',
      { stall_ms: 400 },
    );
    const exit = await exec(run);
    expect(exit.outcome).toBe('exited');
    expect(exit.exit_code).toBe(0);
  });

  it('a parent waiting on a busy child is progressing through the child CPU', async () => {
    const run = setup(
      "sh -c 'end=$(($(date +%s%N)/1000000+900)); while [ $(($(date +%s%N)/1000000)) -lt $end ]; do :; done'; exit 0",
      { stall_ms: 400 },
    );
    expect((await exec(run)).outcome).toBe('exited');
  });

  it('file changes in a watched directory count as progress', async () => {
    const watched = tmp();
    const run = setup(`for i in 1 2 3 4 5 6; do sleep 0.2; echo $i > ${watched}/f$i; done`, {
      stall_ms: 500,
      watch: [watched],
    });
    expect((await exec(run)).outcome).toBe('exited');
  });

  it('a process writing only stderr is progressing', async () => {
    const run = setup(
      `${process.execPath} -e "let i = 0; const t = setInterval(() => { process.stderr.write('tick ' + i + '\\n'); if (++i >= 20) clearInterval(t); }, 50)"`,
      { stall_ms: 300 },
    );
    expect((await exec(run)).outcome).toBe('exited');
  });

  it('stdout arriving in pieces of one unfinished line is progressing', async () => {
    const run = setup(
      `${process.execPath} -e "let i = 0; process.stdout.write('{'); const t = setInterval(() => { process.stdout.write('\\"k' + i + '\\":1,'); if (++i >= 20) { clearInterval(t); process.stdout.write('\\"end\\":1}\\n'); } }, 50)"`,
      { stall_ms: 300 },
    );
    expect((await exec(run)).outcome).toBe('exited');
  });

  it('a tree with no CPU, output or file change is stopped as stalled and verified empty', async () => {
    const run = setup('sleep 30', { stall_ms: 300 });
    const exit = await exec(run);
    expect(exit.outcome).toBe('stalled');
    expect(exit.termination.term_sent).toBe(true);
    expect(exit.termination.tree_empty_verified).toBe(true);
    expect(exit.spawned).toBe(true);
  });
});

describe('deadline and stop', () => {
  it('wall timeout sends TERM, then KILL to a process that ignores TERM, within the bounds', async () => {
    const run = setup("trap '' TERM; while :; do sleep 0.05; done", {
      wall_ms: 400,
      term_grace_ms: 300,
    });
    const t0 = Date.now();
    const exit = await exec(run);
    expect(exit.outcome).toBe('timeout');
    expect(exit.termination).toMatchObject({
      term_sent: true,
      kill_sent: true,
      tree_empty_verified: true,
    });
    expect(Date.now() - t0).toBeLessThan(400 + 300 + 2_000 + 1_500);
  });

  it('descendants that left the process group are stopped after the leader exits', async () => {
    const pidFile = join(tmp(), 'pid');
    const run = setup(`setsid sh -c 'echo $$ > ${pidFile}; exec sleep 30' & sleep 0.3; exit 0`);
    const exit = await exec(run);
    const escaped = Number(readFileSync(pidFile, 'utf8'));
    expect(exit.outcome).toBe('exited');
    expect(exit.termination.killed_after_exit).toBeGreaterThan(0);
    expect(exit.termination.tree_empty_verified).toBe(true);
    expect(pidAlive(escaped)).toBe(false);
  });

  it('never starts past the durable deadline (restart after the deadline)', async () => {
    const run = setup('echo started', { deadline_at: Date.now() - 1 });
    const exit = await exec(run);
    expect(exit).toMatchObject({ outcome: 'timeout', spawned: false });
    expect(run.readFinal(RUN_FILES.pid).state).toBe('missing');
    expect(stdoutRecords(run)).toEqual([]);
  });

  it('a UTC jump forward ends the run at the durable deadline; a jump back does not extend it', async () => {
    let offset = 0;
    const clock: LifecycleClock = {
      now: () => Date.now() + offset,
      monotonic: SYSTEM_CLOCK.monotonic,
    };
    const run = setup('sleep 30', {
      wall_ms: 20_000,
      deadline_at: Date.now() + 20_000,
    });
    setTimeout(() => (offset = 60_000), 200);
    expect((await exec(run, clock)).outcome).toBe('timeout');

    const back: LifecycleClock = {
      now: () => Date.now() - 3_600_000,
      monotonic: SYSTEM_CLOCK.monotonic,
    };
    const run2 = setup('sleep 30', { wall_ms: 400 });
    const t0 = Date.now();
    expect((await exec(run2, back)).outcome).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('pure wall budget is the smaller of monotonic and UTC', () => {
    const base = { start_mono: 0, wall_ms: 1_000, deadline_at: 10_000 };
    expect(remainingMs({ ...base, now_mono: 200, now_utc: 9_500 })).toBe(500);
    expect(remainingMs({ ...base, now_mono: 900, now_utc: 0 })).toBe(100);
    expect(remainingMs({ ...base, now_mono: 2_000, now_utc: 0 })).toBe(0);
  });

  it('an existing launch marker is never spawned again', async () => {
    const marker = join(tmp(), 'ran');
    const run = setup(`echo x >> ${marker}`);
    await exec(run);
    const again = await execOperation(run, {
      sample_ms: 50,
      onStop: () => () => undefined,
    });
    expect(again.state).toBe('marker_exists');
    expect(readFileSync(marker, 'utf8')).toBe('x\n');
  });

  it('a runner stop signal cancels the tree', async () => {
    const run = setup('sleep 30');
    let stop: () => void = () => undefined;
    const p = execOperation(run, {
      sample_ms: 50,
      onStop: (s) => {
        stop = s;
        return () => undefined;
      },
    });
    setTimeout(() => stop(), 200);
    const r = await p;
    expect(r.state === 'finished' && r.exit.outcome).toBe('cancelled');
  });
});

describe('output records', () => {
  it('feeds the prompt on stdin, keeps JSON lines as data and counts an oversize line', async () => {
    const run = setup(
      'cat; head -c 300000 /dev/zero | tr "\\0" a; echo; echo \'{"type":"done"}\'',
      {},
    );
    writeFileSync(join(run.ensureDir('context'), 'prompt.md'), '{"prompt":1}\n');
    const spec = InvocationSpecSchema.parse(
      JSON.parse(readFileSync(run.resolve(RUN_FILES.invocation), 'utf8')),
    );
    run.writeJson(RUN_FILES.invocation, {
      ...spec,
      stdin: 'context/prompt.md',
    });
    const exit = await exec(run);
    expect(exit.outcome).toBe('exited');
    expect(exit.artifacts.truncated_records).toBe(1);
    expect(stdoutRecords(run)).toEqual([
      { kind: 'stdout', data: { prompt: 1 } },
      { kind: 'stdout.truncated', data: { reason: 'record over cap' } },
      { kind: 'stdout', data: { type: 'done' } },
    ]);
  });

  it('redacts a canary secret in stdout, stderr and the exit record before they are written', async () => {
    const canary = 'cusr-canary-6f1d2b9e7a';
    const run = setup(
      `echo "{\\"k\\":\\"${canary}\\"}"; echo "${canary}" >&2; exit 3`,
      {},
      new Redactor({ values: [canary] }),
    );
    const exit = await exec(run);
    expect(exit.exit_code).toBe(3);
    const all = ['events.jsonl', 'stderr.log', 'exit.json', 'pid.json', 'launch.json']
      .map((f) => {
        try {
          return readFileSync(run.resolve(f), 'utf8');
        } catch {
          return '';
        }
      })
      .join('\n');
    expect(all).not.toContain(canary);
    expect(all).toContain('[REDACTED]');
  });
});

describe('process identity', () => {
  it('PID reuse or another boot is never the same process', () => {
    const id = { boot_id: 'b1', pid: 42, pgid: 42, start_ticks: 100 };
    expect(checkIdentity(id, { bootId: () => 'b1', startTicks: () => 100 })).toBe('alive');
    expect(checkIdentity(id, { bootId: () => 'b1', startTicks: () => 999 })).toBe('gone');
    expect(checkIdentity(id, { bootId: () => 'b2', startTicks: () => 100 })).toBe('other_boot');
    expect(checkIdentity(id, { bootId: () => 'b1', startTicks: () => 'unreadable' })).toBe(
      'unknown',
    );
  });

  it('parses /proc stat with spaces and parentheses in the name', () => {
    const s = parseStat(7, '7 (a b) c)) S 1 7 7 0 -1 0 0 0 0 0 11 22 0 0 20 0 1 0 333 0 0');
    expect(s).toEqual({
      pid: 7,
      ppid: 1,
      pgid: 7,
      cpu_ticks: 33,
      start_ticks: 333,
    });
  });

  it('unreadable CPU never counts as progress and silence ages into a stall', () => {
    const s0 = { cpu_ticks: null, processes: 1, output_seq: 0, files: null };
    let st = initialProgress(s0, 0);
    st = assessProgress(st, s0, 500);
    expect(isStalled(st, 500, 400)).toBe(true);
    st = assessProgress(st, { ...s0, output_seq: 1 }, 600);
    expect(st.last_reasons).toEqual(['output']);
    expect(isStalled(st, 700, 400)).toBe(false);
  });
});

describe('cusr-runner exec (the entrypoint a unit runs)', () => {
  it('runs one operation from its run directory once; a second exec never spawns again', () => {
    const marker = join(tmp(), 'ran');
    const run = setup(`echo x >> ${marker}; echo '{"ok":true}'`);
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const exec = () =>
      spawnSync(
        process.execPath,
        [
          `${root}src/cli/cusr-runner.ts`,
          'exec',
          '--data-dir',
          run.root,
          '--kind',
          'operations',
          '--id',
          'op-1',
        ],
        { encoding: 'utf8' },
      );
    const first = exec();
    expect(first.status).toBe(0);
    const exit = run.readFinal(RUN_FILES.exit);
    expect(exit.state).toBe('valid');
    const second = exec();
    expect(second.status).toBe(2);
    expect(second.stderr).toContain('already been launched; duplicate execution was refused');
    expect(readFileSync(marker, 'utf8')).toBe('x\n');
  });
});
