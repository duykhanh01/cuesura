/**
 * What colour means on every screen; src/tui/DESIGN.md says when to use which. Views name a role and
 * never a colour, so a role changes in one place and a state cannot drift from one screen to the next.
 */
import type { Style } from '../terminal/screen.ts';

/** Ran, passed, healthy. */
export const GOOD: Style = { fg: 'green' };
export const GOOD_STRONG: Style = { fg: 'green', bold: true };
/** Failed or refused. */
export const BAD: Style = { fg: 'red' };
export const BAD_STRONG: Style = { fg: 'red', bold: true };
/** A pause or something the user must read; nothing has gone wrong yet. */
export const NOTICE: Style = { fg: 'yellow' };
export const WARN: Style = { fg: 'yellow', bold: true };
/** Cancelled. Orange because yellow already means a wait. */
export const STOPPED: Style = { fg: 'orange' };
export const STOPPED_STRONG: Style = { fg: 'orange', bold: true };
/** Running now, or a pointer to something. */
export const ACTIVE: Style = { fg: 'cyan' };
/** The selection, a key, a heading the eye lands on. */
export const FOCUS: Style = { fg: 'cyan', bold: true };
/** Fainter than dim text: skipped, absent. */
export const FAINT: Style = { fg: 'gray' };
