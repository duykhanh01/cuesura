/**
 * Task detail: where a task stands, why, and how out (FR-011–FR-013, FR-015, US2). Everything about waits, exits,
 * blockers and limits is what `task_explain` said, written out; nothing here works out a state of its own
 * (FR-012). Sections without anything to say are left out. The rows are kept whole, so a resize loses nothing
 * and the screen scrolls by row.
 */
import type { TaskStatus } from '../../domain/state.ts';
import { activity, statusMark, todo } from '../model/activity.ts';
import { ending, type TaskDetail } from '../model/detail.ts';
import { shortAttempt } from '../model/logs.ts';
import { progressStages } from '../model/stages.ts';
import type { TuiState } from '../model/state.ts';
import type { TaskExplain, TaskProgress, TaskShow } from '../client/schemas.ts';
import { joinSafe, sanitize, sanitizeLines, uiText, type SafeText } from '../terminal/safe-text.ts';
import type { Style } from '../terminal/screen.ts';
import { displayWidth } from '../terminal/width.ts';
import { clockTime, type Body } from './layout.ts';
import { BOLD, DIM, putSegs, ruleHeading, seg, ui, wrapSegs, type Seg } from './ink.ts';
import { endBadge, stepper } from './stepper.ts';

const WARN: Style = { fg: 'yellow', bold: true };
const GOOD: Style = { fg: 'green' };
const BAD: Style = { fg: 'red' };
const MARGIN = 1;
const LABEL = 16;

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
  return parts.length === 0 ? `${usage.basis}, no figures` : `${usage.basis} ${parts.join(', ')}`;
}

const choice = (c: {
  readonly harness: SafeText;
  readonly model: SafeText;
  readonly effort: SafeText;
}): SafeText => joinSafe([c.harness, c.model, c.effort], '/');

const short = (sha: SafeText): SafeText => (sha.length > 12 ? uiText(`${sha.slice(0, 12)}…`) : sha);

/** Rows of styled segments, wrapped to the screen as they are added. */
class Rows {
  readonly rows: Seg[][] = [];
  readonly #cols: number;

  constructor(cols: number) {
    this.#cols = cols - MARGIN;
  }

  get width(): number {
    return this.#cols;
  }

  line(segs: readonly Seg[], indent = 0): void {
    for (const row of wrapSegs(segs, this.#cols, indent)) this.rows.push(row);
  }

  say(text: string, style?: Style): void {
    this.line([ui(text, style)]);
  }

  /** A label in a column of its own and the daemon's value beside it, wrapping under itself. */
  field(label: string, value: readonly Seg[] | SafeText, labelStyle = DIM): void {
    const segs = typeof value === 'string' ? [seg(value)] : value;
    // A label longer than its column still keeps a space before the value.
    const head = `  ${label}`.padEnd(LABEL + 2);
    this.line([ui(head.endsWith(' ') ? head : `${head} `, labelStyle), ...segs], LABEL + 2);
  }

  heading(text: string, style: Style = BOLD): void {
    this.rows.push([]);
    this.rows.push(ruleHeading(text, this.#cols, style));
  }
}

function statusStyle(status: TaskStatus): Style {
  const color = statusMark(status).color;
  return color === undefined ? BOLD : { fg: color, bold: true };
}

function aboutRows(out: Rows, d: TaskDetail, stale: boolean): void {
  const show = d.show.data;
  const explain = d.explain.data;
  const title = show?.title ?? d.title;
  const crumb = 'Task detail';
  const room = out.width - displayWidth(title) - crumb.length;
  out.line(
    room >= 4 ? [seg(title, BOLD), ui(' '.repeat(room)), ui(crumb, DIM)] : [seg(title, BOLD)],
  );
  const status = explain?.status ?? show?.status;
  const facts: Seg[] = [];
  if (status !== undefined) facts.push(seg(statusMark(status).text, statusStyle(status)));
  if (show !== null) facts.push(ui(' · ', DIM), seg(sanitize(show.project), DIM));
  const mode = d.progress.data?.mode ?? show?.run_config?.selection.mode ?? null;
  if (mode !== null) facts.push(ui(' · ', DIM), seg(mode, DIM));
  out.line(facts);
  const problems: readonly (readonly [string, SafeText | null])[] = [
    ['the explanation', d.explain.error],
    ['the task', d.show.error],
    ['the progress', d.progress.error],
    ['the history', d.history.error],
  ];
  for (const [what, error] of problems)
    if (error !== null) out.line([ui(`Could not read ${what}: `, WARN), seg(error, WARN)]);
  if (stale) out.say('What is shown here may be out of date.', WARN);
}

/** Every step and its state as the daemon listed it, for a workflow whose steps this does not know. */
function rawSteps(out: Rows, steps: NonNullable<TaskProgress['steps']>): void {
  const words = {
    past: 'ran',
    current: 'running',
    remaining: 'still to run',
    not_required: 'not required',
  } as const;
  for (const step of steps)
    out.field(words[step.state], [
      seg(step.name),
      ui(step.visits > 1 ? ` ×${step.visits}` : '', DIM),
    ]);
}

function progressRows(out: Rows, d: TaskDetail): void {
  const progress = d.progress.data;
  const explain = d.explain.data;
  const status = explain?.status ?? d.show.data?.status;
  out.heading('Progress');
  if (progress === null || status === undefined) {
    out.say('  Reading…', DIM);
    return;
  }
  if (progress.steps === null)
    out.line([
      ui('  Steps are not known yet: ', DIM),
      seg(progress.reason ?? uiText('no reason given')),
    ]);
  else {
    const stages = progressStages(progress.steps, status);
    if (stages === null) rawSteps(out, progress.steps);
    else out.line([ui('  '), ...stepper(stages, status)], 2);
  }
  out.rows.push([]);
  if (explain !== null) {
    const row = {
      status: explain.status,
      wait_code: explain.wait?.detail.code ?? null,
      step: explain.step,
      mode: progress.mode,
      needs_user: progress.needs_user,
    };
    const over = endBadge(explain.status) !== null;
    const end = over ? ending(d) : null;
    out.field(over ? 'Ended' : 'Now', [
      seg(activity(row), BOLD),
      ...(end === null ? [] : [ui(' by ', DIM), seg(end.actor)]),
    ]);
    if (end !== null && end.reason !== null) out.field('Reason', [seg(end.reason)]);
    const action = todo(row);
    if (action !== null)
      out.field('Needs you', [seg(joinSafe([uiText('→ '), action]), WARN)], WARN);
  }
}

function valueText(value: unknown): SafeText {
  return sanitizeLines(typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null'));
}

function whyRows(out: Rows, explain: TaskExplain): void {
  const { wait } = explain;
  if (wait === null && explain.blockers.length === 0) return;
  out.heading(wait === null ? 'Why' : 'Why it is waiting');
  if (wait !== null) {
    out.field('Reason', wait.reason);
    out.field('Code', sanitize(wait.detail.code));
    // The rest of the detail is for whoever digs in: there, but faint.
    for (const [key, value] of Object.entries(wait.detail))
      if (key !== 'code') out.field(sanitize(key), [seg(valueText(value), DIM)]);
  }
  for (const b of explain.blockers)
    out.field('Blocker', [seg(b.code, BAD), ui(' from ', DIM), seg(b.source)]);
}

/** Action names in words; one this does not know is shown as the daemon sent it. */
const ACTION_WORDS: Readonly<Record<string, string>> = {
  merge_manually: 'merge on GitHub',
  fix_external: 'fix outside',
  task_add: 'add a new task',
};

export function actionName(action: string): SafeText {
  return Object.hasOwn(ACTION_WORDS, action)
    ? uiText(ACTION_WORDS[action] ?? action)
    : sanitize(action);
}

function exitRows(out: Rows, explain: TaskExplain): void {
  out.heading('What you can do');
  // `command` is only for showing (contracts/tui.md); this reads nothing out of it.
  for (const a of explain.allowed_actions) {
    out.field(actionName(a.action), a.note, { fg: 'cyan', bold: true });
    if (a.command !== null)
      out.line([ui(''.padEnd(LABEL + 2)), ui('$ ', DIM), seg(a.command, DIM)], LABEL + 4);
  }
  if (explain.allowed_actions.length === 0) out.say('  None right now.', DIM);
}

function checkStyle(state: string): Style {
  if (/^(success|passed?|ok|neutral|skipped)$/i.test(state)) return GOOD;
  if (/^(failure|failed|fail|error|cancelled|timed_out)$/i.test(state)) return BAD;
  return { fg: 'yellow' };
}

function evidenceRows(out: Rows, explain: TaskExplain, show: TaskShow | null): void {
  const { pr, evidence } = explain;
  out.heading('Pull request and checks');
  out.field('PR', pr.ref === null ? [ui('none yet', DIM)] : [seg(pr.ref, BOLD)]);
  if (pr.head_sha !== null || pr.base_sha !== null) {
    out.field('Head', pr.head_sha ?? uiText('none yet'));
    out.field('Base', pr.base_sha ?? uiText('unknown'));
  }
  if (pr.observed !== null)
    out.field('On GitHub', [
      seg(pr.observed.status),
      ui(' at head ', DIM),
      seg(
        pr.observed.observed_head === null ? uiText('unknown') : short(pr.observed.observed_head),
      ),
    ]);
  if (pr.observation_expired)
    out.say('  Watching this PR has expired; a recheck reads it again.', WARN);
  const stale = (valid: boolean): Seg[] => (valid ? [] : [ui(' (no longer valid)', DIM)]);

  if (evidence.gates.length === 0) out.field('Gates', [ui('none yet', DIM)]);
  for (const g of evidence.gates) {
    out.field('Gates', [
      ui(g.passed ? '✓ passed' : '✗ failed', g.passed ? GOOD : BAD),
      ui(' · ', DIM),
      seg(g.step),
      ui(` visit ${g.visit}`, DIM),
      ...stale(g.valid),
    ]);
    for (const f of g.failed ?? []) {
      out.field('', [ui('✗ ', BAD), seg(f.gate)]);
      if (f.log_excerpt !== null)
        out.line([ui(''.padEnd(LABEL + 4)), seg(f.log_excerpt, DIM)], LABEL + 4);
    }
  }
  if (evidence.ci.length === 0) out.field('CI', [ui('nothing read yet', DIM)]);
  for (const c of evidence.ci)
    out.field('CI', [
      ...c.checks.flatMap((k, i) => [
        ...(i === 0 ? [] : [ui('   ')]),
        ui('● ', checkStyle(k.state)),
        seg(joinSafe([k.name, uiText(': '), k.state]), checkStyle(k.state)),
      ]),
      ...(c.checks.length === 0 ? [ui('no checks', DIM)] : []),
      ui('   on head ', DIM),
      seg(short(c.head_sha), DIM),
      ...stale(c.valid),
    ]);

  // Whether review belongs to this run is the daemon's word; a mode without it never reads as passed.
  const config = show?.run_config ?? null;
  const review = config?.review ?? null;
  if (review === 'not_run_by_mode' && config !== null)
    out.field('Review', [ui('not required by ', DIM), seg(config.selection.mode, DIM)]);
  else out.field('Review', [ui(review === 'required' ? 'required' : 'not decided yet', DIM)]);
  for (const r of evidence.reviews)
    out.field('', [
      seg(r.verdict, BOLD),
      ui(' on head ', DIM),
      seg(short(r.head_sha), DIM),
      ...stale(r.valid),
    ]);

  const { wait } = explain;
  // The daemon waits for a merge only once the head is green; this says what it holds, it decides nothing.
  if (wait?.detail.code === 'merge' && typeof wait.detail['head_sha'] === 'string')
    out.line([
      ui('  Green on head ', GOOD),
      seg(sanitize(wait.detail['head_sha']), GOOD),
      ui(': the daemon is waiting for the merge of this head.'),
    ]);
}

function agentRows(out: Rows, explain: TaskExplain, show: TaskShow | null): void {
  out.heading('Agents and usage');
  if (explain.bindings_used.length === 0) out.say('  No attempts requested yet.', DIM);
  for (const b of explain.bindings_used)
    out.field(b.step, [
      seg(b.binding),
      ui(` · rung ${b.rung} · requested ${b.requested} · invoked ${b.invoked}`, DIM),
    ]);
  for (const e of explain.escalations)
    out.field(
      'Escalated',
      [seg(e.step), ui(` · rung ${e.from} to ${e.to} · `, DIM), seg(e.reason)],
      WARN,
    );
  for (const a of show?.provenance.usage ?? [])
    out.field('Attempt', [
      ui(`${shortAttempt(a.attempt_id)} · `, DIM),
      seg(a.step),
      ui(' · ', DIM),
      seg(a.binding),
      ui(` · usage ${usageWords(a.usage)}`, DIM),
    ]);
  for (const e of explain.pending_effects)
    out.field('In progress', [seg(e.kind), ui(' '), seg(e.status, DIM)]);
}

function runConfigRows(out: Rows, show: TaskShow | null): void {
  const config = show?.run_config ?? null;
  if (config === null) return;
  const { selection } = config;
  out.heading('Run configuration');
  out.field('Profile', [
    seg(selection.profile),
    ui(' · ', DIM),
    seg(selection.mode),
    ui(' · ', DIM),
    seg(sanitize(config.status), DIM),
  ]);
  out.field('Worker', choice(selection.worker));
  out.field(
    'Reviewer',
    selection.reviewer === null
      ? [ui('none, ', DIM), seg(selection.mode, DIM), ui(' has no reviewer', DIM)]
      : [seg(choice(selection.reviewer))],
  );
  if (selection.fallbacks.length > 0)
    out.field('Fallbacks', joinSafe(selection.fallbacks.map(choice), uiText(', ')));
}

function limitRows(out: Rows, explain: TaskExplain): void {
  const { remaining, deadline, slot } = explain;
  out.heading('Limits');
  if (!explain.limits_frozen)
    out.say('  Limits are not frozen yet: the task has not started.', DIM);
  out.field('Agent runs', [
    ui(`${remaining.agent_runs} left`),
    ui(` (${remaining.reserved} reserved)`, DIM),
  ]);
  out.field('Escalations', [ui(`${remaining.escalations} left`)]);
  if (explain.blockers.length === 0) out.field('Blockers', [ui('none', DIM)]);
  if (deadline.state === 'passed') out.field('Time left', [ui('none, the deadline passed', BAD)]);
  else if (deadline.state === 'running')
    out.field('Time left', [
      ui(deadline.remaining_ms === null ? 'unavailable' : formatDuration(deadline.remaining_ms)),
    ]);
  else
    out.field('Time limit', [
      ui(
        deadline.max_wall_ms === null
          ? 'unavailable'
          : `${formatDuration(deadline.max_wall_ms)}, not started`,
      ),
    ]);
  out.field('Slot wait', [
    ui(
      `${formatDuration(slot.initial_wait_ms)} first, ${formatDuration(slot.resumed_wait_ms)} resumed`,
    ),
    ...(slot.holding ? [ui(' · holds the execution slot', { fg: 'cyan' })] : []),
  ]);
  if (slot.queued !== null)
    out.field('Queue', [
      ui(
        slot.queued.position === null ? 'position unavailable' : `position ${slot.queued.position}`,
      ),
    ]);
  for (const p of explain.prerequisites)
    out.field('Prerequisite', [
      seg(sanitize(p.task_id), DIM),
      ui(' · '),
      seg(p.status),
      ...(p.unverified === null ? [] : [ui(' · '), seg(p.unverified.reason, WARN)]),
    ]);
}

function mergeRows(out: Rows, explain: TaskExplain, show: TaskShow | null): void {
  const { merge, cancellation, merge_cleanup: cleanup } = explain;
  const completion = show?.completion ?? null;
  const manual = explain.allowed_actions.some((a) => a.action === 'merge_manually');
  if (merge === null && completion === null && cancellation === null && !manual && cleanup === null)
    return;
  out.heading('Merge');
  if (manual)
    out.line(
      [
        ui(
          '  Merge this PR yourself on GitHub. Cuesura does not merge, and this task is not done until that merge is seen.',
          WARN,
        ),
      ],
      2,
    );
  if (merge !== null) {
    out.field('Method', merge.method ?? uiText('unknown'));
    if (merge.proposed !== null) {
      out.field('Title', merge.proposed.title);
      out.field('Message', merge.proposed.message);
    }
    if (merge.observed_method !== null) out.field('Method used', merge.observed_method);
  }
  if (completion !== null) {
    out.field('Merged head', completion.merged_head_sha);
    out.field('Checked head', completion.checked_head_sha ?? uiText('none'));
    out.field('Merge commit', completion.merge_commit_sha ?? uiText('unknown'));
    if (completion.unverified !== null)
      out.line(
        [
          ui('  '),
          seg(completion.unverified.reason, WARN),
          ui(
            ': this merge is not certified, the head merged is not shown to be the head checked.',
            WARN,
          ),
        ],
        2,
      );
  }
  if (cleanup !== null)
    for (const o of cleanup.pending_operations)
      out.field('Cleaning up', [seg(o.kind), ui(' '), seg(o.status, DIM)]);
  // Once a merge is proved the cancel has lost, whether or not the daemon has written that down yet.
  if (cancellation !== null)
    out.line(
      [
        ui(
          cancellation.late || completion !== null
            ? '  Cancel arrived too late: the merge had already happened, so this task does not end cancelled.'
            : '  Cancel requested: it stops and reconciles first; the status above is the daemon’s.',
          WARN,
        ),
      ],
      2,
    );
}

function referenceRows(out: Rows, d: TaskDetail): void {
  const show = d.show.data;
  const explain = d.explain.data;
  out.heading('Reference', DIM);
  out.field('ID', sanitize(d.taskId));
  const version = explain?.version ?? show?.version;
  const revision = explain?.revision ?? show?.revision;
  if (version !== undefined) out.field('Version', [ui(`${version} · revision ${revision}`)]);
  const worktree = d.progress.data?.worktree_path ?? null;
  if (worktree !== null) out.field('Worktree', worktree);
  if (d.explain.readAt !== null) out.field('Read at', [ui(clockTime(d.explain.readAt))]);
}

function historyRows(out: Rows, d: TaskDetail): void {
  const h = d.history;
  out.heading('History', DIM);
  if (h.dropped > 0)
    out.say(`  ${h.dropped} earlier events are not kept here: see cusr task history`, DIM);
  if (h.events.length === 0 && h.attemptAt === null) out.say('  Reading…', DIM);
  // One row each however long the payload, cut when drawn: a long history must not cost a wrap per frame.
  for (const e of h.events)
    out.rows.push([
      ui(`  #${e.seq} `.padEnd(8), DIM),
      seg(e.type),
      ui(' by ', DIM),
      seg(e.actor),
      ui('  '),
      seg(e.payload, DIM),
    ]);
}

let memo: {
  readonly d: TaskDetail;
  readonly cols: number;
  readonly stale: boolean;
  readonly rows: readonly Seg[][];
} | null = null;

function detailRows(d: TaskDetail, cols: number, stale: boolean): readonly Seg[][] {
  if (memo?.d === d && memo.cols === cols && memo.stale === stale) return memo.rows;
  const out = new Rows(cols);
  aboutRows(out, d, stale);
  progressRows(out, d);
  const explain = d.explain.data;
  if (explain === null) {
    out.heading('Why');
    out.say('  Reading…', DIM);
  } else {
    whyRows(out, explain);
    exitRows(out, explain);
    evidenceRows(out, explain, d.show.data);
    mergeRows(out, explain, d.show.data);
    agentRows(out, explain, d.show.data);
  }
  runConfigRows(out, d.show.data);
  if (explain !== null) limitRows(out, explain);
  referenceRows(out, d);
  historyRows(out, d);
  memo = { d, cols, stale, rows: out.rows };
  return out.rows;
}

export const detailRowCount = (s: TuiState): number =>
  s.detail === null
    ? 0
    : detailRows(s.detail, s.size.cols, s.staleTasks.has(s.detail.taskId)).length;

export const detailBody =
  (s: TuiState): Body =>
  (frame, top, height) => {
    if (s.detail === null || height <= 0) return;
    const rows = detailRows(s.detail, s.size.cols, s.staleTasks.has(s.detail.taskId));
    const first = Math.min(s.detail.top, Math.max(0, rows.length - height));
    rows.slice(first, first + height).forEach((row, i) => {
      putSegs(frame, MARGIN, top + i, row, s.size.cols - MARGIN);
    });
  };
