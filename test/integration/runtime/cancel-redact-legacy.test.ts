import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import { cancelTask } from '../../../src/application/cancel.ts';
import { notifyDependents } from '../../../src/application/dependency.ts';
import { admitCommand } from '../../../src/application/commands.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { join } from 'node:path';
import { STORE_FILE } from '../../../src/daemon/main.ts';
import { openFileStoreForTest, storeDb } from '../../../src/store/testing.ts';
import { authz, buildTask, uuidOf } from '../../support/builders.ts';
import type { SeededDaemon } from '../../support/daemon-task.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { FileContentStore } from '../../../src/adapters/publish-content.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { agentData, PREPARE_DATA, publishData } from '../../support/scenario.ts';
import { checkpointGates, reviewToCi } from '../../support/store-flows.ts';
import { seedGreenPr, useTui } from '../../support/tui-fixtures.ts';
import { Redactor } from '../../../src/runner/redact.ts';

// #357 over the daemon socket: a cancel the daemon before #354 stored with the reason as typed, then
// stopped before completing the request. Its rows stay as written; every copy the current daemon makes,
// in an event, a trigger outcome, the reply or the request ledger, is masked.
const tui = useTui();
const SECRET = `ghp_${'e'.repeat(36)}`;
const LEGACY = `stop, token ${SECRET}`;
const MASKED = 'stop, token [REDACTED]';
const HEAD = 'a'.repeat(40);
const OWNER: Caller = { grant: { actor: 'owner', roles: ['read', 'operate', 'admin'] } };

const body = (rid: string, t: CanonicalTask, version: number, force = false) => ({
  request_id: rid,
  kind: 'task_cancel',
  project: t.project,
  task_id: t.id,
  expected_version: version,
  payload: { reason: LEGACY, ...(force ? { force: true } : {}) },
});

/** The daemon before #354: the request admitted and run without a redactor, its ledger left open. */
async function legacyCancel(
  d: StoreDriver,
  cmd: ReturnType<typeof body>,
  o: { complete?: boolean; redact?: (text: string) => string } = {},
): Promise<void> {
  let n = 0;
  const admitted = admitCommand(
    { store: d.store, now: () => d.now, newId: () => uuidOf(60_000 + n++) },
    OWNER,
    cmd,
  );
  if (!admitted.ok) throw new Error(JSON.stringify(admitted.error));
  const r = await cancelTask(
    {
      store: d.store,
      now: () => d.now,
      newId: () => uuidOf(61_000 + n++),
      ...(o.redact === undefined ? {} : { redact: o.redact }),
    },
    admitted.value,
    cmd,
    OWNER,
  );
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  if (o.complete === true) {
    const done = d.store.completeCommand(
      cmd.request_id,
      { ok: true, value: r.value },
      d.now as EpochMs,
    );
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
}

/** `seedGreenPr` up to CI, which is still awaited. */
function seedAwaitingCi(d: StoreDriver, sd: SeededDaemon, t: CanonicalTask): void {
  createGrantStart(d, t, 'full-review', {}, { merge_method: 'squash' });
  const stored = new FileContentStore(join(sd.base, 'content')).put({
    pr_title: 'T',
    pr_body: 'body',
    commit_message: 'M',
  });
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  d.complete(
    t.id,
    d.pendingOne(t.id, 'start_agent').id,
    'succeeded',
    agentData('done', { content: stored }),
  );
  d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(HEAD));
  d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(HEAD));
  d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
    pr_ref: 'acme#7',
    head_sha: HEAD,
  });
  reviewToCi(d, t.id);
}

/** `SeededDaemon.seed` for a seed that awaits: the store stays open until it is done. */
async function seedAsync(sd: SeededDaemon, f: (d: StoreDriver) => Promise<void>): Promise<void> {
  const d = new StoreDriver(openFileStoreForTest(join(sd.dataDir, STORE_FILE)));
  d.now = sd.now;
  try {
    await f(d);
  } finally {
    sd.now = d.now;
    d.store.close();
  }
}

function rowsWith(sd: SeededDaemon, sql: string): unknown[] {
  const store = sd.daemon?.store;
  if (store === undefined) throw new Error('daemon not running');
  return (storeDb(store).prepare(sql).all() as Record<string, unknown>[]).filter((r) =>
    JSON.stringify(r).includes(SECRET),
  );
}

const ledger = (sd: SeededDaemon, rid: string) =>
  storeDb(sd.daemon?.store as NonNullable<SeededDaemon['daemon']>['store'])
    .prepare('SELECT status, result_json FROM command_ledger WHERE request_id = ?')
    .get(rid) as { status: string; result_json: string | null };

describe('a legacy cancel request sent again to the masking daemon (#357)', () => {
  it('a cancel that ended the task: reply and ledger masked, legacy rows and hash kept', async () => {
    const sd = tui.daemon({ recheck: { observed: () => {} } });
    const t = buildTask({ id: uuidOf(1), title: 'Plain' });
    const rid = uuidOf(500);
    let hash = '';
    let sent = 0;
    await seedAsync(sd, async (d) => {
      d.must(t.id, { kind: 'create_task', task: t });
      sent = d.task(t.id).version;
      await legacyCancel(d, body(rid, t, sent));
      expect(d.task(t.id).status).toBe('CANCELLED');
      hash = d.store.priorTrigger(`cmd:${rid}:cancel`)?.envelope.request_hash ?? '';
    });
    await sd.start();

    const r = await sd.command('owner', body(rid, t, sent));
    expect(r.envelope.ok).toBe(true);
    expect(JSON.stringify(r.envelope.data)).not.toContain(SECRET);
    const result = r.envelope.data?.['result'] as Record<string, unknown>;
    expect(result['terminal']).toMatchObject({ reason: MASKED });
    expect(result['cancellation']).toMatchObject({ reason: MASKED });
    const l = ledger(sd, rid);
    expect(l.status).toBe('completed');
    expect(l.result_json).not.toContain(SECRET);
    // What the earlier daemon wrote is left as it was.
    expect(sd.daemon?.store.priorTrigger(`cmd:${rid}:cancel`)?.envelope.request_hash).toBe(hash);
    expect(
      rowsWith(sd, 'SELECT type, payload_json FROM events').map(
        (e) => (e as { type: string }).type,
      ),
    ).toEqual(['CancelRequested', 'TaskCancelled']);
  });

  it('a force after a legacy cancel: CancelForced, TaskCancelled, its outcome and the ledger masked', async () => {
    const sd = tui.daemon({ recheck: { observed: () => {} } });
    const t = buildTask({ id: uuidOf(1), title: 'Stuck cancel' });
    sd.seed((d) => {
      seedGreenPr(d, sd, t, 'full-review', { title: 'T', message: 'M' });
      d.must(t.id, { kind: 'cancel', reason: LEGACY });
      expect(d.task(t.id).wait?.detail.code).toBe('cancel_reconcile');
    });
    await sd.start();
    const version = sd.daemon?.store.readTask(t.id)?.version ?? 0;
    const rid = uuidOf(501);

    const r = await sd.command('owner', body(rid, t, version, true));
    expect(r.envelope.ok).toBe(true);
    expect(sd.daemon?.store.readTask(t.id)?.status).toBe('CANCELLED');
    expect(JSON.stringify(r.envelope.data)).not.toContain(SECRET);
    expect(ledger(sd, rid).result_json).not.toContain(SECRET);
    // Only the legacy cancel's own rows still hold the secret.
    const events = rowsWith(sd, 'SELECT type, payload_json FROM events') as { type: string }[];
    expect(events.map((e) => e.type)).toEqual(['CancelRequested']);
    const triggers = rowsWith(
      sd,
      'SELECT dedup_key, envelope_json, outcome_json FROM accepted_triggers',
    );
    expect(triggers).toHaveLength(1);
    expect((triggers[0] as { dedup_key: string }).dedup_key).not.toContain(rid);
    const ended = sd.daemon?.store.readEvents(t.id).find((e) => e.type === 'TaskCancelled');
    expect(ended?.payload).toEqual({ reason: MASKED });
  });

  it('a legacy force accepted while effects were still in flight replays its outcome at the newer version', async () => {
    const sd = tui.daemon({ recheck: { observed: () => {} } });
    const t = buildTask({ id: uuidOf(1), title: 'Stuck cancel' });
    const rid = uuidOf(502);
    let forcedAt = 0;
    let sent = 0;
    await seedAsync(sd, async (d) => {
      seedAwaitingCi(d, sd, t);
      // CI is being awaited: the cancel and its force wait for it to settle.
      d.store.claimEffect(d.pendingOne(t.id, 'await_ci').id as Uuid, d.now as EpochMs);
      d.must(t.id, { kind: 'cancel', reason: 'first try' });
      sent = d.task(t.id).version;
      await legacyCancel(d, body(rid, t, sent, true));
      expect(d.task(t.id).cancellation?.forced).toBeDefined();
      expect(d.task(t.id).status).not.toBe('CANCELLED');
      forcedAt = d.store.priorTrigger(`cmd:${rid}:force`)?.envelope.expected_version ?? 0;
      expect(d.task(t.id).version).toBeGreaterThan(forcedAt);
    });
    await sd.start();

    const r = await sd.command('owner', body(rid, t, sent, true));
    expect(r.envelope.ok, JSON.stringify(r.envelope)).toBe(true);
    expect((r.envelope.data?.['result'] as Record<string, unknown>)['force_ignored']).toBeNull();
    expect(ledger(sd, rid).status).toBe('completed');
  });

  it('a legacy force that ended the task replays its outcome, not nothing_to_force', async () => {
    const sd = tui.daemon({ recheck: { observed: () => {} } });
    const t = buildTask({ id: uuidOf(1), title: 'Stuck cancel' });
    const rid = uuidOf(503);
    let sent = 0;
    await seedAsync(sd, async (d) => {
      seedGreenPr(d, sd, t, 'full-review', { title: 'T', message: 'M' });
      d.must(t.id, { kind: 'cancel', reason: 'first try' });
      sent = d.task(t.id).version;
      await legacyCancel(d, body(rid, t, sent, true));
      expect(d.task(t.id).status).toBe('CANCELLED');
    });
    await sd.start();

    const r = await sd.command('owner', body(rid, t, sent, true));
    expect(r.envelope.ok, JSON.stringify(r.envelope)).toBe(true);
    const result = r.envelope.data?.['result'] as Record<string, unknown>;
    expect(result['force_ignored']).toBeNull();
    expect(JSON.stringify(r.envelope.data)).not.toContain(SECRET);
  });

  it('a completed legacy request: its replay and request_show masked, the ledger row as stored', async () => {
    const sd = tui.daemon({ recheck: { observed: () => {} } });
    const t = buildTask({ id: uuidOf(1), title: 'Plain' });
    const rid = uuidOf(504);
    let sent = 0;
    await seedAsync(sd, async (d) => {
      d.must(t.id, { kind: 'create_task', task: t });
      sent = d.task(t.id).version;
      await legacyCancel(d, body(rid, t, sent), { complete: true });
    });
    await sd.start();
    const stored = ledger(sd, rid);
    expect(stored.status).toBe('completed');
    expect(stored.result_json).toContain(SECRET);

    const r = await sd.command('owner', body(rid, t, sent));
    expect(r.envelope.ok).toBe(true);
    expect(r.envelope.data?.['replayed']).toBe(true);
    expect(JSON.stringify(r.envelope.data)).not.toContain(SECRET);
    const result = r.envelope.data?.['result'] as Record<string, unknown>;
    expect(result['terminal']).toMatchObject({ reason: MASKED });
    expect(result['cancellation']).toMatchObject({ reason: MASKED });

    const shown = await sd.query('owner', { kind: 'request_show', request_id: rid });
    expect(shown.envelope.ok).toBe(true);
    expect(JSON.stringify(shown.envelope.data)).not.toContain(SECRET);
    expect(JSON.stringify(shown.envelope.data)).toContain(MASKED);
    expect(ledger(sd, rid)).toEqual(stored);
  });

  it('a legacy force masked by a redactor that no longer holds the literal replays its outcome', async () => {
    const sd = tui.daemon({ recheck: { observed: () => {} } });
    const t = buildTask({ id: uuidOf(1), title: 'Stuck cancel' });
    const rid = uuidOf(505);
    const literal = 'synthetic-literal-357';
    const before = new Redactor({ values: [literal] });
    const cmd = {
      ...body(rid, t, 0, true),
      payload: { reason: `gone, key ${literal}`, force: true },
    };
    await seedAsync(sd, async (d) => {
      seedGreenPr(d, sd, t, 'full-review', { title: 'T', message: 'M' });
      d.must(t.id, { kind: 'cancel', reason: 'first try' });
      cmd.expected_version = d.task(t.id).version;
      await legacyCancel(d, cmd, { redact: (x) => before.text(x) });
      expect(d.task(t.id).status).toBe('CANCELLED');
    });
    await sd.start();

    const r = await sd.command('owner', cmd);
    expect(r.envelope.ok, JSON.stringify(r.envelope)).toBe(true);
    expect((r.envelope.data?.['result'] as Record<string, unknown>)['force_ignored']).toBeNull();
    expect(ledger(sd, rid).status).toBe('completed');
  });

  describe('a reason typed in the shape of a cascade, holding a secret the daemon knows', () => {
    // A secret-named variable the daemon reads at start, as production does; its value is a task-ID shape.
    const FORGED = uuidOf(888_888);
    const typed = `dependency_failed:root=${FORGED} via=${uuidOf(1)} (CANCELLED)`;
    beforeEach(() => {
      process.env['CUSR_TEST_357_TOKEN'] = FORGED;
    });
    afterEach(() => {
      delete process.env['CUSR_TEST_357_TOKEN'];
    });

    it('a completed legacy request: replay and request_show masked', async () => {
      const sd = tui.daemon({ recheck: { observed: () => {} } });
      const t = buildTask({ id: uuidOf(1), title: 'Plain' });
      const rid = uuidOf(506);
      const cmd = { ...body(rid, t, 0), payload: { reason: typed } };
      await seedAsync(sd, async (d) => {
        d.must(t.id, { kind: 'create_task', task: t });
        cmd.expected_version = d.task(t.id).version;
        await legacyCancel(d, cmd, { complete: true });
      });
      await sd.start();
      const stored = ledger(sd, rid);
      expect(stored.result_json).toContain(FORGED);

      const r = await sd.command('owner', cmd);
      expect(r.envelope.ok).toBe(true);
      expect(JSON.stringify(r.envelope.data)).not.toContain(FORGED);
      const shown = await sd.query('owner', { kind: 'request_show', request_id: rid });
      expect(JSON.stringify(shown.envelope.data)).not.toContain(FORGED);
      expect(ledger(sd, rid)).toEqual(stored);
    });

    it('a force after a legacy cancel: TaskCancelled, outcome, reply and ledger masked', async () => {
      const sd = tui.daemon({ recheck: { observed: () => {} } });
      const t = buildTask({ id: uuidOf(1), title: 'Stuck cancel' });
      sd.seed((d) => {
        seedGreenPr(d, sd, t, 'full-review', { title: 'T', message: 'M' });
        d.must(t.id, { kind: 'cancel', reason: typed }, { authz: authz(['operate'], 'owner') });
      });
      await sd.start();
      const rid = uuidOf(507);
      const version = sd.daemon?.store.readTask(t.id)?.version ?? 0;

      const r = await sd.command('owner', {
        ...body(rid, t, version, true),
        payload: { reason: 'gone', force: true },
      });
      expect(r.envelope.ok, JSON.stringify(r.envelope)).toBe(true);
      expect(sd.daemon?.store.readTask(t.id)?.status).toBe('CANCELLED');
      expect(JSON.stringify(r.envelope.data)).not.toContain(FORGED);
      expect(ledger(sd, rid).result_json).not.toContain(FORGED);
      const ended = sd.daemon?.store.readEvents(t.id).find((e) => e.type === 'TaskCancelled');
      expect(JSON.stringify(ended)).not.toContain(FORGED);
      const prior = sd.daemon?.store.priorTrigger(`cmd:${rid}:force`);
      expect(JSON.stringify(prior?.outcome)).not.toContain(FORGED);
      // The legacy request's own rows stay as written.
      const requested = sd.daemon?.store.readEvents(t.id).find((e) => e.type === 'CancelRequested');
      expect(requested?.payload).toMatchObject({ reason: typed });
    });

    it('a cascade an earlier release cancelled with that secret as its root: the reply masks it', async () => {
      const sd = tui.daemon({ recheck: { observed: () => {} } });
      const root = buildTask({ id: uuidOf(1), title: 'Root' });
      const child = buildTask({
        id: uuidOf(2),
        title: 'Child',
        source_key: 'cli:2',
        depends_on: [root.id],
      });
      sd.seed((d) => {
        d.must(root.id, { kind: 'create_task', task: root });
        d.must(child.id, { kind: 'create_task', task: child });
        d.must(root.id, { kind: 'cancel', reason: 'not needed' });
        notifyDependents(d.store, d.now);
        // As a release before #357 wrote it: the root copied from a reason text, here the secret.
        const db = storeDb(d.store);
        for (const [table, col, key] of [
          ['events', 'payload_json', 'task_id'],
          ['tasks', 'state_json', 'id'],
        ] as const)
          db.prepare(`UPDATE ${table} SET ${col} = replace(${col}, ?, ?) WHERE ${key} = ?`).run(
            `root=${root.id} `,
            `root=${FORGED} `,
            child.id,
          );
        expect(d.task(child.id).terminal?.reason).toContain(FORGED);
      });
      await sd.start();

      const version = sd.daemon?.store.readTask(child.id)?.version ?? 0;
      const r = await sd.command('owner', {
        ...body(uuidOf(508), child, version),
        payload: { reason: 'again' },
      });
      expect(r.envelope.ok, JSON.stringify(r.envelope)).toBe(true);
      expect(JSON.stringify(r.envelope.data)).not.toContain(FORGED);
      expect(ledger(sd, uuidOf(508)).result_json).not.toContain(FORGED);
    });
  });
});

describe('reads of a task an earlier release cancelled and forced with the reasons as typed (#357)', () => {
  it('task_show, task_history, task_explain and task_list mask only the cancel reasons', async () => {
    const sd = tui.daemon({ recheck: { observed: () => {} } });
    const t = buildTask({ id: uuidOf(1), title: 'Stuck cancel' });
    const forced = `repo gone, token ghp_${'f'.repeat(36)}`;
    sd.seed((d) => {
      seedGreenPr(d, sd, t, 'full-review', { title: 'T', message: 'M' });
      d.must(t.id, { kind: 'cancel', reason: LEGACY }, { authz: authz(['operate'], 'owner') });
      d.must(
        t.id,
        { kind: 'cancel', reason: forced, force: true },
        { authz: authz(['operate'], 'owner') },
      );
      expect(d.task(t.id).status).toBe('CANCELLED');
    });
    await sd.start();
    const store = sd.daemon?.store as NonNullable<SeededDaemon['daemon']>['store'];
    const stored = storeDb(store).prepare('SELECT * FROM events ORDER BY global_seq').all();

    const show = await sd.query('owner', { kind: 'task_show', task_id: t.id });
    expect(JSON.stringify(show.envelope.data)).not.toContain('ghp_');
    expect(show.envelope.data).toMatchObject({
      task_id: t.id,
      status: 'CANCELLED',
      terminal: { kind: 'CANCELLED', reason: MASKED },
    });

    const h = await sd.query('owner', { kind: 'task_history', task_id: t.id, limit: 500 });
    expect(JSON.stringify(h.envelope.data)).not.toContain('ghp_');
    const events = h.envelope.data?.['events'] as { seq: number; type: string; payload: unknown }[];
    expect(events.find((e) => e.type === 'CancelRequested')?.payload).toMatchObject({
      reason: MASKED,
    });
    expect(events.find((e) => e.type === 'CancelForced')?.payload).toMatchObject({
      reason: 'repo gone, token [REDACTED]',
    });
    expect(events.find((e) => e.type === 'TaskCancelled')?.payload).toEqual({ reason: MASKED });
    // Every other event is shown as stored.
    const others = store
      .readEvents(t.id)
      .filter((e) => !['CancelRequested', 'CancelForced', 'TaskCancelled'].includes(e.type));
    expect(others.length).toBeGreaterThan(5);
    for (const e of others)
      expect(events.find((x) => x.seq === e.seq)?.payload, e.type).toEqual(e.payload);

    const explain = await sd.query('owner', { kind: 'task_explain', task_id: t.id });
    expect(JSON.stringify(explain.envelope.data)).not.toContain('ghp_');
    const list = await sd.query('owner', { kind: 'task_list' });
    expect(JSON.stringify(list.envelope.data)).not.toContain('ghp_');

    // The stored rows are as the earlier release wrote them.
    expect(storeDb(store).prepare('SELECT * FROM events ORDER BY global_seq').all()).toEqual(
      stored,
    );
    expect(JSON.stringify(stored)).toContain(SECRET);
  });
});
