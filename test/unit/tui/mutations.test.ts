import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTROL_SOCKET } from '../../../src/cli/output.ts';
import { createDaemonPort } from '../../../src/tui/client/daemon-port.ts';
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
/** A resend the daemon answered without a result: it counts. */
const unadmitted = <T>(): PortResult<T> => ({
  ok: false,
  error: { kind: 'rejected', code: 'store_unwritable', message: uiText('full') },
});

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

function make(over: { connected?: () => boolean; mayCheck?: () => boolean } = {}) {
  const port = new Fake();
  let n = 0;
  const tracker = new MutationTracker({
    port,
    connected: over.connected ?? (() => true),
    ...(over.mayCheck === undefined ? {} : { mayCheck: over.mayCheck }),
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

  it('keeps the lock and looks the request up when the daemon failed inside the handler (internal)', async () => {
    const { tracker, port } = make();
    port.onCommand = () => ({
      ok: false,
      error: {
        kind: 'rejected',
        code: 'internal',
        message: uiText('may have taken effect in part'),
      },
    });
    const r = await tracker.submit(CMD);
    expect(r.started && r.mutation.state).toBe('unknown');
    expect((await tracker.submit(CMD)).started).toBe(false);
    // The daemon reports the failed handler as interrupted: the same request ID and body go again.
    port.onShow = () => good(shown('interrupted'));
    port.onCommand = () => good({ v: 2 });
    const m = await tracker.poll('id-1');
    expect(port.shows).toEqual(['id-1']);
    expect(port.sent.map((b) => b['request_id'])).toEqual(['id-1', 'id-1']);
    expect(m?.state).toBe('accepted');
  });

  it('keeps the lock and looks the request up when the ledger could not store the result (store_write_failed)', async () => {
    const { tracker, port } = make();
    port.onCommand = () => ({
      ok: false,
      error: {
        kind: 'rejected',
        code: 'store_write_failed',
        message: uiText('store write failed'),
      },
    });
    const r = await tracker.submit(CMD);
    expect(r.started && r.mutation.state).toBe('unknown');
    port.onShow = () => good(shown('interrupted'));
    port.onCommand = () => good({ v: 3 });
    expect((await tracker.poll('id-1'))?.state).toBe('accepted');
    expect(port.sent.map((b) => b['request_id'])).toEqual(['id-1', 'id-1']);
  });

  it('a resend refused before admission (store_unwritable) keeps the lock until the same ID finishes (T4.2-R02b)', async () => {
    const { tracker, port } = make();
    const unwritable = () =>
      ({
        ok: false,
        error: { kind: 'rejected', code: 'store_unwritable', message: uiText('store unwritable') },
      }) as const;
    port.onCommand = () => ({
      ok: false,
      error: {
        kind: 'rejected',
        code: 'store_write_failed',
        message: uiText('store write failed'),
      },
    });
    expect((await tracker.submit(CMD)).started).toBe(true);
    // The ledger could not complete the request and the daemon latched: the resend is turned away unadmitted.
    port.onShow = () => good(shown('interrupted'));
    port.onCommand = unwritable;
    const held = await tracker.poll('id-1');
    expect(held?.state).toBe('unknown');
    expect(tracker.blocking(TASK)?.requestId).toBe('id-1');
    expect((await tracker.submit(CMD)).started).toBe(false);
    // Once the daemon writes again, the same request ID and body finish it.
    port.onCommand = () => good({ v: 4 });
    expect((await tracker.poll('id-1'))?.state).toBe('accepted');
    expect(port.sent.map((b) => b['request_id'])).toEqual(['id-1', 'id-1', 'id-1']);
    expect(tracker.blocking(TASK)).toBeUndefined();
  });

  it('a new request refused before admission (store_unwritable) is a refusal, not an unknown write', async () => {
    const { tracker, port } = make();
    port.onCommand = () => ({
      ok: false,
      error: { kind: 'rejected', code: 'store_unwritable', message: uiText('store unwritable') },
    });
    const r = await tracker.submit(CMD);
    expect(r.started && r.mutation.state).toBe('rejected');
    expect(tracker.blocking(TASK)).toBeUndefined();
  });

  it('keeps what a refusal had already recorded, from the reply and from request_show (T4.2-R02)', async () => {
    const note = uiText('This request confirmed the intake of revision 2.');
    const direct = make();
    direct.port.onCommand = () => ({
      ok: false,
      error: { kind: 'rejected', code: 'rejected', message: uiText('digest'), committed: note },
    });
    const r = await direct.tracker.submit(CMD);
    expect(r.started && r.mutation.result).toMatchObject({ ok: false, committed: note });

    const looked = make();
    looked.port.onCommand = lost;
    await looked.tracker.submit(CMD);
    looked.port.onShow = () =>
      good(
        shown('completed', {
          outcome: {
            ok: false,
            error: {
              code: uiText('rejected'),
              message: uiText('digest'),
              details: { committed: { intake: 'confirmed', revision: 2, task_version: 5 } },
            },
          },
        } as never),
      );
    const m = await looked.tracker.poll('id-1');
    expect(m?.state).toBe('rejected');
    expect(String(m?.result?.ok === false ? m.result.committed : '')).toContain(
      'This request confirmed the intake of revision 2',
    );
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
    for (let i = 0; i < MAX_CHECKS - 1; i++) await tracker.poll('id-1');
    expect(tracker.get('id-1')?.state).toBe('unknown');
    await tracker.poll('id-1');
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
    // Each resend is answered, so it counts: the daemon could not admit it and the result stays unknown.
    port.onCommand = unadmitted;
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
  it('looks up on stale data, counts what the daemon answered, and resends only once connected', async () => {
    let up = true;
    const { tracker, port } = make({ connected: () => up, mayCheck: () => true });
    port.onCommand = lost;
    await tracker.submit(CMD);
    up = false;
    expect(await tracker.poll('id-1')).toMatchObject({ state: 'unknown', checks: 1 });
    port.onShow = () => good(shown('interrupted'));
    expect(await tracker.poll('id-1')).toMatchObject({ state: 'unknown', checks: 2, resends: 0 });
    expect(port.sent).toHaveLength(1);
    port.onShow = () => good(shown('completed', { outcome: { ok: true, value: { v: 1 } } }));
    expect(await tracker.poll('id-1')).toMatchObject({ state: 'accepted' });
  });

  it('ends the round at the 60th answered look while the board is still reconnecting', async () => {
    const { tracker, port } = make({ connected: () => false, mayCheck: () => true });
    port.onCommand = lost;
    await tracker.submit(CMD);
    for (let i = 0; i < MAX_CHECKS; i++) await tracker.poll('id-1');
    expect(tracker.get('id-1')).toMatchObject({ state: 'unresolved', checks: MAX_CHECKS });
    await tracker.poll('id-1');
    expect(port.shows).toHaveLength(MAX_CHECKS);
  });

  it('does not count a look that never reached the daemon, whatever the connection state says', async () => {
    const { tracker, port } = make();
    port.onCommand = lost;
    await tracker.submit(CMD);
    for (let i = 0; i < MAX_CHECKS - 1; i++) await tracker.poll('id-1');
    port.onShow = () => ({
      ok: false,
      error: { kind: 'connection', message: uiText('ENOENT'), reached: false },
    });
    for (let i = 0; i < 3; i++)
      expect(await tracker.poll('id-1')).toMatchObject({
        state: 'unknown',
        checks: MAX_CHECKS - 1,
      });
    port.onShow = () => good(shown('in_progress'));
    expect(await tracker.poll('id-1')).toMatchObject({ state: 'unresolved', checks: MAX_CHECKS });
  });

  it('counts a look cut after reaching the daemon while online, and not while the board is down', async () => {
    let up = false;
    const { tracker, port } = make({ connected: () => up, mayCheck: () => true });
    port.onCommand = lost;
    await tracker.submit(CMD);
    port.onShow = lost;
    // A real disconnect: the board says so, the cut look is not counted.
    for (let i = 0; i < 5; i++) await tracker.poll('id-1');
    expect(tracker.get('id-1')).toMatchObject({ state: 'unknown', checks: 0 });
    // The daemon serves the board but keeps cutting this look: the ceiling ends the round.
    up = true;
    for (let i = 0; i < MAX_CHECKS; i++) await tracker.poll('id-1');
    expect(tracker.get('id-1')).toMatchObject({ state: 'unresolved', checks: MAX_CHECKS });
    expect(port.shows).toHaveLength(5 + MAX_CHECKS);
  });

  it('counts a look that timed out: the daemon may be serving, and the ceiling must still end the round', async () => {
    const { tracker, port } = make();
    port.onCommand = lost;
    await tracker.submit(CMD);
    for (let i = 0; i < MAX_CHECKS - 1; i++) await tracker.poll('id-1');
    port.onShow = () => ({ ok: false, error: { kind: 'timeout', message: uiText('slow') } });
    expect(await tracker.poll('id-1')).toMatchObject({ state: 'unresolved', checks: MAX_CHECKS });
  });

  it('keeps the answered look but sends nothing when the link drops before the resend', async () => {
    let up = true;
    const { tracker, port } = make({ connected: () => up, mayCheck: () => true });
    port.onCommand = lost;
    await tracker.submit(CMD);
    port.onShow = () => {
      up = false;
      return good(shown('interrupted'));
    };
    expect(await tracker.poll('id-1')).toMatchObject({ state: 'unknown', checks: 1, resends: 0 });
    expect(port.sent).toHaveLength(1);
    expect(tracker.blocking(TASK)?.requestId).toBe('id-1');
  });

  it('counts a resend sent while connected even when the link drops it, so the resend ceiling ends the round', async () => {
    const { tracker, port } = make();
    port.onCommand = lost;
    await tracker.submit(CMD);
    port.onShow = () => good(shown('interrupted'));
    for (let i = 0; i < MAX_RESENDS; i++) await tracker.poll('id-1');
    expect(tracker.get('id-1')).toMatchObject({ state: 'unresolved', resends: MAX_RESENDS });
    expect(port.sent).toHaveLength(1 + MAX_RESENDS);
    expect(new Set(port.sent.map((b) => b['request_id']))).toEqual(new Set(['id-1']));
  });
});

describe('MutationTracker over a real socket', () => {
  /** A daemon that reads every request whole, then closes the connection without answering. */
  async function cutting<T>(run: (dataDir: string, seen: () => number) => Promise<T>): Promise<T> {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-cut-')));
    let seen = 0;
    const server = createServer((req) => {
      req.resume();
      req.on('end', () => {
        seen += 1;
        req.socket.destroy();
      });
    });
    await new Promise<void>((r) => server.listen(join(dir, CONTROL_SOCKET), r));
    try {
      return await run(dir, () => seen);
    } finally {
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('ends the round after 60 looks the daemon received and cut while the board is online', async () => {
    await cutting(async (dataDir, seen) => {
      const tracker = new MutationTracker({
        port: createDaemonPort({ dataDir, env: {} }),
        connected: () => true,
        newId: () => 'id-1',
      });
      await tracker.submit(CMD);
      for (let i = 0; i <= MAX_CHECKS; i++) await tracker.poll('id-1');
      expect(tracker.get('id-1')).toMatchObject({ state: 'unresolved', checks: MAX_CHECKS });
      expect(seen()).toBe(1 + MAX_CHECKS);
    });
  });

  it('spends nothing on cut looks while the board is down, nor on looks that never connect', async () => {
    await cutting(async (dataDir) => {
      const offline = new MutationTracker({
        port: createDaemonPort({ dataDir, env: {} }),
        connected: () => false,
        mayCheck: () => true,
        newId: () => 'id-1',
      });
      await offline.submit(CMD);
      for (let i = 0; i < 5; i++) await offline.poll('id-1');
      expect(offline.get('id-1')).toMatchObject({ state: 'unknown', checks: 0 });
    });
    const gone = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-gone-')));
    try {
      const tracker = new MutationTracker({
        port: createDaemonPort({ dataDir: gone, env: {} }),
        connected: () => true,
        newId: () => 'id-1',
      });
      await tracker.submit(CMD);
      for (let i = 0; i <= MAX_CHECKS; i++) await tracker.poll('id-1');
      expect(tracker.get('id-1')).toMatchObject({ state: 'unknown', checks: 0 });
    } finally {
      rmSync(gone, { recursive: true, force: true });
    }
  });
});
