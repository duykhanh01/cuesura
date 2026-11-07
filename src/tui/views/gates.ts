/**
 * The gates on the Logs screen: which gates ran in the round chosen, above the log of the gate chosen. Wide, the
 * list is a column of rows; narrow, one row that keeps the chosen gate in view.
 */
import { duration } from '../model/activity.ts';
import {
  chosenGate,
  gateBelow,
  gateListRows,
  gateLogRows,
  QUIET_MS,
  roundOf,
  STUCK_MS,
  visibleGateRows,
  type GateRow,
  type GatesView,
} from '../model/gates.ts';
import { joinSafe, sanitize, uiText, type SafeText } from '../terminal/safe-text.ts';
import type { Frame, Style } from '../terminal/screen.ts';
import { displayWidth, truncate } from '../terminal/width.ts';
import { DIM, putSegs, ruleHeading, seg, segsWidth, ui, type Seg } from './ink.ts';
import { ACTIVE, BAD, FOCUS, GOOD, NOTICE, WARN } from './theme.ts';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const silence = (v: GatesView): number | null => {
  const r = v.running;
  return r === null || v.readAt === null ? null : v.readAt - (r.last_output_at ?? r.started_at);
};

/** What is on screen, for the header of Logs. */
export function gatesModeLine(v: GatesView): SafeText {
  const parts = ['Gates'];
  const round = roundOf(v);
  if (round !== null) {
    parts.push(`round ${round.round} of ${v.rounds?.at(-1)?.round ?? round.round}`);
    parts.push(round.passed ? 'passed' : 'failed');
  }
  parts.push(v.mode === 'live' ? 'Live' : v.scrolledAway ? 'Scrolled up' : 'Paused');
  return uiText(parts.join(' · '));
}

export function gatesNews(v: GatesView): SafeText {
  if (v.error !== null) return joinSafe([uiText('Could not read the gates: '), v.error]);
  const quiet = silence(v);
  if (v.running !== null && quiet !== null && quiet >= STUCK_MS)
    return joinSafe([
      v.running.gate,
      uiText(`: no output for ${duration(quiet) ?? ''}, it may be stuck`),
    ]);
  return uiText('');
}

const logNote = (g: GateRow): string =>
  g.log === 'expired' ? ' · log expired' : g.log === 'missing' ? ' · no log' : '';

function gateSegs(g: GateRow, chosen: boolean, room: 'wide' | 'narrow'): Seg[] {
  const time = g.wall_ms === undefined ? '' : (duration(g.wall_ms) ?? '');
  const name = sanitize(g.gate);
  const nameStyle: Style = chosen ? FOCUS : {};
  return [
    ui(chosen ? '▸' : ' ', FOCUS),
    ui(g.passed ? '✓ ' : '✕ ', g.passed ? GOOD : BAD),
    seg(name, nameStyle),
    ui(time === '' ? '' : room === 'wide' ? `  ${time}` : ` ${time}`, DIM),
    ...(room === 'wide' ? [ui(logNote(g), DIM)] : []),
  ];
}

function runningSegs(v: GatesView, room: 'wide' | 'narrow'): Seg[] {
  const r = v.running;
  if (r === null) return [];
  const ran = v.readAt === null ? null : duration(v.readAt - r.started_at);
  const quiet = silence(v);
  const heard =
    r.last_output_at === null ? 'no output yet' : `last output ${duration(quiet ?? 0) ?? '0s'} ago`;
  const loud = quiet !== null && quiet >= QUIET_MS;
  return [
    ui(' ● ', ACTIVE),
    seg(r.gate, ACTIVE),
    ui(ran === null ? '' : ` ${ran}`, DIM),
    ...(room === 'wide' || loud ? [ui(` · ${heard}`, loud ? NOTICE : DIM)] : []),
  ];
}

/** One row of gates, starting late enough that the chosen one shows. */
function gateRow(v: GatesView, cols: number): Seg[] {
  const gates = roundOf(v)?.gates ?? [];
  const items = [
    ...(v.running === null ? [] : [runningSegs(v, 'narrow')]),
    ...gates.map((g) => gateSegs(g, g.gate === v.gate, 'narrow')),
  ];
  const chosen = (v.running === null ? 0 : 1) + gates.findIndex((g) => g.gate === v.gate);
  const row = (from: number): Seg[] => [
    ...(from > 0 ? [ui('… ', DIM)] : []),
    ...items.slice(from).flatMap((segs, i) => (i === 0 ? segs : [ui('  '), ...segs])),
  ];
  const upToChosen = (from: number): number =>
    items.slice(from, chosen + 1).reduce((n, segs) => n + segsWidth(segs) + 2, from > 0 ? 2 : 0);
  let from = 0;
  while (from < chosen && upToChosen(from) > cols) from += 1;
  return row(from);
}

function gateColumn(v: GatesView, rows: number): Seg[][] {
  const gates = roundOf(v)?.gates ?? [];
  const lines = [
    ...(v.running === null ? [] : [runningSegs(v, 'wide')]),
    ...gates.map((g) => gateSegs(g, g.gate === v.gate, 'wide')),
  ];
  const chosen = (v.running === null ? 0 : 1) + gates.findIndex((g) => g.gate === v.gate);
  const first = Math.max(0, Math.min(chosen - rows + 1, lines.length - rows));
  return lines.slice(first, first + rows);
}

function logHeading(v: GatesView): string {
  const g = chosenGate(v);
  if (g === null) return 'Log';
  const name = sanitize(g.gate);
  return g.bytes === undefined ? name : `${name} · ${formatBytes(g.bytes)}`;
}

/** Why there are no rows of log to show; `null` when there are. */
function emptyWords(v: GatesView, shown: number): string | null {
  if (v.rounds === null) return v.error === null ? 'Reading…' : 'Could not be read.';
  if (v.rounds.length === 0)
    return v.running === null ? 'No gate has run yet.' : 'The log shows once the gate ends.';
  const log = v.log;
  if (log === null) return 'No gate in this round.';
  if (log.state === 'expired') return 'This log has expired: retention removed it.';
  if (log.state === 'missing') return 'No log was kept for this gate.';
  if (log.window === null) return v.error === null ? 'Reading…' : 'Could not be read.';
  return shown === 0 ? '(no output)' : null;
}

function moreWords(v: GatesView, cols: number, height: number): string | null {
  const below = gateBelow(v, cols, height);
  if (below.rows > 0) return `↓ ${below.rows} more ${below.rows === 1 ? 'row' : 'rows'}`;
  return below.bytes > 0 ? `↓ ${formatBytes(below.bytes)} more` : null;
}

export function gatesBody(
  frame: Frame,
  v: GatesView,
  at: {
    readonly x: number;
    readonly top: number;
    readonly height: number;
    readonly cols: number;
    readonly wide: boolean;
  },
): void {
  const { x, top, height, cols, wide } = at;
  if (height <= 0) return;
  const listed = gateListRows(v, wide);
  const list = wide ? gateColumn(v, listed - 1) : [gateRow(v, cols - 1)];
  list.forEach((segs, i) => putSegs(frame, x, top + i, segs, cols - 1));
  const rule = top + listed - 1;
  putSegs(frame, x + 1, rule, ruleHeading(logHeading(v), cols - 2, DIM), cols - 2);
  const rows = gateLogRows(v, height, wide);
  const body = visibleGateRows(v, cols - 1, rows);
  const empty = emptyWords(v, body.length);
  if (empty !== null) {
    frame.put(
      x + 1,
      rule + 1,
      truncate(uiText(empty), cols - 1),
      empty.endsWith('read.') ? WARN : DIM,
    );
    return;
  }
  body.forEach((row, i) => frame.put(x + 1, rule + 1 + i, truncate(row, cols - 1)));
  const more = moreWords(v, cols - 1, rows);
  if (more !== null) {
    const text = uiText(more);
    frame.put(x + Math.max(1, cols - displayWidth(text) - 1), rule + 1 + rows, text, DIM);
  }
}
