/**
 * What a person reads when `--json` is not given (contracts/cli-daemon.md): short tables and labelled
 * summaries. `--json` stays the contract for automation. Everything from the daemon passes the same schemas
 * as the interface, so it is sanitized here too; a reply that does not match falls back to plain YAML.
 */
import { stringify } from 'yaml';
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

function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string[] {
  const widths = header.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] as string))),
  );
  return [header, ...rows].map((row) =>
    row
      .map((cell, i) =>
        i === row.length - 1 ? cell : padEnd(uiText(cell), widths[i] as number),
      )
      .join('  '),
  );
}

function labelled(
  pairs: readonly (readonly [string, string | null])[],
): string[] {
  return pairs.flatMap(([label, value]) =>
    value === null ? [] : [`${label}: ${value}`],
  );
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
  return /^[\w@%+=:,./-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", "'\\''")}'`;
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
          ['cusr', 'task', 'board', ...flags, '--cursor', b.next_cursor]
            .map(shellWord)
            .join(' '),
        )}`,
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
const STEP_STATE: Record<
  NonNullable<TaskProgress['steps']>[number]['state'],
  string
> = {
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
        q.outcome?.ok === false
          ? `${q.outcome.error.code}: ${q.outcome.error.message}`
          : null,
      ],
      ['Next step', q.next_step],
    ]),
  ];
  return `${lines.join('\n')}\n`;
};
