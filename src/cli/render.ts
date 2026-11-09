/**
 * What a person reads when `--json` is not given (contracts/cli-daemon.md): short tables and labelled
 * summaries. `--json` stays the contract for automation. Everything from the daemon passes the same schemas
 * as the interface, so it is sanitized here too; a reply that does not match falls back to plain YAML.
 */
import { stringify } from 'yaml';
import { z } from 'zod';
import {
  BoardSchema,
  ProjectListSchema,
  RequestShowSchema,
  TaskProgressSchema,
  type BoardRow,
  type TaskProgress,
} from '../tui/client/schemas.ts';
import { sanitize, uiText } from '../tui/terminal/safe-text.ts';
import { displayWidth, padEnd } from '../tui/terminal/width.ts';

export type Render = (data: unknown) => string;

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] as string))),
  );
  return [header, ...rows].map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : padEnd(uiText(cell), widths[i] as number)))
      .join('  '),
  );
}

function labelled(pairs: readonly (readonly [string, string | null])[]): string[] {
  return pairs.flatMap(([label, value]) => (value === null ? [] : [`${label}: ${value}`]));
}

const when = (ms: number): string => new Date(ms).toISOString();

function taskTable(rows: readonly BoardRow[]): string[] {
  return table(
    ['ID', 'PROJECT', 'STATUS', 'ACTIVITY', 'TITLE'],
    rows.map((r) => [
      r.task_id,
      sanitize(r.project),
      r.status,
      sanitize(r.wait_code ?? r.step ?? '-'),
      r.title,
    ]),
  );
}

/** Quoted only when it has to be, so a suggested command can be pasted as it is. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** `flags`: what this board was asked with, so the next page shows the same list. */
export const renderBoard =
  (flags: readonly string[]): Render =>
  (data) => {
    const r = BoardSchema.safeParse(data);
    if (!r.success || r.data.unchanged) return stringify(data);
    const b = r.data;
    const needing = new Set(b.attention.items.map((t) => t.task_id));
    const others = b.items.filter((t) => !needing.has(t.task_id));
    const counts = Object.entries(b.counts.by_status)
      .map(([status, n]) => `${status} ${n}`)
      .join(', ');
    const lines: string[] = [];
    if (b.attention.items.length > 0) {
      lines.push(
        `Needs you (${b.attention.items.length}${b.attention.truncated ? '+' : ''})`,
        ...taskTable(b.attention.items),
        '',
      );
    }
    lines.push(
      ...(others.length > 0
        ? ['Tasks', ...taskTable(others)]
        : [b.attention.items.length > 0 ? 'No other tasks.' : 'No tasks.']),
      '',
      `Counts: ${counts === '' ? 'none' : counts}. Queue: ${b.queue.length}.`,
    );
    if (b.next_cursor !== null)
      lines.push(
        `More: ${sanitize(
          ['cusr', 'task', 'board', ...flags, '--cursor', b.next_cursor].map(shellWord).join(' '),
        )}`,
      );
    return `${lines.join('\n')}\n`;
  };

const TaskListSchema = z.object({
  items: z.array(
    z.object({
      task_id: z.string(),
      project: z.string(),
      title: z.string(),
      status: z.string(),
      activity: z.string().optional(),
      pr_ref: z.string().optional(),
      overlaps: z.array(z.string()).optional(),
      base_conflicts: z.array(z.string()).optional(),
      scope_unknown: z.boolean().optional(),
      terminal: z.object({ reason: z.string() }).loose().optional(),
      unverified: z.object({ reason: z.string() }).loose().optional(),
    }),
  ),
  next_cursor: z.string().nullable(),
});

/** Longest end reason the list's activity column shows; `task show` has the whole of it. */
const LIST_REASON_LIMIT = 60;

const shortReason = (r: string): string =>
  r.length <= LIST_REASON_LIMIT ? r : `${r.slice(0, LIST_REASON_LIMIT - 1)}…`;

/** `flags`: what this list was asked with, so the next page shows the same list. */
export const renderTaskList =
  (flags: readonly string[]): Render =>
  (data) => {
    const r = TaskListSchema.safeParse(data);
    if (!r.success) return stringify(data);
    const { items, next_cursor } = r.data;
    const lines =
      items.length === 0
        ? ['No tasks.']
        : table(
            ['ID', 'PROJECT', 'STATUS', 'ACTIVITY', 'PR', 'TITLE'],
            items.map((t) => [
              t.task_id,
              sanitize(t.project),
              // A DONE on a merge nobody checked must not read as a clean one (issue #264).
              sanitize(t.unverified === undefined ? t.status : `${t.status} (unverified)`),
              sanitize(
                t.terminal === undefined ? (t.activity ?? '-') : shortReason(t.terminal.reason),
              ),
              sanitize(t.pr_ref ?? '-'),
              sanitize(t.title),
            ]),
          );
    // Shared files and base conflicts collide at merge whatever the queue order says (issue #210).
    const notes = items.flatMap((t) => [
      ...(t.overlaps === undefined || t.overlaps.length === 0
        ? []
        : [`Overlap: ${t.task_id} changes files also changed by ${t.overlaps.join(', ')}`]),
      ...(t.base_conflicts === undefined || t.base_conflicts.length === 0
        ? []
        : [
            `Base conflict: ${t.task_id} conflicts with its base on ${t.base_conflicts.join(', ')}`,
          ]),
      ...(t.scope_unknown === true
        ? [
            `Scope unknown: ${t.task_id}'s branch could not be read; overlaps and conflicts may be missing`,
          ]
        : []),
    ]);
    if (notes.length > 0) lines.push('', ...notes.map(sanitize));
    if (next_cursor !== null)
      lines.push(
        '',
        `More: ${sanitize(
          ['cusr', 'task', 'list', ...flags, '--cursor', next_cursor].map(shellWord).join(' '),
        )}`,
      );
    return `${lines.join('\n')}\n`;
  };

const HistorySchema = z.object({
  task_id: z.string(),
  events: z.array(
    z.object({
      seq: z.number(),
      type: z.string(),
      revision: z.number(),
      actor: z.unknown(),
      at: z.string().optional(),
    }),
  ),
  next_cursor: z.number(),
  more: z.boolean(),
});

/** Summary pages only: a `--full` page has payloads, which a table cannot show, so it stays YAML. */
export const renderHistory: Render = (data) => {
  const r = HistorySchema.safeParse(data);
  if (!r.success || (data as { details?: unknown }).details === undefined) return stringify(data);
  const { task_id, events, next_cursor, more } = r.data;
  const lines =
    events.length === 0
      ? ['No events.']
      : table(
          ['SEQ', 'AT', 'REVISION', 'ACTOR', 'TYPE'],
          events.map((e) => [
            String(e.seq),
            sanitize(e.at ?? '-'),
            String(e.revision),
            sanitize(typeof e.actor === 'string' ? e.actor : JSON.stringify(e.actor)),
            sanitize(e.type),
          ]),
        );
  if (more)
    lines.push(
      '',
      `More: cusr task history ${shellWord(sanitize(task_id))} --after ${next_cursor}`,
    );
  return `${lines.join('\n')}\n`;
};

export const renderProjects: Render = (data) => {
  const r = ProjectListSchema.safeParse(data);
  if (!r.success) return stringify(data);
  const { caller, projects, profiles } = r.data;
  const access = caller.scope === 'all' ? 'all projects' : 'limited projects';
  const lines = [
    ...labelled([
      ['Signed in as', caller.actor],
      ['Access', access],
      ['Roles', caller.roles.map(sanitize).join(', ') || 'none'],
      ['Can confirm runs', caller.trusted_confirmer ? 'yes' : 'no'],
    ]),
    '',
    ...(projects.length > 0
      ? table(
          ['PROJECT', 'REPOSITORY'],
          projects.map((p) => [sanitize(p.id), p.repo ?? '-']),
        )
      : ['No projects.']),
    '',
    `Profiles: ${profiles.map(sanitize).join(', ') || 'none'}`,
  ];
  return `${lines.join('\n')}\n`;
};

/** `past` only says a step ran, not that it passed: a failed gate is `past` too, on its way to a fix. */
const STEP_STATE: Record<NonNullable<TaskProgress['steps']>[number]['state'], string> = {
  past: 'visited',
  current: 'current',
  remaining: 'next',
  not_required: 'not required',
};

export const renderProgress: Render = (data) => {
  const r = TaskProgressSchema.safeParse(data);
  if (!r.success) return stringify(data);
  const p = r.data;
  const lines = labelled([
    ['Task', p.task_id],
    ['Mode', p.mode],
    ['Needs you', p.needs_user ? 'yes' : 'no'],
    ['Worktree', p.worktree_path],
  ]);
  lines.push(
    '',
    ...(p.steps === null
      ? [`Steps are not available yet (${p.reason ?? 'no reason given'}).`]
      : table(
          ['STATE', 'STEP'],
          p.steps.map((s) => [
            STEP_STATE[s.state],
            s.visits > 1 ? `${s.name} (${s.visits} visits)` : s.name,
          ]),
        )),
  );
  return `${lines.join('\n')}\n`;
};

export const renderRequest: Render = (data) => {
  const r = RequestShowSchema.safeParse(data);
  if (!r.success) return stringify(data);
  const q = r.data;
  const headline =
    q.state === 'in_progress'
      ? 'Request in progress'
      : q.state === 'interrupted'
        ? 'Request interrupted'
        : q.outcome?.ok === false
          ? 'Request completed — operation rejected'
          : 'Request completed — operation succeeded';
  const lines = [
    headline,
    '',
    ...labelled([
      ['Request', sanitize(q.request_id)],
      ['Command', q.kind],
      ['Project', q.project === null ? null : sanitize(q.project)],
      ['Task', q.task_id],
      ['Admitted', when(q.admitted_at)],
      ['Completed', q.completed_at === null ? null : when(q.completed_at)],
      [
        'Reason',
        q.outcome?.ok === false ? `${q.outcome.error.code}: ${q.outcome.error.message}` : null,
      ],
      ['Next step', q.next_step],
    ]),
  ];
  return `${lines.join('\n')}\n`;
};

const ReportSection = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), truncated: z.boolean() });
const ReportMetric = z.object({ sum: z.number(), missing: z.number() });
const ReportUsage = z.object({
  agent_runs: z.number(),
  basis: z.object({
    reported: z.number(),
    estimated: z.number(),
    unavailable: z.number(),
  }),
  tokens: ReportMetric,
  cost: ReportMetric,
});
type ReportUsage = z.infer<typeof ReportUsage>;

/** A metric no run gave is unavailable, never 0; a partial sum says how many runs it leaves out. */
function metric(m: z.infer<typeof ReportMetric>, runs: number, unit: string): string {
  if (m.missing >= runs) return `${unit} unavailable`;
  const value = unit === 'tokens' ? `${m.sum} tokens` : `cost ${m.sum}`;
  return m.missing === 0 ? value : `${value} (${m.missing} of ${runs} runs not included)`;
}

function usageLine(u: ReportUsage): string {
  if (u.agent_runs === 0) return 'Usage of finished tasks: no agent runs.';
  const basis = (['reported', 'estimated', 'unavailable'] as const)
    .filter((b) => u.basis[b] > 0)
    .map((b) => `${u.basis[b]} ${b}`)
    .join(', ');
  return `Usage of finished tasks: ${metric(u.tokens, u.agent_runs, 'tokens')}, ${metric(u.cost, u.agent_runs, 'cost')}; ${u.agent_runs} agent runs (${basis}).`;
}
const ReportBase = {
  task_id: z.string(),
  title: z.string(),
  status: z.string(),
  pr_ref: z.string().nullable(),
};
const ReportSchema = z.object({
  since: z.number(),
  until: z.number(),
  queue_paused: z
    .object({ reason: z.string(), by: z.string(), age_ms: z.number() })
    .nullable()
    .optional(),
  projects: z.array(
    z.object({
      project: z.string(),
      finished: ReportSection(
        z.object({
          ...ReportBase,
          reason: z.string().nullable(),
          merged: z.boolean(),
          unverified: z.string().nullable(),
          finished_at: z.number(),
        }),
      ),
      needs_you: ReportSection(
        z.object({
          ...ReportBase,
          wait_code: z.string().nullable(),
          questions: z.array(z.object({ question_id: z.string(), body: z.string() })),
          task_version: z.number().optional(),
          pause: z.object({ reason: z.string() }).nullable().optional(),
          next: z
            .object({ command: z.string().nullable(), note: z.string() })
            .nullable()
            .optional(),
        }),
      ),
      running: ReportSection(
        z.object({
          ...ReportBase,
          step: z.string().nullable(),
          wait_code: z.string().nullable(),
        }),
      ),
      decisions: ReportSection(
        z.object({
          task_id: z.string(),
          title: z.string(),
          question: z.string().nullable(),
          answer: z.string().nullable(),
          reason: z.string().nullable(),
          applied: z.boolean(),
          failure: z.string().nullable(),
        }),
      ),
      usage: ReportUsage,
    }),
  ),
});

function heading(label: string, s: { items: readonly unknown[]; truncated: boolean }): string {
  return `${label} (${s.items.length}${s.truncated ? '+' : ''})`;
}

/** One line of a longer text, so a decider's answer does not break the layout. */
const oneLine = (text: string): string => sanitize(text.replace(/\s+/g, ' '));

export const renderReport: Render = (data) => {
  const r = ReportSchema.safeParse(data);
  if (!r.success) return stringify(data);
  const { since, until, projects, queue_paused: qp } = r.data;
  const lines = [`Report from ${when(since)} to ${when(until)}`];
  if (qp != null)
    lines.push(
      `Queue paused by ${sanitize(qp.by)} ${Math.round(qp.age_ms / 60_000)} min ago: ${oneLine(qp.reason)}. No task that has not started runs until cusr queue resume.`,
    );
  if (projects.length === 0) lines.push('', 'Nothing to report.');
  for (const p of projects) {
    lines.push('', `Project ${sanitize(p.project)}`);
    const { finished, needs_you, running, decisions, usage } = p;
    if (finished.items.length > 0)
      lines.push(
        heading('Finished', finished),
        ...table(
          ['ID', 'STATUS', 'PR', 'TITLE'],
          finished.items.map((t) => [
            t.task_id,
            t.status === 'DONE' && t.unverified !== null ? 'DONE (unverified)' : t.status,
            sanitize(t.pr_ref ?? '-'),
            sanitize(t.title),
          ]),
        ),
        ...finished.items.flatMap((t) =>
          t.status !== 'DONE' && t.reason !== null ? [`  ${t.task_id}: ${oneLine(t.reason)}`] : [],
        ),
      );
    if (needs_you.items.length > 0)
      lines.push(
        heading('Needs you', needs_you),
        ...table(
          ['ID', 'STATUS', 'WAITING ON', 'TITLE'],
          needs_you.items.map((t) => [
            t.task_id,
            t.status,
            sanitize(t.wait_code ?? '-'),
            sanitize(t.title),
          ]),
        ),
        ...needs_you.items.flatMap((t) => [
          ...(t.task_version === undefined ? [] : [`  ${t.task_id} version ${t.task_version}`]),
          ...(t.pause == null ? [] : [`  ${t.task_id} paused: ${oneLine(t.pause.reason)}`]),
          ...t.questions.map((q) => `  ${t.task_id} asks (${q.question_id}): ${oneLine(q.body)}`),
          ...(t.next == null
            ? []
            : [
                `  ${t.task_id} next: ${t.next.command === null ? oneLine(t.next.note) : sanitize(t.next.command)}`,
              ]),
        ]),
      );
    if (running.items.length > 0)
      lines.push(
        heading('Running', running),
        ...table(
          ['ID', 'STATUS', 'ACTIVITY', 'TITLE'],
          running.items.map((t) => [
            t.task_id,
            t.status,
            sanitize(t.wait_code ?? t.step ?? '-'),
            sanitize(t.title),
          ]),
        ),
      );
    if (decisions.items.length > 0)
      lines.push(
        heading('Decider answers', decisions),
        ...decisions.items.flatMap((d) => [
          `- ${d.task_id} ${oneLine(d.title)}`,
          ...(d.question === null ? [] : [`  Q: ${oneLine(d.question)}`]),
          ...(d.answer === null ? [] : [`  A: ${oneLine(d.answer)}`]),
          ...(d.reason === null ? [] : [`  Why: ${oneLine(d.reason)}`]),
          d.applied
            ? '  Applied.'
            : `  Not applied${d.failure === null ? '' : `: ${oneLine(d.failure)}`}.`,
        ]),
      );
    if (finished.items.length > 0) lines.push(usageLine(usage));
  }
  return `${lines.join('\n')}\n`;
};
