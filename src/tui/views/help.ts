import { uiText } from '../terminal/safe-text.ts';
import { truncate } from '../terminal/width.ts';
import type { Body } from './layout.ts';

const LINES = [
  'Keys',
  '',
  '  ?        This help',
  '  Esc      Go back',
  '  R        Retry the daemon connection',
  '  q        Quit; tasks and the daemon keep running',
  '  Ctrl-C   Quit; does not cancel any task',
];

export const helpBody =
  (cols: number): Body =>
  (frame, top, height) => {
    LINES.slice(0, height).forEach((line, i) =>
      frame.put(0, top + i, truncate(uiText(line), cols)),
    );
  };
