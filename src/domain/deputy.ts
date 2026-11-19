/** Deputy turns (007, data-model.md): daemon records outside the event log, so they move no version. */
import { z } from 'zod';

/** The actor of commands a deputy turn sends, and so of the answers it gives (FR-050). */
export const DEPUTY_ACTOR = 'deputy';

/** Who ends a task whose every action ran out on its failure signature (FR-044). */
export const LOOP_GUARD_ACTOR = 'system:loop-guard';

/** The step a deputy run's records show under in a task's log: a turn is no step of the task. */
export const DEPUTY_STEP = 'deputy';

/** How a log gap starts while a deputy run waits for the output before it to settle. */
export const DEPUTY_WAITS = 'deputy output waits for the output before it';

/** How a log gap starts while the output before a deputy run cannot be read yet, and may be once retried. */
export const DEPUTY_RETRY = 'deputy output waits until the output before it can be read';

/** How a log gap starts while a running deputy run holds back the output after it. */
export const DEPUTY_HOLDS = 'a deputy turn is running; later output waits for it';

/**
 * What the command ledger keeps with a deputy's `task fail` sent once every action ran out on the
 * failure signature (FR-075): retrying that unit is then a scope amendment, as after the loop guard.
 * `TaskFailed` clears the wait, so this cannot be read back from the ended task.
 */
export type SpentFail = { readonly exhausted_signature: string };

export function isSpentFail(v: unknown): v is SpentFail {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Partial<SpentFail>).exhausted_signature === 'string'
  );
}

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

/** A command a turn sent, from the command ledger (FR-022). */
export type TurnCommand = {
  readonly request_id: string;
  readonly kind: string;
  readonly task_id: string | null;
  readonly status: string;
  readonly reason: string | null;
  readonly admitted_at: number;
};

/** A turn that gave its incident to the owner, as the owner's views show it (FR-023). */
export type HandedOffView = {
  readonly turn_id: string;
  readonly state: 'handed_off' | 'aborted';
  readonly handoff_reason: HandoffReason | null;
  readonly handoff: Handoff | null;
  readonly final_message: string | null;
  /** The commands of a turn that ended without a handoff (FR-022). */
  readonly commands: readonly TurnCommand[];
};
