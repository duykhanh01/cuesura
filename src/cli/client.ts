/**
 * CLI side of the control socket (contracts/cli-daemon.md). Every command, reads included, goes through
 * the daemon: the store is held EXCLUSIVE by the single writer, so there is no fallback to opening the
 * database. A missing or unreachable daemon is exit 3. The caller declares its actor with `CUSR_ACTOR`
 * (owner when unset); see `application/authz.ts` for what that does and does not protect.
 */
import { request } from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  ACTOR_HEADER,
  CALLER_ACTORS,
  isCallerActor,
  type CallerActor,
} from '../application/authz.ts';
import { err, ok, type Result } from '../shared/result.ts';
import {
  CONTROL_SOCKET,
  ExitCode,
  errorEnvelope,
  isEnvelope,
  renderEnvelope,
  type Envelope,
} from './output.ts';
import { exitCodeFor } from './errors.ts';
import type { CliCommand } from './program.ts';

export { exitCodeFor } from './errors.ts';

export const DEFAULT_CLIENT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type ClientError = {
  readonly code: 'connection' | 'timeout' | 'protocol' | 'actor';
  readonly message: string;
};

export type DaemonReply = {
  readonly status: number;
  readonly envelope: Envelope;
};

export function resolveDataDir(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = flag ?? env['CUSR_DATA_DIR'] ?? join(homedir(), '.cusr');
  return isAbsolute(dir) ? dir : resolve(dir);
}

export function readClientActor(
  env: NodeJS.ProcessEnv = process.env,
): Result<CallerActor, ClientError> {
  const v = env['CUSR_ACTOR'];
  if (v === undefined || v === '') return ok('owner');
  return isCallerActor(v)
    ? ok(v)
    : err({
        code: 'actor',
        message: `CUSR_ACTOR '${v}' is not one of ${CALLER_ACTORS.join(', ')}`,
      });
}

export type CallOptions = {
  readonly socketPath: string;
  readonly actor: CallerActor;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  /** The whole call, not idle time: a daemon sending a little at a time cannot hold it open (constitution III). */
  readonly timeoutMs?: number;
  /** Gives up at once and closes the connection, for a caller that stopped waiting. */
  readonly signal?: AbortSignal;
};

export function callDaemon(opts: CallOptions): Promise<Result<DaemonReply, ClientError>> {
  return new Promise((settle) => {
    // Settles once: a response cut mid-body fires `error`/`aborted`/`close` after or instead of `end`.
    let settled = false;
    const done = (r: Result<DaemonReply, ClientError>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      opts.signal?.removeEventListener('abort', cancel);
      settle(r);
    };
    const giveUp = (message: string): void => {
      done(err({ code: 'timeout', message }));
      req.destroy();
    };
    const cancel = (): void => giveUp('Daemon request was cancelled');
    const deadline = setTimeout(
      () => giveUp('ETIMEDOUT: Daemon request timed out'),
      opts.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS,
    );
    const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
    const req = request(
      {
        socketPath: opts.socketPath,
        // One connection per request: a pooled keep-alive socket would outlive a daemon restart.
        agent: false,
        method: opts.method,
        path: opts.path,
        headers: {
          [ACTOR_HEADER]: opts.actor,
          ...(payload === null
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES)
            req.destroy(new Error('Daemon response exceeds the size limit'));
          else chunks.push(c);
        });
        const cut = (): void =>
          done(
            err({
              code: 'connection',
              message: 'Daemon closed the connection before the response was complete',
            }),
          );
        res.on('aborted', cut);
        res.on('error', cut);
        res.on('close', () => {
          if (!res.complete) cut();
        });
        res.on('end', () => {
          try {
            const envelope: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!isEnvelope(envelope))
              throw new Error('Daemon response has an invalid result envelope');
            done(ok({ status: res.statusCode ?? 0, envelope }));
          } catch (e) {
            done(
              err({
                code: 'protocol',
                message: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        });
      },
    );
    req.on('error', (e: NodeJS.ErrnoException) => {
      done(
        err({
          code: 'connection',
          message: `${e.code ?? 'error'}: ${e.message}`,
        }),
      );
    });
    if (opts.signal?.aborted === true) {
      cancel();
      return;
    }
    opts.signal?.addEventListener('abort', cancel, { once: true });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

export const statusCommand: CliCommand = {
  name: 'status',
  description: 'Show daemon health, recovery status, and execution slot',
  options: [
    {
      flags: '--data-dir <dir>',
      description: 'Daemon data directory (default: $CUSR_DATA_DIR or ~/.cusr)',
    },
  ],
  async run(values, json, io) {
    const dataDir = resolveDataDir(values['dataDir']);
    const actor = readClientActor();
    const reply = actor.ok
      ? await callDaemon({
          socketPath: join(dataDir, CONTROL_SOCKET),
          actor: actor.value,
          method: 'GET',
          path: '/v1/health',
        })
      : actor;
    if (!reply.ok) {
      const code = reply.error.code === 'actor' ? ExitCode.usage : ExitCode.connection;
      const envelope = errorEnvelope({
        code: reply.error.code === 'actor' ? 'actor_invalid' : 'daemon_unreachable',
        message: reply.error.message,
        details: {},
        request_id: null,
      });
      if (json) io.stdout(renderEnvelope(envelope));
      else io.stderr(`cusr: ${reply.error.message}\n`);
      return code;
    }
    const { envelope } = reply.value;
    if (json) io.stdout(renderEnvelope(envelope));
    else if (envelope.ok) io.stdout(`${JSON.stringify(envelope.data, null, 2)}\n`);
    else io.stderr(`cusr: ${envelope.error.code}: ${envelope.error.message}\n`);
    return exitCodeFor(envelope);
  },
};
