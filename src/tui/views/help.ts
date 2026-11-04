import { TASK_STATUSES } from '../../domain/state.ts';
import { statusGlyph } from '../model/activity.ts';
import { DIM, fg, putSegs, ruleHeading, ui, type Seg } from './ink.ts';
import type { Body } from './layout.ts';
import { STAGE_KEY } from './stepper.ts';

const KEYS: readonly (readonly [string, string])[] = [
  ['↑ ↓ k j', 'Move'],
  [
    'PgUp PgDn',
    'Scroll; at the top or end of the list, the page before or after',
  ],
  ['g G', 'Top and end of the list'],
  [
    'Enter',
    'Open the selected task: its stages and its log; on Finished: show or hide',
  ],
  ['d', 'In a task: details — why it waits, what to do, PR, limits, history'],
  ['l', 'In details: back to the stages and the log'],
  ['Space F t', 'In Logs: pause or resume, follow live, show one step only'],
  ['f', 'Filter by project and status'],
  ['?', 'This help'],
  ['Esc', 'Go back; from a task, back to the list'],
  ['R', 'Retry the daemon connection'],
  ['q', 'Quit; tasks and the daemon keep running'],
  ['Ctrl-C', 'Quit; does not cancel any task'],
];

function lines(cols: number): Seg[][] {
  const out: Seg[][] = [ruleHeading('Keys', cols), []];
  for (const [key, what] of KEYS)
    out.push([ui(`  ${key}`.padEnd(15), { fg: 'cyan', bold: true }), ui(what)]);
  out.push([], ruleHeading('Reading the screen', cols), []);
  out.push([
    ui('  Status'.padEnd(15), DIM),
    ...TASK_STATUSES.flatMap((s, i) => {
      const { mark, color } = statusGlyph(s);
      return [
        ...(i === 0 ? [] : [ui('   ')]),
        ui(mark, fg(color, { bold: true })),
        ui(` ${s.toLowerCase()}`),
      ];
    }),
  ]);
  out.push([
    ui('  Stages'.padEnd(15), DIM),
    ui(
      'triage, prepare, code, gates, review, PR, CI, merge: one dot each on Home',
    ),
  ]);
  out.push([ui(''.padEnd(15)), ...STAGE_KEY]);
  out.push([
    ui('  Needs you'.padEnd(15), DIM),
    ui('→ what to do', { fg: 'yellow', bold: true }),
    ui(' for tasks that cannot go on without you'),
  ]);
  return out;
}

export const helpBody =
  (cols: number): Body =>
  (frame, top, height) => {
    lines(cols - 1)
      .slice(0, height)
      .forEach((segs, i) => putSegs(frame, 1, top + i, segs, cols - 1));
  };
