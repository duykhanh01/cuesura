/**
 * Task detail: where a task stands, why, and how out (FR-011–FR-013, FR-015, US2). Everything about waits, exits,
 * blockers and limits is what `task_explain` said, written out; nothing here works out a state of its own
 * (FR-012). The rows are kept whole, so a resize loses nothing and the screen scrolls by row.
 */
import { activity, statusMark } from '../model/activity.ts';
import type { TaskDetail } from '../model/detail.ts';
import { shortAttempt } from '../model/logs.ts';
import type { TuiState } from '../model/state.ts';
import type { TaskExplain, TaskProgress, TaskShow } from '../client/schemas.ts';
import {
  joinSafe,
  sanitize,
  sanitizeLines,
  uiText,
  type SafeText,
} from '../terminal/safe-text.ts';
import type { Style } from '../terminal/screen.ts';
import { padEnd, truncate, wrap } from '../terminal/width.ts';
import { clockTime, type Body } from './layout.ts';

type Row = { readonly text: SafeText; readonly style?: Style };

const HEADING: Style = { bold: true };
const WARN: Style = { fg: 'yellow', bold: true };

/** Every state a step can be in, in words; `past` says only that it ran, not that it passed (data model). */
const STEP_WORDS: Readonly<
  Record<NonNullable<TaskProgress['steps']>[number]['state'], string>
> = {
  past: 'ran',
  current: 'running',
  remaining: 'still to run',
  not_required: 'not required',
};
const STEP_COLUMN = 14;

/** What the daemon reported, and nothing else: no value never reads as 0. */
export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1_000);
  const h = Math.floor(total / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

type Usage = TaskShow['provenance']['usage'][number]['usage'];

/** FR-013: the basis is always said, and missing usage is `unavailable`. */
export function usageWords(usage: Usage): string {
  if (usage === null || usage.basis === 'unavailable') return 'unavailable';
  const parts = [
    ...(usage.tokens === undefined ? [] : [`${usage.tokens} tokens`]),
    ...(usage.cost === undefined ? [] : [`cost ${usage.cost}`]),
  ];
  return parts.length === 0
    ? `${usage.basis}, no figures`
    : `${usage.basis} ${parts.join(', ')}`;
}

const choice = (c: {
  readonly harness: SafeText;
  readonly model: SafeText;
  readonly effort: SafeText;
}): SafeText => joinSafe([c.harness, c.model, c.effort], '/');

class Rows {
  readonly rows: Row[] = [];
  readonly #cols: number;

  constructor(cols: number) {
    this.#cols = cols;
  }

  add(text: SafeText, style?: Style): void {
    // `wrap` breaks at spaces, so an indent has to be put back on the row.
    const indent = /^ */.exec(text)?.[0] ?? '';
    const body = uiText(text.slice(indent.length));
    for (const row of wrap(body, this.#cols - indent.length))
      this.rows.push({
        text: uiText(indent + row),
        ...(style === undefined ? {} : { style }),
      });
  }

  say(text: string, style?: Style): void {
    this.add(uiText(text), style);
  }

  /** A label and a value the daemon sent. */
  field(label: string, value: SafeText, style?: Style): void {
    this.add(joinSafe([uiText(`${label}: `), value]), style);
  }

  heading(text: string): void {
    this.rows.push({ text: uiText(''), style: {} });
    this.rows.push({ text: uiText(text), style: HEADING });
  }
}

function aboutRows(out: Rows, d: TaskDetail, stale: boolean): void {
  const show = d.show.data;
  const explain = d.explain.data;
  out.say('Task detail', HEADING);
  out.add(show?.title ?? d.title);
  const status = explain?.status ?? show?.status;
  if (status !== undefined)
    out.add(
      joinSafe([
        uiText('Status: '),
        statusMark(status).text,
        uiText(
          ` · Version ${explain?.version ?? show?.version} · Revision ${explain?.revision ?? show?.revision}`,
        ),
        ...(show === null
          ? []
          : [uiText(' · Project '), sanitize(show.project)]),
      ]),
    );
  out.field('ID', sanitize(d.taskId));
  if (explain !== null)
    out.add(
      joinSafe([
        uiText('Now: '),
        activity({
          status: explain.status,
          wait_code: explain.wait?.detail.code ?? null,
          step: explain.step,
          mode: d.progress.data?.mode ?? null,
          needs_user: false,
        }),
      ]),
    );
  if (d.explain.readAt !== null)
    out.say(`Read at ${clockTime(d.explain.readAt)}`);
  const problems: readonly (readonly [string, SafeText | null])[] = [
    ['the explanation', d.explain.error],
    ['the task', d.show.error],
    ['the progress', d.progress.error],
    ['the history', d.history.error],
  ];
  for (const [what, error] of problems)
    if (error !== null)
      out.add(joinSafe([uiText(`Could not read ${what}: `), error]), WARN);
  if (stale) out.say('What is shown here may be out of date.', WARN);
}

function progressRows(out: Rows, d: TaskDetail): void {
  const progress = d.progress.data;
  out.heading('Progress');
  if (progress === null) {
    out.say('Reading…');
    return;
  }
  out.add(
    joinSafe([uiText('Mode: '), progress.mode ?? uiText('not chosen yet')]),
  );
  if (progress.steps === null) {
    out.add(
      joinSafe([
        uiText('Steps are not known yet: '),
        progress.reason ?? uiText('no reason given'),
      ]),
    );
  } else {
    for (const step of progress.steps) {
      const visits =
        step.visits > 0
          ? uiText(
              ` (${step.visits} ${step.visits === 1 ? 'visit' : 'visits'})`,
            )
          : uiText('');
      out.add(
        joinSafe([
          uiText('  '),
          padEnd(uiText(STEP_WORDS[step.state]), STEP_COLUMN),
          step.name,
          visits,
        ]),
      );
    }
  }
  if (progress.worktree_path !== null)
    out.field('Worktree', progress.worktree_path);
}

function runConfigRows(out: Rows, show: TaskShow | null): void {
  const config = show?.run_config ?? null;
  if (config === null) return;
  const { selection } = config;
  out.heading('Run configuration');
  out.add(
    joinSafe([
      uiText('Profile: '),
      selection.profile,
      uiText(' · Mode: '),
      selection.mode,
      uiText(' · Status: '),
      sanitize(config.status),
    ]),
  );
  out.field('Worker', choice(selection.worker));
  out.add(
    selection.reviewer === null
      ? joinSafe([
          uiText('Reviewer: none, '),
          selection.mode,
          uiText(' has no reviewer'),
        ])
      : joinSafe([uiText('Reviewer: '), choice(selection.reviewer)]),
  );
  if (selection.fallbacks.length > 0)
    out.field(
      'Fallbacks',
      joinSafe(selection.fallbacks.map(choice), uiText(', ')),
    );
}

function valueText(value: unknown): SafeText {
  return sanitizeLines(
    typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null'),
  );
}

function whyRows(out: Rows, explain: TaskExplain): void {
  out.heading('Why');
  const { wait } = explain;
  if (wait === null) out.say('Not waiting.');
  else {
    out.field('Reason', wait.reason);
    out.field('Code', sanitize(wait.detail.code));
    for (const [key, value] of Object.entries(wait.detail))
      if (key !== 'code') out.field(sanitize(key), valueText(value));
  }
  // What it takes to go on, in the daemon's words: `resume_when` may name exits that do not exist.
  for (const a of explain.allowed_actions)
    if (a.action === 'wait' || a.action === 'fix_external')
      out.add(joinSafe([uiText('To go on: '), a.note]));
  if (explain.blockers.length === 0) out.say('Blockers: none');
  else
    for (const b of explain.blockers)
      out.add(
        joinSafe([uiText('Blocker: '), b.code, uiText(' from '), b.source]),
      );
}

function exitRows(out: Rows, explain: TaskExplain): void {
  out.heading('Ways out');
  // `command` is only for showing (contracts/tui.md); this reads nothing out of it.
  for (const a of explain.allowed_actions) {
    out.add(joinSafe([sanitize(a.action), uiText(': '), a.note]));
    if (a.command !== null) out.add(joinSafe([uiText('    $ '), a.command]));
  }
  if (explain.allowed_actions.length === 0) out.say('None right now.');
}

function limitRows(out: Rows, explain: TaskExplain): void {
  const { remaining, deadline, slot } = explain;
  out.heading('Limits');
  if (!explain.limits_frozen)
    out.say('Limits are not frozen yet: the task has not started.');
  out.say(
    `Agent runs left: ${remaining.agent_runs} (${remaining.reserved} reserved)`,
  );
  out.say(`Escalations left: ${remaining.escalations}`);
  if (deadline.state === 'passed')
    out.say('Time left: none, the deadline passed');
  else if (deadline.state === 'running')
    out.say(
      `Time left: ${deadline.remaining_ms === null ? 'unavailable' : formatDuration(deadline.remaining_ms)}`,
    );
  else
    out.say(
      `Time limit: ${deadline.max_wall_ms === null ? 'unavailable' : `${formatDuration(deadline.max_wall_ms)}, not started`}`,
    );
  out.say(
    `Waited for the slot: ${formatDuration(slot.initial_wait_ms)} first, ${formatDuration(slot.resumed_wait_ms)} resumed`,
  );
  if (slot.holding) out.say('Holds the execution slot.');
  if (slot.queued !== null)
    out.say(
      slot.queued.position === null
        ? 'Queue position: unavailable'
        : `Queue position: ${slot.queued.position}`,
    );
  for (const p of explain.prerequisites) {
    const parts = [
      uiText('Prerequisite '),
      sanitize(p.task_id),
      uiText(': '),
      p.status,
    ];
    if (p.unverified !== null) parts.push(uiText(' · '), p.unverified.reason);
    out.add(joinSafe(parts));
  }
}

function agentRows(
  out: Rows,
  explain: TaskExplain,
  show: TaskShow | null,
): void {
  out.heading('Agents');
  if (explain.bindings_used.length === 0) out.say('No attempts requested yet.');
  for (const b of explain.bindings_used)
    out.add(
      joinSafe([
        b.step,
        uiText(` · rung ${b.rung} · `),
        b.binding,
        uiText(` · Requested ${b.requested} · Invoked ${b.invoked}`),
      ]),
    );
  for (const e of explain.escalations)
    out.add(
      joinSafe([
        uiText('Escalated: '),
        e.step,
        uiText(` · rung ${e.from} to ${e.to} · `),
        e.reason,
      ]),
    );
  for (const a of show?.provenance.usage ?? [])
    out.add(
      joinSafe([
        uiText(`Attempt ${shortAttempt(a.attempt_id)} · `),
        a.step,
        uiText(' · '),
        a.binding,
        uiText(` · Usage: ${usageWords(a.usage)}`),
      ]),
    );
  for (const e of explain.pending_effects)
    out.add(joinSafe([uiText('In progress: '), e.kind, uiText(' '), e.status]));
}

function evidenceRows(
  out: Rows,
  explain: TaskExplain,
  show: TaskShow | null,
): void {
  const { pr, evidence } = explain;
  out.heading('Pull request and evidence');
  out.field('PR', pr.ref ?? uiText('none yet'));
  out.field('Head', pr.head_sha ?? uiText('none yet'));
  out.field('Base', pr.base_sha ?? uiText('unknown'));
  if (pr.observed !== null)
    out.add(
      joinSafe([
        uiText('Last seen on GitHub: '),
        pr.observed.status,
        uiText(' at head '),
        pr.observed.observed_head ?? uiText('unknown'),
      ]),
    );
  if (pr.observation_expired)
    out.say('Watching this PR has expired; a recheck reads it again.', WARN);
  const validity = (valid: boolean): string =>
    valid ? 'valid' : 'no longer valid';

  out.say(evidence.gates.length === 0 ? 'Gates: none yet' : 'Gates:');
  for (const g of evidence.gates) {
    out.add(
      joinSafe([
        uiText('  '),
        g.step,
        uiText(
          ` · visit ${g.visit} · ${g.passed ? 'passed' : 'failed'} · ${validity(g.valid)}`,
        ),
      ]),
    );
    for (const f of g.failed ?? []) {
      out.add(joinSafe([uiText('    failed: '), f.gate]));
      if (f.log_excerpt !== null) out.add(f.log_excerpt);
    }
  }
  if (evidence.ci.length === 0) out.say('CI: nothing read yet');
  for (const c of evidence.ci)
    out.add(
      joinSafe([
        uiText('CI on head '),
        c.head_sha,
        uiText(` (${validity(c.valid)}): `),
        joinSafe(
          c.checks.map((k) => joinSafe([k.name, uiText(': '), k.state])),
          uiText(', '),
        ),
      ]),
    );

  // Whether review belongs to this run is the daemon's word; a mode without it never reads as passed.
  const config = show?.run_config ?? null;
  const review = config?.review ?? null;
  if (review === 'not_run_by_mode' && config !== null)
    out.add(
      joinSafe([uiText('Review: not required by '), config.selection.mode]),
    );
  else if (review === 'required') out.say('Review: required');
  else out.say('Review: not decided yet');
  for (const r of evidence.reviews)
    out.add(
      joinSafe([
        uiText('  '),
        r.verdict,
        uiText(' on head '),
        r.head_sha,
        uiText(` (${validity(r.valid)})`),
      ]),
    );

  const { wait } = explain;
  // The daemon waits for a merge only once the head is green; this says what it holds, it decides nothing.
  if (
    wait?.detail.code === 'merge' &&
    typeof wait.detail['head_sha'] === 'string'
  )
    out.add(
      joinSafe([
        uiText('Green on head '),
        sanitize(wait.detail['head_sha']),
        uiText(': the daemon is waiting for the merge of this head.'),
      ]),
    );
}

function mergeRows(
  out: Rows,
  explain: TaskExplain,
  show: TaskShow | null,
): void {
  const { merge, cancellation, merge_cleanup: cleanup } = explain;
  const completion = show?.completion ?? null;
  const manual = explain.allowed_actions.some(
    (a) => a.action === 'merge_manually',
  );
  if (
    merge === null &&
    completion === null &&
    cancellation === null &&
    !manual &&
    cleanup === null
  )
    return;
  out.heading('Merge');
  if (manual)
    out.say(
      'Merge this PR yourself on GitHub. Cuesura does not merge, and this task is not done until that merge is seen.',
      WARN,
    );
  if (merge !== null) {
    out.field('Method', merge.method ?? uiText('unknown'));
    if (merge.proposed !== null) {
      out.field('Proposed title', merge.proposed.title);
      out.field('Proposed message', merge.proposed.message);
    }
    if (merge.observed_method !== null)
      out.field('Method actually used', merge.observed_method);
  }
  if (completion !== null) {
    out.field('Merged head', completion.merged_head_sha);
    out.field('Checked head', completion.checked_head_sha ?? uiText('none'));
    out.field('Merge commit', completion.merge_commit_sha ?? uiText('unknown'));
    if (completion.unverified !== null)
      out.add(
        joinSafe([
          completion.unverified.reason,
          uiText(
            ': this merge is not certified, the head merged is not shown to be the head checked.',
          ),
        ]),
        WARN,
      );
  }
  if (cleanup !== null)
    for (const o of cleanup.pending_operations)
      out.add(
        joinSafe([uiText('Cleaning up: '), o.kind, uiText(' '), o.status]),
      );
  // Once a merge is proved the cancel has lost, whether or not the daemon has written that down yet.
  if (cancellation !== null)
    out.say(
      cancellation.late || completion !== null
        ? 'Cancel arrived too late: the merge had already happened, so this task does not end cancelled.'
        : 'Cancel requested: it stops and reconciles first; the status above is the daemon’s.',
      WARN,
    );
}

function historyRows(out: Rows, d: TaskDetail): void {
  const h = d.history;
  out.heading('History');
  if (h.dropped > 0)
    out.say(
      `${h.dropped} earlier events are not kept here: see cusr task history`,
    );
  if (h.events.length === 0 && h.attemptAt === null) out.say('Reading…');
  // One row each however long the payload, cut when drawn: a long history must not cost a wrap per frame.
  for (const e of h.events)
    out.rows.push({
      text: joinSafe([
        uiText(`#${e.seq} `),
        e.type,
        uiText(' by '),
        e.actor,
        uiText('  '),
        e.payload,
      ]),
    });
}

let memo: {
  readonly d: TaskDetail;
  readonly cols: number;
  readonly stale: boolean;
  readonly rows: readonly Row[];
} | null = null;

function detailRows(
  d: TaskDetail,
  cols: number,
  stale: boolean,
): readonly Row[] {
  if (memo?.d === d && memo.cols === cols && memo.stale === stale)
    return memo.rows;
  const out = new Rows(cols);
  aboutRows(out, d, stale);
  progressRows(out, d);
  runConfigRows(out, d.show.data);
  const explain = d.explain.data;
  if (explain === null) {
    out.heading('Why');
    out.say('Reading…');
  } else {
    whyRows(out, explain);
    exitRows(out, explain);
    limitRows(out, explain);
    agentRows(out, explain, d.show.data);
    evidenceRows(out, explain, d.show.data);
    mergeRows(out, explain, d.show.data);
  }
  historyRows(out, d);
  memo = { d, cols, stale, rows: out.rows };
  return out.rows;
}

export const detailRowCount = (s: TuiState): number =>
  s.detail === null
    ? 0
    : detailRows(s.detail, s.size.cols, s.staleTasks.has(s.detail.taskId))
        .length;

export const detailBody =
  (s: TuiState): Body =>
  (frame, top, height) => {
    if (s.detail === null || height <= 0) return;
    const rows = detailRows(
      s.detail,
      s.size.cols,
      s.staleTasks.has(s.detail.taskId),
    );
    const first = Math.min(s.detail.top, Math.max(0, rows.length - height));
    rows.slice(first, first + height).forEach((row, i) => {
      frame.put(0, top + i, truncate(row.text, s.size.cols), row.style ?? {});
    });
  };
