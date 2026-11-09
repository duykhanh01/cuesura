/**
 * Control transport (contracts/cli-daemon.md): `node:http` over the
 * filesystem socket DATA_DIR/control.sock (directory 0700, socket 0600; never TCP or an abstract socket).
 * GET /v1/health, POST /v1/query and POST /v1/command with a JSON body of at most 1 MiB. The socket's
 * file mode is the access check; the caller only declares its actor (`authz.ts`). Authorization, schema,
 * version and dedup belong to the handlers.
 */
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { ACTOR_HEADER, callerFor, CALLER_ACTORS, type Caller } from '../application/authz.ts';
import { CONTROL_SOCKET, errorEnvelope, type Envelope, type EnvelopeError } from '../cli/output.ts';

export const MAX_BODY_BYTES = 1024 * 1024;
/** sun_path holds 108 bytes on Linux, including the terminating NUL. */
export const MAX_SOCKET_PATH_BYTES = 107;
export const HEADER_TIMEOUT_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 10_000;
const CONNECTION_CHECK_MS = 1_000;

export type Reply = { readonly status: number; readonly envelope: Envelope };

export interface ControlHandlers {
  health(caller: Caller): Reply;
  query(caller: Caller, body: unknown): Promise<Reply>;
  command(caller: Caller, body: unknown): Promise<Reply>;
}

export function errorReply(
  status: number,
  error: Omit<EnvelopeError, 'request_id'> & { request_id?: string | null },
): Reply {
  return {
    status,
    envelope: errorEnvelope({ ...error, request_id: error.request_id ?? null }),
  };
}

function send(res: ServerResponse, reply: Reply): void {
  const body = `${JSON.stringify(reply.envelope)}\n`;
  res.writeHead(reply.status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function declaredActor(req: IncomingMessage): string | null {
  const h = req.headers[ACTOR_HEADER];
  return typeof h === 'string' ? h.trim() : null;
}

async function readBody(
  req: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; reply: Reply }> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    return {
      ok: false,
      reply: errorReply(415, {
        code: 'invalid_request',
        message: 'content-type must be application/json',
        details: {},
      }),
    };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      return {
        ok: false,
        reply: errorReply(413, {
          code: 'body_too_large',
          message: `body exceeds ${MAX_BODY_BYTES} bytes`,
          details: {},
        }),
      };
    }
    chunks.push(chunk as Buffer);
  }
  try {
    return {
      ok: true,
      value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
    };
  } catch {
    return {
      ok: false,
      reply: errorReply(400, {
        code: 'invalid_request',
        message: 'body is not valid JSON',
        details: {},
      }),
    };
  }
}

export function createControlServer(
  handlers: ControlHandlers,
  log: (msg: string) => void = () => undefined,
): Server {
  const server = createServer(
    {
      headersTimeout: HEADER_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
      // Node only checks those two limits on this interval (default 30 seconds).
      connectionsCheckingInterval: CONNECTION_CHECK_MS,
    },
    (req, res) => {
      void (async () => {
        const caller = callerFor(declaredActor(req));
        if (caller === null)
          return send(
            res,
            errorReply(401, {
              code: 'unauthenticated',
              message: `unknown actor; CUSR_ACTOR must be one of ${CALLER_ACTORS.join(', ')}`,
              details: {},
            }),
          );
        const route = `${req.method ?? ''} ${req.url ?? ''}`;
        if (route === 'GET /v1/health') return send(res, handlers.health(caller));
        if (route !== 'POST /v1/query' && route !== 'POST /v1/command') {
          return send(
            res,
            errorReply(404, {
              code: 'not_found',
              message: `no route ${route}`,
              details: {},
            }),
          );
        }
        const body = await readBody(req);
        if (!body.ok) return send(res, body.reply);
        send(
          res,
          route === 'POST /v1/query'
            ? await handlers.query(caller, body.value)
            : await handlers.command(caller, body.value),
        );
      })().catch((e: unknown) => {
        log(`control request failed: ${e instanceof Error ? e.message : String(e)}`);
        if (!res.headersSent)
          send(
            res,
            errorReply(500, {
              code: 'internal',
              message: 'internal error',
              details: {},
            }),
          );
        else res.destroy();
      });
    },
  );
  return server;
}

/**
 * Listens on DATA_DIR/control.sock. The caller already holds the store's exclusive lock, so a socket
 * file left there belongs to a dead daemon and is replaced; any other file type is refused.
 */
export async function listenControlSocket(server: Server, dataDir: string): Promise<string> {
  const path = join(dataDir, CONTROL_SOCKET);
  const bytes = Buffer.byteLength(path);
  if (bytes > MAX_SOCKET_PATH_BYTES)
    throw new Error(
      `socket path ${path} is ${bytes} bytes; Unix sockets allow ${MAX_SOCKET_PATH_BYTES}, use a shorter data dir`,
    );
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st !== undefined) {
    if (!st.isSocket()) throw new Error(`${path} exists and is not a socket`);
    unlinkSync(path);
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  chmodSync(path, 0o600);
  return path;
}

export async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
