import { MAX_FALLBACKS } from '../../../src/domain/run-config.ts';
import { mutationTarget, type Mutation } from '../../../src/tui/client/mutations.ts';
import { describe, expect, it } from 'vitest';
import {
  RunOptionsSchema,
  type BoardReply,
  type RunOptions,
  type TaskShow,
  type TaskExplain,
} from '../../../src/tui/client/schemas.ts';
import {
  NEW_TASK_FIELDS,
  onNewTaskKey,
  validate,
  type NewTaskField,
  openNewTask,
  newTaskTasksDue,
  onNewTaskTasksRead,
} from '../../../src/tui/model/new-task.ts';
import {
  currentOptions,
  onRunConfigKey,
  onRunConfigRead,
  openRunConfig,
} from '../../../src/tui/model/run-config.ts';
import { hintBar } from '../../../src/tui/model/keymap.ts';
import { actionItems } from '../../../src/tui/views/actions.ts';
import { openActions } from '../../../src/tui/model/actions.ts';
import { reduce } from '../../../src/tui/model/reduce.ts';
import { initialState, type TuiState } from '../../../src/tui/model/state.ts';
import { renderFrame } from '../../../src/tui/views/layout.ts';
import { screenBody } from '../../../src/tui/views/screen-body.ts';
import type { Key } from '../../../src/tui/terminal/keys.ts';
import { sanitize } from '../../../src/tui/terminal/safe-text.ts';

const TASK = '019a0000-0000-7000-8000-000000000001';
const base = (): TuiState => ({
  ...initialState({ cols: 100, rows: 30 }),
  connection: { kind: 'online' },
  lastUpdatedAt: 1,
  caller: { actor: sanitize('owner'), roles: ['operate'], trusted_confirmer: true },
  projects: [{ id: 'acme', repo: null }],
  profiles: ['standard'],
});

const row = (n: number) => ({
  task_id: `019a0000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  title: sanitize(`T${n}`),
  status: 'PENDING',
});
const page = (from: number, count: number, next: string | null): BoardReply =>
  ({
    unchanged: false,
    watermark: 1,
    items: Array.from({ length: count }, (_, i) => row(from + i)),
    next_cursor: next,
  }) as unknown as BoardReply;

describe('the dependency list of New task', () => {
  it('reads further pages as the cursor nears the end, with no ceiling, and picks a task past 1,000', () => {
    let s = openNewTask(base()).state;
    const session = s.newTask?.session ?? 0;
    const read = (cursor: string | null, value: BoardReply): void => {
      s = onNewTaskTasksRead(s, {
        type: 'new_task_tasks_read',
        session,
        project: 'acme',
        cursor,
        askedAt: 1,
        at: 2,
        result: { ok: true, value },
      });
    };
    const at = (n: number): void => {
      s = {
        ...s,
        newTask: {
          ...(s.newTask as NonNullable<typeof s.newTask>),
          dependsCursor: n,
          focus: NEW_TASK_FIELDS.indexOf('depends'),
        },
      };
    };
    expect(newTaskTasksDue(s, 0, 5_000)).toEqual({ project: 'acme', cursor: null });
    read(null, page(1, 100, 'c1'));
    // Far from the end of what was read: nothing more is asked for.
    expect(newTaskTasksDue(s, 0, 5_000)).toBeNull();
    // A page that is not the one wanted next changes nothing.
    read('other', page(500, 3, null));
    expect(s.newTask?.tasks.data).toHaveLength(100);
    let next = 1;
    for (; next < 11; next++) {
      at((s.newTask?.tasks.data?.length ?? 0) - 1);
      const due = newTaskTasksDue(s, 0, 5_000);
      expect(due?.cursor).toBe(`c${next}`);
      read(due?.cursor ?? null, page(next * 100 + 1, 100, next === 10 ? null : `c${next + 1}`));
    }
    expect(s.newTask?.tasks.data).toHaveLength(1_100);
    expect(newTaskTasksDue(s, 0, 5_000)).toBeNull();
    // A task past the 1,000th is chosen like any other.
    at(1_050);
    s = onNewTaskKey(s, { kind: 'char', text: ' ' }, 80).state;
    expect(s.newTask?.depends).toEqual([row(1_051).task_id]);
  });
});

describe('what the New task form chose from the project and profile lists', () => {
  const listed = (ids: string[], profiles: string[]): TuiState => ({
    ...base(),
    lastUpdatedAt: 1,
    projects: ids.map((id) => ({ id, repo: null })),
    profiles,
  });
  const read = (s: TuiState, next: TuiState): TuiState =>
    reduce(s, {
      type: 'read_succeeded',
      board: { unchanged: true, watermark: 1 } as never,
      health: {} as never,
      projects: {
        caller: {} as never,
        projects: next.projects ?? [],
        profiles: next.profiles ?? [],
      },
      at: 3,
    }).state;

  it('keeps the project and the profile by value when entries are inserted before them', () => {
    let s = openNewTask(listed(['b', 'c'], ['p2'])).state;
    s = {
      ...s,
      newTask: { ...(s.newTask as NonNullable<typeof s.newTask>), project: 'c', profile: 'p2' },
    };
    s = read(s, listed(['a', 'b', 'c'], ['p1', 'p2']));
    expect(s.newTask?.project).toBe('c');
    expect(s.newTask?.profile).toBe('p2');
  });

  it('checks selected dependencies again after reconnect and drops only the missing ones', () => {
    const opened = openNewTask(listed(['acme'], [])).state;
    let s = read(
      {
        ...opened,
        stale: true,
        newTask: {
          ...opened.newTask!,
          depends: [row(1).task_id, row(150).task_id, row(999).task_id],
        },
      },
      listed(['acme'], []),
    );
    const readPage = (cursor: string | null, value: BoardReply) =>
      onNewTaskTasksRead(s, {
        type: 'new_task_tasks_read',
        session: s.newTask!.session,
        project: 'acme',
        cursor,
        askedAt: 4,
        at: 5,
        result: { ok: true, value },
      });
    expect(s.newTask?.session).not.toBe(opened.newTask?.session);
    s = readPage(null, page(1, 100, 'next'));
    expect(newTaskTasksDue(s, 5, 5_000)?.cursor).toBe('next');
    s = readPage('next', page(101, 80, null));
    expect(s.newTask?.depends).toEqual([row(1).task_id, row(150).task_id]);
    expect(s.newTask?.notice).toContain('no longer listed');
  });

  it('cannot send a project or profile that is gone, and drops the dependencies of the project', () => {
    let s = openNewTask(listed(['a', 'b'], ['p1'])).state;
    s = {
      ...s,
      newTask: {
        ...(s.newTask as NonNullable<typeof s.newTask>),
        project: 'b',
        profile: 'p1',
        depends: [row(1).task_id],
      },
    };
    s = read(s, listed(['a'], []));
    const form = s.newTask as NonNullable<typeof s.newTask>;
    expect(form.depends).toEqual([]);
    const errors = validate(s, form);
    expect(String(errors.project)).toContain('no longer declared');
    expect(String(errors.profile)).toContain('no longer declared');
  });
});

const choice = { harness: 'claude', model: 'sonnet', effort: 'medium' };
const options = RunOptionsSchema.parse({
  task_id: TASK,
  revision: 1,
  version: 1,
  profile: { id: 'standard', source: 'project' },
  modes: [
    {
      mode: 'direct-pr',
      when_to_use: null,
      reviewers: [],
      reviewer_fallbacks: [],
      workers: [{ choice, fallbacks: [] }],
    },
  ],
  truncated: false,
});

function runWithMenu(version = 1): TuiState {
  const title = sanitize('t');
  const s = openActions(base(), TASK, title).state;
  const menu = s.actions!;
  return openRunConfig(
    {
      ...s,
      actions: {
        ...menu,
        show: { ...menu.show, data: { project: 'acme', version } as TaskShow },
        explain: {
          ...menu.explain,
          data: {
            version,
            allowed_actions: [{ action: 'propose', note: sanitize('Propose it'), command: null }],
          } as TaskExplain,
        },
      },
    },
    TASK,
    title,
  ).state;
}

function optionsRead(s: TuiState, value: RunOptions, askedAt = 1): TuiState {
  return onRunConfigRead(s, {
    type: 'run_config_read',
    session: s.runConfig!.session,
    askedAt,
    at: askedAt + 1,
    watermark: null,
    result: { ok: true, value },
  });
}

function optionsFailed(s: TuiState): TuiState {
  return onRunConfigRead(s, {
    type: 'run_config_read',
    session: s.runConfig!.session,
    askedAt: 3,
    at: 4,
    watermark: null,
    result: {
      ok: false,
      error: { kind: 'rejected', code: 'config_invalid', message: sanitize('bad') },
    },
  });
}

const key = (s: TuiState, key: Key) => reduce(s, { type: 'key', key });

describe('Run config reads and writes', () => {
  it('keeps the last good options internally and sends nothing until a read succeeds again', () => {
    let s = optionsRead(runWithMenu(), options);
    const send = (state: TuiState) => onRunConfigKey(state, named('ctrl_s'), 80);
    expect(send(s).effects).toMatchObject([
      {
        type: 'submit',
        command: {
          expected_version: 1,
          task_id: TASK,
          payload: { run_config: { profile: 'standard', mode: 'direct-pr', reviewer: null } },
        },
      },
    ]);
    s = optionsFailed(s);
    expect(s.runConfig?.options.data).toBe(options);
    expect(currentOptions(s.runConfig!)).toBeNull();
    expect(send(s).effects).toEqual([]);
    expect(String(send(s).state.runConfig?.notice)).toContain('could not be read');
    expect(send(optionsRead(s, options, 5)).effects).toHaveLength(1);
  });

  it('rejects an option read for another task or a different version and requires a fresh read after reconnect', () => {
    const s = runWithMenu();
    const send = (state: TuiState) => onRunConfigKey(state, named('ctrl_s'), 80);
    expect(
      send(optionsRead(s, { ...options, task_id: row(2).task_id } as RunOptions)).effects,
    ).toEqual([]);
    expect(send(optionsRead(s, { ...options, version: 2 })).effects).toEqual([]);
    const reconnecting = { ...s, runConfig: { ...s.runConfig!, freshAfter: 3 } };
    expect(send(optionsRead(reconnecting, options, 2)).effects).toEqual([]);
    expect(send(optionsRead(reconnecting, options, 3)).effects).toHaveLength(1);
  });
  const workerOptions = (...models: string[]): RunOptions => ({
    ...options,
    modes: [
      {
        ...options.modes[0]!,
        workers: models.map((model) => ({
          choice: {
            harness: sanitize('claude'),
            model: sanitize(model),
            effort: sanitize('medium'),
          },
          fallbacks: [],
        })),
      },
    ],
  });

  function choseWorker(): TuiState {
    let s = optionsRead(runWithMenu(), workerOptions('first', 'second'));
    for (const nav of [
      named('tab'),
      named('down'),
      named('tab'),
      named('tab'),
      paste('saved reason'),
    ])
      s = key(s, nav).state;
    expect(s.runConfig?.worker).toContain('/second/');
    return s;
  }

  it('requires accepting a replacement worker before proposing with the saved reason', () => {
    const s = optionsRead(choseWorker(), workerOptions('replacement'), 5);
    expect(s.runConfig?.changes).toEqual(['worker']);
    expect(key(s, named('ctrl_s')).effects).toEqual([]);
    const accepted = key(s, named('enter'));
    expect(accepted.effects).toEqual([]);
    expect(key(accepted.state, named('ctrl_s')).effects).toMatchObject([
      {
        type: 'submit',
        command: {
          payload: { run_config: { worker: { model: 'replacement' }, reason: 'saved reason' } },
        },
      },
    ]);
  });

  it('requires accepting a new revision even after an intervening error and reconnect', () => {
    const failed = optionsFailed(choseWorker());
    const s = optionsRead(
      {
        ...failed,
        actions: runWithMenu(2).actions,
        runConfig: { ...failed.runConfig!, freshAfter: 5 },
      },
      { ...workerOptions('first', 'second'), revision: 2, version: 2 },
      5,
    );
    expect(s.runConfig?.reason.text).toBe('saved reason');
    expect(s.runConfig?.changes).toEqual(['task revision']);
    expect(s.runConfig?.worker).toContain('/first/');
    expect(key(s, named('ctrl_s')).effects).toEqual([]);
    expect(key(key(s, named('enter')).state, named('ctrl_s')).effects).toMatchObject([
      {
        type: 'submit',
        command: { expected_version: 2, payload: { run_config: { worker: { model: 'first' } } } },
      },
    ]);
  });

  it('keeps the accepted version through refreshes and requires matching task reads to advance it', () => {
    const draft = choseWorker();
    const next = { ...workerOptions('second', 'first'), version: 2 };
    const ahead = optionsRead(draft, next, 3);
    expect(ahead.runConfig?.acceptedVersion).toBe(1);
    expect(key(ahead, named('ctrl_s')).effects).toEqual([]);
    const earlyEnter = key(ahead, named('enter'));
    expect(earlyEnter.effects).toEqual([]);
    expect(earlyEnter.state.runConfig?.acceptedVersion).toBe(1);

    const matching = { ...earlyEnter.state, actions: runWithMenu(2).actions };
    const reread = optionsRead(matching, next, 5);
    expect(reread.runConfig?.acceptedVersion).toBe(1);
    expect(reread.runConfig?.worker).toContain('/second/');
    expect(key(reread, named('ctrl_s')).effects).toEqual([]);

    const accepted = key(reread, named('enter'));
    expect(accepted.effects).toEqual([]);
    expect(accepted.state.runConfig?.acceptedVersion).toBe(2);
    expect(key(accepted.state, named('ctrl_s')).effects).toMatchObject([
      {
        type: 'submit',
        command: {
          expected_version: 2,
          payload: {
            run_config: {
              worker: { model: 'second' },
              reason: 'saved reason',
            },
          },
        },
      },
    ]);
    const later = optionsRead(
      { ...accepted.state, actions: runWithMenu(3).actions },
      { ...next, version: 3 },
      7,
    );
    expect(later.runConfig?.acceptedVersion).toBe(2);
    expect(key(later, named('ctrl_s')).effects).toEqual([]);
  });

  it('keeps the same binding when the daemon reorders the list', () => {
    const s = optionsRead(optionsFailed(choseWorker()), workerOptions('second', 'first'), 5);
    expect(s.runConfig?.changes).toEqual([]);
    expect(key(s, named('ctrl_s')).effects).toMatchObject([
      {
        type: 'submit',
        command: { payload: { run_config: { worker: { model: 'second' } } } },
      },
    ]);
  });

  it('shows when a selected reviewer fallback disappears and blocks until acceptance', () => {
    const reviewer = { harness: 'codex', model: 'reviewer', effort: 'medium' };
    const rung = { ...reviewer, effort: 'high' };
    const withLadder = (fallbacks: (typeof rung)[]) =>
      RunOptionsSchema.parse({
        ...options,
        modes: [
          {
            ...options.modes[0],
            mode: 'full-review',
            reviewers: [reviewer],
            reviewer_fallbacks: [{ choice: reviewer, fallbacks }],
          },
        ],
      });
    let s = optionsRead(runWithMenu(), withLadder([rung]));
    for (let i = 0; i < 4; i++) s = key(s, named('tab')).state;
    s = key(s, char(' ')).state;
    expect(s.runConfig?.reviewerFallbacks).toEqual(['codex/reviewer/high']);
    s = optionsRead(s, withLadder([]), 5);
    expect(s.runConfig?.changes).toEqual(['reviewer fallbacks']);
    expect(key(s, named('ctrl_s')).effects).toEqual([]);
    expect(key(key(s, named('enter')).state, named('ctrl_s')).effects).toMatchObject([
      {
        type: 'submit',
        command: { payload: { run_config: { reviewer_fallbacks: [] } } },
      },
    ]);
  });

  it.each(['fallbacks', 'reviewerFallbacks'] as const)(
    'limits %s to the proposal schema maximum',
    (field) => {
      const reviewer = { harness: 'codex', model: 'reviewer', effort: 'medium' };
      const ladder = Array.from({ length: MAX_FALLBACKS + 1 }, (_, i) => ({
        ...choice,
        model: `model${i}`,
      }));
      const twoLadders = RunOptionsSchema.parse({
        ...options,
        modes: [
          {
            ...options.modes[0],
            mode: 'full-review',
            workers: [{ choice, fallbacks: ladder }],
            reviewers: [reviewer],
            reviewer_fallbacks: [{ choice: reviewer, fallbacks: ladder }],
          },
        ],
      });
      let s = optionsRead(runWithMenu(), twoLadders);
      for (let i = 0; i < (field === 'fallbacks' ? 2 : 4); i++) s = key(s, named('tab')).state;
      for (let i = 0; i <= MAX_FALLBACKS; i++) {
        s = key(s, char(' ')).state;
        s = key(s, named('down')).state;
      }
      expect(s.runConfig?.[field]).toHaveLength(MAX_FALLBACKS);
      expect(s.runConfig?.notice).toContain(`Choose at most ${MAX_FALLBACKS}`);
      s = key(s, named('up')).state;
      s = key(s, char(' ')).state;
      expect(s.runConfig?.[field]).toHaveLength(MAX_FALLBACKS - 1);
    },
  );
});

const char = (text: string): Key => ({ kind: 'char', text });
const named = (name: 'enter' | 'pagedown' | 'pageup' | 'ctrl_s' | 'tab' | 'up' | 'down'): Key => ({
  kind: 'key',
  name,
});
const paste = (text: string): Key => ({ kind: 'paste', text });

function formAt(field: NewTaskField): TuiState {
  const s = openNewTask({ ...base(), lastUpdatedAt: 1 }).state;
  return {
    ...s,
    newTask: {
      ...(s.newTask as NonNullable<typeof s.newTask>),
      focus: NEW_TASK_FIELDS.indexOf(field),
    },
  };
}

describe('manual reconnect inside either form', () => {
  it.each(['newTask', 'runConfig'] as const)(
    '%s keeps its draft and retry works during reconciliation',
    (form) => {
      const starting =
        form === 'newTask' ? formAt('priority') : optionsRead(runWithMenu(), options);
      let s = starting;
      if (form === 'runConfig') for (let i = 0; i < 3; i++) s = key(s, named('tab')).state;
      s = {
        ...s,
        stale: true,
        connection: { kind: 'waiting_retry' },
      };
      const typing = key(s, char('R'));
      expect(typing.effects).toEqual([]);
      expect(hintBar(s, 100)).not.toContain('R retry');
      const text = (state: TuiState) =>
        form === 'newTask' ? state.newTask?.texts.priority.text : state.runConfig?.reason.text;
      expect(text(typing.state)).toBe('R');

      const command =
        form === 'newTask'
          ? {
              kind: 'task_add',
              task_id: null,
              expected_version: null,
              project: 'acme',
              payload: {},
            }
          : {
              kind: 'task_propose_run',
              task_id: TASK,
              expected_version: 1,
              project: 'acme',
              payload: {},
            };
      const pending: Mutation = {
        command,
        requestId: 'original-request',
        checks: 1,
        resends: 0,
        state: 'unknown',
        result: null,
      };
      for (const awaiting of [false, true]) {
        const draft = typing.state;
        const waiting = {
          ...draft,
          newTask: draft.newTask === null ? null : { ...draft.newTask, awaiting },
          runConfig: draft.runConfig === null ? null : { ...draft.runConfig, awaiting },
          mutations: new Map(awaiting ? [[mutationTarget(command), pending]] : []),
        };
        const moved = key(waiting, named('tab'));
        expect(moved.effects).toEqual([]);
        expect(hintBar(moved.state, 100)).toContain('R retry connection');
        const retry = key(moved.state, char('R'));
        expect(retry.effects).toEqual([{ type: 'retry_connection' }]);
        expect(retry.state.connection).toEqual({ kind: 'reconnecting', attempt: 1 });
        expect(text(retry.state)).toBe('R');
        expect(retry.state.mutations).toEqual(waiting.mutations);
        expect(key(retry.state, char('R')).effects).toEqual([]);
      }
    },
  );
});

describe('authorization for the two forms', () => {
  it.each([
    ['deputy', ['read', 'operate'], 'deputy actor'],
    ['owner', ['read'], 'needs the operate role'],
    ['assistant', ['read', 'operate'], null],
  ] as const)('matches menu, Home and submit for %s with %j', (actor, roles, problem) => {
    const caller = { ...base().caller!, actor: sanitize(actor), roles: [...roles] };
    const run = optionsRead(runWithMenu(), options);
    const actions = run.actions!;
    const explain = actions.explain.data!;
    const menu = { ...run, caller, screens: ['home', 'actions'] as const, runConfig: null };
    const allowed_actions = [
      ...explain.allowed_actions,
      { action: 'task_add', note: sanitize('Add'), command: null },
    ];
    const items = actionItems({ ...explain, allowed_actions }, caller);
    for (const [selected, screen] of ['run_config', 'new_task'].entries()) {
      if (problem === null) expect(items[selected]?.unavailable).toBeNull();
      else expect(items[selected]?.unavailable).toContain(problem);
      const opened = key(
        {
          ...menu,
          actions: {
            ...actions,
            selected,
            explain: { ...actions.explain, data: { ...explain, allowed_actions } },
          },
        },
        named('enter'),
      ).state;
      expect(opened.screens.at(-1)).toBe(problem === null ? screen : 'actions');
    }
    expect(key({ ...base(), caller }, char('n')).state.screens.at(-1)).toBe(
      problem === null ? 'new_task' : 'home',
    );
    const propose = key({ ...run, caller }, named('ctrl_s'));
    let create: TuiState = { ...openNewTask(base()).state, caller };
    for (const input of [
      named('tab'),
      paste('title'),
      named('tab'),
      paste('main'),
      named('tab'),
      named('tab'),
      paste('works'),
    ])
      create = key(create, input).state;
    const submitted = key(create, named('ctrl_s'));
    if (problem === null) {
      expect(propose.effects).toMatchObject([{ type: 'submit' }]);
      expect(submitted.effects).toMatchObject([{ type: 'submit' }]);
    } else {
      expect(propose.effects).toEqual([]);
      expect(submitted.effects).toEqual([]);
      expect(propose.state.runConfig?.notice).toContain(problem);
      expect(submitted.state.newTask?.notice).toContain(problem);
    }
  });
});

describe('the New task form', () => {
  it('goes on to the next field on Enter in a one-line field', () => {
    const r = onNewTaskKey(formAt('title'), named('enter'), 80);
    expect(NEW_TASK_FIELDS[r.state.newTask?.focus ?? -1]).toBe('base');
  });

  it('edits nothing while the answer to a send is awaited', () => {
    const s = formAt('title');
    const waiting = {
      ...s,
      newTask: { ...(s.newTask as NonNullable<typeof s.newTask>), awaiting: true },
    };
    const r = onNewTaskKey(waiting, char('x'), 80);
    expect(r.state.newTask?.texts.title.text).toBe('');
  });

  it('names the field of a limit the daemon would refuse', () => {
    let s = formAt('acceptance');
    s = onNewTaskKey(s, paste(Array.from({ length: 101 }, (_, i) => `c${i}`).join('\n')), 80).state;
    expect(validate(s, s.newTask as NonNullable<typeof s.newTask>).acceptance).toBeDefined();
    s = formAt('acceptance');
    s = onNewTaskKey(s, paste('y'.repeat(4_100)), 80).state;
    const errors = validate(s, s.newTask as NonNullable<typeof s.newTask>);
    expect(String(errors.acceptance)).toContain('Criterion 1');
    const many = {
      ...(s.newTask as NonNullable<typeof s.newTask>),
      depends: Array.from({ length: 101 }, (_, i) => String(i)),
    };
    expect(validate(s, many).depends).toBeDefined();
  });

  it('counts the title the way the daemon does, in UTF-16 units', () => {
    const s = onNewTaskKey(formAt('title'), paste('😀'.repeat(300)), 80).state;
    expect(s.newTask?.texts.title.text.length).toBe(512);
  });
});

describe('the Run config screen', () => {
  const when = Array.from({ length: 30 }, (_, i) => `guidance${i}`).join(' ');
  const long = {
    ...options,
    modes: [{ ...options.modes[0], when_to_use: sanitize(when) }],
  } as unknown as RunOptions;

  function opened(): TuiState {
    return { ...optionsRead(runWithMenu(), long), size: { cols: 80, rows: 24 } };
  }
  const text = (s: TuiState): string => {
    const f = renderFrame(s, screenBody(s, { color: false }), { color: false });
    return Array.from({ length: f.rows }, (_, y) =>
      // eslint-disable-next-line no-control-regex
      f.rowBytes(y).replace(/\x1b\[[0-9;]*m/g, ''),
    ).join('\n');
  };

  it('lets the whole guidance of a long mode be read, page by page', () => {
    let s = opened();
    expect(text(s)).toContain('PgUp/PgDn to read');
    expect(text(s)).not.toContain('guidance29');
    for (let i = 0; i < 20; i++) s = onRunConfigKey(s, named('pagedown'), 20).state;
    expect(text(s)).toContain('guidance29');
    expect(text(s)).not.toContain('guidance0 ');
  });

  it('takes no more reason than the daemon accepts in UTF-16 units', () => {
    let s = opened();
    s = { ...s, runConfig: { ...(s.runConfig as NonNullable<typeof s.runConfig>), focus: 3 } };
    s = onRunConfigKey(s, paste('😀'.repeat(1_001)), 60).state;
    expect(s.runConfig?.reason.text.length).toBe(2_000);
  });

  it('edits nothing while the answer to a proposal is awaited', () => {
    let s = opened();
    s = {
      ...s,
      runConfig: { ...(s.runConfig as NonNullable<typeof s.runConfig>), focus: 3, awaiting: true },
    };
    expect(onRunConfigKey(s, char('x'), 60).state.runConfig?.reason.text).toBe('');
  });
});

describe('a refusal by the daemon', () => {
  it('keeps every typed field, names the field it concerns and lets the form send again', () => {
    let s = formAt('title');
    for (const [field, text] of [
      ['title', 'Add export'],
      ['base', 'main'],
    ] as const) {
      s = {
        ...s,
        newTask: {
          ...(s.newTask as NonNullable<typeof s.newTask>),
          focus: NEW_TASK_FIELDS.indexOf(field),
        },
      };
      s = onNewTaskKey(s, paste(text), 80).state;
    }
    s = { ...s, newTask: { ...(s.newTask as NonNullable<typeof s.newTask>), awaiting: true } };
    const command = {
      kind: 'task_add',
      project: 'acme',
      task_id: null,
      expected_version: null,
      payload: {},
    };
    const r = reduce(s, {
      type: 'mutation_changed',
      mutation: {
        requestId: 'r1',
        command,
        state: 'rejected',
        result: { ok: false, code: 'invalid_command', message: 'dependency cycle' },
        checks: 0,
        resends: 0,
      },
    });
    const form = r.state.newTask;
    expect(form?.texts.title.text).toBe('Add export');
    expect(form?.texts.base.text).toBe('main');
    expect(form?.awaiting).toBe(false);
    expect(String(form?.errors.depends)).toContain('dependency cycle');
    expect(r.state.screens).toContain('new_task');
  });
});
