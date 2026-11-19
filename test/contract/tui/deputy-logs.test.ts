import { describe, expect, it } from 'vitest';
import { EventLogWriter, RunDir } from '../../../src/runner/files.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { KEY, type PtySession } from '../../support/pty.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import type { Store } from '../../../src/store/index.ts';
import type { StoreDriver } from '../../support/store-driver.ts';
import { daemonSocket, LogFeed, openTask, useTui } from '../../support/tui-fixtures.ts';

// A deputy turn's run writes its spool outside the task's operations; the Logs screen still shows it.
const tui = useTui();
const SETUP = uuidOf(700);
const CODER = uuidOf(701);
const TURN = uuidOf(900);
const RUN_1 = { attempt: uuidOf(901), op: uuidOf(902) };
const RUN_2 = { attempt: uuidOf(903), op: uuidOf(904) };

function ended(d: StoreDriver, taskId: string, op: string): void {
  d.must(taskId, {
    kind: 'operation_result',
    operation_id: op as Uuid,
    status: 'finished',
    outcome: 'succeeded',
    invocation_id: null,
    processes: [],
    started_at: d.now as EpochMs,
    finished_at: d.now as EpochMs,
    receipt_digest: `sha256:${'c'.repeat(64)}`,
  });
}

type Seed = {
  readonly mode?: 'headless' | 'interactive';
  /** One list of lines per run of the turn; more than one is a turn that was retried. */
  readonly runs: readonly (readonly string[])[];
  /** Whether the turn ended. */
  readonly done?: boolean;
  /**
   * The turn begins once the opened task's `task_show` has come back and before the daemon answers the
   * first `task_logs`: no event, so the snapshot the screen holds is from before it.
   */
  readonly beginsAfterOpen?: boolean;
};

/** A task whose coder wrote one line, then a deputy turn on it. */
async function deputyTask(o: Seed): Promise<PtySession> {
  return (await deputyDaemon(o)).s;
}

/** The same, with the running daemon's store, to change the turn while the log is open. */
async function deputyDaemon(o: Seed): Promise<{ s: PtySession; store: Store }> {
  const sd = tui.daemon();
  const t = buildTask({ id: uuidOf(1), title: 'Deputy task' });
  const feed = new LogFeed(sd);
  sd.seed((d) => {
    createGrantStart(d, t, 'direct-pr');
    const prepare = d.pendingOne(t.id, 'prepare');
    feed.write(d, t.id, prepare.id, SETUP, 'setup', ['setup line 1']);
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: prepare.id as never,
      outcome: 'succeeded',
      data: PREPARE_DATA,
    });
    feed.write(d, t.id, d.pendingOne(t.id, 'start_agent').id, CODER, 'agent', ['coder line 1']);
    ended(d, t.id, SETUP);
    ended(d, t.id, CODER);
    if (o.beginsAfterOpen !== true) begin(d.store);
  });
  /** The deputy turn and its runs, as the daemon records them. */
  function begin(store: Store): void {
    const turns = store.deputy;
    const now = Date.now();
    const ok = (r: { ok: boolean; error?: unknown }) => {
      if (!r.ok) throw new Error(JSON.stringify(r.error));
    };
    ok(
      turns.startTurn({
        turn_id: TURN,
        goal_id: t.id,
        task_id: t.id,
        kind: 'incident',
        incident: `${t.id}:1:timeout:1`,
        signature: null,
        harness: 'fake',
        attempt_id: RUN_1.attempt,
        operation_id: RUN_1.op,
        mode: o.mode ?? 'headless',
        context_bytes: 0,
        now,
      }),
    );
    o.runs.forEach((lines, i) => {
      const r = i === 0 ? RUN_1 : RUN_2;
      if (i > 0) {
        ok(turns.scheduleRetry(TURN, { retry_at: now, infra: true, session_ref: null }));
        ok(turns.resumeTurn(TURN, r.attempt, r.op));
      }
      const run = RunDir.open({
        dataDir: sd.dataDir,
        kind: 'runs',
        id: r.attempt,
        redactor: new Redactor(),
      });
      const log = EventLogWriter.open(run, r.op);
      for (const line of lines) {
        const appended = log.append('progress', line);
        if (!appended.ok) throw new Error(appended.error.code);
      }
      log.sync();
    });
    if (o.done !== false) ok(turns.finishTurn(TURN, { state: 'done', now }));
  }
  const running = await sd.start();
  if (o.beginsAfterOpen === true) {
    // The first log read is held at a proxy until task_show has answered and the turn has begun.
    const proxy = await tui.proxy(daemonSocket(sd));
    let release = (): void => undefined;
    const held = new Promise<void>((r) => (release = r));
    let first = true;
    let shown = false;
    proxy.tap = (direction, data) => {
      if (direction === 'response' && data.toString('utf8').includes('"provenance"')) shown = true;
    };
    proxy.beforeForward = (request) => {
      if (!first || !request.includes('"task_logs"')) return undefined;
      first = false;
      return held;
    };
    const s = tui.cusr(proxy.dataDir, { cols: 120, rows: 24 });
    await s.waitForText('Deputy task');
    s.send(KEY.enter);
    await s.waitForText('Logs:');
    await s.waitFor(() => shown, 10_000);
    begin(running.store);
    release();
    return { s, store: running.store };
  }
  const s = tui.cusr(sd.dataDir, { cols: 120, rows: 24 });
  await openTask(s, 'Deputy task');
  s.send('l');
  await s.waitForText('Logs:');
  return { s, store: running.store };
}

async function quit(s: PtySession): Promise<void> {
  s.send('q');
  expect((await s.waitForExit()).status).toBe(0);
}

describe('Logs of a task the deputy acted on', () => {
  it("shows the deputy turn's output under its own step", async () => {
    const s = await deputyTask({
      runs: [['deputy read the failure', 'deputy continued the task']],
    });
    // The turn came last, so it is the step the log opens on.
    await s.waitForText('deputy continued the task');
    const screen = s.screenText();
    expect(screen).toContain('deputy read the failure');
    expect(screen).toMatch(/── deputy · attempt \w+ · .+ ──/);
    expect(screen.indexOf('deputy read the failure')).toBeLessThan(
      screen.indexOf('deputy continued the task'),
    );
    await quit(s);
  });

  it('reaches each run of a retried turn with ← and the attempt chooser', async () => {
    const s = await deputyTask({ runs: [['first run line'], ['second run line']] });
    await s.waitForText('second run line');
    s.send(KEY.left);
    await s.waitForText('first run line');
    expect(s.screenText()).not.toContain('second run line');
    s.send(KEY.left);
    await s.waitForText('coder line 1');

    s.send('t');
    await s.waitForText('deputy ×2');
    s.send('G');
    s.send(KEY.enter);
    // The folded run of the turn opens on its runs; the last is the second.
    await s.waitForText('#2');
    s.send('G');
    s.send(KEY.enter);
    await s.waitForText('second run line');
    expect(s.screenText()).not.toContain('first run line');
    await quit(s);
  });

  it('a native turn with nothing in the log says where its output is', async () => {
    const s = await deputyTask({ mode: 'interactive', runs: [], done: false });
    await s.waitForText('coder line 1');
    await s.waitForText('The deputy is working in its own terminal window');
    await quit(s);
  });

  it('drops the native-terminal note once the turn ends, though the task version stands still', async () => {
    const { s, store } = await deputyDaemon({ mode: 'interactive', runs: [], done: false });
    await s.waitForText('The deputy is working in its own terminal window');
    const version = store.readTask(uuidOf(1))?.version;
    expect(store.deputy.finishTurn(TURN, { state: 'done', now: Date.now() }).ok).toBe(true);
    expect(store.readTask(uuidOf(1))?.version).toBe(version);
    await s.waitFor(() => !s.screenText().includes('its own terminal window'), 5_000);
    await quit(s);
  });

  it('after a native run fell back to headless, says the output comes here; the native run says where it went', async () => {
    const s = await deputyTask({ mode: 'interactive', runs: [[], []], done: false });
    await s.waitForText('The deputy is working on this task; its output will appear here.');
    expect(s.screenText()).not.toContain('its own terminal window');

    s.send('t');
    // The chooser opens with the latest run unfolded: the native run is the one above the last row.
    await s.waitForText('Deputy #2');
    s.send('G');
    s.send(KEY.up);
    s.send(KEY.enter);
    await s.waitForText('This deputy run was a native session in its own terminal window');
    await quit(s);
  });

  it('a turn that began after the task was read is told on the first log page, without `t`', async () => {
    const { s, store } = await deputyDaemon({
      mode: 'interactive',
      runs: [],
      done: false,
      beginsAfterOpen: true,
    });
    const version = store.readTask(uuidOf(1))?.version;
    await s.waitForText('coder line 1');
    await s.waitForText('The deputy is working in its own terminal window', 5_000);
    expect(store.readTask(uuidOf(1))?.version).toBe(version);
    await quit(s);
  });
});
