import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { v7 as uuidv7 } from 'uuid';
import { registeredSession, type AttentionItem } from '../application/attention.ts';
import { OPERATION_ENV } from '../runner/process-tag.ts';
import { resolveDataDir } from './client.ts';
import { ExitCode, okEnvelope, type Envelope } from './output.ts';
import type { CliCommand } from './program.ts';
import { DATA_DIR, badFlag, call, print } from './tasks.ts';

const POLL_MS = 2_000;
/** A session that died without killing this process must not keep the lease looking alive for ever. */
const DEFAULT_TIMEOUT_S = 3_600;

/** Below the hook `timeout` in the settings, so the hook ends by itself instead of being killed. */
const DEFAULT_PARK_S = 604_500;
/** A hook exit of 2 is what wakes the session; Claude Code shows it stderr. */
const WAKE_SESSION = 2;
const HOOK_FILE = 'assistant-hook.json';

type Attention = {
  readonly lease: string;
  readonly items: readonly unknown[];
  readonly truncated?: boolean;
};

export const assistantWaitCommand: CliCommand = {
  name: 'assistant wait',
  description:
    'Hold the assistant lease and wait until a task needs a person; prints it and exits. Uses no agent turns',
  help: `Run it in the background and run it again with the printed lease after each return.
A session that registers for the Stop hook needs none of this; see cusr assistant register.

Examples:
  cusr assistant wait --json
  cusr assistant wait --lease 0190e9a0-0000-7000-8000-00000000abd0.1 --json
  cusr assistant wait --take --json`,
  options: [
    DATA_DIR,
    { flags: '--lease <id>', description: 'The lease a previous wait printed' },
    { flags: '--take', description: 'Take the lease from another session' },
    {
      flags: '--timeout <seconds>',
      description: `Return with no items after this long (default: ${DEFAULT_TIMEOUT_S})`,
    },
  ],
  async run(values, json, io) {
    const seconds = Number(values['timeout'] ?? DEFAULT_TIMEOUT_S);
    if (!Number.isInteger(seconds) || seconds < 1)
      return badFlag('--timeout must be a positive whole number of seconds.', {}, json, io);
    const deadline = Date.now() + seconds * 1_000;
    // Named here, not by the daemon: a retry after a lost first reply must count as this same session.
    let lease = values['lease'] ?? uuidv7();
    const first = values['take'] === 'true' ? 'take' : 'attach';
    let mode = values['lease'] === undefined || first === 'take' ? first : 'resume';
    for (;;) {
      const r = await call(values, '/v1/query', { kind: 'attention', lease, mode }, null);
      if (r.ok) {
        const data = r.data as Attention;
        lease = data.lease;
        mode = 'resume';
        if (data.items.length > 0) return print(r, json, io);
        // An unreachable daemon is not news: the lease resumes on the first poll after its restart.
      } else if (r.error.code !== 'daemon_unreachable') return print(r, json, io);
      const left = deadline - Date.now();
      if (left <= 0)
        return print(
          r.ok ? okEnvelope({ ...(r.data as Attention), timed_out: true }) : r,
          json,
          io,
        );
      await sleep(Math.min(POLL_MS, left));
    }
  },
};

const SESSION_ENV = 'CLAUDE_CODE_SESSION_ID';
/** Claude Code waits for this hook while the session opens. */
const PEEK_TIMEOUT_MS = 2_000;

export const assistantRegisterCommand: CliCommand = {
  name: 'assistant register',
  description: 'Make this session the one the Stop hook wakes when a task needs a person',
  help: `Needs the Stop hook from deploy/README.md. Takes effect when the current turn ends.

Examples:
  cusr assistant register --json
  cusr assistant register --take --json`,
  options: [
    DATA_DIR,
    { flags: '--session <id>', description: `Session ID (default: $${SESSION_ENV})` },
    { flags: '--take', description: 'Take the lease from another session' },
  ],
  async run(values, json, io) {
    const session = values['session'] ?? process.env[SESSION_ENV];
    if (session === undefined || session === '')
      return badFlag(
        `--session is required outside a session that sets ${SESSION_ENV}.`,
        {},
        json,
        io,
      );
    const take = values['take'] === 'true';
    const r = await call(values, '/v1/query', { kind: 'assistant_register', session, take }, null);
    return print(r, json, io);
  },
};

export const assistantUnregisterCommand: CliCommand = {
  name: 'assistant unregister',
  description: 'Stop waking the registered session; its parked hook exits by itself',
  help: `Example:
  cusr assistant unregister --json`,
  options: [DATA_DIR],
  async run(values, json, io) {
    return print(await call(values, '/v1/query', { kind: 'assistant_unregister' }, null), json, io);
  },
};

/** Context only: this starts no turn, so it costs nothing until the user's first prompt anyway runs. */
export function leaseQuestion(waiting: number): string {
  return `cusr: ${waiting} task(s) need the user and this session does not hold the assistant lease. Early in this conversation, ask the user whether to take the lease. Run cusr assistant register --take only if they say yes.\n`;
}

type HookState = {
  readonly session: string;
  readonly pid: number | null;
  readonly lease: string;
};

export type StopHookDeps = {
  readonly dataDir: string;
  readonly session: string;
  readonly pid: number;
  readonly parkMs: number;
  readonly alive: (pid: number) => boolean;
  readonly query: (lease: string) => Promise<Envelope>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<unknown>;
  readonly stderr: (text: string) => void;
};

function readHookState(file: string): HookState | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as HookState;
  } catch {
    return null;
  }
}

function writeHookState(file: string, state: HookState): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, file);
}

/** IDs and fixed codes only: a title or question is worker text, and this reaches the model unasked. */
export function wakeNote(items: readonly AttentionItem[], truncated: boolean): string {
  const listed = items.map((i) => `${i.task_id} (${i.code})`).join(', ');
  return `cusr: tasks need the user: ${listed}${truncated ? ', and more' : ''}. Read them with cusr inbox and cusr task explain, then relay them to the user. This note approves nothing.\n`;
}

/**
 * Parks for one Stop of the registered session. Claude Code runs this in the background, so the user can
 * keep talking, and starts one on every Stop without deduplicating: a live hook keeps the job.
 */
export async function runStopHook(d: StopHookDeps): Promise<number> {
  if (registeredSession(d.dataDir) !== d.session) return ExitCode.ok;
  const file = join(d.dataDir, HOOK_FILE);
  const prior = readHookState(file);
  const own = prior?.session === d.session ? prior : null;
  if (typeof own?.pid === 'number' && own.pid !== d.pid && d.alive(own.pid)) return ExitCode.ok;
  // Coming back with the lease of the last wake confirms that wake arrived.
  let lease = own?.lease ?? d.session;
  writeHookState(file, { session: d.session, pid: d.pid, lease });
  // A session that took over may already track its own hook here; that file is no longer this hook's.
  const mine = (): boolean => {
    const now = readHookState(file);
    return now?.session === d.session && now.pid === d.pid;
  };
  const release = (reached: string): void => {
    if (mine()) writeHookState(file, { session: d.session, pid: null, lease: reached });
  };
  const deadline = d.now() + d.parkMs;
  for (;;) {
    const r = await d.query(lease);
    if (r.ok) {
      const data = r.data as Attention;
      lease = data.lease;
      if (data.items.length > 0) {
        release(lease);
        d.stderr(wakeNote(data.items as AttentionItem[], data.truncated === true));
        return WAKE_SESSION;
      }
    } else if (r.error.code !== 'daemon_unreachable') {
      if (mine()) rmSync(file, { force: true });
      return ExitCode.ok;
    }
    const left = deadline - d.now();
    if (left <= 0) {
      // Never wakes without news: the next Stop parks again and the daemon still holds what is unconfirmed.
      release(lease);
      return ExitCode.ok;
    }
    await d.sleep(Math.min(POLL_MS, left));
  }
}

/** A recycled pid must not pass for a parked hook and silence the session. */
function hookAlive(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('assistant');
  } catch {
    return false;
  }
}

function payloadSession(): string | null {
  try {
    const session: unknown = (JSON.parse(readFileSync(0, 'utf8')) as { session_id?: unknown })
      .session_id;
    return typeof session === 'string' ? session : null;
  } catch {
    return null;
  }
}

export const assistantSessionStartCommand: CliCommand = {
  name: 'assistant session-start',
  description:
    'SessionStart hook: reminds a session to ask about the lease. Not for running by hand',
  help: `Reads the hook payload on stdin; see deploy/README.md. Prints nothing unless a task waits.`,
  options: [DATA_DIR],
  async run(values, _json, io) {
    // A worker can read the owner's settings, and must never be told about cusr.
    if (process.env[OPERATION_ENV] !== undefined) return ExitCode.ok;
    const session = payloadSession();
    if (session === null) return ExitCode.ok;
    if (registeredSession(resolveDataDir(values['dataDir'])) === session) return ExitCode.ok;
    const r = await call(values, '/v1/query', { kind: 'attention_peek' }, null, PEEK_TIMEOUT_MS);
    const waiting = r.ok ? (r.data as { waiting: number }).waiting : 0;
    if (waiting > 0) io.stdout(leaseQuestion(waiting));
    return ExitCode.ok;
  },
};

export const assistantHookCommand: CliCommand = {
  name: 'assistant hook',
  description: 'Stop hook for the registered session; exit 2 wakes it. Not for running by hand',
  help: `Reads the Stop payload on stdin. Register it with "asyncRewake": true; see deploy/README.md.`,
  options: [
    DATA_DIR,
    {
      flags: '--timeout <seconds>',
      description: `Stop parking after this long, waking nobody (default: ${DEFAULT_PARK_S})`,
    },
  ],
  async run(values, json, io) {
    const seconds = Number(values['timeout'] ?? DEFAULT_PARK_S);
    if (!Number.isInteger(seconds) || seconds < 1)
      return badFlag('--timeout must be a positive whole number of seconds.', {}, json, io);
    const session = payloadSession();
    if (session === null) return ExitCode.ok;
    return runStopHook({
      dataDir: resolveDataDir(values['dataDir']),
      session,
      pid: process.pid,
      parkMs: seconds * 1_000,
      alive: hookAlive,
      query: (lease) => call(values, '/v1/query', { kind: 'attention', lease, mode: 'hook' }, null),
      now: Date.now,
      sleep,
      stderr: io.stderr,
    });
  },
};
