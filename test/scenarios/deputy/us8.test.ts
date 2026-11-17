import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withDeputyDecisions } from '../../../src/adapters/github/publish.ts';
import type { HarnessInput } from '../../../src/adapters/ports.ts';
import type { Caller } from '../../../src/application/authz.ts';
import { statusSinceReader } from '../../../src/application/board.ts';
import { contentDecisions, taskDecisions } from '../../../src/application/deputy-decisions.ts';
import { goalShow } from '../../../src/application/goals.ts';
import { renderReport } from '../../../src/cli/render.ts';
import { taskShow } from '../../../src/application/queries.ts';
import { report } from '../../../src/application/report.ts';
import { writeDecisionsNote } from '../../../src/daemon/decisions-note.ts';
import type { GoalTrigger } from '../../../src/domain/goal.ts';
import type { TaskState } from '../../../src/domain/state.ts';
import { waiversSection } from '../../../src/engine/waivers.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { Store } from '../../../src/store/index.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, ownerAuthz, uuidOf } from '../../support/builders.ts';
import { deputyDaemon, deputyTurn, handoffBody, type DeputyDaemon } from '../../support/deputy.ts';
import { goalPlan, planUnit } from '../../support/goal.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { agentData, PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// 007 US8, SC-007 (T093): every decision of the deputy shows in `decisions.md`, `report`, `goal show`,
// the task's detail and history and the unit's PR body, with goal, task, incident, action, reason,
// hypothesis, criterion and measured result; a waiver always shows as waived, never as passed.

const HOUR = 3_600_000;
const GOAL = '0192aaaa-0000-7000-8000-0000000000b8';
const trial = { hypothesis: 'the mirror is back', expect: 'prepare passes' };
const live: DeputyDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.sd.cleanup();
});

function spendBackoff(d: StoreDriver, taskId: string): void {
  const failed = { ...PREPARE_DATA, setup: { ran: true, passed: false } };
  for (let i = 0; i < 12 && d.task(taskId).wait?.detail.code !== 'backoff_exhausted'; i++) {
    d.complete(taskId, d.pendingOne(taskId, 'prepare').id, 'succeeded', failed);
    d.now += 300_000;
    d.fire();
  }
  expect(d.task(taskId).wait?.detail.code).toBe('backoff_exhausted');
}

function seedGoal(store: Store, taskId: string): void {
  const plan = goalPlan([planUnit('a')]);
  const triggers: GoalTrigger[] = [
    { kind: 'add', project: 'acme', base_branch: 'main', request: 'r', hints: {} },
    { kind: 'propose', plan, plan_version: 0, plan_hash: 'sha256:p1' },
    { kind: 'confirm', plan_hash: 'sha256:p1', units: { a: taskId } },
  ];
  triggers.forEach((trigger, i) => {
    const r = store.goals.accept({
      goal_id: GOAL,
      dedup_key: `seed:${i}`,
      now: 1,
      actor: 'owner',
      trigger,
    });
    if (!r.ok || r.value.decision.kind !== 'accepted') throw new Error(JSON.stringify(r));
  });
}

const version = (store: Store, id: string): number => store.readTask(id as Uuid)?.version ?? -1;
const turnOf = (input: HarnessInput): string => input.deputy_turn as string;
type Data = Record<string, unknown>;
const data = (r: { envelope: { ok: boolean; data?: unknown } }): Data => {
  expect(r.envelope.ok, JSON.stringify(r.envelope)).toBe(true);
  return r.envelope.data as Data;
};

/** One unit of a goal at `backoff_exhausted`; the deputy's turn continues it with a trial. */
async function decided() {
  const t = buildTask({
    goal: { id: GOAL as Uuid, unit_key: 'a', role: 'unit', depends_on_units: [] },
  });
  const ctx: { d: StoreDriver | null } = { d: null };
  const x: DeputyDaemon = deputyDaemon([
    {
      kind: 'turn_ended',
      act: async (input) => {
        const store = (ctx.d as StoreDriver).store;
        const r = await x.asDeputy(turnOf(input), {
          kind: 'task_continue',
          task_id: t.id,
          expected_version: version(store, t.id),
          payload: {},
          reason: 'transient network error',
          trial,
        });
        expect(r.envelope.ok, JSON.stringify(r.envelope)).toBe(true);
        // The same failure again: the trial's result is measured at this next incident.
        spendBackoff(ctx.d as StoreDriver, t.id);
        await x.asDeputy(turnOf(input), handoffBody('handover', 'environment'));
      },
    },
  ]);
  live.push(x);
  let seeded: StoreDriver | null = null;
  x.sd.seed((d) => {
    seeded = d;
    seedGoal(d.store, t.id);
    createGrantStart(d, t, 'direct-pr', { limits: { max_wall_ms: 24 * HOUR } });
    spendBackoff(d, t.id);
  });
  const running = await x.sd.start();
  const d = new StoreDriver(running.store);
  d.now = (seeded as StoreDriver | null)?.now ?? d.now;
  ctx.d = d;
  await x.deputy().round();
  await x.deputy().idle();
  const [turn] = running.store.deputy.turnsOf({ task_id: t.id });
  if (turn === undefined) throw new Error('no turn');
  return { x, t, store: running.store, turn };
}

describe('US8: what the deputy did shows where the owner already looks', () => {
  it('scenario 1: each decision has goal, task, incident, action, reason, hypothesis, criterion and result', async () => {
    const { x, t, store, turn } = await decided();
    const decision = {
      actor: 'deputy',
      goal_id: GOAL,
      task_id: t.id,
      unit_key: 'a',
      turn_id: turn.turn_id,
      incident: turn.incident,
      action: 'task_continue',
      reason: 'transient network error',
      hypothesis: trial.hypothesis,
      expect: trial.expect,
      applied: true,
      result: { signature_changed: false, errors_delta: 0, tree_changed: false, progressed: false },
    };
    expect(turn.incident).toMatch(/backoff_exhausted/);

    const rep = data(await x.sd.query('owner', { kind: 'report', since: 0 }));
    const [project] = rep['projects'] as Data[];
    expect((project?.['deputy_decisions'] as { items: unknown[] }).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining(decision),
        expect.objectContaining({ action: 'handoff', detail: 'handover', turn_id: turn.turn_id }),
      ]),
    );
    expect((project?.['goals'] as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ goal_id: GOAL, status: 'running' }),
    ]);

    const goal = data(await x.sd.query('owner', { kind: 'goal_show', goal_id: GOAL }));
    expect(goal['deputy_decisions']).toEqual(
      expect.arrayContaining([expect.objectContaining(decision)]),
    );
    for (const kind of ['task_show', 'task_explain']) {
      const shown = data(await x.sd.query('owner', { kind, task_id: t.id }));
      expect(shown['deputy_decisions']).toEqual(
        expect.arrayContaining([expect.objectContaining(decision)]),
      );
    }

    // History: the command's events carry its actor, reason, turn and trial (T096).
    const history = data(
      await x.sd.query('owner', { kind: 'task_history', task_id: t.id, limit: 500 }),
    );
    expect(history['events']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: 'deputy',
          reason: 'transient network error',
          turn_id: turn.turn_id,
          trial,
        }),
      ]),
    );

    // decisions.md, rebuilt by code from the same records.
    const file = join(x.sd.dataDir, 'decisions.md');
    expect(writeDecisionsNote({ store, file, redactor: new Redactor({ values: [] }) })).toBe(true);
    const note = readFileSync(file, 'utf8');
    for (const text of [
      t.id,
      GOAL,
      turn.turn_id,
      'task_continue',
      'transient network error',
      trial.hypothesis,
      trial.expect,
      'signature unchanged',
    ])
      expect(note).toContain(text);
    // Nothing changed: the file is left alone.
    expect(writeDecisionsNote({ store, file, redactor: new Redactor({ values: [] }) })).toBe(false);

    // The unit's PR body lists the decisions that shaped its content (FR-111).
    const s = store.readTask(t.id) as TaskState;
    const body = withDeputyDecisions('Fixes add.', contentDecisions(taskDecisions(store, s)));
    expect(body).toContain('## Decisions made by the deputy');
    expect(body).toContain('transient network error');
    expect(body).toContain(trial.hypothesis);
    expect(withDeputyDecisions('Fixes add.', [])).toBe('Fixes add.');
  });
});

describe('US8: a waiver shows as waived, never as passed', () => {
  const tempDir = useTempDir('cusr-us8-');
  const OWNER: Caller = { grant: { actor: 'owner', roles: ['read', 'operate', 'admin'] } };

  it('lists the waiver in report, task detail, decisions.md and the PR body as waived', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', {
      results: [
        { gate: 'build', passed: true },
        { gate: 'unit', passed: false, signature: 'u', log_excerpt: 'error: flaky timer' },
        { gate: 'lint', passed: true },
      ],
    });
    d.must(
      t.id,
      { kind: 'waive', target: { kind: 'gate', key: 'unit' }, evidence: 'timer flake #12' },
      {
        authz: {
          ...ownerAuthz(),
          actor: 'deputy',
          roles: ['read', 'operate'],
          reason: 'known flaky timer',
          turn_id: 'turn-1',
        },
      },
    );
    const waived: unknown = expect.objectContaining({
      status: 'waived',
      target: { kind: 'gate', key: 'unit' },
      by: 'deputy',
      turn_id: 'turn-1',
      reason: 'known flaky timer',
    });

    const r = report(
      { store: d.store, statusSince: statusSinceReader(d.store), now: () => d.now },
      OWNER,
      { kind: 'report', since: 0 },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const [project] = (r.value as { projects: Data[] }).projects;
    expect((project?.['waivers'] as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ task_id: t.id }),
    ]);
    expect((project?.['waivers'] as { items: unknown[] }).items).toEqual([waived]);

    const shown = taskShow(d.store, OWNER, { kind: 'task_show', task_id: t.id });
    if (!shown.ok) throw new Error(JSON.stringify(shown.error));
    expect((shown.value as Data)['waivers']).toEqual([waived]);

    const file = join(tempDir(), 'decisions.md');
    writeDecisionsNote({ store: d.store, file, redactor: new Redactor({ values: [] }) });
    const note = readFileSync(file, 'utf8');
    expect(note).toContain('waived');
    expect(note).toContain('gate unit');
    expect(note).not.toMatch(/\bpassed\b/);

    const section = waiversSection(d.task(t.id).run.waivers ?? []);
    expect(section).toContain('waived');
    expect(section).not.toMatch(/\bpassed\b/);
  });
});

// A canary credential the configured redactor masks (review #300, S1).
const TOKEN = `ghp_${'A1b2C3d4E5f6G7h8I9j0'}K1l2M3n4O5p6Q7r8`;
const REDACTOR = new Redactor({ values: [] });
const redact = (t: string): string => REDACTOR.text(t);
const OWNER_CALLER: Caller = { grant: { actor: 'owner', roles: ['read', 'operate', 'admin'] } };

/** A completed command of the deputy in the ledger, as `admitCommand` and its handler leave it. */
function ledgerDecision(
  store: Store,
  o: {
    readonly request_id: string;
    readonly kind: string;
    readonly target: string;
    readonly reason: string;
    readonly turn_id?: string | null;
    readonly trial?: unknown;
    readonly now: number;
  },
): void {
  const a = store.admitCommand({
    request_id: o.request_id,
    actor: 'deputy',
    kind: o.kind,
    command_hash: `sha256:${o.request_id}`,
    project: 'acme',
    task_id: o.target,
    assigned_ids: [],
    now: o.now,
    reason: o.reason,
    turn_id: o.turn_id ?? null,
    trial: o.trial ?? null,
  });
  if (!a.ok) throw new Error(JSON.stringify(a.error));
  const c = store.completeCommand(o.request_id, { ok: true, value: {} }, o.now as EpochMs);
  if (!c.ok) throw new Error(JSON.stringify(c.error));
}

function goalAccept(
  store: Store,
  goalId: string,
  trigger: GoalTrigger,
  key: string,
  actor = 'owner',
) {
  const r = store.goals.accept({ goal_id: goalId, dedup_key: key, now: 10, actor, trigger });
  if (!r.ok || r.value.decision.kind !== 'accepted') throw new Error(JSON.stringify(r));
}

describe('US8: secrets in what the deputy wrote are masked where it is shown (review #300, S1)', () => {
  const tempDir = useTempDir('cusr-us8-secret-');

  it('report, task show and goal show mask the reason and the trial of a decision', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr');
    ledgerDecision(d.store, {
      request_id: uuidOf(7001),
      kind: 'task_continue',
      target: t.id,
      reason: `the token ${TOKEN} expired`,
      trial: { hypothesis: `rotate ${TOKEN}`, expect: `no 401 for ${TOKEN}` },
      now: d.now,
    });
    const r = report(
      { store: d.store, statusSince: statusSinceReader(d.store), now: () => d.now, redact },
      OWNER_CALLER,
      { kind: 'report', since: 0 },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const text = JSON.stringify(r.value);
    expect(text).toContain('task_continue');
    expect(text).not.toContain(TOKEN);
    const shown = taskShow(d.store, OWNER_CALLER, { kind: 'task_show', task_id: t.id }, redact);
    if (!shown.ok) throw new Error(JSON.stringify(shown.error));
    expect(JSON.stringify((shown.value as Data)['deputy_decisions'])).toContain('expired');
    expect(JSON.stringify(shown.value)).not.toContain(TOKEN);
  });
});

describe('US8: decisions on the goal itself (review #300, P1)', () => {
  const tempDir = useTempDir('cusr-us8-goal-');
  const G = '0192aaaa-0000-7000-8000-0000000000c1';

  it('lists the plan turn and its proposal before the plan is confirmed, and an amendment on replan', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const store = d.store;
    goalAccept(
      store,
      G,
      { kind: 'add', project: 'acme', base_branch: 'main', request: 'r', hints: {} },
      'seed:add',
    );
    const plan = deputyTurn({
      turn_id: uuidOf(7100),
      goal_id: G,
      task_id: null,
      kind: 'plan',
      incident: `${G}:0:new`,
    });
    if (!store.deputy.startTurn(plan).ok) throw new Error('turn');
    const propose = uuidOf(7101);
    ledgerDecision(store, {
      request_id: propose,
      kind: 'goal_propose',
      target: G,
      reason: 'one unit per layer',
      turn_id: plan.turn_id,
      now: 20,
    });
    goalAccept(
      store,
      G,
      { kind: 'propose', plan: goalPlan([planUnit('a')]), plan_version: 0, plan_hash: 'sha256:p1' },
      `cmd:${propose}:goal`,
      'deputy',
    );
    store.deputy.setHandoff(plan.turn_id, {
      cause: 'spec',
      decision: 'proposed a plan of one unit',
      ruled_out: [],
      next_look: null,
    });
    store.deputy.finishTurn(plan.turn_id, { state: 'done', now: 30 });

    const goalDecision: unknown = expect.objectContaining({
      goal_id: G,
      task_id: null,
      action: 'goal_propose',
      turn_id: plan.turn_id,
      incident: `${G}:0:new`,
      reason: 'one unit per layer',
      detail: expect.stringContaining('plan v1') as unknown,
    });
    const shown = goalShow(store, OWNER_CALLER, { kind: 'goal_show', goal_id: G });
    if (!shown.ok) throw new Error(JSON.stringify(shown.error));
    expect((shown.value as Data)['deputy_decisions']).toEqual([
      goalDecision,
      expect.objectContaining({ action: 'handoff', detail: 'proposed a plan of one unit' }),
    ]);
    const r = report(
      { store, statusSince: statusSinceReader(store), now: () => 100 },
      OWNER_CALLER,
      { kind: 'report', since: 0 },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const [project] = (r.value as { projects: Data[] }).projects;
    expect((project?.['deputy_decisions'] as { items: unknown[] }).items).toEqual(
      expect.arrayContaining([goalDecision]),
    );
    // The CLI prints a goal's decision too, with no task.
    expect(renderReport(r.value)).toContain('goal_propose');
    const file = join(tempDir(), 'decisions.md');
    writeDecisionsNote({ store, file, redactor: REDACTOR });
    const note = readFileSync(file, 'utf8');
    expect(note).toContain('goal_propose');
    expect(note).toContain('one unit per layer');
    expect(note).toContain('proposed a plan of one unit');

    // Confirmed, then a unit failed: the deputy amends the plan while the goal waits for a new one.
    goalAccept(
      store,
      G,
      { kind: 'confirm', plan_hash: 'sha256:p1', units: { a: uuidOf(7102) } },
      'seed:confirm',
    );
    goalAccept(store, G, { kind: 'replan', reason: 'unit_failed:a' }, 'seed:replan', 'system:goal');
    expect(store.goals.read(G)?.status).toBe('replan');
    const amend = uuidOf(7103);
    ledgerDecision(store, {
      request_id: amend,
      kind: 'goal_amend',
      target: G,
      reason: 'replace the failed unit',
      now: 40,
    });
    const again = goalShow(store, OWNER_CALLER, { kind: 'goal_show', goal_id: G });
    if (!again.ok) throw new Error(JSON.stringify(again.error));
    expect((again.value as Data)['deputy_decisions']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'goal_amend', reason: 'replace the failed unit' }),
      ]),
    );
  });
});

describe('US8: a turn acting on another task of its goal (review #300, P3)', () => {
  const tempDir = useTempDir('cusr-us8-cross-');

  it("keeps the incident of the turn's own task", () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const a = buildTask({ id: uuidOf(7200) });
    const b = buildTask({ id: uuidOf(7201) });
    createGrantStart(d, a, 'direct-pr');
    d.must(b.id, { kind: 'create_task', task: b });
    const turn = deputyTurn({
      turn_id: uuidOf(7202),
      goal_id: a.id,
      task_id: a.id,
      incident: `${a.id}:1:backoff_exhausted:9`,
    });
    if (!d.store.deputy.startTurn(turn).ok) throw new Error('turn');
    ledgerDecision(d.store, {
      request_id: uuidOf(7203),
      kind: 'task_pause',
      target: b.id,
      reason: 'b overlaps a',
      turn_id: turn.turn_id,
      now: d.now,
    });
    expect(taskDecisions(d.store, d.task(b.id))).toEqual([
      expect.objectContaining({ turn_id: turn.turn_id, incident: turn.incident }),
    ]);
  });
});
