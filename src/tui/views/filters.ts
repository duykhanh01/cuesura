/**
 * The filter screen and the line that always shows what is applied (FR-008). The filter is the one place a
 * user can type at this stage, and a lost connection leaves that text as it is (FR-009).
 */
import { projectChoices, STATUS_CHOICES, type TuiState } from '../model/state.ts';
import { joinSafe, sanitize, uiText, type SafeText } from '../terminal/safe-text.ts';
import { truncate } from '../terminal/width.ts';
import { putSegs, ruleHeading } from './ink.ts';
import type { Body } from './layout.ts';
import { FOCUS } from './theme.ts';

export const filtered = (s: TuiState): boolean =>
  s.filters.project !== null || s.filters.status !== null;

/** The filter in force, in the words of the screen. */
export function filterLine(s: TuiState): SafeText {
  const { project, status } = s.filters;
  return joinSafe([
    uiText('Filters: project '),
    project === null ? uiText('all') : sanitize(project),
    uiText(` · status ${status ?? 'all'} · f to change`),
  ]);
}

export const QUIT_PROMPT =
  'Quitting loses what you typed. Press the same key again to quit, any other to stay.';

type Row = {
  readonly text: SafeText;
  readonly heading?: boolean;
  readonly bold?: boolean;
  readonly inverse?: boolean;
};

export const filtersBody =
  (s: TuiState): Body =>
  (frame, top, height) => {
    const draft = s.filterDraft;
    if (draft === null) return;
    const typing = draft.field === 'project';
    const rows: Row[] = [
      { text: uiText('Filter tasks'), bold: true, heading: true },
      {
        text: joinSafe([
          uiText(`${typing ? '› ' : '  '}Find project: `),
          sanitize(draft.query),
          uiText(typing ? '_' : ''),
        ]),
        bold: typing,
      },
    ];
    const choices = projectChoices(s.projects, draft.query);
    if (s.projects === null) rows.push({ text: uiText('    Project list not read yet') });
    else if (choices.length === 0) rows.push({ text: uiText('    No project matches') });
    // Statuses always fit; projects take what is left, around the chosen one.
    const room = Math.max(1, height - rows.length - STATUS_CHOICES.length - 2);
    const first = Math.max(0, Math.min(draft.project - room + 1, choices.length - room));
    for (const [i, choice] of choices.entries()) {
      if (i < first || i >= first + room) continue;
      const on = i === draft.project;
      rows.push({
        text: joinSafe([
          uiText(on ? '    › ' : '      '),
          choice === null ? uiText('All projects') : sanitize(choice),
        ]),
        inverse: on && typing,
      });
    }
    rows.push({
      text: uiText(`${typing ? '  ' : '› '}Status:`),
      bold: !typing,
    });
    for (const [i, choice] of STATUS_CHOICES.entries()) {
      const on = i === draft.status;
      rows.push({
        text: uiText(`${on ? '    › ' : '      '}${choice ?? 'All statuses'}`),
        inverse: on && !typing,
      });
    }
    if (s.quitArmed) rows.push({ text: uiText(QUIT_PROMPT), bold: true });
    rows.slice(0, height).forEach((row, i) => {
      if (row.heading === true) {
        putSegs(frame, 1, top + i, ruleHeading(row.text, s.size.cols - 1, FOCUS), s.size.cols - 1);
        return;
      }
      frame.put(1, top + i, truncate(row.text, s.size.cols - 1), {
        ...(row.bold === true ? { bold: true } : {}),
        ...(row.inverse === true ? { inverse: true } : {}),
      });
    });
  };
