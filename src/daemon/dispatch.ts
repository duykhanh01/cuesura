/**
 * Effect dispatch (contracts/cli-daemon.md, research R-16). The daemon
 * is the only writer: it claims a committed `pending` effect through the store (`EffectStarted` and the
 * operation identity commit together), and only after that commit hands the effect and its operation to
 * a handler built on the ports. A handler returns facts as trigger envelopes (the operation receipt and
 * the effect result); the dispatcher accepts them in order through the same store. Handlers never touch
 * the store, never choose a task status and never decide retry. A slot-bound effect's operation (prepare,
 * agent attempt, gates, publish) holds the execution slot until its receipt resolves it.
 *
 * Never dispatched: `merge` (merging is the user's action on GitHub, ADR-0001), tasks without a runtime
 * snapshot (legacy 001 tasks are read-only here), and effect kinds that have no handler yet.
 *
 * Store failure latch (FR-023): once the store or the data directory refuses a write (a claim, a result,
 * a handler's file), nothing new is claimed, service effects included, until the daemon restarts and
 * startup recovery proves the store again. Facts not written stay where they are: the effect stays
 * `started` with its operation, so restart reconciles it; runner spools wait for ingest.
 */
import { randomUUID } from 'node:crypto';
import { DaemonStopping, type Clock } from '../adapters/ports.ts';
import { holdsSlot, isBusinessEffect, type Effect, type EffectKind } from '../domain/effect.ts';
import type { OperationKind } from '../domain/runtime.ts';
import type { TriggerEnvelope } from '../domain/trigger.ts';
import { isUnresolved, type OperationClaim } from '../engine/runtime.ts';
import { newLaunchNonce, unitName } from '../runner/identity.ts';
import { runInOperation } from '../runner/process-tag.ts';
import type { Uuid } from '../shared/brand.ts';
import { writeFailure } from '../store/accept.ts';
import type { ClaimError, Store } from '../store/index.ts';

export type EffectHandler = (
  effect: Effect,
  signal: AbortSignal,
  operation: OperationClaim,
) => Promise<TriggerEnvelope | readonly TriggerEnvelope[]>;

/** `merge` cannot be given a handler: the type excludes it and the constructor refuses it at runtime. */
export type EffectHandlers = Partial<Record<Exclude<EffectKind, 'merge'>, EffectHandler>>;

export type SkipReason =
  | 'merge_refused'
  | 'store_unwritable'
  | 'no_handler'
  | 'dispatch_blocked'
  | 'dispatch_held'
  | 'in_flight'
  | ClaimError['code']
  | `claim_blocked:${string}`
  | `operation_rejected:${string}`;

const OPERATION_KIND: Record<Exclude<EffectKind, 'merge'>, OperationKind> = {
  prepare: 'setup',
  start_agent: 'agent',
  stop_attempt: 'agent',
  run_gates: 'gate',
  publish: 'publish',
  create_pr: 'github',
  mark_ready: 'github',
  post_review: 'github',
  await_ci: 'github',
  rerun_ci: 'github',
  reconcile: 'github',
  observe_external: 'github',
};

export type DispatchReport = {
  readonly started: readonly string[];
  readonly skipped: readonly {
    readonly effect_id: string;
    readonly reason: SkipReason;
  }[];
};

export type DispatchLog = (record: {
  readonly event: string;
  readonly effect_id: string;
  readonly detail?: string;
}) => void;

export type DispatcherOptions = {
  readonly store: Store;
  readonly clock: Clock;
  readonly handlers: EffectHandlers;
  readonly log?: DispatchLog;
  readonly batch?: number;
  /** Operation IDs; must be safe unit-name components (UUIDs). */
  readonly newId?: () => string;
  /**
   * Durable mark of when an operation's handler starts, written before it can spawn anything and
   * cleared once its facts are written; recovery dates surviving processes against it.
   */
  readonly marks?: {
    readonly write: (operationId: string) => void;
    readonly clear: (operationId: string) => void;
  };
};

/** errno of a filesystem that cannot take a write; anything else from a handler is not a store failure. */
const STORAGE_ERRNO = new Set(['ENOSPC', 'EDQUOT', 'EIO', 'EROFS']);

/** The store or the data directory refused a write: the reason to latch, or null for any other error. */
export function storageFailure(e: unknown): string | null {
  const wf = writeFailure(e);
  if (wf !== null) return `store write failed: ${wf.cause}`;
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && STORAGE_ERRNO.has(code)
    ? `filesystem write failed: ${code}`
    : null;
}

/** How long `stop()` waits for in-flight handlers after aborting them. */
export const DEFAULT_STOP_GRACE_MS = 10_000;

export class DispatchConfigError extends Error {
  override name = 'DispatchConfigError';
}

export class Dispatcher {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #handlers: EffectHandlers;
  readonly #log: DispatchLog;
  readonly #batch: number;
  readonly #newId: () => string;
  readonly #marks: DispatcherOptions['marks'];
  readonly #inFlight = new Map<string, { abort: AbortController; done: Promise<void> }>();
  #blocked: string | null = null;
  #held: string | null = null;
  #latched: string | null = null;
  #stopped = false;

  constructor(opts: DispatcherOptions) {
    if (Object.hasOwn(opts.handlers, 'merge'))
      throw new DispatchConfigError('merge is never executed by the daemon');
    this.#store = opts.store;
    this.#clock = opts.clock;
    this.#handlers = opts.handlers;
    this.#log = opts.log ?? (() => undefined);
    this.#batch = opts.batch ?? 100;
    this.#newId = opts.newId ?? randomUUID;
    this.#marks = opts.marks;
  }

  /** Stops new claims (e.g. projection mismatch at startup); in-flight work is left to finish. */
  block(reason: string): void {
    this.#blocked = reason;
  }

  get blockedReason(): string | null {
    return this.#blocked;
  }

  /**
   * Holds business effects while a claim is unresolved (FR-036): no new work is handed out, but service
   * effects (reconcile, stop, observation) still run so recovery can resolve it. `null` lifts the hold.
   */
  hold(reason: string | null): void {
    this.#held = reason;
  }

  get heldReason(): string | null {
    return this.#held;
  }

  /**
   * Latches a store/filesystem write failure (FR-023): no effect of any kind is claimed until restart.
   * The first reason is kept; neither `block` nor `hold` lifts it.
   */
  latch(reason: string): void {
    if (this.#latched !== null) return;
    this.#latched = reason;
    this.#log({ event: 'store_latched', effect_id: '-', detail: reason });
  }

  get latchedReason(): string | null {
    return this.#latched;
  }

  get inFlight(): number {
    return this.#inFlight.size;
  }

  /** Signals the handler of one in-flight effect (e.g. `stop_attempt` for a running agent); false if none. */
  abort(effectId: string): boolean {
    const f = this.#inFlight.get(effectId);
    if (f === undefined) return false;
    f.abort.abort();
    return true;
  }

  /** Resolves once the handler of `effectId` (if any is in flight) has finished and its result is written. */
  settled(effectId: string): Promise<void> {
    return this.#inFlight.get(effectId)?.done ?? Promise.resolve();
  }

  isInFlight(effectId: string): boolean {
    return this.#inFlight.has(effectId);
  }

  /**
   * One synchronous pass over every pending effect, page by page, so effects that are always skipped
   * (legacy tasks, kinds without a handler) never starve the ones behind them. Claims what can run now
   * and starts its handler without awaiting it.
   */
  tick(): DispatchReport {
    const started: string[] = [];
    const skipped: { effect_id: string; reason: SkipReason }[] = [];
    let after: string | undefined;
    for (;;) {
      const page = this.#store.pendingEffects(this.#batch, after);
      for (const effect of page) this.#tryStart(effect, started, skipped);
      if (page.length < this.#batch) break;
      after = page[page.length - 1]?.id;
    }
    return { started, skipped };
  }

  #tryStart(
    effect: Effect,
    started: string[],
    skipped: { effect_id: string; reason: SkipReason }[],
  ): void {
    const reason = this.#skipReason(effect);
    if (reason !== null) {
      skipped.push({ effect_id: effect.id, reason });
      return;
    }
    const kind = effect.kind as Exclude<EffectKind, 'merge'>;
    const operationId = this.#newId();
    const operation: OperationClaim = {
      operation_id: operationId,
      kind: OPERATION_KIND[kind],
      launch_nonce: newLaunchNonce(),
      unit: unitName(operationId),
      holds_slot: holdsSlot(kind),
    };
    const claimed = this.#store.claimEffect(effect.id as Uuid, this.#clock.now(), {
      require_runtime: true,
      operation,
    });
    if (!claimed.ok) {
      const e = claimed.error;
      if (e.code === 'write_failed') this.latch(`store write failed: ${e.cause}`);
      const r =
        e.code === 'claim_blocked'
          ? (`claim_blocked:${e.reason}` as const)
          : e.code === 'operation_rejected'
            ? (`operation_rejected:${e.reason}` as const)
            : e.code;
      skipped.push({ effect_id: effect.id, reason: r });
      return;
    }
    // Only now, after EffectStarted and the operation are committed, may anything outside the store happen.
    this.#start(claimed.value, operation, this.#handlers[kind] as EffectHandler);
    started.push(effect.id);
  }

  #skipReason(effect: Effect): SkipReason | null {
    if (effect.kind === 'merge') return 'merge_refused';
    if (this.#latched !== null) return 'store_unwritable';
    if (this.#blocked !== null) return 'dispatch_blocked';
    if (this.#held !== null && isBusinessEffect(effect.kind)) return 'dispatch_held';
    if (this.#inFlight.has(effect.id)) return 'in_flight';
    return this.#handlers[effect.kind] === undefined ? 'no_handler' : null;
  }

  #start(effect: Effect, operation: OperationClaim, handler: EffectHandler): void {
    const abort = new AbortController();
    const run = async (): Promise<void> => {
      try {
        this.#marks?.write(operation.operation_id);
      } catch (e) {
        // No durable mark, no handler: recovery then knows nothing of it was spawned.
        this.#log({
          event: 'handler_failed',
          effect_id: effect.id,
          detail: `process mark: ${e instanceof Error ? e.message : String(e)}`,
        });
        this.latch(storageFailure(e) ?? 'process mark not written');
        return;
      }
      try {
        // Processes the handler spawns carry the operation id, so a restart can find survivors.
        const result = await runInOperation(operation.operation_id, () =>
          handler(effect, abort.signal, operation),
        );
        const envelopes = (Array.isArray(result) ? result : [result]) as readonly TriggerEnvelope[];
        for (const envelope of envelopes) {
          if (this.#stopped) {
            this.#log({
              event: 'result_dropped',
              effect_id: effect.id,
              detail: 'dispatcher stopped',
            });
            return;
          }
          const accepted = this.#store.accept(envelope);
          if (!accepted.ok) {
            this.#log({
              event: 'result_rejected',
              effect_id: effect.id,
              detail: JSON.stringify(accepted.error),
            });
            if (accepted.error.code === 'write_failed') {
              // Later facts of this effect depend on the one not written; restart reconciles them all.
              this.latch(`store write failed: ${accepted.error.cause}`);
              return;
            }
          }
        }
        // The mark goes only with a resolved operation: one left unknown may still have processes, and
        // a missing mark would read as "nothing was spawned" to every later scan (FR-034.01).
        const op = this.#store.readTask(effect.task_id as Uuid)?.operations[operation.operation_id];
        if (op !== undefined && !isUnresolved(op))
          try {
            this.#marks?.clear(operation.operation_id);
          } catch {
            // A stale mark only narrows what recovery may skip; it never widens it.
          }
      } catch (e) {
        // The effect stays `started`: recovery reconciles it; nothing here guesses an outcome.
        this.#log({
          event: 'handler_failed',
          effect_id: effect.id,
          detail: e instanceof Error ? e.message : String(e),
        });
        const failure = storageFailure(e);
        if (failure !== null) this.latch(failure);
      }
    };
    // Registered before the handler runs, so a synchronous throw cannot delete the entry before it exists.
    const entry = { abort, done: Promise.resolve() };
    this.#inFlight.set(effect.id, entry);
    entry.done = Promise.resolve()
      .then(run)
      .finally(() => {
        if (this.#inFlight.get(effect.id) === entry) this.#inFlight.delete(effect.id);
      });
  }

  /** Waits for every handler started so far. */
  async settle(): Promise<void> {
    await Promise.all([...this.#inFlight.values()].map((f) => f.done));
  }

  /**
   * Stops claiming, signals every in-flight handler and waits at most `graceMs` for them. A handler
   * still running after that is abandoned: its effect stays `started` for recovery and any result it
   * returns later is dropped, never written to a store that may already be closed. Returns the IDs of
   * the abandoned effects.
   */
  async stop(graceMs = DEFAULT_STOP_GRACE_MS): Promise<string[]> {
    this.#blocked ??= 'stopping';
    for (const f of this.#inFlight.values()) f.abort.abort(new DaemonStopping());
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((r) => (timer = setTimeout(r, graceMs)));
    await Promise.race([this.settle(), expired]);
    clearTimeout(timer);
    this.#stopped = true;
    const abandoned = [...this.#inFlight.keys()];
    for (const id of abandoned)
      this.#log({
        event: 'handler_abandoned',
        effect_id: id,
        detail: `still running after ${graceMs}ms`,
      });
    return abandoned;
  }
}
