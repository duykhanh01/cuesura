import { describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import { statusSinceReader, taskBoard } from '../../../src/application/board.ts';
import { inbox, nextAction, type InboxEntry } from '../../../src/application/inbox.ts';
import type { TaskState } from '../../../src/domain/state.ts';
import { EFFECT_UNKNOWN_ATTENTION_MS } from '../../../src/explain/needs-user.ts';
import type { Store } from '../../../src/store/index.ts';
import { taskExplain } from '../../../src/application/queries.ts';
import { report } from '../../../src/application/report.ts';
import { openMemoryStore } from '../../../src/store/testing.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { buildTask, freezeOk, uuidOf } from '../../support/builders.ts';
import {
  confirmedRuntime,
  createGrantStart,
  proposeAndConfirm,
  selectionFor,
} from '../../support/runtime.ts';
import { PREPARE_DATA, agentData } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';

// #256: what waits on the user is readable from the commands the assistant is pointed at.

const OWNER: Caller = { grant: { actor: 'owner', roles: ['read', 'operate', 'admin'] } };
const PAUSE = { reason: 'upgrade cuesura', by: 'assistant', at: 1_000 };

/** A started task paused while its coder ran; the coder's end leaves it WAITING on `paused`. */
function paused(d: StoreDriver, n: number) {
  const t = buildTask({ id: uuidOf(n) });
  createGrantStart(d, t, 'direct-pr');
  pauseRunning(d, t);
  return t;
}

function pauseRunning(d: StoreDriver, t: CanonicalTask): void {
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  d.must(t.id, { kind: 'pause', reason: 'look at the plan first' });
  d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
}

/** Starts a task created with {@link ready}, then pauses it as {@link paused} does. */
function startAndPause(d: StoreDriver, t: CanonicalTask): void {
  d.must(t.id, { kind: 'request_execution' });
  const g = d.store.grantNext(d.now as never, [], { capacity: 4 });
  if (!g.ok) throw new Error(JSON.stringify(g));
  d.must(t.id, {
    kind: 'start',
    freeze: freezeOk(t, { limits: { max_wall_ms: 3_600_000 }, mode: 'direct-pr' }),
    runtime: confirmedRuntime(d, t),
  });
  pauseRunning(d, t);
}

/** A task with a confirmed run selection that has not been granted the slot. */
function ready(d: StoreDriver, n: number, o: Parameters<typeof buildTask>[0] = {}) {
  const t = buildTask({ id: uuidOf(n), ...o });
  d.must(t.id, { kind: 'create_task', task: t });
  proposeAndConfirm(d, t, selectionFor(t, 'direct-pr'));
  return t;
}

const items = (r: ReturnType<typeof inbox>): InboxEntry[] => (r.ok ? r.value.items : []);

describe('inbox lists a task that waits on the user without a question', () => {
  it('a paused task shows with its wait code, version and the command that gets it going', () => {
    const d = new StoreDriver(openMemoryStore());
    const t = paused(d, 1);
    const s = d.task(t.id);
    expect(s.wait?.detail.code).toBe('paused');
    expect(Object.values(s.questions)).toEqual([]);
    expect(items(inbox(d.store, OWNER, {}, { now: d.now }))).toMatchObject([
      {
        kind: 'wait',
        task_id: t.id,
        question_id: null,
        wait_code: 'paused',
        task_version: s.version,
        paused: { reason: 'look at the plan first' },
        next: {
          action: 'resume',
          command: `cusr task resume ${t.id} --expected-version ${s.version}`,
        },
      },
    ]);
  });

  it('a question the task waits on is listed once, with the answer command', () => {
    const d = new StoreDriver(openMemoryStore());
    const t = buildTask({ id: uuidOf(1) });
    createGrantStart(d, t, 'direct-pr');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      agentData('needs_input', { questions: ['Which encoding?'] }),
    );
    const listed = items(inbox(d.store, OWNER, {}, { now: d.now }));
    expect(listed).toHaveLength(1);
    const [q] = listed;
    expect(q).toMatchObject({ kind: 'question', blocking: true });
    expect(q?.next?.command).toBe(
      `cusr answer ${q?.question_id} --file FILE --expected-version ${d.task(t.id).version}`,
    );
  });
});

describe('inbox filters that name nothing are refused, not read as empty', () => {
  it('a task ID that is not a UUID or not a task', () => {
    const d = new StoreDriver(openMemoryStore());
    paused(d, 1);
    const bad = inbox(d.store, OWNER, { task_id: 'nope' });
    expect(!bad.ok && bad.error.code).toBe('invalid_request');
    const missing = inbox(d.store, OWNER, { task_id: uuidOf(999) });
    expect(!missing.ok && missing.error.code).toBe('task_not_found');
  });

  it('a project neither the config nor any task names', () => {
    const d = new StoreDriver(openMemoryStore());
    const t = paused(d, 1);
    const r = inbox(d.store, OWNER, { project: 'nope' }, { projects: [t.project] });
    expect(!r.ok && r.error).toMatchObject({
      code: 'not_found',
      details: { projects: [t.project] },
    });
    // Configured but without tasks, or with tasks but no longer configured: both are real projects.
    expect(inbox(d.store, OWNER, { project: 'fresh' }, { projects: ['fresh'] }).ok).toBe(true);
    expect(inbox(d.store, OWNER, { project: t.project }, { projects: [] }).ok).toBe(true);
  });
});

describe('inbox pages past its limit with a cursor', () => {
  it('reads every item one page at a time', () => {
    const d = new StoreDriver(openMemoryStore());
    const ids = [1, 2, 3].map((n) => paused(d, n).id);
    const seen: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const r = inbox(d.store, OWNER, { limit: 2, ...(after === undefined ? {} : { after }) });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      seen.push(...r.value.items.map((i) => i.task_id));
      if (r.value.next_after === null) break;
      expect(r.value.truncated).toBe(true);
      after = r.value.next_after;
    }
    expect(seen).toEqual(ids);
  });
});

describe('a paused queue is visible where a task waits for it', () => {
  it('explain of a task not started says so and points at queue resume', () => {
    const d = new StoreDriver(openMemoryStore());
    const t = ready(d, 1);
    const now = PAUSE.at + 5_000;
    const r = taskExplain(d.store, OWNER, { kind: 'task_explain', task_id: t.id }, now, {
      queuePause: () => PAUSE,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const e = r.value as Record<string, unknown>;
    expect(e['queue_paused']).toEqual({ ...PAUSE, age_ms: 5_000, command: 'cusr queue resume' });
    const actions = e['allowed_actions'] as { action: string; note: string }[];
    expect(actions.map((a) => a.action)).toEqual(['resume_queue', 'cancel']);
    expect(JSON.stringify(actions)).not.toContain('Waits for its turn');

    const unpaused = taskExplain(d.store, OWNER, { kind: 'task_explain', task_id: t.id }, now, {
      queuePause: () => null,
    });
    expect(unpaused.ok && (unpaused.value as Record<string, unknown>)['queue_paused']).toBeNull();
  });

  it('a started task is not held by the queue', () => {
    const d = new StoreDriver(openMemoryStore());
    const t = paused(d, 1);
    const r = taskExplain(d.store, OWNER, { kind: 'task_explain', task_id: t.id }, d.now, {
      queuePause: () => PAUSE,
    });
    expect(r.ok && (r.value as Record<string, unknown>)['queue_paused']).toBeNull();
  });

  it('board and report carry the pause, the board even when nothing else changed', () => {
    const d = new StoreDriver(openMemoryStore());
    ready(d, 1);
    const deps = {
      store: d.store,
      statusSince: statusSinceReader(d.store),
      now: () => PAUSE.at + 10,
      queuePause: () => PAUSE,
    };
    const full = taskBoard(deps, OWNER, { kind: 'task_board' });
    if (!full.ok) throw new Error(JSON.stringify(full.error));
    const view = { ...PAUSE, age_ms: 10, command: 'cusr queue resume' };
    expect((full.value as Record<string, unknown>)['queue_paused']).toEqual(view);
    const watermark = (full.value as { watermark: number }).watermark;
    const same = taskBoard(deps, OWNER, { kind: 'task_board', if_changed_since: watermark });
    expect(same.ok && same.value).toMatchObject({ unchanged: true, queue_paused: view });
    const rep = report(deps, OWNER, { kind: 'report', since: 0 });
    expect(rep.ok && (rep.value as Record<string, unknown>)['queue_paused']).toEqual(view);
  });
});

describe('report gives what it takes to act on a task that needs you', () => {
  it('lists task_version, the pause and the next command', () => {
    const d = new StoreDriver(openMemoryStore());
    const t = paused(d, 1);
    const r = report(
      { store: d.store, statusSince: statusSinceReader(d.store), now: () => d.now },
      OWNER,
      { kind: 'report', since: 0 },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const projects = (r.value as { projects: { needs_you: { items: unknown[] } }[] }).projects;
    expect(projects[0]?.needs_you.items).toMatchObject([
      {
        task_id: t.id,
        wait_code: 'paused',
        task_version: d.task(t.id).version,
        pause: { reason: 'look at the plan first' },
        next: { action: 'resume' },
        questions: [],
      },
    ]);
  });
});

describe('a dependency wait names the prerequisite holding it (#256)', () => {
  it('reads the prerequisite as it is now, not as triage saw it', () => {
    const d = new StoreDriver(openMemoryStore());
    const dep = ready(d, 1);
    const t = buildTask({ id: uuidOf(2), depends_on: [dep.id] });
    d.must(t.id, { kind: 'create_task', task: t });
    expect(d.task(t.id).wait?.detail).toMatchObject({
      code: 'dependency_pending',
      deps: { [dep.id]: 'READY' },
    });
    startAndPause(d, dep);
    const r = taskExplain(d.store, OWNER, { kind: 'task_explain', task_id: t.id }, d.now);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const e = r.value as {
      wait: { detail: { deps: Record<string, string> } };
      prerequisites: unknown[];
      allowed_actions: { action: string; note: string }[];
    };
    expect(e.wait.detail.deps).toEqual({ [dep.id]: 'WAITING' });
    expect(e.prerequisites).toEqual([
      expect.objectContaining({
        task_id: dep.id,
        status: 'WAITING',
        wait_code: 'paused',
        paused: true,
        needs_user: true,
      }),
    ]);
    expect(e.allowed_actions[0]?.note).toContain(`Blocked by ${dep.id} (WAITING, paused)`);
  });
});

describe('next follows the order task explain lists (#256 review)', () => {
  const waiting = (code: 'missing_acceptance' | 'config_invalid' | 'effect_unknown') =>
    ({
      ...buildTaskState(),
      status: 'WAITING',
      wait: {
        reason: 'policy',
        detail: { code },
        resume_when: [],
        exit_paths: [],
        resume: { kind: 'none' },
      },
    }) as TaskState;

  it.each(['missing_acceptance', 'config_invalid'] as const)(
    '%s: the step without a command comes first, never the cancel after it',
    (code) => {
      const next = nextAction(waiting(code), false);
      expect(next).toMatchObject({ action: 'fix_external', command: null });
      expect(next?.note).not.toBe('');
    },
  );

  it('an effect_unknown wait recorded without its start counts from the status change', () => {
    const s = waiting('effect_unknown');
    const store = {
      taskIdsByStatus: () => [s.id],
      readTask: () => s,
    } as unknown as Store;
    const now = EFFECT_UNKNOWN_ATTENTION_MS + 10;
    expect(items(inbox(store, OWNER, {}, { now }))).toEqual([]);
    expect(
      items(inbox(store, OWNER, {}, { now, statusSince: () => 0 })).map((i) => i.wait_code),
    ).toEqual(['effect_unknown']);
  });
});

function buildTaskState(): TaskState {
  const d = new StoreDriver(openMemoryStore());
  const t = buildTask({ id: uuidOf(50) });
  d.must(t.id, { kind: 'create_task', task: t });
  return d.task(t.id);
}
