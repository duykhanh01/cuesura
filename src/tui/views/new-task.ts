/** The New task form (FR-024): what is drawn comes from `model/new-task.ts`; nothing here decides anything. */
import { NEW_TASK_KEY } from '../client/mutations.ts';
import {
  fieldHeight,
  isText,
  LEAVE_PROMPT,
  NEW_TASK_FIELDS,
  PROJECT_DEFAULT_PROFILE,
  profileChoices,
  projectIds,
  type NewTaskField,
  type NewTaskForm,
} from '../model/new-task.ts';
import type { TuiState } from '../model/state.ts';
import { joinSafe, sanitize, uiText, type SafeText } from '../terminal/safe-text.ts';
import type { Frame } from '../terminal/screen.ts';
import { truncate } from '../terminal/width.ts';
import {
  BOX_X,
  drawBlocks,
  putError,
  putLabel,
  sendingLine,
  type Block,
  type Line,
} from './form.ts';
import { drawField } from './input.ts';
import { putSegs, ruleHeading } from './ink.ts';
import type { Body } from './layout.ts';
import { BAD_STRONG, FOCUS, NOTICE, WARN } from './theme.ts';

const LABELS: Record<NewTaskField, string> = {
  project: 'Project',
  title: 'Title',
  base: 'Base branch',
  description: 'Description',
  acceptance: 'Acceptance',
  priority: 'Priority',
  profile: 'Profile',
  depends: 'Depends on',
};
const REQUIRED: ReadonlySet<NewTaskField> = new Set(['project', 'title', 'base', 'acceptance']);
const PLACEHOLDER: Partial<Record<NewTaskField, string>> = {
  acceptance: 'one criterion per line',
  description: 'optional',
  priority: 'optional, whole number, higher runs first (default 0)',
};
/** Rows of the dependency list shown while it is focused. */
const LIST_ROWS = 5;

function dependsRows(form: NewTaskForm): number {
  const n = form.tasks.data?.length ?? 0;
  return 1 + Math.min(LIST_ROWS, Math.max(1, n));
}

function choiceValue(state: TuiState, form: NewTaskForm, field: 'project' | 'profile'): SafeText {
  if (field === 'project') {
    const ids = projectIds(state);
    if (state.projects === null) return uiText('The project list is not read yet');
    if (form.project === null) return uiText('No project is declared');
    const at = ids.indexOf(form.project);
    return joinSafe([
      uiText('‹ '),
      sanitize(form.project),
      uiText(at < 0 ? ' › no longer declared; choose another' : ` ›  ${at + 1} of ${ids.length}`),
    ]);
  }
  const list = profileChoices(state);
  const at = list.indexOf(form.profile);
  const name = form.profile === null ? uiText(PROJECT_DEFAULT_PROFILE) : sanitize(form.profile);
  return joinSafe([
    uiText('‹ '),
    name,
    uiText(at < 0 ? ' › no longer declared; choose another' : ` ›  ${at + 1} of ${list.length}`),
  ]);
}

function dependsBlock(form: NewTaskForm, focused: boolean, cols: number): Block {
  const error = form.errors.depends;
  const tasks = form.tasks.data;
  const summary = ((): SafeText => {
    if (form.tasks.error !== null)
      return joinSafe([uiText('Could not read the tasks: '), form.tasks.error]);
    if (tasks === null) return uiText('Reading the tasks of this project…');
    if (tasks.length === 0) return uiText('No task in this project yet');
    const n = form.depends.length;
    return uiText(n === 0 ? 'none chosen' : `${n} chosen`);
  })();
  return {
    height: (focused ? dependsRows(form) : 1) + (error === undefined ? 0 : 1),
    draw(frame, y) {
      putLabel(frame, y, LABELS.depends, focused, false);
      frame.put(
        BOX_X,
        y,
        truncate(summary, cols - BOX_X - 1),
        form.tasks.error === null ? {} : NOTICE,
      );
      const shown = focused ? dependsRows(form) : 1;
      putError(frame, y + shown, error, cols);
      if (!focused || tasks === null || tasks.length === 0) return;
      const room = dependsRows(form) - 1;
      const first = Math.max(0, Math.min(form.dependsCursor - room + 1, tasks.length - room));
      tasks.slice(first, first + room).forEach((t, i) => {
        const at = first + i;
        const on = at === form.dependsCursor;
        const mark = form.depends.includes(t.task_id) ? '[x]' : '[ ]';
        frame.put(
          BOX_X,
          y + 1 + i,
          truncate(
            joinSafe([uiText(`${on ? '› ' : '  '}${mark} `), t.title, uiText(`  ${t.status}`)]),
            cols - BOX_X - 1,
          ),
          on ? { inverse: true } : {},
        );
      });
    },
  };
}

function blockOf(state: TuiState, form: NewTaskForm, field: NewTaskField, cols: number): Block {
  const focused = NEW_TASK_FIELDS[form.focus] === field;
  if (field === 'depends') return dependsBlock(form, focused, cols);
  const error = form.errors[field];
  const height = fieldHeight(field);
  return {
    height: height + (error === undefined ? 0 : 1),
    draw(frame: Frame, y: number) {
      putLabel(frame, y, LABELS[field], focused, REQUIRED.has(field));
      if (isText(field)) {
        const f = form.texts[field];
        drawField(frame, { x: BOX_X, y, width: cols - BOX_X - 1, height }, f, focused);
        const hint = PLACEHOLDER[field];
        if (f.text === '' && !focused && hint !== undefined)
          frame.put(BOX_X, y, truncate(uiText(hint), cols - BOX_X - 1), { dim: true });
      } else {
        frame.put(
          BOX_X,
          y,
          truncate(choiceValue(state, form, field), cols - BOX_X - 1),
          focused ? { bold: true } : {},
        );
      }
      putError(frame, y + height, error, cols);
    },
  };
}

export const newTaskBody =
  (s: TuiState): Body =>
  (frame, top, height) => {
    const form = s.newTask;
    if (form === null || height <= 0) return;
    const cols = s.size.cols;
    const head: Line[] = [];
    const sending = sendingLine(s.mutations.get(NEW_TASK_KEY));
    if (sending !== null) head.push(sending);
    if (form.notice !== null) head.push({ text: form.notice, style: WARN });
    const general = form.errors.form;
    if (general !== undefined) head.push({ text: general, style: BAD_STRONG });
    if (form.leaveArmed) head.push({ text: uiText(LEAVE_PROMPT), style: { bold: true } });
    putSegs(frame, 1, top, ruleHeading('New task', cols - 1, FOCUS), cols - 1);
    // Notices come first but never take the room of the field in focus.
    const shown = head.slice(0, Math.max(0, height - 8));
    shown.forEach((l, i) => frame.put(1, top + 1 + i, truncate(l.text, cols - 1), l.style));
    const used = 1 + shown.length;
    drawBlocks(
      frame,
      top + used,
      height - used,
      NEW_TASK_FIELDS.map((f) => blockOf(s, form, f, cols)),
      form.focus,
    );
  };
