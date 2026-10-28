/**
 * Effect dispatch (contracts/cli-daemon.md "Transport và application service", research R-16). The daemon
 * is the only writer: it claims a committed `pending` effect through the store (`EffectStarted` and the
 * operation identity commit together), and only after that commit hands the effect to a handler built on
 * the ports. A handler returns facts as a trigger envelope; the dispatcher accepts it through the same
 * store. Handlers never touch the store, never choose a task status and never decide retry.
 *
 * Never dispatched: `merge` (merging is the user's action on GitHub, ADR-0001), tasks without a runtime
 * snapshot (legacy 001 tasks are read-only here), and effect kinds that have no handler yet.
 */
import type { Clock } from '../adapters/ports.ts';
import type { Effect, EffectKind } from '../domain/effect.ts';
import type { TriggerEnvelope } from '../domain/trigger.ts';
import type { Uuid } from '../shared/brand.ts';
import type { ClaimError, Store } from '../store/index.ts';

export type EffectHandler = (effect: Effect, signal: AbortSignal) => Promise<TriggerEnvelope>;

/** `merge` cannot be given a handler: the type excludes it and the constructor refuses it at runtime. */
export type EffectHandlers = Partial<Record<Exclude<EffectKind, 'merge'>, EffectHandler>>;

export type SkipReason = 'merge_refused' | 'no_handler' | 'dispatch_blocked' | 'in_flight' | ClaimError['code'] | `claim_blocked:${string}`;

export type DispatchReport = {
  readonly started: readonly string[];
  readonly skipped: readonly { readonly effect_id: string; readonly reason: SkipReason }[];
};

export type DispatchLog = (record: { readonly event: string; readonly effect_id: string; readonly detail?: string }) => void;

export type DispatcherOptions = {
  readonly store: Store;
  readonly clock: Clock;
  readonly handlers: EffectHandlers;
  readonly log?: DispatchLog;
  readonly batch?: number;
};

export class DispatchConfigError extends Error {
  override name = 'DispatchConfigError';
}

export class Dispatcher {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #handlers: EffectHandlers;
  readonly #log: DispatchLog;
  readonly #batch: number;
  readonly #inFlight = new Map<string, { abort: AbortController; done: Promise<void> }>();
  #blocked: string | null = null;

  constructor(opts: DispatcherOptions) {
    if (Object.hasOwn(opts.handlers, 'merge')) throw new DispatchConfigError('merge is never executed by the daemon');
    this.#store = opts.store;
    this.#clock = opts.clock;
    this.#handlers = opts.handlers;
    this.#log = opts.log ?? (() => undefined);
    this.#batch = opts.batch ?? 100;
  }

  /** Stops new claims (e.g. projection mismatch at startup); in-flight work is left to finish. */
  block(reason: string): void {
    this.#blocked = reason;
  }

  get blockedReason(): string | null {
    return this.#blocked;
  }

  get inFlight(): number {
    return this.#inFlight.size;
  }

  /** One synchronous pass: claim what can run now and start its handler without awaiting it. */
  tick(): DispatchReport {
    const started: string[] = [];
    const skipped: { effect_id: string; reason: SkipReason }[] = [];
    for (const effect of this.#store.pendingEffects(this.#batch)) {
      const reason = this.#skipReason(effect);
      if (reason !== null) {
        skipped.push({ effect_id: effect.id, reason });
        continue;
      }
      const claimed = this.#store.claimEffect(effect.id as Uuid, this.#clock.now(), { require_runtime: true });
      if (!claimed.ok) {
        const r = claimed.error.code === 'claim_blocked' ? (`claim_blocked:${claimed.error.reason}` as const) : claimed.error.code;
        skipped.push({ effect_id: effect.id, reason: r });
        continue;
      }
      // Only now, after EffectStarted is committed, may anything outside the store happen.
      this.#start(claimed.value, this.#handlers[effect.kind as Exclude<EffectKind, 'merge'>] as EffectHandler);
      started.push(effect.id);
    }
    return { started, skipped };
  }

  #skipReason(effect: Effect): SkipReason | null {
    if (effect.kind === 'merge') return 'merge_refused';
    if (this.#blocked !== null) return 'dispatch_blocked';
    if (this.#inFlight.has(effect.id)) return 'in_flight';
    return this.#handlers[effect.kind] === undefined ? 'no_handler' : null;
  }

  #start(effect: Effect, handler: EffectHandler): void {
    const abort = new AbortController();
    const done = (async () => {
      try {
        const envelope = await handler(effect, abort.signal);
        const accepted = this.#store.accept(envelope);
        if (!accepted.ok) this.#log({ event: 'result_rejected', effect_id: effect.id, detail: JSON.stringify(accepted.error) });
      } catch (e) {
        // The effect stays `started`: recovery reconciles it; nothing here guesses an outcome.
        this.#log({ event: 'handler_failed', effect_id: effect.id, detail: e instanceof Error ? e.message : String(e) });
      } finally {
        this.#inFlight.delete(effect.id);
      }
    })();
    this.#inFlight.set(effect.id, { abort, done });
  }

  /** Waits for every handler started so far. */
  async settle(): Promise<void> {
    await Promise.all([...this.#inFlight.values()].map((f) => f.done));
  }

  /** Signals every in-flight handler to stop, then waits for them. */
  async stop(): Promise<void> {
    for (const f of this.#inFlight.values()) f.abort.abort();
    await this.settle();
  }
}
