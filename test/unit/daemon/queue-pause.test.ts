import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Admitted, CommandInput } from '../../../src/application/commands.ts';
import {
  QUEUE_PAUSE_FILE,
  queueCommands,
  readQueuePause,
} from '../../../src/daemon/queue-pause.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dataDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'cusr-queue-'));
  dirs.push(d);
  return d;
};
const caller = { grant: { actor: 'assistant', roles: ['read', 'operate'] as const } };
let seq = 0;
const run = (
  h: ReturnType<typeof queueCommands>['queue_pause'],
  payload: unknown,
  requestId = `req-${seq++}`,
) =>
  h(
    { record: { request_id: requestId } } as unknown as Admitted,
    { payload } as CommandInput,
    caller as never,
  );

describe('queue pause file (issue #142)', () => {
  it('is absent until paused, owner-only once written, and clear after resume', async () => {
    const dir = dataDir();
    const q = queueCommands({ dataDir: dir, now: () => 1_000 });
    expect(readQueuePause(dir)).toBeNull();

    expect(await run(q.queue_pause, { reason: 'release upgrade' })).toMatchObject({
      ok: true,
      value: {
        changed: true,
        queue: { paused: { reason: 'release upgrade', by: 'assistant', at: 1_000 } },
      },
    });
    expect(readQueuePause(dir)).toEqual({ reason: 'release upgrade', by: 'assistant', at: 1_000 });
    expect(statSync(join(dir, QUEUE_PAUSE_FILE)).mode & 0o777).toBe(0o600);

    // A second pause keeps the first reason and says it changed nothing (issue #260).
    expect(await run(q.queue_pause, { reason: 'other' })).toMatchObject({
      ok: true,
      value: { changed: false, queue: { paused: { reason: 'release upgrade' } } },
    });
    expect(readQueuePause(dir)?.reason).toBe('release upgrade');

    expect(await run(q.queue_resume, {})).toMatchObject({
      ok: true,
      value: { changed: true, queue: { paused: null } },
    });
    expect(readQueuePause(dir)).toBeNull();
    expect(await run(q.queue_resume, {})).toMatchObject({ ok: true, value: { changed: false } });
  });

  it('a request run again after a crash changes nothing, so it never undoes a later decision', async () => {
    const dir = dataDir();
    const q = queueCommands({ dataDir: dir, now: () => 1_000 });
    await run(q.queue_pause, { reason: 'first' }, 'pause-1');
    // Resume X runs, then the daemon dies before its ledger row completes.
    await run(q.queue_resume, {}, 'resume-x');
    expect(readQueuePause(dir)).toBeNull();
    // The user pauses again with Y; X is retried with the same request ID.
    await run(q.queue_pause, { reason: 'second' }, 'pause-y');
    expect(await run(q.queue_resume, {}, 'resume-x')).toMatchObject({
      ok: true,
      value: { queue: { paused: { reason: 'second' } } },
    });
    expect(readQueuePause(dir)?.reason).toBe('second');
    // The same holds the other way round.
    await run(q.queue_resume, {}, 'resume-z');
    await run(q.queue_pause, { reason: 'again' }, 'pause-y');
    expect(readQueuePause(dir)).toBeNull();
  });

  it('a damaged file reads as paused, never as free to start new work', () => {
    const dir = dataDir();
    writeFileSync(join(dir, QUEUE_PAUSE_FILE), '{not json');
    expect(readQueuePause(dir)).toMatchObject({ reason: 'pause file malformed' });
    writeFileSync(join(dir, QUEUE_PAUSE_FILE), JSON.stringify({ reason: 'x' }));
    expect(readQueuePause(dir)).toMatchObject({ reason: 'pause file malformed' });
  });
});
