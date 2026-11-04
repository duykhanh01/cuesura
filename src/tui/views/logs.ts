/**
 * Logs: the task's log, live or by attempt (FR-014, EC-011). What the reader is looking at stays while new
 * records come: this only says that they came. Only the rows on screen are worked out, however long the buffer.
 */
import { activity, todo } from '../model/activity.ts';
import { attemptChoices } from '../model/detail-keys.ts';
import {
  progressStages,
  STAGE_LABEL,
  stageOf,
  type StageName,
} from '../model/stages.ts';
import {
  LOG_HEADER_ROWS,
  logColumns,
  shortAttempt,
  visibleRows,
  type LogRow,
  type LogState,
} from '../model/logs.ts';
import type { TuiState } from '../model/state.ts';
import { joinSafe, uiText, type SafeText } from '../terminal/safe-text.ts';
import type { Frame, Style } from '../terminal/screen.ts';
import type { Tone } from '../model/log-text.ts';
import { graphemes, truncate } from '../terminal/width.ts';
import { BOLD, DIM, putSegs, seg, ui, wrapSegs, type Seg } from './ink.ts';
import { stageLook, stepper } from './stepper.ts';
import type { Body } from './layout.ts';

const ROW_STYLE: Readonly<Record<LogRow['kind'], Style>> = {
  record: {},
  separator: { fg: 'cyan', bold: true },
  gap: { fg: 'yellow', bold: true },
};

/** The mark and the text of a record by what it says. */
const TONE: Readonly<Record<Tone, { mark: Style; body: Style }>> = {
  say: { mark: { bold: true }, body: {} },
  tool: { mark: { fg: 'green', bold: true }, body: {} },
  result: { mark: DIM, body: DIM },
  ok: { mark: { fg: 'green' }, body: DIM },
  error: { mark: { fg: 'red' }, body: { fg: 'red' } },
  warn: { mark: { fg: 'yellow', bold: true }, body: { fg: 'yellow' } },
  info: { mark: DIM, body: DIM },
};

function drawRow(
  frame: Frame,
  x0: number,
  y: number,
  row: LogRow,
  cols: number,
): void {
  if (
    row.kind !== 'record' ||
    row.head === undefined ||
    row.tone === undefined
  ) {
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
    putSegs(
      frame,
      x0 + row.head,
      y,
      row.segs,
      Math.max(0, cols - row.head),
      tone.body,
    );
    return;
  }
  const chars = graphemes(row.text);
  const strong = row.strong ?? 0;
  const part = (from: number, to?: number): SafeText =>
    uiText(chars.slice(from, to).join(''));
  frame.put(x0, y, truncate(part(0, row.head), cols), tone.mark);
  frame.put(
    x0 + row.head,
    y,
    truncate(part(row.head, row.head + strong), cols - row.head),
    {
      ...tone.body,
      bold: true,
    },
  );
  const x = row.head + strong;
  frame.put(x0 + x, y, truncate(part(x), Math.max(0, cols - x)), tone.body);
}

function modeLine(s: LogState): SafeText {
  const parts = [`Mode: ${s.mode}`];
  parts.push(
    s.attemptFilter === null
      ? 'Every step (t: one step only)'
      : `Attempt: ${shortAttempt(s.attemptFilter)}`,
  );
  const first = s.buffer[0];
  const last = s.buffer.at(-1);
  if (first !== undefined && last !== undefined)
    parts.push(`Records: ${first.seq}–${last.seq}`);
  if (s.windowStart > 0)
    parts.push(
      s.attemptFilter === null
        ? `${s.windowStart} earlier left the buffer: ↑ at the top reads them again`
        : 'Earlier ones left the buffer: ↑ at the top reads them again',
    );
  return uiText(parts.join(' · '));
}

function newsLine(s: LogState): SafeText {
  if (s.error !== null)
    return joinSafe([uiText('Could not read the log: '), s.error]);
  if (s.newActivity) return uiText('New activity: F follows the log live');
  if (s.filling || s.older !== null) return uiText('Reading…');
  if (s.complete) return uiText('End of the log: the task has finished');
  return uiText('');
}

const WARN: Style = { fg: 'yellow', bold: true };
const KEY: Style = { fg: 'cyan', bold: true };

/** The stages in one row, where there is no room for a column of them. */
function stagesRow(s: TuiState): Seg[] | null {
  const d = s.detail;
  const status = d?.explain.data?.status ?? d?.show.data?.status;
  const steps = d?.progress.data?.steps ?? null;
  if (steps === null || status === undefined) return null;
  const stages = progressStages(steps, status);
  return stages === null ? null : stepper(stages, status);
}

/** The attempt being read, by its step, so the progress column can point at it. */
function filteredStage(s: TuiState): StageName | null {
  const id = s.logs?.attemptFilter ?? null;
  if (id === null) return null;
  const attempt = s.detail?.show.data?.provenance.usage.find(
    (a) => a.attempt_id === id,
  );
  return attempt === undefined ? null : stageOf(attempt.step);
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * The task's stages top to bottom as a timeline, what it is doing now, what it waits on the user for, and
 * which part of the log is shown. The running stage turns; the line between stages is solid where the
 * task has passed. Without room for the lines between stages, the stages sit one under another.
 */
function progressPane(
  frame: Frame,
  s: TuiState,
  top: number,
  height: number,
  width: number,
): void {
  const d = s.detail;
  const status = d?.explain.data?.status ?? d?.show.data?.status;
  const steps = d?.progress.data?.steps ?? null;
  const stages =
    steps === null || status === undefined
      ? null
      : progressStages(steps, status);
  const head: Seg[][] = [];
  const timeline: Seg[][] = [];
  const tail: Seg[][] = [];

  const progress = d?.progress.data ?? null;
  if (stages === null || status === undefined) {
    head.push([ui('Progress', BOLD)], []);
    if (progress === null) timeline.push([ui('Reading…', DIM)]);
    else if (progress.steps === null)
      // Not frozen yet, say: there are no steps to show, which is an answer, not a wait.
      timeline.push(
        ...wrapSegs(
          [
            ui('No steps yet: ', DIM),
            seg(progress.reason ?? uiText('no reason given'), DIM),
          ],
          width - 1,
        ),
      );
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
    const label = `${done}/${counted.length}`;
    head.push(
      [
        ui('Progress', BOLD),
        ui(' '.repeat(Math.max(1, width - 9 - label.length - 1))),
        ui(label, DIM),
      ],
      [],
    );
    const pointed = filteredStage(s);
    stages.forEach((stage, i) => {
      const look = stageLook(stage, status);
      const turning = stage.state === 'current' && status === 'RUNNING';
      const mark = turning
        ? (SPINNER[s.tick % SPINNER.length] ?? look.mark)
        : look.mark;
      const here = pointed === stage.name;
      const strong = here || stage.state === 'current';
      timeline.push([
        ui(here ? '▸' : ' ', KEY),
        ui(`${mark}  `, look.style),
        ui(STAGE_LABEL[stage.name], {
          ...(stage.state === 'todo' || stage.state === 'skipped'
            ? DIM
            : stage.state === 'current'
              ? look.style
              : {}),
          ...(strong ? { bold: true } : {}),
        }),
        ui(stage.runs > 1 ? `  ×${stage.runs}` : '', DIM),
        ui(stage.state === 'skipped' ? '  skipped' : '', DIM),
      ]);
      const next = stages[i + 1];
      if (next !== undefined) {
        const passed = stage.state === 'done';
        timeline.push([
          ui(' '),
          ui(passed ? '│' : '╎', passed ? { fg: 'green' } : DIM),
        ]);
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
    tail.push([], [ui('Now', BOLD)]);
    tail.push(...wrapSegs([seg(activity(row))], width - 1));
    const action = todo(row);
    if (action !== null) {
      tail.push([], [ui('▲ Needs you', WARN)]);
      tail.push(
        ...wrapSegs(
          [seg(joinSafe([uiText('→ '), action]), WARN)],
          width - 1,
          2,
        ),
      );
    }
  }
  const filtered =
    s.logs?.attemptFilter !== null && s.logs?.attemptFilter !== undefined;
  tail.push(
    [],
    [ui('─'.repeat(Math.max(0, width - 2)), DIM)],
    [ui('Showing ', DIM), ui(filtered ? 'one step' : 'every step')],
    [ui('t', KEY), ui('  choose a step', DIM)],
    [ui('d', KEY), ui('  details: why, PR, limits', DIM)],
  );

  // Short of room, the lines between stages go first: the stages and what to do matter more.
  const fits = head.length + timeline.length + tail.length <= height;
  const stagesShown = fits
    ? timeline
    : timeline.filter((_, i) => stages === null || i % 2 === 0);
  [...head, ...stagesShown, ...tail]
    .slice(0, height)
    .forEach((segs, i) => putSegs(frame, 1, top + i, segs, width - 1));
}

export const logsBody =
  (s: TuiState): Body =>
  (frame, top, height) => {
    const logs = s.logs;
    if (logs === null || height <= 0) return;
    const cols = s.size.cols;
    putSegs(
      frame,
      1,
      top,
      [ui('Logs: ', { fg: 'cyan', bold: true }), seg(logs.title, BOLD)],
      cols - 1,
    );
    // Without room for the column of stages, they take the second row and the mode joins the news.
    const narrow = logColumns(cols).pane === 0;
    const stages = narrow ? stagesRow(s) : null;
    const news = newsLine(logs);
    if (height > 1) {
      if (stages !== null) putSegs(frame, 1, top + 1, stages, cols - 1);
      else frame.put(1, top + 1, truncate(modeLine(logs), cols - 1), DIM);
    }
    if (height > 2) {
      if (news === '' && stages !== null)
        frame.put(1, top + 2, truncate(modeLine(logs), cols - 1), DIM);
      else frame.put(1, top + 2, truncate(news, cols - 1), WARN);
    }
    const listTop = top + LOG_HEADER_ROWS;
    const room = height - LOG_HEADER_ROWS;
    if (room <= 0) return;
    if (logs.picker !== null) {
      const rows = [
        uiText('Show the log of:'),
        ...attemptChoices(s).map((c, i) =>
          joinSafe([uiText(i === logs.picker ? '› ' : '  '), c.label]),
        ),
      ];
      const first = Math.max(0, logs.picker + 2 - room);
      rows
        .slice(first, first + room)
        .forEach((row, i) =>
          frame.put(1, listTop + i, truncate(row, cols - 1)),
        );
      return;
    }
    const { pane, log } = logColumns(cols);
    const x = pane === 0 ? 0 : pane + 2;
    if (pane > 0) {
      progressPane(frame, s, listTop, room, pane);
      for (let y = listTop; y < listTop + room; y++)
        frame.put(pane, y, uiText('│'), DIM);
    }
    if (logs.buffer.length === 0 && !logs.filling && logs.lastReadAt !== null) {
      frame.put(x + 1, listTop, uiText('No log records here yet.'), DIM);
      return;
    }
    // Scrolling counts rows wrapped at this same width (`logColumns`), so the place kept is the place shown.
    visibleRows(logs, log, room).forEach((row, i) =>
      drawRow(frame, x, listTop + i, row, log),
    );
  };
