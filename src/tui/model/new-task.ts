/**
 * The New task form (FR-024). Project, profile and dependencies are chosen from what the daemon lists, never
 * typed, so an ID or a name that does not exist cannot be entered. What was typed stays in the form until the
 * daemon accepts the task: a refusal, a stale screen or a lost answer never empties it (FR-018, FR-044).
 */
import type { PortResult } from '../client/daemon-port.ts';
import { NEW_TASK_KEY, type Mutation, type MutationCommand } from '../client/mutations.ts';
import type { BoardReply, BoardRow } from '../client/schemas.ts';
import { joinSafe, sanitize, uiText, type SafeText } from '../terminal/safe-text.ts';
import type { Key } from '../terminal/keys.ts';
import { formUnavailable } from '../views/actions.ts';
import { editField, textField, type TextField } from '../views/input.ts';
import { noPart, type Part } from './detail.ts';
import { fieldCommand, type Command } from './keymap.ts';
import type { Effect } from './messages.ts';
import { mutationLock, writeLock, type TuiState } from './state.ts';

export type NewTaskField =
  | 'project'
  | 'title'
  | 'base'
  | 'description'
  | 'acceptance'
  | 'priority'
  | 'profile'
  | 'depends';

export const NEW_TASK_FIELDS: readonly NewTaskField[] = [
  'project',
  'title',
  'base',
  'description',
  'acceptance',
  'priority',
  'profile',
  'depends',
];

export type NewTaskText = Extract<
  NewTaskField,
  'title' | 'base' | 'description' | 'acceptance' | 'priority'
>;

export const isText = (f: NewTaskField): f is NewTaskText =>
  f !== 'project' && f !== 'profile' && f !== 'depends';

export const PROJECT_DEFAULT_PROFILE = 'Project default';
export const TITLE_MAX = 512;
export const DESCRIPTION_MAX = 65_536;
export const BASE_MAX = 255;
/** What the daemon's `NewTaskSchema` allows of the acceptance list and the dependencies. */
export const ACCEPTANCE_MAX_LINES = 100;
export const ACCEPTANCE_MAX_UNITS = 4_096;
export const DEPENDS_MAX = 100;
/** Another page is read once the cursor is this close to the end of what was read: memory follows the reader. */
export const DEPENDENCY_AHEAD = 20;

export type NewTaskErrors = Partial<Record<NewTaskField | 'form', SafeText>>;

export type NewTaskForm = {
  /** See `TuiState.screenSession`. */
  readonly session: number;
  readonly texts: Readonly<Record<NewTaskText, TextField>>;
  /** Into `NEW_TASK_FIELDS`. */
  readonly focus: number;
  /** The project's ID, by value: a project list read again cannot move the choice onto another one. */
  readonly project: string | null;
  /** The profile's name, by value; `null` is `Project default`. */
  readonly profile: string | null;
  /** Task IDs chosen as dependencies. */
  readonly depends: readonly string[];
  readonly dependsCursor: number;
  /** The tasks of the chosen project, from `task_board`. */
  readonly tasks: Part<readonly BoardRow[]>;
  /** Cursor of the next page still to read; `null` when the list is whole. */
  readonly tasksCursor: string | null;
  /** The project `tasks` was asked for; a change of project asks again. */
  readonly tasksProject: string | null;
  readonly errors: NewTaskErrors;
  /** Ctrl-S was pressed and the write has not come back with an answer. */
  readonly awaiting: boolean;
  /** Esc was pressed once with content in the form; the next Esc leaves. */
  readonly leaveArmed: boolean;
  /** What the last send said, when it was not sent. */
  readonly notice: SafeText | null;
};

type Reduced = { readonly state: TuiState; readonly effects: readonly Effect[] };

export const LEAVE_PROMPT =
  'Leaving loses what you typed. Press Esc again to leave, any other key to stay.';

function initialNewTask(state: TuiState, session: number): NewTaskForm {
  const ids = (state.projects ?? []).map((p) => p.id);
  const filtered = state.filters.project;
  return {
    session,
    texts: {
      title: textField('line', 'Title', '', null, TITLE_MAX),
      base: textField('line', 'Base branch', '', null, BASE_MAX),
      description: textField('multi', 'Description', '', null, DESCRIPTION_MAX),
      acceptance: textField('multi', 'Acceptance', ''),
      priority: textField('line', 'Priority', '', 6),
    },
    focus: 0,
    project: filtered !== null && ids.includes(filtered) ? filtered : (ids[0] ?? null),
    profile: null,
    depends: [],
    dependsCursor: 0,
    tasks: noPart(),
    tasksCursor: null,
    tasksProject: null,
    errors: {},
    awaiting: false,
    leaveArmed: false,
    notice: null,
  };
}

export function openNewTask(state: TuiState): Reduced {
  const session = state.screenSession + 1;
  return {
    state: {
      ...state,
      screens: [...state.screens, 'new_task'],
      newTask: initialNewTask(state, session),
      screenSession: session,
    },
    effects: [{ type: 'read_screen' }],
  };
}

function leaveNewTask(state: TuiState): TuiState {
  return {
    ...state,
    screens: state.screens.slice(0, state.screens.lastIndexOf('new_task')),
    newTask: null,
  };
}

export const projectIds = (state: TuiState): readonly string[] =>
  (state.projects ?? []).map((p) => p.id);

/** The chosen project, only while the project list still declares it. */
export const chosenProject = (state: TuiState, form: NewTaskForm): string | null =>
  form.project !== null && projectIds(state).includes(form.project) ? form.project : null;

/** The profile list the form offers: `Project default` (`null`) first. */
export const profileChoices = (state: TuiState): readonly (string | null)[] => [
  null,
  ...state.profiles,
];

/**
 * The project and profile lists were read again: a project or profile that is gone stays named on screen
 * but cannot be sent, and the dependencies of a project that is gone are dropped with it.
 */
export function reconcileNewTask(state: TuiState, reconnecting: boolean): TuiState {
  const form = state.newTask;
  if (form === null) return state;
  const project = form.project ?? projectIds(state)[0] ?? null;
  const gone =
    project !== null &&
    state.projects !== null &&
    chosenProject(state, { ...form, project }) === null;
  if (!gone && !reconnecting && project === form.project) return state;
  if (!gone && !reconnecting) return { ...state, newTask: { ...form, project } };

  const session = state.screenSession + 1;
  return {
    ...state,
    screenSession: session,
    newTask: {
      ...form,
      session,
      project,
      depends: gone ? [] : form.depends,
      dependsCursor: 0,
      tasks: noPart(),
      tasksCursor: null,
      tasksProject: null,
    },
  };
}

/** Content the user would lose by leaving. A project that is only the first of the list is no content. */
export function hasContent(form: NewTaskForm): boolean {
  return (
    Object.values(form.texts).some((f) => f.text !== '') ||
    form.depends.length > 0 ||
    form.profile !== null
  );
}

const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

/** What is wrong with the form as typed, by field. Empty when it can go to the daemon. */
export function validate(state: TuiState, form: NewTaskForm): NewTaskErrors {
  const errors: Record<string, SafeText> = {};
  const set = (field: NewTaskField | 'form', text: string): void => {
    errors[field] = uiText(text);
  };
  if (state.projects === null) set('project', 'The project list is not read yet.');
  else if (chosenProject(state, form) === null)
    set(
      'project',
      form.project === null
        ? 'No project is declared to create the task in.'
        : 'This project is no longer declared; choose another.',
    );
  if (form.profile !== null && !state.profiles.includes(form.profile))
    set('profile', 'This profile is no longer declared; choose another.');
  if (form.texts.title.text.trim() === '') set('title', 'A title is required.');
  if (form.texts.base.text.trim() === '') set('base', 'A base branch is required.');
  const criteria = lines(form.texts.acceptance.text);
  if (criteria.length === 0)
    set('acceptance', 'Write at least one acceptance criterion, one per line.');
  else if (criteria.length > ACCEPTANCE_MAX_LINES)
    set('acceptance', `At most ${ACCEPTANCE_MAX_LINES} criteria; there are ${criteria.length}.`);
  else {
    const long = criteria.findIndex((c) => c.length > ACCEPTANCE_MAX_UNITS);
    if (long >= 0)
      set(
        'acceptance',
        `Criterion ${long + 1} is longer than ${ACCEPTANCE_MAX_UNITS} characters; shorten or split it.`,
      );
  }
  if (form.texts.title.text.trim().length > TITLE_MAX)
    set('title', `The title is longer than ${TITLE_MAX} characters.`);
  if (form.texts.base.text.trim().length > BASE_MAX)
    set('base', `The base branch is longer than ${BASE_MAX} characters.`);
  if (form.texts.description.text.length > DESCRIPTION_MAX)
    set('description', `The description is longer than ${DESCRIPTION_MAX} characters.`);
  if (form.depends.length > DEPENDS_MAX)
    set('depends', `At most ${DEPENDS_MAX} dependencies; ${form.depends.length} are chosen.`);
  const priority = form.texts.priority.text.trim();
  if (priority !== '') {
    const n = Number(priority);
    if (!/^-?\d+$/.test(priority) || Math.abs(n) > 1_000)
      set('priority', 'Priority is a whole number from -1000 to 1000.');
  }
  return errors;
}

function taskCommand(state: TuiState, form: NewTaskForm): MutationCommand | null {
  const project = chosenProject(state, form);
  if (project === null) return null;
  const priority = form.texts.priority.text.trim();
  const profile = form.profile;
  return {
    kind: 'task_add',
    project,
    task_id: null,
    expected_version: null,
    payload: {
      task: {
        title: form.texts.title.text.trim(),
        base_branch: form.texts.base.text.trim(),
        description: form.texts.description.text,
        acceptance: lines(form.texts.acceptance.text),
        depends_on: form.depends,
        ...(priority === '' ? {} : { priority: Number(priority) }),
        ...(profile === null ? {} : { profile }),
      },
    },
  };
}

/** The field a refusal that names no field most likely concerns, from its code and words. */
function refusedField(code: string, message: string): NewTaskField | 'form' {
  const said = `${code} ${message}`.toLowerCase();
  if (said.includes('profile')) return 'profile';
  if (said.includes('depend') || said.includes('cycle')) return 'depends';
  if (said.includes('base')) return 'base';
  if (said.includes('title')) return 'title';
  if (said.includes('description')) return 'description';
  if (said.includes('accept')) return 'acceptance';
  if (said.includes('priority')) return 'priority';
  if (said.includes('project')) return 'project';
  return 'form';
}

/** The tracker moved the write this form sent: close on acceptance, keep everything on refusal. */
export function onNewTaskMutation(state: TuiState, m: Mutation): TuiState {
  const form = state.newTask;
  if (form === null || !form.awaiting || m.command.kind !== 'task_add') return state;
  if (m.state === 'accepted') return leaveNewTask(state);
  if (m.state !== 'rejected') return state;
  const result = m.result;
  const text =
    result?.ok === false
      ? joinSafe([uiText(`${result.code}: `), sanitize(result.message)])
      : uiText('The daemon refused the task.');
  const field = result?.ok === false ? refusedField(result.code, result.message) : 'form';
  return {
    ...state,
    newTask: {
      ...form,
      awaiting: false,
      notice: null,
      focus: field === 'form' ? form.focus : NEW_TASK_FIELDS.indexOf(field),
      errors: {
        [field]: joinSafe([uiText('Refused by the daemon — '), text]),
      },
    },
  };
}

export type NewTaskTasksMessage = {
  readonly type: 'new_task_tasks_read';
  readonly session: number;
  readonly project: string;
  /** The page asked for: `null` is the first. */
  readonly cursor: string | null;
  readonly askedAt: number;
  readonly at: number;
  readonly result: PortResult<BoardReply>;
};

/** What the task list asks for next: the first page, the page after the last one read, or a retry. */
export function newTaskTasksDue(
  state: TuiState,
  now: number,
  retryMs: number,
): { readonly project: string; readonly cursor: string | null } | null {
  const form = state.newTask;
  if (form === null) return null;
  const project = chosenProject(state, form);
  if (project === null) return null;
  if (form.tasksProject !== project) return { project, cursor: null };
  const asked = form.tasks.attemptAt;
  if (form.tasks.error !== null)
    return asked !== null && now - asked >= retryMs ? { project, cursor: form.tasksCursor } : null;
  const unverified = hasUnverifiedDependencies(form);
  // Further pages are read as the cursor nears the end of what was read, so a long project costs only what is read.
  const read = form.tasks.data?.length ?? 0;
  return form.tasksCursor !== null && (unverified || form.dependsCursor >= read - DEPENDENCY_AHEAD)
    ? { project, cursor: form.tasksCursor }
    : null;
}

function hasUnverifiedDependencies(form: NewTaskForm): boolean {
  return form.depends.some((id) => !form.tasks.data?.some((row) => row.task_id === id));
}

export function onNewTaskTasksRead(state: TuiState, m: NewTaskTasksMessage): TuiState {
  const form = state.newTask;
  if (
    state.stale ||
    form === null ||
    form.session !== m.session ||
    chosenProject(state, form) !== m.project
  )
    return state;
  // An answer for a page other than the one wanted next would repeat or skip tasks.
  if (m.cursor !== (form.tasksProject === m.project ? form.tasksCursor : null)) return state;
  if (!m.result.ok)
    return {
      ...state,
      newTask: {
        ...form,
        tasksProject: m.project,
        // Pages already read stay: they are still tasks of this project.
        tasks: { ...form.tasks, error: m.result.error.message, attemptAt: m.askedAt },
      },
    };
  const board = m.result.value;
  if (board.unchanged) return state;
  const items = [...(m.cursor === null ? [] : (form.tasks.data ?? [])), ...board.items];
  const depends =
    board.next_cursor === null
      ? form.depends.filter((id) => items.some((row) => row.task_id === id))
      : form.depends;
  return {
    ...state,
    newTask: {
      ...form,
      tasksProject: m.project,
      tasksCursor: board.next_cursor,
      tasks: { data: items, error: null, attemptAt: m.askedAt, readAt: m.at },
      depends,
      notice:
        depends.length === form.depends.length
          ? form.notice
          : uiText('The task list changed. Dependencies that are no longer listed were removed.'),
    },
  };
}

function put(state: TuiState, form: NewTaskForm, effects: readonly Effect[] = []): Reduced {
  return { state: { ...state, newTask: form }, effects };
}

function send(state: TuiState, form: NewTaskForm): Reduced {
  const open = mutationLock(state, NEW_TASK_KEY);
  if (open?.state === 'unresolved')
    return put(state, form, [{ type: 'check_again', requestId: open.requestId }]);
  const errors = validate(state, form);
  if (Object.keys(errors).length > 0) {
    const first = NEW_TASK_FIELDS.findIndex((f) => errors[f] !== undefined);
    return put(state, {
      ...form,
      errors,
      notice: uiText('Nothing was sent: fix the fields marked below.'),
      focus: first < 0 ? form.focus : first,
    });
  }
  const permission = formUnavailable(state.caller);
  if (permission !== null)
    return put(state, { ...form, notice: uiText(`Nothing was sent: New task ${permission}.`) });
  const lock = writeLock(state, NEW_TASK_KEY);
  const blocked =
    open !== null
      ? `Nothing was sent: an earlier new task is still being sent (request ${open.requestId}).`
      : lock !== null
        ? 'Nothing was sent: the data on screen may be out of date. Try again once it has been read again.'
        : hasUnverifiedDependencies(form)
          ? 'Nothing was sent: selected dependencies are still being checked.'
          : null;
  if (blocked !== null) return put(state, { ...form, errors: {}, notice: uiText(blocked) });
  const command = taskCommand(state, form);
  if (command === null) return put(state, form);
  return put(state, { ...form, errors: {}, notice: null, awaiting: true }, [
    { type: 'submit', command },
  ]);
}

const FIELD_HEIGHT: Partial<Record<NewTaskField, number>> = {
  description: 3,
  acceptance: 3,
};
export const fieldHeight = (f: NewTaskField): number => FIELD_HEIGHT[f] ?? 1;

/** Esc (the `back` command): leaves, or asks once when there is something to lose. */
export function onNewTaskCommand(state: TuiState, command: Command): Reduced | null {
  const form = state.newTask;
  if (form === null) return null;
  if (command !== 'back') return null;
  if (form.awaiting) return put(state, form);
  if (hasContent(form) && !form.leaveArmed) return put(state, { ...form, leaveArmed: true });
  return { state: leaveNewTask(state), effects: [] };
}

function moveFocus(form: NewTaskForm, step: number): NewTaskForm {
  const n = NEW_TASK_FIELDS.length;
  return { ...form, focus: (form.focus + step + n) % n };
}

/** A key that is no command of the screen: text for the focused field, or a move in a list. */
export function onNewTaskKey(state: TuiState, key: Key, width: number): Reduced {
  const form0 = state.newTask;
  if (form0 === null) return { state, effects: [] };
  // Any key but a second Esc keeps the form.
  const form = form0.leaveArmed ? { ...form0, leaveArmed: false } : form0;
  const field = NEW_TASK_FIELDS[form.focus] ?? 'title';
  const command = fieldCommand(key);
  if (command === 'submit') return send(state, form);
  if (command === 'next') return put(state, moveFocus(form, 1));
  if (command === 'previous') return put(state, moveFocus(form, -1));
  if (form.awaiting) return put(state, form);
  if (isText(field)) {
    const r = editField(form.texts[field], key, width);
    if (!r.handled) return put(state, form);
    const errors = { ...form.errors };
    delete errors[field];
    const edited = { ...form, texts: { ...form.texts, [field]: r.field }, errors };
    // Enter in a one-line field goes on to the next field.
    return put(state, r.signal === 'next' ? moveFocus(edited, 1) : edited);
  }
  return onChoiceKey(state, form, field, key, command);
}

function onChoiceKey(
  state: TuiState,
  form: NewTaskForm,
  field: 'project' | 'profile' | 'depends',
  key: Key,
  command: ReturnType<typeof fieldCommand>,
): Reduced {
  if (command === 'enter') return put(state, moveFocus(form, 1));
  const step = command === 'line_down' ? 1 : command === 'line_up' ? -1 : 0;
  const clear = (f: NewTaskForm): NewTaskForm => {
    const errors = { ...f.errors };
    delete errors[field];
    return { ...f, errors };
  };
  switch (field) {
    case 'project': {
      const ids = projectIds(state);
      const at = form.project === null ? -1 : ids.indexOf(form.project);
      // A project that is gone is left by any move: to the nearest end of the list.
      const next = Math.min(
        ids.length - 1,
        Math.max(0, at < 0 ? (step > 0 ? 0 : ids.length - 1) : at + step),
      );
      const id = ids[next];
      if (step === 0 || id === undefined || id === form.project) return put(state, form);
      // Another project has other tasks: what was chosen of the old list does not carry over.
      const session = state.screenSession + 1;
      return put(
        { ...state, screenSession: session },
        clear({
          ...form,
          session,
          project: id,
          depends: [],
          dependsCursor: 0,
          tasks: noPart(),
          tasksCursor: null,
          tasksProject: null,
        }),
        [{ type: 'read_screen' }],
      );
    }
    case 'profile': {
      const list = profileChoices(state);
      const at = list.indexOf(form.profile);
      if (step === 0) return put(state, form);
      const next = Math.min(
        list.length - 1,
        Math.max(0, at < 0 ? (step > 0 ? 0 : list.length - 1) : at + step),
      );
      return put(state, clear({ ...form, profile: list[next] ?? null }));
    }
    case 'depends': {
      const tasks = form.tasks.data ?? [];
      const cursor = Math.min(
        Math.max(0, tasks.length - 1),
        Math.max(0, form.dependsCursor + step),
      );
      if (key.kind === 'char' && key.text === ' ') {
        const id = tasks[cursor]?.task_id;
        if (id === undefined) return put(state, form);
        const has = form.depends.includes(id);
        return put(
          state,
          clear({
            ...form,
            dependsCursor: cursor,
            depends: has ? form.depends.filter((d) => d !== id) : [...form.depends, id],
          }),
        );
      }
      // Near the end of what was read, the next page is asked for.
      const near = form.tasksCursor !== null && cursor >= tasks.length - DEPENDENCY_AHEAD;
      return put(state, { ...form, dependsCursor: cursor }, near ? [{ type: 'read_screen' }] : []);
    }
  }
}
