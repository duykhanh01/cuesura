import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../../src/cli/output.ts';
import type { Caller } from '../../../src/application/authz.ts';
import { inbox } from '../../../src/application/inbox.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { injectEvents, openFileStoreForTest } from '../../../src/store/testing.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { agentData, PREPARE_DATA } from '../../support/scenario.ts';
import type { CallerActor } from '../../../src/application/authz.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// US5.1/US5.2/US5.7 on the store (T095): real SQLite file, reopened for the restart cases. The command
// path over the control socket (request replay, races, scopes) is in the daemon block below.

const tempDir = useTempDir('cusr-questions-');

export const OWNER: Caller = {
  grant: {
    actor: 'owner',
    roles: ['read', 'operate', 'admin'],
  },
};
let grantSeq = 70_000;
function grant(d: StoreDriver): void {
  const ids = Array.from({ length: 4 }, () => uuidOf(grantSeq++));
  const g = d.store.grantNext(d.now as EpochMs, ids);
  if (!g.ok) throw new Error(JSON.stringify(g));
}

/** A started runtime task whose first coder attempt is running. */
function started(path = dbPath(tempDir())) {
  const d = new StoreDriver(openFileStoreForTest(path));
  const t = buildTask();
  createGrantStart(d, t, 'direct-pr');
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  return { d, t, path };
}

function openQuestion(d: StoreDriver, taskId: string) {
  const q = Object.values(d.task(taskId).questions).find((x) => x.status === 'open');
  if (q === undefined) throw new Error('no open question');
  return q;
}

/** Attempts in request order; the projected map is keyed canonically, not by order. */
const attemptsOf = (d: StoreDriver, taskId: string) =>
  Object.values(d.task(taskId).attempts).sort((a, b) => a.n - b.n);

const agentRequests = (d: StoreDriver, taskId: string) =>
  d.pending(taskId, 'start_agent').map((e) => e.request);

describe('needs_input ends the attempt and waits for a person (US5.1, FR-024)', () => {
  it('records the question, finishes the attempt, keeps the slot only reserved and keeps the question across a restart', () => {
    const { d, t, path } = started();
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      agentData('needs_input', { questions: ['Which encoding?'] }),
    );
    const s = d.task(t.id);
    expect(s).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'human_input', detail: { code: 'agent_question' } },
    });
    // No agent kept alive to wait: the attempt is finished and nothing is in flight. The slot is only
    // reserved, so another task may borrow it until the answer comes (FR-044.02).
    expect(Object.values(s.attempts).map((a) => a.status)).toEqual(['finished']);
    expect(d.store.pendingEffects(100)).toEqual([]);
    expect(d.store.readSlots()).toMatchObject([{ holder_task_id: t.id, reserved_at: d.now }]);
    expect(s.execution).toMatchObject({ holding: { reserved_at: d.now }, request: null });
    const q = openQuestion(d, t.id);
    expect(q).toMatchObject({ body: 'Which encoding?', step: 'code' });

    d.store.close();
    const reopened = openFileStoreForTest(path);
    const r = inbox(reopened, OWNER, {});
    expect(r.ok && r.value.items).toEqual([
      expect.objectContaining({
        question_id: q.id,
        task_id: t.id,
        body: 'Which encoding?',
        blocking: true,
        wait_code: 'agent_question',
        task_version: s.version,
      }),
    ]);
    // A filter on another project leaves it out.
    const other = inbox(reopened, OWNER, { project: 'elsewhere' });
    expect(other.ok && other.value.items).toEqual([]);
    reopened.close();
  });
});

describe('inbox lists only questions that can still be answered', () => {
  it('a cancelled task leaves both the full and the per-task inbox', () => {
    const { d, t } = started();
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      agentData('needs_input', { questions: ['Which encoding?'] }),
    );
    d.must(t.id, { kind: 'cancel', reason: 'not needed' });
    expect(d.task(t.id).status).toBe('CANCELLED');
    for (const body of [{}, { task_id: t.id }]) {
      const r = inbox(d.store, OWNER, body);
      expect(r.ok && r.value.items).toEqual([]);
    }
  });
});

describe('the first valid answer wins (US5.2, FR-037)', () => {
  it('a competing answer is rejected and asks for no attempt', () => {
    const { d, t } = started();
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      agentData('needs_input', { questions: ['Which encoding?'] }),
    );
    const q = openQuestion(d, t.id);
    d.must(t.id, {
      kind: 'answer',
      question_id: q.id as Uuid,
      answer: 'UTF-8',
    });
    const after = d.task(t.id);
    const competing = d.must(t.id, {
      kind: 'answer',
      question_id: q.id as Uuid,
      answer: 'Latin-1',
    });
    expect(
      competing.decision.kind === 'accepted' && competing.decision.events.map((e) => e.type),
    ).toEqual(['AnswerRejected']);
    const s = d.task(t.id);
    expect(s.questions[q.id]).toMatchObject({
      status: 'answered',
      answer: 'UTF-8',
    });
    expect(Object.keys(s.attempts)).toEqual(Object.keys(after.attempts));
    expect(s.execution.request?.request_id).toBe(after.execution.request?.request_id);
  });
});

describe('continuing after an answer (US5.7, FR-038)', () => {
  function asked(session: string | null) {
    const env = started();
    env.d.complete(
      env.t.id,
      env.d.pendingOne(env.t.id, 'start_agent').id,
      'succeeded',
      agentData('needs_input', {
        questions: ['Which encoding?'],
        ...(session === null ? {} : { session_ref: session }),
      }),
    );
    const q = openQuestion(env.d, env.t.id);
    env.d.must(env.t.id, {
      kind: 'answer',
      question_id: q.id as Uuid,
      answer: 'UTF-8',
    });
    grant(env.d);
    return { ...env, q };
  }

  it('resumes the session that asked, with the answer in the request', () => {
    const { d, t, q } = asked('sess-1');
    const [req] = agentRequests(d, t.id);
    const first = attemptsOf(d, t.id)[0];
    expect(req).toMatchObject({
      resume: { session_ref: 'sess-1', from_attempt_id: first?.id },
      resume_reason: null,
      answers: [{ question_id: q.id, answer: 'UTF-8' }],
    });
  });

  it('a session that could not be resumed is resumed at most once; the next attempt is new and still carries the Q&A', () => {
    const { d, t, q } = asked('sess-1');
    const resumed = d.pendingOne(t.id, 'start_agent');
    // The resumed run dies without a session of its own (dead session, lost run): a counted attempt.
    d.complete(t.id, resumed.id, 'failed', {
      failure_class: 'timeout',
      message: 'session no longer exists',
    });
    for (let i = 0; i < 4 && d.pending(t.id, 'start_agent').length === 0; i++) {
      d.now += 120_000;
      d.fire();
      if (d.task(t.id).wait?.detail.code === 'execution_slot') grant(d);
    }
    const [req] = agentRequests(d, t.id);
    expect(req).toMatchObject({
      resume: null,
      resume_reason: 'session_unusable',
      answers: [{ question_id: q.id, answer: 'UTF-8' }],
    });
    const attempts = attemptsOf(d, t.id);
    expect(attempts).toHaveLength(3);
    expect(attempts[1]).toMatchObject({
      status: 'finished',
      outcome: { class: 'timeout' },
    });
    expect(attempts[2]?.resumed_from).toBeUndefined();
  });

  it('without a session the next attempt is new and carries the Q&A', () => {
    const { d, t, q } = asked(null);
    const [req] = agentRequests(d, t.id);
    expect(req).toMatchObject({
      resume: null,
      resume_reason: 'no_session',
      answers: [{ question_id: q.id, answer: 'UTF-8' }],
    });
  });
});

describe('needs_context and blocked wait for a person with what is missing (US5.7, FR-039)', () => {
  it.each([
    ['needs_context', 'agent_needs_context', 'the API schema of /v2/search'],
    ['blocked', 'agent_blocked', 'the test database is not reachable'],
  ] as const)(
    '%s: no automatic attempt, the blocker is recorded, an answer runs one new attempt with it',
    (status, code, blocker) => {
      const { d, t } = started();
      d.complete(
        t.id,
        d.pendingOne(t.id, 'start_agent').id,
        'succeeded',
        agentData(status, { blocker }),
      );
      const s = d.task(t.id);
      expect(s).toMatchObject({
        status: 'WAITING',
        wait: {
          reason: 'human_input',
          detail: { code, reported: blocker, step: 'code' },
          exit_paths: ['cancel'],
        },
      });
      expect(d.store.pendingEffects(100)).toEqual([]);
      expect(Object.keys(s.attempts)).toHaveLength(1);
      // No other role is called on the worker's behalf.
      expect(d.store.readEvents(t.id).filter((e) => e.type === 'AttemptRequested')).toHaveLength(1);
      const q = openQuestion(d, t.id);
      expect(q.body).toBe(`${status}: ${blocker}`);
      d.must(t.id, {
        kind: 'answer',
        question_id: q.id as Uuid,
        answer: 'see docs/api.md',
      });
      grant(d);
      const reqs = agentRequests(d, t.id);
      expect(reqs).toHaveLength(1);
      expect(reqs[0]).toMatchObject({
        role: 'coder',
        attempt_kind: 'retry',
        answers: [{ question_id: q.id, answer: 'see docs/api.md' }],
      });
    },
  );

  it('an answer once the agent runs are spent asks for no attempt; the task waits on policy', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr', { limits: { max_agent_runs: 1 } });
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      agentData('needs_context', { blocker: 'missing spec' }),
    );
    const q = openQuestion(d, t.id);
    d.must(t.id, {
      kind: 'answer',
      question_id: q.id as Uuid,
      answer: 'spec attached',
    });
    if (d.task(t.id).wait?.detail.code === 'execution_slot') grant(d);
    expect(d.pending(t.id, 'start_agent')).toEqual([]);
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'policy' },
    });
    expect(Object.keys(d.task(t.id).attempts)).toHaveLength(1);
  });
});

describe('answer and inbox over the control socket (US5.1/US5.2, FR-024/FR-037)', () => {
  const live: SeededDaemon[] = [];
  afterEach(async () => {
    for (const x of live.splice(0)) await x.cleanup();
  });

  /** A daemon whose store holds a task waiting on one worker question. */
  async function asking() {
    const sd = new SeededDaemon();
    live.push(sd);
    const { t, q } = sd.seed((d) => {
      const t = buildTask();
      createGrantStart(d, t, 'direct-pr');
      d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
      d.complete(
        t.id,
        d.pendingOne(t.id, 'start_agent').id,
        'succeeded',
        agentData('needs_input', { questions: ['Which encoding?'] }),
      );
      return { t, q: openQuestion(d, t.id) };
    });
    await sd.start();
    const store = () => sd.daemon?.store as NonNullable<typeof sd.daemon>['store'];
    const version = () => store().readTask(t.id)?.version ?? -1;
    const answer = (
      request: number,
      text = 'UTF-8',
      o: { version?: number; project?: string; question?: string } = {},
    ) => ({
      request_id: `0192bbbb-0000-7000-8000-${String(request).padStart(12, '0')}`,
      kind: 'answer',
      project: o.project ?? 'acme',
      task_id: t.id,
      expected_version: o.version ?? version(),
      payload: { question_id: o.question ?? q.id, answer: text },
    });
    const events = (type: string) =>
      store()
        .readEvents(t.id)
        .filter((e) => e.type === type);
    return { sd, t, q, store, version, answer, events };
  }

  it('the inbox lists the question, and still does after a daemon restart', async () => {
    const { sd, t, q } = await asking();
    const list = async (actor: CallerActor) => {
      const r = await sd.query(actor, { kind: 'inbox' });
      expect(r.code).toBe(ExitCode.ok);
      return (r.envelope.data?.['items'] as { question_id: string }[]).map((i) => i.question_id);
    };
    expect(await list('assistant')).toEqual([q.id]);
    await sd.stop();
    await sd.start();
    expect(await list('owner')).toEqual([q.id]);
    const one = await sd.query('assistant', { kind: 'inbox', task_id: t.id });
    expect(one.envelope.data?.['items']).toEqual([
      expect.objectContaining({ question_id: q.id, blocking: true }),
    ]);
  });

  it.each([2, 3, 5])(
    'the same request sent %i times records one answer and replays the first result',
    async (times) => {
      const { sd, answer, events, store, t } = await asking();
      const body = answer(1);
      const first = await sd.command('assistant', body);
      expect(first.code).toBe(ExitCode.ok);
      expect(first.envelope.data).toMatchObject({
        replayed: false,
        result: { status: 'answered', answered_by: 'assistant' },
      });
      const attempts = Object.keys(store().readTask(t.id)?.attempts ?? {});
      // Sequential and concurrent repeats alike.
      const again = await Promise.all(
        Array.from({ length: times - 1 }, () => sd.command('assistant', body)),
      );
      for (const r of again) {
        expect(r.code).toBe(ExitCode.ok);
        expect(r.envelope.data?.['replayed']).toBe(true);
        expect(r.envelope.data?.['result']).toEqual(first.envelope.data?.['result']);
      }
      expect(events('QuestionAnswered')).toHaveLength(1);
      expect(events('ExecutionQueued').length).toBeGreaterThan(0);
      expect(Object.keys(store().readTask(t.id)?.attempts ?? {})).toEqual(attempts);
    },
  );

  it('racing answers from different requests: exactly one wins, the others are conflicts', async () => {
    const { sd, answer, events } = await asking();
    const bodies = [1, 2, 3, 4, 5].map((i) => answer(i, `answer ${i}`));
    const replies = await Promise.all(bodies.map((b) => sd.command('owner', b)));
    expect(replies.filter((r) => r.code === ExitCode.ok)).toHaveLength(1);
    expect(replies.filter((r) => r.code === ExitCode.conflict)).toHaveLength(4);
    expect(events('QuestionAnswered')).toHaveLength(1);
  });

  it('a competing answer at the current version is a conflict, recorded only as AnswerRejected', async () => {
    const { sd, answer, events, store, t } = await asking();
    expect((await sd.command('owner', answer(1))).code).toBe(ExitCode.ok);
    const before = store().readTask(t.id);
    const late = await sd.command('assistant', answer(2, 'Latin-1'));
    expect(late.code).toBe(ExitCode.conflict);
    expect(late.envelope.error).toMatchObject({
      code: 'conflict',
      details: { reason: 'already_answered', answered_by: 'owner' },
    });
    expect(events('AnswerRejected')).toHaveLength(1);
    const after = store().readTask(t.id);
    expect(Object.keys(after?.attempts ?? {})).toEqual(Object.keys(before?.attempts ?? {}));
    expect(after?.questions).toEqual(before?.questions);
    // A stale version is a conflict before anything is recorded.
    const stale = await sd.command('owner', answer(3, 'x', { version: 1 }));
    expect(stale.code).toBe(ExitCode.conflict);
    expect(events('AnswerRejected')).toHaveLength(1);
  });

  it('a losing answer does not make the version the loser read stale (issue #260)', async () => {
    const { sd, answer, events, store, t, version } = await asking();
    expect((await sd.command('owner', answer(1))).code).toBe(ExitCode.ok);
    const read = version();
    expect((await sd.command('assistant', answer(2, 'Latin-1'))).code).toBe(ExitCode.conflict);
    expect(events('AnswerRejected')).toHaveLength(1);
    expect(store().readTask(t.id)?.version).toBeGreaterThan(read);
    const pause = await sd.command('assistant', {
      request_id: '0192bbbb-0000-7000-8000-000000000099',
      kind: 'task_pause',
      project: 'acme',
      task_id: t.id,
      expected_version: read,
      payload: { reason: 'after the race' },
    });
    expect(pause.code).toBe(ExitCode.ok);
  });

  it('another project and an unknown question change nothing', async () => {
    const { sd, answer, events } = await asking();
    expect((await sd.command('assistant', answer(2, 'x', { project: 'elsewhere' }))).code).toBe(
      ExitCode.missing,
    );
    expect((await sd.command('owner', answer(4, 'x', { question: uuidOf(99_999) }))).code).toBe(
      ExitCode.missing,
    );
    expect(events('QuestionAnswered')).toEqual([]);
  });

  it('a question withdrawn by a new revision is not answered', async () => {
    const { sd, answer, events, store, t, q } = await asking();
    const s = store().readTask(t.id);
    if (s === null) throw new Error('no task');
    injectEvents(store(), t.id, [
      {
        type: 'RevisionApplied',
        revision: 2,
        actor: 'system',
        payload: { revision: 2, task: { ...s.task, revision: 2 } },
      },
    ]);
    expect(store().readTask(t.id)?.questions[q.id]?.status).toBe('withdrawn');
    const r = await sd.command('owner', answer(1));
    expect(r.code).toBe(ExitCode.conflict);
    expect(r.envelope.error).toMatchObject({
      details: { reason: 'question_not_open' },
    });
    expect(events('QuestionAnswered')).toEqual([]);
    const listed = await sd.query('owner', { kind: 'inbox' });
    const items = listed.envelope.data?.['items'] as { kind: string }[];
    expect(items.filter((i) => i.kind === 'question')).toEqual([]);
  });
});
