/**
 * Follow committed records as JSON Lines until task completion or the session limit. Return a cursor
 * to resume interrupted sessions. Records go to stdout; connection diagnostics go to stderr.
 */
import { join } from 'node:path';
import { callDaemon, readClientActor, resolveDataDir } from './client.ts';
import { exitCodeFor } from './errors.ts';
import { CONTROL_SOCKET, ExitCode } from './output.ts';
import type { CliCommand } from './program.ts';
import { print } from './tasks.ts';
import { errorEnvelope } from './output.ts';
import { logRecordSummary, logsSummary, LOG_TEXT_LIMIT } from './summary.ts';

export const FOLLOW_SESSION_MS = 3_600_000;
/** A snapshot without --limit; --follow keeps the daemon's larger page since it streams anyway. */
export const LOGS_DEFAULT_LIMIT = 20;
const FOLLOW_POLL_MS = 1_000;

type Page = {
  readonly records: readonly {
    readonly cursor: number;
    readonly operation_id: string;
    readonly attempt_id: string | null;
    readonly gap?: { readonly records: number; readonly reason: string };
  }[];
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
    o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    name: 'task logs',
    description: 'Show recorded, redacted task logs; --follow streams JSON Lines',
    help: `Continue a snapshot with --after set to next_cursor until complete is true.

Examples:
  cusr task logs 019a0000-0000-7000-8000-000000000001 --json
  cusr task logs 019a0000-0000-7000-8000-000000000001 --after 20 --limit 200 --json
  cusr task logs 019a0000-0000-7000-8000-000000000001 --tail
  cusr task logs 019a0000-0000-7000-8000-000000000001 --follow --tail`,
    args: ['<id>'],
    options: [
      {
        flags: '--data-dir <dir>',
        description: 'Daemon data directory (default: $CUSR_DATA_DIR or ~/.cusr)',
      },
      {
        flags: '--after <cursor>',
        description: 'Show records after this cursor (default: 0)',
      },
      {
        flags: '--limit <n>',
        description: `Page size, at most 200 (default: ${LOGS_DEFAULT_LIMIT} without --follow)`,
      },
      {
        flags: '--tail',
        description:
          'Start from the last page instead of --after; with --follow, stream from there',
      },
      {
        flags: '--attempt <id>',
        description: 'Filter logs by attempt ID.',
      },
      {
        flags: '--full',
        description: `Print records as recorded; by default strings longer than ${LOG_TEXT_LIMIT} characters are cut`,
      },
      {
        flags: '--follow',
        description: 'Stream logs until the task ends or the one-hour session limit is reached',
      },
    ],
    async run(values, json, io) {
      const full = values['full'] !== undefined;
      const tail = values['tail'] !== undefined;
      if (tail && values['after'] !== undefined)
        return print(
          errorEnvelope({
            code: 'invalid_arguments',
            message: '--tail and --after cannot be used together',
            details: {},
            request_id: null,
          }),
          json,
          io,
        );
      const after = Number(values['after'] ?? 0);
      const limit =
        values['limit'] === undefined
          ? values['follow'] === undefined
            ? LOGS_DEFAULT_LIMIT
            : undefined
          : Number(values['limit']);
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
      const actor = readClientActor();
      if (!actor.ok)
        return print(
          errorEnvelope({
            code: 'actor_invalid',
            message: actor.error.message,
            details: {},
            request_id: null,
          }),
          json,
          io,
        );
      const fetch = (cursor: number, fromEnd = false) =>
        callDaemon({
          socketPath: join(dataDir, CONTROL_SOCKET),
          actor: actor.value,
          method: 'POST',
          path: '/v1/query',
          body: {
            kind: 'task_logs',
            task_id: values['id'],
            after: cursor,
            ...(fromEnd ? { tail: true } : {}),
            ...(limit === undefined ? {} : { limit }),
            ...(values['attempt'] === undefined ? {} : { attempt_id: values['attempt'] }),
          },
        });
      if (values['follow'] === undefined) {
        const r = await fetch(after, tail);
        if (!r.ok)
          return print(
            errorEnvelope({
              code: 'daemon_unreachable',
              message: r.error.message,
              details: { cursor: after },
              request_id: null,
            }),
            json,
            io,
          );
        const { envelope } = r.value;
        return print(
          envelope.ok && !full ? { ...envelope, data: logsSummary(envelope.data) } : envelope,
          json,
          io,
        );
      }
      const started = now();
      let cursor = after;
      let lastDiagnostic: string | null = null;
      let fromEnd = tail;
      for (;;) {
        const r = await fetch(cursor, fromEnd);
        fromEnd = false;
        if (!r.ok) {
          io.stderr(`cusr: ${r.error.message}; resume with --after ${cursor}\n`);
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
        let diagnostic: string | null = null;
        for (const rec of page.records) {
          if (rec.gap?.records === 0) {
            diagnostic = JSON.stringify([rec.operation_id, rec.attempt_id, rec.gap.reason]);
            if (diagnostic !== lastDiagnostic)
              io.stdout(
                `${JSON.stringify({
                  diagnostic: 'log_gap',
                  cursor: rec.cursor,
                  operation_id: rec.operation_id,
                  attempt_id: rec.attempt_id,
                  reason: rec.gap.reason,
                })}\n`,
              );
          } else io.stdout(`${JSON.stringify(full ? rec : logRecordSummary(rec))}\n`);
        }
        lastDiagnostic = diagnostic;
        const advanced = page.next_cursor > cursor;
        cursor = page.next_cursor;
        if (page.complete) {
          io.stdout(`${JSON.stringify({ end: 'task_finished', cursor })}\n`);
          return ExitCode.ok;
        }
        if (now() - started >= maxSession) {
          io.stdout(`${JSON.stringify({ end: 'session_limit', cursor })}\n`);
          return ExitCode.ok;
        }
        if (!advanced) await sleep(pollMs);
      }
    },
  };
}

export const logsCommand: CliCommand = logsCommandWith();
