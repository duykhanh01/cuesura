/**
 * Logs: the task's log one step at a time, the latest live or an earlier attempt (FR-014, EC-011). What the reader is looking at stays while new
 * records come: this only says that they came. Only the rows on screen are worked out, however long the buffer.
 */
import { activity, duration, todo } from '../model/activity.ts';
import {
  cursorIndex,
  formatTokens,
  groupAttempts,
  groupFlow,
  rowStage,
  stepName,
  tokensOf,
  treeRows,
  type Attempt,
  type TreeRow,
} from '../model/attempt-tree.ts';
import { pickerGroups } from '../model/detail-keys.ts';
import { QUIET_MS, STUCK_MS } from '../model/gates.ts';
import { ending } from '../model/detail.ts';
import { progressStages, STAGE_LABEL, stageOf, type StageName } from '../model/stages.ts';
import {
  LOG_HEADER_ROWS,
  logColumns,
  logRows,
  visibleRows,
  type LogRow,
  type LogState,
} from '../model/logs.ts';
import type { TuiState } from '../model/state.ts';
import { joinSafe, sanitize, uiText, type SafeText } from '../terminal/safe-text.ts';
import type { Frame, Style } from '../terminal/screen.ts';
import type { Tone } from '../model/log-text.ts';
import { graphemes, truncate } from '../terminal/width.ts';
import { BOLD, DIM, putSegs, seg, segsWidth, ui, wrapSegs, type Seg } from './ink.ts';
import { gatesBody, gatesModeLine, gatesNews } from './gates.ts';
import { endBadge, leadsOn, stageLook, stepperRow } from './stepper.ts';
import type { Body } from './layout.ts';
import { ACTIVE, BAD, BAD_STRONG, FOCUS, GOOD, GOOD_STRONG, NOTICE, WARN } from './theme.ts';

const ROW_STYLE: Readonly<Record<LogRow['kind'], Style>> = {
  record: {},
  separator: FOCUS,
  gap: WARN,
};

/** The mark and the text of a record by what it says. */
const TONE: Readonly<Record<Tone, { mark: Style; body: Style }>> = {
  say: { mark: { bold: true }, body: {} },
  tool: { mark: GOOD_STRONG, body: {} },
  result: { mark: DIM, body: DIM },
  ok: { mark: GOOD, body: DIM },
  error: { mark: BAD_STRONG, body: BAD },
  warn: { mark: WARN, body: NOTICE },
  info: { mark: DIM, body: DIM },
};

function drawRow(frame: Frame, x0: number, y: number, row: LogRow, cols: number): void {
  if (row.kind !== 'record' || row.head === undefined || row.tone === undefined) {
    frame.put(x0, y, truncate(row.text, cols), ROW_STYLE[row.kind]);
    return;
  }
  const tone = TONE[row.tone];
  if (row.segs !== undefined) {
    frame.put(
      x0,
      y,
      truncate(uiText(graphemes(row.text).slice(0, row.head).join('')), cols),
      tone.mark,
    );
    putSegs(frame, x0 + row.head, y, row.segs, Math.max(0, cols - row.head), tone.body);
    return;
  }
  const chars = graphemes(row.text);
  const strong = row.strong ?? 0;
  const part = (from: number, to?: number): SafeText => uiText(chars.slice(from, to).join(''));
  frame.put(x0, y, truncate(part(0, row.head), cols), tone.mark);
  frame.put(x0 + row.head, y, truncate(part(row.head, row.head + strong), cols - row.head), {
    ...tone.body,
    bold: true,
  });
  const x = row.head + strong;
  frame.put(x0 + x, y, truncate(part(x), Math.max(0, cols - x)), tone.body);
}

/**
 * How long a running task followed live has said nothing, up to the last read, so a screen that lost the daemon
 * does not count on. Only a log being followed has an answer: a paused one or one attempt stopped reading on.
 */
function quietFor(s: LogState, t: TuiState): number | null {
  const status = t.detail?.explain.data?.status ?? t.detail?.show.data?.status;
  if (status !== 'RUNNING' || s.mode !== 'live' || s.attemptFilter !== null) return null;
  if (s.lastOutputAt === null || s.lastReadAt === null) return null;
  return s.lastReadAt - s.lastOutputAt;
}

function followState(s: LogState): string {
  if (s.complete) return 'Finished';
  if (s.mode === 'live') return 'Live';
  return s.scrolledAway ? 'Scrolled up' : 'Paused';
}

/** What is being read, and which lines when the buffer holds only part of it. */
function modeLine(s: LogState, t: TuiState): SafeText {
  if (s.gates !== null) return gatesModeLine(s.gates);
  const parts: SafeText[] = [];
  if (s.attemptFilter === null) parts.push(uiText(`${followState(s)} · latest step`));
  else {
    const a = t.detail?.show.data?.provenance.usage.find((u) => u.attempt_id === s.attemptFilter);
    parts.push(
      a === undefined ? uiText('One attempt') : joinSafe([stepName(a.step), a.binding], ' · '),
    );
  }
  const first = s.buffer[0];
  const last = s.buffer.at(-1);
  if (first !== undefined && last !== undefined && (s.windowStart > 0 || s.moreForward))
    parts.push(uiText(`lines ${first.seq}–${last.seq}`));
  if (s.windowStart > 0) parts.push(uiText('earlier lines: ↑ at the top reads them'));
  if (s.expanded) parts.push(uiText('full output'));
  const quiet = quietFor(s, t);
  if (quiet !== null && quiet >= QUIET_MS && quiet < STUCK_MS)
    parts.push(uiText(`last output ${duration(quiet) ?? ''} ago`));
  return joinSafe(parts, ' · ');
}

/** Only scrolling left the end, so that is where to look: it shows under the log, not up in the header. */
const newBelow = (s: LogState): boolean => s.newActivity && s.scrolledAway;

function newsLine(s: LogState, t: TuiState): SafeText {
  if (s.gates !== null) return gatesNews(s.gates);
  if (s.error !== null) return joinSafe([uiText('Could not read the log: '), s.error]);
  if (s.newActivity && !s.scrolledAway)
    return uiText(
      s.attemptFilter === null
        ? 'New activity: Space follows the log live'
        : 'New activity: → next step, Space follows the log live',
    );
  if (s.filling || s.older !== null) return uiText('Reading…');
  const quiet = quietFor(s, t);
  if (quiet !== null && quiet >= STUCK_MS)
    return uiText(`No output for ${duration(quiet) ?? ''}: it may be stuck`);
  return uiText('');
}

/** The stages in one row, where there is no room for a column of them. */
function stagesRow(s: TuiState, cols: number): Seg[] | null {
  const d = s.detail;
  const status = d?.explain.data?.status ?? d?.show.data?.status;
  const steps = d?.progress.data?.steps ?? null;
  if (steps === null || status === undefined) return null;
  const stages = progressStages(steps, status);
  return stages === null ? null : stepperRow(stages, status, cols);
}

/** The attempt being read, or the row chosen in the chooser, by its stage, so the progress column can point at it. */
function filteredStage(s: TuiState): StageName | null {
  const logs = s.logs;
  if (logs?.gates != null && logs.picker === null) return 'gates';
  if (logs !== null && logs.picker !== null) {
    const groups = pickerGroups(s);
    const rows = treeRows(groups, logs.pickerOpen);
    const row = rows[cursorIndex(rows, logs.picker)];
    return row === undefined ? null : rowStage(row, groups);
  }
  const id = logs?.attemptFilter ?? null;
  if (id === null) return null;
  const attempt = s.detail?.show.data?.provenance.usage.find((a) => a.attempt_id === id);
  return attempt === undefined ? null : stageOf(attempt.step);
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * The task's stages top to bottom as a timeline, what it is doing now, what it waits on the user for, and
 * which part of the log is shown. The running stage turns; the line between stages is solid where the
 * task has passed. Without room for the lines between stages, the stages sit one under another.
 */
function progressPane(frame: Frame, s: TuiState, top: number, height: number, width: number): void {
  const d = s.detail;
  const status = d?.explain.data?.status ?? d?.show.data?.status;
  const steps = d?.progress.data?.steps ?? null;
  const stages = steps === null || status === undefined ? null : progressStages(steps, status);
  const head: Seg[][] = [];
  const timeline: Seg[][] = [];
  const tail: Seg[][] = [];

  const progress = d?.progress.data ?? null;
  if (stages === null || status === undefined) {
    head.push([ui('Progress', BOLD)], []);
    if (progress === null) timeline.push([ui('Reading…', DIM)]);
    else if (progress.steps === null)
      // Not frozen yet, say: there are no steps to show, which is an answer, not a wait.
      timeline.push([ui('No steps yet', DIM)]);
    // A workflow whose steps this does not know: each step as the daemon gave it.
    else
      for (const step of progress.steps)
        timeline.push([
          ui(' '),
          ui(
            step.state === 'past'
              ? '✓  '
              : step.state === 'current'
                ? '●  '
                : step.state === 'not_required'
                  ? '–  '
                  : '○  ',
            DIM,
          ),
          seg(step.name),
        ]);
  } else {
    const counted = stages.filter((st) => st.state !== 'skipped');
    const done = counted.filter((st) => st.state === 'done').length;
    const count = `${done}/${counted.length}`;
    // A task that ended says so beside the count, so the header alone tells an end from a pause.
    const badge = endBadge(status);
    const right =
      badge === null
        ? [ui(count, DIM)]
        : badge.text.length + count.length + 3 <= width - 11
          ? [badge, ui(` · ${count}`, DIM)]
          : [badge];
    const used = right.reduce((n, r) => n + r.text.length, 0);
    head.push(
      [ui('Progress', BOLD), ui(' '.repeat(Math.max(1, width - 9 - used - 1))), ...right],
      [],
    );
    const pointed = filteredStage(s);
    stages.forEach((stage, i) => {
      const look = stageLook(stage, status);
      const turning = stage.state === 'current' && status === 'RUNNING';
      const mark = turning ? (SPINNER[s.tick % SPINNER.length] ?? look.mark) : look.mark;
      const here = pointed === stage.name;
      const strong = here || stage.state === 'current';
      const faint = stage.state === 'todo' || stage.state === 'abandoned';
      timeline.push([
        ui(here ? '▸' : ' ', FOCUS),
        ui(`${mark}  `, look.style),
        ui(STAGE_LABEL[stage.name], {
          ...(faint ? DIM : stage.state === 'done' ? {} : look.style),
          ...(strong ? { bold: true } : {}),
        }),
        ui(stage.runs > 1 ? `  ×${stage.runs}` : '', DIM),
        ui(look.word === null ? '' : `  ${look.word}`, look.style),
      ]);
      const next = stages[i + 1];
      if (next !== undefined) {
        const passed = stage.state === 'done';
        // The path stops where the task ended; the empty row keeps every stage on its own line.
        if (!leadsOn(stage.state)) timeline.push([]);
        else timeline.push([ui(' '), ui(passed ? '│' : '╎', passed ? GOOD : DIM)]);
      }
    });
  }
  // What the task does and needs is the explanation's word, whether or not its stages are known.
  const explain = d?.explain.data ?? null;
  if (explain !== null) {
    const row = {
      status: explain.status,
      wait_code: explain.wait?.detail.code ?? null,
      step: explain.step,
      mode: d?.progress.data?.mode ?? null,
      needs_user: d?.progress.data?.needs_user ?? false,
    };
    const over = endBadge(explain.status) !== null;
    const end = over && d !== null ? ending(d) : null;
    tail.push([], [ui(over ? 'Ended' : 'Now', BOLD)]);
    tail.push(
      ...wrapSegs(
        [
          seg(activity(row)),
          ...(end === null ? [] : [seg(joinSafe([uiText(' by '), end.actor]), DIM)]),
        ],
        width - 1,
      ),
    );
    if (end !== null && end.reason !== null)
      tail.push([], [ui('Reason', BOLD)], ...wrapSegs([seg(end.reason)], width - 1));
    // What can still be done about it, which for an ended task is the daemon's word too.
    if (over) {
      const commands = explain.allowed_actions.flatMap((a) =>
        a.command === null ? [] : [a.command],
      );
      if (commands.length > 0) tail.push([]);
      for (const command of commands)
        tail.push(...wrapSegs([ui('→ ', ACTIVE), seg(command)], width - 1, 2));
    }
    const action = todo(row);
    if (action !== null) {
      tail.push([], [ui('▲ Needs you', WARN)]);
      tail.push(...wrapSegs([seg(joinSafe([uiText('→ '), action]), WARN)], width - 1, 2));
    }
  }

  // Short of room, the lines between stages go first: the stages and what to do matter more.
  const fits = head.length + timeline.length + tail.length <= height;
  const stagesShown = fits ? timeline : timeline.filter((_, i) => stages === null || i % 2 === 0);
  [...head, ...stagesShown, ...tail]
    .slice(0, height)
    .forEach((segs, i) => putSegs(frame, 1, top + i, segs, width - 1));
}

const NAME_COLS = 24;
const BINDING_COLS = 14;
/** A step run this many times in a row is worth a look: a fix that does not hold. */
const RUN_WARN = 3;

const pad = (segs: readonly Seg[], cols: number): Seg[] => [
  ...segs,
  ui(' '.repeat(Math.max(1, cols - segsWidth(segs)))),
];

const TOKEN_COLS = 5;

const tokenSeg = (attempts: readonly Attempt[]): Seg[] => {
  const n = tokensOf(attempts);
  return [ui(n === null ? ' '.repeat(TOKEN_COLS) : formatTokens(n).padStart(TOKEN_COLS), DIM)];
};

/** The left and the right-aligned part of one chooser row. */
function pickerRow(
  row: TreeRow,
  ctx: { readonly reading: string | null; readonly running: string | null },
): { left: Seg[]; right: Seg[] } {
  switch (row.kind) {
    case 'live':
      return {
        left: [ui('  '), ui('Latest step'), ui(ctx.reading === null ? '  ◂ reading' : '', ACTIVE)],
        right: [],
      };
    case 'group': {
      const attempts = groupAttempts(row.group);
      const now = ctx.running !== null && attempts.some((a) => a.id === ctx.running);
      return {
        left: [
          ...pad(
            [
              ui(row.open ? '▾ ' : '▸ ', DIM),
              ui(row.group.title, row.open ? BOLD : {}),
              ui(now ? ' ●' : '', GOOD),
            ],
            NAME_COLS,
          ),
          seg(sanitize(groupFlow(row.group)), DIM),
        ],
        right: [
          ui(`${attempts.length} ${attempts.length === 1 ? 'run ' : 'runs'}`.padStart(7), DIM),
          ui('  '),
          ...tokenSeg(attempts),
        ],
      };
    }
    case 'run': {
      const n = row.run.attempts.length;
      const last = row.run.attempts.at(-1);
      return {
        left: [
          ...pad(
            [
              ui('  '),
              ui(row.open ? '▾ ' : '▸ ', DIM),
              seg(stepName(row.run.step)),
              ui(` ×${n}`, BOLD),
            ],
            NAME_COLS,
          ),
          ...(last === undefined ? [] : pad([seg(last.binding, DIM)], BINDING_COLS)),
          ui(n >= RUN_WARN ? `⚠ ${n} in a row` : '', NOTICE),
        ],
        right: tokenSeg(row.run.attempts),
      };
    }
    case 'attempt': {
      const a = row.attempt;
      const name = stepName(a.step);
      return {
        left: [
          ...pad(
            [
              ui(' '.repeat(row.depth * 2 + 2)),
              seg(row.ordinal === undefined ? name : joinSafe([name, uiText(` #${row.ordinal}`)])),
            ],
            NAME_COLS,
          ),
          ...pad([seg(a.binding, DIM)], BINDING_COLS),
          ui(a.id === ctx.running ? '  ● running' : '', GOOD),
          ui(a.id === ctx.reading ? '  ◂ reading' : '', ACTIVE),
        ],
        right: tokenSeg([a]),
      };
    }
  }
}

/**
 * The attempt chooser: a summary, then the rounds, each folded to one row unless unfolded. Moves only as far as
 * keeps the chosen row in sight.
 */
/** In place of what is being read, while the chooser is open: the row under it says that. */
function pickerSummary(s: TuiState): SafeText {
  const groups = pickerGroups(s);
  const all = groups.flatMap(groupAttempts);
  const rounds = groups.filter((g) => g.runs[0]?.step === 'review').length;
  const tokens = tokensOf(all);
  return uiText(
    [
      'Choose what to read',
      `${all.length} ${all.length === 1 ? 'attempt' : 'attempts'}`,
      ...(rounds > 0 ? [`${rounds} review ${rounds === 1 ? 'round' : 'rounds'}`] : []),
      ...(tokens === null ? [] : [`${formatTokens(tokens)} tokens`]),
    ].join(' · '),
  );
}

function pickerList(
  frame: Frame,
  s: TuiState,
  logs: LogState,
  x: number,
  top: number,
  room: number,
  width: number,
): void {
  const groups = pickerGroups(s);
  const all = groups.flatMap(groupAttempts);
  const status = s.detail?.explain.data?.status ?? s.detail?.show.data?.status;
  const ctx = {
    reading: logs.attemptFilter,
    running: status === 'RUNNING' ? (all.at(-1)?.id ?? null) : null,
  };
  const rows = treeRows(groups, logs.pickerOpen);
  const cursor = cursorIndex(rows, logs.picker);
  const area = room;
  if (area <= 0) return;
  // A row of its own under the latest step, which is not one of the rounds. `null` is that row.
  const lines = rows.flatMap((r, i): (TreeRow | null)[] =>
    i === 0 && rows.length > 1 ? [r, null] : [r],
  );
  const at = cursor === 0 ? 0 : cursor + 1;
  // One row past the chosen one stays in sight, so moving down shows what comes next.
  const first = Math.min(Math.max(0, at - area + 2), Math.max(0, lines.length - area));
  const inner = Math.max(0, width - 2);
  lines.slice(first, first + area).forEach((row, i) => {
    if (row === null) return;
    const y = top + i;
    const chosen = first + i === at;
    const { left, right } = pickerRow(row, ctx);
    const look = (segs: readonly Seg[]): Seg[] => (chosen ? highlight(segs) : [...segs]);
    if (chosen) frame.put(x, y, uiText('›'), FOCUS);
    const rightCols = segsWidth(right);
    const fitsRight = rightCols > 0 && inner - rightCols >= NAME_COLS + 2;
    putSegs(frame, x + 2, y, look(left), fitsRight ? inner - rightCols - 2 : inner);
    if (fitsRight) putSegs(frame, x + 2 + inner - rightCols, y, look(right), rightCols);
  });
}

/** Chosen row: faint or plain text takes the selection style; yellow and green keep their meaning. */
const highlight = (segs: readonly Seg[]): Seg[] =>
  segs.map((g) =>
    g.style?.fg === 'yellow' || g.style?.fg === 'green' ? g : { ...g, style: FOCUS },
  );

export const logsBody =
  (s: TuiState): Body =>
  (frame, top, height) => {
    const logs = s.logs;
    if (logs === null || height <= 0) return;
    const cols = s.size.cols;
    putSegs(frame, 1, top, [ui('Logs: ', FOCUS), seg(logs.title, BOLD)], cols - 1);
    // Without room for the column of stages, they take the second row and the mode joins the news.
    const narrow = logColumns(cols, logs.paneHidden).pane === 0;
    const stages = narrow ? stagesRow(s, cols - 1) : null;
    const news = newsLine(logs, s);
    if (height > 1) {
      if (stages !== null) putSegs(frame, 1, top + 1, stages, cols - 1);
      else
        frame.put(
          1,
          top + 1,
          truncate(logs.picker === null ? modeLine(logs, s) : pickerSummary(s), cols - 1),
          DIM,
        );
    }
    if (height > 2) {
      if (news === '' && stages !== null)
        frame.put(
          1,
          top + 2,
          truncate(logs.picker === null ? modeLine(logs, s) : pickerSummary(s), cols - 1),
          DIM,
        );
      else frame.put(1, top + 2, truncate(news, cols - 1), WARN);
    }
    const listTop = top + LOG_HEADER_ROWS;
    const room = height - LOG_HEADER_ROWS;
    if (room <= 0) return;
    const { pane, log } = logColumns(cols, logs.paneHidden);
    const x = pane === 0 ? 0 : pane + 2;
    if (pane > 0) {
      progressPane(frame, s, listTop, room, pane);
      for (let y = listTop; y < listTop + room; y++) frame.put(pane, y, uiText('│'), DIM);
    }
    if (logs.picker !== null) {
      pickerList(frame, s, logs, x, listTop, logRows(height), log);
      return;
    }
    if (logs.gates !== null) {
      gatesBody(frame, logs.gates, {
        x,
        top: listTop,
        height: logRows(height),
        cols: log,
        wide: pane > 0,
      });
      return;
    }
    if (logs.buffer.length === 0 && !logs.filling && logs.lastReadAt !== null) {
      frame.put(x + 1, listTop, uiText('No log records here yet.'), DIM);
      return;
    }
    // Scrolling counts rows wrapped at this same width (`logColumns`), so the place kept is the place shown.
    visibleRows(logs, log, logRows(height)).forEach((row, i) =>
      drawRow(frame, x, listTop + i, row, log),
    );
    if (newBelow(logs) && logRows(height) < room)
      frame.put(
        x + 1,
        listTop + logRows(height),
        truncate(uiText('↓ New messages · G to jump to the end'), log - 1),
        WARN,
      );
  };
