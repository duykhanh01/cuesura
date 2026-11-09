/** Apart from process-tag.ts so the CLI's worker guard can read them without its zod imports. */
export const OPERATION_ENV = 'CUSR_OPERATION_ID';
/** Set in the environment of every harness attempt (worker agent) the runner launches. */
export const ATTEMPT_ENV = 'CUSR_ATTEMPT_ID';
