/**
 * The steps of `software_dev` folded into the eight stages a person follows: triage, prepare, code, gates,
 * PR, review, CI, merge. The PR opens before the review (a draft in `full-review`), whose verdict is posted
 * on it and turns it ready. Fix and retry steps belong to the stage they repair, so a loop shows as a stage run
 * more than once instead of a list of side steps. Only presentation: the step states are the daemon's.
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

/** `failed` and `stopped` mark where a task that ended badly was. */
export type StageState = 'done' | 'current' | 'todo' | 'skipped' | 'failed' | 'stopped';

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

/**
 * Stages for a board row, which knows only its current step and mode. `null` when the step belongs to a
 * workflow this does not know, so nothing is drawn rather than something made up.
 */
export function rowStages(row: {
  readonly status: TaskStatus;
  readonly step: string | null;
  readonly mode: string | null;
}): readonly Stage[] | null {
  const skip = (name: StageName): boolean => name === 'review' && row.mode === 'direct-pr';
  const at = stageOf(row.step);
  if (row.step !== null && at === null) return null;
  const here = at === null ? -1 : STAGES.indexOf(at);
  const terminal =
    row.status === 'FAILED' || row.status === 'CANCELLED' ? endState(row.status) : null;
  return STAGES.map((name, i) => {
    let state: StageState;
    if (skip(name)) state = 'skipped';
    else if (row.status === 'DONE') state = 'done';
    else if (here < 0) state = 'todo';
    else if (i < here) state = 'done';
    else if (i === here) state = terminal ?? 'current';
    else state = 'todo';
    return { name, state, runs: 0 };
  });
}

type Step = NonNullable<TaskProgress['steps']>[number];

/**
 * Stages from the daemon's step list. A stage after the current one that already ran is shown as still to
 * come: the loop that went back will run it again. `null` for a workflow with steps this does not know.
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
  const current = STAGES.findIndex((n) =>
    (byStage.get(n) ?? []).some((s) => s.state === 'current'),
  );
  return STAGES.map((name, i) => {
    const members = byStage.get(name) ?? [];
    const own = members.find((s) => s.name === name) ?? members[0];
    const runs = own?.visits ?? 0;
    let state: StageState;
    if (members.length === 0 || members.every((s) => s.state === 'not_required')) state = 'skipped';
    // A finished task still names its last step (`complete`); nothing of a DONE task is under way.
    else if (status === 'DONE') state = 'done';
    else if (i === current)
      state = status === 'FAILED' || status === 'CANCELLED' ? endState(status) : 'current';
    else if (current >= 0 && i > current) state = 'todo';
    else if (members.some((s) => s.state === 'past')) state = 'done';
    else state = 'todo';
    return { name, state, runs };
  });
}
