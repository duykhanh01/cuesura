/**
 * `report` (SPEC §16): what happened since a moment, per project, for someone who was away. Built from the
 * projection and the event log only, never by a model. Finished tasks are those whose terminal status came
 * at or after `since`; waiting and running tasks are listed as they are now; decider answers are those
 * given at or after `since`. Finding when a task finished replays its log once per version (the board's
 * `statusSince`), so the first report after a restart reads every terminal task of the projects.
 */
import { z } from 'zod';
import { TASK_STATUSES, TERMINAL_STATUSES, isTerminal, type TaskState } from '../domain/state.ts';
import type { Usage } from '../domain/trigger.ts';
import { needsUser } from '../explain/needs-user.ts';
import type { Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import type { Caller } from './authz.ts';
import type { StatusSince } from './board.ts';
import type { AppError, QueuePauseReader } from './queries.ts';
import { queuePausedView } from '../explain/explain.ts';
import { nextAction } from './inbox.ts';

/** Entries kept per section and project; a longer section says `truncated`. */
export const REPORT_LIMIT = 200;

const ACTIVE_STATUSES = TASK_STATUSES.filter((s) => !isTerminal(s));

const ReportQuerySchema = z
  .object({
    kind: z.literal('report'),
    project: z.string().min(1).optional(),
    since: z.number().int().nonnegative(),
  })
  .strict();

export type ReportDeps = {
  readonly store: Store;
  readonly statusSince: StatusSince;
  readonly now: () => number;
  readonly queuePause?: QueuePauseReader;
};

/** A sum over the runs that gave this metric; with `missing` runs it is a lower bound, never a zero for unknown. */
type Metric = { sum: number; missing: number };

type UsageTotal = {
  agent_runs: number;
  /** Runs by the basis of their usage; a run that gave no usage at all is `unavailable`. */
  basis: Record<Usage['basis'], number>;
  tokens: Metric;
  cost: Metric;
};

function emptyUsage(): UsageTotal {
  return {
    agent_runs: 0,
    basis: { reported: 0, estimated: 0, unavailable: 0 },
    tokens: { sum: 0, missing: 0 },
    cost: { sum: 0, missing: 0 },
  };
}

function addMetric(m: Metric, value: number | undefined): void {
  if (value === undefined) m.missing += 1;
  else m.sum += value;
}

type Section<T> = { items: T[]; truncated: boolean };

export type ProjectReport = {
  project: string;
  finished: Section<Record<string, unknown>>;
  needs_you: Section<Record<string, unknown>>;
  running: Section<Record<string, unknown>>;
  decisions: Section<Record<string, unknown>>;
  /** Usage of the tasks finished in the window, over their whole life. */
  usage: UsageTotal;
};

function section<T>(): Section<T> {
  return { items: [], truncated: false };
}

function push<T>(s: Section<T>, item: T): void {
  if (s.items.length < REPORT_LIMIT) s.items.push(item);
  else s.truncated = true;
}

function addUsage(total: UsageTotal, u: Usage | null): void {
  total.agent_runs += 1;
  total.basis[u?.basis ?? 'unavailable'] += 1;
  addMetric(total.tokens, u?.tokens);
  addMetric(total.cost, u?.cost);
}

export function taskUsage(s: TaskState): UsageTotal {
  const total = emptyUsage();
  for (const a of Object.values(s.attempts)) addUsage(total, a.usage);
  for (const r of Object.values(s.decider_runs ?? {})) if (r.invoked) addUsage(total, r.usage);
  return total;
}

function sumInto(total: UsageTotal, u: UsageTotal): void {
  total.agent_runs += u.agent_runs;
  for (const b of Object.keys(u.basis) as Usage['basis'][]) total.basis[b] += u.basis[b];
  for (const m of ['tokens', 'cost'] as const) {
    total[m].sum += u[m].sum;
    total[m].missing += u[m].missing;
  }
}

/**
 * Adds one task to its project's report. Pure, so the window rules are tested without a daemon; `finishedAt`
 * is when the task entered its terminal status, `null` when the log cannot say (then it is not listed as
 * finished). Decider answers count by their own time: one can land after the task finished.
 */
export function addToReport(
  r: ProjectReport,
  s: TaskState,
  window: { readonly since: number; readonly until: number },
  finishedAt: number | null,
  statusSince?: () => number | null,
  queuePaused = false,
): void {
  const inWindow = (t: number): boolean => t >= window.since && t <= window.until;
  const base = { task_id: s.id, title: s.task.title };
  if (isTerminal(s.status)) {
    if (finishedAt !== null && inWindow(finishedAt)) {
      const usage = taskUsage(s);
      sumInto(r.usage, usage);
      push(r.finished, {
        ...base,
        status: s.status,
        reason: s.terminal?.reason ?? null,
        pr_ref: s.pr_ref,
        merged: s.merged,
        unverified: s.completion?.unverified?.reason ?? null,
        finished_at: finishedAt,
        usage,
      });
    }
  } else if (needsUser(s, window.until, statusSince)) {
    push(r.needs_you, {
      ...base,
      status: s.status,
      wait_code: s.wait?.detail.code ?? null,
      pr_ref: s.pr_ref,
      task_version: s.version,
      pause: s.pause ?? null,
      next: nextAction(s, queuePaused),
      questions: Object.values(s.questions)
        .filter((q) => q.status === 'open' && q.revision === s.revision)
        .map((q) => ({ question_id: q.id, body: q.body })),
    });
  } else {
    push(r.running, {
      ...base,
      status: s.status,
      step: s.current_step,
      wait_code: s.wait?.detail.code ?? null,
      pr_ref: s.pr_ref,
    });
  }
  for (const d of Object.values(s.decider_runs ?? {}).sort((a, b) => a.at - b.at)) {
    if (!d.invoked || !inWindow(d.at)) continue;
    push(r.decisions, {
      ...base,
      question: s.questions[d.question_id]?.body ?? null,
      answer: d.answer,
      reason: d.reason,
      applied: d.applied,
      failure: d.failure,
      at: d.at,
    });
  }
}

export function emptyReport(project: string): ProjectReport {
  return {
    project,
    finished: section(),
    needs_you: section(),
    running: section(),
    decisions: section(),
    usage: emptyUsage(),
  };
}

function isEmpty(r: ProjectReport): boolean {
  return (
    r.finished.items.length +
      r.needs_you.items.length +
      r.running.items.length +
      r.decisions.items.length ===
    0
  );
}

export function report(
  deps: ReportDeps,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
): Result<unknown, AppError> {
  const q = ReportQuerySchema.safeParse(body);
  if (!q.success)
    return err({
      code: 'invalid_request',
      message: 'invalid report query',
      details: {
        issues: q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    });
  const { project, since } = q.data;
  const { store, statusSince } = deps;
  const until = deps.now();
  const projects = project === undefined ? null : [project];
  const queuePaused = queuePausedView(deps.queuePause?.() ?? null, until);
  const byProject = new Map<string, ProjectReport>();
  if (project !== undefined) byProject.set(project, emptyReport(project));

  for (const statuses of [ACTIVE_STATUSES, TERMINAL_STATUSES]) {
    for (const id of store.taskPage({
      projects,
      statuses,
      limit: Number.MAX_SAFE_INTEGER,
    })) {
      const s = store.readTask(id as Uuid);
      if (s === null) continue;
      let r = byProject.get(s.project);
      if (r === undefined) {
        r = emptyReport(s.project);
        byProject.set(s.project, r);
      }
      addToReport(
        r,
        s,
        { since, until },
        isTerminal(s.status) ? statusSince(s) : null,
        () => statusSince(s),
        queuePaused !== null,
      );
    }
  }

  const at = (key: string) => (x: Record<string, unknown>) => x[key] as number;
  for (const r of byProject.values()) {
    r.finished.items.sort((a, b) => at('finished_at')(a) - at('finished_at')(b));
    r.decisions.items.sort((a, b) => at('at')(a) - at('at')(b));
  }

  return ok({
    since,
    until,
    queue_paused: queuePaused,
    projects: [...byProject.values()]
      .filter((r) => r.project === project || !isEmpty(r))
      .sort((a, b) => a.project.localeCompare(b.project)),
  });
}
