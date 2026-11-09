import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { v7 as uuidv7 } from 'uuid';
import { registeredSession, replacedSessions } from '../application/assistant-session.ts';
import type { AttentionItem, AttentionPeek, RegisterReply } from '../application/attention.ts';
import {
  ASSISTANT_SETTINGS_PATH,
  CODEX_HOOKS_PATH,
  PI_EXTENSION_PATH,
} from '../application/init-assistant.ts';
import {
  HARNESSES,
  codexBinary,
  findAncestor,
  findHarness,
  isAncestor,
  isAppServer,
  ownerWatch,
  queueToCodex,
  type Harness,
} from './assistant-harness.ts';
import { resolveDataDir } from './client.ts';
import { ExitCode, okEnvelope, type Envelope } from './output.ts';
import type { CliCommand, CliIo } from './program.ts';
import { DATA_DIR, badFlag, queryDaemon } from './base.ts';

const POLL_MS = 2_000;

/** The hooks never print an envelope, so they skip the YAML and schema modules `print` brings. */
const loadTasks = () => import('./tasks.ts');

/** Below the hook `timeout` in the settings, so the hook ends by itself instead of being killed. */
const DEFAULT_PARK_S = 604_500;
/** Claude Code wakes the session on this exit and shows it stderr; the pi extension reads stdout. */
const WAKE_SESSION = 2;
const HOOK_FILE = 'assistant-hook.json';
/** One per replaced session, so hooks of different sessions never write the same file. */
const MOVED_FILE_PREFIX = 'assistant-moved-told.';

function movedToldFile(dataDir: string, session: string): string {
  return join(dataDir, `${MOVED_FILE_PREFIX}${encodeURIComponent(session)}`);
}
/** Longer than `codex queue` may take, so a hook that waits outlasts the delivery it waits for. */
const DELIVERY_WAIT_MS = 25_000;
const DELIVERY_POLL_MS = 200;
/** A daemon down this long is no restart: tasks stand still until someone looks. */
export const UNREACHABLE_WAKE_MS = 5 * 60_000;

/** A daemon that is down or too busy to answer: both resume on a later poll. */
const unreachable = (code: string): boolean =>
  code === 'daemon_unreachable' || code === 'daemon_timeout';
/** Between tries of a note `codex queue` failed to hand over; the hook keeps parking meanwhile. */
export const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;

/**
 * A usage error on the hook path must not exit with `WAKE_SESSION`: a broken hook command would wake the
 * session on every Stop with its own error text.
 */
function hookFlag(message: string, json: boolean, io: CliIo): number {
  badFlag(message, {}, json, io);
  return ExitCode.failure;
}

type Attention = {
  readonly lease: string;
  readonly items: readonly unknown[];
  readonly truncated?: boolean;
};

export const assistantWaitCommand: CliCommand = {
  name: 'assistant wait',
  description:
    'Hold the assistant lease and wait until a task needs a person or ends; prints it and exits. Uses no agent turns',
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
        'Return with no items after this long (default: wait until a task needs a person or ends)',
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
    let downSince: number | null = null;
    const { print } = await loadTasks();
    for (;;) {
      // Its session is gone: stopping lets the lease go stale for the next one.
      if (!ownerAlive()) return ExitCode.ok;
      const r = await queryDaemon(values, { kind: 'attention', lease, mode });
      if (r.ok) {
        const data = r.data as Attention;
        lease = data.lease;
        mode = 'resume';
        downSince = null;
        if (data.items.length > 0) return print(r, json, io);
      } else if (!unreachable(r.error.code)) return print(r, json, io);
      else {
        // A restart is not news: the lease resumes on the first poll after it. A daemon that stays down is.
        downSince ??= Date.now();
        if (Date.now() - downSince >= UNREACHABLE_WAKE_MS) return print(r, json, io);
      }
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
  description: 'Make this session the one the hooks wake when a task needs a person or ends',
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
    const { print } = await loadTasks();
    const r = await queryDaemon(values, { kind: 'assistant_register', session, take });
    if (!r.ok) return print(r, json, io);
    const data = r.data as RegisterReply;
    // A daemon older than this CLI replies without a lease; its first wake then repeats what waits.
    if (typeof data.lease === 'string')
      noteRegistered(resolveDataDir(values['dataDir']), session, data.lease);
    const warnings = stopHookFound(process.cwd(), homedir())
      ? []
      : [
          `No cusr Stop hook found for ${process.cwd()}, so nothing will wake this session. Run cusr init here, or use cusr assistant wait.`,
        ];
    return print(
      okEnvelope({
        ...data,
        guidance:
          (data.items ?? []).length > 0
            ? 'Relay the items listed here to the user now; the Stop hook will not wake this session for them again, only for what comes after.'
            : 'Nothing waits now. The Stop hook wakes this session when a task needs the user or ends; do not poll.',
        ...(warnings.length > 0 ? { warnings } : {}),
      }),
      json,
      io,
    );
  },
};

const HOOK_MARK = 'cusr assistant hook';

/** Where `cusr init` puts the Stop hook; a harness also reads the user's own settings. */
export function stopHookFound(cwd: string, home: string): boolean {
  const has = (path: string, mark: string): boolean => {
    try {
      return readFileSync(path, 'utf8').includes(mark);
    } catch {
      return false;
    }
  };
  return (
    [
      join(cwd, ASSISTANT_SETTINGS_PATH),
      join(cwd, '.claude/settings.json'),
      join(home, '.claude/settings.json'),
      join(cwd, CODEX_HOOKS_PATH),
      join(home, '.codex/hooks.json'),
    ].some((p) => has(p, HOOK_MARK)) || existsSync(join(cwd, PI_EXTENSION_PATH))
  );
}

/**
 * The register reply already listed what waits; the first Stop hook comes back with its lease to confirm
 * that, instead of waking the session for the same tasks a second time.
 */
export function noteRegistered(dataDir: string, session: string, lease: string): void {
  // A note about an earlier move, still unacknowledged, must not stand for the next move.
  rmSync(movedToldFile(dataDir, session), { force: true });
  const file = join(dataDir, HOOK_FILE);
  const state = readHookState(file);
  if (state?.session === session) {
    const { retired: _, ...rest } = state;
    writeHookState(file, { ...rest, lease });
  } else writeHookState(file, { session, pid: null, lease });
}

export const assistantUnregisterCommand: CliCommand = {
  name: 'assistant unregister',
  description: 'Stop waking the registered session; its parked hook exits by itself',
  help: `Example:
  cusr assistant unregister --json`,
  options: [
    DATA_DIR,
    {
      flags: '--session <id>',
      description:
        'Only if this session is the registered one (default: as for register; none outside a session)',
    },
  ],
  async run(values, json, io) {
    const session =
      values['session'] ??
      SESSION_ENVS.map((e) => process.env[e]).find((v) => v !== undefined && v !== '');
    const body = { kind: 'assistant_unregister', ...(session === undefined ? {} : { session }) };
    const { print } = await loadTasks();
    return print(await queryDaemon(values, body), json, io);
  },
};

/** Context only: this starts no turn, so it costs nothing until the user's first prompt anyway runs. */
export function leaseQuestion(
  waiting: number,
  tasks: readonly { readonly task_id: string; readonly code: string }[] = [],
): string {
  const listed = tasks.map((t) => `${t.task_id} (${t.code})`).join(', ');
  const named = listed === '' ? '' : `: ${listed}${tasks.length < waiting ? ', and more' : ''}`;
  return `cusr: ${waiting} task(s) need the user${named}. This session does not hold the assistant lease. Early in this conversation, ask the user whether to take the lease. Run cusr assistant register --take only if they say yes. Read the tasks with cusr inbox.\n`;
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
  /** The session was told the daemon is down; told again only after it came back. */
  readonly unreachable?: boolean;
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
  /** Tells the daemon this replaced session got the note that the lease moved. */
  readonly ackMoved: () => Promise<Envelope>;
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

/** Item codes of a task that ended (`ENDED_CODES` in the daemon); kept here so the hook loads no daemon code. */
const ENDED = new Set(['done', 'failed', 'cancelled']);

/** IDs and fixed codes only: a title or question is worker text, and this reaches the model unasked. */
export function wakeNote(items: readonly AttentionItem[], truncated: boolean): string {
  const list = (xs: readonly AttentionItem[]) =>
    xs.map((i) => `${i.task_id} (${i.code})`).join(', ');
  const waits = items.filter((i) => !ENDED.has(i.code));
  const ended = items.filter((i) => ENDED.has(i.code));
  const more = truncated ? ', and more' : '';
  const parts = [
    ...(waits.length > 0
      ? [
          `cusr: tasks need the user: ${list(waits)}${more}. Read them with cusr inbox and cusr task explain, then relay them to the user.`,
        ]
      : []),
    ...(ended.length > 0
      ? [
          `cusr: tasks ended: ${list(ended)}${waits.length > 0 ? '' : more}. Read the outcome with cusr task show, tell the user, and go on with what was waiting for them.`,
        ]
      : []),
  ];
  return `${parts.join(' ')} This note approves nothing.\n`;
}

export function unreachableNote(dataDir: string): string {
  return `cusr: daemon unreachable at ${dataDir} for ${UNREACHABLE_WAKE_MS / 60_000} minutes, so no task moves. Run cusr status and tell the user. This note is not repeated until the daemon comes back and goes down again.\n`;
}

/**
 * What a hook hands with a note that carries no lease, so that pi, which confirms a note with the lease
 * it came with, can say the note arrived. Never sent to the daemon.
 */
export const MOVED_TOKEN = 'lease-moved';
export const DOWN_TOKEN = 'daemon-down';

export const LEASE_MOVED_NOTE =
  'cusr: another session took the assistant lease; this session no longer gets task news. Run cusr assistant register --take only if the user asks to move it back.\n';

/**
 * Parks for one Stop of the registered session. The harness runs this in the background, so the user can
 * keep talking, and starts one on every Stop without deduplicating: a live hook keeps the job.
 */
export async function runStopHook(d: StopHookDeps): Promise<number> {
  const replaced = (): boolean => replacedSessions(d.dataDir).includes(d.session);
  // The hook's own record that the note arrived, kept while the daemon cannot take the ack: without it
  // every Stop would wake the session again with the same note until the daemon is back.
  const toldFile = movedToldFile(d.dataDir, d.session);
  const ack = async (): Promise<void> => {
    if ((await d.ackMoved()).ok) rmSync(toldFile, { force: true });
  };
  const noteTold = async (): Promise<void> => {
    writeFileSync(toldFile, '', { mode: 0o600 });
    await ack();
  };
  // Told once, also when no hook of this session was parked as the lease moved; only a confirmed note counts.
  const tellMoved = async (): Promise<number> => {
    if (existsSync(toldFile)) {
      await ack();
      return ExitCode.ok;
    }
    if (d.confirm === MOVED_TOKEN) {
      await noteTold();
      return ExitCode.ok;
    }
    const end = d.now() + d.parkMs;
    for (let wait = RETRY_MIN_MS; ; wait = Math.min(2 * wait, RETRY_MAX_MS)) {
      const sent = await d.deliver(LEASE_MOVED_NOTE, MOVED_TOKEN);
      if (sent.confirmed) {
        await noteTold();
        return sent.exit;
      }
      // pi takes the note over and confirms it later. A failed codex queue leaves an idle session with no
      // Stop to come, so this hook keeps trying while it may park.
      if (sent.exit !== ExitCode.ok || d.now() + wait > end) return sent.exit;
      await d.sleep(wait);
      if (!d.ownerAlive() || !replaced()) return ExitCode.ok;
    }
  };
  // A record left from an earlier replacement must not silence the next one.
  if (!replaced()) rmSync(toldFile, { force: true });
  if (registeredSession(d.dataDir) !== d.session) return replaced() ? tellMoved() : ExitCode.ok;
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
  const confirm = d.confirm === DOWN_TOKEN || d.confirm === MOVED_TOKEN ? undefined : d.confirm;
  let lease = confirm ?? own?.lease ?? d.session;
  let told = own?.unreachable === true || d.confirm === DOWN_TOKEN;
  const save = (pid: number | null, reached: string, delivering = false): void =>
    writeHookState(file, {
      session: d.session,
      pid,
      lease: reached,
      owner: d.owner,
      ...(delivering ? { delivering: true } : {}),
      ...(told ? { unreachable: true } : {}),
    });
  save(d.pid, lease);
  // A session that took over may already track its own hook here; that file is no longer this hook's.
  const tracked = (): HookState | null => {
    const now = readHookState(file);
    return now?.session === d.session && now.pid === d.pid ? now : null;
  };
  const mine = (): boolean => tracked() !== null;
  const release = (reached: string): void => {
    if (mine()) save(null, reached);
  };
  const ended = (): boolean => !d.ownerAlive() || readHookState(file)?.retired === true;
  const deadline = d.now() + d.parkMs;
  let downSince: number | null = null;
  let retryAt = 0;
  let retryWait = RETRY_MIN_MS;
  for (;;) {
    if (ended()) {
      release(lease);
      return ExitCode.ok;
    }
    const state = tracked();
    // Another hook of this session took the job, or another session took the lease.
    if (state === null) return replaced() ? tellMoved() : ExitCode.ok;
    // A register in this session moved the lease on past what it listed.
    lease = state.lease;
    const before = lease;
    const r = await d.query(lease);
    if (r.ok) {
      const data = r.data as Attention;
      lease = data.lease;
      downSince = null;
      retryAt = 0;
      retryWait = RETRY_MIN_MS;
      if (told) {
        told = false;
        if (mine()) save(d.pid, before);
      }
      if (data.items.length > 0) {
        if (ended()) {
          release(before);
          return ExitCode.ok;
        }
        if (mine()) save(d.pid, before, true);
        const sent = await d.deliver(
          wakeNote(data.items as AttentionItem[], data.truncated === true),
          lease,
        );
        // Without the new lease the items stay unconfirmed, so the daemon sends them again.
        release(sent.confirmed ? lease : before);
        return sent.exit;
      }
      if (lease !== before && mine()) save(d.pid, lease);
    } else if (unreachable(r.error.code)) {
      downSince ??= d.now();
      if (!told && d.now() - downSince >= UNREACHABLE_WAKE_MS && d.now() >= retryAt) {
        const sent = await d.deliver(unreachableNote(d.dataDir), DOWN_TOKEN);
        // pi confirms with DOWN_TOKEN on its next hook, so only a confirmed note marks it told.
        if (sent.confirmed || sent.exit !== ExitCode.ok) {
          told = sent.confirmed;
          release(lease);
          return sent.exit;
        }
        // A failed codex queue: no Stop will follow in an idle session, so keep parking and try again
        // until it arrives or the daemon is back.
        retryAt = d.now() + retryWait;
        retryWait = Math.min(2 * retryWait, RETRY_MAX_MS);
      }
    } else {
      if (mine()) rmSync(file, { force: true });
      if (r.error.code === 'attention_superseded' || replaced()) return tellMoved();
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

/**
 * A Codex app-server holds many threads (the Codex app, an IDE, Paseo), so a thread opening in it is not
 * the registered one going away.
 */
export function retiresIn(
  owner: number,
  from: number,
  inside: (from: number, owner: number) => boolean = isAncestor,
  appServer: (pid: number) => boolean = isAppServer,
): boolean {
  return !appServer(owner) && inside(from, owner);
}

/**
 * How many waits to ask about; 0 when a live holder was already sent everything. A dead holder still gets
 * the question, since nobody else would relay its news (#244 keeps taking it a user decision).
 */
export function askAbout(peek: AttentionPeek): number {
  return peek.held === true ? peek.undelivered : peek.waiting;
}

/** The tasks {@link askAbout} counts; an older daemon sends none. */
function askedTasks(peek: AttentionPeek): AttentionPeek['tasks'] {
  const tasks = peek.tasks ?? [];
  return peek.held === true ? tasks.filter((t) => t.undelivered) : tasks;
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
    noteSessionStart(dataDir, session, (owner) => retiresIn(owner, process.ppid));
    if (registeredSession(dataDir) === session) return ExitCode.ok;
    const r = await queryDaemon(values, { kind: 'attention_peek' }, PEEK_TIMEOUT_MS);
    const peek = r.ok ? (r.data as AttentionPeek) : null;
    const waiting = peek === null ? 0 : askAbout(peek);
    if (peek !== null && waiting > 0) io.stdout(leaseQuestion(waiting, askedTasks(peek)));
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
      return hookFlag('--timeout must be a positive whole number of seconds.', json, io);
    const harness = (values['harness'] ?? 'claude') as Harness;
    if (!HARNESSES.includes(harness))
      return hookFlag(`--harness must be one of ${HARNESSES.join(', ')}.`, json, io);
    const ownerPid = values['ownerPid'] === undefined ? null : Number(values['ownerPid']);
    if (ownerPid !== null && (!Number.isInteger(ownerPid) || ownerPid < 1))
      return hookFlag('--owner-pid must be a process ID.', json, io);
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
      query: (lease) => queryDaemon(values, { kind: 'attention', lease, mode: 'hook' }),
      now: Date.now,
      sleep,
      ...(values['confirm'] === undefined ? {} : { confirm: values['confirm'] }),
      deliver: deliverer(harness, session, owner, io),
      ackMoved: () => queryDaemon(values, { kind: 'assistant_moved_ack', session }),
    });
  },
};
