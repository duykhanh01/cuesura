import { describe, expect, it } from 'vitest';
import { uuidOf } from '../../support/builders.ts';
import type { ControlProxy } from '../../support/control-proxy.ts';
import type { SeededDaemon } from '../../support/daemon-task.ts';
import { KEY, type PtySession } from '../../support/pty.ts';
import {
  cancelTask,
  cliJson,
  daemonSocket,
  flat,
  pressAction,
  taskAdd,
  useTui,
} from '../../support/tui-fixtures.ts';

// T066: the New task form and the Run config screen on a PTY against a real daemon (US5 scenarios 1, 2, 9
// and 10, FR-024, FR-025). Everything is chosen from lists the daemon gave; what is typed stays until the
// daemon has accepted it.
const tui = useTui();

const RUNTIME =
  'runtime:\n  modes:\n    direct-pr: { when_to_use: "small, low risk" }\n    full-review: { when_to_use: "needs a second pair of eyes" }';

type Board = { items: { task_id: string; title: string }[] };

async function tasks(sd: SeededDaemon): Promise<Board['items']> {
  const r = await sd.query('owner', { kind: 'task_board', scope: 'all', limit: 100 });
  return (r.envelope.data as unknown as Board).items;
}

const said = (s: PtySession, text: string, ms = 10_000): Promise<void> =>
  s.waitFor(() => flat(s.screenText()).includes(text), ms);

/** Types in the focused field and goes on to the next with Tab. */
async function fill(s: PtySession, text: string): Promise<void> {
  s.send(text);
  await said(s, text.split('\n')[0] as string);
  s.send(KEY.tab);
}

/** The form with every required field typed and the focus on Priority. */
async function typeRequired(s: PtySession, title = 'Add export'): Promise<void> {
  s.send(KEY.tab); // Project → Title
  await fill(s, title);
  await fill(s, 'main');
  await fill(s, 'Export the report');
  await fill(s, 'The report downloads');
}

async function openForm(s: PtySession): Promise<void> {
  await s.waitForText('Existing task');
  s.send('n');
  await s.waitForText('New task');
  await said(s, '‹ acme ›');
}

function traceThrough(proxy: ControlProxy) {
  const trace = { offline: false, writes: [] as string[], lookups: [] as string[] };
  proxy.refuse = (request) => {
    const id = /"request_id":"([^"]+)"/.exec(request)?.[1] ?? '';
    if (request.startsWith('POST /v1/command ')) trace.writes.push(id);
    if (request.includes('"kind":"request_show"')) trace.lookups.push(id);
    return trace.offline;
  };
  return trace;
}

function responseBody(chunk: Buffer): { data?: Record<string, unknown> } | undefined {
  const raw = chunk.toString('utf8');
  const split = raw.indexOf('\r\n\r\n');
  if (split < 0) return undefined;
  try {
    return JSON.parse(raw.slice(split + 4)) as { data?: Record<string, unknown> };
  } catch {
    return undefined;
  }
}

async function scene(extra: { runnable?: boolean; projects?: string[] } = {}) {
  const sd = tui.daemon({
    ...(extra.runnable === true ? { runnable: {}, runtime: RUNTIME } : {}),
    ...(extra.projects === undefined ? {} : { projects: extra.projects }),
  });
  await sd.start();
  await sd.command('owner', taskAdd(1, 'Existing task'));
  return sd;
}

describe('US5 scenario 1: the New task form', () => {
  it('leads from an empty Home to the form', async () => {
    const sd = tui.daemon();
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await said(s, 'Press n to create the first one');
    s.send('n');
    await s.waitForText('New task');
    expect(s.screenText()).toContain('Base branch');
    s.send(KEY.esc);
    await s.waitFor(() => !s.screenText().includes('Base branch'));
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('opens New task from Actions on a finished task', async () => {
    const sd = await scene();
    const id = (await tasks(sd))[0]?.task_id ?? '';
    await cancelTask(sd, id, 1);
    const s = tui.cusr(sd.dataDir);
    await said(s, 'Finished');
    s.send(KEY.enter);
    await s.waitForText('Existing task');
    s.send(KEY.down);
    s.send('a');
    await pressAction(s, 'New task');
    await said(s, '‹ acme ›');
    await said(s, 'Ctrl-S create');
  });

  it('says what is wrong at its field and keeps everything typed', async () => {
    const sd = await scene();
    const s = tui.cusr(sd.dataDir);
    await openForm(s);
    s.send(KEY.ctrlS);
    await said(s, 'A title is required.');
    expect(flat(s.screenText())).toContain('A base branch is required.');
    expect(flat(s.screenText())).toContain('Write at least one acceptance criterion');
    expect(flat(s.screenText())).toContain('Nothing was sent');

    // The focus went to the first field in error: Title.
    await fill(s, 'Add export');
    await fill(s, 'main');
    await fill(s, 'Export the report');
    await fill(s, 'The report downloads');
    s.send('abc');
    s.send(KEY.ctrlS);
    await said(s, 'Priority is a whole number');
    const screen = flat(s.screenText());
    for (const kept of ['Add export', 'main', 'Export the report', 'The report downloads', 'abc'])
      expect(screen).toContain(kept);
    expect(await tasks(sd)).toHaveLength(1);
    s.send(KEY.ctrlC);
    await said(s, 'Quitting loses what you typed');
    s.send(KEY.ctrlC);
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('names an over-long criterion at its field, keeps everything typed and sends nothing', async () => {
    const sd = await scene();
    const s = tui.cusr(sd.dataDir);
    await openForm(s);
    s.send(KEY.tab);
    await fill(s, 'Add export');
    await fill(s, 'main');
    await fill(s, 'Export the report');
    // One criterion past the daemon's length limit: the form says so at the field.
    s.send(`\x1b[200~${'y'.repeat(4_200)}\x1b[201~`);
    await said(s, 'yyyy');
    s.send(KEY.ctrlS);
    await said(s, 'Criterion 1 is longer than 4096 characters');
    const screen = flat(s.screenText());
    for (const kept of ['Add export', 'main', 'Export the report', 'yyyy'])
      expect(screen).toContain(kept);
    expect(await tasks(sd)).toHaveLength(1);
    s.send(KEY.ctrlC);
    await said(s, 'Quitting loses what you typed');
    s.send(KEY.ctrlC);
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('asks before leaving a form that has content, and leaves an untouched one at once', async () => {
    const sd = await scene();
    const s = tui.cusr(sd.dataDir);
    await openForm(s);
    s.send(KEY.esc);
    await s.waitFor(() => !s.screenText().includes('Base branch'));
    s.send('n');
    await s.waitForText('Base branch');
    s.send(KEY.tab);
    s.send('Half done');
    await said(s, 'Half done');
    s.send(KEY.esc);
    await said(s, 'Leaving loses what you typed');
    // Any other key keeps the form, with its content.
    s.send(KEY.left);
    await s.waitFor(() => !s.screenText().includes('Leaving loses'));
    expect(flat(s.screenText())).toContain('Half done');
    s.send(KEY.esc);
    await said(s, 'Leaving loses what you typed');
    s.send(KEY.esc);
    await s.waitFor(() => !s.screenText().includes('Base branch'));
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('picks the profile and the dependency from lists, without typing a name or an ID', async () => {
    const sd = await scene({ runnable: true, projects: ['aaa'] });
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('Existing task');
    s.send('n');
    await said(s, '‹ aaa ›');
    s.send(KEY.down);
    await said(s, '‹ acme ›');
    await typeRequired(s);
    // Priority, then Profile: the default is `Project default`.
    s.send(KEY.tab);
    await said(s, 'Project default');
    s.send(KEY.down);
    await said(s, 'heavy');
    s.send(KEY.tab);
    await said(s, 'Existing task');
    s.send(' ');
    await said(s, '[x] Existing task');
    s.send(KEY.ctrlS);
    await s.waitFor(() => !s.screenText().includes('Base branch'), 15_000);
    await s.waitForText('Add export');

    const created = (await tasks(sd)).find((t) => t.title === 'Add export');
    expect(created).toBeDefined();
    const id = created?.task_id ?? '';
    const existing = (await tasks(sd)).find((t) => t.title === 'Existing task')?.task_id;
    const content = await sd.query('owner', { kind: 'task_content', task_id: id });
    expect(content.envelope.data?.['project']).toBe('acme');
    expect(content.envelope.data?.['depends_on']).toEqual([existing]);
    expect(content.envelope.data?.['acceptance']).toEqual(['The report downloads']);
    // The profile the task carries is the one chosen, and it is the task's own.
    const options = await sd.query('owner', { kind: 'run_options', task_id: id });
    expect(options.envelope.data?.['profile']).toEqual({ id: 'heavy', source: 'task' });
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('keeps the draft at the dependency field after the daemon refuses the create', async () => {
    const sd = await scene();
    const other = tui.daemon();
    await other.start();
    const proxy = await tui.proxy(daemonSocket(sd));
    const s = tui.cusr(proxy.dataDir);
    await openForm(s);
    await typeRequired(s);
    s.send(KEY.tab + KEY.tab);
    await said(s, '[ ] Existing task');
    s.send(' ');
    await said(s, '[x] Existing task');
    // The replacement daemon has the same project but does not have the selected dependency.
    proxy.retarget(daemonSocket(other));
    s.send(KEY.ctrlS);
    await said(s, 'Refused by the daemon');
    const screen = flat(s.screenText());
    for (const kept of [
      'Add export',
      'main',
      'Export the report',
      'The report downloads',
      '[x] Existing task',
    ])
      expect(screen).toContain(kept);
    expect(await tasks(other)).toHaveLength(0);
  });

  it('leaves the profile unset when `Project default` stays chosen', async () => {
    const sd = await scene({ runnable: true });
    const s = tui.cusr(sd.dataDir);
    await openForm(s);
    await typeRequired(s);
    s.send(KEY.ctrlS);
    await s.waitFor(() => !s.screenText().includes('Base branch'), 15_000);
    const id = (await tasks(sd)).find((t) => t.title === 'Add export')?.task_id ?? '';
    const options = await sd.query('owner', { kind: 'run_options', task_id: id });
    expect(options.envelope.data?.['profile']).toEqual({ id: 'standard', source: 'project' });
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });
});

describe('US5 scenarios 9 and 10: a create whose answer is lost', () => {
  it('sends no create during reconnect or while selected dependencies are being reread', async () => {
    const sd = await scene();
    const proxy = await tui.proxy(daemonSocket(sd));
    const trace = traceThrough(proxy);
    const s = tui.cusr(proxy.dataDir);
    await openForm(s);
    await typeRequired(s);
    s.send(KEY.tab + KEY.tab);
    await said(s, '[ ] Existing task');
    s.send(' ');
    await said(s, '[x] Existing task');

    trace.offline = true;
    await said(s, 'Data may be out of date');
    s.send(KEY.ctrlS);
    await said(s, 'Nothing was sent: the data on screen may be out of date');
    expect(trace.writes).toEqual([]);

    const dependencyRead = Promise.withResolvers<void>();
    let askedForDependencies = false;
    proxy.beforeForward = (request) => {
      if (!request.includes('"kind":"task_board"') || !request.includes('"scope":"all"'))
        return undefined;
      askedForDependencies = true;
      return dependencyRead.promise;
    };
    trace.offline = false;
    await s.waitFor(
      () => askedForDependencies && !s.screenText().includes('Data may be out of date'),
    );
    s.send(KEY.ctrlS);
    await said(s, 'selected dependencies are still being checked');
    expect(flat(s.screenText())).toContain('Export the report');
    expect(trace.writes).toEqual([]);

    dependencyRead.resolve();
    await said(s, '[x] Existing task');
    expect(trace.writes).toEqual([]);
    expect(await tasks(sd)).toHaveLength(1);
    s.send(KEY.ctrlS);
    await s.waitFor(() => !s.screenText().includes('Base branch'));
    await said(s, 'Add export');
    expect(trace.writes).toHaveLength(1);
    const rows = await tasks(sd);
    const created = rows.find((task) => task.title === 'Add export');
    const dep = rows.find((task) => task.title === 'Existing task');
    const content = await sd.query('owner', { kind: 'task_content', task_id: created?.task_id });
    expect(content.envelope.data?.['depends_on']).toEqual([dep?.task_id]);
  });

  it('creates one task however the answer is lost, then closes the form', async () => {
    const sd = await scene();
    const proxy = await tui.proxy(daemonSocket(sd));
    const trace = traceThrough(proxy);
    const s = tui.cusr(proxy.dataDir);
    await openForm(s);
    await typeRequired(s);
    proxy.mode = 'drop_response';
    s.send(KEY.ctrlS);
    await said(s, 'Result unknown - checking');
    // Submitting again while the result is unknown cannot start a second write.
    s.send(KEY.ctrlS);
    await said(s, 'an earlier new task is still being sent');
    expect(flat(s.screenText())).toContain('Export the report');
    proxy.mode = 'forward';
    await s.waitFor(() => !s.screenText().includes('Base branch'), 20_000);
    expect(trace.writes).toHaveLength(1);
    expect(trace.lookups.length).toBeGreaterThan(0);
    expect([...new Set(trace.lookups)]).toEqual(trace.writes);
    expect((await tasks(sd)).filter((t) => t.title === 'Add export')).toHaveLength(1);
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('leaves a result that can be looked up with the printed command, and no second task', async () => {
    const sd = await scene();
    const proxy = await tui.proxy(daemonSocket(sd));
    const trace = traceThrough(proxy);
    let original: Record<string, unknown> | undefined;
    proxy.onReply = (request, response) => {
      if (!request.startsWith('POST /v1/command ')) return;
      const data = responseBody(response)?.data;
      if (data?.['replayed'] === false) original = data;
    };
    const s = tui.cusr(proxy.dataDir);
    await openForm(s);
    await typeRequired(s);
    proxy.mode = 'drop_response';
    s.send(KEY.ctrlS);
    await said(s, 'Result unknown - checking');
    s.send(KEY.ctrlC);
    await said(s, 'Quitting loses what you typed');
    s.send(KEY.ctrlC);
    expect((await s.waitForExit()).status).toBe(3);
    const id = /request ID: (\S+)/.exec(s.screenText())?.[1] ?? '';
    expect(s.screenText()).toContain(`cusr request show ${id}`);
    expect(trace.writes).toEqual([id]);
    const before = await tasks(sd);
    const created = before.find((task) => task.title === 'Add export');
    expect(before).toHaveLength(2);
    expect(created).toBeDefined();
    expect(original).toMatchObject({ request_id: id, result: { task_id: created?.task_id } });
    const found = await cliJson(sd, 'request', 'show', id);
    expect(found.code).toBe(0);
    expect(found.envelope.data).toMatchObject({
      request_id: id,
      kind: 'task_add',
      state: 'completed',
      task_id: created?.task_id,
      outcome: { ok: true, value: original?.['result'] },
    });
    expect(await tasks(sd)).toEqual(before);
  });
});

describe('US5 scenario 2: the Run config screen', () => {
  async function openRun(s: PtySession): Promise<void> {
    await s.waitForText('Existing task');
    s.send('a');
    await s.waitForText('Propose run');
    await pressAction(s, 'Propose run');
    await s.waitForText('Run config');
  }

  it('shows the profile as text and offers only what run_options lists, with when_to_use', async () => {
    const sd = await scene({ runnable: true });
    const s = tui.cusr(sd.dataDir);
    await openRun(s);
    await said(s, 'Profile: standard');
    expect(flat(s.screenText())).toContain('cannot be changed here');
    for (const text of ['full-review', 'direct-pr', 'small, low risk', 'Reason', '0/2000'])
      await said(s, text);
    // direct-pr is listed first and runs no reviewer: there is no such field.
    expect(flat(s.screenText())).not.toContain('Reviewer');
    s.send(KEY.down);
    await said(s, 'needs a second pair of eyes');
    await said(s, 'Reviewer');
    s.send(KEY.esc);
    await said(s, 'Leaving loses what you typed');
    s.send(KEY.esc);
    await s.waitFor(() => !s.screenText().includes('Run config'));
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it.each([true, false])(
    'stores explicit full-review fallbacks (select reviewer fallback: %s)',
    async (selectReviewerFallback) => {
      const sd = await scene({ runnable: true });
      const s = tui.cusr(sd.dataDir);
      await openRun(s);
      await said(s, 'Profile: standard');
      s.send(KEY.down);
      await said(s, 'needs a second pair of eyes');
      s.send(KEY.tab + KEY.tab);
      await said(s, '› Worker fallbacks');
      s.send(' ');
      await said(s, '[x] claude/sonnet/high');
      s.send(KEY.tab + KEY.tab);
      await said(s, '› Reviewer fallbacks');
      await said(s, '[ ] codex/sol/high');
      if (selectReviewerFallback) {
        s.send(' ');
        await said(s, '[x] codex/sol/high');
      }
      s.send(KEY.tab);
      s.send('because it is small');
      await said(s, 'because it is small');
      s.send(KEY.ctrlS);
      await s.waitFor(() => !s.screenText().includes('Run config'), 15_000);
      const id = (await tasks(sd)).find((t) => t.title === 'Existing task')?.task_id ?? '';
      const shown = await sd.query('owner', { kind: 'task_show', task_id: id });
      expect(shown.envelope.data?.['run_config']).toMatchObject({
        status: 'proposed',
        selection: {
          reason: 'because it is small',
          mode: 'full-review',
          reviewer: { model: 'sol' },
          worker: { model: 'sonnet' },
          fallbacks: [{ harness: 'claude', model: 'sonnet', effort: 'high' }],
          profile: 'standard',
        },
      });
      const config = shown.envelope.data?.['run_config'] as { selection: Record<string, unknown> };
      expect(config.selection['reviewer_fallbacks']).toEqual(
        selectReviewerFallback ? [{ harness: 'codex', model: 'sol', effort: 'high' }] : [],
      );
    },
  );

  it('sends no proposal until fresh options arrive after reconnect', async () => {
    const sd = await scene({ runnable: true });
    const proxy = await tui.proxy(daemonSocket(sd));
    const trace = traceThrough(proxy);
    const s = tui.cusr(proxy.dataDir);
    await openRun(s);
    await said(s, 'Profile: standard');
    s.send(KEY.tab.repeat(3));
    s.send('Retained reason');
    await said(s, 'Retained reason');

    trace.offline = true;
    await said(s, 'Data may be out of date');
    s.send(KEY.ctrlS);
    await said(s, 'the data on screen may be out of date');
    expect(trace.writes).toEqual([]);

    const optionsRead = Promise.withResolvers<void>();
    let askedForOptions = false;
    proxy.beforeForward = (request) => {
      if (!request.includes('"kind":"run_options"')) return undefined;
      askedForOptions = true;
      return optionsRead.promise;
    };
    let shown = false;
    let explained = false;
    proxy.onReply = (request, response) => {
      if (responseBody(response)?.data?.['task_id'] === undefined) return;
      if (request.includes('"kind":"task_explain"')) explained = true;
      if (request.includes('"kind":"task_show"')) shown = true;
    };
    trace.offline = false;
    await s.waitFor(() => askedForOptions && shown && explained);
    await said(s, 'Reading the run options of this task');
    s.send(KEY.ctrlS);
    await said(s, 'this task and its options are being read again');
    expect(trace.writes).toEqual([]);

    optionsRead.resolve();
    await said(s, 'Retained reason');
    expect(trace.writes).toEqual([]);
    s.send(KEY.ctrlS);
    await s.waitFor(() => !s.screenText().includes('Run config'));
    expect(trace.writes).toHaveLength(1);
    const id = (await tasks(sd))[0]?.task_id;
    const result = await sd.query('owner', { kind: 'task_show', task_id: id });
    const config = result.envelope.data?.['run_config'] as { selection: Record<string, unknown> };
    expect(config.selection).toMatchObject({
      mode: 'direct-pr',
      reason: 'Retained reason',
      reviewer: null,
    });
    expect(config.selection).not.toHaveProperty('reviewer_fallbacks');
  });

  it('requires acceptance of a new proposal at the same revision after manual reconnect at 80×24', async () => {
    const sd = await scene({ runnable: true });
    const proxy = await tui.proxy(daemonSocket(sd));
    const trace = traceThrough(proxy);
    const s = tui.cusr(proxy.dataDir, { cols: 80, rows: 24 });
    await openRun(s);
    await said(s, 'Profile: standard');
    s.send(KEY.down);
    await said(s, 'needs a second pair of eyes');
    s.send(KEY.tab.repeat(4));
    await said(s, '[ ] codex/sol/high');
    s.send(' ');
    await said(s, '[x] codex/sol/high');
    s.send(KEY.tab);
    s.send('Saved reason');
    await said(s, 'Saved reason');

    const id = (await tasks(sd))[0]?.task_id;
    const before = (await sd.query('owner', { kind: 'task_show', task_id: id })).envelope.data;
    trace.offline = true;
    await said(s, 'Data may be out of date');
    const other = await sd.command('assistant', {
      request_id: uuidOf(7001),
      kind: 'task_propose_run',
      project: 'acme',
      task_id: id,
      expected_version: before?.['version'],
      payload: {
        run_config: {
          mode: 'direct-pr',
          profile: 'standard',
          worker: { harness: 'claude', model: 'sonnet', effort: 'medium' },
          reviewer: null,
          reason: 'Proposed while disconnected',
          fallbacks: [],
        },
      },
    });
    expect(other.envelope.ok).toBe(true);
    const latest = (await sd.query('owner', { kind: 'task_show', task_id: id })).envelope.data;
    expect(latest?.['revision']).toBe(before?.['revision']);
    expect(latest?.['version']).not.toBe(before?.['version']);

    const incompatible = await tui.answering('{}');
    proxy.retarget(incompatible.socketPath);
    trace.offline = false;
    await said(s, 'Stopped');
    proxy.retarget(daemonSocket(sd));
    const reads = new Set<string>();
    proxy.onReply = (request, response) => {
      if (responseBody(response)?.data?.['version'] === latest?.['version'])
        reads.add(/"kind":"([^"]+)"/.exec(request)?.[1] ?? '');
    };
    s.send(KEY.tab);
    await said(s, 'R retry connection');
    s.send('R');
    await s.waitFor(
      () =>
        ['task_show', 'task_explain', 'run_options'].every((kind) => reads.has(kind)) &&
        flat(s.screenText()).includes('Saved reason') &&
        !s.screenText().includes('Stopped'),
    );
    expect(trace.writes).toEqual([]);

    s.send(KEY.ctrlS);
    await s.waitFor(
      () =>
        trace.writes.length > 0 || flat(s.screenText()).includes('press Enter on Mode to accept'),
    );
    expect(trace.writes).toEqual([]);
    await said(
      s,
      `Task changed (version ${String(before?.['version'])} → ${String(latest?.['version'])})`,
    );
    await said(s, 'Current proposal by assistant (direct-pr)');
    expect(
      (await sd.query('owner', { kind: 'task_show', task_id: id })).envelope.data?.['run_config'],
    ).toEqual(latest?.['run_config']);

    s.send(KEY.enter);
    await s.waitFor(() => !s.screenText().includes('Task changed'));
    expect(trace.writes).toEqual([]);
    s.send(KEY.ctrlS);
    await s.waitFor(() => !s.screenText().includes('Run config'));
    expect(trace.writes).toHaveLength(1);
    const shown = await sd.query('owner', { kind: 'task_show', task_id: id });
    expect(shown.envelope.data?.['run_config']).toMatchObject({
      proposed_by: 'owner',
      selection: {
        mode: 'full-review',
        reason: 'Saved reason',
        reviewer_fallbacks: [{ harness: 'codex', model: 'sol', effort: 'high' }],
      },
    });
  });

  it('keeps the reason and submit key visible at 80×24 and limits the reason to 2,000 characters', async () => {
    const sd = await scene({ runnable: true });
    const s = tui.cusr(sd.dataDir, { cols: 80, rows: 24 });
    await openRun(s);
    await said(s, 'Profile: standard');
    // direct-pr: Mode → Worker → Fallbacks → Reason
    for (let i = 0; i < 3; i++) s.send(KEY.tab);
    // A paste goes in as one piece; only what fits the limit is taken.
    s.send(`\x1b[200~${'x'.repeat(2_100)}\x1b[201~`);
    await said(s, '2000/2000 characters');
    expect(s.screenText()).toContain('Ctrl-S propose');
    s.send(KEY.esc);
    await said(s, 'Leaving loses what you typed');
    s.send(KEY.esc);
    await s.waitFor(() => !s.screenText().includes('Run config'));
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });
});

describe('US5 scenario 2: options that cannot be read', () => {
  it('says config_invalid as it is, offers nothing and sends nothing', async () => {
    // The base holds no `cusr.yaml`, and the task names no profile: the daemon cannot say which applies.
    const sd = tui.daemon({ runnable: { cusr: null }, runtime: RUNTIME });
    await sd.start();
    await sd.command('owner', taskAdd(1, 'Existing task'));
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('Existing task');
    s.send('a');
    await s.waitForText('Propose run');
    await pressAction(s, 'Propose run');
    await said(s, 'config_invalid');
    const screen = flat(s.screenText());
    expect(screen).toContain('Could not read the run options');
    expect(screen).toContain('origin/main');
    expect(screen).toContain('a'.repeat(40));
    expect(screen).toContain('commit and merge cusr.yaml');
    expect(screen).not.toContain('full-review');
    expect(screen).not.toContain('direct-pr');
    s.send(KEY.ctrlS);
    await said(s, 'Nothing was sent');
    const id = (await tasks(sd))[0]?.task_id ?? '';
    const shown = await sd.query('owner', { kind: 'task_show', task_id: id });
    expect(shown.envelope.data?.['run_config'] ?? null).toBeNull();
    s.send(KEY.esc);
    await s.waitFor(() => !s.screenText().includes('Run config'));
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });
});

describe('US5: the form at the smallest size', () => {
  it('keeps the focused field and the keys in view at 80×24', async () => {
    const sd = await scene({ runnable: true });
    const s = tui.cusr(sd.dataDir, { cols: 80, rows: 24 });
    await openForm(s);
    for (let i = 0; i < 7; i++) s.send(KEY.tab);
    await said(s, 'Existing task');
    const screen = s.screenText();
    expect(screen).toContain('› Depends on');
    expect(screen).toContain('Ctrl-S create');
    // Nothing was typed, so one Ctrl-C quits.
    s.send(KEY.ctrlC);
    expect((await s.waitForExit()).status).toBe(0);
  });
});
