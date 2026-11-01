/**
 * The interface's only way to the daemon (FR-003, FR-036). It connects exactly as a subcommand does: same
 * data dir, same token file, same socket. The token is read for every call, so one that was fixed is picked
 * up by the next retry and nothing but this module ever holds it.
 */
import { join } from 'node:path';
import type { z } from 'zod';
import {
  callDaemon,
  readClientToken,
  resolveDataDir,
  type CallOptions,
} from '../../cli/client.ts';
import { CONTROL_SOCKET, isEnvelope, type Envelope } from '../../cli/output.ts';
import { err, ok, type Result } from '../../shared/result.ts';
import { sanitize, type SafeText } from '../terminal/safe-text.ts';
import {
  BoardSchema,
  HealthDataSchema,
  ProjectListSchema,
  RequestShowSchema,
  RunOptionsSchema,
  TaskContentSchema,
  TaskExplainSchema,
  TaskHistorySchema,
  TaskLogsSchema,
  TaskProgressSchema,
  TaskShowSchema,
  type BoardReply,
  type Health,
  type ProjectList,
  type RequestShow,
  type RunOptions,
  type TaskContent,
  type TaskExplain,
  type TaskHistory,
  type TaskLogs,
  type TaskProgress,
  type TaskShow,
} from './schemas.ts';

/**
 * Why a call failed. `connection` and `timeout` may pass by themselves. `token`, `unauthenticated` and
 * `incompatible` will not, so retrying them is pointless. `rejected` is the daemon's answer to this request.
 */
export type PortError =
  | { readonly kind: 'connection' | 'timeout'; readonly message: SafeText }
  | {
      readonly kind: 'token' | 'unauthenticated' | 'incompatible';
      readonly message: SafeText;
    }
  | {
      readonly kind: 'rejected';
      readonly code: string;
      readonly message: SafeText;
    };

export type PortResult<T> = Result<T, PortError>;

export type BoardQuery = {
  readonly project?: string;
  readonly status?: string;
  readonly scope?: 'active' | 'terminal' | 'all';
  readonly limit?: number;
  readonly cursor?: string;
  readonly if_changed_since?: number;
};

export type DaemonPort = {
  /** Counts the times the token file was found to hold another token; the token itself stays in here. */
  credentialGeneration(): number;
  health(timeoutMs: number, signal?: AbortSignal): Promise<PortResult<Health>>;
  /** The token is read before this returns: `credentialGeneration()` right after says which token asked. */
  board(
    q: BoardQuery,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<PortResult<BoardReply>>;
  projects(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<PortResult<ProjectList>>;
  runOptions(
    taskId: string,
    timeoutMs: number,
  ): Promise<PortResult<RunOptions>>;
  content(taskId: string, timeoutMs: number): Promise<PortResult<TaskContent>>;
  progress(
    taskId: string,
    timeoutMs: number,
  ): Promise<PortResult<TaskProgress>>;
  show(taskId: string, timeoutMs: number): Promise<PortResult<TaskShow>>;
  explain(taskId: string, timeoutMs: number): Promise<PortResult<TaskExplain>>;
  history(
    taskId: string,
    after: number,
    timeoutMs: number,
  ): Promise<PortResult<TaskHistory>>;
  logs(
    q: { taskId: string; after: number; attemptId?: string },
    timeoutMs: number,
  ): Promise<PortResult<TaskLogs>>;
  requestShow(id: string, timeoutMs: number): Promise<PortResult<RequestShow>>;
};

export type PortDeps = {
  readonly dataDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly call?: typeof callDaemon;
};

/** A daemon that lacks a query is older than this interface, like one that answers in another shape. */
const INCOMPATIBLE_CODES = ['not_available'];

const incompatible = (message: string): PortError => ({
  kind: 'incompatible',
  message: sanitize(message),
});

function fromEnvelopeError(e: { code: string; message: string }): PortError {
  if (e.code === 'unauthenticated')
    return { kind: 'unauthenticated', message: sanitize(e.message) };
  if (INCOMPATIBLE_CODES.includes(e.code)) return incompatible(e.message);
  return { kind: 'rejected', code: e.code, message: sanitize(e.message) };
}

export function createDaemonPort(deps: PortDeps = {}): DaemonPort {
  const env = deps.env ?? process.env;
  const call = deps.call ?? callDaemon;
  const dataDir = resolveDataDir(deps.dataDir, env);

  let lastToken: string | null = null;
  let generation = 0;
  /** The generation of the latest board request; a watermark means nothing to another token (R-02). */
  let boardGeneration = 0;

  const readToken = (): ReturnType<typeof readClientToken> => {
    const token = readClientToken(dataDir, env);
    if (token.ok) {
      if (lastToken !== null && lastToken !== token.value) generation += 1;
      lastToken = token.value;
    }
    return token;
  };

  const send = async (
    opts: Pick<
      CallOptions,
      'method' | 'path' | 'body' | 'timeoutMs' | 'signal'
    >,
    token: ReturnType<typeof readClientToken> = readToken(),
  ): Promise<PortResult<Envelope>> => {
    if (!token.ok)
      return err({ kind: 'token', message: sanitize(token.error.message) });
    const r = await call({
      socketPath: join(dataDir, CONTROL_SOCKET),
      token: token.value,
      ...opts,
    });
    if (r.ok)
      return isEnvelope(r.value.envelope)
        ? ok(r.value.envelope)
        : err(incompatible("The daemon's response is not a result envelope"));
    const message = sanitize(r.error.message);
    switch (r.error.code) {
      case 'timeout':
        return err({ kind: 'timeout', message });
      case 'protocol':
        return err({ kind: 'incompatible', message });
      case 'token':
        return err({ kind: 'token', message });
      default:
        return err({ kind: 'connection', message });
    }
  };

  const parsed = <T extends z.ZodType>(
    schema: T,
    data: unknown,
    what: string,
  ): PortResult<z.output<T>> => {
    const r = schema.safeParse(data);
    return r.success
      ? ok(r.data)
      : err(
          incompatible(
            `The daemon's ${what} response has a shape this cusr does not understand`,
          ),
        );
  };

  const query = async <T extends z.ZodType>(
    schema: T,
    body: Record<string, unknown> & { kind: string },
    timeoutMs: number,
    signal?: AbortSignal,
    token: ReturnType<typeof readClientToken> = readToken(),
  ): Promise<PortResult<z.output<T>>> => {
    const r = await send(
      {
        method: 'POST',
        path: '/v1/query',
        body,
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      },
      token,
    );
    if (!r.ok) return r;
    return r.value.ok
      ? parsed(schema, r.value.data, body.kind)
      : err(fromEnvelopeError(r.value.error));
  };

  const taskQuery =
    <T extends z.ZodType>(schema: T, kind: string) =>
    (task_id: string, timeoutMs: number) =>
      query(schema, { kind, task_id }, timeoutMs);

  return {
    credentialGeneration: () => generation,
    async health(timeoutMs, signal) {
      const r = await send({
        method: 'GET',
        path: '/v1/health',
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!r.ok) return r;
      const envelope = r.value;
      // An unhealthy daemon is a reachable one: 503 carries the same facts plus the reason.
      if (!envelope.ok && envelope.error.code !== 'unhealthy')
        return err(fromEnvelopeError(envelope.error));
      const data = parsed(
        HealthDataSchema,
        envelope.ok ? envelope.data : envelope.error.details,
        'health',
      );
      if (!data.ok) return data;
      return ok({
        healthy: envelope.ok,
        reason: envelope.ok ? null : sanitize(envelope.error.message),
        slot: data.value.slot,
        queue_length: data.value.queue_length,
      });
    },
    board: (q, timeoutMs, signal) => {
      // One read of the token decides both the watermark and who asks, so the two cannot disagree.
      const token = readToken();
      const sameToken = boardGeneration === generation;
      boardGeneration = generation;
      const { if_changed_since: watermark, ...view } = q;
      return query(
        BoardSchema,
        {
          kind: 'task_board',
          ...view,
          ...(watermark === undefined || !sameToken
            ? {}
            : { if_changed_since: watermark }),
        },
        timeoutMs,
        signal,
        token,
      );
    },
    projects: (timeoutMs, signal) =>
      query(ProjectListSchema, { kind: 'project_list' }, timeoutMs, signal),
    runOptions: taskQuery(RunOptionsSchema, 'run_options'),
    content: taskQuery(TaskContentSchema, 'task_content'),
    progress: taskQuery(TaskProgressSchema, 'task_progress'),
    show: taskQuery(TaskShowSchema, 'task_show'),
    explain: taskQuery(TaskExplainSchema, 'task_explain'),
    history: (task_id, after, timeoutMs) =>
      query(
        TaskHistorySchema,
        { kind: 'task_history', task_id, after },
        timeoutMs,
      ),
    logs: ({ taskId, after, attemptId }, timeoutMs) =>
      query(
        TaskLogsSchema,
        {
          kind: 'task_logs',
          task_id: taskId,
          after,
          ...(attemptId === undefined ? {} : { attempt_id: attemptId }),
        },
        timeoutMs,
      ),
    requestShow: (request_id, timeoutMs) =>
      query(RequestShowSchema, { kind: 'request_show', request_id }, timeoutMs),
  };
}
