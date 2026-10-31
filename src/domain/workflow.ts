import { z } from 'zod';

/** The engine interprets step kinds rather than step names. */
export const STEP_KINDS = [
  'triage',
  'prepare',
  'agent',
  'gate',
  'review',
  'action',
  'wait',
  'classify',
  'approval',
  'complete',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const OUTCOMES_BY_KIND = {
  triage: ['ok'],
  prepare: ['ok'],
  agent: ['done', 'needs_input', 'needs_context', 'blocked'],
  gate: ['pass', 'fail'],
  review: ['approve', 'request_changes'],
  action: ['ok'],
  wait: ['pass', 'fail', 'timeout'],
  classify: ['flaky_or_infra', 'autofix', 'code'],
  approval: ['approved', 'rejected'],
  complete: [],
} as const satisfies Record<StepKind, readonly string[]>;

export type Outcome = (typeof OUTCOMES_BY_KIND)[StepKind][number];

/**
 * Special targets: ask waits for input and reruns the step; escalate waits with loop_exhausted;
 * retry creates an attempt at the same step; fail terminates; cancel starts cancellation.
 */
export const SPECIAL_TARGETS = [
  'ask',
  'escalate',
  'retry',
  'fail',
  'cancel',
] as const;
export type SpecialTarget = (typeof SPECIAL_TARGETS)[number];

export function isSpecialTarget(t: string): t is SpecialTarget {
  return (SPECIAL_TARGETS as readonly string[]).includes(t);
}

export const ACTIONS = [
  'git.publish',
  'github.create_pr',
  'github.rerun_failed',
  'github.merge',
] as const;
export type ActionName = (typeof ACTIONS)[number];

export const WAIT_FOR = ['github.checks'] as const;

export const PREDICATE_KEYS = [
  'flag',
  'size',
  'label',
  'task_type',
  'attempt_gte',
  'target_branch',
] as const;
export type PredicateKey = (typeof PREDICATE_KEYS)[number];

const stringOrList = z.union([z.string(), z.array(z.string()).min(1)]);

export const PredicateSchema = z
  .object({
    flag: stringOrList.optional(),
    size: stringOrList.optional(),
    label: stringOrList.optional(),
    task_type: stringOrList.optional(),
    attempt_gte: z.number().int().positive().optional(),
    target_branch: stringOrList.optional(),
  })
  .strict();
export type Predicate = z.infer<typeof PredicateSchema>;

export const DECISION_MODES = [
  'human',
  'agent',
  'agent_if_confident',
  'agent_review',
] as const;
export type DecisionMode = (typeof DECISION_MODES)[number];

/** The last five decision points always require a human decision. */
export const DECISION_POINTS = [
  'agent_question',
  'missing_acceptance',
  'source_drift',
  'escalation_approval',
  'loop_exhausted',
  'merge_to_main',
  'policy_change',
  'budget_increase',
  'secret_handling',
  'data_deletion',
] as const;
export type DecisionPoint = (typeof DECISION_POINTS)[number];

export const FORBIDDEN_DECIDER_POINTS: readonly DecisionPoint[] = [
  'merge_to_main',
  'policy_change',
  'budget_increase',
  'secret_handling',
  'data_deletion',
];

export const StepSchema = z
  .object({
    kind: z.enum(STEP_KINDS),
    role: z.string().min(1).optional(),
    run: z.array(z.string().min(1)).optional(),
    required: z.array(z.string().min(1)).optional(),
    action: z.enum(ACTIONS).optional(),
    for: z.enum(WAIT_FOR).optional(),
    rules: z.literal('ci_rules').optional(),
    poll: z.number().int().positive().optional(),
    timeout: z.number().int().positive().optional(),
    uses: z.array(z.string().min(1)).optional(),
    max_visits: z.number().int().positive().optional(),
    max_rung: z.number().int().nonnegative().optional(),
    on_exhausted: z.string().min(1).optional(),
    when: PredicateSchema.optional(),
    skip_when: PredicateSchema.optional(),
    auto_when: PredicateSchema.optional(),
    next: z.record(z.string(), z.string().min(1)).default({}),
  })
  .strict();
export type StepDef = z.infer<typeof StepSchema>;

export const WorkflowSchema = z
  .object({
    start: z.string().min(1),
    steps: z.record(z.string(), StepSchema),
    decisions: z
      .partialRecord(z.enum(DECISION_POINTS), z.enum(DECISION_MODES))
      .default({}),
  })
  .strict();
export type Workflow = z.infer<typeof WorkflowSchema>;

export function isAgentStep(step: StepDef): boolean {
  return step.kind === 'agent' || step.kind === 'review';
}

export function outcomesOf(kind: StepKind): readonly string[] {
  return OUTCOMES_BY_KIND[kind];
}

export type PredicateFacts = {
  labels: readonly string[];
  size: string | null;
  task_type: string;
  attempt: number;
  target_branch: string;
};

function anyOf(v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v];
}

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  return re.test(value);
}

export function branchMatches(pattern: string, branch: string): boolean {
  return globMatch(pattern, branch);
}

/** All declared keys must match (AND); a list matches any one of its values (OR). */
export function evalPredicate(p: Predicate, f: PredicateFacts): boolean {
  if (p.flag !== undefined && !anyOf(p.flag).some((x) => f.labels.includes(x)))
    return false;
  if (
    p.label !== undefined &&
    !anyOf(p.label).some((x) => f.labels.includes(x))
  )
    return false;
  if (
    p.size !== undefined &&
    (f.size === null || !anyOf(p.size).includes(f.size))
  )
    return false;
  if (p.task_type !== undefined && !anyOf(p.task_type).includes(f.task_type))
    return false;
  if (p.attempt_gte !== undefined && f.attempt < p.attempt_gte) return false;
  if (
    p.target_branch !== undefined &&
    !anyOf(p.target_branch).some((g) => globMatch(g, f.target_branch))
  )
    return false;
  return true;
}
