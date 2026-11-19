import { describe, expect, it } from 'vitest';
import { EventLogWriter, RunDir } from '../../../src/runner/files.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import type { StoreDriver } from '../../support/store-driver.ts';
import { LogFeed, openTask, useTui } from '../../support/tui-fixtures.ts';

// A deputy turn's run writes its spool outside the task's operations; the Logs screen still shows it.
const tui = useTui();
const SETUP = uuidOf(700);
const CODER = uuidOf(701);
const TURN = uuidOf(900);
const DEPUTY_ATTEMPT = uuidOf(901);
const DEPUTY_OP = uuidOf(902);

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

describe('Logs of a task the deputy acted on', () => {
  it("shows the deputy turn's output under its own step", async () => {
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
      const started = d.store.deputy.startTurn({
        turn_id: TURN,
        goal_id: t.id,
        task_id: t.id,
        kind: 'incident',
        incident: `${t.id}:1:timeout:1`,
        signature: null,
        harness: 'fake',
        attempt_id: DEPUTY_ATTEMPT,
        mode: 'headless',
        context_bytes: 0,
        now: d.now,
      });
      if (!started.ok) throw new Error(JSON.stringify(started.error));
      const run = RunDir.open({
        dataDir: sd.dataDir,
        kind: 'runs',
        id: DEPUTY_ATTEMPT,
        redactor: new Redactor(),
      });
      const log = EventLogWriter.open(run, DEPUTY_OP);
      for (const line of ['deputy read the failure', 'deputy continued the task']) {
        const r = log.append('progress', line);
        if (!r.ok) throw new Error(r.error.code);
      }
      log.sync();
      if (!d.store.deputy.finishTurn(TURN, { state: 'done', now: d.now }).ok)
        throw new Error('turn not finished');
    });
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 120, rows: 30 });
    await openTask(s, 'Deputy task');
    s.send('l');
    await s.waitForText('Logs:');
    // The turn came last, so it is the step the log opens on.
    await s.waitForText('deputy continued the task');
    const screen = s.screenText();
    expect(screen).toContain('deputy read the failure');
    expect(screen).toMatch(/── deputy · attempt \w+ ──/);
    expect(screen.indexOf('deputy read the failure')).toBeLessThan(
      screen.indexOf('deputy continued the task'),
    );
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });
});
