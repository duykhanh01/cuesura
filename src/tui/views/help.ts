import { uiText } from '../terminal/safe-text.ts';
import { truncate } from '../terminal/width.ts';
import type { Body } from './layout.ts';

const LINES = [
  'Keys',
  '',
  '  ↑ ↓ k j      Move',
  '  PgUp PgDn    Scroll; at the top or end of the list, the page before or after',
  '  g G          Top and end of the list',
  '  Enter        Open the selected task; on Finished: show or hide finished tasks',
  '  l            In Task detail: open the logs',
  '  Space F t    In Logs: pause or resume, follow live, choose an attempt',
  '  f            Filter by project and status',
  '  ?            This help',
  '  Esc          Go back',
  '  R            Retry the daemon connection',
  '  q            Quit; tasks and the daemon keep running',
  '  Ctrl-C       Quit; does not cancel any task',
];

export const helpBody =
  (cols: number): Body =>
  (frame, top, height) => {
    LINES.slice(0, height).forEach((line, i) =>
      frame.put(0, top + i, truncate(uiText(line), cols)),
    );
  };
