/**
 * Goals (007, R-21): the second aggregate of the event log. A goal's events carry `stream = 'goal'` and the
 * goal ID in `task_id`; a task outside any planned goal is read as its own implicit goal (FR-070, FR-123).
 */
import { z } from 'zod';
import { RunProposalSchema } from './run-config.ts';

/** Same bound as a task's declared scope (`SCOPE_ENTRIES_MAX`). */
export const PLAN_SCOPE_MAX = 100;
export const PLAN_UNITS_MAX = 50;
export const UNIT_KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;

const Text = z.string().min(1).max(4_096);
const LongText = z.string().max(65_536);
const ScopeList = z.array(z.string().min(1).max(512)).max(PLAN_SCOPE_MAX);

export const PlanUnitSchema = z
  .object({
    key: z.string().regex(UNIT_KEY),
    title: z.string().min(1).max(512),
    /** What the unit does for the user; frozen once confirmed (a change is a scope amendment). */
    description: LongText,
    /** How to do it; the deputy may change it as an execution amendment. */
    instructions: LongText.default(''),
    acceptance: z.array(Text).min(1).max(100),
    scope: ScopeList.optional(),
    depends_on: z.array(z.string().regex(UNIT_KEY)).max(PLAN_UNITS_MAX).default([]),
    run_config: RunProposalSchema,
  })
  .strict();
export type PlanUnit = z.infer<typeof PlanUnitSchema>;

/** contracts/goal.md#kế-hoạch-planschema. */
export const PlanSchema = z
  .object({
    schema_version: z.literal(1),
    summary: z.string().min(1).max(4_096),
    scope: ScopeList,
    non_goals: z.array(Text).max(100).default([]),
    units: z.array(PlanUnitSchema).min(1).max(PLAN_UNITS_MAX),
  })
  .strict();
export type Plan = z.infer<typeof PlanSchema>;

export const GOAL_STATUSES = [
  'planning',
  'awaiting_confirm',
  'running',
  'amendment_pending',
  'replan',
  'done',
  'failed',
  'cancelled',
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const GOAL_TERMINAL: readonly GoalStatus[] = ['done', 'failed', 'cancelled'];
export const isGoalTerminal = (s: GoalStatus): boolean => GOAL_TERMINAL.includes(s);

export const AmendmentKindSchema = z.enum(['execution', 'scope']);
export type AmendmentKind = z.infer<typeof AmendmentKindSchema>;

/** FR-063: what a ledger entry is, from who wrote it; never declared by the caller. */
export type NoteKind = 'directive' | 'observation' | 'event';

export const GoalHintsSchema = z
  .object({
    agent: z.string().min(1).max(64).optional(),
    model: z.string().min(1).max(128).optional(),
    mode: z.string().min(1).max(64).optional(),
    single_task: z.boolean().optional(),
    note: z.string().max(4_096).optional(),
  })
  .strict();
export type GoalHints = z.infer<typeof GoalHintsSchema>;

export type PlanRecord = {
  readonly version: number;
  readonly hash: string;
  readonly by: string;
  readonly reason: string | null;
  readonly kind: 'proposed' | 'amended' | 'amendment_proposed';
  readonly at: number;
};

export type GoalNote = {
  readonly by: string;
  readonly kind: NoteKind;
  readonly text: string;
  readonly at: number;
};

export type PendingAmendment = {
  readonly plan: Plan;
  readonly plan_version: number;
  readonly plan_hash: string;
  readonly affected: readonly string[];
  readonly by: string;
  readonly reason: string | null;
};

export type GoalUnit = { task_id: string; previous: string[] };

export type GoalState = {
  id: string;
  project: string;
  status: GoalStatus;
  /** Always false for a stored goal: implicit goals are read from their task (`implicitGoal`). */
  implicit: boolean;
  version: number;
  base_branch: string;
  /** Verbatim, secrets masked. */
  request: string;
  hints: GoalHints;
  /** Requests replaced by `goal revise`, oldest first. */
  revisions: { request: string; by: string; at: number }[];
  plan: Plan | null;
  /** Bumped by every new plan and by `goal revise` (FR-058), so a plan built on an older read is stale. */
  plan_version: number;
  plan_hash: string | null;
  confirmed_plan_version: number | null;
  plans: PlanRecord[];
  pending_amendment: PendingAmendment | null;
  notes: GoalNote[];
  branch: string | null;
  units: Record<string, GoalUnit>;
  final_task_id: string | null;
  replan_reason: string | null;
  created_at: number;
  ended: { reason: string; by: string; at: number } | null;
};

export type GoalEventPayloads = {
  GoalAdded: {
    project: string;
    base_branch: string;
    request: string;
    hints: GoalHints;
    by: string;
    at: number;
  };
  GoalRevised: { request: string; by: string; at: number };
  GoalNoted: { text: string; kind: NoteKind; by: string; at: number };
  PlanProposed: {
    plan: Plan;
    plan_version: number;
    plan_hash: string;
    by: string;
    reason: string | null;
    at: number;
  };
  /** `units` names the task created for each unit this confirmation adds. */
  PlanConfirmed: {
    plan_version: number;
    plan_hash: string;
    by: string;
    units: Record<string, string>;
    at: number;
  };
  PlanAmended: {
    plan: Plan;
    plan_version: number;
    plan_hash: string;
    affected: string[];
    by: string;
    reason: string | null;
    at: number;
  };
  PlanAmendmentProposed: {
    plan: Plan;
    plan_version: number;
    plan_hash: string;
    affected: string[];
    by: string;
    reason: string | null;
    at: number;
  };
  GoalReplanNeeded: { reason: string; at: number };
  GoalCompleted: { at: number };
  GoalFailed: { reason: string; at: number };
  GoalCancelled: { reason: string; by: string; at: number };
};
export type GoalEventType = keyof GoalEventPayloads;
export const GOAL_EVENT_TYPES = [
  'GoalAdded',
  'GoalRevised',
  'GoalNoted',
  'PlanProposed',
  'PlanConfirmed',
  'PlanAmended',
  'PlanAmendmentProposed',
  'GoalReplanNeeded',
  'GoalCompleted',
  'GoalFailed',
  'GoalCancelled',
] as const satisfies readonly GoalEventType[];

export type GoalEventDraft = {
  [K in GoalEventType]: { type: K; actor: string; payload: GoalEventPayloads[K] };
}[GoalEventType];

export type GoalEvent = GoalEventDraft & {
  goal_id: string;
  seq: number;
  global_seq: number;
};

/** What a goal command or a daemon fact asks of the goal aggregate. */
export type GoalTrigger =
  | {
      kind: 'add';
      project: string;
      base_branch: string;
      request: string;
      hints: GoalHints;
    }
  | { kind: 'revise'; request: string }
  | { kind: 'note'; text: string; note_kind: NoteKind }
  | { kind: 'propose'; plan: Plan; plan_version: number; plan_hash: string }
  | {
      kind: 'amend';
      plan: Plan;
      plan_version: number;
      plan_hash: string;
      amendment: AmendmentKind;
      affected: string[];
    }
  | { kind: 'confirm'; plan_hash: string; units: Record<string, string> }
  | { kind: 'cancel'; reason: string }
  | { kind: 'replan'; reason: string }
  | { kind: 'complete' }
  | { kind: 'fail'; reason: string };

export type GoalEnvelope = {
  goal_id: string;
  dedup_key: string;
  now: number;
  actor: string;
  reason?: string | null;
  /**
   * What deduplicates the request: a command's hash from admission, so a request run again after a crash
   * matches whatever the handler derives the second time. Absent for daemon facts, which hash the envelope.
   */
  request_hash?: string;
  /** The goal version the caller read; absent for daemon facts and `add`. */
  expected_version?: number;
  trigger: GoalTrigger;
};
