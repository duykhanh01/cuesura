/**
 * Daemon composition (T026). One process is the only store writer: the SQLite file is opened with an
 * exclusive lock, so a second daemon on the same DATA_DIR fails with `store_locked`. Startup recovery
 * (startup.ts) verifies every projection, reconciles open operations and ingests runner output before the
 * first dispatch; a mismatch blocks dispatch and an unresolved claim holds new work, both reported by
 * health. A store or filesystem write failure while running latches the dispatcher (FR-023): nothing is
 * claimed, ingested or acknowledged and new commands are refused until restart. While running, the daemon keeps reconciling operations no handler owns (adopted runners,
 * unreadable probes). Clock, IDs, effect handlers, host probes and command/query handlers are injected,
 * so tests run the real transport and store with fakes behind it.
 */
import { lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { v7 as uuidv7 } from 'uuid';
import type { Clock } from '../adapters/ports.ts';
import {
  ensureOwnerToken,
  loadTokenMap,
  readTokenFile,
  type TokenMap,
} from '../application/access-tokens.ts';
import {
  authorize,
  type AuthzError,
  type Caller,
} from '../application/authz.ts';
import {
  COMMAND_PAYLOADS,
  UNSUPPORTED_GUIDANCE,
  admitCommand,
  type AdmitError,
  type Admitted,
  type CommandInput,
  type CommandKind,
} from '../application/commands.ts';
import { httpStatusFor } from '../cli/errors.ts';
import { okEnvelope } from '../cli/output.ts';
import type { RuntimeConfig } from '../config/normalize.ts';
import { readConfigFiles } from '../config/read-files.ts';
import type { AccessTokenSpec } from '../config/schema-user.ts';
import { validateConfig } from '../config/validate.ts';
import type { ConfigSource } from '../config/yaml-loader.ts';
import type { IdentityProbe } from '../runner/identity.ts';
import { Redactor } from '../runner/redact.ts';
import { inspectUnit } from '../runner/supervisor.ts';
import { asEpochMs } from '../shared/brand.ts';
import type { Result } from '../shared/result.ts';
import type { Store, StoreOpenError } from '../store/index.ts';
import {
  Dispatcher,
  type DispatchLog,
  type EffectHandlers,
} from './dispatch.ts';
import {
  clearOperationMark,
  writeOperationMark,
} from '../runner/process-tag.ts';
import { healthProblem, healthReply } from './health.ts';
import type { LockInspector, UnitInspector } from './reconcile.ts';
import { productionControl } from './production.ts';
import {
  closeServer,
  createControlServer,
  errorReply,
  listenControlSocket,
  type ControlHandlers,
  type Reply,
} from './server.ts';
import {
  heldReason,
  recoverOperations,
  recoverStore,
  type StartupReport,
} from './startup.ts';

export const STORE_FILE = 'cusr.db';

export const systemClock: Clock = {
  now: () => asEpochMs(Date.now()),
  monotonic: () => performance.now(),
};

export const newUuid = (): string => uuidv7();

export type HandlerError = {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
};

/** Runs an admitted mutation; its result is stored in the command ledger and replayed for the same request. */
export type CommandHandler = (
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
) => Promise<Result<unknown, HandlerError>>;
export type QueryHandler = (
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
) => Promise<Reply>;

/** What the daemon offers the handlers built over its store. */
export type DaemonRuntime = {
  readonly health: () => string | null;
  readonly abort: (effectId: string) => boolean;
  readonly settled: (effectId: string) => Promise<void>;
  /** The store refused a write: nothing new is claimed until a restart proves it again (FR-023). */
  readonly latch: (reason: string) => void;
};

export type DaemonOptions = {
  readonly dataDir: string;
  readonly accessTokens: readonly AccessTokenSpec[];
  readonly clock?: Clock;
  readonly newId?: () => string;
  readonly effects?: EffectHandlers;
  readonly commands?: Partial<Record<CommandKind, CommandHandler>>;
  readonly queries?: Readonly<Record<string, QueryHandler>>;
  /** Handlers that need the opened store (e.g. the task surface); merged over `commands`/`queries`. */
  readonly control?: (
    store: Store,
    runtime: DaemonRuntime,
  ) => {
    readonly commands?: Partial<Record<CommandKind, CommandHandler>>;
    readonly queries?: Readonly<Record<string, QueryHandler>>;
    /** Merged over `effects`; these handlers can reach the dispatcher through `runtime`. */
    readonly effects?: EffectHandlers;
    /**
     * Passes that run on the dispatch interval under the same conditions as `schedule`, each never
     * overlapping itself (timers, PR observation, drain). They start after the first request can arrive.
     */
    readonly rounds?: readonly (() => Promise<unknown>)[];
    /**
     * One scheduler pass (dependency notifications, queue, grant, start). It runs once before the first
     * request and then on the dispatch interval, never overlapping itself and never while new work is
     * held, blocked or latched.
     */
    readonly schedule?: () => Promise<unknown>;
  };
  readonly dispatchIntervalMs?: number;
  readonly log?: (msg: string) => void;
  /** Host probes used by recovery; default to systemd, the kernel operation lock and /proc. */
  readonly inspectUnit?: UnitInspector;
  readonly probeLock?: LockInspector;
  readonly identity?: IdentityProbe;
};

export type DaemonStartError =
  | { readonly code: 'data_dir_insecure'; readonly detail: string }
  | { readonly code: 'token_error'; readonly detail: string }
  | { readonly code: StoreOpenError['code']; readonly detail: string }
  | { readonly code: 'listen_failed'; readonly detail: string };

export type RunningDaemon = {
  readonly socketPath: string;
  readonly ownerTokenPath: string;
  readonly store: Store;
  readonly dispatcher: Dispatcher;
  readonly tokens: TokenMap;
  readonly startup: StartupReport;
  /** One recovery pass now (the interval runs it too); resolves once it is done. */
  recover(): Promise<void>;
  stop(): Promise<void>;
};

function authzReply(e: AuthzError): Reply {
  return e.code === 'unauthenticated'
    ? errorReply(401, {
        code: 'unauthenticated',
        message: 'missing or unknown bearer token',
        details: {},
      })
    : errorReply(403, {
        code: 'forbidden',
        message: `requires ${e.reason} ${e.required}`,
        details: { reason: e.reason, required: e.required },
      });
}

function admitReply(e: AdmitError, requestId: string | null): Reply {
  switch (e.code) {
    case 'unauthenticated':
    case 'forbidden':
      return authzReply(e);
    case 'unsupported_feature':
      return errorReply(400, {
        code: 'unsupported_feature',
        message: `${e.kind} is not supported`,
        details: {
          kind: e.kind,
          guidance: Object.hasOwn(UNSUPPORTED_GUIDANCE, e.kind)
            ? UNSUPPORTED_GUIDANCE[e.kind as keyof typeof UNSUPPORTED_GUIDANCE]
            : null,
        },
        request_id: requestId,
      });
    case 'invalid_command':
      return errorReply(400, {
        code: 'invalid_command',
        message: 'invalid command',
        details: { issues: e.issues },
        request_id: requestId,
      });
    case 'conflict':
      return errorReply(409, {
        code: 'conflict',
        message: `request conflicts: ${e.reason}`,
        details: { reason: e.reason },
        request_id: requestId,
      });
    default:
      return errorReply(500, {
        code: 'store_write_failed',
        message: 'store write failed',
        details: { code: e.code },
        request_id: requestId,
      });
  }
}

/** What the command ledger stores for a request: the handler's value or its rejection. */
type CommandOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: HandlerError };

function outcomeReply(
  requestId: string,
  outcome: CommandOutcome,
  replayed: boolean,
): Reply {
  if (!outcome.ok)
    return errorReply(httpStatusFor(outcome.error.code), {
      ...outcome.error,
      request_id: requestId,
    });
  return {
    status: 200,
    envelope: okEnvelope({
      request_id: requestId,
      replayed,
      result: outcome.value,
    }),
  };
}

/** DATA_DIR holds the store, tokens and socket: created 0700, refused when group/other can access it. */
function prepareDataDir(dataDir: string): string | null {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dataDir);
  if (!st.isDirectory()) return `${dataDir} is not a directory`;
  if ((st.mode & 0o077) !== 0)
    return `${dataDir} must not be accessible by group or others (mode ${(st.mode & 0o777).toString(8)})`;
  if (typeof process.getuid === 'function' && st.uid !== process.getuid())
    return `${dataDir} is owned by another user`;
  return null;
}

export async function startDaemon(
  opts: DaemonOptions,
): Promise<Result<RunningDaemon, DaemonStartError>> {
  const clock = opts.clock ?? systemClock;
  const newId = opts.newId ?? newUuid;
  const rawLog = opts.log ?? (() => undefined);
  // Until the token files are read, only well-known credential shapes and secret-named env values are known.
  let redactor = new Redactor({ env: process.env });
  // Every daemon log line (request failures, handler errors) passes here: secrets are masked before output.
  const log = (msg: string): void => rawLog(redactor.text(msg));
  const insecure = prepareDataDir(opts.dataDir);
  if (insecure !== null)
    return {
      ok: false,
      error: { code: 'data_dir_insecure', detail: insecure },
    };

  const owner = ensureOwnerToken(opts.dataDir);
  if (!owner.ok)
    return {
      ok: false,
      error: { code: 'token_error', detail: JSON.stringify(owner.error) },
    };
  const tokens = loadTokenMap(owner.value.path, opts.accessTokens);
  if (!tokens.ok)
    return {
      ok: false,
      error: { code: 'token_error', detail: JSON.stringify(tokens.error) },
    };
  const secrets: string[] = [];
  for (const [id, path] of [
    ['owner', owner.value.path],
    ...opts.accessTokens.map((t) => [t.id, t.token_file] as const),
  ] as const) {
    const t = readTokenFile(path, id);
    if (t.ok) secrets.push(t.value);
  }
  redactor = new Redactor({ values: secrets, env: process.env });
  log(`token config hash ${tokens.value.config_hash}`);
  for (const a of tokens.value.audit)
    log(
      `token ${a.id} actor=${a.actor} roles=${a.roles.join(',')} projects=${a.projects === '*' ? '*' : a.projects.join(',')} fp=${a.fingerprint}`,
    );

  const recovery = {
    dataDir: opts.dataDir,
    redactor,
    inspect: opts.inspectUnit ?? ((id: string) => inspectUnit(id)),
    ...(opts.probeLock === undefined ? {} : { probeLock: opts.probeLock }),
    ...(opts.identity === undefined ? {} : { identity: opts.identity }),
    now: () => clock.now(),
    newId,
  };
  const recovered = await recoverStore({
    ...recovery,
    path: join(opts.dataDir, STORE_FILE),
  });
  if (!recovered.ok) return { ok: false, error: recovered.error };
  const { store, report: startup } = recovered.value;
  for (const r of startup.operations)
    log(
      `recover ${r.operation_id}: ${r.from} -> ${r.finding.status} (${r.finding.reason}); effect ${r.effect}${r.error === undefined ? '' : `; error ${r.error}`}`,
    );
  for (const r of startup.ingest)
    log(
      `spool ${r.operation_id}: ${r.status} records=${r.records} torn=${r.torn} acked=${r.acked.length}${r.detail === undefined ? '' : `: ${r.detail}`}`,
    );

  // Called here because the handlers go into the dispatcher; `runtime` is only used once it exists.
  const extra: ReturnType<NonNullable<DaemonOptions['control']>> =
    opts.control?.(store, {
      health: () => healthProblem(dispatcher),
      abort: (id) => dispatcher.abort(id),
      settled: (id) => dispatcher.settled(id),
      latch: (reason) => dispatcher.latch(reason),
    }) ?? {};
  const dispatchLog: DispatchLog = (r) =>
    log(
      `dispatch ${r.event} ${r.effect_id}${r.detail === undefined ? '' : `: ${r.detail}`}`,
    );
  const dispatcher: Dispatcher = new Dispatcher({
    store,
    clock,
    handlers: { ...opts.effects, ...extra.effects },
    log: dispatchLog,
    newId,
    marks: {
      write: (id) => writeOperationMark(opts.dataDir, id),
      clear: (id) => clearOperationMark(opts.dataDir, id),
    },
  });
  if (startup.blocked !== null) {
    dispatcher.block(startup.blocked);
    log(`startup recovery: dispatch blocked: ${startup.blocked}`);
  }
  dispatcher.hold(startup.held);
  if (startup.held !== null)
    log(`startup recovery: new work held: ${startup.held}`);
  let unresolved = startup.unresolved;

  // Operations no handler owns are followed until they resolve; a pass never overlaps the previous one.
  let recovering: Promise<void> | null = null;
  const recover = (): Promise<void> => {
    if (recovering !== null) return recovering;
    // A latched store takes no facts: runner spools wait on disk, unacknowledged, for the restart.
    if (dispatcher.blockedReason !== null || dispatcher.latchedReason !== null)
      return Promise.resolve();
    recovering = (async () => {
      const r = await recoverOperations({
        ...recovery,
        store,
        inFlight: (id) => dispatcher.isInFlight(id),
      });
      for (const o of r.reconcile.operations)
        if (o.from !== o.finding.status || o.effect !== 'kept')
          log(
            `recover ${o.operation_id}: ${o.from} -> ${o.finding.status} (${o.finding.reason}); effect ${o.effect}`,
          );
      if (
        r.reconcile.write_failed ||
        r.ingest.some((i) => i.status === 'write_failed')
      ) {
        dispatcher.latch('store write failed during recovery');
        return;
      }
      unresolved = r.reconcile.unresolved;
      dispatcher.hold(heldReason(unresolved));
    })().finally(() => {
      recovering = null;
    });
    return recovering;
  };
  let scheduling: Promise<void> | null = null;
  const schedule = (): Promise<void> => {
    if (
      extra.schedule === undefined ||
      scheduling !== null ||
      healthProblem(dispatcher) !== null
    )
      return scheduling ?? Promise.resolve();
    scheduling = extra
      .schedule()
      .then(
        () => undefined,
        (e: unknown) =>
          log(
            `scheduler pass failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      )
      .finally(() => {
        scheduling = null;
      });
    return scheduling;
  };
  const running = new Set<Promise<void>>();
  const rounds = (extra.rounds ?? []).map((round) => {
    let current: Promise<void> | null = null;
    return (): void => {
      if (current !== null || healthProblem(dispatcher) !== null) return;
      const pass: Promise<void> = round()
        .then(
          () => undefined,
          (e: unknown) =>
            log(
              `daemon round failed: ${e instanceof Error ? e.message : String(e)}`,
            ),
        )
        .finally(() => {
          running.delete(pass);
          current = null;
        });
      current = pass;
      running.add(pass);
    };
  });
  const commands = { ...opts.commands, ...extra.commands };
  const inFlight = new Map<string, Promise<Reply>>();
  const queries = { ...opts.queries, ...extra.queries };
  const handlers: ControlHandlers = {
    health(caller) {
      const allowed = authorize(caller, { role: 'read' });
      if (!allowed.ok) return authzReply(allowed.error);
      return healthReply({
        store,
        dispatcher,
        startup,
        unresolved,
        now: clock.now(),
      });
    },
    async query(caller, body) {
      const allowed = authorize(caller, { role: 'read' });
      if (!allowed.ok) return authzReply(allowed.error);
      const kind =
        typeof body === 'object' && body !== null
          ? (body as { kind?: unknown }).kind
          : undefined;
      const handler =
        typeof kind === 'string' && Object.hasOwn(queries, kind)
          ? queries[kind]
          : undefined;
      if (handler === undefined)
        return errorReply(501, {
          code: 'not_available',
          message: `query ${String(kind)} is not available in this build`,
          details: {},
        });
      return handler(caller, body as Record<string, unknown>);
    },
    async command(caller, body) {
      const input = body as CommandInput;
      const requestId =
        typeof input?.request_id === 'string' ? input.request_id : null;
      const kind = typeof input?.kind === 'string' ? input.kind : '';
      // A supported kind without a handler in this build is refused before admission, so no ledger row
      // waits for it forever. Unknown and unsupported kinds get their own error from admission.
      // Nothing is admitted while the store is latched: no request is reported accepted unless it is
      // durably recorded and can still be executed.
      if (dispatcher.latchedReason !== null)
        return errorReply(503, {
          code: 'store_unwritable',
          message: `store unwritable: ${dispatcher.latchedReason}`,
          details: { failure: dispatcher.latchedReason },
          request_id: requestId,
        });
      const known = Object.hasOwn(COMMAND_PAYLOADS, kind);
      const handler = known ? commands[kind as CommandKind] : undefined;
      if (known && handler === undefined) {
        return errorReply(501, {
          code: 'not_available',
          message: `command ${kind} is not available in this build`,
          details: { kind },
          request_id: requestId,
        });
      }
      const admitted = admitCommand(
        { store, now: () => clock.now(), newId },
        caller,
        body,
      );
      if (!admitted.ok) {
        if (admitted.error.code === 'write_failed')
          dispatcher.latch(`store write failed: ${admitted.error.cause}`);
        return admitReply(admitted.error, requestId);
      }
      const record = admitted.value.record;
      if (record.status === 'completed')
        return outcomeReply(
          record.request_id,
          record.result as CommandOutcome,
          true,
        );
      // The same request already running in this process: wait for its answer instead of running twice.
      const running = inFlight.get(record.request_id);
      if (running !== undefined) return running;
      // Admission succeeded, so the kind is known and has a handler. An `admitted` record left by a
      // crash runs the same handler again with the IDs assigned the first time.
      const run = (async (): Promise<Reply> => {
        const r = await (handler as CommandHandler)(
          admitted.value,
          input,
          caller,
        );
        // A rejection is a result too: it is stored and replayed, never run again for the same request.
        const outcome: CommandOutcome = r.ok
          ? { ok: true, value: r.value }
          : { ok: false, error: r.error };
        const done = store.completeCommand(
          record.request_id,
          outcome,
          clock.now(),
        );
        if (!done.ok) {
          if (done.error.code === 'write_failed')
            dispatcher.latch(`store write failed: ${done.error.cause}`);
          return admitReply(done.error, record.request_id);
        }
        if (r.ok) dispatcher.tick();
        return outcomeReply(record.request_id, outcome, false);
      })();
      inFlight.set(record.request_id, run);
      try {
        return await run;
      } finally {
        inFlight.delete(record.request_id);
      }
    },
  };

  const server: Server = createControlServer(tokens.value, handlers, log);
  let socketPath: string;
  try {
    socketPath = await listenControlSocket(server, opts.dataDir);
  } catch (e) {
    store.close();
    return {
      ok: false,
      error: {
        code: 'listen_failed',
        detail: e instanceof Error ? e.message : String(e),
      },
    };
  }

  // A dependency notification lost when the daemon died right after DONE is recovered by this first pass
  // (T119); notifications are derived from committed state, so a repeat changes nothing.
  await schedule();
  const interval = setInterval(() => {
    void schedule();
    for (const round of rounds) round();
    dispatcher.tick();
    if (store.unresolvedOperations().length > 0) void recover();
  }, opts.dispatchIntervalMs ?? 1_000);
  interval.unref();
  dispatcher.tick();

  return {
    ok: true,
    value: {
      socketPath,
      ownerTokenPath: owner.value.path,
      store,
      dispatcher,
      tokens: tokens.value,
      startup,
      recover,
      async stop() {
        clearInterval(interval);
        await recovering;
        await scheduling;
        await Promise.all(running);
        await closeServer(server);
        await dispatcher.stop();
        store.close();
      },
    },
  };
}

export type DaemonCliArgs = {
  readonly config: string;
  readonly dataDir: string | undefined;
};

/** Reads the trusted user config; only `runtime` is used to start the daemon. */
export async function loadDaemonConfig(args: DaemonCliArgs): Promise<
  Result<
    {
      dataDir: string;
      accessTokens: AccessTokenSpec[];
      runtime: RuntimeConfig;
    },
    string
  >
> {
  let sources;
  try {
    sources = await readConfigFiles({ user: args.config });
  } catch (e) {
    return {
      ok: false,
      error: `cannot read ${args.config}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const validated = validateConfig({
    user: sources[0] as ConfigSource,
    packs: {},
  });
  if (!validated.ok)
    return {
      ok: false,
      error: validated.error
        .map((d) => `${d.file}:${d.line}:${d.col} ${d.code}: ${d.message}`)
        .join('\n'),
    };
  const runtime = validated.value.runtime;
  if (runtime === null)
    return {
      ok: false,
      error: `${args.config}: runtime section is required by cusrd`,
    };
  const dataDir = args.dataDir ?? runtime.data_dir ?? join(homedir(), '.cusr');
  return {
    ok: true,
    value: {
      dataDir: isAbsolute(dataDir) ? dataDir : resolve(dataDir),
      accessTokens: runtime.access_tokens,
      runtime,
    },
  };
}

/** `cusrd --config FILE [--data-dir DIR]`: foreground daemon until SIGTERM/SIGINT. */
export async function daemonMain(
  args: DaemonCliArgs,
  io: { stderr: (t: string) => void },
  until: Promise<unknown>,
): Promise<number> {
  const cfg = await loadDaemonConfig(args);
  if (!cfg.ok) {
    io.stderr(`cusrd: ${cfg.error}\n`);
    return 2;
  }
  const log = (m: string): void => io.stderr(`cusrd: ${m}\n`);
  const clock: Clock = {
    now: () => asEpochMs(Date.now()),
    monotonic: () => performance.now(),
  };
  const control = await productionControl({
    configPath: args.config,
    dataDir: cfg.value.dataDir,
    clock,
    redactor: new Redactor({ env: process.env }),
    newId: newUuid,
  });
  const started = await startDaemon({
    dataDir: cfg.value.dataDir,
    accessTokens: cfg.value.accessTokens,
    log,
    clock,
    control,
  });
  if (!started.ok) {
    io.stderr(`cusrd: ${started.error.code}: ${started.error.detail}\n`);
    return started.error.code === 'store_locked' ? 3 : 1;
  }
  log(`listening on ${started.value.socketPath}`);
  await until;
  await started.value.stop();
  log('stopped');
  return 0;
}
