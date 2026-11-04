import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isBusinessEffect } from '../../../src/domain/effect.ts';
import type { MergeProof } from '../../../src/domain/runtime.ts';
import type { DomainEvent } from '../../../src/domain/event.ts';
import { isTerminal, type TaskState } from '../../../src/domain/state.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { inFlight } from '../../../src/engine/effects.ts';
import { openMemoryStore } from '../../../src/store/testing.ts';
import { buildTask } from '../../support/builders.ts';
import { A, cancelRef, ci, merge, observation, toGreen } from '../../support/observation.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { propertyParams } from '../arbitraries/policies.ts';

// FR-025.01–05 (T096): whatever order cancels, PR reads, merges, drain rounds and timers arrive in, a
// cancel never ends CANCELLED without a clear read of the PR after the request and nothing in flight, a
// merge with its proof always wins as DONE with the cancel recorded late, no business work starts once
// the cancel is recorded, and a terminal task is never reopened.

type Step =
  | 'cancel'
  | 'open'
  | 'closed'
  | 'unknown'
  | 'cancel_open'
  | 'cancel_closed'
  | 'cancel_unknown'
  | 'merge'
  | 'merged_unproven'
  | 'drain'
  | 'tick';

/** Each step with how the clock moves before it: on, not at all, or back (FR-025.03 must not care). */
const stepArb = fc.array(
  fc.tuple(
    fc.constantFrom<Step>(
      'cancel',
      'open',
      'closed',
      'unknown',
      'cancel_open',
      'cancel_closed',
      'cancel_unknown',
      'merge',
      'merged_unproven',
      'drain',
      'tick',
    ),
    fc.constantFrom(1_000, 0, -1_000),
  ),
  { minLength: 1, maxLength: 12 },
);

function apply(d: StoreDriver, t: CanonicalTask, step: Step, clock: number, n: number): void {
  d.now += clock;
  const token = d.task(t.id).cancellation?.read_token;
  switch (step) {
    case 'cancel':
      d.send(t.id, { kind: 'cancel', reason: `stop ${n}` });
      return;
    case 'open':
    case 'closed':
    case 'unknown':
      // A read not made for the cancel: the automatic schedule or one requested before it.
      d.send(t.id, observation(d, t, step, A, { source: 'recheck' }));
      return;
    case 'cancel_open':
    case 'cancel_closed':
    case 'cancel_unknown': {
      const status = step.slice('cancel_'.length) as 'open' | 'closed' | 'unknown';
      d.send(
        t.id,
        observation(d, t, status, A, {
          source: 'recheck',
          ...(token === undefined ? {} : { ref: `cancel:${token}` }),
        }),
      );
      return;
    }
    case 'merge': {
      const trig = observation(d, t, 'merged', A, { source: 'recheck' });
      d.send(t.id, trig);
      const s = d.task(t.id);
      const proof: MergeProof = {
        subject:
          s.observation?.subject ??
          (trig.kind === 'observation_result' ? trig.observation.subject : (null as never)),
        merged_at: d.now,
        merged_head_sha: A,
        checked_head_sha: null,
        merge_commit_sha: 'd'.repeat(40),
        observation_id: trig.kind === 'observation_result' ? trig.observation.observation_id : '',
        evidence_ref: 'ev-merge',
      };
      d.send(t.id, {
        kind: 'external_completion',
        proof,
        unverified_reason: null,
      });
      return;
    }
    case 'merged_unproven':
      // GitHub shows a merge whose evidence is incomplete: no proof follows.
      d.send(t.id, observation(d, t, 'merged', A, { source: 'timer', merge_proof: false }));
      return;
    case 'drain':
      if (d.task(t.id).completion !== null)
        d.send(t.id, { kind: 'drain_result', pending_operations: [] });
      return;
    case 'tick':
      d.now += 120_000;
      d.fire();
      return;
  }
}

function check(s: TaskState, events: readonly DomainEvent[], before: TaskState): void {
  const types = events.map((e) => e.type);
  // A terminal task never moves again.
  if (isTerminal(before.status)) {
    expect(s.status).toBe(before.status);
    expect(s.completion?.finalized_at ?? null).toBe(before.completion?.finalized_at ?? null);
  }
  expect(types.filter((x) => x === 'TaskCancelled' || x === 'TaskCompleted')).toHaveLength(
    isTerminal(s.status) ? 1 : 0,
  );
  if (s.status === 'CANCELLED') {
    // FR-025.03/04: a clear read made for this cancel, logged after it, no merge proof, nothing in flight.
    expect(s.completion).toBeNull();
    const read = s.cancellation?.pr_read;
    expect(['open', 'closed']).toContain(read?.status);
    const seq = (pred: (e: DomainEvent) => boolean) => events.find(pred)?.seq ?? -1;
    const cancelSeq = seq((e) => e.type === 'CancelRequested');
    const readSeq = seq(
      (e) =>
        e.type === 'ExternalStateObserved' &&
        e.payload.observation.observation_id === read?.observation_id,
    );
    expect(cancelSeq).toBeGreaterThan(0);
    expect(readSeq).toBeGreaterThan(cancelSeq);
    // No read since the cancel (nor the last one before it) showed a merge, proven or not, whatever
    // order the reads were logged in (FR-040.12).
    const lastBefore = events
      .filter((e) => e.seq < cancelSeq && e.type === 'ExternalStateObserved')
      .at(-1);
    expect(
      events.some(
        (e) =>
          e.type === 'ExternalStateObserved' &&
          (e.seq > cancelSeq || e === lastBefore) &&
          e.payload.observation.status === 'merged',
      ),
    ).toBe(false);
    expect(Object.values(s.effects).some(inFlight)).toBe(false);
    expect(s.pr_ref).not.toBeNull();
  }
  if (s.status === 'DONE' && s.cancellation !== null) expect(types).toContain('CancelRecordedLate');
  // FR-025.01: once the cancel is recorded, no business effect waits to be dispatched.
  if (s.cancellation !== null)
    expect(
      Object.values(s.effects).filter((e) => e.status === 'pending' && isBusinessEffect(e.kind)),
    ).toEqual([]);
}

describe('cancel of a task with a PR (FR-025.01–05)', () => {
  it('never CANCELLED without a read made for the cancel, never over a merge, never reopened', () => {
    const reached = { CANCELLED: 0, DONE_late: 0 };
    fc.assert(
      fc.property(stepArb, (steps) => {
        const d = new StoreDriver(openMemoryStore());
        const t = buildTask();
        toGreen(d, t, 'direct-pr');
        steps.forEach(([step, clock], i) => {
          const before = d.task(t.id);
          apply(d, t, step, clock, i);
          check(d.task(t.id), d.store.readEvents(t.id), before);
        });
        const s = d.task(t.id);
        if (s.status === 'CANCELLED') reached.CANCELLED++;
        if (s.status === 'DONE' && s.cancellation !== null) reached.DONE_late++;
      }),
      propertyParams(200),
    );
    // The property is not vacuous: both endings were reached.
    expect(reached.CANCELLED).toBeGreaterThan(0);
    expect(reached.DONE_late).toBeGreaterThan(0);
  });

  it('a merge seen without its proof, then the cancel read answering open late, keeps the cancel open (regression)', () => {
    const d = new StoreDriver(openMemoryStore());
    const t = buildTask();
    toGreen(d, t, 'direct-pr');
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'pending' }),
      }),
    );
    d.now += 60_000;
    d.fire();
    const poll = d.pendingOne(t.id, 'await_ci');
    d.claim(poll.id);
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    const ref = cancelRef(d, t);
    d.must(t.id, observation(d, t, 'merged', A, { source: 'timer', merge_proof: false }));
    // The cancel's own read was sent first and answers last: open.
    d.must(t.id, observation(d, t, 'open', A, { source: 'recheck', ref }));
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: poll.id as Uuid,
      outcome: 'succeeded',
      data: ci(A, { build: 'success', test: 'success' }),
    });
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: { detail: { code: 'cancel_reconcile' } },
    });
    // The proof that follows still ends it DONE, with the cancel late.
    merge(d, t, A, 'recheck');
    if (d.task(t.id).status !== 'DONE')
      d.must(t.id, { kind: 'drain_result', pending_operations: [] });
    expect(d.task(t.id).status).toBe('DONE');
  });

  it('a merge seen without its proof after the cancel read keeps the cancel open (regression)', () => {
    const d = new StoreDriver(openMemoryStore());
    const t = buildTask();
    toGreen(d, t, 'direct-pr');
    // A CI poll is in flight, so the cancel cannot end at once.
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'pending' }),
      }),
    );
    d.now += 60_000;
    d.fire();
    const poll = d.pendingOne(t.id, 'await_ci');
    d.claim(poll.id);
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        source: 'recheck',
        ref: cancelRef(d, t),
      }),
    );
    d.must(t.id, observation(d, t, 'merged', A, { source: 'timer', merge_proof: false }));
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: poll.id as Uuid,
      outcome: 'succeeded',
      data: ci(A, { build: 'success', test: 'success' }),
    });
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: { detail: { code: 'cancel_reconcile' } },
    });
  });

  it('a read logged before the cancel at the same millisecond does not end it (regression)', () => {
    const d = new StoreDriver(openMemoryStore());
    const t = buildTask();
    toGreen(d, t, 'direct-pr');
    d.must(t.id, observation(d, t, 'open', A, { source: 'recheck' }));
    d.must(t.id, { kind: 'cancel', reason: 'same ms' });
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: { detail: { code: 'cancel_reconcile' } },
    });
    // Neither does a read without the cancel's token after it, even with a later clock.
    d.now += 5_000;
    d.must(t.id, observation(d, t, 'open', A, { source: 'timer' }));
    expect(d.task(t.id).status).toBe('WAITING');
  });
});
