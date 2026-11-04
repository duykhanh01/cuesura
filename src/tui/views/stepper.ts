/**
 * How stages look: a row of dots on Home, a labelled path on Task detail. Every state has its own mark, so
 * the path reads the same without colour (FR-035), and a skipped stage never looks like one that ran (FR-011).
 */
import type { TaskStatus } from '../../domain/state.ts';
import { STAGE_LABEL, type Stage, type StageState } from '../model/stages.ts';
import type { Color, Style } from '../terminal/screen.ts';
import { DIM, ui, type Seg } from './ink.ts';

/** Running is cyan; a task that waits shows its current stage in yellow, so a stall stands out. */
function currentColor(status: TaskStatus): Color {
  return status === 'WAITING' ? 'yellow' : 'cyan';
}

function look(
  state: StageState,
  status: TaskStatus,
): { readonly dot: string; readonly mark: string; readonly style: Style } {
  switch (state) {
    case 'done':
      return { dot: '●', mark: '✓', style: { fg: 'green' } };
    case 'current':
      return {
        dot: '◉',
        mark: '●',
        style: { fg: currentColor(status), bold: true },
      };
    case 'failed':
      return { dot: '✗', mark: '✗', style: { fg: 'red', bold: true } };
    case 'stopped':
      return { dot: '×', mark: '×', style: DIM };
    case 'skipped':
      return { dot: '–', mark: '–', style: DIM };
    case 'todo':
      return { dot: '○', mark: '○', style: DIM };
  }
}

/** The mark and style of a stage, for a screen that lays stages out its own way. */
export function stageLook(
  stage: Stage,
  status: TaskStatus,
): { readonly mark: string; readonly style: Style } {
  const { mark, style } = look(stage.state, status);
  return { mark, style };
}

const DOT_STYLE: Readonly<Record<StageState, (status: TaskStatus) => Style>> = {
  done: () => ({ fg: 'green' }),
  current: (status) => ({ fg: currentColor(status), bold: true }),
  failed: () => ({ fg: 'red', bold: true }),
  stopped: () => ({ fg: 'magenta' }),
  skipped: () => DIM,
  todo: () => DIM,
};

/**
 * One cell per stage, for a list row. With colour every stage is the same dot and the colour tells the state;
 * a skipped stage is a small dot, so it never looks like one still to come (FR-011). Without colour the
 * distinct marks of `look` carry the states (FR-035).
 */
export function dots(stages: readonly Stage[], status: TaskStatus, color = true): Seg[] {
  return stages.map((s) => {
    if (!color) {
      const { dot, style } = look(s.state, status);
      return ui(dot, style);
    }
    return ui(s.state === 'skipped' ? '·' : '●', DOT_STYLE[s.state](status));
  });
}

export const DOTS_WIDTH = 8;

/**
 * `triage ✓ ─ code ● ─ PR ○`: the label carries the stage's style, a stage run more than once says how many
 * times. Joined with breakable spaces so a narrow screen wraps between stages, never inside one.
 */
export function stepper(stages: readonly Stage[], status: TaskStatus): Seg[] {
  const out: Seg[] = [];
  stages.forEach((s, i) => {
    const { mark, style } = look(s.state, status);
    if (i > 0) out.push(ui(' ─ ', DIM));
    const runs = s.runs > 1 ? `\u00a0×${s.runs}` : '';
    const label =
      s.state === 'skipped' ? `${STAGE_LABEL[s.name]}\u00a0skipped` : STAGE_LABEL[s.name];
    out.push(ui(`${label}\u00a0${mark}${runs}`, style));
  });
  return out;
}

/** What the marks mean, for the screens that draw them. */
export const STAGE_KEY: readonly Seg[] = [
  ui('✓ ran', { fg: 'green' }),
  ui('  ● now', { fg: 'cyan' }),
  ui('  ○ to come', DIM),
  ui('  – skipped by mode', DIM),
  ui('  ×n runs', DIM),
];
