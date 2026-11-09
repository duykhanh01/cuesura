/** Deputy turns (007, data-model.md): daemon records outside the event log, so they move no version. */
import { z } from 'zod';

export const TURN_KINDS = ['incident', 'question', 'plan'] as const;
export type TurnKind = (typeof TURN_KINDS)[number];

export const TURN_STATES = [
  'running',
  'retry_wait',
  'done',
  'handed_off',
  'aborted',
  'stopped',
] as const;
export type TurnState = (typeof TURN_STATES)[number];
export const LIVE_TURN_STATES: readonly TurnState[] = ['running', 'retry_wait'];
export type FinalTurnState = Exclude<TurnState, 'running' | 'retry_wait'>;

export const HANDOFF_REASONS = [
  'still_waiting',
  'auth',
  'refused',
  'capability',
  'no_harness',
  'infra_cap',
  'handover',
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

/** The cause table of FR-041, plus `none` for a turn that found nothing wrong. */
export const HANDOFF_CAUSES = [
  'model',
  'strategy',
  'review_dispute',
  'process',
  'limit',
  'environment',
  'spec',
  'none',
] as const;

const Text = z.string().min(1).max(4_096);

/** contracts/deputy-turn.md#bàn-giao; the last one of a turn wins. */
export const HandoffSchema = z
  .object({
    cause: z.enum(HANDOFF_CAUSES),
    decision: Text,
    ruled_out: z.array(z.object({ hypothesis: Text, why: Text }).strict()).max(32),
    next_look: Text.nullable(),
  })
  .strict();
export type Handoff = z.infer<typeof HandoffSchema>;

export type DeputyTurn = {
  readonly turn_id: string;
  readonly goal_id: string;
  /** Null for a `plan` turn. */
  readonly task_id: string | null;
  readonly kind: TurnKind;
  /** `task:revision:code:enteredSeq` (FR-020), or `goal:plan_version:reason` for a plan turn. */
  readonly incident: string | null;
  readonly signature: string | null;
  readonly harness: string;
  readonly session_ref: string | null;
  readonly attempt_id: string;
  readonly mode: 'interactive' | 'headless';
  readonly state: TurnState;
  readonly infra_failures: number;
  readonly retry_at: number | null;
  readonly handoff: Handoff | null;
  readonly final_message: string | null;
  readonly handoff_reason: HandoffReason | null;
  readonly context_bytes: number;
  readonly started_at: number;
  readonly ended_at: number | null;
};
