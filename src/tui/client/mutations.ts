/**
 * Tracks writes whose answer may be lost (FR-018, FR-019, data-model.md "Thao tác đang gửi"). One logical
 * operation has one request ID and one body for its whole life, so every resend is the same request to the
 * daemon and can have only one effect.
 */
import { v7 as uuidv7 } from 'uuid';
import { committedNote, type PortError, type PortResult } from './daemon-port.ts';
import type { SafeText } from '../terminal/safe-text.ts';
import type { CommandReply, RequestShow } from './schemas.ts';

export const MAX_CHECKS = 60;
export const MAX_RESENDS = 5;
export const COMMAND_TIMEOUT_MS = 10_000;
export const CHECK_TIMEOUT_MS = 5_000;
/** A merge reads GitHub several times before it sends; a cut answer is still found again by its request ID. */
export const MERGE_TIMEOUT_MS = 120_000;

/**
 * The whole body sent to the daemon, minus the request ID; never changes on a resend. A command on the
 * daemon's queue names no project, task or version.
 */
export type MutationCommand = {
  readonly kind: string;
  readonly project: string | null;
  readonly task_id: string | null;
  readonly expected_version: number | null;
  readonly payload: unknown;
};

/** Where a write is kept and locked: its task, or the queue. Task IDs are UUIDs, so the two never meet. */
export const QUEUE_TARGET = 'queue';
export const NEW_TASK_KEY = 'new-task';
export const mutationTarget = (c: MutationCommand): string =>
  c.task_id ?? (c.kind === 'task_add' ? NEW_TASK_KEY : QUEUE_TARGET);

/** The handler's value inside a direct reply (`{ request_id, replayed, result }`), as `request_show` gives it. */
function handlerValue(reply: unknown): unknown {
  return typeof reply === 'object' && reply !== null && 'result' in reply ? reply.result : reply;
}

export type MutationState = 'sending' | 'accepted' | 'rejected' | 'unknown' | 'unresolved';

export type MutationResult =
  /** `value`: what the command's handler returned, as the ledger stores it, whichever way it came back. */
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      /** What the refused command had already recorded. */
      readonly committed?: SafeText;
    };

export type Mutation = {
  readonly requestId: string;
  readonly command: MutationCommand;
  readonly state: MutationState;
  readonly result: MutationResult | null;
  readonly checks: number;
  readonly resends: number;
};

export type MutationPort = {
  command(
    body: MutationCommand & { readonly request_id: string },
    timeoutMs: number,
  ): Promise<PortResult<CommandReply>>;
  requestShow(id: string, timeoutMs: number): Promise<PortResult<RequestShow>>;
};

export type MutationDeps = {
  readonly port: MutationPort;
  /** Resends wait for this; reconnecting has its own limit. */
  readonly connected: () => boolean;
  /**
   * Whether an unknown write may be looked up now; defaults to `connected`. Looking up stays open on stale
   * data (FR-044), and a look the daemon answered uses a turn whatever the board's state.
   */
  readonly mayCheck?: () => boolean;
  readonly newId?: () => string;
  readonly onChange?: (m: Mutation) => void;
};

export type SubmitResult =
  | { readonly started: true; readonly mutation: Mutation }
  | { readonly started: false; readonly blockedBy: Mutation };

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

const withCommitted = (c: SafeText | null): { committed?: SafeText } =>
  c === null ? {} : { committed: c };

const isOpen = (m: Mutation): boolean => m.state === 'unknown' || m.state === 'unresolved';

/**
 * A failure that says nothing about whether the daemon acted on the request. `internal` is the daemon
 * saying its handler failed after it may have written part of it; `store_write_failed` may come after the
 * handler wrote, when the ledger could not store its result. `request_show` tells which, and the same
 * request ID finishes it.
 */
const lostAnswer = (e: PortError): boolean =>
  e.kind === 'connection' ||
  e.kind === 'timeout' ||
  e.kind === 'incompatible' ||
  (e.kind === 'rejected' && (e.code === 'internal' || e.code === 'store_write_failed'));

/**
 * Refused before admission. For a first send that is the answer; for a resend it says nothing about the
 * attempt the ledger already holds, which stays unknown until the same ID can be finished.
 */
const notAdmitted = (e: PortError): boolean =>
  e.kind === 'rejected' && e.code === 'store_unwritable';

export class MutationTracker {
  readonly #deps: MutationDeps;
  readonly #all = new Map<string, Mutation>();
  readonly #busy = new Set<string>();
  /** Requests sent again after being unknown; their `sending` state keeps the lock. */
  readonly #resending = new Set<string>();

  constructor(deps: MutationDeps) {
    this.#deps = deps;
  }

  get(requestId: string): Mutation | undefined {
    return this.#all.get(requestId);
  }

  /** Writes whose result is not known; they block new writes on their task and are named on exit. */
  open(): readonly Mutation[] {
    return [...this.#all.values()].filter(isOpen);
  }

  /** `target`: a task ID, or `QUEUE_TARGET`. */
  blocking(target: string): Mutation | undefined {
    // `sending` counts too: a resend in flight is still a write whose result is not known.
    return [...this.#all.values()].find(
      (m) =>
        mutationTarget(m.command) === target && (isOpen(m) || this.#resending.has(m.requestId)),
    );
  }

  async submit(command: MutationCommand): Promise<SubmitResult> {
    const blockedBy = this.blocking(mutationTarget(command));
    if (blockedBy !== undefined) return { started: false, blockedBy };
    const id = (this.#deps.newId ?? uuidv7)();
    const m = this.#set({
      requestId: id,
      // A copy taken now: the caller cannot change what a later resend carries.
      command: deepFreeze(structuredClone(command)),
      state: 'sending',
      result: null,
      checks: 0,
      resends: 0,
    });
    this.#busy.add(id);
    try {
      return { started: true, mutation: await this.#send(m) };
    } finally {
      this.#busy.delete(id);
    }
  }

  /** One automatic step for an `unknown` write, meant for each refresh tick; a no-op otherwise. */
  async poll(requestId: string): Promise<Mutation | undefined> {
    const m = this.#all.get(requestId);
    if (m === undefined || m.state !== 'unknown' || this.#busy.has(requestId)) return m;
    if (!(this.#deps.mayCheck ?? this.#deps.connected)()) return m;
    if (m.checks >= MAX_CHECKS) return this.#set({ ...m, state: 'unresolved' });
    this.#busy.add(requestId);
    try {
      const counted = this.#set({ ...m, checks: m.checks + 1 });
      const r = await this.#deps.port.requestShow(requestId, CHECK_TIMEOUT_MS);
      // A look that never reached the daemon, or was cut while the board too says the link is down, uses no
      // turn. One cut after reaching a daemon that still serves the board counts, as does a timeout: the
      // ceiling must end a round the daemon keeps failing (data-model.md).
      if (
        !r.ok &&
        r.error.kind === 'connection' &&
        (r.error.reached === false || !this.#deps.connected())
      )
        return this.#set({ ...counted, checks: m.checks });
      return this.#capped(await this.#afterCheck(counted, r));
    } finally {
      this.#busy.delete(requestId);
    }
  }

  /** `Check again`: a new round with the same request ID. */
  checkAgain(requestId: string): Mutation | undefined {
    const m = this.#all.get(requestId);
    if (m === undefined || m.state !== 'unresolved') return m;
    return this.#set({ ...m, state: 'unknown', checks: 0, resends: 0 });
  }

  /** Stops the automatic round the moment either ceiling is spent and the result is still unknown. */
  #capped(m: Mutation): Mutation {
    const spent = m.checks >= MAX_CHECKS || m.resends >= MAX_RESENDS;
    return m.state === 'unknown' && spent ? this.#set({ ...m, state: 'unresolved' }) : m;
  }

  async #afterCheck(m: Mutation, r: PortResult<RequestShow>): Promise<Mutation> {
    if (!r.ok) {
      // The ledger has no row: the request was not admitted when asked, so it is sent again as it was.
      if (r.error.kind === 'rejected' && r.error.code === 'request_not_found')
        return this.#resend(m);
      return m;
    }
    switch (r.value.state) {
      case 'in_progress':
        return m;
      case 'interrupted':
        return this.#resend(m);
      case 'completed': {
        const o = r.value.outcome;
        if (o === undefined) return m;
        return this.#set(
          o.ok
            ? { ...m, state: 'accepted', result: { ok: true, value: o.value } }
            : {
                ...m,
                state: 'rejected',
                result: {
                  ok: false,
                  code: o.error.code,
                  message: o.error.message,
                  ...withCommitted(committedNote(o.error['details'])),
                },
              },
        );
      }
    }
  }

  async #resend(m: Mutation): Promise<Mutation> {
    // Resends wait for the connection; the answered look that asked for one keeps its turn.
    if (!this.#deps.connected()) return m;
    if (m.resends >= MAX_RESENDS) return this.#set({ ...m, state: 'unresolved' });
    this.#resending.add(m.requestId);
    try {
      // Sent while connected, a resend uses its turn whatever became of it: the ceiling bounds a link that
      // keeps dropping only this request.
      return await this.#send(this.#set({ ...m, state: 'sending', resends: m.resends + 1 }), true);
    } finally {
      this.#resending.delete(m.requestId);
    }
  }

  async #send(m: Mutation, resend = false): Promise<Mutation> {
    const r = await this.#deps.port.command(
      { ...m.command, request_id: m.requestId },
      m.command.kind === 'task_merge' ? MERGE_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
    );
    if (r.ok)
      return this.#set({
        ...m,
        state: 'accepted',
        result: { ok: true, value: handlerValue(r.value) },
      });
    if (lostAnswer(r.error) || (resend && notAdmitted(r.error))) {
      return this.#set({ ...m, state: 'unknown' });
    }
    return this.#set({
      ...m,
      state: 'rejected',
      result: {
        ok: false,
        code: r.error.kind === 'rejected' ? r.error.code : r.error.kind,
        message: r.error.message,
        ...withCommitted(r.error.kind === 'rejected' ? (r.error.committed ?? null) : null),
      },
    });
  }

  #set(m: Mutation): Mutation {
    this.#all.set(m.requestId, m);
    this.#deps.onChange?.(m);
    return m;
  }
}
