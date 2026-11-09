/**
 * Follow committed records as JSON Lines until the task ends, needs the user, the daemon stays away or
 * the session limit is reached. Every line carries `schema_version` and `type`, and the last one is an
 * `end` line with the cursor to resume from.
 */
import { join } from 'node:path';
import { callDaemon, clientErrorEnvelope, readClientActor, resolveDataDir } from './client.ts';
import { exitCodeFor } from './errors.ts';
import { CONTROL_SOCKET, ExitCode } from './output.ts';
import type { CliCommand } from './program.ts';
import { print } from './tasks.ts';
import { errorEnvelope } from './output.ts';
import { LOG_LIST_LIMIT, LOG_TEXT_LIMIT, logRecordSummary, logsSummary } from './summary.ts';

export const FOLLOW_SESSION_MS = 3_600_000;
/** A snapshot without --limit; --follow keeps the daemon's larger page since it streams anyway. */
export const LOGS_DEFAULT_LIMIT = 20;
const FOLLOW_POLL_MS = 1_000;
/** Long enough to ride out `systemctl restart cusrd`. */
export const FOLLOW_RECONNECT_MS = 15_000;
const LINE_VERSION = 1;

type Page = {
  readonly records: readonly {
    readonly cursor: number;
    readonly operation_id: string;
    readonly attempt_id: string | null;
    readonly gap?: { readonly records: number; readonly reason: string };
  }[];
  readonly next_cursor: number;
  readonly complete: boolean;
  readonly more?: boolean;
  /** Absent from an older daemon. */
  readonly state?: {
    readonly status: string;
    readonly wait_code: string | null;
    readonly needs_user: boolean;
  };
};

export type FollowOptions = {
  readonly maxSessionMs?: number;
  readonly pollMs?: number;
  readonly reconnectMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

export function logsCommandWith(o: FollowOptions = {}): CliCommand {
  const maxSession = o.maxSessionMs ?? FOLLOW_SESSION_MS;
  const pollMs = o.pollMs ?? FOLLOW_POLL_MS;
  const reconnectMs = o.reconnectMs ?? FOLLOW_RECONNECT_MS;
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
        description: `Print records as recorded; by default harness bookkeeping (IDs, signatures, usage) and empty fields are dropped, lists keep ${LOG_LIST_LIMIT} items and strings ${LOG_TEXT_LIMIT} characters`,
      },
      {
        flags: '--follow',
        description:
          'Stream logs until the task ends, needs the user, or the one-hour session limit is reached',
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
          return print(clientErrorEnvelope(dataDir, r.error, null, { cursor: after }), json, io);
        const { envelope } = r.value;
        return print(
          envelope.ok && !full ? { ...envelope, data: logsSummary(envelope.data) } : envelope,
          json,
          io,
        );
      }
      const line = (type: string, body: Record<string, unknown>): void =>
        io.stdout(`${JSON.stringify({ schema_version: LINE_VERSION, type, ...body })}\n`);
      const started = now();
      let cursor = after;
      let lastDiagnostic: string | null = null;
      let lastState: string | null = null;
      let fromEnd = tail;
      let unreachableSince: number | null = null;
      for (;;) {
        const r = await fetch(cursor, fromEnd);
        if (!r.ok) {
          const lost = r.error.code === 'connection' || r.error.code === 'timeout';
          unreachableSince ??= now();
          if (lost && now() - unreachableSince < reconnectMs) {
            await sleep(pollMs);
            continue;
          }
          line(
            'end',
            lost
              ? { end: 'daemon_unreachable', cursor }
              : { end: 'error', code: r.error.code, cursor },
          );
          io.stderr(`cusr: ${r.error.message}; resume with --after ${cursor}\n`);
          const failed = clientErrorEnvelope(dataDir, r.error, null);
          const guidance = failed.ok ? undefined : failed.error.details['guidance'];
          if (typeof guidance === 'string') io.stderr(`cusr: ${guidance}\n`);
          return ExitCode.connection;
        }
        unreachableSince = null;
        fromEnd = false;
        const { envelope } = r.value;
        if (!envelope.ok) {
          if (cursor === after) return print(envelope, json, io);
          line('end', { end: 'error', code: envelope.error.code, cursor });
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
              line('diagnostic', {
                diagnostic: 'log_gap',
                cursor: rec.cursor,
                operation_id: rec.operation_id,
                attempt_id: rec.attempt_id,
                reason: rec.gap.reason,
              });
          } else line('record', full ? rec : (logRecordSummary(rec) as Record<string, unknown>));
        }
        lastDiagnostic = diagnostic;
        const advanced = page.next_cursor > cursor;
        cursor = page.next_cursor;
        if (page.complete) {
          line('end', { end: 'task_finished', cursor });
          return ExitCode.ok;
        }
        const state = page.state;
        if (state !== undefined) {
          // Printed when the task enters or leaves a wait, not for every status it passes through.
          const key = JSON.stringify([state.wait_code, state.needs_user]);
          if (key !== (lastState ?? JSON.stringify([null, false])))
            line('state', { cursor, ...state });
          lastState = key;
          if (state.needs_user && page.more !== true) {
            line('end', { end: 'needs_user', wait_code: state.wait_code, cursor });
            return ExitCode.ok;
          }
        }
        if (now() - started >= maxSession) {
          line('end', { end: 'session_limit', cursor });
          return ExitCode.ok;
        }
        if (!advanced) await sleep(pollMs);
      }
    },
  };
}

export const logsCommand: CliCommand = logsCommandWith();
