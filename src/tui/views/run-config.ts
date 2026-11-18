/**
 * The Run config screen (FR-025). The profile is a line of text with no way to change it; the mode, worker,
 * reviewer and fallbacks are lists; the reason is the only text. When the options cannot be read the screen
 * says so and offers nothing.
 */
import type { RunOptions } from '../client/schemas.ts';
import {
  choiceKey,
  currentOptions,
  fallbackChoices,
  focusedRunConfigField,
  RUN_CONFIG_BOX_X as BOX_X,
  REASON_MAX,
  resolve,
  taskVersionChanged,
  visibleFields,
  whenRows,
  WHEN_ROWS,
  type RunConfigField,
  type RunConfigForm,
} from '../model/run-config.ts';
import { LEAVE_PROMPT } from '../model/new-task.ts';
import type { TuiState } from '../model/state.ts';
import { joinSafe, uiText, type SafeText } from '../terminal/safe-text.ts';
import { truncate, wrap } from '../terminal/width.ts';
import { drawBlocks, putLabel, sendingLine, type Block, type Line } from './form.ts';
import { drawField } from './input.ts';
import { putSegs, ruleHeading } from './ink.ts';
import type { Body } from './layout.ts';
import { BAD_STRONG, FOCUS, NOTICE, WARN } from './theme.ts';

type Choice = RunOptions['modes'][number]['reviewers'][number];

const LABELS: Record<RunConfigField, string> = {
  mode: 'Mode',
  worker: 'Worker',
  reviewer: 'Reviewer',
  fallbacks: 'Worker fallbacks',
  reviewerFallbacks: 'Reviewer fallbacks',
  reason: 'Reason',
};
const LIST_ROWS = 4;

const show = (c: Choice): SafeText =>
  joinSafe([c.harness, uiText('/'), c.model, uiText('/'), c.effort]);

/** The rows of a list around `at`, `room` at most, as `[index, row]`. */
function window<T>(list: readonly T[], at: number, room: number): [number, T][] {
  const first = Math.max(0, Math.min(at - room + 1, list.length - room));
  return list.slice(first, first + room).map((t, i) => [first + i, t]);
}

function listBlock(
  field: RunConfigField,
  focused: boolean,
  cols: number,
  items: readonly SafeText[],
  chosen: readonly boolean[],
  cursor: number,
  multi: boolean,
  empty: string,
  extra: readonly Line[] = [],
): Block {
  const room = focused ? Math.min(LIST_ROWS, Math.max(1, items.length)) : 1;
  const summary = ((): SafeText => {
    if (items.length === 0) return uiText(empty);
    if (multi) {
      const n = chosen.filter(Boolean).length;
      return uiText(n === 0 ? 'none chosen' : `${n} chosen`);
    }
    return items[Math.max(0, chosen.indexOf(true))] ?? uiText(empty);
  })();
  return {
    height: (focused ? room : 1) + extra.length,
    draw(frame, y) {
      putLabel(frame, y, LABELS[field], focused, false, BOX_X);
      if (!focused || items.length === 0) {
        frame.put(BOX_X, y, truncate(summary, cols - BOX_X - 1), items.length === 0 ? NOTICE : {});
      } else
        window(items, cursor, room).forEach(([i, item], row) => {
          const on = i === cursor;
          const mark = multi
            ? chosen[i] === true
              ? '[x] '
              : '[ ] '
            : chosen[i] === true
              ? '(•) '
              : '( ) ';
          frame.put(
            BOX_X,
            y + row,
            truncate(joinSafe([uiText(`${on ? '› ' : '  '}${mark}`), item]), cols - BOX_X - 1),
            on ? { inverse: true } : {},
          );
        });
      extra.forEach((l, i) =>
        frame.put(BOX_X, y + (focused ? room : 1) + i, truncate(l.text, cols - BOX_X - 1), l.style),
      );
    },
  };
}

function blocks(form: RunConfigForm, cols: number): Block[] {
  const fields = visibleFields(form);
  const at = (f: RunConfigField): boolean => focusedRunConfigField(form) === f;
  const r = resolve(form);
  const out: Block[] = [];
  if (r === null) return out;
  const modes = form.options.data?.modes ?? [];
  const all = whenRows(form, cols);
  const top = Math.min(form.whenTop, Math.max(0, all.length - WHEN_ROWS));
  const whenLines: Line[] =
    r.mode.when_to_use === null
      ? [{ text: uiText('No guidance declared for this mode.'), style: { dim: true } }]
      : [
          ...all.slice(top, top + WHEN_ROWS).map((text) => ({ text, style: { dim: true } })),
          // Long guidance is read in pages; the row says where the page stands.
          ...(all.length > WHEN_ROWS
            ? [
                {
                  text: uiText(
                    `rows ${top + 1}-${Math.min(all.length, top + WHEN_ROWS)} of ${all.length} - PgUp/PgDn to read`,
                  ),
                  style: NOTICE,
                },
              ]
            : []),
        ];
  const out0 = (f: RunConfigField, b: Block): void => {
    if (fields.includes(f)) out.push(b);
  };
  // The mode list is always open, so the guidance of the chosen mode sits right under it.
  out0('mode', {
    height: modes.length + whenLines.length,
    draw(frame, y) {
      putLabel(frame, y, LABELS.mode, at('mode'), false, BOX_X);
      let row = 0;
      for (const m of modes) {
        const on = m.mode === r.mode.mode;
        frame.put(
          BOX_X,
          y + row,
          truncate(uiText(`${on ? '› ' : '  '}${on ? '(•) ' : '( ) '}${m.mode}`), cols - BOX_X - 1),
          on && at('mode') ? { inverse: true } : {},
        );
        row += 1;
        if (on)
          for (const l of whenLines) {
            frame.put(BOX_X, y + row, truncate(l.text, cols - BOX_X - 1), l.style);
            row += 1;
          }
      }
    },
  });
  const workers = r.mode.workers;
  out0(
    'worker',
    listBlock(
      'worker',
      at('worker'),
      cols,
      workers.map((w) => show(w.choice)),
      workers.map((w) => w === r.worker),
      Math.max(
        0,
        workers.findIndex((w) => w === r.worker),
      ),
      false,
      'No worker on offer for this mode',
    ),
  );
  const addFallbacks = (field: 'fallbacks' | 'reviewerFallbacks', empty: string): void => {
    const list = fallbackChoices(r, field);
    out0(
      field,
      listBlock(
        field,
        at(field),
        cols,
        list.map(show),
        list.map((item) => form[field].includes(choiceKey(item))),
        Math.max(0, Math.min(form.fallbackCursors[field], list.length - 1)),
        true,
        empty,
      ),
    );
  };
  addFallbacks('fallbacks', 'None on offer for this worker');
  const reviewers = r.mode.reviewers;
  out0(
    'reviewer',
    listBlock(
      'reviewer',
      at('reviewer'),
      cols,
      reviewers.map(show),
      reviewers.map((x) => x === r.reviewer),
      Math.max(
        0,
        reviewers.findIndex((x) => x === r.reviewer),
      ),
      false,
      'No reviewer on offer for this mode',
    ),
  );
  addFallbacks('reviewerFallbacks', 'None on offer for this reviewer');
  out0('reason', {
    height: 4,
    draw(frame, y) {
      putLabel(frame, y, LABELS.reason, at('reason'), false, BOX_X);
      drawField(
        frame,
        { x: BOX_X, y, width: cols - BOX_X - 1, height: 3 },
        form.reason,
        at('reason'),
      );
      if (form.reason.text === '' && !at('reason'))
        frame.put(BOX_X, y, uiText('optional'), { dim: true });
      frame.put(BOX_X, y + 3, uiText(`${form.reason.text.length}/${REASON_MAX} characters`), {
        dim: true,
      });
    },
  });
  return out;
}

export const runConfigBody =
  (s: TuiState): Body =>
  (frame, top, height) => {
    const form = s.runConfig;
    if (form === null || height <= 0) return;
    const cols = s.size.cols;
    putSegs(frame, 1, top, ruleHeading(`Run config — ${form.title}`, cols - 1, FOCUS), cols - 1);
    const head: Line[] = [];
    const options = currentOptions(form);
    if (form.options.error !== null)
      head.push(
        ...wrap(
          joinSafe([
            uiText('Could not read the run options: '),
            form.options.error,
            uiText('. Nothing is offered and nothing is guessed.'),
          ]),
          cols - 1,
        ).map((text) => ({ text, style: BAD_STRONG })),
      );
    else if (options === null)
      head.push({ text: uiText('Reading the run options of this task…'), style: { dim: true } });
    else {
      head.push({
        text: joinSafe([
          uiText('Profile: '),
          options.profile.id,
          uiText(` (set by the ${options.profile.source}; shown only, it cannot be changed here)`),
        ]),
        style: { bold: true },
      });
      if (options.truncated)
        head.push({
          text: uiText('Only the first combinations are listed; the daemon offers no more.'),
          style: NOTICE,
        });
      if (options.modes.length === 0)
        head.push({ text: uiText('The daemon offers no mode for this task.'), style: BAD_STRONG });
    }
    if (options !== null) {
      const versionChanged = taskVersionChanged(form, options);
      if (versionChanged) {
        head.push({
          text: uiText(`Task changed (version ${form.acceptedVersion} → ${options.version}).`),
          style: WARN,
        });
        const show = s.actions?.show;
        const task = show?.data;
        const proposal =
          show?.error === null && task?.task_id === form.taskId && task.version === options.version
            ? task.run_config
            : null;
        if (proposal !== null)
          head.push({
            text: uiText(`Current proposal by ${proposal.proposed_by} (${proposal.mode}).`),
            style: WARN,
          });
      }
      if (form.changes.length > 0)
        head.push({ text: uiText(`Options changed: ${form.changes.join(', ')}`), style: WARN });
      if (versionChanged || form.changes.length > 0)
        head.push({
          text: uiText('On Mode, press Enter to accept the displayed choices.'),
          style: WARN,
        });
    }
    const sending = sendingLine(s.mutations.get(form.taskId));
    if (sending !== null) head.push(sending);
    if (form.notice !== null) head.push({ text: form.notice, style: WARN });
    if (form.error !== null) head.push({ text: form.error, style: BAD_STRONG });
    if (form.leaveArmed) head.push({ text: uiText(LEAVE_PROMPT), style: { bold: true } });
    const shown = head.slice(0, Math.max(1, height - 8));
    shown.forEach((l, i) => frame.put(1, top + 1 + i, truncate(l.text, cols - 1), l.style));
    const used = 1 + shown.length;
    // Without readable options there is nothing to choose, and nothing to draw.
    if (options === null) return;
    const fields = visibleFields(form);
    drawBlocks(
      frame,
      top + used,
      height - used,
      blocks(form, cols),
      Math.min(form.focus, fields.length - 1),
    );
  };
