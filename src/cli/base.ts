/**
 * What the hook path and `--version` share with the other commands. Nothing here may import a schema
 * library or the application layer: a harness runs the hooks on every Stop and while a session opens.
 */
import { join } from 'node:path';
import { callDaemon, clientErrorEnvelope, readClientActor, resolveDataDir } from './client.ts';
import { exitCodeFor } from './errors.ts';
import {
  CONTROL_SOCKET,
  ExitCode,
  errorEnvelope,
  renderEnvelope,
  type Envelope,
} from './output.ts';
import type { CliIo } from './program.ts';

export { DATA_DIR } from './program.ts';

/** A flag this command can check itself: the message says how to fix it, with no error code in front. */
export function badFlag(
  message: string,
  details: Readonly<Record<string, unknown>>,
  json: boolean,
  io: CliIo,
): number {
  if (!json) {
    io.stderr(`cusr: ${message}\n`);
    return ExitCode.usage;
  }
  const envelope = errorEnvelope({
    code: 'invalid_arguments',
    message,
    details,
    request_id: null,
  });
  io.stdout(renderEnvelope(envelope));
  return exitCodeFor(envelope);
}

/** A read on `/v1/query`; it carries no request ID. */
export async function queryDaemon(
  values: Readonly<Record<string, string | undefined>>,
  body: unknown,
  timeoutMs?: number,
): Promise<Envelope> {
  const dataDir = resolveDataDir(values['dataDir']);
  const actor = readClientActor();
  const reply = actor.ok
    ? await callDaemon({
        socketPath: join(dataDir, CONTROL_SOCKET),
        actor: actor.value,
        method: 'POST',
        path: '/v1/query',
        body,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
    : actor;
  if (reply.ok) return reply.value.envelope;
  return clientErrorEnvelope(dataDir, reply.error, null);
}
