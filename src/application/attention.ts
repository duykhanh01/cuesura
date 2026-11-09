/**
 * Which assistant session relays what needs a person (issue #166). The lease only routes news: it grants
 * nothing and anyone with the right role may still answer. It lives in memory because a lost lease loses
 * no fact: what needs a person is rebuilt from the tasks. Delivery is at least once: what was sent counts as
 * received only when the holder comes back with the lease of that reply.
 */
import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { TASK_STATUSES, isTerminal, type TaskState } from '../domain/state.ts';
import { effectUnknownDueAt, needsUser } from '../explain/needs-user.ts';
import { statusSinceReader, type StatusSince } from './board.ts';
import type { Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import { authorize, type Caller } from './authz.ts';
import { INBOX_LIMIT, openQuestions } from './inbox.ts';
import type { AppError } from './queries.ts';
import {
  ASSISTANT_SESSION_FILE,
  readSessionFile,
  registeredSession,
  replacedSessions,
} from './assistant-session.ts';

/** With no poll for this long the holder has gone, and a new session needs no `take`. */
export const ATTENTION_STALE_MS = 10_000;

export { ASSISTANT_SESSION_FILE, registeredSession, replacedSessions };

const LIVE = TASK_STATUSES.filter((s) => !isTerminal(s));

const AttentionQuerySchema = z
  .object({
    kind: z.literal('attention').optional(),
    /** `<id>`, or `<id>.<batch>` as a reply printed it: coming back with it confirms that batch arrived. */
    lease: z.string().regex(/^[^.]+(\.\d+)?$/),
    /** `hook` is a Stop hook parked for its session: it never claims the lease. */
    mode: z.enum(['attach', 'resume', 'take', 'hook']),
  })
  .strict();

const SESSION_ID = z.string().regex(/^[^.]+$/);

const RegisterSchema = z
  .object({
    kind: z.literal('assistant_register').optional(),
    session: SESSION_ID,
    take: z.boolean().optional(),
  })
  .strict();

const MovedAckSchema = z
  .object({ kind: z.literal('assistant_moved_ack').optional(), session: SESSION_ID })
  .strict();

const UnregisterSchema = z
  .object({
    kind: z.literal('assistant_unregister').optional(),
    /** When given, only this session's registration goes. */
    session: SESSION_ID.optional(),
  })
  .strict();

const LEASE_GUIDANCE =
  'Pass --lease exactly as the last cusr assistant wait printed it, or leave it out to start a new wait.';

type Mode = z.infer<typeof AttentionQuerySchema>['mode'];

export type AttentionItem = {
  readonly task_id: string;
  readonly project: string;
  readonly title: string;
  readonly code: string;
  readonly question_id: string | null;
  readonly question: string | null;
  readonly task_version: number;
};

export type AttentionReply = {
  readonly lease: string;
  readonly items: readonly AttentionItem[];
  readonly truncated: boolean;
};

export type AttentionPeek = {
  readonly waiting: number;
  /** The holder polled within `ATTENTION_STALE_MS`. */
  readonly held: boolean;
  /** Waits the holder has not been sent yet. */
  readonly undelivered: number;
  /** The waits themselves, IDs and codes only, in task order; at most `INBOX_LIMIT`. Absent from an older daemon. */
  readonly tasks?: readonly {
    readonly task_id: string;
    readonly code: string;
    readonly undelivered: boolean;
  }[];
};

export type RegisterReply = AttentionReply & { readonly session: string };

type Holder = {
  readonly id: string;
  seenAt: number;
  /** Numbers the batches sent, so a reply lost on the way is not taken for one that arrived. */
  batch: number;
  offered: readonly string[];
  delivered: ReadonlySet<string>;
  /** Log position and decider version already looked at; null while something is still to send or to be confirmed. */
  seq: string | null;
  /** Rebuilt from disk, so `batch` is not yet known: the client's first lease tells where it stood. */
  restored: boolean;
  /** When the next `effect_unknown` wait looked at reaches its threshold (#249); null when none will. */
  due: number | null;
};

type Keyed = { readonly key: string; readonly item: AttentionItem };
type Ended = Keyed & { readonly seq: number };

/** Item codes for a task that ended; they wake the holder like a wait does, but need no person. */
export const ENDED_CODES = { DONE: 'done', FAILED: 'failed', CANCELLED: 'cancelled' } as const;

/** The decider's view of what it may still answer itself (`Decider.holds`/`version`). */
export type DeciderWatch = {
  readonly holds: (s: TaskState) => boolean;
  readonly version: () => number;
};

function keyed(s: TaskState, enteredAt: number): Keyed {
  const code = s.wait?.detail.code ?? 'run_config_unconfirmed';
  const q = openQuestions(s).find((x) => x.blocking) ?? null;
  return {
    key: `${s.id}:${s.revision}:${code}:${enteredAt}`,
    item: {
      task_id: s.id,
      project: s.project,
      title: s.task.title,
      code,
      question_id: q?.question_id ?? null,
      question: q?.body ?? null,
      task_version: s.version,
    },
  };
}

function invalid(
  message: string,
  issues: readonly z.core.$ZodIssue[],
  guidance?: string,
): Result<never, AppError> {
  return err({
    code: 'invalid_request',
    message,
    details: {
      issues: issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      ...(guidance === undefined ? {} : { guidance }),
    },
  });
}

function forbidden(message: string, error: object): Result<never, AppError> {
  return err({ code: 'forbidden', message, details: { ...error } });
}

/** Events that set `wait`; together with the task they name one entry into a wait. */
const ENTERS_WAIT: ReadonlySet<string> = new Set(['TaskPending', 'TaskWaiting']);

export class AttentionDesk {
  readonly #store: Store;
  readonly #now: () => number;
  readonly #dataDir: string | null;
  readonly #decider: DeciderWatch | null;
  readonly #statusSince: StatusSince;
  #holder: Holder | null = null;
  #registered: string | null = null;
  #replaced = new Set<string>();
  /**
   * Global seq at or below which every task that ended was told and confirmed, or ended before any holder
   * claimed the lease (#257). On disk and kept when the lease moves, so an ended task waits for a holder.
   */
  #endedAfter: number | null = null;
  /** Reading a task's log only when it changed; holds the tasks that needed a person last time. */
  #entered = new Map<string, { readonly version: number; readonly seq: number }>();

  constructor(deps: {
    readonly store: Store;
    readonly now: () => number;
    readonly dataDir?: string;
    readonly decider?: DeciderWatch;
  }) {
    this.#store = deps.store;
    this.#statusSince = statusSinceReader(deps.store);
    this.#decider = deps.decider ?? null;
    this.#now = deps.now;
    this.#dataDir = deps.dataDir ?? null;
    const saved =
      this.#dataDir === null
        ? { session: null, replaced: [], ended_after: null }
        : readSessionFile(this.#dataDir);
    this.#registered = saved.session;
    this.#replaced = new Set(saved.replaced);
    this.#endedAfter = saved.ended_after;
    if (this.#registered !== null)
      this.#holder = {
        id: this.#registered,
        seenAt: this.#now(),
        batch: 0,
        offered: [],
        delivered: new Set(),
        seq: null,
        restored: true,
        due: null,
      };
  }

  register(
    caller: Caller,
    body: Readonly<Record<string, unknown>>,
  ): Result<RegisterReply, AppError> {
    const q = RegisterSchema.safeParse(body);
    if (!q.success) return invalid('invalid assistant_register query', q.error.issues);
    const allowed = authorize(caller, { role: 'operate' });
    if (!allowed.ok) return forbidden('assistant session not registrable', allowed.error);
    const dataDir = this.#dataDir;
    if (dataDir === null)
      return err({ code: 'not_available', message: 'no data directory', details: {} });
    const { session, take } = q.data;
    const held = this.#claim(session, 0, take === true ? 'take' : 'attach');
    if (!held.ok) return held;
    this.#registered = session;
    this.#replaced.delete(session);
    this.#persist();
    // What waits now goes in this reply, so the first Stop hook confirms it instead of waking for it again.
    return ok({ session, ...this.#reply(held.value, 0) });
  }

  unregister(
    caller: Caller,
    body: Readonly<Record<string, unknown>>,
  ): Result<{ readonly session: string | null }, AppError> {
    const q = UnregisterSchema.safeParse(body);
    if (!q.success) return invalid('invalid assistant_unregister query', q.error.issues);
    const allowed = authorize(caller, { role: 'operate' });
    if (!allowed.ok) return forbidden('assistant session not registrable', allowed.error);
    const session = this.#registered;
    if (q.data.session !== undefined && q.data.session !== session)
      return err({
        code: 'attention_not_registered',
        message: 'this session is not the registered assistant session',
        details: { registered: session, guidance: 'Nothing to undo: this session gets no news.' },
      });
    if (session !== null && this.#holder?.id === session) this.#holder = null;
    // A session still waiting with `assistant wait` keeps the mark; with nobody left, nothing is owed.
    if (this.#holder === null) this.#endedAfter = null;
    this.#forget();
    return ok({ session });
  }

  /** What a session opening needs to decide whether to ask for the lease. Holds nothing, sends nothing. */
  peek(caller: Caller): Result<AttentionPeek, AppError> {
    const allowed = authorize(caller, { role: 'read' });
    if (!allowed.ok) return forbidden('attention not readable', allowed.error);
    const { waiting } = this.#waiting();
    const holder = this.#holder;
    // Sent but not yet confirmed counts as told: the holder's session may be reading it right now.
    const told = new Set(holder === null ? [] : [...holder.delivered, ...holder.offered]);
    const tasks = waiting
      .map((w) => ({ task_id: w.item.task_id, code: w.item.code, undelivered: !told.has(w.key) }))
      .sort((a, b) => a.task_id.localeCompare(b.task_id))
      .slice(0, INBOX_LIMIT);
    if (holder === null)
      return ok({ waiting: waiting.length, held: false, undelivered: waiting.length, tasks });
    // A registered session that stopped polling may be dead (#244): a session opening must then ask.
    const held = this.#now() - holder.seenAt < ATTENTION_STALE_MS;
    const undelivered = waiting.filter((w) => !told.has(w.key)).length;
    return ok({ waiting: waiting.length, held, undelivered, tasks });
  }

  /** A replaced session's hook says its note arrived; it is not told again. */
  movedAck(
    caller: Caller,
    body: Readonly<Record<string, unknown>>,
  ): Result<{ readonly session: string }, AppError> {
    const q = MovedAckSchema.safeParse(body);
    if (!q.success) return invalid('invalid assistant_moved_ack query', q.error.issues);
    const allowed = authorize(caller, { role: 'operate' });
    if (!allowed.ok) return forbidden('assistant session not registrable', allowed.error);
    if (this.#replaced.delete(q.data.session)) this.#persist();
    return ok({ session: q.data.session });
  }

  #forget(): void {
    this.#registered = null;
    this.#persist();
  }

  #persist(): void {
    const dataDir = this.#dataDir;
    if (dataDir === null) return;
    const file = join(dataDir, ASSISTANT_SESSION_FILE);
    if (this.#registered === null && this.#replaced.size === 0 && this.#endedAfter === null) {
      rmSync(file, { force: true });
      return;
    }
    const tmp = `${file}.${randomUUID()}.tmp`;
    const content: Record<string, unknown> = {
      ...(this.#registered === null ? {} : { session: this.#registered }),
      ...(this.#replaced.size === 0 ? {} : { replaced: [...this.#replaced] }),
      ...(this.#endedAfter === null ? {} : { ended_after: this.#endedAfter }),
    };
    writeFileSync(tmp, JSON.stringify(content), { mode: 0o600 });
    renameSync(tmp, file);
  }

  poll(caller: Caller, body: Readonly<Record<string, unknown>>): Result<AttentionReply, AppError> {
    const q = AttentionQuerySchema.safeParse(body);
    if (!q.success)
      return invalid(
        'invalid attention query',
        q.error.issues,
        q.error.issues.some((i) => i.path[0] === 'lease') ? LEASE_GUIDANCE : undefined,
      );
    // Claiming the lease moves where news goes, and may end a registration: that is a change.
    const claims = q.data.mode === 'attach' || q.data.mode === 'take';
    const allowed = authorize(caller, { role: claims ? 'operate' : 'read' });
    if (!allowed.ok) return forbidden('attention not readable', allowed.error);
    const [id = '', batch = '0'] = q.data.lease.split('.');
    const held = this.#claim(id, Number(batch), q.data.mode);
    if (!held.ok) return held;
    return ok(this.#reply(held.value, Number(batch)));
  }

  #reply(holder: Holder, batch: number): AttentionReply {
    holder.seenAt = this.#now();
    if (holder.restored) {
      holder.restored = false;
      // A number reused after a restart would make a retry of a lost reply read as its confirmation.
      holder.batch = Math.max(holder.batch, batch);
    }
    if (batch >= holder.batch) {
      holder.delivered = new Set([...holder.delivered, ...holder.offered]);
      holder.offered = [];
    }
    // The inputs of `needsUser` are task state, the decider's view (its version) and, for an
    // `effect_unknown` wait, time: with none of them changed and no such wait due yet, nothing is new.
    const seq = `${this.#store.lastGlobalSeq()}:${this.#decider?.version() ?? 0}`;
    if (holder.seq === seq && (holder.due === null || this.#now() < holder.due))
      return { lease: `${holder.id}.${holder.batch}`, items: [], truncated: false };
    return this.#deliver(holder, seq);
  }

  #claim(id: string, batch: number, mode: Mode): Result<Holder, AppError> {
    const cur = this.#holder;
    if (cur !== null && cur.id === id) return ok(cur);
    if (mode === 'hook')
      return this.#replaced.has(id)
        ? err({
            code: 'attention_superseded',
            message: 'another session took the assistant lease',
            details: {},
          })
        : err({
            code: 'attention_not_registered',
            message: 'this session is not the registered assistant session',
            details: {},
          });
    if (cur !== null && mode === 'resume')
      return err({
        code: 'attention_superseded',
        message: 'another session took the assistant lease; stop waiting here',
        details: {},
      });
    const idle = cur === null ? 0 : this.#now() - cur.seenAt;
    if (cur !== null && mode === 'attach' && idle < ATTENTION_STALE_MS)
      return err({
        code: 'attention_held',
        message: 'another session holds the assistant lease',
        details: {
          retry_after_ms: ATTENTION_STALE_MS - idle,
          guidance:
            'If that is this same session after it lost its lease (a compact or a restart), wait retry_after_ms and run this again without --take; do not ask the user. Otherwise run it again with --take only if the user asked to move here.',
        },
      });
    if (this.#registered !== null && this.#registered !== id) {
      this.#replaced.add(this.#registered);
      this.#forget();
    }
    // Starts at the batch it came with: after a daemon restart a lower number would read as confirmed.
    this.#holder = {
      id,
      seenAt: this.#now(),
      batch,
      offered: [],
      delivered: new Set(),
      seq: null,
      restored: false,
      due: null,
    };
    return ok(this.#holder);
  }

  #waiting(): { waiting: Keyed[]; due: number | null } {
    const waiting: Keyed[] = [];
    const now = this.#now();
    let due: number | null = null;
    const entered = new Map<string, { readonly version: number; readonly seq: number }>();
    for (const id of this.#store.taskIdsByStatus(LIVE)) {
      const s = this.#store.readTask(id as Uuid);
      const at = s === null ? null : effectUnknownDueAt(s, () => this.#statusSince(s));
      if (at !== null && at > now && (due === null || at < due)) due = at;
      // A question the decider is about to answer is not the person's yet; it comes if the decider gives up.
      if (
        s === null ||
        !needsUser(s, now, () => this.#statusSince(s)) ||
        this.#decider?.holds(s) === true
      )
        continue;
      const known = this.#entered.get(id);
      const seq =
        known?.version === s.version
          ? known.seq
          : (this.#store.readEvents(id as Uuid).findLast((e) => ENTERS_WAIT.has(e.type))
              ?.global_seq ?? 0);
      entered.set(id, { version: s.version, seq });
      waiting.push(keyed(s, seq));
    }
    this.#entered = entered;
    return { waiting, due };
  }

  #ended(): Ended[] {
    const ended: Ended[] = [];
    if (this.#endedAfter === null) {
      this.#endedAfter = this.#store.lastGlobalSeq();
      this.#persist();
    }
    for (const e of this.#store.terminalEventsAfter(this.#endedAfter)) {
      const s = this.#store.readTask(e.task_id as Uuid);
      if (s === null) continue;
      ended.push({
        key: `${e.task_id}:ended:${e.global_seq}`,
        seq: e.global_seq,
        item: {
          task_id: s.id,
          project: s.project,
          title: s.task.title,
          code: ENDED_CODES[e.kind],
          question_id: null,
          question: null,
          task_version: s.version,
        },
      });
    }
    return ended;
  }

  #deliver(holder: Holder, seq: string): AttentionReply {
    const { waiting: waits, due } = this.#waiting();
    const ended = this.#ended();
    holder.due = due;
    const waiting: Keyed[] = [...waits, ...ended];
    waiting.sort((a, b) => a.item.task_id.localeCompare(b.item.task_id));
    const fresh = waiting.filter((w) => !holder.delivered.has(w.key));
    const sent = fresh.slice(0, INBOX_LIMIT);
    // Only what still waits is kept, so the set stays bounded and a wait that comes back is told again.
    holder.delivered = new Set(waiting.map((w) => w.key).filter((k) => holder.delivered.has(k)));
    holder.offered = sent.map((w) => w.key);
    // Ended tasks confirmed so far drop below the mark, and with it out of `delivered`.
    const unconfirmed = ended.filter((e) => !holder.delivered.has(e.key)).map((e) => e.seq);
    const last = ended.at(-1)?.seq;
    const mark = unconfirmed.length > 0 ? Math.min(...unconfirmed) - 1 : (last ?? this.#endedAfter);
    if (mark !== this.#endedAfter) {
      this.#endedAfter = mark;
      this.#persist();
    }
    if (sent.length > 0) holder.batch += 1;
    holder.seq = sent.length > 0 ? null : seq;
    return {
      lease: `${holder.id}.${holder.batch}`,
      items: sent.map((w) => w.item),
      truncated: fresh.length > sent.length,
    };
  }
}
