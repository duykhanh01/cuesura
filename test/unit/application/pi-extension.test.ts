import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { piExtensionSource } from '../../../src/application/pi-extension.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;

const base = mkdtempSync(join(tmpdir(), 'cusr-pi-ext-'));
const log = join(base, 'calls.log');
const path = process.env['PATH'];

/** Plays `cusr`: logs its call and stdin, and does what MODE asks. */
const CUSR = `#!/bin/sh
payload=$(cat)
echo "$* $CUSR_DATA_DIR $CUSR_ACTOR $payload" >> ${JSON.stringify(log)}
case "$2:$MODE" in
  session-start:remind) echo 'cusr: ask about the lease' ;;
  hook:wake) printf '%s' '{"note":"cusr: tasks need the user: t-1.","lease":"s-1.1"}'; exit 2 ;;
  hook:park) exec sleep 30 ;;
esac
`;

const NOTE = 'cusr: tasks need the user: t-1.';

let extension: (pi: unknown) => void;

function session() {
  const handlers = new Map<string, Handler>();
  const sendUserMessage = vi.fn();
  const state = { idle: true, queued: false };
  extension({ on: (name: string, run: Handler) => handlers.set(name, run), sendUserMessage });
  const ctx = {
    sessionManager: { getSessionId: () => 's-1' },
    isIdle: () => state.idle,
    hasPendingMessages: () => state.queued,
  };
  const fire = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  const arrives = (text: string) =>
    fire('message_start', { message: { role: 'user', content: text } });
  return { fire, arrives, sendUserMessage, state };
}

const hooks = () => calls().filter((c) => c.startsWith('assistant hook'));

const calls = () => {
  try {
    return readFileSync(log, 'utf8').trim().split('\n');
  } catch {
    return [];
  }
};

beforeAll(async () => {
  writeFileSync(join(base, 'cusr'), CUSR);
  chmodSync(join(base, 'cusr'), 0o755);
  process.env['PATH'] = `${base}:${path ?? ''}`;
  const file = join(base, 'extension.ts');
  writeFileSync(file, piExtensionSource('/srv/cusr "data"'));
  extension = ((await import(/* @vite-ignore */ file)) as { default: typeof extension }).default;
});

afterEach(() => {
  rmSync(log, { force: true });
  delete process.env['MODE'];
});

afterAll(() => {
  process.env['PATH'] = path;
  rmSync(base, { recursive: true, force: true });
});

describe('the pi extension', () => {
  it('parks after a turn with its own pid as the owner, and sends the wake as a follow-up', async () => {
    process.env['MODE'] = 'wake';
    const s = session();
    s.fire('session_start');
    s.fire('agent_end');
    await vi.waitFor(() => {
      expect(s.sendUserMessage).toHaveBeenCalledWith(NOTE, { deliverAs: 'followUp' });
    });
    expect(calls()).toContain(
      `assistant hook --harness pi --owner-pid ${String(process.pid)} /srv/cusr "data" assistant {"session_id":"s-1"}`,
    );
    s.fire('session_shutdown');
  });

  it('confirms the lease only after the note arrived', async () => {
    process.env['MODE'] = 'wake';
    const s = session();
    s.fire('session_start');
    s.fire('agent_end');
    await vi.waitFor(() => {
      expect(s.sendUserMessage).toHaveBeenCalled();
    });
    s.fire('agent_end');
    expect(hooks()).toHaveLength(1);
    s.arrives('something the user typed');
    s.fire('agent_end');
    expect(hooks()).toHaveLength(1);
    s.arrives(NOTE);
    delete process.env['MODE'];
    s.fire('agent_end');
    await vi.waitFor(() => {
      expect(hooks()).toHaveLength(2);
    });
    expect(hooks()[1]).toContain('--confirm s-1.1 ');
    s.fire('session_shutdown');
  });

  it('holds the wake during compaction and offers it once the session is idle', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      process.env['MODE'] = 'wake';
      const s = session();
      s.fire('session_start');
      s.state.idle = false;
      s.fire('agent_end');
      await vi.waitFor(() => {
        expect(hooks()).toHaveLength(1);
      });
      await new Promise((r) => setTimeout(r, 100));
      vi.advanceTimersByTime(6_000);
      expect(s.sendUserMessage).not.toHaveBeenCalled();
      s.state.idle = true;
      vi.advanceTimersByTime(2_000);
      expect(s.sendUserMessage).toHaveBeenCalledTimes(1);
      s.arrives(NOTE);
      vi.advanceTimersByTime(6_000);
      expect(s.sendUserMessage).toHaveBeenCalledTimes(1);
      s.fire('session_shutdown');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops offering a note that never shows up, leaving the lease unconfirmed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      process.env['MODE'] = 'wake';
      const s = session();
      s.fire('session_start');
      s.fire('agent_end');
      await vi.waitFor(() => {
        expect(s.sendUserMessage).toHaveBeenCalledTimes(1);
      });
      vi.advanceTimersByTime(60_000);
      expect(s.sendUserMessage).toHaveBeenCalledTimes(3);
      delete process.env['MODE'];
      s.fire('agent_end');
      await vi.waitFor(() => {
        expect(hooks()).toHaveLength(2);
      });
      expect(hooks()[1]).not.toContain('--confirm');
      s.fire('session_shutdown');
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers again when pi drops the note silently', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      process.env['MODE'] = 'wake';
      const s = session();
      s.fire('session_start');
      s.fire('agent_end');
      await vi.waitFor(() => {
        expect(s.sendUserMessage).toHaveBeenCalledTimes(1);
      });
      vi.advanceTimersByTime(2_000);
      expect(s.sendUserMessage).toHaveBeenCalledTimes(2);
      s.fire('session_shutdown');
      vi.advanceTimersByTime(6_000);
      expect(s.sendUserMessage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends nothing when the hook ends without news, and parks again next turn', async () => {
    const s = session();
    s.fire('session_start');
    s.fire('agent_end');
    await vi.waitFor(() => {
      expect(calls().filter((c) => c.startsWith('assistant hook'))).toHaveLength(1);
    });
    await new Promise((r) => setTimeout(r, 50));
    s.fire('agent_end');
    await vi.waitFor(() => {
      expect(calls().filter((c) => c.startsWith('assistant hook'))).toHaveLength(2);
    });
    expect(s.sendUserMessage).not.toHaveBeenCalled();
  });

  it('gives the reminder to the first turn only, hidden, without starting one', async () => {
    process.env['MODE'] = 'remind';
    const s = session();
    s.fire('session_start');
    expect(await s.fire('before_agent_start')).toEqual({
      message: { customType: 'cusr', content: 'cusr: ask about the lease', display: false },
    });
    expect(await s.fire('before_agent_start')).toBeUndefined();
    expect(s.sendUserMessage).not.toHaveBeenCalled();
  });

  it('keeps one hook parked, and ends it with the session without sending', async () => {
    process.env['MODE'] = 'park';
    const s = session();
    s.fire('session_start');
    s.fire('agent_end');
    s.fire('agent_end');
    await vi.waitFor(() => {
      expect(calls().filter((c) => c.startsWith('assistant hook'))).toHaveLength(1);
    });
    s.fire('session_shutdown');
    s.fire('agent_end');
    await new Promise((r) => setTimeout(r, 100));
    expect(calls().filter((c) => c.startsWith('assistant hook'))).toHaveLength(1);
    expect(s.sendUserMessage).not.toHaveBeenCalled();
  });

  it('leaves the session alone when cusr is not installed', async () => {
    const saved = process.env['PATH'];
    process.env['PATH'] = '/nonexistent';
    const s = session();
    s.fire('session_start');
    expect(await s.fire('before_agent_start')).toBeUndefined();
    s.fire('agent_end');
    process.env['PATH'] = saved;
    await new Promise((r) => setTimeout(r, 50));
    expect(s.sendUserMessage).not.toHaveBeenCalled();
  });
});
