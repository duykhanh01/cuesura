import { currentScreen, type TuiState } from '../model/state.ts';
import { uiText } from '../terminal/safe-text.ts';
import { wrap } from '../terminal/width.ts';
import { actionsBody } from './actions.ts';
import { dialogBody } from './dialog.ts';
import { withDisconnected } from './disconnected.ts';
import { filtersBody, QUIT_PROMPT } from './filters.ts';
import { helpBody } from './help.ts';
import { homeBody } from './home.ts';
import type { Body } from './layout.ts';
import { logsBody } from './logs.ts';
import { detailBody } from './task-detail.ts';

/** What the screen on top draws between the bars, under what a lost connection has to say. */
export function screenBody(s: TuiState, opts: { color: boolean }): Body {
  const body = ((): Body => {
    switch (currentScreen(s)) {
      case 'help':
        return helpBody(s);
      case 'actions':
        return actionsBody(s);
      case 'dialog':
        return dialogBody(s);
      case 'filters':
        return filtersBody(s);
      case 'home':
        return homeBody(s, opts);
      case 'detail':
        return detailBody(s);
      case 'logs':
        return logsBody(s);
    }
  })();
  return withDisconnected(s, withQuitPrompt(s, body));
}

/**
 * The question a first quit key asks must be on whatever screen is open: Help can be over the form whose
 * text would be lost. The filter form asks it in its own rows.
 */
function withQuitPrompt(s: TuiState, body: Body): Body {
  if (!s.quitArmed || currentScreen(s) === 'filters') return body;
  return (frame, top, height) => {
    const rows = wrap(uiText(QUIT_PROMPT), s.size.cols).slice(0, height);
    rows.forEach((row, i) => frame.put(0, top + i, row, { bold: true }));
    body(frame, top + rows.length, height - rows.length);
  };
}
