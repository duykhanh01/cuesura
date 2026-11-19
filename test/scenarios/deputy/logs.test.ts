import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { callerFor, type Caller } from '../../../src/application/authz.ts';
import { taskLogs } from '../../../src/application/logs.ts';
import { EventLogWriter, RunDir } from '../../../src/runner/files.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import { buildTask } from '../../support/builders.ts';
import { deputyDaemon, handoffBody, type DeputyDaemon } from '../../support/deputy.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';

// A deputy turn's output in `task_logs`, as the daemon runs the turn: the count of what each run wrote
// is kept when the run ends, so the place it took in the log survives losing its spool.
const HOUR = 3_600_000;
const live: DeputyDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.sd.cleanup();
});

type Page = {
  records: { seq: number; data?: unknown; gap?: { records: number } }[];
  next_cursor: number;
};

describe('the logs of a deputy turn the daemon ran', () => {
  it('keep their place once the turn ended, even when its spool is gone', async () => {
    let dir: string | null = null;
    const x: DeputyDaemon = deputyDaemon([
      {
        kind: 'turn_ended',
        final_message: 'Looked at the setup failure.',
        act: async (input) => {
          const run = RunDir.open({
            dataDir: x.sd.dataDir,
            kind: 'runs',
            id: input.attempt_id,
            redactor: new Redactor(),
          });
          dir = run.dir;
          const log = EventLogWriter.open(run, input.operation_id);
          for (const line of ['deputy read the failure', 'deputy handed it over']) {
            const r = log.append('progress', line);
            if (!r.ok) throw new Error(r.error.code);
          }
          log.sync();
          await x.asDeputy(input.deputy_turn as string, handoffBody('handover'));
        },
      },
    ]);
    live.push(x);
    const t = buildTask();
    x.sd.seed((d) => {
      createGrantStart(d, t, 'direct-pr', { limits: { max_wall_ms: 24 * HOUR } });
      const failed = { ...PREPARE_DATA, setup: { ran: true, passed: false } };
      for (let i = 0; i < 12 && d.task(t.id).wait?.detail.code !== 'backoff_exhausted'; i++) {
        d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', failed);
        d.now += 300_000;
        d.fire();
      }
      expect(d.task(t.id).wait?.detail.code).toBe('backoff_exhausted');
    });
    const running = await x.sd.start();
    await x.deputy().round();
    await x.deputy().idle();

    // The daemon's own `task_logs`, over the store and data dir it runs on.
    const logs = (after = 0): Page => {
      const r = taskLogs(
        { store: running.store, dataDir: x.sd.dataDir, redactor: new Redactor() },
        callerFor('owner') as Caller,
        { kind: 'task_logs', task_id: t.id, after },
      );
      if (!r.ok) throw new Error(r.error.code);
      return r.value as Page;
    };
    const read = logs();
    expect(read.records.map((r) => r.data)).toEqual([
      'deputy read the failure',
      'deputy handed it over',
    ]);
    expect(running.store.deputy.runsOf(t.id)).toEqual([
      expect.objectContaining({ live: false, records: 2 }),
    ]);

    rmSync(dir as unknown as string, { recursive: true });
    const lost = logs();
    expect(lost.next_cursor).toBe(read.next_cursor);
    expect(lost.records).toHaveLength(1);
    expect(lost.records[0]).toMatchObject({ seq: 2 });
    expect(lost.records[0]?.gap?.records).toBe(2);
    expect(logs(read.next_cursor).records).toEqual([]);
  });
});
