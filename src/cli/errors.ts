/**
 * Stable mapping from an error code to the CLI exit code and the HTTP status of the control socket
 * (FR-028, contracts/cli-daemon.md). A task's status never decides either one; only the outcome of the
 * command does. An engine refusal reaches this table only through `application/engine-verdict.ts`, so
 * its raw reject codes never do. Any code not listed (e.g. `response_too_large`) is exit 1.
 */
import { ExitCode, type Envelope } from './output.ts';

const FORBIDDEN = ['unauthenticated', 'forbidden', 'worker_refused'];
const MISSING = [
  'not_found',
  'task_not_found',
  'gate_not_found',
  'question_not_found',
  'approval_not_found',
  'request_not_found',
];
const USAGE = [
  'invalid_arguments',
  'invalid_command',
  'invalid_request',
  'unsupported_feature',
  'not_available',
  'body_too_large',
  'actor_invalid',
];
/** The request was understood, but the task's current state or version does not allow it. */
const CONFLICT = [
  'conflict',
  'nothing_to_recheck',
  'rejected',
  'attention_held',
  'attention_superseded',
  'attention_not_registered',
];

export function exitCodeForError(code: string): ExitCode {
  if (FORBIDDEN.includes(code)) return ExitCode.forbidden;
  if (MISSING.includes(code)) return ExitCode.missing;
  if (USAGE.includes(code)) return ExitCode.usage;
  if (CONFLICT.includes(code)) return ExitCode.conflict;
  if (code === 'daemon_unreachable' || code === 'daemon_timeout') return ExitCode.connection;
  return ExitCode.failure;
}

export function exitCodeFor(envelope: Envelope): ExitCode {
  return envelope.ok ? ExitCode.ok : exitCodeForError(envelope.error.code);
}

/** HTTP status of a handler rejection; any code not listed is a processed request that failed. */
export function httpStatusFor(code: string): number {
  if (code === 'unauthenticated') return 401;
  if (code === 'forbidden') return 403;
  if (MISSING.includes(code)) return 404;
  if (code === 'invalid_arguments' || USAGE.includes(code)) return 400;
  if (CONFLICT.includes(code)) return 409;
  if (code === 'unhealthy') return 503;
  return 422;
}
