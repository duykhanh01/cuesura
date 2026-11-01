import { TASK_STATUSES } from '../../domain/state.ts';
import type { TuiState } from '../model/state.ts';
import { uiText } from '../terminal/safe-text.ts';
import { truncate } from '../terminal/width.ts';
import type { Body } from './layout.ts';

/** What Home shows until its screen exists: the counts the daemon reported, and nothing inferred. */
export const countsBody =
  (s: TuiState): Body =>
  (frame, top, height) => {
    if (height <= 0 || s.board === null) return;
    const counts = s.board.counts.by_status;
    const parts = TASK_STATUSES.flatMap((status) => {
      const n = counts[status];
      return n === undefined ? [] : [`${status} ${n}`];
    });
    frame.put(
      0,
      top,
      truncate(
        uiText(`Tasks: ${parts.length === 0 ? 'none' : parts.join('  ')}`),
        s.size.cols,
      ),
    );
  };
