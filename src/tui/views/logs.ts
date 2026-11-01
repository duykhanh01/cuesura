/**
 * Logs: the task's log, live or by attempt (FR-014, EC-011). What the reader is looking at stays while new
 * records come: this only says that they came. Only the rows on screen are worked out, however long the buffer.
 */
import { attemptChoices } from '../model/detail-keys.ts';
import {
  LOG_HEADER_ROWS,
  shortAttempt,
  visibleRows,
  type LogRow,
  type LogState,
} from '../model/logs.ts';
import type { TuiState } from '../model/state.ts';
import { joinSafe, uiText, type SafeText } from '../terminal/safe-text.ts';
import type { Style } from '../terminal/screen.ts';
import { truncate } from '../terminal/width.ts';
import type { Body } from './layout.ts';

const ROW_STYLE: Readonly<Record<LogRow['kind'], Style>> = {
  record: {},
  separator: { bold: true },
  gap: { fg: 'yellow', bold: true },
};

function modeLine(s: LogState): SafeText {
  const parts = [`Mode: ${s.mode}`];
  if (s.attemptFilter !== null)
    parts.push(`Attempt: ${shortAttempt(s.attemptFilter)}`);
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

export const logsBody =
  (s: TuiState): Body =>
  (frame, top, height) => {
    const logs = s.logs;
    if (logs === null || height <= 0) return;
    const cols = s.size.cols;
    frame.put(
      0,
      top,
      truncate(joinSafe([uiText('Logs: '), logs.title]), cols),
      { bold: true },
    );
    if (height > 1) frame.put(0, top + 1, truncate(modeLine(logs), cols));
    if (height > 2)
      frame.put(0, top + 2, truncate(newsLine(logs), cols), {
        fg: 'yellow',
        bold: true,
      });
    const listTop = top + LOG_HEADER_ROWS;
    const room = height - LOG_HEADER_ROWS;
    if (room <= 0) return;
    if (logs.picker !== null) {
      const rows = [
        uiText('Choose an attempt:'),
        ...attemptChoices(s).map((c, i) =>
          joinSafe([uiText(i === logs.picker ? '› ' : '  '), c.label]),
        ),
      ];
      const first = Math.max(0, logs.picker + 2 - room);
      rows
        .slice(first, first + room)
        .forEach((row, i) => frame.put(0, listTop + i, truncate(row, cols)));
      return;
    }
    if (logs.buffer.length === 0 && !logs.filling && logs.lastReadAt !== null) {
      frame.put(0, listTop, uiText('No log records here yet.'));
      return;
    }
    visibleRows(logs, cols, room).forEach((row, i) =>
      frame.put(0, listTop + i, truncate(row.text, cols), ROW_STYLE[row.kind]),
    );
  };
