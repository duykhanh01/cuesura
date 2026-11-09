/**
 * Tracks writes whose answer may be lost (FR-018, FR-019, feature 004 data model, "Pending writes"). One logical
 * operation has one request ID and one body for its whole life, so every resend is the same request to the
 * daemon and can have only one effect.
 */
import { v7 as uuidv7 } from 'uuid';
import type { PortError, PortResult } from './daemon-port.ts';
import type { CommandReply, RequestShow } from './schemas.ts';

export const MAX_CHECKS = 60;
export const MAX_RESENDS = 5;
export const COMMAND_TIMEOUT_MS = 10_000;
export const CHECK_TIMEOUT_MS = 5_000;

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
export const mutationTarget = (c: MutationCommand): string => c.task_id ?? QUEUE_TARGET;

export type MutationState = 'sending' | 'accepted' | 'rejected' | 'unknown' | 'unresolved';

export type MutationResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

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
  /** Checks and resends count only while the daemon is reachable; reconnecting has its own limit. */
  readonly connected: () => boolean;
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

const isOpen = (m: Mutation): boolean => m.state === 'unknown' || m.state === 'unresolved';

/** A failure that says nothing about whether the daemon acted on the request. */
const lostAnswer = (e: PortError): boolean =>
  e.kind === 'connection' || e.kind === 'timeout' || e.kind === 'incompatible';

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
    if (m === undefined || m.state !== 'unknown') return m;
    if (!this.#deps.connected() || this.#busy.has(requestId)) return m;
    if (m.checks >= MAX_CHECKS) return this.#set({ ...m, state: 'unresolved' });
    this.#busy.add(requestId);
    try {
      const counted = this.#set({ ...m, checks: m.checks + 1 });
      const r = await this.#deps.port.requestShow(requestId, CHECK_TIMEOUT_MS);
      // A check that went unanswered because the link dropped or it timed out says nothing: it does not use a turn.
      if (!r.ok && (!this.#deps.connected() || r.error.kind === 'timeout'))
        return this.#set({ ...counted, checks: m.checks });
      const after = await this.#afterCheck(counted, r);
      if (this.#deps.connected()) return this.#capped(after);
      // Offline, an answer that settles nothing does not use a turn and nothing is given up: the round resumes
      // once the link is back.
      return after.state === 'unknown'
        ? this.#set({ ...after, checks: Math.min(after.checks, m.checks) })
        : after;
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
                result: { ok: false, code: o.error.code, message: o.error.message },
              },
        );
      }
    }
  }

  async #resend(m: Mutation): Promise<Mutation> {
    // The link may have dropped while `request_show` was in flight: nothing is spent, the round resumes later.
    if (!this.#deps.connected()) return this.#set({ ...m, checks: Math.max(0, m.checks - 1) });
    if (m.resends >= MAX_RESENDS) return this.#set({ ...m, state: 'unresolved' });
    this.#resending.add(m.requestId);
    try {
      let timedOut = false;
      const sent = await this.#send(
        this.#set({ ...m, state: 'sending', resends: m.resends + 1 }),
        (kind) => (timedOut = kind === 'timeout'),
      );
      if (sent.state !== 'unknown') return sent;
      // Only the check that asked for the resend is given back when the link is down; the resend itself counts.
      // A timeout gives back both, so a check at the ceiling does not end the round.
      if (timedOut)
        return this.#set({ ...sent, resends: m.resends, checks: Math.max(0, m.checks - 1) });
      return this.#deps.connected()
        ? sent
        : this.#set({ ...sent, checks: Math.max(0, m.checks - 1) });
    } finally {
      this.#resending.delete(m.requestId);
    }
  }

  async #send(m: Mutation, onLost?: (kind: string) => void): Promise<Mutation> {
    const r = await this.#deps.port.command(
      { ...m.command, request_id: m.requestId },
      COMMAND_TIMEOUT_MS,
    );
    if (r.ok) return this.#set({ ...m, state: 'accepted', result: { ok: true, value: r.value } });
    if (lostAnswer(r.error)) {
      onLost?.(r.error.kind);
      return this.#set({ ...m, state: 'unknown' });
    }
    return this.#set({
      ...m,
      state: 'rejected',
      result: {
        ok: false,
        code: r.error.kind === 'rejected' ? r.error.code : r.error.kind,
        message: r.error.message,
      },
    });
  }

  #set(m: Mutation): Mutation {
    this.#all.set(m.requestId, m);
    this.#deps.onChange?.(m);
    return m;
  }
}
