import { describe, expect, it } from 'vitest';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { observation, toGreen } from '../../support/observation.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { createAndStart } from '../../support/store-flows.ts';
import { cliJson, LogFeed, useTui } from '../../support/tui-fixtures.ts';
import type { SeededDaemon } from '../../support/daemon-task.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';

// Issue #264: what `task explain`, `task show` and `task list` say about a hung attempt, why a task ended
// and a DONE nobody verified, read through the real CLI against a seeded daemon.

const tui = useTui();
const HOUR = 3_600_000;

type Data = Record<string, unknown>;
const data = async (sd: SeededDaemon, ...argv: string[]): Promise<Data> =>
  (await cliJson(sd, ...argv)).envelope.data as Data;

/** Started and past prepare: the coder attempt is running, its start_agent effect still pending. */
function toCode(d: StoreDriver, t: CanonicalTask): string {
  createAndStart(d, t);
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  return d.pendingOne(t.id, 'start_agent').id;
}

describe('a running attempt shows how long it has been silent', () => {
  it('explain two hours later differs from explain right after the start', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Hung' });
    sd.seed((d) => toCode(d, t));
    await sd.start();
    const fresh = await data(sd, 'task', 'explain', t.id);
    sd.now += 2 * HOUR;
    const later = await data(sd, 'task', 'explain', t.id);
    expect(later).not.toEqual(fresh);
    expect(later['status_since']).toBe(fresh['status_since']);
    expect(typeof later['status_since']).toBe('number');
    const [run] = later['running'] as Data[];
    // No runner took the attempt: nothing started it and it wrote nothing.
    expect(run).not.toHaveProperty('started_at');
    expect(run).not.toHaveProperty('last_output_at');
    expect(run?.['silent_ms']).toBe(
      ((fresh['running'] as Data[])[0]?.['silent_ms'] as number) + 2 * HOUR,
    );
  });

  it('names when the attempt last wrote output, and counts silence from there', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Talking' });
    sd.seed((d) => {
      createGrantStart(d, t, 'direct-pr');
      d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    });
    await sd.start();
    if (sd.daemon === null) throw new Error('not running');
    // Fed to the running daemon's store: a seeded operation without a unit is lost on recovery.
    const live = new StoreDriver(sd.daemon.store);
    live.now = sd.now;
    const before = Date.now();
    new LogFeed(sd).write(
      live,
      t.id,
      live.pendingOne(t.id, 'start_agent').id,
      uuidOf(500),
      'agent',
      [{ text: 'working' }],
    );
    const after = Date.now();
    sd.now = after + 2 * HOUR;
    const full = await data(sd, 'task', 'explain', t.id, '--full');
    const [run] = full['running'] as Data[];
    const output = run?.['last_output_at'] as number;
    expect(output).toBeGreaterThanOrEqual(before - 1_000);
    expect(output).toBeLessThanOrEqual(after + 1_000);
    expect(run?.['silent_ms']).toBe(sd.now - output);
    const summary = await data(sd, 'task', 'explain', t.id);
    expect((summary['running'] as Data[])[0]).toMatchObject({ last_output_at: output });
  });
});

describe('a finished task says why it ended', () => {
  it('explain, show and list carry the reason, a cascade cancel included; no deadline counts down', async () => {
    const sd = tui.daemon();
    const root = uuidOf(9);
    const reason = `dependency_failed:root=${root} via=${root} (CANCELLED)`;
    const t = buildTask({ id: uuidOf(1), title: 'Dependent' });
    sd.seed((d) => {
      toCode(d, t);
      d.must(t.id, { kind: 'cancel', reason });
    });
    await sd.start();
    const terminal = { kind: 'CANCELLED', reason };
    const explained = await data(sd, 'task', 'explain', t.id);
    expect(explained).toMatchObject({ status: 'CANCELLED', terminal });
    expect(explained).not.toHaveProperty('deadline_ms');
    expect(await data(sd, 'task', 'explain', t.id, '--full')).toMatchObject({
      terminal,
      deadline: { state: 'ended', remaining_ms: null },
    });
    expect(await data(sd, 'task', 'show', t.id)).toMatchObject({ terminal });
    expect(await data(sd, 'task', 'list')).toMatchObject({ items: [{ terminal }] });
  });
});

describe('a DONE nobody verified is told apart from a verified one', () => {
  it('explain, show and list name unverified', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Unverified' });
    const merged = 'c'.repeat(40);
    sd.seed((d) => {
      toGreen(d, t, 'direct-pr');
      d.must(t.id, observation(d, t, 'merged', merged));
      const s = d.task(t.id);
      d.must(t.id, {
        kind: 'external_completion',
        proof: {
          subject: s.observation?.subject as never,
          merged_at: d.now,
          merged_head_sha: merged,
          checked_head_sha: 'a'.repeat(40),
          merge_commit_sha: 'd'.repeat(40),
          observation_id: s.observation?.last?.observation_id as string,
          evidence_ref: 'ev',
        },
        unverified_reason: 'merged_head_unverified',
      });
      d.must(t.id, { kind: 'drain_result', pending_operations: [] });
    });
    await sd.start();
    const unverified = { reason: 'merged_head_unverified' };
    expect(await data(sd, 'task', 'explain', t.id)).toMatchObject({ status: 'DONE', unverified });
    expect(await data(sd, 'task', 'explain', t.id, '--full')).toMatchObject({
      completion: {
        merged_head_sha: merged,
        checked_head_sha: 'a'.repeat(40),
        merge_commit_sha: 'd'.repeat(40),
        unverified,
      },
    });
    expect(await data(sd, 'task', 'show', t.id)).toMatchObject({ unverified });
    expect(await data(sd, 'task', 'list')).toMatchObject({ items: [{ unverified }] });
  });
});
