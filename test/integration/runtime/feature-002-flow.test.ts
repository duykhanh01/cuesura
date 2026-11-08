import { spawnSync } from 'node:child_process';
import {
  existsSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as spoolIngest from '../../../src/daemon/ingest.ts';
import {
  MAX_CONTENT_FILE_BYTES,
  readStoredContent,
} from '../../../src/adapters/publish-content.ts';
import type { HarnessInput, HarnessOutcome } from '../../../src/adapters/ports.ts';
import { notifyDependents } from '../../../src/application/dependency.ts';
import { observeTask } from '../../../src/daemon/handlers.ts';
import { mergeView } from '../../../src/application/queries.ts';
import { taskBranch } from '../../../src/adapters/git/worktree.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { InvocationUnknown } from '../../../src/runner/invocation.ts';
import { canonicalJson } from '../../../src/shared/canonical-json.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { hashCanonical, hashText } from '../../../src/shared/hash.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import { injectEvents } from '../../../src/store/testing.ts';
import { replay } from '../../../src/engine/evolve.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { CONTENT, flowEnv, type Content } from '../../support/flow-env.ts';
import { recoverOperations } from '../../../src/daemon/startup.ts';
import { taskLogs } from '../../../src/application/logs.ts';
import { EventLogWriter, readRecords, RunDir } from '../../../src/runner/files.ts';
import { runExit } from '../../support/run-exit.ts';

// US1 baseline (T028/T047): real Git worktree and bare remote, fake harnesses and GitHub, Clock driven
// by the test. One task, one branch, one PR, green CI, zero merge requests, then the user's merge.

const { g, setup } = flowEnv('cusr-flow-');
let n = 0;

it('keeps committed history and holds B live output until a corrupt, partially ingested A is repaired', async () => {
  const task = buildTask();
  const f = setup(task, {
    mode: 'direct-pr',
    askFirst: true,
    runs: [CONTENT, CONTENT],
  });
  const original = f.coder.run.bind(f.coder);
  const read = (after: number) =>
    taskLogs(
      { store: f.d.store, dataDir: f.deps.dataDir, redactor: f.deps.redactor },
      {
        grant: {
          actor: 'reader',
          roles: ['read'],
        },
      },
      { kind: 'task_logs', task_id: task.id, after },
    );
  const commit = (operation: string) =>
    spoolIngest.ingestOperationSpool(
      {
        store: f.d.store,
        dataDir: f.deps.dataDir,
        redactor: f.deps.redactor,
        now: () => f.d.now,
        newId: f.newId,
      },
      task.id,
      operation,
    );
  let prior: { files: RunDir; operation: string; good: Buffer } | null = null;
  f.coder.run = async (input, signal) => {
    const files = RunDir.open({
      dataDir: f.deps.dataDir,
      kind: 'runs',
      id: input.attempt_id,
      redactor: f.deps.redactor,
    });
    const writer = EventLogWriter.open(files, input.operation_id);
    if (prior === null) {
      writer.append('progress', { attempt: 'A', i: 1 });
      writer.sync();
      expect(commit(input.operation_id).records).toBe(1);
      writer.append('progress', { attempt: 'A', i: 2 });
      writer.close();
      expect(read(0)).toMatchObject({ ok: true, value: { next_cursor: 2 } });
      files.writeExit(runExit(input.operation_id, f.d.now));
      const good = readFileSync(files.resolve('events.jsonl'));
      const firstLine = good.indexOf(10) + 1;
      writeFileSync(files.resolve('events.jsonl'), good.subarray(0, firstLine));
      appendFileSync(files.resolve('events.jsonl'), 'corrupt second record\n');
      expect(read(0)).toMatchObject({
        ok: true,
        value: {
          next_cursor: 1,
          records: [{ data: { attempt: 'A', i: 1 } }, { gap: { records: 0 } }],
        },
      });
      prior = { files, operation: input.operation_id, good };
      // Reproduce a legacy resolved attempt whose last output never made it into the store.
      return original(input, signal);
    }
    writer.append('progress', { attempt: 'B', i: 1 });
    writer.append('progress', { attempt: 'B', i: 2 });
    writer.sync();
    expect(read(0)).toMatchObject({
      ok: true,
      value: {
        next_cursor: 1,
        records: [{ data: { attempt: 'A', i: 1 } }, { gap: { records: 0 } }],
      },
    });
    expect(read(2)).toMatchObject({
      ok: true,
      value: { next_cursor: 2, records: [{ gap: { records: 0 } }] },
    });
    writeFileSync(prior.files.resolve('events.jsonl'), prior.good);
    expect(commit(prior.operation).status).toBe('ingested');
    expect(read(2)).toMatchObject({
      ok: true,
      value: {
        next_cursor: 4,
        records: [{ data: { attempt: 'B', i: 1 } }, { data: { attempt: 'B', i: 2 } }],
      },
    });
    writer.close();
    files.writeExit(runExit(input.operation_id, f.d.now));
    const batch = readRecords(files, input.operation_id, null, { final: true });
    if (!batch.ok || batch.value.cursor === null) throw new Error('missing B spool');
    return {
      ...(await original(input, signal)),
      ingest: {
        operation_id: input.operation_id,
        cursor: batch.value.cursor,
        records: batch.value.records.length,
        digest: hashCanonical(batch.value.records),
        artifacts: [],
      },
    };
  };
  f.d.must(task.id, { kind: 'create_task', task });
  f.start();
  await f.settle();
  const question = Object.values(f.d.task(task.id).questions).find((q) => q.status === 'open');
  if (question === undefined) throw new Error('missing worker question');
  f.d.must(task.id, {
    kind: 'answer',
    question_id: question.id as Uuid,
    answer: 'UTF-8',
  });
  await settleWithSlot(f.d, f.settle);
  expect(f.coder.calls).toHaveLength(2);
  expect(read(4)).toMatchObject({
    ok: true,
    value: { next_cursor: 4, records: [] },
  });
});

it('turn exhaustion uses timeout handling, preserving the worker session, then raises the rung', async () => {
  const task = buildTask();
  const f = setup(task, { mode: 'direct-pr', resume: true });
  const seen: HarnessInput[] = [];
  f.coder.run = (input) => {
    seen.push(input);
    return Promise.resolve({
      kind: 'failure',
      failure: 'turn_limit',
      detail: 'error_max_turns',
      role: input.role,
      usage: { basis: 'unavailable' },
      session_ref: 'continued-session',
      permission_denials: [],
      invoked: true,
      reset_at: null,
    });
  };
  f.d.must(task.id, { kind: 'create_task', task });
  f.start();
  await f.settle();
  expect(
    f.d.store
      .readEvents(task.id)
      .filter((e) => e.type === 'FailureClassified')
      .map((e) => e.payload['class']),
  ).toEqual(expect.arrayContaining(['timeout', 'timeout']));
  expect(seen[1]?.session).toMatchObject({
    ref: 'continued-session',
    from_attempt_id: seen[0]?.attempt_id,
  });
  // Past its retry the step goes up the ladder instead of asking a person (#247).
  const s = f.d.task(task.id);
  expect(s.wait?.detail.code).not.toBe('timeout');
  expect(s.questions).toEqual({});
  expect(f.d.store.readEvents(task.id).some((e) => e.type === 'RungRaised')).toBe(true);
});

describe('a task that runs out of rungs before any checkpoint (#247, real Git)', () => {
  /** Every coder run hits its turn limit; with `write`, the first one leaves a file behind. */
  const timingOut = (f: ReturnType<typeof setup>, write: boolean) => {
    f.coder.run = (input) => {
      if (write) writeFileSync(join(f.worktree, 'partial.ts'), 'export const partial = 1;\n');
      return Promise.resolve({
        kind: 'failure',
        failure: 'turn_limit',
        detail: 'error_max_turns',
        role: input.role,
        usage: { basis: 'unavailable' },
        session_ref: null,
        permission_denials: [],
        invoked: true,
        reset_at: null,
      });
    };
  };
  const toEnd = async (f: ReturnType<typeof setup>, task: ReturnType<typeof buildTask>) => {
    for (let i = 0; i < 24 && f.d.task(task.id).status !== 'FAILED'; i++) {
      await f.settle();
      const w = f.d.task(task.id).wait;
      if (w?.detail.code === 'execution_slot')
        f.d.store.grantNext(f.d.now as EpochMs, [
          uuidOf(40_000 + i * 4),
          uuidOf(40_001 + i * 4),
          uuidOf(40_002 + i * 4),
          uuidOf(40_003 + i * 4),
        ]);
      if (w?.reason === 'approval')
        f.d.must(task.id, {
          kind: 'approve',
          approval_request_id: w.detail['approval_id'] as Uuid,
        });
    }
  };

  it('commits what the worktree holds and opens it as a draft PR before failing', async () => {
    const task = buildTask();
    const f = setup(task, { mode: 'full-review', writeCode: false });
    timingOut(f, true);
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    await toEnd(f, task);

    const s = f.d.task(task.id);
    expect(s.status).toBe('FAILED');
    expect(s.terminal?.reason).toMatch(/^ladder_exhausted:code \(draft PR acme\/\S+#\d+\)$/);
    expect(s.pr_ref).not.toBeNull();
    expect(s.run.checkpoint).toBeNull();
    expect(f.github.prs).toHaveLength(1);
    expect(f.github.prs[0]).toMatchObject({ draft: true });
    expect(f.github.prs[0]?.title).toMatch(/^\[failed\] /);
    expect(f.github.prs[0]?.body).toContain('Reason: ladder_exhausted:code');
    const head = f.github.prs[0]?.head.sha ?? '';
    expect(git(f.remote, 'show', `${head}:partial.ts`)).toBe('export const partial = 1;');
  });

  /** The daemon that ran the salvage died: its operation is lost and the effect unknown (restart). */
  const loseSalvage = (f: ReturnType<typeof setup>, task: ReturnType<typeof buildTask>) => {
    const e = Object.values(f.d.task(task.id).effects).find(
      (x) => x.kind === 'publish' && x.status === 'started',
    );
    if (e === undefined) throw new Error('no started salvage');
    const op = Object.values(f.d.task(task.id).operations).find((o) => o.effect_id === e.id);
    if (op === undefined) throw new Error('no operation');
    f.d.must(task.id, {
      kind: 'operation_result',
      operation_id: op.id as Uuid,
      status: 'lost',
      outcome: null,
      invocation_id: null,
      processes: [],
      started_at: f.d.now as EpochMs,
      finished_at: f.d.now as EpochMs,
      receipt_digest: `sha256:${'c'.repeat(64)}`,
    });
    f.d.must(task.id, { kind: 'effect_result', effect_id: e.id as Uuid, outcome: 'unknown' });
  };
  /** The restarted daemon can tell a lost local operation is gone. */
  const restarted = (f: ReturnType<typeof setup>) =>
    Object.assign(f.deps, { stopLocal: () => Promise.resolve('not_running' as const) });

  it('a crash between the commit intent and the ref update commits the same work on the rerun', async () => {
    const task = buildTask();
    const f = setup(task, { mode: 'full-review', writeCode: false });
    timingOut(f, true);
    const run = f.deps.git.run.bind(f.deps.git);
    let crashed = false;
    f.deps.git.run = async (req) => {
      if (!crashed && req.args[0] === 'update-ref' && req.args[1]?.startsWith('refs/heads/')) {
        crashed = true;
        // The rerun happens later: a new clock reading must not make another commit.
        f.d.now += 60_000;
        throw new Error('daemon stopped before the ref update');
      }
      return run(req);
    };
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    await toEnd(f, task);
    expect(crashed).toBe(true);
    expect(f.d.task(task.id).status).toBe('RUNNING');
    restarted(f);
    loseSalvage(f, task);
    await toEnd(f, task);

    const s = f.d.task(task.id);
    expect(s.terminal?.reason).toMatch(/^ladder_exhausted:code \(draft PR acme\/\S+#\d+\)$/);
    expect(f.github.prs).toHaveLength(1);
    expect(git(f.remote, 'show', `${f.github.prs[0]?.head.sha ?? ''}:partial.ts`)).toBe(
      'export const partial = 1;',
    );
  });

  it('a PR whose create response was lost is found by its marker and linked', async () => {
    const task = buildTask();
    const f = setup(task, { mode: 'full-review', writeCode: false });
    timingOut(f, true);
    const request = f.github.request.bind(f.github);
    let lost = 0;
    const down = {
      reason: 'unknown' as const,
      status: null,
      detail: 'connection reset',
      retry_after_ms: null,
    };
    f.github.request = async (req) => {
      // The POST lands on GitHub but its answer is lost, and so is the read right after it.
      if (lost === 0 && req.method === 'POST' && req.path.endsWith('/pulls')) {
        lost = 1;
        await request(req);
        return { ok: false, error: down };
      }
      if (lost === 1 && req.method === 'GET') {
        lost = 2;
        return { ok: false, error: down };
      }
      return request(req);
    };
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    restarted(f);
    await toEnd(f, task);

    expect(lost).toBe(2);
    const s = f.d.task(task.id);
    expect(f.github.prs).toHaveLength(1);
    expect(s.pr_ref).toMatch(/#\d+$/);
    expect(s.terminal?.reason).toBe(`ladder_exhausted:code (draft PR ${s.pr_ref ?? ''})`);
  });

  it('with nothing beyond the base, fails without a PR and says so', async () => {
    const task = buildTask();
    const f = setup(task, { mode: 'full-review', writeCode: false });
    timingOut(f, false);
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    await toEnd(f, task);

    const s = f.d.task(task.id);
    expect(s.terminal).toEqual({
      kind: 'FAILED',
      reason: 'ladder_exhausted:code (no draft PR: nothing to publish beyond the base)',
    });
    expect(s.pr_ref).toBeNull();
    expect(f.github.prs).toEqual([]);
  });
});

describe('gates that keep changing the tree (#245, real Git)', () => {
  it('reach the gate fixer from the tree they left, not worktree_changed', async () => {
    const task = buildTask();
    const f = setup(task, {
      mode: 'direct-pr',
      runs: [CONTENT, CONTENT],
      gates: { build: 'true', unit: 'printf x >> generated.txt', lint: 'true', format_fix: 'true' },
    });
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    for (let i = 0; i < 6 && !f.coder.calls.some((c) => c.role === 'fixer'); i++)
      await settleWithSlot(f.d, f.settle);

    expect(f.coder.calls.filter((c) => c.role === 'fixer').length).toBeGreaterThan(0);
    const events = f.d.store.readEvents(task.id);
    expect(
      events.some(
        (e) => e.type === 'TaskWaiting' && e.payload.wait.detail.code === 'worktree_changed',
      ),
    ).toBe(false);
    expect(events.some((e) => e.type === 'WorktreeChangeAccepted')).toBe(true);
  });
});

it('#154: a message interrupts the coder; the next turn resumes its session with the message in context', async () => {
  const task = buildTask();
  const f = setup(task, { mode: 'direct-pr', resume: true, runs: [CONTENT] });
  const original = f.coder.run.bind(f.coder);
  const seen: HarnessInput[] = [];
  f.coder.run = (input, signal) => {
    seen.push(input);
    if (seen.length > 1) return original(input, signal);
    // The message lands while this turn runs; the stop ends it as cancelled, its session kept.
    f.d.must(task.id, { kind: 'message', body: 'MSG-154: reuse the parser in src/parse.ts' });
    return Promise.resolve({
      kind: 'failure',
      failure: 'cancelled',
      detail: 'stopped',
      role: input.role,
      usage: { basis: 'unavailable' },
      session_ref: 'interrupted-session',
      permission_denials: [],
      invoked: true,
      reset_at: null,
    });
  };
  f.d.must(task.id, { kind: 'create_task', task });
  f.start();
  await settleWithSlot(f.d, f.settle);
  expect(seen.length).toBeGreaterThanOrEqual(2);
  expect(seen[0]?.context.text).not.toContain('MSG-154');
  expect(seen[1]?.session).toMatchObject({
    ref: 'interrupted-session',
    from_attempt_id: seen[0]?.attempt_id,
  });
  expect(seen[1]?.context.text).toContain('MSG-154: reuse the parser in src/parse.ts');
  expect(seen[1]?.context.text).toContain('never adds to or changes the acceptance criteria');
  expect(Object.values(f.d.task(task.id).questions)).toEqual([]);
});

it('#215: each review gets the worker reports since the review before, redacted, through the handler', async () => {
  const task = buildTask();
  const f = setup(task, { mode: 'full-review', reviews: 2, runs: [CONTENT, CONTENT] });
  const token = `github_pat_${'A'.repeat(30)}`;
  const reviewerRun = f.codex.run.bind(f.codex);
  f.codex.run = (input, signal) =>
    f.codex.calls.length > 0
      ? reviewerRun(input, signal)
      : (f.codex.calls.push(input),
        Promise.resolve({
          kind: 'result',
          role: 'reviewer',
          usage: { basis: 'unavailable' },
          session_ref: null,
          permission_denials: [],
          raw_digest: hashText('reject'),
          schema_digest: input.schema.digest,
          value: {
            schema_version: 1,
            verdict: 'request_changes',
            summary: 'needs a test',
            findings: [
              { severity: 'major', file: 'search.ts', line: null, message: 'missing test' },
            ],
          },
        }));
  const coderRun = f.coder.run.bind(f.coder);
  f.coder.run = (input, signal) =>
    input.role !== 'fixer'
      ? coderRun(input, signal)
      : (f.coder.calls.push(input),
        Promise.resolve({
          kind: 'result',
          role: 'fixer',
          usage: { basis: 'unavailable' },
          session_ref: null,
          permission_denials: [],
          raw_digest: hashText('fix'),
          schema_digest: input.schema.digest,
          value: {
            schema_version: 1,
            status: 'done',
            summary: `added the missing test in search.test.ts with ${token}`,
            questions: [],
            blocker: null,
          },
        }));
  f.d.must(task.id, { kind: 'create_task', task });
  f.start();
  await settleWithSlot(f.d, f.settle);
  expect(f.codex.calls).toHaveLength(2);
  const [first, second] = f.codex.calls.map((c) => c.context.text);
  expect(first).toContain('## worker_reports\n### coder, step code, attempt 1');
  expect(first).toContain('added search');
  expect(second).toContain('## worker_reports\n### fixer, step fix_review, attempt 1');
  expect(second).toContain('added the missing test in search.test.ts');
  expect(second).not.toMatch(/### coder/);
  expect(second).not.toContain(token);
  expect(JSON.stringify(f.d.task(task.id).attempts)).not.toContain(token);
});

it('#213: the second review resumes the first review session through the handler; the fixer keeps the worker session', async () => {
  const task = buildTask();
  const f = setup(task, {
    mode: 'full-review',
    reviews: 2,
    rejectFirst: true,
    reviewerResume: true,
    resume: true,
    runs: [CONTENT, CONTENT],
  });
  f.d.must(task.id, { kind: 'create_task', task });
  f.start();
  await settleWithSlot(f.d, f.settle);
  expect(f.codex.calls).toHaveLength(2);
  expect(f.codex.calls[0]?.session).toBeNull();
  expect(f.codex.calls[1]?.session).toEqual({
    ref: 'review-1',
    from_attempt_id: f.codex.calls[0]?.attempt_id,
  });
  expect(f.coder.calls[1]?.session).toMatchObject({ ref: 'sess-1' });
  // A resumed review still gets a packet built for its own round.
  expect(f.codex.calls[1]?.context.digest).not.toBe(f.codex.calls[0]?.context.digest);
  expect(f.d.task(task.id).attempts[f.codex.calls[1]?.attempt_id ?? '']?.session_ref).toBe(
    'review-2',
  );
});

it('an expired harness login stops at once instead of spending retries and visits (#97)', async () => {
  const task = buildTask();
  const f = setup(task, { mode: 'direct-pr' });
  let runs = 0;
  f.coder.run = (input) => {
    runs++;
    return Promise.resolve({
      kind: 'failure',
      failure: 'auth',
      detail: 'success: Failed to authenticate: OAuth session expired and could not be refreshed',
      role: input.role,
      usage: { basis: 'unavailable' },
      session_ref: null,
      permission_denials: [],
      invoked: true,
      reset_at: null,
    });
  };
  f.d.must(task.id, { kind: 'create_task', task });
  f.start();
  await f.settle();
  expect(runs).toBe(1);
  const s = f.d.task(task.id);
  expect(s.wait).toMatchObject({
    reason: 'policy',
    detail: { code: 'harness_auth', step: 'code', harness: 'claude' },
  });
  expect(s.step_visits['code']).toBe(1);
});

it('final handler ingestion adds only the tail after live output, with no duplicate records or gaps', async () => {
  const task = buildTask();
  const f = setup(task, { mode: 'direct-pr' });
  const dataDir = f.deps.dataDir;
  const original = f.coder.run.bind(f.coder);
  f.coder.run = async (input, signal) => {
    const run = RunDir.open({
      dataDir,
      kind: 'runs',
      id: input.attempt_id,
      redactor: f.deps.redactor,
    });
    const log = EventLogWriter.open(run, input.operation_id);
    for (let i = 0; i < 3; i++) log.append('progress', { i });
    log.sync();
    const before = f.d.task(task.id).version;
    const eventCount = f.d.store.readEvents(task.id).length;
    const live = (after = 0) =>
      taskLogs(
        { store: f.d.store, dataDir, redactor: f.deps.redactor },
        {
          grant: {
            actor: 'reader',
            roles: ['read'],
          },
        },
        { kind: 'task_logs', task_id: task.id, after },
      );
    expect(live()).toMatchObject({
      ok: true,
      value: {
        next_cursor: 3,
        records: [{ data: { i: 0 } }, { data: { i: 1 } }, { data: { i: 2 } }],
      },
    });
    await recoverOperations({
      store: f.d.store,
      dataDir,
      redactor: f.deps.redactor,
      now: () => f.d.now,
      newId: f.deps.newId,
      inFlight: () => true,
      inspect: () => {
        throw new Error('live handler must not be reconciled');
      },
    });
    expect(f.d.task(task.id).version).toBe(before);
    expect(f.d.store.readEvents(task.id)).toHaveLength(eventCount);
    for (let i = 3; i < 5; i++) log.append('progress', { i });
    log.sync();
    expect(live(3)).toMatchObject({
      ok: true,
      value: {
        next_cursor: 5,
        records: [{ data: { i: 3 } }, { data: { i: 4 } }],
      },
    });
    log.close();
    run.writeExit(runExit(input.operation_id, f.d.now));
    const batch = readRecords(run, input.operation_id, null, { final: true });
    if (!batch.ok || batch.value.cursor === null) throw new Error('missing log batch');
    return {
      ...(await original(input, signal)),
      ingest: {
        operation_id: input.operation_id,
        cursor: batch.value.cursor,
        records: batch.value.records.length,
        digest: hashCanonical(batch.value.records),
        artifacts: [],
      },
    };
  };
  f.d.must(task.id, { kind: 'create_task', task });
  f.start();
  await f.settle();
  const logs = taskLogs(
    { store: f.d.store, dataDir, redactor: f.deps.redactor },
    {
      grant: {
        actor: 'reader',
        roles: ['read'],
      },
    },
    { kind: 'task_logs', task_id: task.id },
  );
  expect(logs.ok).toBe(true);
  if (logs.ok)
    expect(logs.value).toMatchObject({
      next_cursor: 5,
      records: Array.from({ length: 5 }, (_, i) => ({ data: { i } })),
    });
});

it.each(['unreadable', 'rejected', 'write_failed', 'no_run_dir'] as const)(
  'a final spool %s produces an unknown receipt/result; only write failure latches',
  async (status) => {
    const task = buildTask();
    const f = setup(task, { mode: 'direct-pr' });
    const latch = vi.fn();
    Object.assign(f.deps, { latch });
    const original = f.coder.run.bind(f.coder);
    f.coder.run = async (input, signal) => ({
      ...(await original(input, signal)),
      ingest: {
        operation_id: input.operation_id,
        cursor: {
          generation: 0,
          segment: 0,
          byte_offset: 1,
          last_record_seq: 1,
        },
        records: 1,
        digest: hashCanonical([]),
        artifacts: [],
      },
    });
    const ingest = vi
      .spyOn(spoolIngest, 'ingestOperationSpool')
      .mockImplementation((_deps, taskId, operationId) => ({
        task_id: taskId,
        operation_id: operationId,
        status,
        records: 0,
        torn: 0,
        acked: [],
        detail: 'injected spool fault',
      }));
    try {
      f.d.must(task.id, { kind: 'create_task', task });
      f.start();
      await f.tick();
      await f.tick();
      const s = f.d.task(task.id);
      const worker = Object.values(s.effects).find((e) => e.kind === 'start_agent');
      expect(worker?.status).toBe('unknown');
      expect(Object.values(s.operations).find((o) => o.effect_id === worker?.id)?.status).toBe(
        'unknown',
      );
      expect(latch).toHaveBeenCalledTimes(status === 'write_failed' ? 1 : 0);
    } finally {
      ingest.mockRestore();
    }
  },
);

const types = (d: StoreDriver, t: CanonicalTask) => d.store.readEvents(t.id).map((e) => e.type);
const MARKER = /<!-- cusr:task=\S+ revision=1 op=\S+ -->\n$/;

describe.each(['full-review', 'direct-pr'] as const)(
  'feature 002 flow in %s: task to green PR, then the user merges (US1)',
  (mode) => {
    it('one worktree, branch and PR from the confirmed selection; checkpoint commit with the worker message; DONE once after the merge', async () => {
      const task = buildTask();
      const child = buildTask({
        id: uuidOf(2),
        source_key: 'cli:child',
        depends_on: [task.id],
      });
      const template = '## Summary\n\n## Tests\n';
      const { d, deps, github, remote, start, settle, codex, coder, worktree } = setup(task, {
        mode,
        template,
      });
      d.must(task.id, { kind: 'create_task', task });
      d.must(child.id, { kind: 'create_task', task: child });
      start();
      await settle();

      const s = d.task(task.id);
      expect(s).toMatchObject({
        status: 'WAITING',
        wait: {
          reason: 'approval',
          detail: { code: 'merge', mode: 'external_confirmation' },
        },
      });
      expect(coder.remaining('coder')).toBe(0);
      // The worker saw the frozen template and where to write its content.
      expect(coder.calls[0]?.context.text).toContain('## Summary');
      // The prompt frozen for the role reached the agent, and so did the rule that Cuesura commits.
      expect(coder.calls[0]?.context.text).toContain('## prompt:prompts/coder.md');
      expect(coder.calls[0]?.context.text).toContain('## worker_rules');
      expect(coder.calls[0]?.view).toEqual({
        project: s.project,
        title: `coder: ${s.task.title}`,
      });
      // gates → checkpoint commit made with the worker's message; publish pushed exactly that commit.
      const cp = s.run.checkpoint;
      expect(cp).toMatchObject({ revision: 1, committed: true });
      expect(s.head_sha).toBe(cp?.sha);
      expect(g.sh(worktree, 'log', '-1', '--format=%B', cp?.sha ?? '')).toBe(
        CONTENT.commit_message,
      );
      const branches = g.sh(
        remote,
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/heads/cusr/',
      );
      expect(branches.split('\n')).toHaveLength(1);
      expect(g.sh(remote, 'rev-parse', branches)).toBe(cp?.sha);
      expect(g.sh(worktree, 'show', `${cp?.sha ?? ''}:search.ts`)).toContain('search');
      if (mode === 'full-review') {
        // The reviewer read the fixed base..checkpoint diff and the PR content, and approved that input.
        expect(codex.remaining('reviewer')).toBe(0);
        expect(codex.calls[0]?.context.text).toContain(CONTENT.pr_title);
        expect(codex.calls[0]?.context.text).toContain(`..${cp?.sha ?? ''}`);
        expect(s.run.reviews).toMatchObject([{ verdict: 'approve', sha: cp?.sha }]);
        // The PR opened as a draft; the verdict was posted on it as one COMMENT review, then it turned
        // ready, and CI was read only after that.
        const pr = github.prs[0];
        expect(pr?.draft).toBe(false);
        expect(pr?.reviews).toHaveLength(1);
        expect(pr?.reviews?.[0]).toMatchObject({
          event: 'COMMENT',
          commit_id: cp?.sha,
        });
        expect(pr?.reviews?.[0]?.comments).toBeUndefined();
        expect(pr?.reviews?.[0]?.body).toContain('Review round 1: Approved');
        expect(pr?.reviews?.[0]?.body).toContain(
          `<!-- cusr:review task=${task.id} attempt=${s.run.reviews[0]?.attempt_id ?? ''} -->`,
        );
        const calls = github.calls;
        expect(calls.indexOf(`POST repos/${github.repo}/pulls`)).toBeLessThan(
          calls.indexOf(`POST repos/${github.repo}/pulls/7/reviews`),
        );
        expect(calls.indexOf(`POST repos/${github.repo}/pulls/7/reviews`)).toBeLessThan(
          calls.indexOf('POST graphql'),
        );
        expect(calls.indexOf('POST graphql')).toBeLessThan(
          calls.findIndex((c) => c.endsWith('/check-runs')),
        );
        expect(s.run.pr_ready_at).toBe(Date.parse('2026-10-29T11:00:00Z'));
      } else {
        // direct-pr: no reviewer call, no approval made up on its behalf.
        expect(codex.calls).toEqual([]);
        expect(types(d, task)).not.toContain('ReviewVerdictRecorded');
        expect(types(d, task)).not.toContain('ReviewReused');
        // Nothing turns it ready later, so it opens ready and gets no review comment.
        expect(github.prs[0]?.draft ?? false).toBe(false);
        expect(github.prs[0]?.reviews ?? []).toEqual([]);
        expect(github.calls).not.toContain('POST graphql');
      }
      // One PR with the worker's title/body and one canonical marker block at the end; no merge request.
      expect(github.prs).toHaveLength(1);
      expect(github.prs[0]).toMatchObject({
        title: CONTENT.pr_title,
        head: { sha: cp?.sha },
      });
      expect(github.prs[0]?.body.startsWith(CONTENT.pr_body)).toBe(true);
      expect(github.prs[0]?.body).toMatch(MARKER);
      expect(github.prs[0]?.body.match(/<!-- cusr:/g)).toHaveLength(1);
      expect(github.calls.filter((c) => c.includes('/merge') && !c.startsWith('GET'))).toEqual([]);
      expect(Object.values(s.effects).filter((e) => e.kind === 'merge')).toEqual([]);
      expect(types(d, task)).not.toContain('ApprovalRequested');
      // Waiting for the merge keeps the slot reserved (FR-044.02).
      expect(d.store.readSlots()).toMatchObject([{ holder_task_id: task.id }]);
      expect(d.store.readSlots()[0]?.reserved_at).toBeTypeOf('number');
      expect(d.task(child.id).status).toBe('PENDING');

      // The user merges on GitHub; the merged head is the checked one, verified under this mode.
      github.merge(7, 'e'.repeat(40));
      const seen = await observeTask(deps, task.id, 'obs:1');
      for (const t of seen.extra) d.must(task.id, t);
      const done = d.task(task.id);
      expect(done).toMatchObject({
        status: 'DONE',
        completion: {
          unverified: null,
          proof: {
            merged_head_sha: cp?.sha,
            checked_head_sha: cp?.sha,
            merge_commit_sha: 'e'.repeat(40),
          },
        },
      });
      expect(types(d, task).filter((x) => x === 'TaskCompleted')).toHaveLength(1);
      notifyDependents(d.store, d.now);
      expect(d.task(child.id).status).toBe('READY');
    });

    it('a PR retargeted to an unprotected branch with green checks is not green: it waits as target_mismatch until retargeted back (FR-041.05)', async () => {
      const task = buildTask();
      const { d, github, start, settle } = setup(task, { mode });
      // Right after the PR is created, someone retargets it; head and (green) checks stay the same.
      const request = github.request.bind(github);
      github.request = async (req) => {
        const r = await request(req);
        if (req.method === 'POST' && req.path === `repos/${github.repo}/pulls`)
          for (const p of github.prs) p.base = 'unprotected';
        return r;
      };
      d.must(task.id, { kind: 'create_task', task });
      start();
      await settle();
      const s = d.task(task.id);
      expect(s).toMatchObject({
        status: 'WAITING',
        wait: {
          reason: 'policy',
          detail: {
            code: 'target_mismatch',
            expected: task.base_branch,
            observed: 'unprotected',
          },
        },
      });
      expect(types(d, task)).not.toContain('CiResultRecorded');
      // Nothing of the other branch was read.
      expect(github.calls.filter((c) => c.includes('unprotected'))).toEqual([]);

      // Retargeted back: the poll timer re-observes and the CI wait goes on to green under the snapshot target.
      for (const p of github.prs) p.base = task.base_branch;
      d.now += 60_000;
      d.fire();
      await settle();
      expect(d.task(task.id)).toMatchObject({
        status: 'WAITING',
        wait: {
          reason: 'approval',
          detail: { code: 'merge', mode: 'external_confirmation' },
        },
      });
    });

    it('a PR retargeted and merged into another branch before it is observed waits as target_mismatch, never DONE (FR-040.12)', async () => {
      const task = buildTask();
      const { d, deps, github, start, settle } = setup(task, { mode });
      const request = github.request.bind(github);
      github.request = async (req) => {
        const r = await request(req);
        if (req.method === 'POST' && req.path === `repos/${github.repo}/pulls`) {
          for (const p of github.prs) p.base = 'other';
          github.merge(7, 'e'.repeat(40));
        }
        return r;
      };
      d.must(task.id, { kind: 'create_task', task });
      start();
      await settle();
      const s = d.task(task.id);
      expect(s).toMatchObject({
        status: 'WAITING',
        wait: {
          reason: 'policy',
          resume_when: ['amend'],
          exit_paths: ['cancel'],
          detail: {
            code: 'target_mismatch',
            expected: task.base_branch,
            observed: 'other',
            merged: true,
          },
        },
      });
      expect(s.completion).toBeNull();
      expect(s.observation?.last?.status).toBe('unknown');
      expect(types(d, task)).not.toContain('CiResultRecorded');
      expect(
        Object.values(s.timers).filter((t) => t.status === 'armed' && t.kind === 'ci_poll'),
      ).toEqual([]);
      // A later observation still reports the mismatch, never a merge proof for the task's target.
      const again = await observeTask(deps, task.id, 'obs:2');
      expect(again.extra).toMatchObject([
        { kind: 'observation_result', target: { ref: 'other', merged: true } },
      ]);
      expect(again.extra.map((f) => f.kind)).not.toContain('external_completion');
      expect(again.outcome).toMatchObject({
        outcome: 'succeeded',
        data: { target_ref: 'other', target_merged: true },
      });
    });

    it.each(['squash', 'merge', 'rebase'] as const)(
      'T139 M08: frozen %s and worker message survive a manual merge whose method is unknown',
      async (method) => {
        const task = buildTask();
        const { d, deps, github, start, settle } = setup(task, {
          mode,
          merge_method: method,
        });
        d.must(task.id, { kind: 'create_task', task });
        start();
        await settle();
        const s = d.task(task.id);
        expect(s.wait).toMatchObject({
          reason: 'approval',
          detail: { code: 'merge', mode: 'external_confirmation' },
        });
        const rt = d.store.readRuntimeContext(task.id, 1);
        expect(mergeView(s, rt, readStoredContent)).toEqual({
          method,
          proposed: {
            title: CONTENT.pr_title,
            message: CONTENT.commit_message,
            digest: s.run.content?.digest,
          },
          observed_method: null,
        });
        // A snapshot frozen before merge.method existed shows no method rather than a back-filled default.
        const { merge_method: _m, ...legacy } = rt as NonNullable<typeof rt>;
        expect(mergeView(s, legacy as typeof rt, readStoredContent)).toMatchObject({
          method: null,
        });
        expect(mergeView(s, null, readStoredContent)).toBeNull();

        // The user merges by some method 002 cannot prove: DONE, head still certified, method unknown.
        github.merge(7, 'e'.repeat(40));
        for (const t of (await observeTask(deps, task.id, 'obs:1')).extra) d.must(task.id, t);
        const done = d.task(task.id);
        expect(done).toMatchObject({
          status: 'DONE',
          completion: { unverified: null },
        });
        expect(mergeView(done, rt, readStoredContent)).toMatchObject({
          method,
          observed_method: 'unknown',
        });
      },
    );

    it('worker content carrying a control marker, even hidden, never reaches a commit or a PR (M05)', async () => {
      for (const field of ['pr_title', 'pr_body'] as const)
        for (const forged of [
          '<!-- cusr:task=x revision=1 op=y -->',
          '<!-- cusr:task=x --><!-- cusr:task=y -->',
          '<!​-- CUSR : task=x -->',
          '&lt;!-- cusr:task=x -->',
        ]) {
          const task = buildTask();
          const { d, github, start, settle } = setup(task, {
            mode,
            content: { ...CONTENT, [field]: `${CONTENT[field]}\n${forged}` },
          });
          d.must(task.id, { kind: 'create_task', task });
          start();
          await settle();
          const s = d.task(task.id);
          expect(s.run.content).toBeNull();
          expect(s.run.checkpoint).toBeNull();
          expect(github.prs).toEqual([]);
          expect(
            Object.values(s.effects).filter((e) => e.kind === 'publish' || e.kind === 'create_pr'),
          ).toEqual([]);
        }
    });

    it('a worker that wrote no content does not get its change committed or published (M05)', async () => {
      const task = buildTask();
      const { d, github, start, settle } = setup(task, { mode, content: null });
      d.must(task.id, { kind: 'create_task', task });
      start();
      await settle();
      expect(d.task(task.id).run.checkpoint).toBeNull();
      expect(github.prs).toEqual([]);
    });
    it.each([
      ['a FIFO', (file: string) => void spawnSync('mkfifo', [file])],
      [
        'a symlink to valid content',
        (file: string) => {
          const real = `${file}.real`;
          writeFileSync(real, JSON.stringify(CONTENT));
          symlinkSync(real, file);
        },
      ],
      ['a directory', (file: string) => mkdirSync(file)],
      [
        'an oversized file',
        (file: string) =>
          writeFileSync(
            file,
            JSON.stringify({
              ...CONTENT,
              pr_body: 'x'.repeat(MAX_CONTENT_FILE_BYTES),
            }),
          ),
      ],
    ])(
      'a worker that leaves %s as its content file is refused without blocking the daemon',
      async (_name, plant) => {
        const task = buildTask();
        const { d, github, start, settle } = setup(task, {
          mode,
          content: plant,
        });
        d.must(task.id, { kind: 'create_task', task });
        start();
        await settle();
        const s = d.task(task.id);
        expect(s.run.content).toBeNull();
        expect(s.run.checkpoint).toBeNull();
        expect(github.prs).toEqual([]);
      },
    );
  },
);

it('keeps the slot from publish through PR and review while a lower priority task waits (#203, FR-044.01)', async () => {
  const task = buildTask({ priority: 60 });
  const other = buildTask({ id: uuidOf(2), source_key: 'cli:other', priority: 50 });
  const { d, start, settle } = setup(task, { mode: 'full-review' });
  d.must(task.id, { kind: 'create_task', task });
  d.must(other.id, { kind: 'create_task', task: other });
  d.must(other.id, { kind: 'request_execution' });
  start();
  await settle();

  expect(d.task(task.id).wait).toMatchObject({ reason: 'approval', detail: { code: 'merge' } });
  const events = d.store.readEvents(task.id);
  const at = (type: string) => events.findIndex((e) => e.type === type);
  // One grant for the whole run: no release at a step boundary, so no second trip through the queue.
  expect(events.filter((e) => e.type === 'ExecutionGranted')).toHaveLength(1);
  expect(
    events.some((e) => e.type === 'TaskWaiting' && e.payload.wait.detail.code === 'execution_slot'),
  ).toBe(false);
  // Waiting for the merge keeps the slot as a reservation, taken only after the review (#206).
  expect(at('ExecutionReleased')).toBe(-1);
  expect(at('ExecutionReserved')).toBeGreaterThan(at('ReviewVerdictRecorded'));
  expect(d.store.readSlots()).toMatchObject([
    { holder_task_id: task.id, reserved_at: expect.any(Number) as number },
  ]);
  expect(d.task(other.id).execution.request).not.toBeNull();
});

describe('project setup in prepare', () => {
  const prepareResult = (f: ReturnType<typeof setup>, id: Uuid): unknown => {
    const effect = Object.values(f.d.task(id).effects).find((e) => e.kind === 'prepare');
    const done = f.d.store
      .readEvents(id)
      .find((e) => e.type === 'EffectCompleted' && e.payload['effect_id'] === effect?.id);
    return (done?.payload as Record<string, unknown> | undefined)?.['result'];
  };

  it('runs in order before the worker, and what it leaves is where the task starts', async () => {
    const task = buildTask();
    const f = setup(task, {
      mode: 'direct-pr',
      setup_commands: ['echo a > setup-a', 'cat setup-a > setup-b'],
    });
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    await f.settle();
    expect(readFileSync(join(f.worktree, 'setup-b'), 'utf8')).toBe('a\n');
    expect(f.coder.calls).toHaveLength(1);
    const s = f.d.task(task.id);
    expect(prepareResult(f, task.id)).toMatchObject({
      setup: { ran: true, passed: true },
    });
    // The worker did not see setup's files as a change made by someone else.
    expect(s.wait?.detail.code).toBe('merge');
  });

  it('a command over its wall time retries once, then asks a person: no infra backoff', async () => {
    const task = buildTask();
    const f = setup(task, {
      mode: 'direct-pr',
      setup_commands: ['sleep 30'],
      command_wall_ms: 200,
    });
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    await f.settle();
    const events = f.d.store.readEvents(task.id);
    expect(
      events.filter((e) => e.type === 'FailureClassified').map((e) => e.payload['class']),
    ).toEqual(['timeout', 'timeout']);
    const s = f.d.task(task.id);
    expect(s.status).toBe('WAITING');
    expect(s.wait?.detail).toMatchObject({ code: 'timeout' });
    expect(f.coder.calls).toEqual([]);
    expect(prepareResult(f, task.id)).toMatchObject({
      failure_class: 'timeout',
      message: expect.stringContaining('setup:setup-1:timeout') as string,
    });
  });

  it('a failing command stops the rest and no worker starts; the failure names it', async () => {
    const task = buildTask();
    const f = setup(task, {
      mode: 'direct-pr',
      setup_commands: ['echo boom >&2; exit 7', 'echo never > setup-never'],
    });
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    await f.tick();
    expect(f.coder.calls).toEqual([]);
    expect(existsSync(join(f.worktree, 'setup-never'))).toBe(false);
    const failure = f.d.store.readEvents(task.id).find((e) => e.type === 'FailureClassified');
    expect(failure?.payload).toMatchObject({ class: 'infra' });
    // A command that exits with an error takes the infra backoff, not the one timeout retry.
    expect(f.d.task(task.id).wait?.detail.code).toBe('infra_backoff');
    expect(prepareResult(f, task.id)).toMatchObject({
      failure_class: 'infra',
      message: expect.stringContaining('setup_failed: setup:setup-1:exit_7') as string,
    });
  });
});

it('T139 M03: missing reviewer diff never launches or consumes a reviewer run', async () => {
  const task = buildTask();
  const f = setup(task, { mode: 'full-review', writeCode: false });
  f.d.must(task.id, { kind: 'create_task', task });
  f.start();
  await f.settle();
  expect(f.codex.calls).toEqual([]);
  expect(f.coder.calls).toHaveLength(1);
  expect(f.d.task(task.id).budget.agent_runs).toMatchObject({
    used: 1,
    reserved: 0,
  });
  // The review comes after the PR: it stays a draft, with no review on it.
  expect(f.github.prs).toMatchObject([{ draft: true }]);
  expect(f.github.prs[0]?.reviews ?? []).toEqual([]);
});

describe('a fix round that left the reviewed files alone (#168, real Git)', () => {
  const rejectOn = (file: string) => ({
    schema_version: 1,
    verdict: 'request_changes',
    summary: 'one blocking finding',
    findings: [{ severity: 'major', file, line: 1, message: 'wrong behaviour' }],
  });
  const approve = { schema_version: 1, verdict: 'approve', summary: 'ok', findings: [] };
  const run = async (file: string) => {
    const task = buildTask();
    const f = setup(task, {
      mode: 'full-review',
      runs: [CONTENT, FIXED],
      verdicts: [rejectOn(file), approve],
    });
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    await settleWithSlot(f.d, f.settle);
    return { ...f, task };
  };

  it('sends the fixer back with a note before a second review when it did not touch the finding file', async () => {
    // The fake fixer only edits search.ts.
    const { d, codex, coder, task } = await run('src/other.ts');
    expect(coder.calls.length).toBeGreaterThan(2);
    expect(codex.calls).toHaveLength(1);
    const q = Object.values(d.task(task.id).questions)[0];
    expect(q).toMatchObject({ status: 'answered', answered_by: 'engine:auto' });
    expect(q?.body).toContain('src/other.ts');
    expect(d.task(task.id).wait?.detail.code).not.toBe('fix_no_src_change');
  });

  it('goes on to the second review when the fixer touched it', async () => {
    const { d, codex, task } = await run('search.ts');
    expect(codex.calls).toHaveLength(2);
    expect(d.task(task.id).wait).toMatchObject({ detail: { code: 'merge' } });
  });
});

async function settleWithSlot(d: StoreDriver, settle: () => Promise<void>): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await settle();
    if (
      d.task(d.store.taskIdsByStatus(['WAITING', 'RUNNING'])[0] as never)?.wait?.detail.code !==
      'execution_slot'
    )
      return;
    d.store.grantNext(d.now as EpochMs, [
      uuidOf(30_000 + i * 4),
      uuidOf(30_001 + i * 4),
      uuidOf(30_002 + i * 4),
      uuidOf(30_003 + i * 4),
    ]);
  }
}

it('a reviewer prompt too large for the context ends the task: no call, no run consumed, no question (#247)', async () => {
  const task = buildTask();
  const f = setup(task, {
    mode: 'full-review',
    reviewerPrompt: 'x'.repeat(200 * 1024),
  });
  f.d.must(task.id, { kind: 'create_task', task });
  f.start();
  await f.settle();
  expect(f.codex.calls).toEqual([]);
  const s = f.d.task(task.id);
  expect(s.terminal).toEqual({ kind: 'FAILED', reason: 'context_budget:review' });
  expect(s.questions).toEqual({});
  expect(s.budget.agent_runs).toMatchObject({ used: 1, reserved: 0 });
});

describe('worktree changed by someone else before the worker (T072, real Git)', () => {
  it('the worker does not start on a changed worktree; recheck takes the change as the person’s and the flow goes on', async () => {
    const task = buildTask();
    const { d, start, tick, settle, coder, worktree } = setup(task, {
      mode: 'direct-pr',
    });
    d.must(task.id, { kind: 'create_task', task });
    start();
    expect(await tick()).toBe(1);
    const prepared = d.task(task.id).run.worktree_tree;
    expect(prepared).toMatch(/^[0-9a-f]{40}$/);

    // A person edits the task worktree before the coder starts.
    writeFileSync(join(worktree, 'notes.md'), 'mine\n');
    await settle();
    const s = d.task(task.id);
    expect(s.wait?.detail).toMatchObject({
      code: 'worktree_changed',
      known: prepared,
    });
    expect(coder.calls).toHaveLength(0);
    expect(s.run.worktree_tree).toBe(prepared);

    d.must(task.id, { kind: 'recheck', target: 'worktree' });
    const accepted = d.store.readEvents(task.id).find((e) => e.type === 'WorktreeChangeAccepted');
    expect(accepted?.payload).toMatchObject({
      previous: prepared,
      tree: s.wait?.detail['observed'],
    });
    // Back at once on the slot it kept reserved while it waited (FR-044.02).
    expect(d.task(task.id).status).toBe('RUNNING');
    await settle();
    expect(coder.calls).toHaveLength(1);
    expect(d.task(task.id).wait?.detail.code).toBe('merge');
  });
});

describe('remote drift while the reviewer reads A (T137, H01/H03, real Git)', () => {
  it('B pushed to the task branch during the review: the PR stays a draft, the CI wait records the drift, B is kept', async () => {
    const task = buildTask();
    let pushedB: string | null = null;
    const { d, github, remote, start, settle } = setup(task, {
      mode: 'full-review',
      duringReview: (rem) => {
        // Someone pushes B on top of the published A to the task branch while A is being reviewed.
        const other = `${rem}.other${n++}`;
        const branch = taskBranch(task.id, task.title);
        g.sh(g.base, 'clone', '-q', '-b', branch, rem, other);
        writeFileSync(join(other, 'b.txt'), 'b\n');
        g.sh(other, 'add', 'b.txt');
        g.sh(other, 'commit', '-qm', 'b');
        pushedB = g.sh(other, 'rev-parse', 'HEAD');
        g.sh(other, 'push', '-q', 'origin', `HEAD:refs/heads/${taskBranch(task.id, task.title)}`);
      },
    });
    d.must(task.id, { kind: 'create_task', task });
    start();
    await settle();
    const s = d.task(task.id);
    const a = s.run.checkpoint?.sha;
    // A was published and reviewed; the approval is A's. The PR head is B, so it is not turned ready, and
    // the CI wait observes B and records the drift.
    expect(s.head_sha).toBe(a);
    expect(s.run.reviews).toMatchObject([{ verdict: 'approve', sha: a }]);
    expect(s).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'policy',
        detail: { code: 'head_changed', observed: pushedB },
      },
    });
    expect(s.run.head_drift).toMatchObject({ expected: a, observed: pushedB });
    expect(g.sh(remote, 'rev-parse', `refs/heads/${taskBranch(task.id, task.title)}`)).toBe(
      pushedB,
    );
    expect(github.prs).toMatchObject([{ draft: true }]);
    expect(types(d, task)).not.toContain('CiResultRecorded');
  });
});

// T064 (US2.3, US1.7, M04/M05/M06/M07): a CI failure on the published head goes through the repair loop
// on the same worktree, gates → checkpoint commit → (review) → fast-forward push of the new commit, the
// same PR gets the newer title/body, and only CI of the new head makes it green. Resume is decided with
// the fake session port; that is not evidence of a real harness resume (T138).
const FIXED: Content = {
  commit_message: 'Handle empty query\n\nCI test failed on an empty query.',
  pr_title: 'Add name search (empty query)',
  pr_body: '## Summary\nSearch by name, empty query handled.\n\n## Tests\nunit',
};

describe.each(['full-review', 'direct-pr'] as const)(
  'feature 002 repair flow in %s (T064)',
  (mode) => {
    it.each([true, false])(
      'CI code failure → fix on the same worktree → same PR updated → green on the new head (resume proven: %s)',
      async (resume) => {
        const task = buildTask();
        const { d, deps, github, remote, start, settle, codex, coder, worktree } = setup(task, {
          mode,
          reviews: 2,
          runs: [CONTENT, FIXED],
          resume,
          checks: [{ build: 'success', test: 'failure' }],
          ci_rules: [{ match: { check: 'test' }, class: 'code' }],
        });
        d.must(task.id, { kind: 'create_task', task });
        start();
        await settleWithSlot(d, settle);
        const s = d.task(task.id);
        expect(s).toMatchObject({
          status: 'WAITING',
          wait: { reason: 'approval', detail: { code: 'merge' } },
        });
        expect(coder.calls).toHaveLength(2);
        const [first, second] = [
          s.evidence.publishes[0]?.head_sha,
          s.evidence.publishes[1]?.head_sha,
        ];
        expect(first).toBeDefined();
        expect(second).toBe(s.run.checkpoint?.sha);
        expect(second).not.toBe(first);
        // Fast-forward only: the first head is an ancestor of the second; one branch, one PR.
        g.sh(worktree, 'merge-base', '--is-ancestor', first ?? '', second ?? '');
        const branches = g.sh(
          remote,
          'for-each-ref',
          '--format=%(refname:short)',
          'refs/heads/cusr/',
        );
        expect(branches.split('\n')).toHaveLength(1);
        expect(g.sh(remote, 'rev-parse', branches)).toBe(second);
        expect(g.sh(worktree, 'log', '-1', '--format=%B', second ?? '')).toBe(FIXED.commit_message);
        expect(github.prs).toHaveLength(1);
        expect(github.calls.filter((c) => c === `POST repos/${github.repo}/pulls`)).toHaveLength(1);
        expect(github.calls.filter((c) => c.startsWith('PATCH '))).toHaveLength(1);
        expect(github.prs[0]).toMatchObject({
          title: FIXED.pr_title,
          head: { sha: second },
        });
        expect(github.prs[0]?.body.startsWith(FIXED.pr_body)).toBe(true);
        expect(github.prs[0]?.body.match(/<!-- cusr:/g)).toHaveLength(1);
        // The repair context carried the failing CI check of the first head and the reconciled state.
        const ctx = coder.calls[1]?.context.text ?? '';
        expect(ctx).toContain('test');
        expect(ctx).toContain(first ?? '');
        // Resume: only with a proven session capability, on the same binding; otherwise a new session with a reason.
        const fix = Object.values(s.attempts).find((a) => a.step === 'ci_fix');
        const fixEffect = d.store
          .readEvents(task.id)
          .map((e) => e.payload as { effect_id?: string; result?: unknown })
          .find((p) => p.effect_id === fix?.effect_id && p.result !== undefined);
        if (resume) {
          expect(coder.calls[1]?.session).toEqual({
            ref: 'sess-1',
            from_attempt_id: coder.calls[0]?.attempt_id,
          });
          expect(fixEffect?.result).toMatchObject({
            resumed: true,
            session_ref: 'sess-2',
          });
        } else {
          expect(coder.calls[1]?.session).toBeNull();
          expect(fixEffect?.result).toMatchObject({
            resumed: false,
            resume_fallback: 'no_session',
          });
        }
        if (mode === 'full-review')
          expect(s.run.reviews.filter((r) => r.verdict === 'approve').map((r) => r.sha)).toEqual([
            first,
            second,
          ]);
        else expect(codex.calls).toEqual([]);
        // CI of the old head is history; the merge of the new head is verified.
        github.merge(7, 'e'.repeat(40));
        const seen = await observeTask(deps, task.id, 'obs:merge');
        for (const t of seen.extra) d.must(task.id, t);
        expect(d.task(task.id)).toMatchObject({
          status: 'DONE',
          completion: {
            unverified: null,
            proof: { merged_head_sha: second, checked_head_sha: second },
          },
        });
      },
    );
    it('T139 M04: a coder answer follows the worker into a resumed CI repair, with a new packet digest', async () => {
      const task = buildTask();
      const f = setup(task, {
        mode,
        reviews: 2,
        runs: [CONTENT, CONTENT, FIXED],
        resume: true,
        askFirst: true,
        checks: [{ build: 'success', test: 'failure' }],
        ci_rules: [{ match: { check: 'test' }, class: 'code' }],
      });
      f.d.must(task.id, { kind: 'create_task', task });
      f.start();
      await f.settle();
      const question = Object.values(f.d.task(task.id).questions).find((q) => q.status === 'open');
      if (question === undefined) throw new Error('no worker question');
      f.d.must(task.id, {
        kind: 'answer',
        question_id: question.id as Uuid,
        answer: 'UTF-8; preserve accents',
      });
      await settleWithSlot(f.d, f.settle);
      expect(f.coder.calls).toHaveLength(3);
      const repair = f.coder.calls[2];
      expect(repair?.context.text).toContain('Which encoding?');
      expect(repair?.context.text).toContain('UTF-8; preserve accents');
      expect(repair?.context.text).toContain('Cause: ci');
      expect(repair?.session).not.toBeNull();
      expect(repair?.context.digest).not.toBe(f.coder.calls[1]?.context.digest);
      expect(f.d.task(task.id).wait?.detail.code).toBe('merge');
    });

    it('T139 M04: drift arriving during repair packet construction prevents a stale worker launch', async () => {
      const task = buildTask();
      let env: ReturnType<typeof setup> | null = null;
      let drifted = false;
      const f = setup(task, {
        mode,
        reviews: 2,
        runs: [CONTENT, FIXED],
        resume: true,
        checks: [{ build: 'success', test: 'failure' }],
        ci_rules: [{ match: { check: 'test' }, class: 'code' }],
        afterGit: (args) => {
          if (
            env === null ||
            drifted ||
            !args.includes('--no-ext-diff') ||
            env.d.task(task.id).current_step !== 'ci_fix'
          )
            return;
          drifted = true;
          env.d.must(task.id, {
            kind: 'head_drift',
            expected: env.d.task(task.id).head_sha ?? '',
            observed: 'b'.repeat(40),
            source: 'observation',
            evidence_ref: 'during-packet',
          });
        },
      });
      env = f;
      f.d.must(task.id, { kind: 'create_task', task });
      f.start();
      await settleWithSlot(f.d, f.settle);
      expect(drifted).toBe(true);
      expect(f.coder.calls).toHaveLength(1);
      expect(f.d.task(task.id).blockers.map((b) => b.code)).toContain('head_changed');
      expect(f.github.prs).toHaveLength(1);
      expect(f.github.calls.filter((c) => c.startsWith('PATCH '))).toEqual([]);
    });
    it.each([1, 2])(
      'T139 M04: context changes %i time(s) during Git reads; rebuild once then stop within the bound',
      async (maxChanges) => {
        const task = buildTask();
        let env: ReturnType<typeof setup> | null = null;
        let changes = 0;
        const f = setup(task, {
          mode,
          reviews: 2,
          runs: [CONTENT, FIXED],
          resume: true,
          checks: [{ build: 'success', test: 'failure' }],
          ci_rules: [{ match: { check: 'test' }, class: 'code' }],
          afterGit: (args) => {
            if (
              env === null ||
              changes >= maxChanges ||
              !args.includes('--no-ext-diff') ||
              env.d.task(task.id).current_step !== 'ci_fix'
            )
              return;
            changes++;
            const question_id = uuidOf(80_000 + changes);
            // A newly ingested answer interleaves with the async Git read; admission itself is covered separately.
            injectEvents(env.d.store, task.id, [
              {
                type: 'QuestionAsked',
                actor: 'test',
                revision: 1,
                payload: {
                  question_id,
                  step: 'code',
                  attempt_id: null,
                  body: 'Fresh encoding question ' + changes,
                  resume: { kind: 'none' },
                },
              },
              {
                type: 'QuestionAnswered',
                actor: 'owner',
                revision: 1,
                payload: {
                  question_id,
                  answer: 'UTF-8 generation ' + changes,
                  by: 'owner',
                },
              },
            ]);
          },
        });
        env = f;
        f.d.must(task.id, { kind: 'create_task', task });
        f.start();
        await settleWithSlot(f.d, f.settle);
        expect(changes).toBe(maxChanges);
        if (maxChanges === 1) {
          expect(f.coder.calls).toHaveLength(2);
          expect(f.coder.calls[1]?.context.text).toContain('Fresh encoding question 1');
          expect(f.coder.calls[1]?.context.text).toContain('UTF-8 generation 1');
          expect(f.d.task(task.id).wait?.detail.code).toBe('merge');
        } else {
          expect(f.coder.calls).toHaveLength(1);
          expect(f.d.task(task.id).wait?.detail.code).toBe('agent_question');
          expect(
            Object.values(f.d.task(task.id).questions).some(
              (q) => q.status === 'open' && q.body.startsWith('needs_context:'),
            ),
          ).toBe(true);
          expect(f.github.calls.filter((c) => c.startsWith('PATCH '))).toEqual([]);
        }
        expect(f.d.store.verifyProjections().ok).toBe(true);
      },
    );
  },
);

const git = (cwd: string, ...args: string[]): string =>
  spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();

/** What a reviewer may do in its run; `git add` and `commit` move both the index and HEAD. */
function reviewerCommits(worktree: string): void {
  writeFileSync(join(worktree, 'reviewer-probe.txt'), 'reviewer\n');
  git(worktree, 'add', '--all', '--', '.');
  git(worktree, '-c', 'user.name=r', '-c', 'user.email=r@x', 'commit', '-qm', 'reviewer');
}

it('a reviewer lost to a restart still has its worktree put back before the next run', async () => {
  const task = buildTask();
  const { d, deps, start, settle } = setup(task, { mode: 'full-review', reviews: 2 });
  const harness = deps.harnesses['codex'];
  if (harness === undefined) throw new Error('no harness');
  const run = harness.run.bind(harness);
  const worktree = join(deps.paths.worktrees, task.id);
  const heads: string[] = [];
  Object.assign(harness, {
    run: async (input: HarnessInput, signal: AbortSignal) => {
      heads.push(git(worktree, 'rev-parse', 'HEAD'));
      if (heads.length > 1) return run(input, signal);
      reviewerCommits(worktree);
      throw new Error('daemon killed');
    },
  });
  d.must(task.id, { kind: 'create_task', task });
  start();
  await settle();
  const agent = Object.values(d.task(task.id).effects).find((e) => e.status === 'started');
  if (agent === undefined) throw new Error('no agent effect');
  const op = Object.values(d.task(task.id).operations).find((o) => o.effect_id === agent.id);
  if (op === undefined) throw new Error('no operation');
  d.must(task.id, {
    kind: 'operation_result',
    operation_id: op.id as Uuid,
    status: 'lost',
    outcome: null,
    invocation_id: null,
    processes: [],
    started_at: d.now as EpochMs,
    finished_at: d.now as EpochMs,
    receipt_digest: `sha256:${'c'.repeat(64)}`,
  });
  d.must(task.id, {
    kind: 'effect_result',
    effect_id: agent.id as Uuid,
    ...(agent.attempt_id === null ? {} : { attempt_id: agent.attempt_id as Uuid }),
    outcome: 'unknown',
  });
  await settle();
  expect(d.task(task.id).effects[agent.id]?.status).toBe('failed');
  expect(git(worktree, 'rev-parse', 'HEAD')).toBe(heads[0]);
  expect(existsSync(join(worktree, 'reviewer-probe.txt'))).toBe(false);
});

it('#154: a message sent after the launch does not change the input recovery rebuilds; the next turn carries it', async () => {
  const task = buildTask();
  const { d, deps, start, settle, coder } = setup(task, { mode: 'direct-pr', runs: [CONTENT] });
  const harness = deps.harnesses['claude'];
  if (harness === undefined) throw new Error('no harness');
  const finished: { input: HarnessInput; out: HarnessOutcome }[] = [];
  const run = harness.run.bind(harness);
  let died = false;
  Object.assign(harness, {
    run: async (input: HarnessInput, signal: AbortSignal) => {
      const out = await run(input, signal);
      if (died) return out;
      died = true;
      finished.push({ input, out });
      throw new Error('daemon killed');
    },
    recover: (input: HarnessInput): HarnessOutcome => {
      const r = finished.find((f) => canonicalJson(f.input) === canonicalJson(input));
      if (r === undefined)
        throw new InvocationUnknown('launch state does not match this invocation');
      return r.out;
    },
  });
  d.must(task.id, { kind: 'create_task', task });
  start();
  await settle();
  const agent = Object.values(d.task(task.id).effects).find((e) => e.status === 'started');
  const op = Object.values(d.task(task.id).operations).find((o) => o.effect_id === agent?.id);
  if (agent === undefined || op === undefined) throw new Error('no running agent');
  d.must(task.id, { kind: 'message', body: 'MSG-154: after the launch' });
  d.must(task.id, {
    kind: 'operation_result',
    operation_id: op.id as Uuid,
    status: 'finished',
    outcome: 'succeeded',
    invocation_id: null,
    processes: [],
    started_at: d.now as EpochMs,
    finished_at: d.now as EpochMs,
    receipt_digest: `sha256:${'c'.repeat(64)}`,
  });
  d.must(task.id, {
    kind: 'effect_result',
    effect_id: agent.id as Uuid,
    ...(agent.attempt_id === null ? {} : { attempt_id: agent.attempt_id as Uuid }),
    outcome: 'unknown',
  });
  await settleWithSlot(d, settle);
  expect(d.task(task.id).effects[agent.id]?.status).toBe('succeeded');
  expect(finished[0]?.input.context.text).not.toContain('MSG-154');
  const next = coder.calls.at(-1);
  expect(next?.attempt_id).not.toBe(agent.attempt_id);
  expect(next?.context.text).toContain('MSG-154: after the launch');
});

it('#154: a stopped run recovered as cancelled keeps its session and tree; the next turn continues it', async () => {
  const task = buildTask();
  const { d, deps, start, settle, coder } = setup(task, {
    mode: 'direct-pr',
    runs: [CONTENT, CONTENT],
    resume: true,
  });
  const harness = deps.harnesses['claude'];
  if (harness === undefined) throw new Error('no harness');
  const finished: { input: HarnessInput; out: HarnessOutcome }[] = [];
  const run = harness.run.bind(harness);
  let died = false;
  Object.assign(harness, {
    run: async (input: HarnessInput, signal: AbortSignal) => {
      // The first run edits the worktree, then a message stops it and the daemon dies unread.
      const edited = await run(input, signal);
      if (died) return edited;
      died = true;
      d.must(task.id, { kind: 'message', body: 'MSG-154: keep going from here' });
      finished.push({
        input,
        out: {
          kind: 'failure',
          failure: 'cancelled',
          detail: 'stopped',
          role: input.role,
          usage: { basis: 'unavailable' },
          session_ref: 'interrupted-session',
          permission_denials: [],
          invoked: true,
          reset_at: null,
        },
      });
      throw new Error('daemon killed');
    },
    recover: (input: HarnessInput): HarnessOutcome => {
      const r = finished.find((f) => canonicalJson(f.input) === canonicalJson(input));
      if (r === undefined)
        throw new InvocationUnknown('launch state does not match this invocation');
      return r.out;
    },
  });
  d.must(task.id, { kind: 'create_task', task });
  start();
  await settle();
  const agent = Object.values(d.task(task.id).effects).find((e) => e.status === 'started');
  const op = Object.values(d.task(task.id).operations).find((o) => o.effect_id === agent?.id);
  if (agent === undefined || op === undefined) throw new Error('no running agent');
  d.must(task.id, {
    kind: 'operation_result',
    operation_id: op.id as Uuid,
    status: 'finished',
    outcome: 'failed',
    invocation_id: null,
    processes: [],
    started_at: d.now as EpochMs,
    finished_at: d.now as EpochMs,
    receipt_digest: `sha256:${'c'.repeat(64)}`,
  });
  d.must(task.id, {
    kind: 'effect_result',
    effect_id: agent.id as Uuid,
    ...(agent.attempt_id === null ? {} : { attempt_id: agent.attempt_id as Uuid }),
    outcome: 'unknown',
  });
  await settleWithSlot(d, settle);
  const s = d.task(task.id);
  expect(s.effects[agent.id]?.status).toBe('failed');
  expect(s.attempts[agent.attempt_id as string]?.session_ref).toBe('interrupted-session');
  expect(coder.calls).toHaveLength(2);
  expect(coder.calls[1]?.session).toMatchObject({
    ref: 'interrupted-session',
    from_attempt_id: agent.attempt_id,
  });
  expect(coder.calls[1]?.context.text).toContain('MSG-154: keep going from here');
  expect(s.wait?.detail.code).not.toBe('worktree_changed');
  expect(replay(d.store.readEvents(task.id))).toEqual(s);
});

describe.each(['coder', 'reviewer'] as const)(
  'restart after a %s finished while no daemon read it (US3.2, T090)',
  (role) => {
    it('its result comes back through the harness on reconcile: no second run, the flow goes on to the PR', async () => {
      const task = buildTask();
      const { d, deps, start, settle, codex, coder, github } = setup(task, {
        mode: 'full-review',
      });
      const harness = deps.harnesses[role === 'coder' ? 'claude' : 'codex'];
      if (harness === undefined) throw new Error('no harness');
      const finished: { input: HarnessInput; out: HarnessOutcome }[] = [];
      const run = harness.run.bind(harness);
      let died = false;
      // The run goes to its end; the daemon dies before it reads the outcome (once).
      Object.assign(harness, {
        run: async (input: HarnessInput, signal: AbortSignal) => {
          const out = await run(input, signal);
          if (died) return out;
          died = true;
          finished.push({ input, out });
          if (role === 'reviewer') reviewerCommits(join(deps.paths.worktrees, task.id));
          throw new Error('daemon killed');
        },
      });
      const recovered: HarnessInput[] = [];
      Object.assign(harness, {
        recover: (input: HarnessInput): HarnessOutcome => {
          recovered.push(input);
          const r = finished.find((f) => canonicalJson(f.input) === canonicalJson(input));
          if (r === undefined) throw new InvocationUnknown('no finished run for this input');
          // Recovery reads the run from its first record; its result file is new.
          return { ...r.out, ingest };
        },
      });
      d.must(task.id, { kind: 'create_task', task });
      start();
      await settle();
      const open = Object.values(d.task(task.id).effects).filter((e) => e.status === 'started');
      expect(open).toHaveLength(1);
      const agent = open[0];
      if (agent === undefined) throw new Error('no agent effect');
      expect(agent.kind).toBe('start_agent');
      const op = Object.values(d.task(task.id).operations).find((o) => o.effect_id === agent.id);
      if (op === undefined) throw new Error('no operation');

      // Use real spool files and the production ingester before recovering the finished run.
      const files = RunDir.open({
        dataDir: deps.dataDir,
        kind: 'runs',
        id: op.attempt_id!,
        redactor: deps.redactor,
      });
      const writer = EventLogWriter.open(files, op.id);
      for (let i = 0; i < 3; i++) writer.append('progress', { i });
      writer.close();
      files.writeExit(runExit(op.id, d.now));
      const batch = readRecords(files, op.id, null, { final: true });
      if (!batch.ok || batch.value.cursor === null) throw new Error('missing spool');
      const ingest = {
        operation_id: op.id,
        cursor: batch.value.cursor,
        records: batch.value.records.length,
        digest: hashCanonical(batch.value.records),
        artifacts: [],
      };
      const committed = spoolIngest.ingestOperationSpool(
        {
          store: d.store,
          dataDir: deps.dataDir,
          redactor: deps.redactor,
          now: () => d.now,
          newId: deps.newId,
        },
        task.id,
        op.id,
      );
      expect(committed).toMatchObject({ status: 'ingested', records: 3 });
      // The result becomes available only after that first ingest, so recovery must index it alone.
      files.writeResult({ schema_version: 1, outcome: finished[0]?.out });
      const resultId = `${op.id}:out/result.json`;

      // What restart commits for a runner whose exit.json is final (T086): finished, effect unknown.
      d.must(task.id, {
        kind: 'operation_result',
        operation_id: op.id as Uuid,
        status: 'finished',
        outcome: 'succeeded',
        invocation_id: null,
        processes: [],
        started_at: d.now as EpochMs,
        finished_at: d.now as EpochMs,
        receipt_digest: `sha256:${'c'.repeat(64)}`,
      });
      d.must(task.id, {
        kind: 'effect_result',
        effect_id: agent.id as Uuid,
        ...(agent.attempt_id === null ? {} : { attempt_id: agent.attempt_id as Uuid }),
        outcome: 'unknown',
      });
      await settle();

      expect(recovered).toHaveLength(1);
      expect((role === 'coder' ? coder : codex).calls).toHaveLength(1);
      const worktree = join(deps.paths.worktrees, task.id);
      expect(existsSync(join(worktree, 'reviewer-probe.txt'))).toBe(false);
      expect(git(worktree, 'log', '--format=%s', '-1')).not.toBe('reviewer');
      const s = d.task(task.id);
      expect(s.effects[agent.id]?.status).toBe('succeeded');
      // The result file is indexed alone at the committed cursor, the records are not counted twice.
      expect(s.artifacts[resultId]).toMatchObject({ kind: 'result' });
      expect(d.store.readEvents(task.id).filter((e) => e.type === 'OutputIngested')).toHaveLength(
        1,
      );
      expect(s.run.reviews).toMatchObject([{ verdict: 'approve', sha: s.run.checkpoint?.sha }]);
      expect(github.prs).toHaveLength(1);
      expect(d.store.verifyProjections().ok).toBe(true);
    });
  },
);

describe('minor findings of an approving review (real Git)', () => {
  const approveMinor = {
    schema_version: 1,
    verdict: 'approve',
    summary: 'ok, one minor finding',
    findings: [{ severity: 'minor', file: 'search.ts', line: 1, message: 'misleading name' }],
  };
  const run = async (gates?: Record<string, string>) => {
    const task = buildTask();
    const f = setup(task, {
      mode: 'full-review',
      runs: [CONTENT, FIXED],
      verdicts: [approveMinor],
      ...(gates === undefined ? {} : { gates }),
    });
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    await settleWithSlot(f.d, f.settle);
    return { ...f, task };
  };
  const remoteHead = (remote: string, task: CanonicalTask) =>
    g.sh(remote, 'rev-parse', `refs/heads/${taskBranch(task.id, task.title)}`);

  it('the fixer takes the minor finding once; the approval carries the fix to the merge, with no second review', async () => {
    const { d, codex, coder, remote, task } = await run();
    expect(coder.calls).toHaveLength(2);
    expect(codex.calls).toHaveLength(1);
    const s = d.task(task.id);
    expect(s.run.minor_fix).toMatchObject({ paths: ['search.ts'] });
    expect(remoteHead(remote, task)).toBe(s.run.minor_fix?.sha);
    expect(s.wait).toMatchObject({ detail: { code: 'merge' } });
  });

  it('a base update after a carried minor fix runs the task gates, not the minor ones', async () => {
    const { d, codex, remote, task, settle } = await run();
    const head = d.task(task.id).head_sha as string;
    const external = join(g.base, `minor-base-${task.id}`);
    g.sh(g.base, 'clone', '-q', remote, external);
    writeFileSync(join(external, 'base-only.txt'), 'a change on main\n');
    g.sh(external, 'add', '-A');
    g.sh(external, 'commit', '-qm', 'main moves on');
    g.sh(external, 'push', '-q', 'origin', 'main');
    const base = g.sh(external, 'rev-parse', 'HEAD');
    d.must(task.id, { kind: 'update_base', head_sha: head, base_sha: base });
    await settleWithSlot(d, settle);
    const s = d.task(task.id);
    expect(s.run.base_update).toMatchObject({ gate_step: 'gates', base_sha: base });
    const pushed = remoteHead(remote, task);
    expect(pushed).not.toBe(head);
    expect(g.sh(remote, 'merge-base', '--is-ancestor', base, pushed)).toBe('');
    expect(codex.calls).toHaveLength(1);
    expect(s.wait).toMatchObject({ detail: { code: 'merge' } });
  });

  it('failed minor gates put the worktree back and merge the approved commit', async () => {
    // The fake fixer adds "fix 1" to search.ts; the approved tree has none.
    const { d, codex, coder, deps, remote, task } = await run({
      build: '! grep -q "fix 1" search.ts',
      unit: 'true',
      lint: 'true',
      format_fix: 'true',
    });
    expect(coder.calls).toHaveLength(2);
    expect(codex.calls).toHaveLength(1);
    const s = d.task(task.id);
    expect(s.run.minor_fix).toBeUndefined();
    const approved = s.run.reviews.at(-1)?.sha;
    expect(remoteHead(remote, task)).toBe(approved);
    const worktree = join(deps.paths.worktrees, task.id);
    expect(readFileSync(join(worktree, 'search.ts'), 'utf8')).not.toContain('fix 1');
    expect(g.sh(worktree, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(s.wait).toMatchObject({ detail: { code: 'merge' } });
  });
});
