/**
 * Task detail: where a task stands, why, and how out (FR-011–FR-013, FR-015, US2). Everything about waits, exits,
 * blockers and limits is what `task_explain` said, written out; nothing here works out a state of its own
 * (FR-012). Sections without anything to say are left out. The rows are kept whole, so a resize loses nothing
 * and the screen scrolls by row. Codes, hashes and counters that only mean something to whoever digs in stay
 * behind `i` (`technical`): the screen first says what a person acts on.
 */
import { isTerminal, type TaskStatus } from '../../domain/state.ts';
import { activity, statusMark, todo } from '../model/activity.ts';
import { stepName } from '../model/attempt-tree.ts';
import { ending, type TaskDetail } from '../model/detail.ts';
import { shortAttempt } from '../model/logs.ts';
import { progressStages } from '../model/stages.ts';
import type { TuiState } from '../model/state.ts';
import type { TaskExplain, TaskProgress, TaskShow } from '../client/schemas.ts';
import { joinSafe, sanitize, sanitizeLines, uiText, type SafeText } from '../terminal/safe-text.ts';
import type { Style } from '../terminal/screen.ts';
import { displayWidth } from '../terminal/width.ts';
import { pausedText } from './dialog.ts';
import { clockTime, type Body } from './layout.ts';
import { BOLD, DIM, putSegs, ruleHeading, seg, ui, wrapSegs, type Seg } from './ink.ts';
import { endBadge, stepper } from './stepper.ts';
import { ACTIVE, BAD, FOCUS, GOOD, NOTICE, WARN } from './theme.ts';

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

const left = (count: number | null): string => (count === null ? 'no limit' : `${count} left`);

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
  // Said here, not only as a wait: a paused task may be waiting on CI or an answer as well.
  const paused = explain?.paused ?? null;
  if (paused !== null) out.line([ui('‖ ', WARN), seg(pausedText(paused), NOTICE)]);
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

/** A section with nothing to show yet: still on its way, or its read failed and is being retried. */
function missing(out: Rows, failed: boolean): void {
  if (failed) out.say('  Could not be read.', WARN);
  else out.say('  Reading…', DIM);
}

function progressRows(out: Rows, d: TaskDetail): void {
  const progress = d.progress.data;
  const explain = d.explain.data;
  const status = explain?.status ?? d.show.data?.status;
  out.heading('Progress');
  if (progress === null || status === undefined) {
    const noStatus = d.explain.error !== null && d.show.error !== null;
    missing(out, progress === null ? d.progress.error !== null : noStatus);
    return;
  }
  if (progress.steps === null)
    out.line([
      ui('  Steps are not known yet', DIM),
      ...(progress.reason === null
        ? []
        : [
            ui(': ', DIM),
            seg(
              progress.reason !== 'not_frozen'
                ? progress.reason
                : uiText(isTerminal(status) ? 'it never started' : 'it has not started'),
            ),
          ]),
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

/** A long description is cut on the plain screen so it never pushes what to do far down; `i` shows it whole. */
const DESCRIPTION_ROWS = 6;

function itemRows(out: Rows, label: string, items: readonly SafeText[]): void {
  items.forEach((item, i) => {
    const head = (i === 0 ? `  ${label}` : '').padEnd(LABEL + 2);
    out.line([ui(head, DIM), ui('• ', DIM), seg(item)], LABEL + 4);
  });
}

function requestRows(out: Rows, d: TaskDetail): void {
  const content = d.content.data;
  out.heading('Request');
  if (content === null) {
    if (d.content.error === null) out.say('  Reading…', DIM);
    else out.line([ui('  Could not be read: ', WARN), seg(d.content.error, WARN)], 2);
    return;
  }
  if (content.description !== '') {
    const rows = wrapSegs([ui('  '), seg(content.description)], out.width, 2);
    const cut = !d.technical && rows.length > DESCRIPTION_ROWS + 1;
    out.rows.push(...(cut ? rows.slice(0, DESCRIPTION_ROWS) : rows));
    if (cut)
      out.say(
        `  … ${rows.length - DESCRIPTION_ROWS} more lines: press i to see the whole request`,
        DIM,
      );
    out.rows.push([]);
  }
  itemRows(out, 'Requirements', content.requirements);
  if (content.acceptance.length === 0) out.field('Acceptance', [ui('none', DIM)]);
  else itemRows(out, 'Acceptance', content.acceptance);
  if (!d.technical) return;
  itemRows(out, 'Constraints', content.constraints);
  itemRows(out, 'Out of scope', content.out_of_scope);
  out.field('Base branch', content.base_branch);
}

function valueText(value: unknown): SafeText {
  return sanitizeLines(typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null'));
}

function whyRows(out: Rows, explain: TaskExplain): void {
  const { wait } = explain;
  if (wait === null && explain.blockers.length === 0) return;
  out.heading(wait === null ? 'Why' : 'Why it is waiting', DIM);
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
    out.field(actionName(a.action), a.note, FOCUS);
    if (a.command !== null)
      out.line([ui(''.padEnd(LABEL + 2)), ui('$ ', DIM), seg(a.command, DIM)], LABEL + 4);
  }
  if (explain.allowed_actions.length === 0) out.say('  None right now.', DIM);
}

function checkStyle(state: string): Style {
  if (/^(success|passed?|ok|neutral|skipped)$/i.test(state)) return GOOD;
  if (/^(failure|failed|fail|error|cancelled|timed_out)$/i.test(state)) return BAD;
  return NOTICE;
}

const EXCERPT_LINES = 20;

/** The end of a failure's excerpt: the page is for the state of the task, not for reading a log. */
export const lastLines = (text: SafeText): SafeText =>
  sanitizeLines(text.split('\n').slice(-EXCERPT_LINES).join('\n'));

function evidenceRows(
  out: Rows,
  explain: TaskExplain,
  show: TaskShow | null,
  technical: boolean,
): void {
  const { pr, evidence } = explain;
  const config = show?.run_config ?? null;
  const review = config?.review ?? null;
  // Nothing to say yet is left out; whether review applies at all is said once there is a PR to review.
  if (
    !technical &&
    pr.ref === null &&
    evidence.gates.length === 0 &&
    evidence.ci.length === 0 &&
    evidence.reviews.length === 0
  )
    return;
  out.heading('Pull request and checks');
  out.field('PR', pr.ref === null ? [ui('none yet', DIM)] : [seg(pr.ref, BOLD)]);
  if (technical && (pr.head_sha !== null || pr.base_sha !== null)) {
    out.field('Head', pr.head_sha ?? uiText('none yet'));
    out.field('Base', pr.base_sha ?? uiText('unknown'));
  }
  if (pr.observed !== null)
    out.field('On GitHub', [
      seg(pr.observed.status),
      ...(technical
        ? [
            ui(' at head ', DIM),
            seg(
              pr.observed.observed_head === null
                ? uiText('unknown')
                : short(pr.observed.observed_head),
            ),
          ]
        : []),
    ]);
  if (pr.observation_expired)
    out.say('  Watching this PR has expired; a recheck reads it again.', WARN);
  const stale = (valid: boolean): Seg[] => (valid ? [] : [ui(' (no longer valid)', DIM)]);
  const onHead = (sha: SafeText): Seg[] =>
    technical ? [ui(' on head ', DIM), seg(short(sha), DIM)] : [];

  if (evidence.gates.length === 0) out.field('Gates', [ui('none yet', DIM)]);
  for (const g of evidence.gates) {
    out.field('Gates', [
      ui(g.passed ? '✓ passed' : '✗ failed', g.passed ? GOOD : BAD),
      ...(technical ? [ui(' · ', DIM), seg(g.step), ui(` visit ${g.visit}`, DIM)] : []),
      ...stale(g.valid),
    ]);
    for (const f of g.failed ?? []) {
      out.field('', [ui('✗ ', BAD), seg(f.gate)]);
      if (f.log_excerpt !== null)
        out.line([ui(''.padEnd(LABEL + 4)), seg(lastLines(f.log_excerpt), DIM)], LABEL + 4);
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
      ...onHead(c.head_sha),
      ...stale(c.valid),
    ]);

  // Whether review belongs to this run is the daemon's word; a mode without it never reads as passed.
  if (review === 'not_run_by_mode' && config !== null)
    out.field('Review', [ui('not required by ', DIM), seg(config.selection.mode, DIM)]);
  else out.field('Review', [ui(review === 'required' ? 'required' : 'not decided yet', DIM)]);
  for (const r of evidence.reviews)
    out.field('', [seg(r.verdict, BOLD), ...onHead(r.head_sha), ...stale(r.valid)]);

  const { wait } = explain;
  // The daemon waits for a merge only once the head is green; this says what it holds, it decides nothing.
  if (wait?.detail.code === 'merge' && typeof wait.detail['head_sha'] === 'string')
    if (technical)
      out.line([
        ui('  Green on head ', GOOD),
        seg(sanitize(wait.detail['head_sha']), GOOD),
        ui(': the daemon is waiting for the merge of this head.'),
      ]);
    else out.say('  All checks passed on the latest commit.', GOOD);
}

const runs = (n: number): string => `${n} ${n === 1 ? 'run' : 'runs'}`;

function agentRows(
  out: Rows,
  explain: TaskExplain,
  show: TaskShow | null,
  technical: boolean,
): void {
  if (!technical && explain.bindings_used.length === 0 && explain.escalations.length === 0) return;
  out.heading(technical ? 'Agents and usage' : 'Agents');
  if (explain.bindings_used.length === 0) out.say('  No attempts requested yet.', DIM);
  for (const b of explain.bindings_used)
    out.field(technical ? b.step : stepName(b.step), [
      seg(b.binding),
      ui(
        technical
          ? ` · rung ${b.rung} · requested ${b.requested} · invoked ${b.invoked}`
          : ` · ${runs(b.invoked)}`,
        DIM,
      ),
    ]);
  for (const e of explain.escalations)
    if (technical)
      out.field(
        'Escalated',
        [seg(e.step), ui(` · rung ${e.from} to ${e.to} · `, DIM), seg(e.reason)],
        WARN,
      );
    else out.field('Stronger model', [seg(stepName(e.step))], WARN);
  if (!technical) return;
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

function runConfigRows(out: Rows, show: TaskShow | null, technical: boolean): void {
  const config = show?.run_config ?? null;
  if (config === null) return;
  const { selection } = config;
  out.heading('Run configuration');
  out.field('Profile', [
    seg(selection.profile),
    ui(' · ', DIM),
    seg(selection.mode),
    ...(technical ? [ui(' · ', DIM), seg(sanitize(config.status), DIM)] : []),
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
  const reviewerFallbacks = selection.reviewer_fallbacks ?? [];
  if (reviewerFallbacks.length > 0)
    out.field('Reviewer fallbacks', joinSafe(reviewerFallbacks.map(choice), uiText(', ')));
}

/** What is left and its place in the queue; a task that ended or never started has none of it. */
function plainLimitRows(out: Rows, explain: TaskExplain): void {
  const { remaining, deadline, slot } = explain;
  const running = explain.limits_frozen && !isTerminal(explain.status);
  if (!running && slot.queued === null && explain.prerequisites.length === 0) return;
  out.heading('Limits');
  if (running) {
    out.field('Agent runs', [ui(left(remaining.agent_runs))]);
    if (deadline.state === 'passed') out.field('Time left', [ui('none, the deadline passed', BAD)]);
    else if (deadline.state === 'running' && deadline.remaining_ms !== null)
      out.field('Time left', [ui(formatDuration(deadline.remaining_ms))]);
  }
  if (slot.queued?.position !== null && slot.queued?.position !== undefined)
    out.field('Queue', [ui(`position ${slot.queued.position}`)]);
  for (const p of explain.prerequisites)
    out.field('Waits for', [seg(sanitize(p.task_id), DIM), ui(' · '), seg(p.status)]);
}

const HOLD_TEXT = {
  running: 'holds the execution slot',
  reserved: 'keeps the execution slot reserved while it waits',
  borrowed: "runs on another task's reserved slot",
} as const;

function limitRows(out: Rows, explain: TaskExplain): void {
  const { remaining, deadline, slot } = explain;
  out.heading('Limits');
  if (!explain.limits_frozen)
    out.say('  Limits are not frozen yet: the task has not started.', DIM);
  out.field('Agent runs', [
    ui(left(remaining.agent_runs)),
    ui(` (${remaining.reserved} reserved)`, DIM),
  ]);
  out.field('Escalations', [ui(left(remaining.escalations))]);
  if (explain.blockers.length === 0) out.field('Blockers', [ui('none', DIM)]);
  if (deadline.state === 'passed') out.field('Time left', [ui('none, the deadline passed', BAD)]);
  else if (deadline.state === 'ended') out.field('Time left', [ui('none, the task ended', DIM)]);
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
    ...(slot.holding ? [ui(` · ${HOLD_TEXT[slot.hold?.kind ?? 'running']}`, ACTIVE)] : []),
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

function mergeRows(
  out: Rows,
  explain: TaskExplain,
  show: TaskShow | null,
  technical: boolean,
): void {
  const { merge, cancellation: asked, merge_cleanup: cleanup } = explain;
  const completion = show?.completion ?? null;
  const manual = explain.allowed_actions.some((a) => a.action === 'merge_manually');
  // Once it ended cancelled, that the cancel was asked for is history: the status already says how it went.
  const cancellation = explain.status === 'CANCELLED' ? null : asked;
  if (merge === null && completion === null && cancellation === null && !manual && cleanup === null)
    return;
  const mergeNews = merge !== null || completion !== null || manual || cleanup !== null;
  out.heading(mergeNews ? 'Merge' : 'Cancelling');
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
    if (technical) {
      out.field('Merged head', completion.merged_head_sha);
      out.field('Checked head', completion.checked_head_sha ?? uiText('none'));
    }
    out.field(
      'Merge commit',
      technical
        ? (completion.merge_commit_sha ?? uiText('unknown'))
        : short(completion.merge_commit_sha ?? uiText('unknown')),
    );
    if (completion.unverified !== null && !technical)
      out.say('  Could not verify that what was merged is what was checked.', WARN);
    if (completion.unverified !== null && technical)
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
  if (cleanup !== null && technical)
    for (const o of cleanup.pending_operations)
      out.field('Cleaning up', [seg(o.kind), ui(' '), seg(o.status, DIM)]);
  // Once a merge is proved the cancel has lost, whether or not the daemon has written that down yet.
  if (cancellation !== null)
    out.line(
      [
        ui(
          cancellation.late || completion !== null
            ? '  Cancel arrived too late: the merge had already happened, so this task does not end cancelled.'
            : '  Cancel requested: the task stops safely first, so this can take a moment.',
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
  const { technical } = d;
  const out = new Rows(cols);
  aboutRows(out, d, stale);
  progressRows(out, d);
  const explain = d.explain.data;
  if (explain === null) {
    out.heading('Why');
    missing(out, d.explain.error !== null);
  } else exitRows(out, explain);
  requestRows(out, d);
  if (explain !== null) {
    evidenceRows(out, explain, d.show.data, technical);
    mergeRows(out, explain, d.show.data, technical);
    agentRows(out, explain, d.show.data, technical);
  }
  runConfigRows(out, d.show.data, technical);
  if (explain !== null) {
    if (technical) {
      whyRows(out, explain);
      limitRows(out, explain);
    } else plainLimitRows(out, explain);
  }
  if (technical) {
    referenceRows(out, d);
    historyRows(out, d);
  }
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
