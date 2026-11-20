import { afterEach, describe, expect, it } from 'vitest';
import { Redactor } from '../../../src/runner/redact.ts';
import { storeDb } from '../../../src/store/testing.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import { confirmedGoal, goalCommand, goalPlan, planUnit, resultOf } from '../../support/goal.ts';

// A reason a person writes may carry a secret by mistake; the daemon masks it, as production wires its
// redactor, before anything stores or shows it.
const live: SeededDaemon[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((d) => d.cleanup()));
});

async function daemon(): Promise<SeededDaemon> {
  const redactor = new Redactor();
  const sd = new SeededDaemon({}, () => ({ redact: (t: string) => redactor.text(t) }));
  live.push(sd);
  await sd.start();
  return sd;
}

/** Every row of every table of the daemon's store, as text. */
function everyRow(sd: SeededDaemon): Record<string, string> {
  const store = sd.daemon?.store;
  if (store === undefined) throw new Error('daemon not running');
  const db = storeDb(store);
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((r) => r.name);
  return Object.fromEntries(
    tables.map((t) => [t, JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())]),
  );
}

describe('goal cancel masks its reason before the goal records it', () => {
  it('the goal, its tasks and goal_show keep only the masked reason', async () => {
    const sd = await daemon();
    const g = await confirmedGoal(sd, goalPlan([planUnit('a'), planUnit('b')]));
    const secret = `ghp_${'c'.repeat(36)}`;
    const r = await goalCommand(sd, 'goal_cancel', g.goal_id, g.version, {
      reason: `stop, token ${secret}`,
    });
    expect(resultOf(r).goal_id).toBe(g.goal_id);

    for (const [table, rows] of Object.entries(everyRow(sd)))
      expect(rows, table).not.toContain(secret);
    const shown = await sd.query('owner', { kind: 'goal_show', goal_id: g.goal_id });
    const text = JSON.stringify(shown.envelope.data);
    expect(text).not.toContain(secret);
    expect(text).toContain('stop, token [REDACTED]');
  });
});

describe('a goal an earlier release cancelled with the reason as typed (#357)', () => {
  it('goal_show masks ended.reason and the GoalCancelled ledger line; stored rows and the plan stay', async () => {
    const redactor = new Redactor();
    let masking = false;
    const sd = new SeededDaemon({}, () =>
      masking ? { redact: (t: string) => redactor.text(t) } : {},
    );
    live.push(sd);
    await sd.start();
    const g = await confirmedGoal(sd, goalPlan([planUnit('a'), planUnit('b')]));
    const secret = `ghp_${'g'.repeat(36)}`;
    // The release before #354: no redactor for a reason a person writes.
    await goalCommand(sd, 'goal_cancel', g.goal_id, g.version, { reason: `stop, token ${secret}` });
    const before = await sd.query('owner', { kind: 'goal_show', goal_id: g.goal_id });
    expect(JSON.stringify(before.envelope.data)).toContain(secret);
    await sd.stop();

    masking = true;
    await sd.start();
    const db = storeDb(sd.daemon?.store as NonNullable<SeededDaemon['daemon']>['store']);
    const rows = () => ({
      goals: db.prepare('SELECT * FROM goals').all(),
      events: db.prepare('SELECT * FROM events WHERE task_id = ?').all(g.goal_id),
    });
    const stored = rows();
    expect(JSON.stringify(stored)).toContain(secret);

    const shown = await sd.query('owner', { kind: 'goal_show', goal_id: g.goal_id });
    const data = shown.envelope.data as Record<string, unknown>;
    expect(JSON.stringify(data)).not.toContain(secret);
    expect(data['ended']).toMatchObject({ reason: 'stop, token [REDACTED]' });
    const ledger = data['ledger'] as { text: string }[];
    expect(ledger.map((l) => l.text)).toContain('goal cancelled: stop, token [REDACTED]');
    // Everything but the cancel's reason is shown as before.
    const old = before.envelope.data as Record<string, unknown>;
    for (const key of Object.keys(old).filter((k) => !['ended', 'ledger'].includes(k)))
      expect(data[key], key).toEqual(old[key]);
    const oldLedger = old['ledger'] as { text: string }[];
    expect(ledger.filter((l) => !l.text.startsWith('goal cancelled:'))).toEqual(
      oldLedger.filter((l) => !l.text.startsWith('goal cancelled:')),
    );
    expect(rows()).toEqual(stored);
  });
});
