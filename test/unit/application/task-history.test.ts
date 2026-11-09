import { describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import { taskHistory } from '../../../src/application/queries.ts';
import type { Store } from '../../../src/store/index.ts';
import { openMemoryStore } from '../../../src/store/testing.ts';
import { buildTask } from '../../support/builders.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { createAndStart } from '../../support/store-flows.ts';

const OWNER: Caller = { grant: { actor: 'owner', roles: ['read', 'operate', 'admin'] } };

type Page = { events: { seq: number; at: string | null }[]; next_cursor: number; more: boolean };

/** Counts the event rows each read returns, so a test sees what the query had to read. */
function counting(store: Store): { store: Store; rows: number[] } {
  const rows: number[] = [];
  const wrapped = new Proxy(store, {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver) as unknown;
      if (key !== 'readEvents' && key !== 'readEventPage') return v;
      return (...args: unknown[]) => {
        const r = (v as (...a: unknown[]) => unknown[]).apply(target, args);
        rows.push(r.length);
        return r;
      };
    },
  });
  return { store: wrapped, rows };
}

function seeded() {
  const d = new StoreDriver(openMemoryStore());
  const t = buildTask();
  createAndStart(d, t);
  const all = d.store.readEvents(t.id);
  expect(all.length).toBeGreaterThan(4);
  return { d, id: t.id, last: all.length };
}

describe('task_history', () => {
  it('a page after a seq reads one event past the limit, not the rest of the log', () => {
    const { d, id, last } = seeded();
    const c = counting(d.store);
    const r = taskHistory(c.store, OWNER, {
      kind: 'task_history',
      task_id: id,
      after: 1,
      limit: 2,
    });
    expect(r.ok).toBe(true);
    const page = (r.ok ? r.value : null) as Page;
    expect(page.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(page).toMatchObject({ next_cursor: 3, more: true });
    expect(c.rows).toEqual([3]);
    expect(last).toBeGreaterThan(3);
  });

  it('the last forward page says there is no more', () => {
    const { d, id, last } = seeded();
    const r = taskHistory(d.store, OWNER, {
      kind: 'task_history',
      task_id: id,
      after: last - 2,
      limit: 2,
    });
    expect(r.ok && (r.value as Page)).toMatchObject({ next_cursor: last, more: false });
  });

  it('tail reads only the newest events, oldest first, each with the time of its trigger', () => {
    const { d, id, last } = seeded();
    const c = counting(d.store);
    const r = taskHistory(c.store, OWNER, {
      kind: 'task_history',
      task_id: id,
      tail: true,
      limit: 2,
    });
    const page = (r.ok ? r.value : null) as Page;
    expect(page.events.map((e) => e.seq)).toEqual([last - 1, last]);
    expect(page.events[0]?.at).toBe(new Date(d.now).toISOString());
    expect(page).toMatchObject({ next_cursor: last, more: false });
    expect(c.rows).toEqual([2]);
  });

  it('refuses tail together with after', () => {
    const { d, id } = seeded();
    const r = taskHistory(d.store, OWNER, {
      kind: 'task_history',
      task_id: id,
      tail: true,
      after: 1,
    });
    expect(r.ok).toBe(false);
  });
});
