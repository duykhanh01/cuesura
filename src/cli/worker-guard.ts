/**
 * Workers must not call `cusr` (#185). A harness attempt carries `CUSR_ATTEMPT_ID` and every process the
 * daemon spawns for an operation (gate, setup, Git) carries `CUSR_OPERATION_ID`, so either one means the
 * caller runs on the daemon's behalf. Like the tags themselves this authenticates nothing: a same-UID
 * process that clears them gets through. It only stops an agent that follows the rules from calling by
 * mistake.
 */
import { ATTEMPT_ENV, DEPUTY_TURN_ENV, OPERATION_ENV } from '../runner/process-env.ts';
import { ExitCode, errorEnvelope, renderEnvelope } from './output.ts';
import type { CliIo } from './program.ts';

export const WORKER_REFUSED = 'worker_refused';

const MARKERS = [ATTEMPT_ENV, OPERATION_ENV] as const;

/** The owner's hook settings can fire inside a worker; failing or printing there would reach the agent. */
const QUIET = ['hook', 'session-start'];
/** A deputy turn is not the owner's assistant session: it must not register, wait or take the lease. */
const DEPUTY_QUIET = [...QUIET, 'register', 'wait'];

function isAssistantCommand(argv: readonly string[], names: readonly string[]): boolean {
  const i = argv.indexOf('assistant');
  return i >= 0 && names.includes(argv[i + 1] ?? '');
}

/** The exit code when this invocation comes from a worker, or null when it may go on. */
export function refuseWorker(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
): number | null {
  const marker = MARKERS.find((k) => env[k] !== undefined);
  // The deputy acts through cusr (FR-050); only the assistant's own session commands are silenced.
  if (marker === undefined && env[DEPUTY_TURN_ENV] !== undefined)
    return isAssistantCommand(argv, DEPUTY_QUIET) ? ExitCode.ok : null;
  if (marker === undefined) return null;
  if (isAssistantCommand(argv, QUIET)) return ExitCode.ok;
  const message = `cusr cannot be called from a Cuesura worker or operation (${marker} is set)`;
  if (argv.includes('--json'))
    io.stdout(
      renderEnvelope(
        errorEnvelope({
          code: WORKER_REFUSED,
          message,
          details: { variable: marker },
          request_id: null,
        }),
      ),
    );
  else io.stderr(`cusr: ${message}\n`);
  return ExitCode.forbidden;
}
