import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { v7 as uuidv7 } from 'uuid';
import { registeredSession, type AttentionItem } from '../application/attention.ts';
import {
  HARNESSES,
  codexBinary,
  findAncestor,
  findHarness,
  isAncestor,
  ownerWatch,
  queueToCodex,
  type Harness,
} from './assistant-harness.ts';
import { resolveDataDir } from './client.ts';
import { ExitCode, okEnvelope, type Envelope } from './output.ts';
import type { CliCommand, CliIo } from './program.ts';
import { DATA_DIR, badFlag, call, print } from './tasks.ts';

const POLL_MS = 2_000;

/** Below the hook `timeout` in the settings, so the hook ends by itself instead of being killed. */
const DEFAULT_PARK_S = 604_500;
/** Claude Code wakes the session on this exit and shows it stderr; the pi extension reads stdout. */
const WAKE_SESSION = 2;
const HOOK_FILE = 'assistant-hook.json';
/** Longer than `codex queue` may take, so a hook that waits outlasts the delivery it waits for. */
const DELIVERY_WAIT_MS = 25_000;
const DELIVERY_POLL_MS = 200;

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
      flags: '--owner-pid <pid>',
      description:
        'Stop waiting when this process ends (default: the nearest claude, codex or pi ancestor)',
    },
    {
      flags: '--timeout <seconds>',
      description:
        'Return with no items after this long (default: wait until something needs a person)',
    },
  ],
  async run(values, json, io) {
    const seconds = values['timeout'] === undefined ? null : Number(values['timeout']);
    if (seconds !== null && (!Number.isInteger(seconds) || seconds < 1))
      return badFlag('--timeout must be a positive whole number of seconds.', {}, json, io);
    const ownerPid = values['ownerPid'] === undefined ? null : Number(values['ownerPid']);
    if (ownerPid !== null && (!Number.isInteger(ownerPid) || ownerPid < 1))
      return badFlag('--owner-pid must be a process ID.', {}, json, io);
    // A timeout only wakes the session for nothing. What ends a wait nobody reads is its session dying;
    // the shell that ran this in the background may end long before that, so the harness is watched.
    const deadline = seconds === null ? Number.POSITIVE_INFINITY : Date.now() + seconds * 1_000;
    const owner = ownerPid ?? findHarness(process.ppid);
    const ownerAlive = owner === null ? () => true : (ownerWatch(owner) ?? (() => false));
    // Named here, not by the daemon: a retry after a lost first reply must count as this same session.
    let lease = values['lease'] ?? uuidv7();
    const first = values['take'] === 'true' ? 'take' : 'attach';
    let mode = values['lease'] === undefined || first === 'take' ? first : 'resume';
    for (;;) {
      // Its session is gone: stopping lets the lease go stale for the next one.
      if (!ownerAlive()) return ExitCode.ok;
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

/** A harness started from another inherits that one's variable; Claude Code's stays last for that. */
const SESSION_ENVS = ['PI_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID'] as const;
/** Claude Code waits for this hook while the session opens. */
const PEEK_TIMEOUT_MS = 2_000;

export const assistantRegisterCommand: CliCommand = {
  name: 'assistant register',
  description: 'Make this session the one the hooks wake when a task needs a person',
  help: `Needs the hooks cusr init installs; see deploy/README.md. Takes effect when the current turn ends.

Examples:
  cusr assistant register --json
  cusr assistant register --take --json`,
  options: [
    DATA_DIR,
    {
      flags: '--session <id>',
      description: `Session ID (default: the first set of ${SESSION_ENVS.map((e) => `$${e}`).join(', ')})`,
    },
    { flags: '--take', description: 'Take the lease from another session' },
  ],
  async run(values, json, io) {
    const session =
      values['session'] ??
      SESSION_ENVS.map((e) => process.env[e]).find((v) => v !== undefined && v !== '');
    if (session === undefined || session === '')
      return badFlag(
        `--session is required outside a session that sets ${SESSION_ENVS.join(', ')}.`,
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
  /** The harness process, when the hook watches one. */
  readonly owner?: number | null;
  /** Another session opened in that process, so this one no longer gets news. */
  readonly retired?: boolean;
  /** `pid` is handing over a wake, so `lease` does not yet say whether it arrived. */
  readonly delivering?: boolean;
};

/** `confirmed` says the wake arrived; only then may the next hook come back with its lease. */
export type Delivery = { readonly exit: number; readonly confirmed: boolean };

export type StopHookDeps = {
  readonly dataDir: string;
  readonly session: string;
  readonly pid: number;
  readonly parkMs: number;
  readonly alive: (pid: number) => boolean;
  readonly owner: number | null;
  /** False once the harness process is gone: nobody is left to wake. */
  readonly ownerAlive: () => boolean;
  readonly query: (lease: string) => Promise<Envelope>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<unknown>;
  /** The lease of a wake the harness saw arrive, for a harness that confirms after this hook ended. */
  readonly confirm?: string;
  readonly deliver: (note: string, lease: string) => Promise<Delivery>;
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
 * Parks for one Stop of the registered session. The harness runs this in the background, so the user can
 * keep talking, and starts one on every Stop without deduplicating: a live hook keeps the job.
 */
export async function runStopHook(d: StopHookDeps): Promise<number> {
  if (registeredSession(d.dataDir) !== d.session) return ExitCode.ok;
  const file = join(d.dataDir, HOOK_FILE);
  const ownState = (): HookState | null => {
    const now = readHookState(file);
    return now?.session === d.session ? now : null;
  };
  let own = ownState();
  // The turn a wake starts can Stop before its delivery ends. Its hook must wait to learn the outcome:
  // leaving would park nobody, and coming back with the new lease would confirm a wake that may fail.
  for (let waited = 0; typeof own?.pid === 'number' && own.pid !== d.pid && d.alive(own.pid);) {
    if (own.delivering !== true || waited >= DELIVERY_WAIT_MS) return ExitCode.ok;
    await d.sleep(DELIVERY_POLL_MS);
    waited += DELIVERY_POLL_MS;
    own = ownState();
  }
  if (own?.retired === true) return ExitCode.ok;
  // Coming back with the lease of the last wake confirms that wake arrived.
  let lease = d.confirm ?? own?.lease ?? d.session;
  writeHookState(file, { session: d.session, pid: d.pid, lease, owner: d.owner });
  // A session that took over may already track its own hook here; that file is no longer this hook's.
  const mine = (): boolean => {
    const now = readHookState(file);
    return now?.session === d.session && now.pid === d.pid;
  };
  const release = (reached: string): void => {
    if (mine())
      writeHookState(file, { session: d.session, pid: null, lease: reached, owner: d.owner });
  };
  const ended = (): boolean => !d.ownerAlive() || readHookState(file)?.retired === true;
  const deadline = d.now() + d.parkMs;
  for (;;) {
    if (ended()) {
      release(lease);
      return ExitCode.ok;
    }
    const before = lease;
    const r = await d.query(lease);
    if (r.ok) {
      const data = r.data as Attention;
      lease = data.lease;
      if (data.items.length > 0) {
        if (ended()) {
          release(before);
          return ExitCode.ok;
        }
        if (mine())
          writeHookState(file, {
            session: d.session,
            pid: d.pid,
            lease: before,
            owner: d.owner,
            delivering: true,
          });
        const sent = await d.deliver(
          wakeNote(data.items as AttentionItem[], data.truncated === true),
          lease,
        );
        // Without the new lease the items stay unconfirmed, so the daemon sends them again.
        release(sent.confirmed ? lease : before);
        return sent.exit;
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

/**
 * Codex keeps a thread loaded after `/new`, so its process stays alive and a wake would run as a turn
 * nobody sees and count as delivered. A session opening inside the registered session's process ends
 * that: the news stays unconfirmed, and the lease stays where the user put it.
 */
export function noteSessionStart(
  dataDir: string,
  session: string,
  inOwner: (owner: number) => boolean,
): void {
  const registered = registeredSession(dataDir);
  const file = join(dataDir, HOOK_FILE);
  const state = readHookState(file);
  if (registered === null || state?.session !== registered) return;
  if (session === registered) {
    if (state.retired === true) {
      const { retired: _, ...active } = state;
      writeHookState(file, active);
    }
    return;
  }
  if (state.retired !== true && typeof state.owner === 'number' && inOwner(state.owner))
    writeHookState(file, { ...state, pid: null, retired: true });
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
    const session = payloadSession();
    if (session === null) return ExitCode.ok;
    const dataDir = resolveDataDir(values['dataDir']);
    noteSessionStart(dataDir, session, (owner) => isAncestor(process.ppid, owner));
    if (registeredSession(dataDir) === session) return ExitCode.ok;
    const r = await call(values, '/v1/query', { kind: 'attention_peek' }, null, PEEK_TIMEOUT_MS);
    const waiting = r.ok ? (r.data as { waiting: number }).waiting : 0;
    if (waiting > 0) io.stdout(leaseQuestion(waiting));
    return ExitCode.ok;
  },
};

/** The harness process to watch; Claude Code ends its own hooks. */
function ownerOf(harness: Harness, ownerPid: number | null): number | null {
  if (ownerPid !== null) return ownerPid;
  return harness === 'codex' ? findAncestor(process.ppid, 'codex') : null;
}

function deliverer(harness: Harness, session: string, owner: number | null, io: CliIo) {
  return async (note: string, lease: string): Promise<Delivery> => {
    if (harness === 'codex') {
      const binary = owner === null ? 'codex' : codexBinary(owner);
      const confirmed = await queueToCodex(binary, session, note);
      return { exit: ExitCode.ok, confirmed };
    }
    // pi can refuse a message without saying so: the extension confirms once it sees the note arrive.
    if (harness === 'pi') {
      io.stdout(JSON.stringify({ note: note.trim(), lease }));
      return { exit: WAKE_SESSION, confirmed: false };
    }
    io.stderr(note);
    return { exit: WAKE_SESSION, confirmed: true };
  };
}

export const assistantHookCommand: CliCommand = {
  name: 'assistant hook',
  description: 'Parks for the registered session and wakes it. Not for running by hand',
  help: `Reads the Stop payload on stdin; see deploy/README.md. Claude Code needs "asyncRewake": true,
Codex needs "async": true, and the pi extension from cusr init starts this itself.`,
  options: [
    DATA_DIR,
    {
      flags: '--harness <name>',
      description: `Who to wake: ${HARNESSES.join(', ')} (default: claude)`,
    },
    { flags: '--owner-pid <pid>', description: 'Stop parking when this process ends' },
    { flags: '--confirm <lease>', description: 'Confirm the wake this lease came with' },
    {
      flags: '--timeout <seconds>',
      description: `Stop parking after this long, waking nobody (default: ${DEFAULT_PARK_S})`,
    },
  ],
  async run(values, json, io) {
    const seconds = Number(values['timeout'] ?? DEFAULT_PARK_S);
    if (!Number.isInteger(seconds) || seconds < 1)
      return badFlag('--timeout must be a positive whole number of seconds.', {}, json, io);
    const harness = (values['harness'] ?? 'claude') as Harness;
    if (!HARNESSES.includes(harness))
      return badFlag(`--harness must be one of ${HARNESSES.join(', ')}.`, {}, json, io);
    const ownerPid = values['ownerPid'] === undefined ? null : Number(values['ownerPid']);
    if (ownerPid !== null && (!Number.isInteger(ownerPid) || ownerPid < 1))
      return badFlag('--owner-pid must be a process ID.', {}, json, io);
    const session = payloadSession();
    if (session === null) return ExitCode.ok;
    const owner = ownerOf(harness, ownerPid);
    // Without an owner to watch the hook would outlive the session, so it does not park at all.
    if (owner === null && harness !== 'claude') return ExitCode.ok;
    const ownerAlive = owner === null ? () => true : ownerWatch(owner);
    if (ownerAlive === null) return ExitCode.ok;
    return runStopHook({
      dataDir: resolveDataDir(values['dataDir']),
      session,
      pid: process.pid,
      parkMs: seconds * 1_000,
      alive: hookAlive,
      owner,
      ownerAlive,
      query: (lease) => call(values, '/v1/query', { kind: 'attention', lease, mode: 'hook' }, null),
      now: Date.now,
      sleep,
      ...(values['confirm'] === undefined ? {} : { confirm: values['confirm'] }),
      deliver: deliverer(harness, session, owner, io),
    });
  },
};
