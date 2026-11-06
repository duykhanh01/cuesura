/**
 * What the lost connection means, above whatever screen is open (FR-009, SC-011): why, whether it is still
 * trying and what the user can do. The screen stays with what it held; a daemon that died is no way out. The
 * banner row and the reason of a stop come from `layout.ts`.
 */
import { RECONNECT_ATTEMPTS, type TuiState } from '../model/state.ts';
import { joinSafe, uiText, type SafeText } from '../terminal/safe-text.ts';
import { truncate, wrap } from '../terminal/width.ts';
import { notices, staleBanner, type Body } from './layout.ts';
import { NOTICE } from './theme.ts';

const LABEL = 'Disconnected: ';

/** While typing, `R` is text like any other key, so the way to the retry goes through leaving the field. */
const retryHint = (s: TuiState): string =>
  s.filterDraft?.field === 'project'
    ? 'Press Tab to leave the text field, then R to retry. What you typed stays.'
    : 'Retry connection: press R. Nothing else starts a new round.';

function reasonRow(s: TuiState, cols: number): SafeText {
  return joinSafe([
    uiText(LABEL),
    truncate(s.lastError ?? uiText('no answer'), cols - LABEL.length),
  ]);
}

export function disconnectedRows(s: TuiState, cols: number): SafeText[] {
  switch (s.connection.kind) {
    case 'online':
    case 'connecting':
      return [];
    case 'reconnecting':
      return [reasonRow(s, cols)];
    case 'waiting_retry':
      return [
        reasonRow(s, cols),
        ...wrap(
          uiText(
            `All ${RECONNECT_ATTEMPTS} automatic attempts are used; it will not try again on its own.`,
          ),
          cols,
        ),
        ...wrap(uiText(retryHint(s)), cols),
      ];
    case 'stopped':
      return wrap(
        uiText(
          s.filterDraft?.field === 'project' ? retryHint(s) : 'It will not try again on its own.',
        ),
        cols,
      );
  }
}

export const withDisconnected =
  (s: TuiState, body: Body): Body =>
  (frame, top, height) => {
    // At most half the room, so the data under it stays in view.
    const rows = disconnectedRows(s, s.size.cols).slice(0, Math.floor(height / 2));
    rows.forEach((row, i) => frame.put(0, top + i, truncate(row, s.size.cols), NOTICE));
    body(frame, top + rows.length, height - rows.length);
  };

/** The rows a screen's own body gets now: what `renderFrame` and `withDisconnected` leave of the terminal. */
export function contentHeight(s: TuiState): number {
  const { cols, rows } = s.size;
  const room = Math.floor((rows - 2) / 2);
  const top = 1 + staleBanner(s).length + notices(s, cols, room).length;
  const height = rows - top - 1;
  return height - Math.min(disconnectedRows(s, cols).length, Math.floor(height / 2));
}
