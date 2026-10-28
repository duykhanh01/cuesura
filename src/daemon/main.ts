/**
 * Daemon composition (T026). One process is the only store writer: the SQLite file is opened with an
 * exclusive lock, so a second daemon on the same DATA_DIR fails with `store_locked`. Startup verifies
 * every projection by replay and blocks dispatch on a mismatch. Clock, IDs, effect handlers and
 * command/query handlers are injected, so tests run the real transport and store with fakes behind it.
 */
import { lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { v7 as uuidv7 } from 'uuid';
import type { Clock } from '../adapters/ports.ts';
import { ensureOwnerToken, loadTokenMap, type TokenMap } from '../application/access-tokens.ts';
import { authorize, type AuthzError, type Caller } from '../application/authz.ts';
import { COMMAND_PAYLOADS, admitCommand, type AdmitError, type Admitted, type CommandInput, type CommandKind } from '../application/commands.ts';
import { okEnvelope } from '../cli/output.ts';
import { readConfigFiles } from '../config/read-files.ts';
import type { AccessTokenSpec } from '../config/schema-user.ts';
import { validateConfig } from '../config/validate.ts';
import type { ConfigSource } from '../config/yaml-loader.ts';
import { asEpochMs } from '../shared/brand.ts';
import type { Result } from '../shared/result.ts';
import { openStore, type Store, type StoreOpenError } from '../store/index.ts';
import { Dispatcher, type DispatchLog, type EffectHandlers } from './dispatch.ts';
import { closeServer, createControlServer, errorReply, listenControlSocket, type ControlHandlers, type Reply } from './server.ts';

export const STORE_FILE = 'cusr.db';

export const systemClock: Clock = {
  now: () => asEpochMs(Date.now()),
  monotonic: () => performance.now(),
};

export const newUuid = (): string => uuidv7();

export type HandlerError = { readonly code: string; readonly message: string; readonly details: Readonly<Record<string, unknown>> };

/** Runs an admitted mutation; its result is stored in the command ledger and replayed for the same request. */
export type CommandHandler = (admitted: Admitted, input: CommandInput, caller: Caller) => Promise<Result<unknown, HandlerError>>;
export type QueryHandler = (caller: Caller, body: Readonly<Record<string, unknown>>) => Promise<Reply>;

export type DaemonOptions = {
  readonly dataDir: string;
  readonly accessTokens: readonly AccessTokenSpec[];
  readonly clock?: Clock;
  readonly newId?: () => string;
  readonly effects?: EffectHandlers;
  readonly commands?: Partial<Record<CommandKind, CommandHandler>>;
  readonly queries?: Readonly<Record<string, QueryHandler>>;
  readonly dispatchIntervalMs?: number;
  readonly log?: (msg: string) => void;
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
  stop(): Promise<void>;
};

function authzReply(e: AuthzError): Reply {
  return e.code === 'unauthenticated'
    ? errorReply(401, { code: 'unauthenticated', message: 'missing or unknown bearer token', details: {} })
    : errorReply(403, { code: 'forbidden', message: `requires ${e.reason} ${e.required}`, details: { reason: e.reason, required: e.required } });
}

function admitReply(e: AdmitError, requestId: string | null): Reply {
  switch (e.code) {
    case 'unauthenticated':
    case 'forbidden':
      return authzReply(e);
    case 'unsupported_feature':
      return errorReply(400, { code: 'unsupported_feature', message: `${e.kind} is not supported`, details: { kind: e.kind }, request_id: requestId });
    case 'invalid_command':
      return errorReply(400, { code: 'invalid_command', message: 'invalid command', details: { issues: e.issues }, request_id: requestId });
    case 'conflict':
      return errorReply(409, { code: 'conflict', message: `request conflicts: ${e.reason}`, details: { reason: e.reason }, request_id: requestId });
    default:
      return errorReply(500, { code: 'store_write_failed', message: 'store write failed', details: { code: e.code }, request_id: requestId });
  }
}

/** DATA_DIR holds the store, tokens and socket: created 0700, refused when group/other can access it. */
function prepareDataDir(dataDir: string): string | null {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dataDir);
  if (!st.isDirectory()) return `${dataDir} is not a directory`;
  if ((st.mode & 0o077) !== 0) return `${dataDir} must not be accessible by group or others (mode ${(st.mode & 0o777).toString(8)})`;
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return `${dataDir} is owned by another user`;
  return null;
}

export async function startDaemon(opts: DaemonOptions): Promise<Result<RunningDaemon, DaemonStartError>> {
  const clock = opts.clock ?? systemClock;
  const newId = opts.newId ?? newUuid;
  const log = opts.log ?? (() => undefined);
  const insecure = prepareDataDir(opts.dataDir);
  if (insecure !== null) return { ok: false, error: { code: 'data_dir_insecure', detail: insecure } };

  const owner = ensureOwnerToken(opts.dataDir);
  if (!owner.ok) return { ok: false, error: { code: 'token_error', detail: JSON.stringify(owner.error) } };
  const tokens = loadTokenMap(owner.value.path, opts.accessTokens);
  if (!tokens.ok) return { ok: false, error: { code: 'token_error', detail: JSON.stringify(tokens.error) } };
  for (const a of tokens.value.audit) log(`token ${a.id} actor=${a.actor} roles=${a.roles.join(',')} projects=${a.projects === '*' ? '*' : a.projects.join(',')} fp=${a.fingerprint}`);

  const opened = openStore(join(opts.dataDir, STORE_FILE));
  if (!opened.ok) return { ok: false, error: opened.error };
  const store = opened.value;

  const dispatchLog: DispatchLog = (r) => log(`dispatch ${r.event} ${r.effect_id}${r.detail === undefined ? '' : `: ${r.detail}`}`);
  const dispatcher = new Dispatcher({ store, clock, handlers: opts.effects ?? {}, log: dispatchLog });
  const verify = store.verifyProjections();
  if (!verify.ok) {
    dispatcher.block(`projection mismatch (${verify.mismatches.length})`);
    log(`projection verification failed: ${verify.mismatches.length} mismatches; dispatch blocked`);
  }

  const commands = opts.commands ?? {};
  const queries = opts.queries ?? {};
  const handlers: ControlHandlers = {
    health(caller) {
      const allowed = authorize(caller, { role: 'read' });
      if (!allowed.ok) return authzReply(allowed.error);
      return {
        status: 200,
        envelope: okEnvelope({
          writer: 'ok',
          projections: { ok: verify.ok, tasks: verify.tasks, events: verify.events, mismatches: verify.mismatches.length },
          dispatch: { blocked: dispatcher.blockedReason, in_flight: dispatcher.inFlight },
          slot: store.readSlot(),
          queue_length: store.readQueue(100).length,
          now: clock.now(),
        }),
      };
    },
    async query(caller, body) {
      const allowed = authorize(caller, { role: 'read' });
      if (!allowed.ok) return authzReply(allowed.error);
      const kind = typeof body === 'object' && body !== null ? (body as { kind?: unknown }).kind : undefined;
      const handler = typeof kind === 'string' && Object.hasOwn(queries, kind) ? queries[kind] : undefined;
      if (handler === undefined) return errorReply(501, { code: 'not_available', message: `query ${String(kind)} is not available in this build`, details: {} });
      return handler(caller, body as Record<string, unknown>);
    },
    async command(caller, body) {
      const input = body as CommandInput;
      const requestId = typeof input?.request_id === 'string' ? input.request_id : null;
      const kind = typeof input?.kind === 'string' ? input.kind : '';
      // A supported kind without a handler in this build is refused before admission, so no ledger row
      // waits for it forever. Unknown and unsupported kinds get their own error from admission.
      const known = Object.hasOwn(COMMAND_PAYLOADS, kind);
      const handler = known ? commands[kind as CommandKind] : undefined;
      if (known && handler === undefined) {
        return errorReply(501, { code: 'not_available', message: `command ${kind} is not available in this build`, details: { kind }, request_id: requestId });
      }
      const admitted = admitCommand({ store, now: () => clock.now(), newId }, caller, body);
      if (!admitted.ok) return admitReply(admitted.error, requestId);
      const record = admitted.value.record;
      if (record.status === 'completed') return { status: 200, envelope: okEnvelope({ request_id: record.request_id, replayed: true, result: record.result }) };
      // Admission succeeded, so the kind is known and has a handler. An `admitted` record left by a
      // crash runs the same handler again with the IDs assigned the first time.
      const r = await (handler as CommandHandler)(admitted.value, input, caller);
      if (!r.ok) return errorReply(422, { ...r.error, request_id: record.request_id });
      const done = store.completeCommand(record.request_id, r.value, clock.now());
      if (!done.ok) return admitReply(done.error, record.request_id);
      dispatcher.tick();
      return { status: 200, envelope: okEnvelope({ request_id: record.request_id, replayed: false, result: r.value }) };
    },
  };

  const server: Server = createControlServer(tokens.value, handlers, log);
  let socketPath: string;
  try {
    socketPath = await listenControlSocket(server, opts.dataDir);
  } catch (e) {
    store.close();
    return { ok: false, error: { code: 'listen_failed', detail: e instanceof Error ? e.message : String(e) } };
  }

  const interval = setInterval(() => dispatcher.tick(), opts.dispatchIntervalMs ?? 1_000);
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
      async stop() {
        clearInterval(interval);
        await closeServer(server);
        await dispatcher.stop();
        store.close();
      },
    },
  };
}

export type DaemonCliArgs = { readonly config: string; readonly dataDir: string | undefined };

/** Reads the trusted user config; only `runtime` is used to start the daemon. */
export async function loadDaemonConfig(args: DaemonCliArgs): Promise<Result<{ dataDir: string; accessTokens: AccessTokenSpec[] }, string>> {
  let sources;
  try {
    sources = await readConfigFiles({ user: args.config });
  } catch (e) {
    return { ok: false, error: `cannot read ${args.config}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const validated = validateConfig({ user: sources[0] as ConfigSource, packs: {} });
  if (!validated.ok) return { ok: false, error: validated.error.map((d) => `${d.file}:${d.line}:${d.col} ${d.code}: ${d.message}`).join('\n') };
  const runtime = validated.value.runtime;
  if (runtime === null) return { ok: false, error: `${args.config}: runtime section is required by cusrd` };
  const dataDir = args.dataDir ?? runtime.data_dir ?? join(homedir(), '.cusr');
  return { ok: true, value: { dataDir: isAbsolute(dataDir) ? dataDir : resolve(dataDir), accessTokens: runtime.access_tokens } };
}

/** `cusrd --config FILE [--data-dir DIR]`: foreground daemon until SIGTERM/SIGINT. */
export async function daemonMain(args: DaemonCliArgs, io: { stderr: (t: string) => void }, until: Promise<unknown>): Promise<number> {
  const cfg = await loadDaemonConfig(args);
  if (!cfg.ok) {
    io.stderr(`cusrd: ${cfg.error}\n`);
    return 2;
  }
  const log = (m: string): void => io.stderr(`cusrd: ${m}\n`);
  const started = await startDaemon({ dataDir: cfg.value.dataDir, accessTokens: cfg.value.accessTokens, log });
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
