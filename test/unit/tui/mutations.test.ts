import { describe, expect, it } from 'vitest';
import type { PortError, PortResult } from '../../../src/tui/client/daemon-port.ts';
import {
  MAX_CHECKS,
  MAX_RESENDS,
  MutationTracker,
  type MutationCommand,
  type MutationPort,
} from '../../../src/tui/client/mutations.ts';
import type { RequestShow } from '../../../src/tui/client/schemas.ts';
import { uiText } from '../../../src/tui/terminal/safe-text.ts';

const TASK = '019a0000-0000-7000-8000-000000000001';
const OTHER = '019a0000-0000-7000-8000-000000000002';
const CMD: MutationCommand = {
  kind: 'task_cancel',
  project: 'acme',
  task_id: TASK,
  expected_version: 3,
  payload: { reason: 'stop' },
};
const LOST: PortError = { kind: 'connection', message: uiText('gone') };
const lost = <T>(): PortResult<T> => ({ ok: false, error: LOST });
const good = <T>(value: T): PortResult<T> => ({ ok: true, value });

const shown = (state: RequestShow['state'], extra: Partial<RequestShow> = {}): RequestShow =>
  ({
    request_id: 'x',
    kind: 'task_cancel',
    state,
    project: 'acme',
    task_id: TASK,
    admitted_at: 1,
    completed_at: null,
    next_step: null,
    ...extra,
  }) as RequestShow;

class Fake implements MutationPort {
  sent: Record<string, unknown>[] = [];
  shows: string[] = [];
  onCommand: () => PortResult<unknown> = () => good({});
  onShow: () => PortResult<RequestShow> = () => good(shown('in_progress'));
  command(body: Record<string, unknown>): Promise<PortResult<unknown>> {
    this.sent.push(body);
    return Promise.resolve(this.onCommand());
  }
  requestShow(id: string): Promise<PortResult<RequestShow>> {
    this.shows.push(id);
    return Promise.resolve(this.onShow());
  }
}

function make(over: { connected?: () => boolean } = {}) {
  const port = new Fake();
  let n = 0;
  const tracker = new MutationTracker({
    port,
    connected: over.connected ?? (() => true),
    newId: () => `id-${++n}`,
  });
  return { port, tracker };
}

describe('MutationTracker', () => {
  it('accepts on ok and keeps the daemon reply', async () => {
    const { tracker } = make();
    const r = await tracker.submit(CMD);
    expect(r.started && r.mutation.state).toBe('accepted');
    expect(tracker.open()).toEqual([]);
  });

  it('rejects without resending or checking', async () => {
    const { tracker, port } = make();
    port.onCommand = () => ({
      ok: false,
      error: { kind: 'rejected', code: 'version_conflict', message: uiText('stale') },
    });
    const r = await tracker.submit(CMD);
    expect(r.started && r.mutation.state).toBe('rejected');
    expect(port.sent).toHaveLength(1);
    expect(port.shows).toHaveLength(0);
  });

  it('goes unknown on a lost answer and blocks new writes on that task only', async () => {
    const { tracker, port } = make();
    port.onCommand = lost;
    const r = await tracker.submit(CMD);
    expect(r.started && r.mutation.state).toBe('unknown');
    const again = await tracker.submit(CMD);
    expect(again.started).toBe(false);
    expect((await tracker.submit({ ...CMD, task_id: OTHER })).started).toBe(true);
    expect(port.sent).toHaveLength(2);
  });

  it('uses the stored result when request_show says completed', async () => {
    const { tracker, port } = make();
    port.onCommand = lost;
    await tracker.submit(CMD);
    port.onShow = () => good(shown('completed', { outcome: { ok: true, value: { v: 1 } } }));
    const m = await tracker.poll('id-1');
    expect(m?.state).toBe('accepted');
    expect(m?.result).toEqual({ ok: true, value: { v: 1 } });
    expect(port.sent).toHaveLength(1);
  });

  it('takes a completed rejection as rejected', async () => {
    const { tracker, port } = make();
    port.onCommand = lost;
    await tracker.submit(CMD);
    port.onShow = () =>
      good(
        shown('completed', {
          outcome: { ok: false, error: { code: uiText('nope'), message: uiText('why') } },
        }),
      );
    expect((await tracker.poll('id-1'))?.state).toBe('rejected');
  });

  it('keeps asking while in_progress', async () => {
    const { tracker, port } = make();
    port.onCommand = lost;
    await tracker.submit(CMD);
    for (let i = 0; i < 3; i++) await tracker.poll('id-1');
    expect(tracker.get('id-1')).toMatchObject({ state: 'unknown', checks: 3, resends: 0 });
    expect(port.sent).toHaveLength(1);
  });

  it.each([
    ['interrupted', () => good(shown('interrupted'))],
    [
      'not_found',
      (): PortResult<RequestShow> => ({
        ok: false,
        error: { kind: 'rejected', code: 'request_not_found', message: uiText('none') },
      }),
    ],
  ])('resends the same request ID and body on %s', async (_name, answer) => {
    const { tracker, port } = make();
    port.onCommand = lost;
    await tracker.submit(CMD);
    port.onCommand = () => good({});
    port.onShow = answer;
    const m = await tracker.poll('id-1');
    expect(m?.state).toBe('accepted');
    expect(port.sent).toHaveLength(2);
    expect(port.sent[1]).toEqual(port.sent[0]);
    expect(port.sent[1]).toEqual({ ...CMD, request_id: 'id-1' });
  });

  it('does not count or ask while disconnected', async () => {
    let up = true;
    const { tracker, port } = make({ connected: () => up });
    port.onCommand = lost;
    await tracker.submit(CMD);
    up = false;
    await tracker.poll('id-1');
    expect(port.shows).toHaveLength(0);
    expect(tracker.get('id-1')?.checks).toBe(0);
  });

  it('becomes unresolved after the check ceiling and stops asking', async () => {
    const { tracker, port } = make();
    port.onCommand = lost;
    await tracker.submit(CMD);
    for (let i = 0; i < MAX_CHECKS; i++) await tracker.poll('id-1');
    // Unresolved as soon as the 60th check leaves it unknown, not at the next poll.
    expect(tracker.get('id-1')?.state).toBe('unresolved');
    for (let i = 0; i < 5; i++) await tracker.poll('id-1');
    expect(port.shows).toHaveLength(MAX_CHECKS);
    expect(tracker.get('id-1')?.state).toBe('unresolved');
    expect(tracker.blocking(TASK)?.requestId).toBe('id-1');
    expect((await tracker.submit(CMD)).started).toBe(false);
  });

  it('becomes unresolved after the resend ceiling', async () => {
    const { tracker, port } = make();
    port.onCommand = lost;
    port.onShow = () => good(shown('interrupted'));
    await tracker.submit(CMD);
    for (let i = 0; i < MAX_RESENDS; i++) await tracker.poll('id-1');
    // The fifth resend lost its answer: stop at once instead of asking again.
    expect(tracker.get('id-1')?.state).toBe('unresolved');
    for (let i = 0; i < 5; i++) await tracker.poll('id-1');
    expect(port.shows).toHaveLength(MAX_RESENDS);
    expect(port.sent).toHaveLength(1 + MAX_RESENDS);
    expect(tracker.get('id-1')?.state).toBe('unresolved');
    expect(new Set(port.sent.map((b) => b['request_id']))).toEqual(new Set(['id-1']));
  });

  it('Check again resets the counters and keeps the request ID', async () => {
    const { tracker, port } = make();
    port.onCommand = lost;
    await tracker.submit(CMD);
    for (let i = 0; i < MAX_CHECKS + 1; i++) await tracker.poll('id-1');
    const m = tracker.checkAgain('id-1');
    expect(m).toMatchObject({ state: 'unknown', checks: 0, resends: 0, requestId: 'id-1' });
    await tracker.poll('id-1');
    expect(port.shows).toHaveLength(MAX_CHECKS + 1);
  });

  it('Check again does nothing unless unresolved', async () => {
    const { tracker, port } = make();
    port.onCommand = lost;
    await tracker.submit(CMD);
    expect(tracker.checkAgain('id-1')?.state).toBe('unknown');
  });

  it('keeps writes on the task blocked while a resend is in flight', async () => {
    const { tracker, port } = make();
    port.onCommand = lost;
    await tracker.submit(CMD);
    port.onShow = () => good(shown('interrupted'));
    let release: () => void = () => undefined;
    port.command = (body) => {
      port.sent.push(body);
      return new Promise((res) => {
        release = () => res(good({}));
      });
    };
    const polling = tracker.poll('id-1');
    await new Promise((r) => setTimeout(r, 0));
    expect(tracker.get('id-1')?.state).toBe('sending');
    expect((await tracker.submit(CMD)).started).toBe(false);
    release();
    await polling;
    expect(tracker.get('id-1')?.state).toBe('accepted');
  });

  it('resends the body as submitted even if the caller changes it afterwards', async () => {
    const { tracker, port } = make();
    port.onCommand = lost;
    const payload = { reason: 'stop' };
    await tracker.submit({ ...CMD, payload });
    payload.reason = 'changed';
    port.onCommand = () => good({});
    port.onShow = () => good(shown('interrupted'));
    await tracker.poll('id-1');
    expect(port.sent[1]).toEqual({ ...CMD, request_id: 'id-1' });
  });

  it('does not resend or count when the link drops while request_show is in flight', async () => {
    let up = true;
    const { tracker, port } = make({ connected: () => up });
    port.onCommand = lost;
    await tracker.submit(CMD);
    port.onShow = () => {
      up = false;
      return good(shown('interrupted'));
    };
    const m = await tracker.poll('id-1');
    expect(port.sent).toHaveLength(1);
    expect(m).toMatchObject({ state: 'unknown', checks: 0, resends: 0 });
  });

  it('does not spend a check when the link drops while request_show waits and fails', async () => {
    let up = true;
    const { tracker, port } = make({ connected: () => up });
    port.onCommand = lost;
    await tracker.submit(CMD);
    for (let i = 0; i < MAX_CHECKS - 1; i++) await tracker.poll('id-1');
    expect(tracker.get('id-1')?.checks).toBe(MAX_CHECKS - 1);
    port.onShow = () => {
      up = false;
      return lost();
    };
    // The 60th look would have ended the round; it did not count, so the round is still open.
    expect(await tracker.poll('id-1')).toMatchObject({ state: 'unknown', checks: MAX_CHECKS - 1 });
    up = true;
    port.onShow = () => good(shown('in_progress'));
    expect(await tracker.poll('id-1')).toMatchObject({ state: 'unresolved', checks: MAX_CHECKS });
  });

  it('gives back the check, not the resend, when the link drops while the resend waits', async () => {
    let up = true;
    const { tracker, port } = make({ connected: () => up });
    port.onCommand = lost;
    await tracker.submit(CMD);
    port.onShow = () => good(shown('interrupted'));
    port.onCommand = () => {
      up = false;
      return lost();
    };
    expect(await tracker.poll('id-1')).toMatchObject({ state: 'unknown', resends: 1, checks: 0 });
    expect(tracker.blocking(TASK)?.requestId).toBe('id-1');
  });

  it('does not spend a check or a resend on a timeout while still connected', async () => {
    const { tracker, port } = make();
    const timedOut = <T>(): PortResult<T> => ({
      ok: false,
      error: { kind: 'timeout', message: uiText('slow') },
    });
    port.onCommand = lost;
    await tracker.submit(CMD);
    for (let i = 0; i < MAX_CHECKS - 1; i++) await tracker.poll('id-1');
    port.onShow = timedOut;
    expect(await tracker.poll('id-1')).toMatchObject({ state: 'unknown', checks: MAX_CHECKS - 1 });

    const second = make();
    second.port.onCommand = lost;
    await second.tracker.submit(CMD);
    second.port.onShow = () => good(shown('interrupted'));
    for (let i = 0; i < MAX_RESENDS - 1; i++) await second.tracker.poll('id-1');
    second.port.onCommand = timedOut;
    expect(await second.tracker.poll('id-1')).toMatchObject({
      state: 'unknown',
      resends: MAX_RESENDS - 1,
    });
  });

  it('keeps the round open when the 60th check asks for a resend that times out', async () => {
    const { tracker, port } = make();
    port.onCommand = lost;
    await tracker.submit(CMD);
    for (let i = 0; i < MAX_CHECKS - 1; i++) await tracker.poll('id-1');
    port.onShow = () => good(shown('interrupted'));
    port.onCommand = () => ({ ok: false, error: { kind: 'timeout', message: uiText('slow') } });
    expect(await tracker.poll('id-1')).toMatchObject({ state: 'unknown', resends: 0 });
  });

  it('still counts a check that failed with a connection error while the state says online', async () => {
    const { tracker, port } = make();
    port.onCommand = lost;
    await tracker.submit(CMD);
    for (let i = 0; i < MAX_CHECKS - 1; i++) await tracker.poll('id-1');
    port.onShow = lost;
    expect(await tracker.poll('id-1')).toMatchObject({ state: 'unresolved', checks: MAX_CHECKS });
  });

  it('keeps the write unknown when the fifth resend is lost to a dropped link', async () => {
    let up = true;
    const { tracker, port } = make({ connected: () => up });
    port.onCommand = lost;
    await tracker.submit(CMD);
    port.onShow = () => good(shown('interrupted'));
    for (let i = 0; i < MAX_RESENDS - 1; i++) await tracker.poll('id-1');
    port.onCommand = () => {
      up = false;
      return lost();
    };
    expect(await tracker.poll('id-1')).toMatchObject({ state: 'unknown', resends: MAX_RESENDS });
  });

  it('does not spend a check on an in_progress answer that arrives while offline', async () => {
    let up = true;
    const { tracker, port } = make({ connected: () => up });
    port.onCommand = lost;
    await tracker.submit(CMD);
    for (let i = 0; i < MAX_CHECKS - 1; i++) await tracker.poll('id-1');
    port.onShow = () => {
      up = false;
      return good(shown('in_progress'));
    };
    expect(await tracker.poll('id-1')).toMatchObject({ state: 'unknown', checks: MAX_CHECKS - 1 });
    up = true;
    port.onShow = () => good(shown('completed', { outcome: { ok: true, value: { v: 1 } } }));
    expect(await tracker.poll('id-1')).toMatchObject({ state: 'accepted' });
  });

  it('still settles a completed answer that arrives while offline', async () => {
    let up = true;
    const { tracker, port } = make({ connected: () => up });
    port.onCommand = lost;
    await tracker.submit(CMD);
    port.onShow = () => {
      up = false;
      return good(shown('completed', { outcome: { ok: true, value: { v: 1 } } }));
    };
    expect(await tracker.poll('id-1')).toMatchObject({ state: 'accepted' });
  });
});
