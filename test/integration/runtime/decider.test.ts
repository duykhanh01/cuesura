import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeHarness, type FakeScript } from '../../../src/adapters/harness/fake.ts';
import type { Clock, HarnessOutcome, HarnessPort } from '../../../src/adapters/ports.ts';
import {
  createDecider,
  DECIDER_ACTOR,
  GRILL_LABEL,
  type DeciderSetting,
} from '../../../src/daemon/decider.ts';
import { InvocationUnknown } from '../../../src/runner/invocation.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { authz, buildTask, uuidOf } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { callerFor, type Caller } from '../../../src/application/authz.ts';
import { inbox } from '../../../src/application/inbox.ts';
import { agentData, PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-decider-');
let ids = 80_000;
const newId = () => uuidOf(ids++);

const SETTING: DeciderSetting = {
  harness: 'fake',
  model: 'opus',
  model_id: 'claude-opus-5-5',
  effort: 'high',
  max_turns: null,
  stall_ms: null,
  wall_ms: null,
};
const decision = (answer: string) => ({
  kind: 'result' as const,
  value: { schema_version: 1, answer, reason: `why ${answer}` },
});

let dir = '';
const decisionsFile = () => join(dir, 'decisions.md');

function waiting(labels: string[] = [], limits: { max_agent_runs?: number } = {}) {
  dir = tempDir();
  const d = new StoreDriver(openFileStoreForTest(dbPath(dir)));
  const t = buildTask({ labels });
  createGrantStart(d, t, 'direct-pr', { limits });
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  ask(d, t.id, ['Which encoding?', 'Which line ending?']);
  return { d, t };
}

function grant(d: StoreDriver): void {
  const g = d.store.grantNext(d.now as EpochMs, Array.from({ length: 4 }, newId));
  if (!g.ok) throw new Error(JSON.stringify(g));
}

function ask(d: StoreDriver, taskId: string, questions: string[]): void {
  d.complete(
    taskId,
    d.pendingOne(taskId, 'start_agent').id,
    'succeeded',
    agentData('needs_input', { questions }),
  );
}

function decider(
  d: StoreDriver,
  harness: HarnessPort,
  setting: DeciderSetting | null | (() => DeciderSetting | null) = SETTING,
  over: { decisionsFile?: string; log?: (line: string) => void } = {},
) {
  const clock: Clock = {
    now: () => d.now as EpochMs,
    monotonic: () => d.now,
  };
  return createDecider({
    store: d.store,
    clock,
    newId,
    harnesses: { fake: harness },
    setting: () => Promise.resolve(typeof setting === 'function' ? setting() : setting),
    workspace: () => Promise.resolve(undefined),
    decisionsFile: over.decisionsFile ?? decisionsFile(),
    recordsDir: join(dir, 'decider'),
    ...(over.log === undefined ? {} : { log: over.log }),
    redactor: new Redactor({ values: ['s3cret'] }),
  });
}

const fake = (steps: FakeScript['decider']) => new FakeHarness({ decider: steps ?? [] });
const questions = (d: StoreDriver, id: string) => Object.values(d.task(id).questions);

describe('the decider answers for an absent owner', () => {
  it('runs nothing while autonomous is off', async () => {
    const { d, t } = waiting();
    const h = fake([]);
    await decider(d, h, null).round();
    expect(h.calls).toEqual([]);
    expect(questions(d, t.id)[0]?.status).toBe('open');
  });

  it('answers every question of a worker result in one read-only run, resumes the task and notes why', async () => {
    const { d, t } = waiting();
    const h = fake([decision('Use UTF-8 and LF, token s3cret')]);
    await decider(d, h).round();

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ role: 'decider', session: null });
    expect(h.calls[0]?.view?.title).toMatch(/^decider: /);
    expect(h.calls[0]?.context.text).toContain('Which encoding?');
    expect(h.calls[0]?.context.text).toContain('Which line ending?');
    const [q] = questions(d, t.id);
    expect(q).toMatchObject({
      status: 'answered',
      answered_by: DECIDER_ACTOR,
    });
    expect(q?.answer).toContain('do not ask again');
    // The next attempt starts through the same path as a person's answer.
    grant(d);
    expect(d.pendingOne(t.id, 'start_agent')).toBeDefined();

    const note = readFileSync(decisionsFile(), 'utf8');
    expect(note).toContain(t.id);
    expect(note).toContain('Which encoding?');
    expect(note).toContain('Reason: why Use UTF-8');
    expect(note).not.toContain('s3cret');
  });

  it('leaves a second question at the same step for the person', async () => {
    const { d, t } = waiting();
    const h = fake([decision('UTF-8')]);
    const one = decider(d, h);
    await one.round();
    grant(d);
    ask(d, t.id, ['And the BOM?']);
    await one.round();
    await decider(d, h).round();

    expect(h.calls).toHaveLength(1);
    expect(questions(d, t.id).map((q) => q.status)).toEqual(['answered', 'open']);
  });

  it('keeps going on a task labelled grill', async () => {
    const { d, t } = waiting([GRILL_LABEL]);
    const h = fake([decision('UTF-8'), decision('No BOM')]);
    const one = decider(d, h);
    await one.round();
    grant(d);
    ask(d, t.id, ['And the BOM?']);
    await one.round();

    expect(h.calls).toHaveLength(2);
    expect(questions(d, t.id).every((q) => q.status === 'answered')).toBe(true);
    expect(questions(d, t.id)[0]?.answer).not.toContain('do not ask again');
  });

  it('leaves the question open after a failed run and tries it again only after a restart', async () => {
    const { d, t } = waiting();
    const h = fake([{ kind: 'failure', failure: 'rate_limited' }, decision('UTF-8')]);
    const one = decider(d, h);
    await one.round();
    await one.round();
    expect(h.calls).toHaveLength(1);
    expect(questions(d, t.id)[0]?.status).toBe('open');
    expect(existsSync(decisionsFile())).toBe(false);

    await decider(d, h).round();
    expect(h.calls).toHaveLength(2);
    expect(questions(d, t.id)[0]?.answered_by).toBe(DECIDER_ACTOR);
  });

  it('does not override a person who answered during the run', async () => {
    const { d, t } = waiting();
    const inner = fake([decision('UTF-8')]);
    const h: HarnessPort = {
      harness: inner.harness,
      manifest: inner.manifest,
      run: async (input, signal) => {
        const out = await inner.run(input, signal);
        const q = questions(d, t.id)[0];
        d.must(t.id, {
          kind: 'answer',
          question_id: q?.id as never,
          answer: 'Latin-1',
        });
        return out;
      },
    };
    await decider(d, h).round();

    expect(questions(d, t.id)[0]).toMatchObject({ answer: 'Latin-1' });
    expect(questions(d, t.id)[0]?.answered_by).not.toBe(DECIDER_ACTOR);
    expect(existsSync(decisionsFile())).toBe(false);
  });

  it('counts every run that invoked a model and keeps its reason in the event log', async () => {
    const { d, t } = waiting();
    const usage = { basis: 'reported' as const, tokens: 7654 };
    const before = d.task(t.id);
    await decider(d, fake([{ ...decision('UTF-8'), usage }])).round();
    const s = d.task(t.id);
    expect(s.budget.agent_runs.used).toBe(before.budget.agent_runs.used + 1);
    // The decider runs no attempt; the answer resumes the worker at once on the reserved slot.
    expect(
      Object.values(s.attempts).filter((a) => before.attempts[a.id] === undefined),
    ).toMatchObject([{ step: 'code' }]);
    expect(Object.values(s.decider_runs ?? {})).toMatchObject([
      { usage, invoked: true, applied: true, reason: 'why UTF-8' },
    ]);
    expect(d.store.verifyProjections().mismatches).toEqual([]);
  });

  it('counts a failed run, but not one that never invoked a model', async () => {
    const { d, t } = waiting();
    const used = d.task(t.id).budget.agent_runs.used;
    const h = fake([
      { kind: 'failure', failure: 'capability_missing', invoked: false },
      { kind: 'failure', failure: 'timeout', invoked: true },
    ]);
    await decider(d, h).round();
    expect(d.task(t.id).budget.agent_runs.used).toBe(used);
    await decider(d, h).round();
    expect(d.task(t.id).budget.agent_runs.used).toBe(used + 1);
    expect(Object.values(d.task(t.id).decider_runs ?? {})).toHaveLength(2);
  });

  it('does not take an answer when autonomous was turned off during the run', async () => {
    const { d, t } = waiting();
    let on = true;
    const inner = fake([decision('UTF-8')]);
    const h: HarnessPort = {
      harness: inner.harness,
      manifest: inner.manifest,
      run: async (input, signal) => {
        const out = await inner.run(input, signal);
        on = false;
        return out;
      },
    };
    await decider(d, h, () => (on ? SETTING : null)).round();

    const s = d.task(t.id);
    expect(questions(d, t.id)[0]?.status).toBe('open');
    expect(s.status).toBe('WAITING');
    expect(Object.values(s.decider_runs ?? {})).toMatchObject([{ applied: false, invoked: true }]);
    expect(existsSync(decisionsFile())).toBe(false);
  });

  it('a new daemon concludes the run it found instead of starting a second one', async () => {
    const { d, t } = waiting();
    const inner = fake([decision('UTF-8')]);
    const seen: string[] = [];
    let live = true;
    const h: HarnessPort = {
      harness: inner.harness,
      manifest: inner.manifest,
      run: (input, signal) => {
        seen.push(input.attempt_id);
        return live
          ? Promise.reject(new InvocationUnknown('still running'))
          : inner.run(input, signal);
      },
    };
    await decider(d, h).round();
    expect(questions(d, t.id)[0]?.status).toBe('open');

    const restarted = decider(d, h);
    await restarted.round();
    expect(questions(d, t.id)[0]?.status).toBe('open');
    expect(new Set(seen).size).toBe(1);
    expect(inner.calls).toHaveLength(0);

    live = false;
    d.now += 60_000;
    await restarted.round();
    expect(new Set(seen).size).toBe(1);
    expect(inner.calls).toHaveLength(1);
    // Recovery compares this digest with the one taken at launch.
    const input = inner.calls[0];
    expect(hashCanonical(JSON.parse(JSON.stringify(input)))).toBe(hashCanonical(input));
    expect(questions(d, t.id)[0]?.answered_by).toBe(DECIDER_ACTOR);
    expect(readdirSync(join(dir, 'decider'))).toEqual([]);
  });

  it('a new daemon still records the usage of a run while autonomous is off', async () => {
    const { d, t } = waiting();
    const inner = fake([decision('UTF-8')]);
    let live = true;
    const h: HarnessPort = {
      harness: inner.harness,
      manifest: inner.manifest,
      run: () => Promise.reject(new InvocationUnknown('still running')),
      recover: () => {
        if (live) throw new InvocationUnknown('still running');
        return {
          kind: 'result',
          role: 'decider',
          value: { schema_version: 1, answer: 'UTF-8', reason: 'why' },
          raw_digest: hashCanonical('raw'),
          schema_digest: hashCanonical('schema'),
          usage: { basis: 'unavailable' },
          session_ref: null,
          permission_denials: [],
        };
      },
    };
    await decider(d, h).round();
    expect(inner.calls).toEqual([]);
    live = false;
    await decider(d, h, null).round();
    expect(Object.values(d.task(t.id).decider_runs ?? {})).toMatchObject([{ applied: false }]);
    expect(questions(d, t.id)[0]?.status).toBe('open');
  });

  it('catches decisions.md up from the event log after a write failed, without repeating an entry', async () => {
    const { d, t } = waiting();
    // A directory where the file should be: the append fails after the answer is committed.
    const broken = join(dir, 'not-writable');
    mkdirSync(broken);
    await decider(d, fake([decision('UTF-8')]), SETTING, {
      decisionsFile: broken,
    }).round();
    expect(questions(d, t.id)[0]?.answered_by).toBe(DECIDER_ACTOR);
    expect(existsSync(decisionsFile())).toBe(false);

    await decider(d, fake([])).round();
    await decider(d, fake([])).round();
    const note = readFileSync(decisionsFile(), 'utf8');
    expect(note.match(/Reason: why UTF-8/g)).toHaveLength(1);
  });

  it.each(['blocked', 'needs_context'] as const)(
    'sends the questions a %s worker listed with its blocker',
    async (status) => {
      const { d, t } = waiting([GRILL_LABEL]);
      await decider(d, fake([decision('UTF-8')])).round();
      grant(d);
      d.complete(
        t.id,
        d.pendingOne(t.id, 'start_agent').id,
        'succeeded',
        agentData(status, {
          blocker: 'No key',
          questions: ['Which key?\nOptions: a | b'],
        }),
      );
      const h = fake([decision('a')]);
      await decider(d, h).round();
      expect(h.calls[0]?.context.text).toContain('No key');
      expect(h.calls[0]?.context.text).toContain('Which key?');
      expect(h.calls[0]?.context.text).toContain('Options: a | b');
    },
  );

  it('holds one agent run while it runs and settles it afterwards', async () => {
    const { d, t } = waiting();
    const before = d.task(t.id).budget.agent_runs;
    const inner = fake([decision('UTF-8')]);
    let during = -1;
    const h: HarnessPort = {
      harness: inner.harness,
      manifest: inner.manifest,
      run: (input, signal) => {
        during = d.task(t.id).budget.agent_runs.reserved;
        return inner.run(input, signal);
      },
    };
    await decider(d, h).round();
    expect(during).toBe(before.reserved + 1);
    // Settled; the one reserved run left is the worker resumed by the answer on its reserved slot.
    expect(d.task(t.id).budget.agent_runs).toMatchObject({
      reserved: before.reserved + 1,
      used: before.used + 1,
    });
  });

  it('does not run on a task with no agent run left', async () => {
    const { d, t } = waiting([], { max_agent_runs: 1 });
    expect(d.task(t.id).budget.agent_runs).toMatchObject({ limit: 1, used: 1 });
    const h = fake([decision('UTF-8')]);
    const lines: string[] = [];
    await decider(d, h, SETTING, { log: (l) => lines.push(l) }).round();
    expect(h.calls).toEqual([]);
    expect(lines.join()).toContain('no_agent_runs_left');
    expect(d.task(t.id).budget.agent_runs).toMatchObject({ limit: 1, used: 1 });
    expect(questions(d, t.id)[0]?.status).toBe('open');
    expect(readdirSync(join(dir, 'decider'))).toEqual([]);
  });

  it('leaves the question to the person when only the worker run it resumes is left (issue #266)', async () => {
    const { d, t } = waiting([], { max_agent_runs: 2 });
    expect(d.task(t.id).budget.agent_runs).toMatchObject({ limit: 2, used: 1 });
    const h = fake([decision('UTF-8')]);
    const lines: string[] = [];
    const one = decider(d, h, SETTING, { log: (l) => lines.push(l) });
    await one.round();

    expect(h.calls).toEqual([]);
    expect(lines.join()).toContain('no_agent_runs_left');
    expect(one.holds(d.task(t.id))).toBe(false);
    expect(d.task(t.id).budget.agent_runs).toMatchObject({ limit: 2, used: 1, reserved: 0 });
    // The person's answer still has the worker's run.
    d.must(t.id, {
      kind: 'answer',
      question_id: questions(d, t.id)[0]?.id as never,
      answer: 'UTF-8',
    });
    grant(d);
    expect(d.pendingOne(t.id, 'start_agent')).toBeDefined();
  });

  it('does not run on a paused task (issue #266)', async () => {
    const { d, t } = waiting();
    d.must(
      t.id,
      { kind: 'pause', reason: 'upgrade cuesura' },
      { authz: authz(['operate'], 'owner') },
    );
    const before = d.task(t.id).budget.agent_runs;
    const h = fake([decision('UTF-8')]);
    const one = decider(d, h);
    await one.round();

    expect(h.calls).toEqual([]);
    expect(one.holds(d.task(t.id))).toBe(false);
    expect(d.task(t.id).budget.agent_runs).toEqual(before);
    expect(questions(d, t.id)[0]?.status).toBe('open');
  });

  it('shows a held question in the inbox, stops the run when a person answers and gives the run back (issue #266)', async () => {
    const { d, t } = waiting();
    const before = d.task(t.id).budget.agent_runs;
    const caller = callerFor('assistant') as Caller;
    let started: () => void = () => undefined;
    const running = new Promise<void>((r) => (started = r));
    let stopped = false;
    const inner = fake([]);
    const h: HarnessPort = {
      harness: inner.harness,
      manifest: inner.manifest,
      run: (_input, signal) =>
        new Promise<HarnessOutcome>((resolve) => {
          started();
          signal.addEventListener('abort', () => {
            stopped = true;
            resolve({
              kind: 'failure',
              role: 'decider',
              usage: { basis: 'unavailable' },
              session_ref: null,
              permission_denials: [],
              failure: 'cancelled',
              detail: 'stopped',
              reset_at: null,
              invoked: true,
            });
          });
        }),
    };
    const one = decider(d, h);
    const round = one.round();
    await running;

    const listed = inbox(d.store, caller, {}, { decider: one });
    expect(listed.ok && listed.value.items).toMatchObject([{ blocking: true, decider: true }]);
    expect(d.task(t.id).budget.agent_runs.reserved).toBe(before.reserved + 1);

    d.must(t.id, {
      kind: 'answer',
      question_id: questions(d, t.id)[0]?.id as never,
      answer: 'Latin-1',
    });
    await one.recheck(t.id);
    await round;

    expect(stopped).toBe(true);
    expect(questions(d, t.id)[0]).toMatchObject({ answer: 'Latin-1' });
    const runs = Object.values(d.task(t.id).decider_runs ?? {});
    expect(runs).toMatchObject([{ applied: false }]);
    expect(d.task(t.id).budget.agent_runs).toMatchObject({ used: before.used });
  });

  it.each(['answer', 'pause'] as const)(
    'stops a run an earlier daemon left once a person overtakes it (%s), and gives the run back',
    async (by) => {
      const { d, t } = waiting();
      const before = d.task(t.id).budget.agent_runs;
      const inner = fake([]);
      let stops = 0;
      // A launched run whose runner outlives the daemon: no exit record is ever readable here.
      const h: HarnessPort = {
        harness: inner.harness,
        manifest: inner.manifest,
        run: () => Promise.reject(new InvocationUnknown('runner still active')),
        recover: () => {
          throw new InvocationUnknown('no exit record');
        },
        started: () => true,
        stop: () => {
          stops += 1;
          return Promise.resolve('stopped');
        },
      };
      await decider(d, h).round();
      const restarted = decider(d, h);
      await restarted.round();
      expect(d.task(t.id).budget.agent_runs.reserved).toBe(before.reserved + 1);
      expect(stops).toBe(0);

      if (by === 'answer')
        d.must(t.id, {
          kind: 'answer',
          question_id: questions(d, t.id)[0]?.id as never,
          answer: 'Latin-1',
        });
      else
        d.must(t.id, { kind: 'pause', reason: 'upgrade' }, { authz: authz(['operate'], 'owner') });
      await restarted.recheck(t.id);

      expect(stops).toBe(1);
      const runs = Object.entries(d.task(t.id).decider_runs ?? {});
      expect(runs.map(([, run]) => run)).toMatchObject([
        { applied: false, failure: expect.stringContaining('cancelled') as unknown },
      ]);
      expect(d.task(t.id).budget.reservations[runs[0]?.[0] ?? '']?.status).toBe('released');
      expect(d.task(t.id).budget.agent_runs.used).toBe(before.used);
      expect(readdirSync(join(dir, 'decider'))).toEqual([]);
    },
  );

  it('keeps running when a recheck finds its question still waiting', async () => {
    const { d, t } = waiting();
    const inner = fake([decision('UTF-8')]);
    const one = decider(d, {
      harness: inner.harness,
      manifest: inner.manifest,
      run: (input, signal) => {
        void one.recheck(t.id);
        expect(signal.aborted).toBe(false);
        return inner.run(input, signal);
      },
    });
    await one.round();
    expect(questions(d, t.id)[0]?.answered_by).toBe(DECIDER_ACTOR);
  });

  it('does not run or hold an agent run once the frozen task deadline has passed', async () => {
    const { d, t } = waiting();
    const before = d.task(t.id);
    d.now = (before.deadline_at ?? 0) + 1;
    const h = fake([decision('UTF-8')]);
    const lines: string[] = [];
    await decider(d, h, SETTING, { log: (l) => lines.push(l) }).round();

    expect(h.calls).toEqual([]);
    expect(lines.join()).toContain('task_deadline_passed');
    expect(d.task(t.id).budget.agent_runs).toEqual(before.budget.agent_runs);
    expect(questions(d, t.id)[0]?.status).toBe('open');
    expect(readdirSync(join(dir, 'decider'))).toEqual([]);
  });

  it('gives a run no more time than the frozen task deadline leaves', async () => {
    const { d, t } = waiting();
    const deadline = d.task(t.id).deadline_at ?? 0;
    d.now = deadline - 1_000;
    const h = fake([decision('UTF-8')]);
    await decider(d, h).round();
    expect(h.calls[0]?.deadline_at).toBe(deadline);
  });

  it('removes a record left after its result was committed, even with autonomous off', async () => {
    const { d, t } = waiting();
    const inner = fake([decision('UTF-8')]);
    let record = '';
    const h: HarnessPort = {
      harness: inner.harness,
      manifest: inner.manifest,
      run: (input, signal) => {
        const [name] = readdirSync(join(dir, 'decider'));
        record = readFileSync(join(dir, 'decider', name ?? ''), 'utf8');
        return inner.run(input, signal);
      },
    };
    await decider(d, h).round();
    const qid = questions(d, t.id)[0]?.id ?? '';
    writeFileSync(join(dir, 'decider', `${qid}.json`), record);
    const version = d.task(t.id).version;
    const lines: string[] = [];
    await decider(d, h, null, { log: (l) => lines.push(l) }).round();

    expect(lines).toEqual([]);
    expect(inner.calls).toHaveLength(1);
    expect(readdirSync(join(dir, 'decider'))).toEqual([]);
    expect(d.task(t.id).version).toBe(version);
  });

  it('drops a run that never spawned instead of launching it after autonomous was turned off', async () => {
    const { d, t } = waiting();
    const inner = fake([decision('UTF-8')]);
    let crashed = true;
    const before = d.task(t.id).budget.agent_runs;
    const h: HarnessPort = {
      harness: inner.harness,
      manifest: inner.manifest,
      started: () => false,
      run: (input, signal) =>
        crashed
          ? Promise.reject(new InvocationUnknown('lost before the spawn'))
          : inner.run(input, signal),
    };
    await decider(d, h).round();
    crashed = false;
    const calls = inner.calls.length;
    await decider(d, h, null).round();

    expect(inner.calls).toHaveLength(calls);
    expect(readdirSync(join(dir, 'decider'))).toEqual([]);
    expect(questions(d, t.id)[0]?.status).toBe('open');
    expect(d.task(t.id).budget.agent_runs).toMatchObject({
      reserved: before.reserved,
      used: before.used,
    });

    // Turned on again: a fresh decision for the question still open.
    await decider(d, h).round();
    expect(inner.calls).toHaveLength(calls + 1);
    expect(questions(d, t.id)[0]?.answered_by).toBe(DECIDER_ACTOR);
  });

  it('replaces a half written decisions.md with the whole record', async () => {
    const { d } = waiting();
    await decider(d, fake([decision('UTF-8')])).round();
    const whole = readFileSync(decisionsFile(), 'utf8');
    writeFileSync(decisionsFile(), whole.slice(0, 30));
    await decider(d, fake([])).round();
    expect(readFileSync(decisionsFile(), 'utf8')).toBe(whole);
  });

  it('does not touch a cancelled task', async () => {
    const { d, t } = waiting();
    d.must(t.id, {
      kind: 'cancel',
      reason: 'owner stopped it',
    } as never);
    const h = fake([]);
    await decider(d, h).round();
    expect(h.calls).toEqual([]);
  });
});

describe('what the decider holds back from the assistant', () => {
  it('holds a question it may answer until a round finds autonomous off', async () => {
    const { d, t } = waiting();
    const one = decider(d, fake([]), null);
    expect(one.holds(d.task(t.id))).toBe(true);
    const before = one.version();
    await one.round();
    expect(one.holds(d.task(t.id))).toBe(false);
    expect(one.version()).not.toBe(before);
  });

  it('holds a question while its run goes on', async () => {
    const { d, t } = waiting();
    let seen: boolean | null = null;
    const inner = fake([decision('UTF-8')]);
    const one = decider(d, {
      harness: inner.harness,
      manifest: inner.manifest,
      run: (input, signal) => {
        seen = one.holds(d.task(t.id));
        return inner.run(input, signal);
      },
    });
    await one.round();
    expect(seen).toBe(true);
    expect(questions(d, t.id)[0]?.status).toBe('answered');
  });

  it('gives a question back to the person after a failed run', async () => {
    const { d, t } = waiting();
    const one = decider(d, fake([{ kind: 'failure', failure: 'rate_limited' }]));
    await one.round();
    expect(questions(d, t.id)[0]?.status).toBe('open');
    expect(one.holds(d.task(t.id))).toBe(false);
  });

  it('gives a question back when its run cannot start', async () => {
    const { d, t } = waiting();
    const one = decider(d, fake([]), { ...SETTING, harness: 'missing' });
    await one.round();
    expect(one.holds(d.task(t.id))).toBe(false);
  });

  it('holds again the replacement run for a record a restart dropped', async () => {
    const { d, t } = waiting();
    const inner = fake([decision('UTF-8')]);
    let crashed = true;
    let seen: boolean | null = null;
    let restarted: ReturnType<typeof decider> | null = null;
    const h: HarnessPort = {
      harness: inner.harness,
      manifest: inner.manifest,
      started: () => false,
      run: (input, signal) => {
        if (crashed) return Promise.reject(new InvocationUnknown('lost before the spawn'));
        seen = restarted?.holds(d.task(t.id)) ?? null;
        return inner.run(input, signal);
      },
    };
    await decider(d, h).round();
    crashed = false;
    restarted = decider(d, h);
    await restarted.round();

    expect(seen).toBe(true);
    expect(questions(d, t.id)[0]?.answered_by).toBe(DECIDER_ACTOR);
  });

  it('never holds a second question at a step it already answered', async () => {
    const { d, t } = waiting();
    const one = decider(d, fake([decision('UTF-8')]));
    await one.round();
    grant(d);
    ask(d, t.id, ['And the BOM?']);
    expect(one.holds(d.task(t.id))).toBe(false);
  });
});
