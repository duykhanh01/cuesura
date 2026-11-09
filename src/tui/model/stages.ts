/**
 * The steps of `software_dev` folded into the eight stages a person follows: triage, prepare, code, gates,
 * PR, review, CI, merge. The PR opens before the review (a draft in `full-review`), whose verdict is posted
 * on it and turns it ready. Fix and retry steps belong to the stage they repair, and the path never goes back:
 * the gates and the push that recheck a fix stay under the stage that asked for it. A loop shows as a stage run
 * more than once, and the task's `Now` says which step runs. Only presentation: the step states are the daemon's.
 */
import type { TaskStatus } from '../../domain/state.ts';
import type { TaskProgress } from '../client/schemas.ts';

export const STAGES = [
  'triage',
  'prepare',
  'code',
  'gates',
  'pr',
  'review',
  'ci',
  'merge',
] as const;
export type StageName = (typeof STAGES)[number];

export const STAGE_LABEL: Readonly<Record<StageName, string>> = {
  triage: 'triage',
  prepare: 'prepare',
  code: 'code',
  gates: 'gates',
  pr: 'PR',
  review: 'review',
  ci: 'CI',
  merge: 'merge',
};

const STAGE_OF: Readonly<Record<string, StageName>> = {
  triage: 'triage',
  prepare: 'prepare',
  scout: 'prepare',
  code: 'code',
  gates: 'gates',
  fix_gates: 'gates',
  review: 'review',
  fix_review: 'review',
  post_review: 'review',
  post_changes: 'review',
  fix_minor: 'review',
  minor_gates: 'review',
  ready: 'review',
  publish: 'pr',
  pr: 'pr',
  ci: 'ci',
  ci_triage: 'ci',
  rerun_ci: 'ci',
  ci_autofix: 'ci',
  ci_fix: 'ci',
  merge_gate: 'merge',
  merge: 'merge',
  complete: 'merge',
};

/**
 * `failed` and `stopped` mark where a task that ended badly was; `abandoned` is a stage it will now never
 * reach, so it does not read as one still to come.
 */
export type StageState =
  | 'done'
  | 'current'
  | 'todo'
  | 'skipped'
  | 'failed'
  | 'stopped'
  | 'abandoned';

export type Stage = {
  readonly name: StageName;
  readonly state: StageState;
  /** How many times the stage's own step ran; above 1 means a fix loop came back to it. */
  readonly runs: number;
};

export function stageOf(step: string | null): StageName | null {
  if (step === null || !Object.hasOwn(STAGE_OF, step)) return null;
  return STAGE_OF[step] ?? null;
}

const endState = (status: TaskStatus): StageState => (status === 'FAILED' ? 'failed' : 'stopped');

const ended = (status: TaskStatus): boolean => status === 'FAILED' || status === 'CANCELLED';

/** A stage still to come of a task that has ended will never run. */
const settle = (state: StageState, status: TaskStatus): StageState =>
  state === 'todo' && ended(status) ? 'abandoned' : state;

type Visits = Readonly<Record<string, number>>;

/**
 * Index of the stage to light. A stage entered again is a recheck, so the furthest stage reached stays lit. A
 * stage's first run stands: the graph without modes runs the review before the PR, which `STAGES` puts after.
 */
function stageNow(step: string | null, visits: Visits): number {
  const here = stageOf(step);
  if (here === null) return -1;
  const index = STAGES.indexOf(here);
  const ran = Object.entries(visits).filter(([, n]) => n > 0);
  if (!ran.some(([name, n]) => n > 1 && stageOf(name) === here)) return index;
  const reached = ran.map(([name]) => STAGES.indexOf(stageOf(name) ?? here));
  return Math.max(index, ...reached);
}

/**
 * Stages for a board row, which knows only its current step, what ran and its mode. `null` when the step belongs to a
 * workflow this does not know, so nothing is drawn rather than something made up.
 */
export function rowStages(row: {
  readonly status: TaskStatus;
  readonly step: string | null;
  readonly step_visits?: Visits | undefined;
  readonly mode: string | null;
}): readonly Stage[] | null {
  const skip = (name: StageName): boolean => name === 'review' && row.mode === 'direct-pr';
  if (row.step !== null && stageOf(row.step) === null) return null;
  const here = stageNow(row.step, row.step_visits ?? {});
  const terminal = ended(row.status) ? endState(row.status) : null;
  return STAGES.map((name, i) => {
    let state: StageState;
    if (skip(name)) state = 'skipped';
    else if (row.status === 'DONE') state = 'done';
    else if (here < 0) state = 'todo';
    else if (i < here) state = 'done';
    else if (i === here) state = terminal ?? 'current';
    else state = 'todo';
    return { name, state: settle(state, row.status), runs: 0 };
  });
}

type Step = NonNullable<TaskProgress['steps']>[number];

/**
 * Stages from the daemon's step list. `null` for a workflow with steps this does not know.
 */
export function progressStages(
  steps: readonly Step[],
  status: TaskStatus,
): readonly Stage[] | null {
  const byStage = new Map<StageName, Step[]>();
  for (const step of steps) {
    const name = stageOf(step.name);
    if (name === null) return null;
    byStage.set(name, [...(byStage.get(name) ?? []), step]);
  }
  const visits = Object.fromEntries(steps.map((s) => [s.name, s.visits]));
  const current = stageNow(steps.find((s) => s.state === 'current')?.name ?? null, visits);
  return STAGES.map((name, i) => {
    const members = byStage.get(name) ?? [];
    const own = members.find((s) => s.name === name) ?? members[0];
    const runs = own?.visits ?? 0;
    let state: StageState;
    if (members.length === 0 || members.every((s) => s.state === 'not_required')) state = 'skipped';
    // A finished task still names its last step (`complete`); nothing of a DONE task is under way.
    else if (status === 'DONE') state = 'done';
    else if (i === current) state = ended(status) ? endState(status) : 'current';
    else if (current >= 0 && i > current) state = 'todo';
    else if (members.some((s) => s.visits > 0)) state = 'done';
    else state = 'todo';
    return { name, state: settle(state, status), runs };
  });
}
