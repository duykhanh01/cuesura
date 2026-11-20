import { describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import { cancelTask } from '../../../src/application/cancel.ts';
import { admitCommand, type Admitted } from '../../../src/application/commands.ts';
import { notifyDependents } from '../../../src/application/dependency.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import { openFileStoreForTest, storeDb } from '../../../src/store/testing.ts';
import { authz, buildTask, uuidOf } from '../../support/builders.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// #357: reasons stored before the daemon masked them (#354) meet a daemon that does.
const tempDir = useTempDir('cusr-cancel-redact-');
const setup = () => new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
const redactor = new Redactor();
const redact = (t: string): string => redactor.text(t);
const SECRET = `ghp_${'d'.repeat(36)}`;

const OWNER: Caller = { grant: { actor: 'owner', roles: ['read', 'operate', 'admin'] } };

/** Admits `cmd` as the daemon does: a request ID seen before with the same command is `existing`. */
function admit(d: StoreDriver, cmd: ReturnType<typeof input>): Admitted {
  let n = 0;
  const r = admitCommand(
    { store: d.store, now: () => d.now, newId: () => uuidOf(70_000 + n++) },
    OWNER,
    cmd,
  );
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function created(d: StoreDriver): CanonicalTask {
  const t = buildTask();
  d.must(t.id, { kind: 'create_task', task: t });
  return t;
}

const input = (t: CanonicalTask, version: number, reason: string, rid = uuidOf(1)) => ({
  request_id: rid,
  kind: 'task_cancel',
  project: t.project,
  task_id: t.id,
  expected_version: version,
  payload: { reason },
});

const rows = (d: StoreDriver, table: string): string =>
  JSON.stringify(storeDb(d.store).prepare(`SELECT * FROM "${table}"`).all());

describe('a cancel request sent again across the upgrade that masks reasons (#357)', () => {
  it('replays the cancel the earlier daemon stored for the typed reason, writing nothing', async () => {
    const d = setup();
    const t = created(d);
    const cmd = input(t, d.task(t.id).version, `stop, token ${SECRET}`);
    // The daemon before #354 stored the reason as typed and stopped before completing the request.
    const first = await cancelTask({ store: d.store, now: () => d.now }, admit(d, cmd), cmd, OWNER);
    expect(first.ok).toBe(true);
    const events = d.store.readEvents(t.id).length;

    const again = admit(d, cmd);
    expect(again.kind).toBe('existing');
    const r = await cancelTask({ store: d.store, now: () => d.now, redact }, again, cmd, OWNER);
    expect(r.ok).toBe(true);
    expect(d.store.readEvents(t.id)).toHaveLength(events);
    // The reply carries the stored reason masked.
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).toContain('stop, token [REDACTED]');
  });

  it('replays a cancel masked by a redactor that no longer holds the literal', async () => {
    const d = setup();
    const t = created(d);
    const literal = 'synthetic-literal-357';
    const before = new Redactor({ values: [literal] });
    const cmd = input(t, d.task(t.id).version, `stop, key ${literal}`);
    await cancelTask(
      { store: d.store, now: () => d.now, redact: (x) => before.text(x) },
      admit(d, cmd),
      cmd,
      OWNER,
    );
    const events = d.store.readEvents(t.id).length;

    const r = await cancelTask(
      { store: d.store, now: () => d.now, redact },
      admit(d, cmd),
      cmd,
      OWNER,
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(d.store.readEvents(t.id)).toHaveLength(events);
  });

  it('still refuses the same request ID carrying another reason, at admission', async () => {
    const d = setup();
    const t = created(d);
    const version = d.task(t.id).version;
    const cmd = input(t, version, `stop, token ${SECRET}`);
    await cancelTask({ store: d.store, now: () => d.now }, admit(d, cmd), cmd, OWNER);

    let n = 0;
    const other = admitCommand(
      { store: d.store, now: () => d.now, newId: () => uuidOf(72_000 + n++) },
      OWNER,
      input(t, version, `other, token ${SECRET}`),
    );
    expect(other.ok).toBe(false);
    expect(!other.ok && other.error).toMatchObject({ code: 'conflict' });
  });

  it('a request ID new to the ledger does not take a trigger stored under its key', async () => {
    const d = setup();
    const t = created(d);
    const cmd = input(t, d.task(t.id).version, 'stop');
    await cancelTask({ store: d.store, now: () => d.now }, admit(d, cmd), cmd, OWNER);
    const fresh = { ...admit(d, cmd), kind: 'new' } as Admitted;

    const r = await cancelTask({ store: d.store, now: () => d.now, redact }, fresh, cmd, OWNER);
    expect(!r.ok && r.error).toMatchObject({ code: 'conflict' });
  });

  it('a request first sent to the masking daemon is stored masked and replays as is', async () => {
    const d = setup();
    const t = created(d);
    const cmd = input(t, d.task(t.id).version, `stop, token ${SECRET}`);
    const deps = { store: d.store, now: () => d.now, redact };
    const first = await cancelTask(deps, admit(d, cmd), cmd, OWNER);
    expect(await cancelTask(deps, admit(d, cmd), cmd, OWNER)).toEqual(first);
    expect(rows(d, 'accepted_triggers')).not.toContain(SECRET);
    expect(rows(d, 'events')).not.toContain(SECRET);
  });
});

describe('a dependent of a task cancelled before reasons were masked (#357)', () => {
  it('gets the masked reason in its notification and its cancel', () => {
    const d = setup();
    const parent = created(d);
    const child = buildTask({ id: uuidOf(2), source_key: 'cli:2', depends_on: [parent.id] });
    d.must(child.id, { kind: 'create_task', task: child });
    // Stored as typed, as the daemon before #354 did.
    d.must(parent.id, { kind: 'cancel', reason: `stop, token ${SECRET}` });
    expect(d.task(parent.id).status).toBe('CANCELLED');

    const notices = notifyDependents(d.store, d.now, redact);
    expect(notices.map((n) => n.task_id)).toEqual([child.id]);
    const childTriggers = JSON.stringify(
      storeDb(d.store)
        .prepare('SELECT envelope_json, outcome_json FROM accepted_triggers WHERE task_id = ?')
        .all(child.id),
    );
    expect(childTriggers).not.toContain(SECRET);
    expect(childTriggers).toContain('stop, token [REDACTED]');
    expect(JSON.stringify(d.store.readEvents(child.id))).not.toContain(SECRET);
    expect(d.task(child.id)).toMatchObject({
      status: 'CANCELLED',
      terminal: { reason: `dependency_failed:root=${parent.id} via=${parent.id} (CANCELLED)` },
    });
  });

  it('a three-hop cascade keeps its root when a redactor literal equals that task ID', () => {
    const root = buildTask();
    // The redactor masks the root's ID, as a secret value that collides with it would.
    const colliding = new Redactor({ values: [root.id] });
    const mask = (x: string): string => colliding.text(x);
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir()), { redact: mask }));
    const chain = [root];
    for (const n of [2, 3, 4]) {
      const prev = chain.at(-1) as CanonicalTask;
      chain.push(buildTask({ id: uuidOf(n), source_key: `cli:${n}`, depends_on: [prev.id] }));
    }
    for (const t of chain) d.must(t.id, { kind: 'create_task', task: t });
    d.must(root.id, { kind: 'cancel', reason: `not needed, see ${root.id}` });

    for (let i = 0; i < 3; i++) notifyDependents(d.store, d.now, mask);
    for (let i = 1; i < chain.length; i++) {
      const t = chain[i] as CanonicalTask;
      const via = (chain[i - 1] as CanonicalTask).id;
      expect(d.task(t.id).terminal?.reason).toBe(
        `dependency_failed:root=${root.id} via=${via} (CANCELLED)`,
      );
    }
    // The person's reason is masked where the first dependent copies it.
    const first = JSON.stringify(
      storeDb(d.store)
        .prepare('SELECT envelope_json FROM accepted_triggers WHERE task_id = ?')
        .all((chain[1] as CanonicalTask).id),
    );
    expect(first).toContain('not needed, see [REDACTED]');
  });

  it('a reason a person typed in the shape of a cascade is masked and names no root', () => {
    const forged = uuidOf(999);
    const colliding = new Redactor({ values: [forged] });
    const mask = (x: string): string => colliding.text(x);
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir()), { redact: mask }));
    const parent = created(d);
    const child = buildTask({ id: uuidOf(2), source_key: 'cli:2', depends_on: [parent.id] });
    d.must(child.id, { kind: 'create_task', task: child });
    const typed = `dependency_failed:root=${forged} via=${parent.id} (CANCELLED)`;
    // Stored as typed by an owner, as the daemon before #354 did.
    d.must(parent.id, { kind: 'cancel', reason: typed }, { authz: authz(['operate'], 'owner') });
    expect(d.task(parent.id).terminal?.reason).toBe(
      `dependency_failed:root=[REDACTED] via=${parent.id} (CANCELLED)`,
    );

    notifyDependents(d.store, d.now, mask);
    expect(d.task(child.id).terminal?.reason).toBe(
      `dependency_failed:root=${parent.id} via=${parent.id} (CANCELLED)`,
    );
    expect(JSON.stringify(d.store.readEvents(child.id))).not.toContain(forged);
    const triggers = JSON.stringify(
      storeDb(d.store).prepare('SELECT * FROM accepted_triggers WHERE task_id = ?').all(child.id),
    );
    expect(triggers).not.toContain(forged);
  });

  describe('a cascade an earlier release wrote, its root copied from a reason text', () => {
    /**
     * Turns the cascade `child` just recorded into what a release before #357 wrote: the root read from
     * the prerequisite's reason text instead of the notification, and no root in the notification.
     */
    function asOldRelease(d: StoreDriver, child: string, root: string, written: string): void {
      const db = storeDb(d.store);
      const from = `root=${root} `;
      const to = `root=${written} `;
      db.prepare(
        'UPDATE events SET payload_json = replace(payload_json, ?, ?) WHERE task_id = ?',
      ).run(from, to, child);
      db.prepare('UPDATE tasks SET state_json = replace(state_json, ?, ?) WHERE id = ?').run(
        from,
        to,
        child,
      );
      db.prepare(
        `UPDATE accepted_triggers SET envelope_json = json_remove(envelope_json, '$.trigger.provenance.root'),
           outcome_json = replace(outcome_json, ?, ?) WHERE task_id = ?`,
      ).run(from, to, child);
    }

    /** root ← mid ← leaf, with mid cancelled by the cascade as an earlier release recorded it. */
    function chain(written: string, mask: (x: string) => string) {
      const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir()), { redact: mask }));
      const root = created(d);
      const mid = buildTask({ id: uuidOf(2), source_key: 'cli:2', depends_on: [root.id] });
      d.must(mid.id, { kind: 'create_task', task: mid });
      d.must(root.id, { kind: 'cancel', reason: 'not needed' });
      notifyDependents(d.store, d.now, mask);
      asOldRelease(d, mid.id, root.id, written);
      // The leaf arrives after the upgrade, so the current release notifies it.
      const leaf = buildTask({ id: uuidOf(3), source_key: 'cli:3', depends_on: [mid.id] });
      d.must(leaf.id, { kind: 'create_task', task: leaf });
      expect(d.task(mid.id).terminal?.reason).toBe(
        `dependency_failed:root=${written} via=${root.id} (CANCELLED)`,
      );
      notifyDependents(d.store, d.now, mask);
      return { d, root, mid, leaf };
    }

    it('a valid but unrelated root that is also a secret: neither copied nor named', () => {
      const unrelated = uuidOf(777);
      const leak = new Redactor({ values: [unrelated] });
      const { d, root, mid, leaf } = chain(unrelated, (x) => leak.text(x));
      expect(d.task(leaf.id)).toMatchObject({
        status: 'CANCELLED',
        terminal: { reason: `dependency_failed:root=${root.id} via=${mid.id} (CANCELLED)` },
      });
      const rows = JSON.stringify(
        storeDb(d.store).prepare('SELECT * FROM accepted_triggers WHERE task_id = ?').all(leaf.id),
      );
      expect(rows).not.toContain(unrelated);
      expect(JSON.stringify(d.store.readEvents(leaf.id))).not.toContain(unrelated);
    });

    it('a malformed root: the dependent still ends, naming the root the notifications show', () => {
      const malformed = 'f'.repeat(36);
      const { d, root, mid, leaf } = chain(malformed, redact);
      expect(d.task(leaf.id)).toMatchObject({
        status: 'CANCELLED',
        terminal: { reason: `dependency_failed:root=${root.id} via=${mid.id} (CANCELLED)` },
      });
    });
  });

  it('an uppercase task ID stays the root down a three-hop cascade', () => {
    const d = setup();
    const root = buildTask({ id: '0192ABCD-0000-7000-8000-00000000000A' as Uuid });
    d.must(root.id, { kind: 'create_task', task: root });
    const tasks = [root];
    for (const n of [2, 3, 4]) {
      const prev = tasks.at(-1) as CanonicalTask;
      const t = buildTask({ id: uuidOf(n), source_key: `cli:${n}`, depends_on: [prev.id] });
      d.must(t.id, { kind: 'create_task', task: t });
      tasks.push(t);
    }
    d.must(root.id, { kind: 'cancel', reason: 'not needed' });
    for (let i = 0; i < 3; i++) notifyDependents(d.store, d.now, redact);
    expect(d.task((tasks[3] as CanonicalTask).id).terminal?.reason).toBe(
      `dependency_failed:root=${root.id} via=${(tasks[2] as CanonicalTask).id} (CANCELLED)`,
    );
  });
});
