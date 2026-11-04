/**
 * CLI side of the control socket (contracts/cli-daemon.md). Every command, reads included, goes through
 * the daemon: the store is held EXCLUSIVE by the single writer, so there is no fallback to opening the
 * database. A missing or unreachable daemon is exit 3. The token comes from `CUSR_TOKEN_FILE` or the
 * owner token in DATA_DIR, never from argv.
 */
import { request } from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { OWNER_TOKEN_FILE, readTokenFile } from '../application/access-tokens.ts';
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
  readonly code: 'connection' | 'timeout' | 'protocol' | 'token';
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

export function readClientToken(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Result<string, ClientError> {
  const path = env['CUSR_TOKEN_FILE'] ?? join(dataDir, OWNER_TOKEN_FILE);
  const t = readTokenFile(path, 'client');
  return t.ok
    ? t
    : err({
        code: 'token',
        message: `Cannot use token file ${path}: ${t.error.code === 'token_file_invalid' ? t.error.reason : t.error.code}`,
      });
}

export type CallOptions = {
  readonly socketPath: string;
  readonly token: string;
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
          authorization: `Bearer ${opts.token}`,
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
    const token = readClientToken(dataDir);
    const reply = token.ok
      ? await callDaemon({
          socketPath: join(dataDir, CONTROL_SOCKET),
          token: token.value,
          method: 'GET',
          path: '/v1/health',
        })
      : token;
    if (!reply.ok) {
      const code = reply.error.code === 'token' ? ExitCode.usage : ExitCode.connection;
      const envelope = errorEnvelope({
        code: reply.error.code === 'token' ? 'token_unavailable' : 'daemon_unreachable',
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
