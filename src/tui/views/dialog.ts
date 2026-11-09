/**
 * The pause and resume dialogs (`model/dialog.ts`): what the action does, the version a task write carries,
 * the reason and `--now` when pausing, and why the last Ctrl-S sent nothing.
 */
import { DIALOG_LABEL, type Dialog } from '../model/dialog.ts';
import type { TuiState } from '../model/state.ts';
import type { PauseInfo } from '../client/schemas.ts';
import { joinSafe, uiText, type SafeText } from '../terminal/safe-text.ts';
import type { Style } from '../terminal/screen.ts';
import { truncate, wrap } from '../terminal/width.ts';
import { DIM, putSegs, ruleHeading } from './ink.ts';
import { drawField } from './input.ts';
import type { Body } from './layout.ts';
import { clockTime } from './layout.ts';
import { BAD_STRONG, FOCUS, NOTICE } from './theme.ts';

export function pausedBy(p: PauseInfo): SafeText {
  return joinSafe([uiText('by '), p.by, uiText(` at ${clockTime(p.at)}: `), p.reason]);
}

export const pausedText = (p: PauseInfo): SafeText => joinSafe([uiText('Paused '), pausedBy(p)]);

const SEND_WORDS: Readonly<Record<Dialog['action'], string>> = {
  pause: 'Ctrl-S pauses the task',
  resume: 'Ctrl-S resumes the task',
  continue: 'Ctrl-S lets the task go on',
  queue_pause: 'Ctrl-S pauses the queue',
  queue_resume: 'Ctrl-S resumes the queue',
};

type Row = { readonly text: SafeText; readonly style: Style } | { readonly field: true };

function dialogRows(s: TuiState, d: Dialog, cols: number): Row[] {
  const rows: Row[] = [];
  const say = (text: SafeText | string, style: Style = {}): void => {
    for (const r of wrap(typeof text === 'string' ? uiText(text) : text, cols))
      rows.push({ text: r, style });
  };
  const now = d.taskId !== null && s.actions?.taskId === d.taskId ? s.actions.show.data : null;
  if (d.taskId !== null)
    say(
      d.version === null
        ? 'Reading this task…'
        : now !== null && now.version !== d.version
          ? `The task changed since this dialog opened (version ${d.version}, now ${now.version}); nothing will be sent.`
          : `Sent with version ${d.version}; if the task moves first, the daemon refuses it.`,
      now !== null && d.version !== null && now.version !== d.version ? NOTICE : DIM,
    );
  if (d.effect !== null) say(d.effect);
  if (d.action === 'queue_resume' && s.queuePaused !== null) say(pausedText(s.queuePaused), NOTICE);
  if (d.reason !== null) {
    rows.push({ text: uiText(''), style: {} });
    say(`${d.focus === 'reason' ? '› ' : '  '}Reason`, d.focus === 'reason' ? FOCUS : {});
    rows.push({ field: true });
  }
  if (d.action === 'pause') {
    const on = d.focus === 'now';
    say(
      `${on ? '› ' : '  '}[${d.now ? 'x' : ' '}] Also stop the agent turn running now (--now)`,
      on ? FOCUS : {},
    );
    say(
      '    It starts over in a new session on resume. Without it, work already started finishes.',
      DIM,
    );
  }
  rows.push({ text: uiText(''), style: {} });
  if (d.unavailable !== null) say(`Not available: ${d.unavailable}`, NOTICE);
  if (d.error !== null) say(d.error, BAD_STRONG);
  say(`${SEND_WORDS[d.action]} · Esc leaves without sending`, DIM);
  return rows;
}

export const dialogBody =
  (s: TuiState): Body =>
  (frame, top, height) => {
    const d = s.dialog;
    if (d === null || height <= 0) return;
    const cols = s.size.cols - 2;
    const label = uiText(DIALOG_LABEL[d.action]);
    const title = d.taskId === null ? label : joinSafe([label, uiText(' — '), d.title]);
    putSegs(frame, 1, top, ruleHeading(title, cols, FOCUS), cols);
    dialogRows(s, d, cols)
      .slice(0, height - 1)
      .forEach((row, i) => {
        const y = top + 1 + i;
        if ('field' in row) {
          if (d.reason === null) return;
          frame.put(1, y, uiText('  ▏'), DIM);
          drawField(frame, { x: 4, y, width: cols - 4, height: 1 }, d.reason, d.focus === 'reason');
          return;
        }
        frame.put(1, y, truncate(row.text, cols), row.style);
      });
  };
