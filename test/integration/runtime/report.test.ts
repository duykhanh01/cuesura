import { describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import { statusSinceReader } from '../../../src/application/board.ts';
import { REPORT_LIMIT, addToReport, emptyReport, report } from '../../../src/application/report.ts';
import type { TaskState } from '../../../src/domain/state.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-report-');

const OWNER: Caller = {
  grant: {
    actor: 'owner',
    roles: ['read', 'operate', 'admin'],
  },
};
type Item = { task_id: string } & Record<string, unknown>;
type Section = { items: Item[]; truncated: boolean };
type Project = {
  project: string;
  finished: Section;
  needs_you: Section;
  running: Section;
  decisions: Section;
  usage: Record<string, unknown>;
};
type Report = { since: number; until: number; projects: Project[] };

function setup() {
  const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
  const statusSince = statusSinceReader(d.store);
  const run = (body: Record<string, unknown>, caller: Caller = OWNER) =>
    report({ store: d.store, statusSince, now: () => d.now }, caller, {
      kind: 'report',
      ...body,
    });
  const read = (body: Record<string, unknown>, caller?: Caller): Report => {
    const r = run(body, caller);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value as Report;
  };
  return { d, run, read };
}

let next = 500;
function add(d: StoreDriver, over: Partial<CanonicalTask> = {}): CanonicalTask {
  const t = buildTask({ id: uuidOf(next++), ...over });
  d.must(t.id, { kind: 'create_task', task: t });
  return t;
}

const ids = (s: Section): string[] => s.items.map((i) => i.task_id);

describe('report', () => {
  it('groups tasks by project and reports only tasks finished in the window', () => {
    const { d, read } = setup();
    const before = add(d, { title: 'Cancelled before' });
    d.must(before.id, { kind: 'cancel', reason: 'old' });
    d.now += 60_000;
    const since = d.now;
    const acme = add(d, { title: 'Cancelled after' });
    d.must(acme.id, { kind: 'cancel', reason: 'not needed' });
    const other = add(d, { project: 'beta', title: 'Waiting' });
    d.now += 60_000;

    const r = read({ since });
    expect(r).toMatchObject({ since, until: d.now });
    expect(r.projects.map((p) => p.project)).toEqual(['acme', 'beta']);
    const [a, b] = r.projects as [Project, Project];
    expect(ids(a.finished)).toEqual([acme.id]);
    expect(a.finished.items[0]).toMatchObject({
      title: 'Cancelled after',
      status: 'CANCELLED',
      finished_at: since,
      usage: {
        agent_runs: 0,
        basis: { reported: 0, estimated: 0, unavailable: 0 },
        tokens: { sum: 0, missing: 0 },
        cost: { sum: 0, missing: 0 },
      },
    });
    expect(ids(b.finished)).toEqual([]);
    expect([...ids(b.needs_you), ...ids(b.running)]).toEqual([other.id]);
  });

  it('leaves out a project with nothing to report, unless it was asked for', () => {
    const { d, read } = setup();
    const t = add(d);
    d.must(t.id, { kind: 'cancel', reason: 'old' });
    d.now += 60_000;
    expect(read({ since: d.now }).projects).toEqual([]);
    expect(read({ since: d.now, project: 'acme' }).projects).toMatchObject([
      { project: 'acme', finished: { items: [] } },
    ]);
  });

  it('filters by project', () => {
    const { d, read } = setup();
    add(d, { project: 'acme' });
    add(d, { project: 'beta' });
    expect(read({ since: 0, project: 'beta' }).projects.map((p) => p.project)).toEqual(['beta']);
    expect(read({ since: 0 }).projects.map((p) => p.project)).toEqual(['acme', 'beta']);
  });

  it('answers through the daemon, with the daemon clock as the end of the window', async () => {
    const sd = new SeededDaemon();
    try {
      const t = buildTask({ id: uuidOf(next++) });
      const since = sd.seed((d) => {
        const at = d.now;
        d.must(t.id, { kind: 'create_task', task: t });
        d.must(t.id, { kind: 'cancel', reason: 'stop' });
        return at;
      });
      sd.now += 60_000;
      await sd.start();
      const r = await sd.query('owner', { kind: 'report', since });
      expect(r.envelope.data).toMatchObject({
        since,
        until: sd.now,
        projects: [{ project: 'acme', finished: { items: [{ task_id: t.id }] } }],
      });
    } finally {
      await sd.cleanup();
    }
  });

  it('refuses a query without a valid since', () => {
    const { run } = setup();
    for (const body of [{}, { since: -1 }, { since: 1, extra: true }]) {
      const r = run(body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid_request');
    }
  });
});

describe('addToReport', () => {
  const window = { since: 1_000, until: 2_000 };

  function state(over: Partial<TaskState>): TaskState {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = add(d, { title: 'Task' });
    return { ...d.task(t.id), ...over };
  }

  it('sums the usage of a finished task over its attempts and the decider runs that invoked a model', () => {
    const s = state({
      status: 'DONE',
      pr_ref: 'acme/app#7',
      merged: true,
      terminal: { kind: 'DONE', reason: 'merged' },
      attempts: {
        a: { usage: { basis: 'reported', tokens: 100, cost: 0.5 } },
        b: { usage: null },
      } as unknown as TaskState['attempts'],
      decider_runs: {
        q1: {
          question_id: 'q1',
          usage: { basis: 'estimated', tokens: 10 },
          invoked: true,
          answer: 'Use the existing helper.',
          reason: 'The spec says so.',
          failure: null,
          applied: true,
          at: 1_500,
        },
        q2: {
          question_id: 'q2',
          usage: { basis: 'unavailable' },
          invoked: false,
          answer: null,
          reason: null,
          failure: 'capability_missing',
          applied: false,
          at: 1_600,
        },
      },
      questions: {
        q1: { id: 'q1', body: 'Which helper?' },
      } as unknown as TaskState['questions'],
    });
    const r = emptyReport('acme');
    addToReport(r, s, window, 1_900);
    expect(r.finished.items).toMatchObject([
      {
        status: 'DONE',
        pr_ref: 'acme/app#7',
        merged: true,
        usage: {
          agent_runs: 3,
          basis: { reported: 1, estimated: 1, unavailable: 1 },
          tokens: { sum: 110, missing: 1 },
          cost: { sum: 0.5, missing: 2 },
        },
      },
    ]);
    expect(r.usage).toEqual(r.finished.items[0]?.['usage']);
    expect(r.decisions.items).toMatchObject([
      {
        question: 'Which helper?',
        answer: 'Use the existing helper.',
        applied: true,
        at: 1_500,
      },
    ]);
  });

  it('skips a task finished outside the window, and one whose finish time is unknown', () => {
    const s = state({
      status: 'FAILED',
      terminal: { kind: 'FAILED', reason: 'x' },
    });
    const r = emptyReport('acme');
    addToReport(r, s, window, 999);
    addToReport(r, s, window, 2_001);
    addToReport(r, s, window, null);
    expect(r.finished.items).toEqual([]);
    expect(r.usage.agent_runs).toBe(0);
  });

  it('keeps a metric a harness did not give apart from a zero', () => {
    const s = state({
      status: 'DONE',
      terminal: { kind: 'DONE', reason: 'merged' },
      attempts: {
        a: { usage: { basis: 'reported', tokens: 100 } },
        b: { usage: { basis: 'reported', tokens: 20 } },
      } as unknown as TaskState['attempts'],
    });
    const r = emptyReport('acme');
    addToReport(r, s, window, 1_500);
    expect(r.usage).toMatchObject({
      basis: { reported: 2, estimated: 0, unavailable: 0 },
      tokens: { sum: 120, missing: 0 },
      cost: { sum: 0, missing: 2 },
    });
  });

  it('reports a decider answer given in the window on a task that finished before it', () => {
    const s = state({
      status: 'CANCELLED',
      terminal: { kind: 'CANCELLED', reason: 'stop' },
      decider_runs: {
        q1: {
          question_id: 'q1',
          usage: { basis: 'unavailable' },
          invoked: true,
          answer: 'Go on.',
          reason: 'Late.',
          failure: null,
          applied: false,
          at: 1_200,
        },
      },
    });
    const r = emptyReport('acme');
    addToReport(r, s, window, 900);
    expect(r.finished.items).toEqual([]);
    expect(r.decisions.items).toMatchObject([{ answer: 'Go on.', at: 1_200 }]);
  });

  it('lists open questions of a task that waits for the user', () => {
    const s = state({
      questions: {
        q1: { id: 'q1', body: 'Open one', status: 'open', revision: 1 },
        q2: { id: 'q2', body: 'Done one', status: 'answered', revision: 1 },
        q3: { id: 'q3', body: 'Withdrawn one', status: 'open', revision: 0 },
      } as unknown as TaskState['questions'],
    });
    const r = emptyReport('acme');
    addToReport(r, s, window, null);
    expect(r.needs_you.items).toMatchObject([
      { questions: [{ question_id: 'q1', body: 'Open one' }] },
    ]);
  });

  it('marks a section truncated past the limit', () => {
    const s = state({
      status: 'CANCELLED',
      terminal: { kind: 'CANCELLED', reason: 'x' },
    });
    const r = emptyReport('acme');
    for (let i = 0; i <= REPORT_LIMIT; i++) addToReport(r, s, window, 1_500);
    expect(r.finished.items).toHaveLength(REPORT_LIMIT);
    expect(r.finished.truncated).toBe(true);
  });
});
