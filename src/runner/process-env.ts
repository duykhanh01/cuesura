/** Apart from process-tag.ts so the CLI's worker guard can read them without its zod imports. */
export const OPERATION_ENV = 'CUSR_OPERATION_ID';
/** Set in the environment of every harness attempt (worker agent) the runner launches. */
export const ATTEMPT_ENV = 'CUSR_ATTEMPT_ID';
/**
 * Set for a deputy turn instead of `CUSR_ATTEMPT_ID` (007, FR-050): the deputy acts through `cusr`, which
 * then calls as actor `deputy` in this turn.
 */
export const DEPUTY_TURN_ENV = 'CUSR_DEPUTY_TURN';
