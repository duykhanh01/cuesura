/**
 * Which assistant session relays what needs a person (issue #166). The lease only routes news: it grants
 * nothing and anyone with the right role may still answer. It lives in memory because a lost lease loses
 * no fact: what needs a person is rebuilt from the tasks. Delivery is at least once: what was sent counts as
 * received only when the holder comes back with the lease of that reply.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { TASK_STATUSES, isTerminal, type TaskState } from '../domain/state.ts';
import { needsUser } from '../explain/needs-user.ts';
import type { Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import { authorize, type Caller } from './authz.ts';
import { INBOX_LIMIT, openQuestions } from './inbox.ts';
import type { AppError } from './queries.ts';

/** With no poll for this long the holder has gone, and a new session needs no `take`. */
export const ATTENTION_STALE_MS = 10_000;

/**
 * Names the session a Stop hook may wake (cusr assistant register). Unlike the lease it survives a restart,
 * because that hook only starts on the session's next Stop and nothing else would claim the lease back.
 */
export const ASSISTANT_SESSION_FILE = 'assistant-session.json';

export function registeredSession(dataDir: string): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, ASSISTANT_SESSION_FILE), 'utf8'));
    const session = (raw as { session?: unknown } | null)?.session;
    return typeof session === 'string' ? session : null;
  } catch {
    return null;
  }
}

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

const UnregisterSchema = z.object({ kind: z.literal('assistant_unregister').optional() }).strict();

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

type Holder = {
  readonly id: string;
  seenAt: number;
  /** Numbers the batches sent, so a reply lost on the way is not taken for one that arrived. */
  batch: number;
  offered: readonly string[];
  delivered: ReadonlySet<string>;
  /** Log position already looked at; null while something is still to send or to be confirmed. */
  seq: number | null;
  /** Rebuilt from disk, so `batch` is not yet known: the client's first lease tells where it stood. */
  restored: boolean;
};

type Keyed = { readonly key: string; readonly item: AttentionItem };

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

function invalid(message: string, issues: readonly z.core.$ZodIssue[]): Result<never, AppError> {
  return err({
    code: 'invalid_request',
    message,
    details: { issues: issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
  });
}

/** Events that set `wait`; together with the task they name one entry into a wait. */
const ENTERS_WAIT: ReadonlySet<string> = new Set(['TaskPending', 'TaskWaiting']);

export class AttentionDesk {
  readonly #store: Store;
  readonly #now: () => number;
  readonly #dataDir: string | null;
  #holder: Holder | null = null;
  #registered: string | null = null;
  /** Reading a task's log only when it changed; holds the tasks that needed a person last time. */
  #entered = new Map<string, { readonly version: number; readonly seq: number }>();

  constructor(deps: {
    readonly store: Store;
    readonly now: () => number;
    readonly dataDir?: string;
  }) {
    this.#store = deps.store;
    this.#now = deps.now;
    this.#dataDir = deps.dataDir ?? null;
    this.#registered = this.#dataDir === null ? null : registeredSession(this.#dataDir);
    if (this.#registered !== null)
      this.#holder = {
        id: this.#registered,
        seenAt: this.#now(),
        batch: 0,
        offered: [],
        delivered: new Set(),
        seq: null,
        restored: true,
      };
  }

  register(
    caller: Caller,
    body: Readonly<Record<string, unknown>>,
  ): Result<{ readonly session: string }, AppError> {
    const q = RegisterSchema.safeParse(body);
    if (!q.success) return invalid('invalid assistant_register query', q.error.issues);
    const allowed = authorize(caller, { role: 'operate' });
    if (!allowed.ok)
      return err({
        code: 'forbidden',
        message: 'assistant session not registrable',
        details: { ...allowed.error },
      });
    const dataDir = this.#dataDir;
    if (dataDir === null)
      return err({ code: 'not_available', message: 'no data directory', details: {} });
    const { session, take } = q.data;
    const held = this.#claim(session, 0, take === true ? 'take' : 'attach');
    if (!held.ok) return held;
    const file = join(dataDir, ASSISTANT_SESSION_FILE);
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ session }), { mode: 0o600 });
    renameSync(tmp, file);
    this.#registered = session;
    return ok({ session });
  }

  unregister(
    caller: Caller,
    body: Readonly<Record<string, unknown>>,
  ): Result<{ readonly session: string | null }, AppError> {
    const q = UnregisterSchema.safeParse(body);
    if (!q.success) return invalid('invalid assistant_unregister query', q.error.issues);
    const allowed = authorize(caller, { role: 'operate' });
    if (!allowed.ok)
      return err({
        code: 'forbidden',
        message: 'assistant session not registrable',
        details: { ...allowed.error },
      });
    const session = this.#registered;
    if (session !== null && this.#holder?.id === session) this.#holder = null;
    this.#forget();
    return ok({ session });
  }

  /** How many tasks wait for a person, for a session deciding whether to ask for the lease. Holds nothing. */
  peek(caller: Caller): Result<{ readonly waiting: number }, AppError> {
    const allowed = authorize(caller, { role: 'read' });
    if (!allowed.ok)
      return err({
        code: 'forbidden',
        message: 'attention not readable',
        details: { ...allowed.error },
      });
    return ok({ waiting: this.#waiting().length });
  }

  #forget(): void {
    this.#registered = null;
    if (this.#dataDir !== null)
      rmSync(join(this.#dataDir, ASSISTANT_SESSION_FILE), { force: true });
  }

  poll(caller: Caller, body: Readonly<Record<string, unknown>>): Result<AttentionReply, AppError> {
    const q = AttentionQuerySchema.safeParse(body);
    if (!q.success) return invalid('invalid attention query', q.error.issues);
    const allowed = authorize(caller, { role: 'read' });
    if (!allowed.ok)
      return err({
        code: 'forbidden',
        message: 'attention not readable',
        details: { ...allowed.error },
      });
    const [id = '', batch = '0'] = q.data.lease.split('.');
    const held = this.#claim(id, Number(batch), q.data.mode);
    if (!held.ok) return held;
    const holder = held.value;
    holder.seenAt = this.#now();
    if (holder.restored) {
      holder.restored = false;
      // A number reused after a restart would make a retry of a lost reply read as its confirmation.
      holder.batch = Math.max(holder.batch, Number(batch));
    }
    if (Number(batch) >= holder.batch) {
      holder.delivered = new Set([...holder.delivered, ...holder.offered]);
      holder.offered = [];
    }
    const seq = this.#store.lastGlobalSeq();
    // Every input of `needsUser` is task state, so an unchanged log means nothing new to read.
    if (holder.seq === seq)
      return ok({ lease: `${holder.id}.${holder.batch}`, items: [], truncated: false });
    return ok(this.#deliver(holder, seq));
  }

  #claim(id: string, batch: number, mode: Mode): Result<Holder, AppError> {
    const cur = this.#holder;
    if (cur !== null && cur.id === id) return ok(cur);
    if (mode === 'hook')
      return err({
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
    if (cur !== null && mode === 'attach' && this.#now() - cur.seenAt < ATTENTION_STALE_MS)
      return err({
        code: 'attention_held',
        message: 'another session holds the assistant lease',
        details: { guidance: 'Run this again with --take only if the user asked to move here.' },
      });
    if (this.#registered !== null && this.#registered !== id) this.#forget();
    // Starts at the batch it came with: after a daemon restart a lower number would read as confirmed.
    this.#holder = {
      id,
      seenAt: this.#now(),
      batch,
      offered: [],
      delivered: new Set(),
      seq: null,
      restored: false,
    };
    return ok(this.#holder);
  }

  #waiting(): Keyed[] {
    const waiting: Keyed[] = [];
    const entered = new Map<string, { readonly version: number; readonly seq: number }>();
    for (const id of this.#store.taskIdsByStatus(LIVE)) {
      const s = this.#store.readTask(id as Uuid);
      if (s === null || !needsUser(s)) continue;
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
    return waiting;
  }

  #deliver(holder: Holder, seq: number): AttentionReply {
    const waiting = this.#waiting();
    waiting.sort((a, b) => a.item.task_id.localeCompare(b.item.task_id));
    const fresh = waiting.filter((w) => !holder.delivered.has(w.key));
    const sent = fresh.slice(0, INBOX_LIMIT);
    // Only what still waits is kept, so the set stays bounded and a wait that comes back is told again.
    holder.delivered = new Set(waiting.map((w) => w.key).filter((k) => holder.delivered.has(k)));
    holder.offered = sent.map((w) => w.key);
    if (sent.length > 0) holder.batch += 1;
    holder.seq = sent.length > 0 ? null : seq;
    return {
      lease: `${holder.id}.${holder.batch}`,
      items: sent.map((w) => w.item),
      truncated: fresh.length > sent.length,
    };
  }
}
