/**
 * 007 lát G (review #297 P4, P5): in a native session the harness's own CPU is not progress, its tools'
 * CPU is. The spawned root is the harness whatever it does to its arguments; a child forked with the
 * harness's arguments becomes a tool once it execs, even into the same executable.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RUN_FILES, RunDir } from '../../../src/runner/files.ts';
import { execOperation } from '../../../src/runner/lifecycle.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import { InvocationSpecSchema } from '../../../src/runner/supervisor.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let last: RunDir | null = null;

async function run(argv: string[], wallMs: number) {
  const data = mkdtempSync(join(tmpdir(), 'cusr-native-progress-'));
  dirs.push(data);
  const dir = RunDir.open({
    dataDir: data,
    kind: 'operations',
    id: 'op-1',
    redactor: new Redactor(),
  });
  dir.writeJson(
    RUN_FILES.invocation,
    InvocationSpecSchema.parse({
      schema_version: 1,
      operation_id: 'op-1',
      kind: 'agent',
      run_dir_kind: 'operations',
      run_id: 'op-1',
      argv,
      cwd: data,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      wall_ms: wallMs,
      deadline_at: Date.now() + 60_000,
      term_grace_ms: 100,
      kill_verify_ms: 1_000,
      launch_nonce: 'nonce-1',
      stall_ms: 700,
      watch: [],
      interactive: true,
    }),
  );
  last = dir;
  const r = await execOperation(dir, { sample_ms: 50, onStop: () => () => undefined });
  if (r.state !== 'finished') throw new Error(r.state);
  return r.exit;
}

it('stalls a root that rewrites its own title and only redraws', async () => {
  const redraw =
    "process.title = 'mock-harness'; setInterval(() => { const e = Date.now() + 30; while (Date.now() < e); }, 100);";
  const exit = await run([process.execPath, '-e', redraw, '--', '# first message'], 4_000);
  expect(exit.outcome).toBe('stalled');
});

it('keeps a tool forked with the harness arguments that then execs the same program', async () => {
  // The subshell is a fork of the root and carries its arguments until it execs bash again.
  const script = "( sleep 0.4; exec /bin/bash -c 'while (( SECONDS < 2 )); do :; done' ); wait";
  const exit = await run(['/bin/bash', '-c', script, 'bash', '# first message'], 10_000);
  expect(exit).toMatchObject({ outcome: 'exited', exit_code: 0 });
});

it('keeps what a native session said on stderr as it failed to start, and still shows it', async () => {
  const fail = "process.stderr.write('Please run /login\\n'); process.exit(1);";
  const exit = await run([process.execPath, '-e', fail, '--', '# first message'], 4_000);
  expect(exit).toMatchObject({ outcome: 'exited', exit_code: 1 });
  expect(readFileSync(last?.resolve(RUN_FILES.stderr) ?? '', 'utf8')).toContain(
    'Please run /login',
  );
});
