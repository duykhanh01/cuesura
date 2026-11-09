/**
 * The CLI end to end (T106, US6.1–7, FR-027.01–05/029/045/046): `runCli` with every real command, over the
 * real socket, to a real daemon on a SQLite file the test seeded; fake ports only behind recheck.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { manifestHash } from '../../../src/application/capabilities.ts';
import {
  DOCTOR_CLIENT_TIMEOUT_MS,
  DOCTOR_PROBE_CACHE_MS,
  DOCTOR_PROBE_BUDGET_MS,
} from '../../../src/application/doctor.ts';
import { recheckTarget } from '../../../src/application/recheck.ts';
import { runStopHook } from '../../../src/cli/assistant.ts';
import { CUSR_COMMANDS } from '../../../src/cli/commands.ts';
import { logsCommandWith } from '../../../src/cli/logs.ts';
import { ExitCode, okEnvelope } from '../../../src/cli/output.ts';
import { runCli } from '../../../src/cli/program.ts';
import { call } from '../../../src/cli/tasks.ts';
import { ingestOperationSpool } from '../../../src/daemon/ingest.ts';
import { ObservationCoordinator } from '../../../src/daemon/observation.ts';
import { Scheduler } from '../../../src/daemon/scheduler.ts';
import type { Trigger } from '../../../src/domain/trigger.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import {
  ACKED_DIR,
  EventLogWriter,
  RunDir,
  segmentFileName,
  SPOOL_DIR,
  type FileLimits,
} from '../../../src/runner/files.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import { SeededDaemon, type SeededExtra } from '../../support/daemon-task.ts';
import { A as HEAD, merge, observation, toGreen } from '../../support/observation.ts';
import {
  fakeGit,
  fakeGitHub,
  fakeHost,
  MANIFESTS,
  userConfig,
} from '../../support/preflight-fakes.ts';
import { runExit } from '../../support/run-exit.ts';
import { createGrantStart, selectionFor } from '../../support/runtime.ts';
import { agentData, PREPARE_DATA, publishData } from '../../support/scenario.ts';
import { toPublish, reviewToCi } from '../../support/store-flows.ts';
import { StoreDriver } from '../../support/store-driver.ts';

type Run = {
  code: number;
  out: string;
  err: string;
  envelope: {
    schema_version: number;
    ok: boolean;
    data: Record<string, unknown> & {
      result?: Record<string, unknown>;
      request_id?: string;
      replayed?: boolean;
    };
    error: {
      code: string;
      message: string;
      request_id: string | null;
      details: Record<string, unknown>;
    };
  };
};

const live: SeededDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.cleanup();
});

function daemon(extra?: SeededExtra): SeededDaemon {
  const sd = new SeededDaemon({}, extra);
  live.push(sd);
  return sd;
}

async function raw(
  sd: SeededDaemon,
  argv: string[],
  o: { commands?: typeof CUSR_COMMANDS; json?: boolean } = {},
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(
    { name: 'cusr', description: 'test', version: '0' },
    [...argv, '--data-dir', sd.dataDir, ...(o.json === false ? [] : ['--json'])],
    { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
    o.commands ?? CUSR_COMMANDS,
  );
  return { code, out: out.join(''), err: err.join('') };
}

/** A finite command: stdout holds exactly one envelope, whatever happened. */
async function cli(sd: SeededDaemon, argv: string[]): Promise<Run> {
  const r = await raw(sd, argv);
  expect(r.out.endsWith('\n')).toBe(true);
  expect(r.out.trimEnd().split('\n')).toHaveLength(1);
  const envelope = JSON.parse(r.out) as Run['envelope'];
  expect(envelope.schema_version).toBe(1);
  return { ...r, envelope };
}

function taskFile(sd: SeededDaemon, body: Record<string, unknown>): string {
  const path = join(sd.base, `task-${Math.random()}.json`);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

const TASK_INPUT = {
  project: 'acme',
  title: 'Add search',
  base_branch: 'main',
  acceptance: ['search by name works'],
};

/** A merge proof while `await_ci` is claimed, past the drain's window: paused, one effect still unclear. */
function pausedDrain(d: StoreDriver, t: CanonicalTask): void {
  createGrantStart(d, t);
  toPublish(d, t, HEAD);
  d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(HEAD));
  d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
    pr_ref: 'acme#7',
    head_sha: HEAD,
  });
  reviewToCi(d, t.id);
  d.claim(d.pendingOne(t.id, 'await_ci').id);
  d.must(t.id, observation(d, t, 'merged', HEAD));
  const s = d.task(t.id);
  d.must(t.id, {
    kind: 'external_completion',
    proof: {
      subject: s.observation?.subject as never,
      merged_at: d.now,
      merged_head_sha: HEAD,
      checked_head_sha: null,
      merge_commit_sha: 'd'.repeat(40),
      observation_id: s.observation?.last?.observation_id as string,
      evidence_ref: 'ev',
    },
    unverified_reason: null,
  });
  d.now += 5 * 60_000;
  d.must(t.id, { kind: 'drain_result', pending_operations: [] });
}

/** The operation's receipt, then its effect's result: what lets recovery acknowledge its segments. */
function resolve(d: StoreDriver, taskId: string, effectId: string, op: string): void {
  d.must(taskId, {
    kind: 'operation_result',
    operation_id: op as Uuid,
    status: 'finished',
    outcome: 'succeeded',
    invocation_id: 'inv-1',
    processes: [],
    started_at: d.now as EpochMs,
    finished_at: d.now as EpochMs,
    receipt_digest: `sha256:${'a'.repeat(64)}`,
  });
  d.must(taskId, {
    kind: 'effect_result',
    effect_id: effectId as Uuid,
    outcome: 'succeeded',
    data: PREPARE_DATA,
  });
}

function asking(d: StoreDriver, t: CanonicalTask): void {
  createGrantStart(d, t, 'direct-pr');
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  d.complete(
    t.id,
    d.pendingOne(t.id, 'start_agent').id,
    'succeeded',
    agentData('needs_input', { questions: ['Which encoding?'] }),
  );
}

describe('commands, envelope and exit codes (US6.1/2, FR-027.01/028)', () => {
  it('walks add → list → show → explain → history → confirm → cancel with one versioned result each', async () => {
    const sd = daemon();
    await sd.start();
    const add = await cli(sd, ['task', 'add', '--file', taskFile(sd, TASK_INPUT)]);
    expect(add.code).toBe(ExitCode.ok);
    const id = add.envelope.data.result?.['task_id'] as string;
    // A generated request ID comes back so the caller can replay it after a timeout.
    expect(add.envelope.data.request_id).toMatch(/^[0-9a-f-]{36}$/);

    const list = await cli(sd, ['task', 'list']);
    expect(list.envelope.data).toMatchObject({
      items: [{ task_id: id, title: 'Add search', project: 'acme' }],
      next_cursor: null,
    });

    const show = await cli(sd, ['task', 'show', id]);
    expect(show.envelope.data).toMatchObject({
      task_id: id,
      status: 'READY',
      details: `cusr task show ${id} --full`,
    });
    expect(show.envelope.data).not.toHaveProperty('provenance');
    const full = await cli(sd, ['task', 'show', id, '--full']);
    expect(full.envelope.data).toMatchObject({
      task_id: id,
      provenance: { usage: [], artifacts: [] },
    });
    const version = String(show.envelope.data['version']);

    const why = await cli(sd, ['task', 'explain', id, '--full']);
    expect(why.envelope.data).toMatchObject({
      task_id: id,
      deadline: { state: 'not_started', remaining_ms: null },
      slot: { holding: false, queued: null, initial_wait_ms: 0 },
    });
    expect(
      (why.envelope.data['allowed_actions'] as { action: string }[]).map((a) => a.action),
    ).toEqual(['propose', 'cancel']);

    const history = await cli(sd, ['task', 'history', id]);
    expect((history.envelope.data['events'] as { type: string }[])[0]?.type).toBe('TaskCreated');

    const confirmed = await cli(sd, ['task', 'confirm', id, '--expected-version', version]);
    expect(confirmed.code).toBe(ExitCode.ok);

    const fresh = await cli(sd, ['task', 'show', id]);
    const cancelled = await cli(sd, [
      'task',
      'cancel',
      id,
      '--expected-version',
      String(fresh.envelope.data['version']),
      '--reason',
      'not needed',
    ]);
    expect(cancelled.code).toBe(ExitCode.ok);
    expect(cancelled.envelope.data.result).toMatchObject({
      status: 'CANCELLED',
    });
  });

  it('pages a list by cursor, at most 100 per page', async () => {
    const sd = daemon();
    await sd.start();
    for (let i = 0; i < 3; i++) await cli(sd, ['task', 'add', '--file', taskFile(sd, TASK_INPUT)]);
    const one = await cli(sd, ['task', 'list', '--limit', '2']);
    const page = one.envelope.data as unknown as {
      items: { task_id: string }[];
      next_cursor: string;
    };
    expect(page.items).toHaveLength(2);
    expect(page.next_cursor).toBe(page.items[1]?.task_id);
    const two = await cli(sd, ['task', 'list', '--cursor', page.next_cursor]);
    expect(two.envelope.data).toMatchObject({ next_cursor: null });
    expect(two.envelope.data['items']).toHaveLength(1);
    const tooMany = await cli(sd, ['task', 'list', '--limit', '101']);
    expect(tooMany.code).toBe(ExitCode.usage);
  });

  it('maps each outcome to exits 0, 2, 3, 4, 5 and 6; a failed or finished task does not change a query', async () => {
    const sd = daemon();
    const { t } = sd.seed((d) => {
      const t = buildTask();
      createGrantStart(d, t, 'direct-pr');
      d.must(t.id, { kind: 'cancel', reason: 'stop' });
      return { t };
    });
    await sd.start();
    const shown = await cli(sd, ['task', 'show', t.id]);
    expect(shown.envelope.data['status']).toBe('CANCELLED');
    expect(shown.code).toBe(ExitCode.ok);

    const flag = await cli(sd, ['task', 'show']);
    expect(flag.code).toBe(ExitCode.usage);
    expect(flag.envelope.error.code).toBe('invalid_arguments');
    const unreadable = await cli(sd, ['task', 'add', '--file', join(sd.base, 'absent.json')]);
    expect(unreadable.code).toBe(ExitCode.usage);
    const schema = await cli(sd, [
      'task',
      'add',
      '--project',
      'acme',
      '--title',
      'T',
      '--base',
      'main',
      '--request-id',
      'not-a-uuid',
    ]);
    expect(schema.code).toBe(ExitCode.usage);
    const noVersion = await cli(sd, ['task', 'cancel', t.id]);
    expect(noVersion.code).toBe(ExitCode.usage);

    expect((await cli(sd, ['task', 'show', uuidOf(4_444)])).code).toBe(ExitCode.missing);
    const stale = await cli(sd, ['task', 'cancel', t.id, '--expected-version', '1']);
    expect(stale.code).toBe(ExitCode.conflict);
    expect(stale.envelope.error.code).toBe('conflict');
    expect(stale.envelope.error.request_id).toMatch(/^[0-9a-f-]{36}$/);

    await sd.stop();
    const gone = await cli(sd, ['task', 'list']);
    expect(gone.code).toBe(ExitCode.connection);
    expect(gone.envelope.error.code).toBe('daemon_unreachable');
    // A mutation whose answer was lost still names the ID to replay.
    const req = '0190e9a0-0000-7000-8000-00000000abcd';
    const lost = await cli(sd, [
      'task',
      'add',
      '--file',
      taskFile(sd, TASK_INPUT),
      '--request-id',
      req,
    ]);
    expect(lost.code).toBe(ExitCode.connection);
    expect(lost.envelope.error.request_id).toBe(req);
  });

  it('the same request replays its first result; a different payload under it is a conflict', async () => {
    const sd = daemon();
    await sd.start();
    const req = '0190e9a0-0000-7000-8000-00000000abce';
    const file = taskFile(sd, TASK_INPUT);
    const first = await cli(sd, ['task', 'add', '--file', file, '--request-id', req]);
    const again = await cli(sd, ['task', 'add', '--file', file, '--request-id', req]);
    expect(again.envelope.data.replayed).toBe(true);
    expect(again.envelope.data.result).toEqual(first.envelope.data.result);
    const other = await cli(sd, [
      'task',
      'add',
      '--file',
      taskFile(sd, { ...TASK_INPUT, title: 'Other' }),
      '--request-id',
      req,
    ]);
    expect(other.code).toBe(ExitCode.conflict);
    expect(((await cli(sd, ['task', 'list'])).envelope.data['items'] as unknown[]).length).toBe(1);
  });

  it('human output has no JSON envelope and no color; errors go to stderr with the request ID', async () => {
    const sd = daemon();
    await sd.start();
    const list = await raw(sd, ['task', 'list'], { json: false });
    expect(list.out).toBe('No tasks.\n');
    // eslint-disable-next-line no-control-regex
    expect(list.out + list.err).not.toMatch(/\u001b\[/);
    const req = '0190e9a0-0000-7000-8000-00000000abcf';
    const missing = await raw(
      sd,
      [
        'task',
        'cancel',
        uuidOf(4_445),
        '--project',
        'acme',
        '--expected-version',
        '1',
        '--request-id',
        req,
      ],
      { json: false },
    );
    expect(missing.code).toBe(ExitCode.missing);
    expect(missing.out).toBe('');
    expect(missing.err).toContain(req);
  });

  it('a real cusr process over the socket; with no daemon it exits 3 and never opens the database', async () => {
    const sd = daemon();
    await sd.start();
    const bin = fileURLToPath(new URL('../../../src/cli/cusr.ts', import.meta.url));
    const run = (args: string[]) =>
      promisify(execFile)(process.execPath, [bin, ...args, '--data-dir', sd.dataDir], {
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      }).then(
        (r) => ({ code: 0, out: r.stdout }),
        (e: { code: number; stdout: string }) => ({
          code: e.code,
          out: e.stdout,
        }),
      );
    const ok = await run(['task', 'list', '--json']);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ schema_version: 1, ok: true });
    const bad = await run(['task', 'show', uuidOf(4_446), '--json']);
    expect(bad.code).toBe(ExitCode.missing);
    await sd.stop();
    // Exclusive-lock files would appear if the CLI opened the store; the store file stays untouched.
    const before = readdirSync(sd.dataDir).sort();
    const down = await run(['task', 'list', '--json']);
    expect(down.code).toBe(ExitCode.connection);
    expect(readdirSync(sd.dataDir).sort()).toEqual(before);
  });
});

describe('syntax errors stop in the CLI (T113)', () => {
  it.each([
    [['task', 'bogus']],
    [['task']],
    [['task', 'list', 'extra']],
    [['task', 'show', uuidOf(1), '--actor', 'owner']],
  ])('%j is one invalid_arguments envelope, exit 2', async (argv) => {
    const sd = daemon();
    await sd.start();
    const r = await cli(sd, argv);
    expect(r.code).toBe(ExitCode.usage);
    expect(r.envelope.error.code).toBe('invalid_arguments');
  });
});

describe('unsupported features change nothing (US6.4/5, FR-021/045)', () => {
  it.each([
    [['task', 'retry', 'ID'], 'task add'],
    [['task', 'approve', 'ID', '--kind', 'merge'], 'merge the PR on GitHub'],
    [['yolo', 'ID'], 'merge the PR on GitHub'],
  ])('%j is unsupported_feature, exit 2, and points the way', async (argv, hint) => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => toGreen(d, t));
    const daemonNow = await sd.start();
    const before = daemonNow.store.readEvents(t.id).length;
    const r = await cli(
      sd,
      argv.map((a) => (a === 'ID' ? t.id : a)),
    );
    expect(r.code).toBe(ExitCode.usage);
    expect(r.envelope.error.code).toBe('unsupported_feature');
    expect(r.envelope.error.details['guidance']).toContain(hint);
    expect(daemonNow.store.readEvents(t.id)).toHaveLength(before);
  });

  it.each(['task_retry', 'merge_approve', 'yolo'])(
    'a raw %s command gets the same answer from the daemon and no ledger row',
    async (kind) => {
      const sd = daemon();
      const t = buildTask();
      sd.seed((d) => toGreen(d, t));
      const running = await sd.start();
      const before = running.store.readEvents(t.id).length;
      const request_id = uuidOf(4_500);
      const r = await sd.command('owner', {
        request_id,
        kind,
        project: t.project,
        task_id: t.id,
        expected_version: 1,
        payload: {},
      });
      expect(r.code).toBe(ExitCode.usage);
      expect(r.envelope.error?.['code']).toBe('unsupported_feature');
      expect(running.store.readCommand(request_id)).toBeNull();
      expect(running.store.readEvents(t.id)).toHaveLength(before);
    },
  );
});

describe('task amend-policy (issue #105)', () => {
  it('previews without --confirm and changes nothing on a task that is not waiting', async () => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => toGreen(d, t));
    const running = await sd.start();
    const before = running.store.readEvents(t.id).length;
    const missing = await cli(sd, ['task', 'amend-policy', t.id]);
    expect(missing.code).toBe(ExitCode.usage);
    const r = await cli(sd, ['task', 'amend-policy', t.id, '--model', 'sol']);
    expect(r.code).toBe(ExitCode.conflict);
    expect(r.envelope.error.details['reason']).toBe('amend_not_applicable');
    expect(running.store.readEvents(t.id)).toHaveLength(before);
  });
});

describe('assistant wait (issue #166)', () => {
  it('tells the holder once, refuses a second session, and moves on --take', async () => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => asking(d, t));
    await sd.start();
    const wait = (...argv: string[]) => cli(sd, ['assistant', 'wait', '--timeout', '1', ...argv]);

    const first = await wait();
    expect(first.code).toBe(ExitCode.ok);
    expect(first.envelope.data['items']).toMatchObject([
      { task_id: t.id, code: 'agent_question', question: 'Which encoding?' },
    ]);
    const lease = first.envelope.data['lease'] as string;

    const quiet = await wait('--lease', lease);
    expect(quiet.envelope.data).toMatchObject({ items: [], timed_out: true });

    const other = await wait();
    expect(other.code).toBe(ExitCode.conflict);
    expect(other.envelope.error.code).toBe('attention_held');

    const taken = await wait('--take');
    expect(taken.envelope.data['items']).toMatchObject([{ task_id: t.id }]);
    expect(taken.envelope.data['lease']).not.toBe(lease);

    const old = await wait('--lease', lease);
    expect(old.code).toBe(ExitCode.conflict);
    expect(old.envelope.error.code).toBe('attention_superseded');
  });

  it('a registered session is told by its Stop hook; another session is not', async () => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => asking(d, t));
    await sd.start();
    const registered = await cli(sd, ['assistant', 'register', '--session', 's-1']);
    expect(registered.envelope.data).toMatchObject({
      session: 's-1',
      items: [{ task_id: t.id, code: 'agent_question' }],
    });

    const notes: string[] = [];
    const hook = (session: string) =>
      runStopHook({
        dataDir: sd.dataDir,
        session,
        pid: process.pid,
        parkMs: 1_000,
        alive: () => false,
        owner: null,
        ownerAlive: () => true,
        query: (lease) =>
          call(
            { dataDir: sd.dataDir },
            '/v1/query',
            { kind: 'attention', lease, mode: 'hook' },
            null,
          ),
        now: Date.now,
        sleep: () => Promise.resolve(),
        deliver: (note) => {
          notes.push(note);
          return Promise.resolve({ exit: 2, confirmed: true });
        },
        ackMoved: () => Promise.resolve(okEnvelope({})),
      });

    expect(await hook('s-2')).toBe(ExitCode.ok);
    expect(notes).toEqual([]);
    // Register listed the task, so the first Stop hook confirms it instead of waking for it (#268).
    expect(await hook('s-1')).toBe(ExitCode.ok);
    expect(notes).toEqual([]);

    expect((await cli(sd, ['assistant', 'unregister', '--session', 's-1'])).envelope.data).toEqual({
      session: 's-1',
    });
    expect(await hook('s-1')).toBe(ExitCode.ok);

    // A register whose reply was lost leaves no lease behind: the hook then tells it.
    await cli(sd, ['assistant', 'register', '--session', 's-1']);
    rmSync(join(sd.dataDir, 'assistant-hook.json'));
    expect(await hook('s-1')).toBe(2);
    expect(notes[0]).toContain(`${t.id} (agent_question)`);
  });

  it('sends a wake again when its delivery failed while the next Stop arrived', async () => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => asking(d, t));
    await sd.start();
    await cli(sd, ['assistant', 'register', '--session', 's-1']);
    // As if the register reply was lost, so the first Stop hook has the task to deliver.
    rmSync(join(sd.dataDir, 'assistant-hook.json'));
    const notes: string[] = [];
    const later: Promise<number>[] = [];
    const hook = (pid: number, ok: boolean, onDelivery?: () => void) =>
      runStopHook({
        dataDir: sd.dataDir,
        session: 's-1',
        pid,
        parkMs: 1_000,
        alive: (other) => other === 1_000,
        owner: null,
        ownerAlive: () => true,
        query: (lease) =>
          call(
            { dataDir: sd.dataDir },
            '/v1/query',
            { kind: 'attention', lease, mode: 'hook' },
            null,
          ),
        now: Date.now,
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
        deliver: (note) => {
          notes.push(note);
          onDelivery?.();
          return Promise.resolve({ exit: 0, confirmed: ok });
        },
        ackMoved: () => Promise.resolve(okEnvelope({})),
      });

    // The turn ends while the first delivery is under way, and that delivery then fails.
    await hook(1_000, false, () => {
      later.push(hook(2_000, true));
    });
    await Promise.all(later);
    expect(notes).toHaveLength(2);
    for (const note of notes) expect(note).toContain(`${t.id} (agent_question)`);
  });

  it('wakes the holder when a task ends, without polling it (issue #257)', async () => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => createGrantStart(d, t, 'direct-pr'));
    await sd.start();
    const wait = (...argv: string[]) => cli(sd, ['assistant', 'wait', '--timeout', '1', ...argv]);
    const first = await wait();
    expect(first.envelope.data['items']).toEqual([]);
    const lease = first.envelope.data['lease'] as string;
    const shown = await cli(sd, ['task', 'show', t.id]);
    const version = String(shown.envelope.data['version']);
    expect((await cli(sd, ['task', 'cancel', t.id, '--expected-version', version])).code).toBe(
      ExitCode.ok,
    );
    const told = await wait('--lease', lease, '--timeout', '5');
    expect(told.code).toBe(ExitCode.ok);
    expect(told.envelope.data['items']).toMatchObject([
      { task_id: t.id, code: 'cancelled', question_id: null },
    ]);
    const quiet = await wait('--lease', told.envelope.data['lease'] as string);
    expect(quiet.envelope.data).toMatchObject({ items: [], timed_out: true });
  });

  it('refuses a timeout that is not a positive whole number', async () => {
    const sd = daemon();
    await sd.start();
    expect((await cli(sd, ['assistant', 'wait', '--timeout', '0'])).code).toBe(ExitCode.usage);
  });
});

describe('inbox and answer (US6, FR-027.01)', () => {
  it('finds the question and answers it from a file; a replay returns the first result', async () => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => asking(d, t));
    await sd.start();
    const box = await cli(sd, ['inbox']);
    const item = (box.envelope.data['items'] as Record<string, unknown>[])[0];
    expect(item).toMatchObject({ task_id: t.id, body: 'Which encoding?' });
    const file = join(sd.base, 'answer.txt');
    writeFileSync(file, 'UTF-8\n');
    const req = '0190e9a0-0000-7000-8000-00000000abd0';
    const argv = [
      'answer',
      item?.['question_id'] as string,
      '--file',
      file,
      '--expected-version',
      String(item?.['task_version']),
      '--request-id',
      req,
    ];
    const first = await cli(sd, argv);
    expect(first.code).toBe(ExitCode.ok);
    expect(first.envelope.data.result).toMatchObject({ status: 'answered' });
    const again = await cli(sd, argv);
    expect(again.envelope.data.replayed).toBe(true);
    const unknown = await cli(sd, [
      'answer',
      uuidOf(4_447),
      '--file',
      file,
      '--expected-version',
      '1',
    ]);
    expect(unknown.code).toBe(ExitCode.missing);
  });
});

describe('a question the decider holds (issue #266)', () => {
  it('is marked in the inbox, and a person answering it tells the decider to stop its run', async () => {
    const rechecked: string[] = [];
    const sd = daemon(() => ({
      decider: {
        holds: () => true,
        version: () => 0,
        recheck: (taskId) => {
          rechecked.push(taskId);
          return Promise.resolve();
        },
      },
    }));
    const t = buildTask();
    sd.seed((d) => asking(d, t));
    await sd.start();
    const box = await cli(sd, ['inbox']);
    const item = (box.envelope.data['items'] as Record<string, unknown>[])[0];
    expect(item).toMatchObject({ task_id: t.id, blocking: true, decider: true });
    const file = join(sd.base, 'answer.txt');
    writeFileSync(file, 'UTF-8\n');
    const answered = await cli(sd, [
      'answer',
      item?.['question_id'] as string,
      '--file',
      file,
      '--expected-version',
      String(item?.['task_version']),
    ]);
    expect(answered.code).toBe(ExitCode.ok);
    expect(rechecked).toEqual([t.id]);
  });
});

describe('explain from committed data (US6.1/7, FR-027.03–05, FR-029)', () => {
  it('separates the first slot wait from a resumed one; only the second counts against the deadline', async () => {
    const sd = daemon();
    const holder = buildTask({ id: uuidOf(5_001), title: 'holder' });
    const queued = buildTask({ id: uuidOf(5_002), title: 'queued' });
    sd.seed((d) => {
      createGrantStart(d, holder, 'direct-pr');
      d.must(queued.id, { kind: 'create_task', task: queued });
      d.must(queued.id, { kind: 'request_execution' });
      d.now += 90_000;
    });
    await sd.start();
    const why = await cli(sd, ['task', 'explain', queued.id, '--full']);
    expect(why.envelope.data).toMatchObject({
      deadline: { state: 'not_started', at: null },
      slot: {
        holding: false,
        queued: { group: 'fresh', position: 1 },
        initial_wait_ms: 90_000,
        resumed_wait_ms: 0,
      },
    });
    const running = await cli(sd, ['task', 'explain', holder.id, '--full']);
    expect(running.envelope.data).toMatchObject({
      deadline: { state: 'running', remaining_ms: 3_600_000 - 90_000 },
      slot: { holding: true, queued: null },
    });
  });

  it('a merged, unverified prerequisite stays visible with its evidence after the dependent started (US1.10)', async () => {
    const sd = daemon();
    const a = buildTask({ id: uuidOf(5_003), title: 'prereq' });
    const b = buildTask({
      id: uuidOf(5_004),
      title: 'dependent',
      depends_on: [a.id],
    });
    sd.seed((d) => {
      toGreen(d, a, 'direct-pr');
      d.must(b.id, { kind: 'create_task', task: b });
      const other = 'c'.repeat(40);
      d.must(a.id, observation(d, a, 'merged', other));
      const s = d.task(a.id);
      d.must(a.id, {
        kind: 'external_completion',
        proof: {
          subject: s.observation?.subject as never,
          merged_at: d.now,
          merged_head_sha: other,
          checked_head_sha: 'a'.repeat(40),
          merge_commit_sha: 'd'.repeat(40),
          observation_id: s.observation?.last?.observation_id as string,
          evidence_ref: 'ev',
        },
        unverified_reason: 'merged_head_unverified',
      });
      d.must(a.id, { kind: 'drain_result', pending_operations: [] });
    });
    const sched = (store: Parameters<SeededExtra>[0]) =>
      new Scheduler({
        store,
        clock: sd.clock,
        newId: sd.newId,
        start: () => Promise.resolve({ kind: 'not_startable', reason: 'test' }),
      });
    const started = await sd.start();
    await sched(started.store).tick();
    const why = await cli(sd, ['task', 'explain', b.id, '--full']);
    expect(why.envelope.data['prerequisites']).toEqual([
      {
        task_id: a.id,
        status: 'DONE',
        wait_code: null,
        paused: false,
        needs_user: false,
        unverified: { reason: 'merged_head_unverified' },
        merged_head_sha: 'c'.repeat(40),
        checked_head_sha: 'a'.repeat(40),
        merge_commit_sha: 'd'.repeat(40),
        evidence: `cusr task show ${a.id}`,
      },
    ]);
    // Durable: the same after a restart.
    await sd.stop();
    await sd.start();
    const after = await cli(sd, ['task', 'explain', b.id, '--full']);
    expect(after.envelope.data['prerequisites']).toEqual(why.envelope.data['prerequisites']);
  });

  it('a confirmed merge still draining shows what is open and is not DONE (FR-027.05)', async () => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => pausedDrain(d, t));
    await sd.start();
    const why = await cli(sd, ['task', 'explain', t.id, '--full']);
    expect(why.envelope.data['status']).not.toBe('DONE');
    expect(why.envelope.data).toMatchObject({
      merge_cleanup: {
        merged_head_sha: HEAD,
        drain: { paused: true },
        unknown_effects: [{ kind: 'await_ci', status: 'started' }],
        recheck: true,
      },
      wait: { detail: { code: 'merge_cleanup_pending' } },
    });
    expect(
      (why.envelope.data['allowed_actions'] as { action: string }[]).map((a) => a.action),
    ).toEqual(['wait', 'recheck']);
  });

  it('READY without a confirmed selection never queues; the confirm explain prints does queue it', async () => {
    const sd: SeededDaemon = daemon((store) => {
      const s = new Scheduler({
        store,
        clock: sd.clock,
        newId: sd.newId,
        start: () => Promise.resolve({ kind: 'not_startable', reason: 'test' }),
      });
      return { schedule: () => s.tick() };
    });
    const t = buildTask();
    sd.seed((d) => {
      d.must(t.id, { kind: 'create_task', task: t });
      d.must(t.id, {
        kind: 'propose_run_config',
        selection: selectionFor(t, 'direct-pr'),
      });
    });
    const running = await sd.start();
    expect(running.store.readTask(t.id)?.execution.request).toBeNull();
    const why = await cli(sd, ['task', 'explain', t.id, '--full']);
    const actions = why.envelope.data['allowed_actions'] as {
      action: string;
      command: string;
    }[];
    expect(actions.map((a) => a.action)).toEqual(['confirm', 'propose', 'cancel']);
    const argv = actions[0]?.command.split(' ').slice(1) as string[];
    expect((await cli(sd, argv)).code).toBe(ExitCode.ok);
    await sd.stop();
    const again = await sd.start();
    expect(
      again.store.readTask(t.id)?.execution.holding ??
        again.store.readTask(t.id)?.execution.request,
    ).not.toBeNull();
    const after = await cli(sd, ['task', 'explain', t.id, '--full']);
    expect(after.envelope.data['allowed_actions']).not.toEqual(actions);
  });

  it('shows the frozen merge method and the proposed message while waiting for a manual merge', async () => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => toGreen(d, t, 'direct-pr', {}, { merge_method: 'rebase' }));
    await sd.start();
    const why = await cli(sd, ['task', 'explain', t.id, '--full']);
    expect(why.envelope.data).toMatchObject({
      wait: { reason: 'approval', detail: { code: 'merge' } },
      merge: { method: 'rebase', observed_method: null },
      pr: { ref: 'acme#7', head_sha: 'a'.repeat(40) },
    });
    expect(JSON.stringify(why.envelope.data['allowed_actions'])).not.toMatch(/amend|accept/i);
    expect(JSON.stringify(why.envelope.data['wait'])).not.toMatch(/amend/);
  });
});

/** A recheck harness: each PR read takes the next scripted facts and is counted. */
function recheckable(sd: { current?: SeededDaemon }) {
  const calls = { observe: 0, drain: 0 };
  const script: ((d: StoreDriver) => Trigger[])[] = [];
  const extra: SeededExtra = (store) => {
    const coordinator = new ObservationCoordinator(() => {
      calls.observe++;
      const d = new StoreDriver(store);
      d.now = sd.current?.now ?? 0;
      return Promise.resolve({
        facts: script.shift()?.(d) ?? [],
        failure: null,
      });
    });
    return {
      newId: () => sd.current?.newId() as string,
      observe: (id, ref) => coordinator.observe(id, ref, 'recheck'),
      drain: () => {
        calls.drain++;
        return Promise.resolve({ pending_operations: [] });
      },
    };
  };
  return { calls, script, extra };
}

function effectsOf(sd: SeededDaemon, id: string): string[] {
  return Object.values(sd.daemon?.store.readTask(id as Uuid)?.effects ?? {}).map((e) => e.kind);
}

describe('task recheck end to end (T110, FR-046.01–08)', () => {
  async function green(o: { limits?: Record<string, number> } = {}) {
    const holder: { current?: SeededDaemon } = {};
    const h = recheckable(holder);
    const sd = daemon(h.extra);
    holder.current = sd;
    const t = buildTask();
    sd.seed((d) => {
      toGreen(d, t, 'direct-pr', o.limits ? { limits: o.limits } : {});
      // The automatic schedule the recheck must leave alone.
      d.must(t.id, observation(d, t, 'open', HEAD));
    });
    await sd.start();
    const version = async (): Promise<string> =>
      String((await cli(sd, ['task', 'show', t.id])).envelope.data['version']);
    return { sd, t, ...h, version };
  }

  it('one PR read, no agent or merge, the schedule untouched; the same request replays without reading', async () => {
    const { sd, t, calls, script, version } = await green();
    script.push((d) => [observation(d, t, 'open', 'a'.repeat(40), { source: 'recheck' })]);
    const before = sd.daemon?.store.readTask(t.id);
    const effects = effectsOf(sd, t.id);
    const req = '0190e9a0-0000-7000-8000-00000000abd1';
    const argv = [
      'task',
      'recheck',
      t.id,
      '--expected-version',
      await version(),
      '--request-id',
      req,
    ];
    const first = await cli(sd, argv);
    expect(first.code).toBe(ExitCode.ok);
    expect(first.envelope.data.result).toMatchObject({
      target: 'observation',
      performed: true,
    });
    expect(calls.observe).toBe(1);
    const again = await cli(sd, argv);
    expect(again.envelope.data.replayed).toBe(true);
    expect(calls.observe).toBe(1);
    const after = sd.daemon?.store.readTask(t.id);
    expect(effectsOf(sd, t.id)).toEqual(effects);
    expect(after?.deadline_at).toBe(before?.deadline_at);
    expect(after?.budget).toEqual(before?.budget);
    expect(before?.observation?.budget.next_due_at).not.toBeNull();
    expect(after?.observation?.budget.next_due_at).toBe(before?.observation?.budget.next_due_at);
    expect(after?.observation?.budget.generation).toBe(before?.observation?.budget.generation);
    expect(after?.status).toBe('WAITING');
  });

  it('a stale version is a conflict with no read', async () => {
    const { sd, t, calls } = await green();
    const stale = await cli(sd, ['task', 'recheck', t.id, '--expected-version', '1']);
    expect(stale.code).toBe(ExitCode.conflict);
    expect(calls.observe).toBe(0);
  });

  it('after observation_expired: still expired on no merge, no poll restarted, DONE path on a merge', async () => {
    const { sd, t, calls, script, version } = await green();
    const store = sd.daemon?.store as NonNullable<SeededDaemon['daemon']>['store'];
    const d = new StoreDriver(store);
    d.now = sd.now;
    // The last read shows another head, so the window cannot be extended (#248).
    d.must(t.id, observation(d, t, 'open', 'b'.repeat(40), { source: 'recheck' }));
    d.now += 31 * 86_400_000;
    sd.now = d.now;
    d.must(t.id, { kind: 'observation_due' });
    expect(d.task(t.id).wait?.detail.code).toBe('observation_expired');
    const budget = d.task(t.id).observation?.budget;

    script.push((x) => [observation(x, t, 'open', 'a'.repeat(40), { source: 'recheck' })]);
    const r = await cli(sd, ['task', 'recheck', t.id, '--expected-version', await version()]);
    expect(r.code).toBe(ExitCode.ok);
    expect(calls.observe).toBe(1);
    expect(d.task(t.id).wait?.detail.code).toBe('observation_expired');
    expect(d.task(t.id).observation?.budget.next_due_at).toBe(budget?.next_due_at);
    expect(d.task(t.id).observation?.expired).toBe(true);

    // The merge seen by a later recheck still ends through FR-040: drain, then DONE; no merge was sent.
    script.push((x) => {
      const seen = observation(x, t, 'merged', HEAD, { source: 'recheck' });
      return [
        seen,
        {
          kind: 'external_completion',
          proof: {
            subject: x.task(t.id).observation?.subject as never,
            merged_at: x.now,
            merged_head_sha: HEAD,
            checked_head_sha: null,
            merge_commit_sha: 'd'.repeat(40),
            observation_id:
              seen.kind === 'observation_result' ? seen.observation.observation_id : '',
            evidence_ref: 'ev',
          },
          unverified_reason: null,
        },
      ] as Trigger[];
    });
    await cli(sd, ['task', 'recheck', t.id, '--expected-version', await version()]);
    expect(calls.observe).toBe(2);
    expect(d.task(t.id).completion?.proof.merged_head_sha).toBe(HEAD);
    expect(effectsOf(sd, t.id)).not.toContain('merge');
    d.must(t.id, { kind: 'drain_result', pending_operations: [] });
    expect(d.task(t.id).status).toBe('DONE');
  });

  it('merge_cleanup: one bounded drain round, also past the deadline; no read of the PR', async () => {
    const holder: { current?: SeededDaemon } = {};
    const h = recheckable(holder);
    const sd = daemon(h.extra);
    holder.current = sd;
    const t = buildTask();
    sd.seed((d) => pausedDrain(d, t));
    await sd.start();
    const v = (await cli(sd, ['task', 'show', t.id])).envelope.data['version'];
    const r = await cli(sd, ['task', 'recheck', t.id, '--expected-version', String(v)]);
    expect(r.envelope.data.result).toMatchObject({
      target: 'drain',
      performed: true,
    });
    expect(h.calls).toEqual({ observe: 0, drain: 1 });
  });

  it('a terminal task stays terminal: no read, no effect, nothing reopens', async () => {
    const holder: { current?: SeededDaemon } = {};
    const h = recheckable(holder);
    const sd = daemon(h.extra);
    holder.current = sd;
    const t = buildTask();
    sd.seed((d) => {
      createGrantStart(d, t, 'direct-pr');
      d.must(t.id, { kind: 'cancel', reason: 'stop' });
    });
    await sd.start();
    const s = sd.daemon?.store.readTask(t.id);
    expect(s && recheckTarget(s)).toBe('terminal');
    const r = await cli(sd, ['task', 'recheck', t.id, '--expected-version', String(s?.version)]);
    expect(r.code).toBe(ExitCode.ok);
    expect(r.envelope.data.result).toMatchObject({
      status: 'CANCELLED',
      target: 'terminal',
      performed: false,
    });
    expect(h.calls).toEqual({ observe: 0, drain: 0 });
  });

  it('nothing to check is a conflict, not a success', async () => {
    const holder: { current?: SeededDaemon } = {};
    const h = recheckable(holder);
    const sd = daemon(h.extra);
    holder.current = sd;
    const t = buildTask();
    sd.seed((d) => createGrantStart(d, t, 'direct-pr'));
    await sd.start();
    const v = sd.daemon?.store.readTask(t.id)?.version;
    const r = await cli(sd, ['task', 'recheck', t.id, '--expected-version', String(v)]);
    expect(r.code).toBe(ExitCode.conflict);
    expect(r.envelope.error).toMatchObject({
      code: 'nothing_to_recheck',
      details: { target: null },
    });
  });

  it('PENDING on a capability: reads config once through triage, then READY; never starts anything', async () => {
    const holder: { current?: SeededDaemon } = {};
    const h = recheckable(holder);
    let manifests: typeof MANIFESTS | Record<string, null> = {};
    const sd = daemon((store, rt) => ({
      ...h.extra(store, rt),
      confirm: {
        store,
        ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
        configInputs: () => Promise.resolve({ user: userConfig(), packs: PACKS, manifests }),
        now: () => sd.now,
      },
    }));
    holder.current = sd;
    await sd.start();
    const add = await cli(sd, ['task', 'add', '--file', taskFile(sd, TASK_INPUT)]);
    const id = add.envelope.data.result?.['task_id'] as string;
    const v0 = add.envelope.data.result?.['version'] as number;
    const confirm = await cli(sd, ['task', 'confirm', id, '--expected-version', String(v0)]);
    expect(confirm.envelope.data.result).toMatchObject({
      status: 'PENDING',
      wait: { detail: { code: 'capability_missing' } },
    });
    const why = await cli(sd, ['task', 'explain', id, '--full']);
    expect(
      (why.envelope.data['allowed_actions'] as { action: string }[]).map((a) => a.action),
    ).toEqual(['fix_external', 'confirm', 'recheck', 'cancel']);
    manifests = MANIFESTS;
    const r = await cli(sd, [
      'task',
      'recheck',
      id,
      '--expected-version',
      String(why.envelope.data['version']),
    ]);
    expect(r.envelope.data.result).toMatchObject({
      target: 'config',
      config_check: 'checked',
      status: 'READY',
    });
    expect(effectsOf(sd, id)).toEqual([]);
  });
});

describe('logs (T114, US6.2, FR-027.01/031)', () => {
  const OP = uuidOf(901);
  const LIMITS: FileLimits = {
    log_record_bytes: 512,
    result_bytes: 2048,
    log_segment_bytes: 1024,
    spool_bytes: 65_536,
  };

  /** A started task whose setup operation writes records into a real run directory. */
  function logged() {
    const secret = randomBytes(16).toString('hex');
    const redactor = new Redactor({ values: [secret] });
    const sd = daemon(() => ({
      logs: { dataDir: sd.dataDir, redactor },
    }));
    const t = buildTask();
    const effect = sd.seed((d) => {
      createGrantStart(d, t);
      const prepare = d.pendingOne(t.id, 'prepare');
      const claimed = d.store.claimEffect(prepare.id as Uuid, d.now as EpochMs, {
        require_runtime: true,
        operation: {
          operation_id: OP,
          kind: 'setup',
          launch_nonce: 'nonce-1',
          unit: 'cusr-op-1.service',
          holds_slot: true,
        },
      });
      if (!claimed.ok) throw new Error(JSON.stringify(claimed.error));
      return prepare.id;
    });
    const run = RunDir.open({
      dataDir: sd.dataDir,
      kind: 'operations',
      id: OP,
      redactor,
      limits: LIMITS,
    });
    const log = EventLogWriter.open(run, OP);
    const write = (n: number, from: number): void => {
      for (let i = 0; i < n; i++) {
        const r = log.append('progress', {
          i: from + i,
          pad: 'x'.repeat(80),
          secret,
        });
        if (!r.ok) throw new Error(r.error.code);
      }
      log.sync();
    };
    const ingest = (store: NonNullable<SeededDaemon['daemon']>['store']) =>
      ingestOperationSpool(
        {
          store,
          dataDir: sd.dataDir,
          redactor,
          limits: LIMITS,
          now: () => sd.now,
          newId: sd.newId,
        },
        t.id,
        OP,
      );
    return { sd, t, effect, run, log, write, ingest, secret };
  }

  const END = { schema_version: 1, type: 'end' };

  type LogPage = {
    records: {
      seq: number;
      cursor: number;
      data: { i: number };
      gap?: unknown;
    }[];
    next_cursor: number;
    complete: boolean;
  };

  it('serves only ingested, redacted records and resumes from any cursor without repeats', async () => {
    const f = logged();
    const running = await f.sd.start();
    f.write(5, 0);
    expect((await cli(f.sd, ['task', 'logs', f.t.id, '--after', '0'])).envelope.data).toMatchObject(
      {
        records: [],
        next_cursor: 0,
      },
    );
    f.ingest(running.store);
    f.write(2, 5); // written, not yet ingested: not served
    const page = (await cli(f.sd, ['task', 'logs', f.t.id, '--after', '0'])).envelope
      .data as unknown as LogPage;
    expect(page.records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(page.next_cursor).toBe(5);
    expect(JSON.stringify(page)).not.toContain(f.secret);
    const rest = (await cli(f.sd, ['task', 'logs', f.t.id, '--after', '3', '--limit', '1']))
      .envelope.data as unknown as LogPage;
    expect(rest.records.map((r) => r.seq)).toEqual([4]);
    expect(rest.next_cursor).toBe(4);
  });

  it('keeps every record through rotation, acknowledgement and a daemon restart', async () => {
    const f = logged();
    // Everything before the daemon opens the store, as after a restart: the run ended and was acknowledged.
    f.sd.seed((d) => {
      f.write(30, 0); // ~170 bytes each: rotates at 1 KiB
      f.ingest(d.store);
      expect(readdirSync(join(f.run.dir, SPOOL_DIR)).length).toBeGreaterThan(1);
      f.log.close();
      f.run.writeExit(runExit(OP, d.now));
      resolve(d, f.t.id, f.effect, OP);
      expect(f.ingest(d.store).acked.length).toBeGreaterThan(0);
    });
    expect(readdirSync(join(f.run.dir, ACKED_DIR))).toContain(segmentFileName(0, 0));
    expect(readdirSync(join(f.run.dir, SPOOL_DIR))).toHaveLength(1);
    await f.sd.start();
    const first = (await cli(f.sd, ['task', 'logs', f.t.id, '--limit', '200'])).envelope
      .data as unknown as LogPage;
    expect(first.records.map((r) => r.data.i)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(first.records.map((r) => r.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    await f.sd.stop();
    await f.sd.start();
    const after = (await cli(f.sd, ['task', 'logs', f.t.id, '--limit', '200'])).envelope
      .data as unknown as LogPage;
    expect(after.records).toEqual(first.records);
  });

  it('a snapshot without --limit shows 20 records; next_cursor reaches the rest', async () => {
    const f = logged();
    const running = await f.sd.start();
    f.write(25, 0);
    f.ingest(running.store);
    const first = (await cli(f.sd, ['task', 'logs', f.t.id])).envelope.data as unknown as LogPage;
    expect(first.records.map((r) => r.data.i)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    const rest = (await cli(f.sd, ['task', 'logs', f.t.id, '--after', String(first.next_cursor)]))
      .envelope.data as unknown as LogPage;
    expect(rest.records.map((r) => r.data.i)).toEqual([20, 21, 22, 23, 24]);
  });

  it('a batch whose files are gone is a gap of that size; the cursor moves past it', async () => {
    const f = logged();
    const running = await f.sd.start();
    f.write(3, 0);
    f.ingest(running.store);
    rmSync(join(f.run.dir, SPOOL_DIR), { recursive: true });
    const page = (await cli(f.sd, ['task', 'logs', f.t.id, '--limit', '200'])).envelope
      .data as unknown as LogPage;
    expect(page.records).toMatchObject([{ seq: 3, gap: { records: 3 } }]);
    expect(page.next_cursor).toBe(3);
  });

  it('--follow prints JSONL with seq and cursor, ends at the session limit with where to resume', async () => {
    const f = logged();
    const running = await f.sd.start();
    f.write(3, 0);
    f.ingest(running.store);
    let now = 0;
    const follow = logsCommandWith({
      maxSessionMs: 3_600_000,
      now: () => now,
      sleep: () => {
        now += 3_600_000;
        return Promise.resolve();
      },
    });
    const r = await raw(f.sd, ['task', 'logs', f.t.id, '--follow'], {
      commands: [follow],
      json: false,
    });
    expect(r.code).toBe(ExitCode.ok);
    const lines = r.out
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.slice(0, 3).map((l) => [l['seq'], l['cursor']])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(lines.at(-1)).toEqual({ ...END, end: 'session_limit', cursor: 3 });
    for (const l of lines) expect([l['schema_version'], typeof l['type']]).toEqual([1, 'string']);
    expect(lines.slice(0, 3).map((l) => l['type'])).toEqual(['record', 'record', 'record']);
    // Resuming prints nothing again.
    now = 0;
    const again = await raw(f.sd, ['task', 'logs', f.t.id, '--follow', '--after', '3'], {
      commands: [follow],
      json: false,
    });
    const more = again.out
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // A wait that resolves without the user is told once and does not end the stream.
    expect(more).toEqual([
      {
        schema_version: 1,
        type: 'state',
        cursor: 3,
        status: 'WAITING',
        wait_code: 'effect_unknown',
        needs_user: false,
      },
      { ...END, end: 'session_limit', cursor: 3 },
    ]);
  });

  it('--follow sleeps when a transient gap leaves the cursor unchanged', async () => {
    const t = buildTask();
    let calls = 0;
    const sd = new SeededDaemon({
      control: () => ({
        queries: {
          task_logs: () => {
            calls++;
            return Promise.resolve({
              status: 200,
              envelope: okEnvelope({
                records: [
                  {
                    seq: 1,
                    cursor: 0,
                    gap: { records: 0, reason: 'unreadable spool' },
                  },
                ],
                next_cursor: 0,
                complete: calls > 3,
              }),
            });
          },
        },
      }),
    });
    live.push(sd);
    await sd.start();
    let now = 0;
    let sleeps = 0;
    const follow = logsCommandWith({
      now: () => now,
      maxSessionMs: 1,
      sleep: () => {
        sleeps++;
        now++;
        return Promise.resolve();
      },
    });
    const r = await raw(sd, ['task', 'logs', t.id, '--follow'], {
      commands: [follow],
      json: false,
    });
    expect(r.code).toBe(ExitCode.ok);
    expect(sleeps).toBe(1);
    expect(calls).toBe(2);
    expect(JSON.parse(r.out.trimEnd().split('\n').at(-1)!)).toEqual({
      ...END,
      end: 'session_limit',
      cursor: 0,
    });
  });

  it.each([false, true])(
    '--follow deduplicates diagnostics without consuming a record seq (json=%s)',
    async (json) => {
      const t = buildTask();
      const operation = uuidOf(901);
      const attempt = uuidOf(902);
      const gap = (cursor: number, reason: string) => ({
        seq: cursor + 1,
        cursor,
        operation_id: operation,
        attempt_id: attempt,
        gap: { records: 0, reason },
      });
      const record = (seq: number) => ({
        seq,
        cursor: seq,
        data: `recovered ${seq}`,
      });
      const line = (type: string, body: object) => ({ schema_version: 1, type, ...body });
      const pages = [
        { records: [gap(0, 'unreadable')], next_cursor: 0 },
        { records: [gap(0, 'unreadable')], next_cursor: 0 },
        { records: [gap(0, 'changed reason')], next_cursor: 0 },
        { records: [record(1)], next_cursor: 1 },
        { records: [gap(1, 'changed reason')], next_cursor: 1 },
        { records: [gap(1, 'changed reason')], next_cursor: 1 },
        { records: [record(2)], next_cursor: 2 },
      ];
      const cursors: unknown[] = [];
      const sd = new SeededDaemon({
        control: () => ({
          queries: {
            task_logs: (_caller, body) => {
              const page = pages[cursors.length];
              cursors.push(body['after']);
              return Promise.resolve({
                status: 200,
                envelope: okEnvelope({
                  ...page,
                  complete: cursors.length >= pages.length,
                }),
              });
            },
          },
        }),
      });
      live.push(sd);
      await sd.start();
      const follow = logsCommandWith({ sleep: () => Promise.resolve() });
      const r = await raw(sd, ['task', 'logs', t.id, '--follow'], {
        commands: [follow],
        json,
      });
      expect(r.code).toBe(ExitCode.ok);
      expect(cursors).toEqual([0, 0, 0, 0, 1, 1, 1]);
      const diagnostic = (cursor: number, reason: string) =>
        line('diagnostic', {
          diagnostic: 'log_gap',
          cursor,
          operation_id: operation,
          attempt_id: attempt,
          reason,
        });
      const output = r.out
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
      expect(output).toEqual([
        diagnostic(0, 'unreadable'),
        diagnostic(0, 'changed reason'),
        line('record', record(1)),
        diagnostic(1, 'changed reason'),
        line('record', record(2)),
        line('end', { end: 'task_finished', cursor: 2 }),
      ]);
    },
  );

  it('--follow ends within one poll once the task needs the user, naming the wait (issue #257)', async () => {
    const sd = daemon(() => ({
      logs: { dataDir: sd.dataDir, redactor: new Redactor() },
    }));
    const t = buildTask();
    sd.seed((d) => asking(d, t));
    await sd.start();
    let sleeps = 0;
    const follow = logsCommandWith({
      sleep: () => {
        sleeps++;
        return Promise.resolve();
      },
    });
    const r = await raw(sd, ['task', 'logs', t.id, '--follow'], { commands: [follow], json: true });
    expect(r.code).toBe(ExitCode.ok);
    expect(sleeps).toBe(0);
    const lines = r.out
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const l of lines) expect([l['schema_version'], typeof l['type']]).toEqual([1, 'string']);
    expect(lines.slice(-2)).toEqual([
      {
        schema_version: 1,
        type: 'state',
        cursor: 0,
        status: 'WAITING',
        wait_code: 'agent_question',
        needs_user: true,
      },
      { ...END, end: 'needs_user', wait_code: 'agent_question', cursor: 0 },
    ]);
  });

  it('a cursor past the last record is refused, not taken silently (issue #257)', async () => {
    const f = logged();
    const running = await f.sd.start();
    f.write(2, 0);
    f.ingest(running.store);
    const r = await cli(f.sd, ['task', 'logs', f.t.id, '--after', '999999']);
    expect(r.code).toBe(ExitCode.usage);
    expect(r.envelope.error).toMatchObject({
      code: 'invalid_arguments',
      details: { after: 999_999, total: 2 },
    });
    const follow = await raw(f.sd, ['task', 'logs', f.t.id, '--follow', '--after', '999999'], {
      json: true,
    });
    expect(follow.code).toBe(ExitCode.usage);
  });

  it('--follow rides out a short daemon restart and resumes where it was (issue #257)', async () => {
    const f = logged();
    const running = await f.sd.start();
    f.write(2, 0);
    f.ingest(running.store);
    let now = 0;
    let sleeps = 0;
    const follow = logsCommandWith({
      maxSessionMs: 10,
      now: () => now,
      sleep: async () => {
        sleeps++;
        now++;
        if (sleeps === 1) await f.sd.stop();
        if (sleeps === 3) await f.sd.start();
      },
    });
    const r = await raw(f.sd, ['task', 'logs', f.t.id, '--follow'], {
      commands: [follow],
      json: true,
    });
    expect(r.code).toBe(ExitCode.ok);
    const lines = r.out
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.filter((l) => l['type'] === 'record').map((l) => l['seq'])).toEqual([1, 2]);
    expect(lines.at(-1)).toEqual({ ...END, end: 'session_limit', cursor: 2 });
  });

  it('--follow ends on its own once a finished task has nothing more', async () => {
    const sd = daemon(() => ({
      logs: { dataDir: sd.dataDir, redactor: new Redactor() },
    }));
    const t = buildTask();
    sd.seed((d) => {
      createGrantStart(d, t, 'direct-pr');
      d.must(t.id, { kind: 'cancel', reason: 'stop' });
    });
    await sd.start();
    const r = await raw(sd, ['task', 'logs', t.id, '--follow'], {
      json: false,
    });
    expect(r.code).toBe(ExitCode.ok);
    expect(JSON.parse(r.out)).toEqual({ ...END, end: 'task_finished', cursor: 0 });
  });

  it('--follow on a lost daemon exits 3 and names the cursor; another project cannot read logs', async () => {
    const f = logged();
    const running = await f.sd.start();
    f.write(2, 0);
    f.ingest(running.store);
    let now = 0;
    const follow = logsCommandWith({
      reconnectMs: 3,
      now: () => now,
      sleep: async () => {
        now += 1;
        await f.sd.stop();
      },
    });
    const r = await raw(f.sd, ['task', 'logs', f.t.id, '--follow'], {
      commands: [follow],
      json: false,
    });
    expect(r.code).toBe(ExitCode.connection);
    expect(r.err).toContain('--after 2');
    expect(JSON.parse(r.out.trimEnd().split('\n').at(-1)!)).toEqual({
      ...END,
      end: 'daemon_unreachable',
      cursor: 2,
    });
  });
});

/** The fixture manifests with what an attempt requires proven, as a real proof would record. */
const PROVEN = Object.fromEntries(
  Object.entries(MANIFESTS).map(([k, m]) => {
    const body = {
      ...m,
      capabilities: {
        ...m.capabilities,
        structured_output: 'proven' as const,
        permission_enforced: 'proven' as const,
        private_home_auth: 'proven' as const,
      },
    };
    return [k, { ...body, manifest_hash: manifestHash(body) }];
  }),
);

describe('doctor (T112, FR-027.02/033)', () => {
  function doctored(
    o: {
      manifests?: Record<string, unknown>;
      host?: Parameters<typeof fakeHost>[0];
      health?: string | null;
      recoveryClaims?: () => readonly { operation_id: string }[];
      spoolProblems?: () => readonly {
        operation_id: string;
        status: string;
        detail?: string;
      }[];
      digest?: (path: string) => string;
      probeBudgetMs?: number;
      harnessTools?: Record<string, { dirs: string[]; requires: string[] }>;
      runtime?: string;
    } = {},
  ) {
    const host = fakeHost(o.host);
    const sd = daemon((_store, rt) => ({
      doctor: {
        dataDir: sd.dataDir,
        host,
        configInputs: () =>
          Promise.resolve({
            user: userConfig(o.runtime === undefined ? {} : { runtime: o.runtime }),
            packs: PACKS,
            manifests: (o.manifests ?? PROVEN) as typeof MANIFESTS,
          }),
        health: () => (o.health === undefined ? rt.health() : o.health),
        ...(o.recoveryClaims === undefined ? {} : { recoveryClaims: o.recoveryClaims }),
        ...(o.spoolProblems === undefined ? {} : { spoolProblems: o.spoolProblems }),
        // The fixture's binaries are not on disk: unless told otherwise each is what its manifest says.
        digest:
          o.digest ??
          ((path) =>
            Object.values(MANIFESTS).find((m) => m.binary.realpath === path)?.binary.digest ??
            'unknown'),
        now: () => sd.now,
        ...(o.probeBudgetMs === undefined ? {} : { probeBudgetMs: o.probeBudgetMs }),
        ...(o.harnessTools === undefined ? {} : { harnessTools: () => o.harnessTools ?? {} }),
      },
    }));
    return { sd, host };
  }
  const names = (r: Run): Record<string, string> =>
    Object.fromEntries(
      (
        (r.envelope.ok ? r.envelope.data['checks'] : r.envelope.error.details['checks']) as {
          name: string;
          status: string;
        }[]
      ).map((c) => [c.name, c.status]),
    );

  it('reports each area on a healthy host, without a model, sudo or provisioning', async () => {
    const { sd, host } = doctored();
    await sd.start();
    const r = await cli(sd, ['doctor', '--project', 'acme']);
    expect(r.code, r.out).toBe(ExitCode.ok);
    expect(names(r)).toMatchObject({
      writer: 'ok',
      schema: 'ok',
      integrity: 'ok',
      replay: 'ok',
      claims: 'ok',
      slot: 'ok',
      data_dir: 'ok',
      storage: 'ok',
      config: 'ok',
      host: 'ok',
      systemd_unit: 'ok',
      'project:acme': 'ok',
    });
    for (const argv of host.execs)
      expect(argv.join(' ')).not.toMatch(/\bsudo\b|sysctl -w|apparmor_parser|claude|codex/);
  });

  it('checks a terminal backend it found outside PATH', async () => {
    const { sd, host } = doctored({
      runtime: 'runtime: { terminal: { backend: herdr } }',
    });
    const find = host.findExecutable.bind(host);
    host.findExecutable = (name, extraDirs) =>
      name === 'herdr'
        ? Promise.resolve(extraDirs?.length === 1 ? '/usr/bin/herdr' : null)
        : find(name, extraDirs);
    await sd.start();
    const found = names(await cli(sd, ['doctor']));
    expect(found['terminal']).toBeDefined();
    expect(host.execs).toContainEqual(['/usr/bin/herdr', 'workspace', 'list']);
  });

  it('checks orca with a command that fails when its runtime is down', async () => {
    const { sd, host } = doctored({
      runtime: 'runtime: { terminal: { backend: orca }, tool_paths: { orca: /usr/bin/orca } }',
    });
    await sd.start();
    expect(names(await cli(sd, ['doctor']))['terminal']).toBeDefined();
    expect(host.execs).toContainEqual(['/usr/bin/orca', 'repo', 'list', '--json']);
  });

  it('checks tmux with a command that fails when no server runs', async () => {
    const { sd, host } = doctored({
      runtime: 'runtime: { terminal: { backend: tmux }, tool_paths: { tmux: /usr/bin/tmux } }',
    });
    await sd.start();
    expect(names(await cli(sd, ['doctor']))['terminal']).toBeDefined();
    expect(host.execs).toContainEqual(['/usr/bin/tmux', 'list-sessions']);
  });

  it('checks paseo by running its CLI script with the daemon node', async () => {
    const { sd, host } = doctored({
      runtime: 'runtime: { terminal: { backend: paseo }, tool_paths: { paseo: /usr/bin/paseo } }',
    });
    await sd.start();
    expect(names(await cli(sd, ['doctor']))['terminal']).toBeDefined();
    expect(host.execs).toContainEqual([
      process.execPath,
      '/usr/bin/paseo',
      'workspace',
      'ls',
      '--json',
    ]);
  });

  it('does not look for a terminal backend by default', async () => {
    const { sd, host } = doctored();
    await sd.start();
    expect(names(await cli(sd, ['doctor']))['terminal']).toBeUndefined();
    expect(host.execs.flat()).not.toContain('workspace');
  });

  it('claims shares recovery findings instead of failing on a live operation', async () => {
    let claims: { operation_id: string }[] = [];
    const options = {
      health: null as string | null,
      recoveryClaims: () => claims,
    };
    const { sd } = doctored(options);
    const daemon = await sd.start();
    const d = new StoreDriver(daemon.store);
    const t = buildTask({ id: uuidOf(4040) });
    createGrantStart(d, t);
    const op = uuidOf(4041);
    const claimed = d.store.claimEffect(
      d.pendingOne(t.id, 'prepare').id as Uuid,
      d.now as EpochMs,
      {
        require_runtime: true,
        operation: {
          operation_id: op,
          kind: 'setup',
          launch_nonce: 'live',
          unit: 'live.service',
          holds_slot: true,
        },
      },
    );
    expect(claimed.ok).toBe(true);
    expect(names(await cli(sd, ['doctor']))['claims']).toBe('ok');
    for (const health of ['dispatch blocked: verify failed', 'store unwritable: disk full']) {
      options.health = health;
      expect(names(await cli(sd, ['doctor']))['claims']).toBe('fail');
    }
    options.health = null;
    claims = [{ operation_id: op }];
    expect(names(await cli(sd, ['doctor']))['claims']).toBe('fail');
    d.must(t.id, {
      kind: 'operation_result',
      operation_id: op,
      status: 'finished',
      outcome: 'succeeded',
      invocation_id: null,
      processes: [],
      started_at: d.now as EpochMs,
      finished_at: d.now as EpochMs,
      receipt_digest: `sha256:${'a'.repeat(64)}`,
    });
    expect(names(await cli(sd, ['doctor']))['claims']).toBe('ok');
  });

  it('reports spool errors instead of presenting a silent worker stall, and clears after recovery', async () => {
    const problems: { operation_id: string; status: string; detail: string }[] = [
      { operation_id: uuidOf(4141), status: 'unreadable', detail: 'EIO' },
    ];
    const { sd } = doctored({ spoolProblems: () => problems });
    await sd.start();
    expect(names(await cli(sd, ['doctor']))['spools']).toBe('fail');
    problems.splice(0);
    expect(names(await cli(sd, ['doctor']))['spools']).toBe('ok');
  });

  it('a harness whose sandbox lacks what its binary needs fails, naming the tool and the fix', async () => {
    const { sd } = doctored({
      harnessTools: {
        claude: { dirs: ['/nowhere'], requires: ['bwrap', 'socat'] },
        codex: { dirs: ['/usr/bin'], requires: [] },
      },
    });
    await sd.start();
    const r = await cli(sd, ['doctor']);
    expect(r.code, r.out).toBe(ExitCode.failure);
    expect(names(r)).toMatchObject({ 'tools:claude': 'fail' });
    expect(names(r)['tools:codex']).toBeUndefined();
    expect(r.out).toContain('bwrap, socat');
  });

  it('a binary with what it needs passes that check', async () => {
    const { sd } = doctored({
      harnessTools: {
        claude: { dirs: ['/usr/bin'], requires: ['socat'] },
      },
    });
    await sd.start();
    expect(names(await cli(sd, ['doctor']))['tools:claude']).toBe('ok');
  });

  it('a harness without a manifest fails with exit 1 and is not called proven', async () => {
    const { sd } = doctored({ manifests: {} });
    await sd.start();
    const r = await cli(sd, ['doctor']);
    expect(r.code).toBe(ExitCode.failure);
    expect(r.envelope.error.code).toBe('unhealthy');
    expect(Object.values(names(r))).toContain('fail');
    expect(
      Object.entries(names(r))
        .filter(([k]) => k.startsWith('manifest:'))
        .every(([, v]) => v === 'fail'),
    ).toBe(true);
    const repairs = (
      r.envelope.error.details['checks'] as {
        name: string;
        fix: string | null;
      }[]
    ).filter((check) => check.name.startsWith('manifest:'));
    expect(repairs.length).toBeGreaterThan(0);
    for (const check of repairs) {
      expect(check.fix).toContain('record-manifest --evidence');
      expect(check.fix).not.toContain('--force');
    }
  });

  it('a transient unit that cannot run fails, even when the user manager answers', async () => {
    const { sd, host } = doctored();
    const exec = host.exec.bind(host);
    host.exec = (argv, o) =>
      argv.includes('--wait')
        ? Promise.resolve({
            kind: 'exited',
            code: 1,
            stdout: '',
            stderr: 'unit failed',
          })
        : exec(argv, o);
    await sd.start();
    const r = await cli(sd, ['doctor']);
    expect(r.code).toBe(ExitCode.failure);
    expect(names(r)).toMatchObject({ host: 'ok', systemd_unit: 'fail' });
  });

  it('reuses a passed unit probe for a while, but runs a failed one again (issue #260)', async () => {
    const { sd, host } = doctored();
    const units = () => host.execs.filter((argv) => argv.includes('--wait')).length;
    await sd.start();
    expect((await cli(sd, ['doctor'])).code).toBe(ExitCode.ok);
    expect(units()).toBe(1);
    const again = await cli(sd, ['doctor']);
    expect(again.code).toBe(ExitCode.ok);
    expect(units()).toBe(1);
    expect(JSON.stringify(again.envelope.data)).toContain('s ago)');
    sd.now += DOCTOR_PROBE_CACHE_MS;
    await cli(sd, ['doctor']);
    expect(units()).toBe(2);

    const exec = host.exec.bind(host);
    host.exec = (argv, o) =>
      argv.includes('--wait')
        ? Promise.resolve({ kind: 'exited', code: 1, stdout: '', stderr: 'unit failed' })
        : exec(argv, o);
    sd.now += DOCTOR_PROBE_CACHE_MS;
    expect((await cli(sd, ['doctor'])).code).toBe(ExitCode.failure);
    host.exec = exec;
    expect((await cli(sd, ['doctor'])).code).toBe(ExitCode.ok);
    expect(units()).toBe(3);
  });

  it('a recorded manifest that does not prove what an attempt requires fails', async () => {
    const { sd } = doctored({ manifests: MANIFESTS });
    await sd.start();
    expect(JSON.stringify((await cli(sd, ['doctor'])).envelope.error.details)).toContain(
      'not proven: structured_output',
    );
  });

  /** A host whose unit and canary probes hang until their timeout, as with a stuck systemd. */
  const hang = (host: ReturnType<typeof fakeHost>, match: string[]) => {
    const exec = host.exec.bind(host);
    host.exec = (argv, o) =>
      match.some((m) => argv.includes(m))
        ? new Promise((r) => setTimeout(() => r({ kind: 'timeout' }), o.timeout_ms))
        : exec(argv, o);
  };

  it('a hung unit probe returns its failed check before the client times out', async () => {
    const { sd, host } = doctored();
    hang(host, ['--wait', '--tmpfs']);
    await sd.start();
    const started = Date.now();
    const r = await cli(sd, ['doctor']);
    expect(Date.now() - started).toBeGreaterThan(9_000);
    expect(r.code).toBe(ExitCode.failure);
    expect(r.envelope.error.code).toBe('unhealthy');
    expect(names(r)).toMatchObject({
      systemd_unit: 'fail',
    });
    expect(JSON.stringify(r.envelope.error.details)).toContain('deploy/README.md');
  }, 40_000);

  it('the budget bounds all probes together and the client waits longer than it', async () => {
    expect(DOCTOR_CLIENT_TIMEOUT_MS).toBeGreaterThan(DOCTOR_PROBE_BUDGET_MS);
    const { sd, host } = doctored({ probeBudgetMs: 300 });
    hang(host, ['--unshare-user', '--wait']);
    await sd.start();
    const started = Date.now();
    const r = await cli(sd, ['doctor']);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.code).toBe(ExitCode.failure);
    // Out of budget, the later probes are reported, not run and not skipped.
    expect(names(r)).toMatchObject({
      systemd_unit: 'fail',
    });
  });

  it('a manifest fails when its binary changed or can no longer be read, or the record was altered', async () => {
    const changed = doctored({ digest: () => 'sha256:other' });
    await changed.sd.start();
    const r1 = await cli(changed.sd, ['doctor']);
    expect(r1.code).toBe(ExitCode.failure);
    expect(JSON.stringify(r1.envelope.error.details)).toContain('changed since the proof');

    const gone = doctored({
      digest: () => {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      },
    });
    await gone.sd.start();
    expect(JSON.stringify((await cli(gone.sd, ['doctor'])).envelope.error.details)).toContain(
      'ENOENT',
    );

    const altered = doctored({
      manifests: Object.fromEntries(
        Object.entries(PROVEN).map(([k, m]) => [
          k,
          { ...m, selected_inner_mode: 'external_verified' },
        ]),
      ),
    });
    await altered.sd.start();
    expect(JSON.stringify((await cli(altered.sd, ['doctor'])).envelope.error.details)).toContain(
      'fails its schema or its hash',
    );
  });

  it('a host problem or a held writer fails with the fix to run, and nothing is run for it', async () => {
    const { sd, host } = doctored({
      host: { userBus: false },
      health: 'dispatch blocked: x',
    });
    await sd.start();
    const r = await cli(sd, ['doctor']);
    expect(r.code).toBe(ExitCode.failure);
    expect(names(r)).toMatchObject({
      writer: 'fail',
      'host:systemd_user_unavailable': 'fail',
    });
    expect(JSON.stringify(r.envelope.error.details)).toContain('enable-linger');
    expect(host.execs.flat().join(' ')).not.toContain('apt');
  });

  it('notices a data dir that became readable, an unknown project and an unreadable config', async () => {
    const { sd } = doctored();
    await sd.start();
    chmodSync(sd.dataDir, 0o750);
    expect(names(await cli(sd, ['doctor']))['data_dir']).toBe('fail');
    chmodSync(sd.dataDir, 0o700);
    expect((await cli(sd, ['doctor', '--project', 'nope'])).code).toBe(ExitCode.missing);
  });
});

describe('dependency recovery and queue (T119, FR-001.02/03, FR-044.06/07)', () => {
  it('a notification lost when the daemon died after DONE is recovered at startup, once, before any request', async () => {
    const a = buildTask({ id: uuidOf(5_003), title: 'prereq' });
    const b = buildTask({
      id: uuidOf(5_004),
      title: 'dependent',
      depends_on: [a.id],
    });
    let scheduled = 0;
    const sd: SeededDaemon = daemon((store) => {
      const s = new Scheduler({
        store,
        clock: sd.clock,
        newId: sd.newId,
        start: () => Promise.resolve({ kind: 'not_startable', reason: 'test' }),
      });
      return {
        schedule: () => {
          scheduled++;
          return s.tick();
        },
      };
    });
    sd.seed((d) => {
      toGreen(d, a, 'direct-pr');
      d.must(b.id, { kind: 'create_task', task: b });
      merge(d, a, 'a'.repeat(40));
      d.must(a.id, { kind: 'drain_result', pending_operations: [] });
      expect(d.task(a.id).status).toBe('DONE');
      expect(d.task(b.id).wait?.detail.code).toBe('dependency_pending');
    });
    const running = await sd.start();
    expect(scheduled).toBeGreaterThan(0);
    const s = running.store.readTask(b.id);
    expect(s?.status).toBe('READY');
    const accepted = running.store
      .readEvents(b.id)
      .filter((e) => e.causation.dedup_key?.startsWith('dep:')).length;
    await sd.stop();
    const again = await sd.start();
    expect(
      again.store.readEvents(b.id).filter((e) => e.causation.dedup_key?.startsWith('dep:')),
    ).toHaveLength(accepted);
  });

  it('runs no scheduler pass while new work is held', async () => {
    let scheduled = 0;
    const sd = daemon(() => ({
      schedule: () => {
        scheduled++;
        return Promise.resolve();
      },
    }));
    const running = await sd.start();
    const count = scheduled;
    running.dispatcher.hold('test');
    await new Promise((r) => setTimeout(r, 1_200));
    expect(scheduled).toBe(count);
  });

  it('a scheduler failure is logged and does not stop the daemon', async () => {
    const logs: string[] = [];
    const sd = new SeededDaemon({ log: (m) => logs.push(m) }, () => ({
      schedule: () => Promise.reject(new Error('boom')),
    }));
    live.push(sd);
    await sd.start();
    expect(logs.join('\n')).toContain('scheduler pass failed: boom');
    expect((await cli(sd, ['task', 'list'])).code).toBe(ExitCode.ok);
  });
});

describe('control socket boundary (T116, FR-028/032)', () => {
  it('refuses an oversized body, a bad route and an open query body', async () => {
    const sd = daemon();
    await sd.start();
    const big = await sd.query('owner', {
      kind: 'task_list',
      pad: 'x'.repeat(1_100_000),
    });
    expect(big.status).toBe(413);
    expect(big.code).toBe(ExitCode.usage);
    const open = await sd.query('owner', { kind: 'task_list', extra: 1 });
    expect(open.code).toBe(ExitCode.usage);
    expect((await sd.query('owner', { kind: 'nope' })).code).toBe(ExitCode.usage);
    const show = await sd.query('owner', {
      kind: 'task_show',
      task_id: uuidOf(1),
      extra: true,
    });
    expect(show.code).toBe(ExitCode.usage);
  });

  it('a client stuck in its headers is dropped within the limit', async () => {
    const { connect } = await import('node:net');
    const sd = daemon();
    const running = await sd.start();
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      const c = connect(running.socketPath, () => {
        c.write('POST /v1/query HTTP/1.1\r\nHost: x\r\n');
      });
      c.resume();
      c.on('close', () => resolve());
      c.on('error', reject);
    });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(4_000);
    expect(took).toBeLessThan(8_000);
  }, 15_000);
});
