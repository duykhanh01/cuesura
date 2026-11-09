import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../../src/cli/output.ts';
import type { CliIo } from '../../../src/cli/program.ts';
import { failCommand } from '../../../src/cli/tasks.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import { buildTask } from '../../support/builders.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { agentData, PREPARE_DATA } from '../../support/scenario.ts';

// 007 FR-032: `cusr task fail <id> --reason` ends a waiting task through the draft-PR path of #247.

const live: SeededDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.cleanup();
});

async function daemon(o: { asking: boolean; drift?: boolean }) {
  const sd = new SeededDaemon();
  live.push(sd);
  const t = sd.seed((d) => {
    const task = buildTask();
    createGrantStart(d, task, 'direct-pr');
    d.complete(task.id, d.pendingOne(task.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    const agent = d.pendingOne(task.id, 'start_agent');
    if (o.drift === true) {
      if (!d.claim(agent.id).ok) throw new Error('claim');
      d.must(task.id, { kind: 'source_updated', task: { ...task, description: 'changed' } });
      d.must(task.id, {
        kind: 'effect_result',
        effect_id: agent.id as Uuid,
        outcome: 'succeeded',
        data: agentData('done'),
      });
      expect(d.task(task.id).wait?.detail.code).toBe('source_drift');
    } else if (o.asking)
      d.complete(
        task.id,
        agent.id,
        'succeeded',
        agentData('needs_input', { questions: ['Which?'] }),
      );
    else if (!d.claim(agent.id).ok) throw new Error('claim');
    return task;
  });
  const running = await sd.start();
  const out: string[] = [];
  const io = {
    stdout: (x: string) => void out.push(x),
    stderr: (x: string) => void out.push(x),
  } as CliIo;
  const fail = (values: Record<string, string>) =>
    failCommand.run(
      {
        dataDir: sd.dataDir,
        id: t.id,
        expectedVersion: String(running.store.readTask(t.id)?.version),
        ...values,
      },
      true,
      io,
    );
  return { t, store: running.store, fail, out };
}

describe('cusr task fail', () => {
  it('requires --reason (exit 2) and sends nothing without it', async () => {
    const { fail, out, store, t } = await daemon({ asking: true });
    const before = store.readTask(t.id)?.version;
    expect(await fail({})).toBe(ExitCode.usage);
    expect(out.join('')).toContain('--reason');
    expect(store.readTask(t.id)?.version).toBe(before);
  });

  it('is refused (exit 6) when the task is not waiting', async () => {
    const { fail, out } = await daemon({ asking: false });
    expect(await fail({ reason: 'stop here' })).toBe(ExitCode.conflict);
    expect(out.join('')).toContain('fail_not_waiting');
  });

  it('ends a waiting task with its reason, opening a draft PR first for unpublished work', async () => {
    const { fail, store, t } = await daemon({ asking: true });
    expect(await fail({ reason: 'the approach cannot work' })).toBe(ExitCode.ok);
    const s = store.readTask(t.id);
    // Nothing is published yet, so the salvage of #247 runs before FAILED.
    expect(s?.run.salvage).toMatchObject({ reason: 'the approach cannot work' });
    expect(s?.wait).toBeNull();
  });

  it('ends a task waiting on source drift at once, with no draft PR it could never publish', async () => {
    const { fail, store, t } = await daemon({ asking: false, drift: true });
    expect(await fail({ reason: 'the request changed under it' })).toBe(ExitCode.ok);
    const s = store.readTask(t.id);
    expect(s?.status).toBe('FAILED');
    expect(s?.terminal?.reason).toBe('the request changed under it (no draft PR: source drift)');
  });

  it('is refused (exit 6) once the task has ended', async () => {
    const { fail, out, store, t } = await daemon({ asking: false, drift: true });
    expect(await fail({ reason: 'end it' })).toBe(ExitCode.ok);
    expect(store.readTask(t.id)?.status).toBe('FAILED');
    const version = store.readTask(t.id)?.version;
    out.length = 0;
    expect(await fail({ reason: 'again' })).toBe(ExitCode.conflict);
    expect(out.join('')).toContain('fail_not_waiting');
    expect(store.readTask(t.id)?.version).toBe(version);
  });
});
