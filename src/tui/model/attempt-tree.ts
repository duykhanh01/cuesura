/**
 * The attempts of a task as the attempt chooser shows them: the build, then one round per review with the fixes
 * it asked for, then CI and merge. A fix that loops back to an earlier stage stays in the round or phase that
 * sent it back, and one step run several times in a row folds into a single row. Only presentation: the order
 * is the daemon's, oldest first.
 */
import type { TaskShow } from '../client/schemas.ts';
import { sanitize, type SafeText } from '../terminal/safe-text.ts';
import { stageOf, type StageName } from './stages.ts';

type Usage = TaskShow['provenance']['usage'][number];

export type Attempt = {
  readonly id: string;
  readonly step: SafeText;
  readonly binding: SafeText;
  /** `null`: the harness did not say. */
  readonly tokens: number | null;
};

/** One step run once or several times in a row. */
export type AttemptRun = {
  readonly key: string;
  readonly step: SafeText;
  readonly attempts: readonly Attempt[];
};

export type AttemptGroup = {
  readonly key: string;
  readonly title: string;
  /** The stage the progress column points at while the group is chosen. */
  readonly stage: StageName | null;
  readonly runs: readonly AttemptRun[];
};

// The pull request opens before the review in `full-review`, so it ranks below it.
const PHASE: Readonly<Record<StageName, number>> = {
  triage: 0,
  prepare: 0,
  code: 0,
  gates: 0,
  pr: 1,
  review: 2,
  ci: 3,
  merge: 4,
};
const PHASE_TITLE = ['Build', 'PR', 'Review', 'CI', 'Merge'] as const;

type Building = {
  key: string;
  title: string;
  stage: StageName | null;
  phase: number | null;
  runs: { key: string; step: SafeText; attempts: Attempt[] }[];
};

export function attemptGroups(usage: readonly Usage[]): readonly AttemptGroup[] {
  const groups: Building[] = [];
  let rounds = 0;
  for (const u of usage) {
    const attempt: Attempt = {
      id: u.attempt_id,
      step: u.step,
      binding: u.binding,
      tokens: u.usage?.tokens ?? null,
    };
    const stage = stageOf(u.step);
    const phase = stage === null ? null : PHASE[stage];
    let group = groups.at(-1);
    // A step this does not know stays where it is; only a later phase or a new review starts a group.
    const opens =
      group === undefined ||
      u.step === 'review' ||
      (phase !== null && (group.phase === null || phase > group.phase));
    if (opens) {
      const title =
        u.step === 'review'
          ? `Round ${++rounds}`
          : phase === null
            ? 'Steps'
            : PHASE_TITLE[phase as 0 | 1 | 2 | 3 | 4];
      group = { key: `g:${groups.length}`, title, stage, phase, runs: [] };
      groups.push(group);
    }
    const g = group as Building;
    const run = g.runs.at(-1);
    if (run !== undefined && run.step === u.step) run.attempts.push(attempt);
    else g.runs.push({ key: `r:${u.attempt_id}`, step: u.step, attempts: [attempt] });
  }
  return groups;
}

/** Tokens of the attempts that reported them; `null` when none did. */
export function tokensOf(attempts: readonly Attempt[]): number | null {
  const known = attempts.flatMap((a) => (a.tokens === null ? [] : [a.tokens]));
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

export const groupAttempts = (g: AttemptGroup): readonly Attempt[] =>
  g.runs.flatMap((r) => r.attempts);

/**
 * What the row of a group says about it. Nearly every round is one review and one fix, so a round names only
 * what sets it apart: its fix repeated, or steps beyond it.
 */
export function groupFlow(group: AttemptGroup): string {
  const label = (r: AttemptRun): string => {
    const name = r.step.replaceAll('_', ' ');
    return r.attempts.length > 1 ? `${name} ×${r.attempts.length}` : name;
  };
  const [opening, fix, ...rest] = group.runs;
  if (opening?.step !== 'review' || fix === undefined) return group.runs.map(label).join(' → ');
  const usual = fix.step === 'fix_review' && fix.attempts.length === 1;
  return (usual ? rest : [fix, ...rest]).map(label).join(' → ');
}

/** `fix_review` → `Fix review`. */
export function stepName(step: SafeText): SafeText {
  const words = step.replaceAll('_', ' ');
  return sanitize(words.charAt(0).toUpperCase() + words.slice(1));
}

export type TreeRow =
  | { readonly kind: 'live'; readonly key: string }
  | {
      readonly kind: 'group';
      readonly key: string;
      readonly group: AttemptGroup;
      readonly open: boolean;
    }
  | {
      readonly kind: 'run';
      readonly key: string;
      readonly parent: string;
      readonly run: AttemptRun;
      readonly open: boolean;
    }
  | {
      readonly kind: 'attempt';
      readonly key: string;
      readonly parent: string;
      readonly attempt: Attempt;
      /** 1 under a group, 2 under a run. */
      readonly depth: 1 | 2;
      /** Which run of its step, where several in a row would read the same. */
      readonly ordinal?: number;
    };

export const LIVE_KEY = 'live';
export const attemptKey = (id: string): string => `a:${id}`;

/** The rows of the chooser with the groups and runs in `open` unfolded. */
export function treeRows(
  groups: readonly AttemptGroup[],
  open: readonly string[],
): readonly TreeRow[] {
  const rows: TreeRow[] = [{ kind: 'live', key: LIVE_KEY }];
  for (const group of groups) {
    const groupOpen = open.includes(group.key);
    rows.push({ kind: 'group', key: group.key, group, open: groupOpen });
    if (!groupOpen) continue;
    for (const run of group.runs) {
      const only = run.attempts[0];
      if (run.attempts.length === 1 && only !== undefined) {
        rows.push({
          kind: 'attempt',
          key: attemptKey(only.id),
          parent: group.key,
          attempt: only,
          depth: 1,
        });
        continue;
      }
      const runOpen = open.includes(run.key);
      rows.push({ kind: 'run', key: run.key, parent: group.key, run, open: runOpen });
      if (runOpen)
        run.attempts.forEach((attempt, i) =>
          rows.push({
            kind: 'attempt',
            key: attemptKey(attempt.id),
            parent: run.key,
            attempt,
            depth: 2,
            ordinal: i + 1,
          }),
        );
    }
  }
  return rows;
}

/**
 * Where the chooser opens: on the attempt being read, else on its first row, with what holds the attempt read
 * or the latest one unfolded.
 * Older rounds stay folded, so a long task still fits on one screen.
 */
export function pickerStart(
  groups: readonly AttemptGroup[],
  reading: string | null,
): { readonly cursor: string; readonly open: readonly string[] } {
  const latest = groups.at(-1)?.runs.at(-1)?.attempts.at(-1)?.id ?? null;
  const target = reading ?? latest;
  for (const group of groups)
    for (const run of group.runs)
      if (run.attempts.some((a) => a.id === target))
        return {
          cursor: reading === null ? LIVE_KEY : attemptKey(reading),
          open: run.attempts.length > 1 ? [group.key, run.key] : [group.key],
        };
  return { cursor: LIVE_KEY, open: [] };
}

/** The row the cursor is on; the first row when its key is not shown. */
export function cursorIndex(rows: readonly TreeRow[], cursor: string | null): number {
  return Math.max(
    0,
    rows.findIndex((r) => r.key === cursor),
  );
}

/** The stage of what the row stands for. */
export function rowStage(row: TreeRow, groups: readonly AttemptGroup[]): StageName | null {
  switch (row.kind) {
    case 'live':
      return null;
    case 'group':
      return row.group.stage;
    case 'run':
      return stageOf(row.run.step);
    case 'attempt':
      return stageOf(row.attempt.step) ?? groups.find((g) => g.key === row.parent)?.stage ?? null;
  }
}

/** `950`, `12k`, `2.1M`. */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
