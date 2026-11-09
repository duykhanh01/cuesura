/**
 * The interface's only way to the daemon (FR-003, FR-036). It connects exactly as a subcommand does: same
 * data dir, same declared actor, same socket.
 */
import { join } from 'node:path';
import type { z } from 'zod';
import { callDaemon, readClientActor, resolveDataDir, type CallOptions } from '../../cli/client.ts';
import { CONTROL_SOCKET, isEnvelope, type Envelope } from '../../cli/output.ts';
import { err, ok, type Result } from '../../shared/result.ts';
import { sanitize, type SafeText } from '../terminal/safe-text.ts';
import {
  BoardSchema,
  CommandReplySchema,
  HealthDataSchema,
  InboxSchema,
  ProjectListSchema,
  QuestionShowSchema,
  RequestShowSchema,
  RunOptionsSchema,
  TaskContentSchema,
  TaskExplainSchema,
  TaskGateLogSchema,
  TaskGatesSchema,
  TaskHistorySchema,
  TaskLogsSchema,
  TaskProgressSchema,
  TaskShowSchema,
  type BoardReply,
  type CommandReply,
  type Health,
  type Inbox,
  type ProjectList,
  type QuestionShow,
  type RequestShow,
  type RunOptions,
  type TaskContent,
  type TaskExplain,
  type TaskGateLog,
  type TaskGates,
  type TaskHistory,
  type TaskLogs,
  type TaskProgress,
  type TaskShow,
} from './schemas.ts';

/**
 * Why a call failed. `connection` and `timeout` may pass by themselves. `actor`, `unauthenticated` and
 * `incompatible` will not, so retrying them is pointless. `rejected` is the daemon's answer to this request.
 */
export type PortError =
  | { readonly kind: 'connection' | 'timeout'; readonly message: SafeText }
  | {
      readonly kind: 'actor' | 'unauthenticated' | 'incompatible';
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
  readonly order?: 'oldest' | 'newest';
  readonly if_changed_since?: number;
};

export type DaemonPort = {
  health(timeoutMs: number, signal?: AbortSignal): Promise<PortResult<Health>>;
  board(q: BoardQuery, timeoutMs: number, signal?: AbortSignal): Promise<PortResult<BoardReply>>;
  projects(timeoutMs: number, signal?: AbortSignal): Promise<PortResult<ProjectList>>;
  runOptions(taskId: string, timeoutMs: number): Promise<PortResult<RunOptions>>;
  content(taskId: string, timeoutMs: number): Promise<PortResult<TaskContent>>;
  progress(taskId: string, timeoutMs: number): Promise<PortResult<TaskProgress>>;
  show(taskId: string, timeoutMs: number): Promise<PortResult<TaskShow>>;
  explain(taskId: string, timeoutMs: number): Promise<PortResult<TaskExplain>>;
  history(taskId: string, after: number, timeoutMs: number): Promise<PortResult<TaskHistory>>;
  logs(
    q: { taskId: string; after: number; attemptId?: string; limit?: number; tail?: boolean },
    timeoutMs: number,
  ): Promise<PortResult<TaskLogs>>;
  gates(taskId: string, timeoutMs: number): Promise<PortResult<TaskGates>>;
  gateLog(
    q: {
      taskId: string;
      gate: string;
      round: number;
      offset?: number;
      tail?: boolean;
      limit: number;
    },
    timeoutMs: number,
  ): Promise<PortResult<TaskGateLog>>;
  inbox(taskId: string, timeoutMs: number): Promise<PortResult<Inbox>>;
  question(questionId: string, timeoutMs: number): Promise<PortResult<QuestionShow>>;
  requestShow(id: string, timeoutMs: number): Promise<PortResult<RequestShow>>;
  /** The only write path; the body carries its own `request_id`, which a resend must keep. */
  command(
    body: Record<string, unknown> & { request_id: string },
    timeoutMs: number,
  ): Promise<PortResult<CommandReply>>;
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

  const actor = readClientActor(env);

  const send = async (
    opts: Pick<CallOptions, 'method' | 'path' | 'body' | 'timeoutMs' | 'signal'>,
  ): Promise<PortResult<Envelope>> => {
    if (!actor.ok) return err({ kind: 'actor', message: sanitize(actor.error.message) });
    const r = await call({
      socketPath: join(dataDir, CONTROL_SOCKET),
      actor: actor.value,
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
      case 'actor':
        return err({ kind: 'actor', message });
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
          incompatible(`The daemon's ${what} response has a shape this cusr does not understand`),
        );
  };

  const query = async <T extends z.ZodType>(
    schema: T,
    body: Record<string, unknown> & { kind: string },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<PortResult<z.output<T>>> => {
    const r = await send({
      method: 'POST',
      path: '/v1/query',
      body,
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
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
        slots: data.value.slots,
        concurrency: data.value.concurrency,
        queue_length: data.value.queue_length,
      });
    },
    board: (q, timeoutMs, signal) =>
      query(BoardSchema, { kind: 'task_board', ...q }, timeoutMs, signal),
    projects: (timeoutMs, signal) =>
      query(ProjectListSchema, { kind: 'project_list' }, timeoutMs, signal),
    runOptions: taskQuery(RunOptionsSchema, 'run_options'),
    content: taskQuery(TaskContentSchema, 'task_content'),
    progress: taskQuery(TaskProgressSchema, 'task_progress'),
    show: taskQuery(TaskShowSchema, 'task_show'),
    explain: taskQuery(TaskExplainSchema, 'task_explain'),
    history: (task_id, after, timeoutMs) =>
      query(TaskHistorySchema, { kind: 'task_history', task_id, after }, timeoutMs),
    logs: ({ taskId, after, attemptId, limit, tail }, timeoutMs) =>
      query(
        TaskLogsSchema,
        {
          kind: 'task_logs',
          task_id: taskId,
          after,
          ...(tail === true ? { tail } : {}),
          ...(attemptId === undefined ? {} : { attempt_id: attemptId }),
          ...(limit === undefined ? {} : { limit }),
        },
        timeoutMs,
      ),
    gates: taskQuery(TaskGatesSchema, 'task_gates'),
    gateLog: ({ taskId, gate, round, offset, tail, limit }, timeoutMs) =>
      query(
        TaskGateLogSchema,
        {
          kind: 'task_gate_log',
          task_id: taskId,
          gate,
          round,
          limit,
          ...(tail === true ? { tail } : {}),
          ...(offset === undefined ? {} : { offset }),
        },
        timeoutMs,
      ),
    inbox: (task_id, timeoutMs) => query(InboxSchema, { kind: 'inbox', task_id }, timeoutMs),
    question: (question_id, timeoutMs) =>
      query(QuestionShowSchema, { kind: 'question_show', question_id }, timeoutMs),
    requestShow: (request_id, timeoutMs) =>
      query(RequestShowSchema, { kind: 'request_show', request_id }, timeoutMs),
    async command(body, timeoutMs) {
      const r = await send({ method: 'POST', path: '/v1/command', body, timeoutMs });
      if (!r.ok) return r;
      return r.value.ok
        ? parsed(CommandReplySchema, r.value.data, String(body['kind']))
        : err(fromEnvelopeError(r.value.error));
    },
  };
}
