import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  fixerExcerpt,
  gateResultOf,
  runAutofix,
  runGates,
  runSetup,
  type CommandSetDeps,
  type CommandSetInput,
} from '../../../src/adapters/gates.ts';
import type { Caller } from '../../../src/application/authz.ts';
import {
  taskGateLog,
  type GateLogDeps,
  type GateLogPage,
} from '../../../src/application/gate-logs.ts';
import { ensureWorktree, markerPath } from '../../../src/adapters/git/worktree.ts';
import type { SandboxProvider } from '../../../src/adapters/ports.ts';
import {
  CommandJournal,
  EXCERPT_BYTES,
  RETRY_SAFETY,
  SpawnExecutor,
  type CommandExecutor,
} from '../../../src/runner/commands.ts';
import type { TaskState } from '../../../src/domain/state.ts';
import { GateDataSchema } from '../../../src/domain/trigger.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import { HostExecutionProvider, shortTmpDir } from '../../../src/runner/sandbox.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { hashText } from '../../../src/shared/hash.ts';
import { ok } from '../../../src/shared/result.ts';
import { uuidOf } from '../../support/builders.ts';
import { gitSandbox } from '../../support/git-repo.ts';

const g = gitSandbox('cusr-gates-');
afterAll(() => g.cleanup());

const SECRET = 'gate-secret-value-123';
const now = 1_000_000;
const clock = { now: () => now as EpochMs, monotonic: () => now };

/** Runs `/bin/sh -c` directly: exercises the command logic without bwrap. */
const passthrough: SandboxProvider = {
  provider: 'bwrap',
  plan: (layout, command) =>
    ok({
      isolation_mode: 'isolated',
      provider: 'bwrap',
      role: layout.role,
      argv: [...command],
      cwd: layout.worktree,
      env: { PATH: '/usr/bin:/bin', SECRET_VALUE: SECRET },
      network: 'internet_outbound',
      mount_sources: [],
      layout_digest: hashText(layout.role),
      layout_shape: hashText(layout.role),
      proof_refs: [],
    }),
};

let n = 0;
async function setup(
  sandbox: SandboxProvider = passthrough,
  executor: CommandExecutor = new SpawnExecutor(),
) {
  const project = g.repo(`p${n}`);
  const data = join(g.base, `data${n++}`);
  const spec = {
    task_id: uuidOf(1),
    title: 'gates',
    project_realpath: project,
    common_git_dir: join(project, '.git'),
    base_sha: g.sh(project, 'rev-parse', 'HEAD'),
    worktrees_root: join(data, 'wt'),
    markers_dir: join(data, 'owners'),
    nonce: 'n',
  };
  const wt = await ensureWorktree(g.runner(), spec);
  if (wt.kind !== 'created') throw new Error(JSON.stringify(wt));
  const scratch = join(data, 'scratch');
  mkdirSync(scratch, { recursive: true });
  const deps: CommandSetDeps = {
    sandbox,
    executor,
    clock,
    redactor: new Redactor({ values: [SECRET] }),
    git: g.runner(),
  };
  const input = (
    commands: { name: string; command: string }[],
    over: Partial<CommandSetInput> = {},
  ): CommandSetInput => ({
    commands,
    layout: {
      worktree: wt.worktree_path,
      git_dirs: [spec.common_git_dir],
      scratch,
      context: null,
      schema: null,
      toolchain: [],
      env: {},
      network: 'internet_outbound',
    },
    wall_ms: 10_000,
    deadline_at: null,
    checkpoint: {
      task_id: spec.task_id,
      revision: 1,
      project_realpath: project,
      common_git_dir: spec.common_git_dir,
      worktree_path: wt.worktree_path,
      branch: wt.branch,
      base_sha: spec.base_sha,
      owner_marker: markerPath(spec.markers_dir, spec.task_id),
    },
    ...over,
  });
  return { deps, input, worktree: wt.worktree_path };
}

describe('setup/gate/autofix commands (T038, FR-004)', () => {
  it('runs a gate without an implicit command timeout', async () => {
    const { deps, input } = await setup();
    const r = await runGates(
      deps,
      input([{ name: 'unit', command: 'sleep 0.1; true' }], { wall_ms: null }),
    );
    expect(r.receipts).toHaveLength(1);
    expect(r.receipts[0]).toMatchObject({ status: 'passed', wall_ms: null });
  });

  it('a gate that rewrites the tree makes the whole set run again on the final tree (M06)', async () => {
    const { deps, input, worktree } = await setup();
    // A formatter normalises a file once; the second pass finds nothing to change.
    writeFileSync(join(worktree, 'f.txt'), 'messy\n');
    const r = await runGates(
      deps,
      input([
        { name: 'format', command: 'grep -q tidy f.txt || echo tidy > f.txt' },
        { name: 'unit', command: 'grep -q tidy f.txt' },
      ]),
    );
    expect(r.data).toMatchObject({
      stable: true,
      results: [
        { gate: 'format', passed: true },
        { gate: 'unit', passed: true },
      ],
    });
    expect(r.receipts).toHaveLength(2);
    expect(r.data?.tree).toBe(g.sh(worktree, 'write-tree'));
  });

  it('a tree that keeps moving is reported unstable after a bounded number of passes', async () => {
    const { deps, input, worktree } = await setup();
    const r = await runGates(deps, input([{ name: 'churn', command: 'date +%s%N >> churn.txt' }]));
    expect(r.data?.stable).toBe(false);
    expect(g.sh(worktree, 'show', ':churn.txt').split('\n')).toHaveLength(3);
  });

  it('runs each frozen gate with /bin/sh -c and reports results with stable failure signatures', async () => {
    const { deps, input } = await setup();
    const r = await runGates(
      deps,
      input([
        { name: 'build', command: 'true' },
        { name: 'unit', command: 'echo "1 failing" >&2; exit 3' },
        { name: 'lint', command: 'test -f a.txt' },
      ]),
    );
    expect(r.kind).toBe('completed');
    expect(r.data?.results).toEqual([
      { gate: 'build', passed: true },
      {
        gate: 'unit',
        passed: false,
        signature: expect.stringMatching(/^gate:unit:exit_3:[0-9a-f]{12}$/) as unknown,
        log_excerpt: '1 failing\n',
      },
      { gate: 'lint', passed: true },
    ]);
    expect(r.receipts.map((x) => x.status)).toEqual(['passed', 'failed', 'passed']);
    expect(r.receipts[1]?.output.tail).toContain('1 failing');
  });

  it('checkpoints the worktree before a command writes', async () => {
    const { deps, input, worktree } = await setup();
    const r = await runAutofix(
      deps,
      input([{ name: 'format_fix', command: 'echo formatted > fmt.txt' }]),
    );
    expect(r.kind).toBe('completed');
    expect(existsSync(join(worktree, 'fmt.txt'))).toBe(true);
    if (r.kind !== 'completed') return;
    expect(
      spawnSync('git', ['cat-file', '-e', `${r.checkpoint.tree_oid}:fmt.txt`], {
        cwd: worktree,
        env: g.env,
      }).status,
    ).not.toBe(0);
  });

  it('caps a command by its wall and by the task deadline', async () => {
    const { deps, input } = await setup();
    const slow = await runGates(
      deps,
      input([{ name: 'unit', command: 'sleep 5' }], { wall_ms: 200 }),
    );
    expect(slow.receipts[0]).toMatchObject({ status: 'timeout', wall_ms: 200 });
    expect(slow.data?.results).toEqual([
      { gate: 'unit', passed: false, signature: 'gate:unit:timeout' },
    ]);

    const near = await runGates(
      deps,
      input([{ name: 'unit', command: 'sleep 5' }], {
        deadline_at: (now + 150) as EpochMs,
      }),
    );
    expect(near.receipts[0]).toMatchObject({ status: 'timeout', wall_ms: 150 });

    const past = await runGates(
      deps,
      input([{ name: 'unit', command: 'touch ran.txt' }], {
        deadline_at: (now - 1) as EpochMs,
      }),
    );
    expect(past.receipts[0]).toMatchObject({
      status: 'deadline',
      started_at: null,
    });
  });

  it('redacts secrets from the recorded output', async () => {
    const { deps, input } = await setup();
    const r = await runGates(
      deps,
      input([{ name: 'unit', command: 'echo "token=$SECRET_VALUE"; exit 1' }]),
    );
    expect(r.receipts[0]?.output.tail).not.toContain(SECRET);
    expect(r.receipts[0]?.output.tail).toContain('[REDACTED]');
  });

  it('setup stops at the first failure; an empty setup passes without running anything', async () => {
    const { deps, input } = await setup();
    const r = await runSetup(
      deps,
      input([
        { name: 'install', command: 'exit 1' },
        { name: 'second', command: 'touch second.txt' },
      ]),
    );
    expect(r).toMatchObject({
      kind: 'completed',
      setup: { ran: true, passed: false },
    });
    expect(r.receipts).toHaveLength(1);
    expect(await runSetup(deps, input([]))).toMatchObject({
      kind: 'completed',
      setup: { ran: false, passed: true },
    });
  });

  it('an unknown outcome of autofix waits for a human; of a gate it may be retried', async () => {
    const unknown: CommandExecutor = {
      run: () =>
        Promise.resolve({
          kind: 'unknown',
          message: 'runner lost',
          output: '',
        }),
    };
    const { deps, input } = await setup(passthrough, unknown);
    expect(RETRY_SAFETY).toEqual({
      setup: 'safe',
      gate: 'safe',
      autofix: 'unsafe',
    });
    expect(await runAutofix(deps, input([{ name: 'format_fix', command: 'x' }]))).toMatchObject({
      kind: 'unknown',
      retry_allowed: false,
    });
    expect(await runGates(deps, input([{ name: 'unit', command: 'x' }]))).toMatchObject({
      kind: 'unknown',
      retry_allowed: true,
    });
  });

  it('a sandbox plan that is refused never launches the command', async () => {
    const refusing: SandboxProvider = {
      provider: 'bwrap',
      plan: () => ({
        ok: false,
        error: { code: 'policy_violation', message: 'no' },
      }),
    };
    const { deps, input } = await setup(refusing);
    const r = await runGates(deps, input([{ name: 'unit', command: 'touch ran.txt' }]));
    expect(r.receipts[0]).toMatchObject({
      status: 'not_launched',
      detail: 'policy_violation: no',
    });
  });
});

describe('gates through the production host launcher', () => {
  it('runs the configured gate in its worktree and records the result', async () => {
    const { deps, input, worktree } = await setup(new HostExecutionProvider());
    const r = await runGates(deps, input([{ name: 'build', command: 'echo built > out.txt' }]));
    expect(r.receipts[0]).toMatchObject({ status: 'passed' });
    expect(existsSync(join(worktree, 'out.txt'))).toBe(true);
  });

  it('gives a gate a short private temp directory, removed afterwards', async () => {
    const { deps, input, worktree } = await setup(new HostExecutionProvider());
    const base = input([
      {
        name: 'build',
        command: 'f=$(mktemp) && echo "$f" > out.txt && echo "$TMPDIR" >> out.txt',
      },
    ]);
    const scratch = join(base.layout.scratch, 'x'.repeat(80));
    mkdirSync(scratch, { recursive: true });
    const r = await runGates(deps, {
      ...base,
      layout: { ...base.layout, scratch },
    });
    expect(r.receipts[0]).toMatchObject({ status: 'passed' });
    const [file, tmp] = readFileSync(join(worktree, 'out.txt'), 'utf8').trim().split('\n');
    // A Unix socket path holds 108 bytes; the scratch dir alone leaves no room for one.
    expect(tmp).toBe(shortTmpDir(scratch));
    expect(`${tmp}/cusr-deadline-XXXXXX/control.sock`.length).toBeLessThan(108);
    expect(file?.startsWith(`${tmp}/`)).toBe(true);
    expect(existsSync(tmp!)).toBe(false);
  });
});

describe('gate logs (#178)', () => {
  const MIB = 1024 * 1024;
  /** Prints markers at the two ends and the middle of `bytes` of filler lines. */
  const noisy = (bytes: number, tail = ''): string =>
    `echo MARKER-START; yes filler-line-of-a-long-test-report | head -c ${bytes / 2}; ` +
    `echo; echo MARKER-MIDDLE; yes filler-line-of-a-long-test-report | head -c ${bytes / 2}; ` +
    `echo; echo MARKER-END; ${tail} exit 1`;

  async function gate(command: string, dir = join(g.base, `journal${n++}`)) {
    const { deps, input } = await setup();
    const r = await runGates(
      { ...deps, journal: new CommandJournal(dir) },
      input([{ name: 'unit', command }]),
    );
    const result = r.data?.results[0];
    const log = result?.log === undefined ? null : join(dir, result.log.ref);
    return { dir, result, log };
  }

  it('keeps the two ends in the excerpt and all of a 2 MiB output in the log', async () => {
    const { result, log } = await gate(noisy(2 * MIB));
    expect(result?.log_excerpt).toContain('MARKER-START');
    expect(result?.log_excerpt).toContain('MARKER-END');
    expect(result?.log_excerpt).toMatch(/\[cuesura: \d+ of \d+ bytes omitted\]/);
    expect(result?.log_excerpt).not.toContain('MARKER-MIDDLE');
    expect(Buffer.byteLength(result?.log_excerpt ?? '')).toBeLessThanOrEqual(EXCERPT_BYTES);
    const whole = readFileSync(log as string, 'utf8');
    for (const m of ['MARKER-START', 'MARKER-MIDDLE', 'MARKER-END']) expect(whole).toContain(m);
    expect(result?.log).toMatchObject({
      digest: hashText(whole),
      bytes: Buffer.byteLength(whole),
      truncated: false,
    });
    expect(() => GateDataSchema.parse({ results: [result] })).not.toThrow();
  });

  it('still has the last line of output past the capture limit, and says what was dropped', async () => {
    const { result, log } = await gate(noisy(20 * MIB));
    expect(result?.log_excerpt).toContain('MARKER-START');
    expect(result?.log_excerpt).toContain('MARKER-END');
    expect(result?.log_excerpt).toMatch(/\[cuesura: \d{8} of \d{8} bytes omitted\]/);
    expect(result?.log?.truncated).toBe(true);
    const whole = readFileSync(log as string, 'utf8');
    expect(whole).toMatch(/\[cuesura: \d+ of \d{8} bytes not captured\]/);
    expect(whole).toContain('MARKER-END');
    expect(Buffer.byteLength(whole)).toBeLessThanOrEqual(16 * MIB + 100);
  });

  it('writes a secret to neither, and only its owner reads the log', async () => {
    const { result, log } = await gate(
      `echo "$SECRET_VALUE"; ${noisy(MIB, 'echo "$SECRET_VALUE";')}`,
    );
    const whole = readFileSync(log as string, 'utf8');
    expect(whole).not.toContain(SECRET);
    expect(result?.log_excerpt).not.toContain(SECRET);
    expect(whole).toContain('[REDACTED]');
    expect(statSync(log as string).mode & 0o777).toBe(0o600);
    expect(statSync(join(log as string, '..')).mode & 0o777).toBe(0o700);
  });

  it('the log a real gate wrote reads back through the daemon query, whole and from its end', async () => {
    const dataDir = join(g.base, `reader${n++}`);
    const effect = uuidOf(7);
    const { result, log } = await gate(noisy(2 * MIB), join(dataDir, 'receipts', effect));
    const path = log as string;
    const deps = {
      store: {
        readTask: () => ({}) as TaskState,
        readEvents: () => [
          { type: 'GateResultRecorded', payload: { effect_id: effect, results: [result] } },
        ],
      },
      dataDir,
    } as unknown as GateLogDeps;
    const owner: Caller = { grant: { actor: 'owner', roles: ['read'] } };
    const query = { kind: 'task_gate_log', task_id: uuidOf(1), gate: result?.gate };

    let offset = 0;
    let all = '';
    for (;;) {
      const r = taskGateLog(deps, owner, { ...query, offset });
      const page = (r as { value: GateLogPage }).value;
      all += page.text;
      offset = page.next_offset;
      if (page.complete) break;
    }
    expect(all).toBe(readFileSync(path, 'utf8'));
    expect(all).toContain('MARKER-MIDDLE');

    const tail = taskGateLog(deps, owner, { ...query, tail: true, limit: 4096 });
    const end = (tail as { value: GateLogPage }).value;
    expect(end.text).toContain('MARKER-END');
    expect(end.text).not.toContain('MARKER-MIDDLE');
  });

  it('tells a reader what runs while it runs, and leaves nothing once it ended', async () => {
    const { deps, input } = await setup();
    const dir = join(g.base, `journal${n++}`);
    const file = join(dir, 'running.state');
    let t = now;
    const seen: unknown[] = [];
    const executor: CommandExecutor = {
      run: (plan, opts) => {
        seen.push(JSON.parse(readFileSync(file, 'utf8')));
        t += 5_000;
        opts.on_output?.();
        seen.push(JSON.parse(readFileSync(file, 'utf8')));
        return new SpawnExecutor().run(plan, opts);
      },
    };
    const r = await runGates(
      {
        ...deps,
        executor,
        clock: { now: () => t as EpochMs, monotonic: () => t },
        journal: new CommandJournal(dir),
      },
      input([{ name: 'unit', command: 'echo out' }]),
    );
    expect(seen).toEqual([
      { gate: 'unit', role: 'gate', started_at: now, last_output_at: null },
      { gate: 'unit', role: 'gate', started_at: now, last_output_at: now + 5_000 },
    ]);
    expect(existsSync(file)).toBe(false);
    expect(r.data?.results[0]?.log?.wall_ms).toBe(5_000);
  });

  it('records the first output at once, then at most once a second', async () => {
    const { deps, input } = await setup();
    const dir = join(g.base, `journal${n++}`);
    const file = join(dir, 'running.state');
    let t = now;
    const seen: unknown[] = [];
    const after = (ms: number, opts: Parameters<CommandExecutor['run']>[1]): void => {
      t += ms;
      opts.on_output?.();
      seen.push(
        (JSON.parse(readFileSync(file, 'utf8')) as { last_output_at: number | null })
          .last_output_at,
      );
    };
    const executor: CommandExecutor = {
      run: (plan, opts) => {
        after(10, opts);
        after(500, opts);
        after(500, opts);
        return new SpawnExecutor().run(plan, opts);
      },
    };
    await runGates(
      {
        ...deps,
        executor,
        clock: { now: () => t as EpochMs, monotonic: () => t },
        journal: new CommandJournal(dir),
      },
      input([{ name: 'unit', command: 'echo out' }]),
    );
    expect(seen).toEqual([now + 10, now + 10, now + 1_010]);
  });

  it('keeps the log of a gate that passed', async () => {
    const { result, log } = await gate('echo all good');
    expect(result).toMatchObject({ passed: true, log: { truncated: false } });
    expect(result?.log_excerpt).toBeUndefined();
    expect(readFileSync(log as string, 'utf8')).toBe('all good\n');
  });

  it('a log that cannot be written leaves the result of the gate alone', async () => {
    const { deps, input } = await setup();
    const dir = join(g.base, `journal${n++}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'logs'), 'not a directory');
    const r = await runGates(
      { ...deps, journal: new CommandJournal(dir) },
      input([{ name: 'unit', command: 'echo out; exit 1' }]),
    );
    expect(r.receipts[0]).toMatchObject({ status: 'failed', output: { log: null } });
    expect(r.data?.results[0]).toMatchObject({ passed: false, log_excerpt: 'out\n' });
    expect(r.data?.results[0]?.log).toBeUndefined();
  });

  it('keeps what a fixer gets within its share, however many gates failed together', () => {
    const log = `first\n${'x\n'.repeat(8000)}last\n`;
    const failed = 10;
    const excerpts = Array.from({ length: failed }, () => fixerExcerpt(log, failed));
    expect(Buffer.byteLength(excerpts.join(''))).toBeLessThanOrEqual(48 * 1024);
    for (const e of excerpts) {
      expect(e.startsWith('first\n')).toBe(true);
      expect(e.endsWith('last\n')).toBe(true);
    }
    expect(fixerExcerpt('short\n', 1)).toBe('short\n');
  });

  it.each([49, 150, 1000])('holds the shared budget when %i gates failed together', (failed) => {
    const log = `first\n${'x\n'.repeat(8000)}last\n`;
    const one = fixerExcerpt(log, failed);
    expect(Buffer.byteLength(one) * failed).toBeLessThanOrEqual(48 * 1024);
  });

  it('stores no suffix of a secret that the capture limit cut in two', async () => {
    // Each short value grows when redacted, which moves the tail of the long one away from the start.
    const SHORT = 'abc123';
    const LONG = `${SHORT.repeat(4000)}TAIL-OF-THE-LONG-SECRET`;
    const script = join(g.base, `secret${n++}.sh`);
    writeFileSync(script, `printf %s '${LONG}'\n`);
    const { deps, input } = await setup();
    const dir = join(g.base, `journal${n++}`);
    // The middle of the stream goes so that the tail starts inside the long secret.
    const after = 8 * MIB - LONG.length + 1000;
    const r = await runGates(
      {
        ...deps,
        redactor: new Redactor({ values: [LONG, SHORT] }),
        journal: new CommandJournal(dir),
      },
      input([
        {
          name: 'unit',
          command: `head -c ${9 * MIB} /dev/zero | tr '\\0' a; sh ${script}; head -c ${after} /dev/zero | tr '\\0' b; echo MARKER-END; exit 1`,
        },
      ]),
    );
    const ref = r.data?.results[0]?.log?.ref as string;
    const whole = readFileSync(join(dir, ref), 'utf8');
    expect(r.data?.results[0]?.log?.truncated).toBe(true);
    expect(whole).toContain('MARKER-END');
    expect(whole).not.toContain('TAIL-OF-THE');
  });

  it('keeps the last line after a single line larger than the capture limit', async () => {
    const { result, log } = await gate(
      `echo START; head -c ${20 * MIB} /dev/zero | tr '\\0' x; echo MARKER-END; exit 1`,
    );
    expect(result?.log_excerpt).toContain('START');
    expect(result?.log_excerpt).toContain('MARKER-END');
    expect(readFileSync(log as string, 'utf8')).toContain('MARKER-END');
  });

  it('reads a receipt an earlier release journaled, which has only a tail', async () => {
    const { deps, input } = await setup();
    const r = await runGates(deps, input([{ name: 'unit', command: 'echo old; exit 1' }]));
    const receipt = r.receipts[0] as (typeof r.receipts)[number];
    const { excerpt: _excerpt, log: _log, ...output } = receipt.output;
    expect(gateResultOf({ ...receipt, output })).toMatchObject({ log_excerpt: 'old\n' });
  });
});
