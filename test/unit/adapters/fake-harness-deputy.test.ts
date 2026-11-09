import { describe, expect, it } from 'vitest';
import { FakeHarness } from '../../../src/adapters/harness/fake.ts';
import { wireRoleSchema } from '../../../src/adapters/harness/result-schema.ts';
import type { HarnessInput } from '../../../src/adapters/ports.ts';
import { hashText } from '../../../src/shared/hash.ts';

// 007 T002: the fake harness runs deputy turns: an `act` callback for what the deputy does through
// `cusr`, then the end of the turn; failures and hangs as for any role.

const input = (over: Partial<HarnessInput> = {}): HarnessInput => ({
  role: 'deputy',
  operation_id: 'op',
  attempt_id: 'attempt',
  revision: 1,
  binding: {
    harness: 'fake',
    vendor: 'fake',
    model: 'm',
    effort: 'high',
    permission_policy_hash: hashText('none'),
  },
  context: { text: 'incident', digest: hashText('incident') },
  schema: wireRoleSchema('deputy', { omit_meta_schema: false }),
  wall_ms: null,
  deadline_at: null,
  session: null,
  deputy_turn: 'turn-1',
  ...over,
});

describe('the fake harness for deputy turns', () => {
  it('runs the act with the turn, then ends the turn with its message and session', async () => {
    const seen: string[] = [];
    const h = new FakeHarness({
      deputy: [
        {
          kind: 'turn_ended',
          act: (i) => {
            seen.push(i.deputy_turn ?? '');
          },
          final_message: 'done',
          session_ref: 's1',
        },
        { kind: 'turn_ended' },
      ],
    });
    expect(await h.run(input(), new AbortController().signal)).toMatchObject({
      kind: 'turn_ended',
      role: 'deputy',
      final_message: 'done',
      session_ref: 's1',
    });
    expect(seen).toEqual(['turn-1']);
    expect(await h.run(input(), new AbortController().signal)).toMatchObject({
      kind: 'turn_ended',
      final_message: null,
    });
    expect(h.remaining('deputy')).toBe(0);
  });

  it.each(['rate_limited', 'auth', 'refusal', 'capability_missing', 'process_failed'] as const)(
    'fails a turn with %s',
    async (failure) => {
      const h = new FakeHarness({ deputy: [{ kind: 'failure', failure }] });
      expect(await h.run(input(), new AbortController().signal)).toMatchObject({
        kind: 'failure',
        role: 'deputy',
        failure,
      });
    },
  );

  it('hangs until the caller stops it', async () => {
    const h = new FakeHarness({ deputy: [{ kind: 'hang' }] });
    const stop = new AbortController();
    const out = h.run(input(), stop.signal);
    stop.abort();
    expect(await out).toMatchObject({ kind: 'failure', failure: 'cancelled' });
  });
});
