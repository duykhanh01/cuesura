/**
 * The Run config screen (FR-025). Every choice comes from `run_options` of this task: a mode, a worker, a
 * reviewer and fallbacks are picked from lists, never typed. The profile is shown and sent as the daemon
 * gave it. When the lists cannot be read nothing is offered and nothing is guessed.
 */
import { MAX_FALLBACKS } from '../../domain/run-config.ts';
import type { PortError, PortResult } from '../client/daemon-port.ts';
import type { Mutation, MutationCommand } from '../client/mutations.ts';
import type { RunOptions, TaskShow } from '../client/schemas.ts';
import { joinSafe, sanitize, uiText, type SafeText } from '../terminal/safe-text.ts';
import { wrap } from '../terminal/width.ts';
import type { Key } from '../terminal/keys.ts';
import { formUnavailable } from '../views/actions.ts';
import { editField, textField, type TextField } from '../views/input.ts';
import { EXPLAIN_READ_MS, noPart, type Part } from './detail.ts';
import { fieldCommand, type Command } from './keymap.ts';
import type { Effect } from './messages.ts';
import { writeBlock } from './actions.ts';
import { mutationLock, type TuiState } from './state.ts';

export const RUN_CONFIG_BOX_X = 22;
export const REASON_MAX = 2_000;
/** Rows of the guidance of a mode on screen at once; PgUp and PgDn read the rest. */
export const WHEN_ROWS = 4;

type FallbackField = 'fallbacks' | 'reviewerFallbacks';
export type RunConfigField = 'mode' | 'worker' | 'reviewer' | FallbackField | 'reason';
const RUN_CONFIG_FIELDS: readonly RunConfigField[] = [
  'mode',
  'worker',
  'fallbacks',
  'reviewer',
  'reviewerFallbacks',
  'reason',
];

const INITIAL_CHOICES = {
  mode: null,
  worker: null,
  reviewer: null,
  fallbacks: [],
  reviewerFallbacks: [],
  fallbackCursors: { fallbacks: 0, reviewerFallbacks: 0 },
  whenTop: 0,
};

type Choice = RunOptions['modes'][number]['reviewers'][number];

export const choiceKey = (c: Choice): string => `${c.harness}/${c.model}/${c.effort}`;

export type RunConfigForm = {
  readonly taskId: string;
  readonly title: SafeText;
  /** See `TuiState.screenSession`. */
  readonly session: number;
  readonly options: Part<RunOptions>;
  /** The first version shown for this draft, or the latest version accepted with Enter. */
  readonly acceptedVersion: number | null;
  readonly freshAfter: number | null;
  readonly watermark: number | null;
  /** By value, so a list that is read again cannot move the choice onto another entry. */
  readonly mode: string | null;
  readonly worker: string | null;
  readonly reviewer: string | null;
  readonly fallbacks: readonly string[];
  readonly reviewerFallbacks: readonly string[];
  readonly fallbackCursors: Readonly<Record<FallbackField, number>>;
  readonly choicesEdited: boolean;
  readonly changes: readonly string[];
  readonly reason: TextField;
  /** First row of the guidance of the chosen mode on screen. */
  readonly whenTop: number;
  /** Into `RUN_CONFIG_FIELDS`. */
  readonly focus: number;
  readonly awaiting: boolean;
  readonly leaveArmed: boolean;
  readonly notice: SafeText | null;
  readonly error: SafeText | null;
};

type Reduced = { readonly state: TuiState; readonly effects: readonly Effect[] };

export function openRunConfig(state: TuiState, taskId: string, title: SafeText): Reduced {
  const session = state.screenSession + 1;
  return {
    state: {
      ...state,
      screens: [...state.screens, 'run_config'],
      runConfig: {
        taskId,
        title,
        session,
        options: noPart(),
        acceptedVersion: null,
        freshAfter: null,
        watermark: null,
        ...INITIAL_CHOICES,
        choicesEdited: false,
        changes: [],
        reason: textField('multi', 'Reason', '', null, REASON_MAX),
        focus: 0,
        awaiting: false,
        leaveArmed: false,
        notice: null,
        error: null,
      },
      screenSession: session,
    },
    effects: [{ type: 'read_screen' }],
  };
}

function leaveRunConfig(state: TuiState): TuiState {
  return {
    ...state,
    screens: state.screens.slice(0, state.screens.lastIndexOf('run_config')),
    runConfig: null,
  };
}

/** What the current choices resolve to in the options; `null` parts are not on offer. */
export type Resolved = {
  readonly mode: RunOptions['modes'][number];
  readonly worker: RunOptions['modes'][number]['workers'][number] | null;
  readonly reviewer: Choice | null;
  readonly fallbacks: readonly Choice[];
  readonly reviewerFallbacks: readonly Choice[];
};

export function resolve(form: RunConfigForm): Resolved | null {
  const modes = form.options.data?.modes ?? [];
  const mode = modes.find((m) => m.mode === form.mode) ?? modes[0];
  if (mode === undefined) return null;
  const worker = mode.workers.find((w) => choiceKey(w.choice) === form.worker) ?? mode.workers[0];
  const reviewer =
    mode.mode === 'direct-pr'
      ? null
      : (mode.reviewers.find((r) => choiceKey(r) === form.reviewer) ?? mode.reviewers[0] ?? null);
  const selected = (list: readonly Choice[], keys: readonly string[]): Choice[] =>
    keys.flatMap((key) => {
      const choice = list.find((item) => choiceKey(item) === key);
      return choice === undefined ? [] : [choice];
    });
  const bindings = { mode, worker: worker ?? null, reviewer };
  return {
    ...bindings,
    fallbacks: selected(fallbackChoices(bindings, 'fallbacks'), form.fallbacks),
    reviewerFallbacks: selected(
      fallbackChoices(bindings, 'reviewerFallbacks'),
      form.reviewerFallbacks,
    ),
  };
}

export function fallbackChoices(
  r: Pick<Resolved, 'mode' | 'worker' | 'reviewer'>,
  field: FallbackField,
): readonly Choice[] {
  if (field === 'fallbacks') return r.worker?.fallbacks ?? [];
  const reviewer = r.reviewer;
  return reviewer === null
    ? []
    : (r.mode.reviewer_fallbacks.find((entry) => choiceKey(entry.choice) === choiceKey(reviewer))
        ?.fallbacks ?? []);
}

export function currentOptions(form: RunConfigForm): RunOptions | null {
  return form.options.error === null && form.freshAfter === null ? form.options.data : null;
}

export function taskVersionChanged(form: RunConfigForm, options: RunOptions): boolean {
  return form.acceptedVersion !== null && form.acceptedVersion !== options.version;
}

export function visibleFields(form: RunConfigForm): readonly RunConfigField[] {
  return resolve(form)?.mode.mode === 'direct-pr'
    ? RUN_CONFIG_FIELDS.filter((f) => f !== 'reviewer' && f !== 'reviewerFallbacks')
    : RUN_CONFIG_FIELDS;
}

export function focusedRunConfigField(form: RunConfigForm): RunConfigField {
  const fields = visibleFields(form);
  return fields[Math.min(form.focus, fields.length - 1)] ?? 'mode';
}

export function whenRows(form: RunConfigForm, cols: number): readonly SafeText[] {
  const when = resolve(form)?.mode.when_to_use ?? null;
  return when === null
    ? []
    : wrap(joinSafe([uiText('When to use: '), when]), cols - RUN_CONFIG_BOX_X - 1);
}

export const runConfigDirty = (form: RunConfigForm): boolean =>
  form.reason.text !== '' ||
  form.choicesEdited ||
  form.fallbacks.length > 0 ||
  form.reviewerFallbacks.length > 0;

export type RunConfigReadMessage = {
  readonly type: 'run_config_read';
  readonly session: number;
  readonly askedAt: number;
  readonly at: number;
  readonly watermark: number | null;
  readonly result: PortResult<RunOptions>;
};

function failure(e: PortError): SafeText {
  if (e.kind !== 'rejected') return e.message;
  return joinSafe([
    uiText(`${e.code}: `),
    e.message,
    ...(e.code === 'config_invalid'
      ? [
          uiText(
            '. For project config changes, commit and merge cusr.yaml into the task’s base branch',
          ),
        ]
      : []),
  ]);
}

export function runConfigDue(form: RunConfigForm, watermark: number | null, now: number): boolean {
  const asked = form.options.attemptAt;
  if (asked === null || (form.freshAfter !== null && asked < form.freshAfter)) return true;
  if (form.options.error !== null) return now - asked >= EXPLAIN_READ_MS;
  return watermark !== form.watermark || now - asked >= EXPLAIN_READ_MS;
}

export function onRunConfigRead(state: TuiState, m: RunConfigReadMessage): TuiState {
  const form = state.runConfig;
  if (
    form === null ||
    form.session !== m.session ||
    state.stale ||
    (form.freshAfter !== null && m.askedAt < form.freshAfter)
  )
    return state;
  const data = m.result.ok && m.result.value.task_id === form.taskId ? m.result.value : null;
  const error = !m.result.ok
    ? failure(m.result.error)
    : data === null
      ? uiText('The daemon returned options for a different task.')
      : null;
  const updated = {
    ...form,
    freshAfter: null,
    watermark: m.watermark,
    // Keep the last successful identity and choices for comparison after a failure.
    options: {
      data: data ?? form.options.data,
      error,
      attemptAt: m.askedAt,
      readAt: data === null ? form.options.readAt : m.at,
    },
  };
  return { ...state, runConfig: data === null ? updated : reconcileOptions(form, updated, data) };
}

function pinChoices(form: RunConfigForm): RunConfigForm {
  const selection = resolve(form);
  return {
    ...form,
    mode: selection?.mode.mode ?? null,
    worker: selection?.worker == null ? null : choiceKey(selection.worker.choice),
    reviewer: selection?.reviewer == null ? null : choiceKey(selection.reviewer),
  };
}

function reconcileOptions(
  form: RunConfigForm,
  updated: RunConfigForm,
  data: RunOptions,
): RunConfigForm {
  const before = form.options.data;
  const newVersion = before?.version !== data.version && taskVersionChanged(form, data);
  const changes: string[] = [];
  if (before !== null) {
    if (before.revision !== data.revision) changes.push('task revision');
    if (before.profile.id !== data.profile.id || before.profile.source !== data.profile.source)
      changes.push('profile');
  }

  const modeRemoved = form.mode !== null && !data.modes.some((mode) => mode.mode === form.mode);
  if (modeRemoved) changes.push('mode');
  const candidate = pinChoices(changes.length > 0 ? { ...updated, ...INITIAL_CHOICES } : updated);
  const selection = resolve(candidate);
  let fallbacks = selection?.fallbacks.map(choiceKey) ?? [];
  let reviewerFallbacks = selection?.reviewerFallbacks.map(choiceKey) ?? [];
  if (changes.length === 0 && before !== null) {
    if (candidate.worker !== form.worker) {
      changes.push('worker');
      fallbacks = [];
    }
    if (candidate.reviewer !== form.reviewer) {
      changes.push('reviewer');
      reviewerFallbacks = [];
    }
    if (fallbacks.length !== form.fallbacks.length) changes.push('worker fallbacks');
    if (reviewerFallbacks.length !== form.reviewerFallbacks.length)
      changes.push('reviewer fallbacks');
  }
  return {
    ...candidate,
    acceptedVersion: form.acceptedVersion ?? data.version,
    fallbacks,
    reviewerFallbacks,
    ...(changes.length === 0 && !newVersion
      ? {}
      : {
          focus: 0,
          notice: null,
          changes: [...new Set([...form.changes, ...changes])],
        }),
  };
}

function proposalCommand(form: RunConfigForm, show: TaskShow): MutationCommand | null {
  const options = currentOptions(form);
  const r = resolve(form);
  if (options === null || options.version !== show.version || r === null || r.worker === null)
    return null;
  if (r.mode.mode === 'full-review' && r.reviewer === null) return null;
  const plain = (c: Choice) => ({ harness: c.harness, model: c.model, effort: c.effort });
  return {
    kind: 'task_propose_run',
    project: show.project,
    task_id: form.taskId,
    expected_version: show.version,
    payload: {
      run_config: {
        profile: options.profile.id,
        mode: r.mode.mode,
        reason: form.reason.text,
        worker: plain(r.worker.choice),
        reviewer: r.reviewer === null ? null : plain(r.reviewer),
        fallbacks: r.fallbacks.map(plain),
        ...(r.mode.mode === 'full-review'
          ? { reviewer_fallbacks: r.reviewerFallbacks.map(plain) }
          : {}),
      },
    },
  };
}

export function onRunConfigMutation(state: TuiState, m: Mutation): TuiState {
  const form = state.runConfig;
  if (
    form === null ||
    !form.awaiting ||
    m.command.kind !== 'task_propose_run' ||
    m.command.task_id !== form.taskId
  )
    return state;
  if (m.state === 'accepted') return leaveRunConfig(state);
  if (m.state !== 'rejected') return state;
  const r = m.result;
  return {
    ...state,
    runConfig: {
      ...form,
      awaiting: false,
      error:
        r?.ok === false
          ? joinSafe([uiText(`Refused by the daemon — ${r.code}: `), sanitize(r.message)])
          : uiText('The daemon refused the proposal.'),
    },
  };
}

function put(state: TuiState, form: RunConfigForm, effects: readonly Effect[] = []): Reduced {
  return { state: { ...state, runConfig: form }, effects };
}

function matchingTask(state: TuiState, form: RunConfigForm, options: RunOptions): TaskShow | null {
  const menu = state.actions;
  const show = menu?.show.data ?? null;
  if (
    menu?.taskId !== form.taskId ||
    form.watermark !== (state.board?.watermark ?? null) ||
    menu.show.error !== null ||
    menu.explain.error !== null ||
    menu.explain.data?.version !== options.version ||
    show?.version !== options.version
  )
    return null;
  return show;
}

function send(state: TuiState, form: RunConfigForm): Reduced {
  const open = mutationLock(state, form.taskId);
  if (open?.state === 'unresolved')
    return put(state, form, [{ type: 'check_again', requestId: open.requestId }]);
  const refuse = (message: string): Reduced =>
    put(state, { ...form, notice: uiText(`Nothing was sent: ${message}`), error: null });
  const menu = state.actions;
  if (menu === null || menu.taskId !== form.taskId) return refuse('this task is still being read.');
  const blocked = writeBlock(state, menu);
  if (blocked !== null) return put(state, { ...form, notice: uiText(blocked), error: null });
  if (form.options.data === null || form.options.error !== null)
    return refuse('the options of this task could not be read.');
  const options = currentOptions(form);
  const show = options === null ? null : matchingTask(state, form, options);
  if (show === null || options === null)
    return refuse('this task and its options are being read again.');
  const permission = formUnavailable(state.caller);
  if (permission !== null) return refuse(`Propose run ${permission}.`);
  if (!menu.explain.data?.allowed_actions.some((action) => action.action === 'propose'))
    return refuse('this task no longer offers Propose run.');
  if (taskVersionChanged(form, options) || form.changes.length > 0)
    return refuse('press Enter on Mode to accept the updated choices first.');
  const command = proposalCommand(form, show);
  if (command === null) return refuse('no worker or reviewer is on offer for this mode.');
  return put(state, { ...form, notice: null, error: null, awaiting: true }, [
    { type: 'submit', command },
  ]);
}

export function onRunConfigCommand(state: TuiState, command: Command): Reduced | null {
  const form = state.runConfig;
  if (form === null || command !== 'back') return null;
  if (form.awaiting) return put(state, form);
  if (runConfigDirty(form) && !form.leaveArmed) return put(state, { ...form, leaveArmed: true });
  return { state: leaveRunConfig(state), effects: [] };
}

const cycle = <T>(list: readonly T[], at: number, step: number): number =>
  Math.min(list.length - 1, Math.max(0, at + step));

export function onRunConfigKey(state: TuiState, key: Key, width: number): Reduced {
  const form0 = state.runConfig;
  if (form0 === null) return { state, effects: [] };
  const form: RunConfigForm = form0.leaveArmed ? { ...form0, leaveArmed: false } : form0;
  const fields = visibleFields(form);
  const field = focusedRunConfigField(form);
  const command = fieldCommand(key);
  const focus = (step: number): Reduced =>
    put(state, { ...form, focus: (form.focus + step + fields.length) % fields.length });
  if (command === 'submit') return send(state, form);
  if (command === 'next') return focus(1);
  if (command === 'previous') return focus(-1);
  if (form.awaiting) return put(state, form);
  if (key.kind === 'key' && (key.name === 'pagedown' || key.name === 'pageup')) {
    const last = Math.max(0, whenRows(form, state.size.cols).length - WHEN_ROWS);
    const to = form.whenTop + (key.name === 'pagedown' ? WHEN_ROWS - 1 : -(WHEN_ROWS - 1));
    return put(state, { ...form, whenTop: Math.min(last, Math.max(0, to)) });
  }
  if (field === 'reason') {
    const r = editField(form.reason, key, width);
    return put(state, r.handled ? { ...form, reason: r.field, error: null } : form);
  }
  const options = currentOptions(form);
  if (command === 'enter') {
    if (
      field === 'mode' &&
      options !== null &&
      (taskVersionChanged(form, options) || form.changes.length > 0)
    ) {
      const menu = state.actions;
      if (
        menu === null ||
        writeBlock(state, menu) !== null ||
        matchingTask(state, form, options) === null ||
        resolve(form) === null
      )
        return put(state, {
          ...form,
          notice: uiText('Wait for the current task and its options.'),
        });
      return put(state, {
        ...form,
        acceptedVersion: options.version,
        changes: [],
        notice: null,
        focus: 1,
      });
    }
    return focus(1);
  }
  const step = command === 'line_down' ? 1 : command === 'line_up' ? -1 : 0;
  const toggle = key.kind === 'char' && key.text === ' ';
  if (options === null || (step === 0 && !toggle)) return put(state, form);
  const r = resolve(form);
  if (r === null) return put(state, form);
  switch (field) {
    case 'mode': {
      const modes = options.modes;
      const at = Math.max(
        0,
        modes.findIndex((m) => m.mode === r.mode.mode),
      );
      const next = modes[cycle(modes, at, step)];
      // The other mode has its own workers and reviewers: those chosen under this one are dropped.
      return put(
        state,
        step === 0 || next === undefined || next.mode === r.mode.mode
          ? form
          : pinChoices({
              ...form,
              ...INITIAL_CHOICES,
              mode: next.mode,
              choicesEdited: true,
            }),
      );
    }
    case 'worker': {
      const workers = r.mode.workers;
      const at = Math.max(
        0,
        workers.findIndex((w) => w === r.worker),
      );
      const next = workers[cycle(workers, at, step)];
      return put(
        state,
        step === 0 || next === undefined || next === r.worker
          ? form
          : {
              ...form,
              mode: r.mode.mode,
              worker: choiceKey(next.choice),
              fallbacks: [],
              choicesEdited: true,
              fallbackCursors: { ...form.fallbackCursors, fallbacks: 0 },
            },
      );
    }
    case 'reviewer': {
      const reviewers = r.mode.reviewers;
      const at = Math.max(
        0,
        reviewers.findIndex((x) => x === r.reviewer),
      );
      const next = reviewers[cycle(reviewers, at, step)];
      return put(
        state,
        step === 0 || next === undefined || next === r.reviewer
          ? form
          : {
              ...form,
              reviewer: choiceKey(next),
              reviewerFallbacks: [],
              choicesEdited: true,
              fallbackCursors: { ...form.fallbackCursors, reviewerFallbacks: 0 },
            },
      );
    }
    case 'fallbacks':
    case 'reviewerFallbacks': {
      const list = fallbackChoices(r, field);
      const at = cycle(list, form.fallbackCursors[field], 0);
      const cursor = cycle(list, at, step);
      const navigated = { ...form, fallbackCursors: { ...form.fallbackCursors, [field]: cursor } };
      const item = list[cursor];
      if (!toggle || item === undefined) return put(state, navigated);
      const key = choiceKey(item);
      const selected = form[field];
      if (!selected.includes(key) && selected.length >= MAX_FALLBACKS)
        return put(state, {
          ...navigated,
          notice: uiText(`Choose at most ${MAX_FALLBACKS} fallbacks per list.`),
        });
      const next = selected.includes(key)
        ? selected.filter((value) => value !== key)
        : list.map(choiceKey).filter((value) => value === key || selected.includes(value));
      return put(state, { ...navigated, [field]: next, notice: null });
    }
  }
}
