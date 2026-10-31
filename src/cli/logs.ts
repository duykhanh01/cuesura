/**
 * Follow committed records as JSON Lines until task completion or the session limit. Return a cursor
 * to resume interrupted sessions. Records go to stdout; connection diagnostics go to stderr.
 */
import { join } from 'node:path';
import { callDaemon, readClientToken, resolveDataDir } from './client.ts';
import { exitCodeFor } from './errors.ts';
import { CONTROL_SOCKET, ExitCode } from './output.ts';
import type { CliCommand } from './program.ts';
import { print } from './tasks.ts';
import { errorEnvelope } from './output.ts';

export const FOLLOW_SESSION_MS = 3_600_000;
const FOLLOW_POLL_MS = 1_000;

type Page = {
  readonly records: readonly unknown[];
  readonly next_cursor: number;
  readonly complete: boolean;
};

export type FollowOptions = {
  readonly maxSessionMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

export function logsCommandWith(o: FollowOptions = {}): CliCommand {
  const maxSession = o.maxSessionMs ?? FOLLOW_SESSION_MS;
  const pollMs = o.pollMs ?? FOLLOW_POLL_MS;
  const now = o.now ?? Date.now;
  const sleep =
    o.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    name: 'task logs',
    description:
      'Show recorded, redacted task logs; --follow streams JSON Lines',
    args: ['<id>'],
    options: [
      {
        flags: '--data-dir <dir>',
        description:
          'Daemon data directory (default: $CUSR_DATA_DIR or ~/.cusr)',
      },
      {
        flags: '--after <cursor>',
        description: 'Show records after this cursor (default: 0)',
      },
      { flags: '--limit <n>', description: 'Page size (maximum: 200)' },
      {
        flags: '--follow',
        description:
          'Stream logs until the task ends or the one-hour session limit is reached',
      },
    ],
    async run(values, json, io) {
      const after = Number(values['after'] ?? 0);
      const limit =
        values['limit'] === undefined ? undefined : Number(values['limit']);
      if (
        !Number.isInteger(after) ||
        after < 0 ||
        (limit !== undefined && !Number.isInteger(limit))
      )
        return print(
          errorEnvelope({
            code: 'invalid_arguments',
            message: '--after and --limit must be integers',
            details: {},
            request_id: null,
          }),
          json,
          io,
        );
      const dataDir = resolveDataDir(values['dataDir']);
      const token = readClientToken(dataDir);
      if (!token.ok)
        return print(
          errorEnvelope({
            code: 'token_unavailable',
            message: token.error.message,
            details: {},
            request_id: null,
          }),
          json,
          io,
        );
      const fetch = (cursor: number) =>
        callDaemon({
          socketPath: join(dataDir, CONTROL_SOCKET),
          token: token.value,
          method: 'POST',
          path: '/v1/query',
          body: {
            kind: 'task_logs',
            task_id: values['id'],
            after: cursor,
            ...(limit === undefined ? {} : { limit }),
          },
        });
      if (values['follow'] === undefined) {
        const r = await fetch(after);
        return print(
          r.ok
            ? r.value.envelope
            : errorEnvelope({
                code: 'daemon_unreachable',
                message: r.error.message,
                details: { cursor: after },
                request_id: null,
              }),
          json,
          io,
        );
      }
      const started = now();
      let cursor = after;
      for (;;) {
        const r = await fetch(cursor);
        if (!r.ok) {
          io.stderr(
            `cusr: ${r.error.message}; resume with --after ${cursor}\n`,
          );
          return ExitCode.connection;
        }
        const { envelope } = r.value;
        if (!envelope.ok) {
          if (cursor === after) return print(envelope, json, io);
          io.stderr(
            `cusr: ${envelope.error.code}: ${envelope.error.message}; resume with --after ${cursor}\n`,
          );
          return exitCodeFor(envelope);
        }
        const page = envelope.data as Page;
        for (const rec of page.records) io.stdout(`${JSON.stringify(rec)}\n`);
        cursor = page.next_cursor;
        if (page.complete) {
          io.stdout(`${JSON.stringify({ end: 'task_finished', cursor })}\n`);
          return ExitCode.ok;
        }
        if (now() - started >= maxSession) {
          io.stdout(`${JSON.stringify({ end: 'session_limit', cursor })}\n`);
          return ExitCode.ok;
        }
        if (page.records.length === 0) await sleep(pollMs);
      }
    },
  };
}

export const logsCommand: CliCommand = logsCommandWith();
