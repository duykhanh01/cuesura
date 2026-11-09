/**
 * Read commands print a short default view (issue #95): `task list` starts at the newest tasks and pages
 * to every older one, `task explain`/`show`/`history` leave logs, PR text and payloads to `--full`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CUSR_COMMANDS } from '../../../src/cli/commands.ts';
import { runCli } from '../../../src/cli/program.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import { A, toGreen } from '../../support/observation.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { agentData, PREPARE_DATA } from '../../support/scenario.ts';
import { checkpointGates } from '../../support/store-flows.ts';

const live: SeededDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.cleanup();
});

function daemon(): SeededDaemon {
  const sd = new SeededDaemon();
  live.push(sd);
  return sd;
}

async function run(
  sd: SeededDaemon,
  argv: string[],
  json = true,
): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const code = await runCli(
    { name: 'cusr', description: 'test', version: '0' },
    [...argv, '--data-dir', sd.dataDir, ...(json ? ['--json'] : [])],
    { stdout: (t) => out.push(t), stderr: () => undefined },
    CUSR_COMMANDS,
  );
  return { code, out: out.join('') };
}

async function data(sd: SeededDaemon, argv: string[]): Promise<Record<string, unknown>> {
  const r = await run(sd, argv);
  const envelope = JSON.parse(r.out) as {
    ok: boolean;
    data: Record<string, unknown>;
  };
  expect(envelope.ok).toBe(true);
  return envelope.data;
}

const ids = (page: Record<string, unknown>): string[] =>
  (page['items'] as { task_id: string }[]).map((t) => t.task_id);

const LOG = `FAIL test/unit.test.ts\n${'stack line\n'.repeat(300)}`;

/** A direct-pr task whose unit gate failed with a long log; the fixer is now at work. */
function failedGate(sd: SeededDaemon) {
  const t = buildTask();
  sd.seed((d) => {
    createGrantStart(d, t, 'direct-pr');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(
      t.id,
      d.pendingOne(t.id, 'run_gates').id,
      'succeeded',
      checkpointGates(
        A,
        {},
        {
          results: [
            { gate: 'build', passed: true },
            {
              gate: 'unit',
              passed: false,
              signature: 'unit:E1',
              log_excerpt: LOG.slice(0, 4_000),
            },
          ],
        },
      ),
    );
  });
  return t;
}

describe('task list', () => {
  it('starts at the newest tasks, 20 by default, and pages to every older one', async () => {
    const sd = daemon();
    const tasks = Array.from({ length: 23 }, (_, i) =>
      buildTask({ id: uuidOf(100 + i), title: `task ${i}` }),
    );
    sd.seed((d) => {
      for (const t of tasks) d.must(t.id, { kind: 'create_task', task: t });
    });
    await sd.start();
    const newest = [...tasks].reverse().map((t) => t.id);

    const first = await data(sd, ['task', 'list']);
    expect(ids(first)).toEqual(newest.slice(0, 20));
    expect(first['next_cursor']).toBe(newest[19]);
    expect(Object.keys((first['items'] as object[])[0] ?? {})).toEqual([
      'task_id',
      'project',
      'title',
      'status',
    ]);
    const full = await data(sd, ['task', 'list', '--full', '--limit', '1']);
    expect((full['items'] as object[])[0]).toHaveProperty('version');
    const second = await data(sd, ['task', 'list', '--cursor', first['next_cursor'] as string]);
    expect(ids(second)).toEqual(newest.slice(20));
    expect(second['next_cursor']).toBeNull();

    const oldest = await data(sd, ['task', 'list', '--order', 'oldest', '--limit', '2']);
    expect(ids(oldest)).toEqual([tasks[0]?.id, tasks[1]?.id]);
    const next = await data(sd, [
      'task',
      'list',
      '--order',
      'oldest',
      '--limit',
      '2',
      '--cursor',
      oldest['next_cursor'] as string,
    ]);
    expect(ids(next)).toEqual([tasks[2]?.id, tasks[3]?.id]);

    expect((await run(sd, ['task', 'list', '--order', 'recent'])).code).toBe(2);
  });

  it('prints a table and the command for the next page', async () => {
    const sd = daemon();
    sd.seed((d) => {
      for (let i = 0; i < 3; i++) {
        const t = buildTask({ id: uuidOf(200 + i), title: `task ${i}` });
        d.must(t.id, { kind: 'create_task', task: t });
      }
    });
    await sd.start();
    const r = await run(sd, ['task', 'list', '--limit', '2', '--project', 'acme'], false);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^ID\s+PROJECT\s+STATUS\s+ACTIVITY\s+PR\s+TITLE$/);
    expect(lines[1]).toContain('task 2');
    expect(lines[2]).toContain('task 1');
    expect(lines.at(-1)).toBe(
      `More: cusr task list --project acme --limit 2 --data-dir ${sd.dataDir} --cursor ${uuidOf(201)}`,
    );
  });
});

describe('task explain and task show', () => {
  it('names the failed gate and the running fixer without the log; --full keeps everything', async () => {
    const sd = daemon();
    const t = failedGate(sd);
    await sd.start();

    const why = await data(sd, ['task', 'explain', t.id]);
    expect(why).toMatchObject({
      task_id: t.id,
      status: 'RUNNING',
      step: 'fix_gates',
      running: [{ step: 'fix_gates', binding: expect.any(String) as string }],
      failed: { gates: ['unit'] },
      details: `cusr task explain ${t.id} --full`,
    });
    // Nothing a progress question does not need, and no empty field.
    for (const k of [
      'evidence',
      'bindings_used',
      'escalations',
      'remaining',
      'slot',
      'deadline',
      'pr',
      'pending_effects',
      'prerequisites',
      'blockers',
      'merge_cleanup',
      'cancellation',
    ])
      expect(why).not.toHaveProperty(k);
    expect(JSON.stringify(why).length).toBeLessThan(1_500);
    expect(JSON.stringify(why)).not.toContain('stack line');
    expect(why['allowed_actions']).toContainEqual(expect.objectContaining({ action: 'cancel' }));

    const full = await data(sd, ['task', 'explain', t.id, '--full']);
    expect(full).not.toHaveProperty('details');
    expect(JSON.stringify(full['evidence'])).toContain('stack line');
    expect(full['bindings_used']).not.toEqual([]);
  });

  it('show keeps what a mutation needs; --full adds provenance and the rest', async () => {
    const sd = daemon();
    const t = failedGate(sd);
    await sd.start();
    const show = await data(sd, ['task', 'show', t.id]);
    expect(show).toMatchObject({
      task_id: t.id,
      status: 'RUNNING',
      step: 'fix_gates',
      run_config: { status: 'confirmed', mode: 'direct-pr' },
      details: `cusr task show ${t.id} --full`,
    });
    expect(typeof show['version']).toBe('number');
    expect(typeof (show['run_config'] as { digest: unknown }).digest).toBe('string');
    for (const k of ['provenance', 'execution', 'merge', 'revision'])
      expect(show).not.toHaveProperty(k);
    const full = await data(sd, ['task', 'show', t.id, '--full']);
    expect(full['version']).toBe(show['version']);
    expect(full).toHaveProperty('provenance');
  });

  it('keeps what a manual merge needs: the wait, the merge method and the PR', async () => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => toGreen(d, t, 'direct-pr', {}, { merge_method: 'rebase' }));
    await sd.start();
    const why = await data(sd, ['task', 'explain', t.id]);
    expect(why).toMatchObject({
      wait: { reason: 'approval', detail: { code: 'merge' } },
      merge: { method: 'rebase' },
      pr: { ref: 'acme#7', head_sha: A },
    });
    expect(why['allowed_actions']).toContainEqual(expect.objectContaining({ action: 'cancel' }));
  });
});

describe('task history', () => {
  it('lists 50 events without payloads by default; --full adds them', async () => {
    const sd = daemon();
    const t = failedGate(sd);
    await sd.start();
    const page = await data(sd, ['task', 'history', t.id]);
    const events = page['events'] as Record<string, unknown>[];
    expect(events.length).toBeLessThanOrEqual(50);
    expect(Object.keys(events[0] ?? {})).toEqual(['seq', 'type', 'revision', 'actor', 'at']);
    expect(events[0]?.['at']).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(page['details']).toBe(`cusr task history ${t.id} --full`);
    expect(JSON.stringify(page)).not.toContain('stack line');
    const full = await data(sd, ['task', 'history', t.id, '--full']);
    expect(JSON.stringify(full)).toContain('stack line');

    const human = await run(sd, ['task', 'history', t.id, '--limit', '2'], false);
    const lines = human.out.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^SEQ\s+AT\s+REVISION\s+ACTOR\s+TYPE$/);
    expect(lines[1]).toMatch(/TaskCreated$/);
    expect(lines.at(-1)).toBe(`More: cusr task history ${t.id} --after 2`);
  });

  it('--tail shows the newest events, each with its time, and nothing after them', async () => {
    const sd = daemon();
    const t = failedGate(sd);
    await sd.start();
    const all = (await data(sd, ['task', 'history', t.id, '--limit', '500']))['events'] as {
      seq: number;
    }[];
    const page = await data(sd, ['task', 'history', t.id, '--tail', '--limit', '3']);
    const events = page['events'] as { seq: number; at?: string }[];
    expect(events.map((e) => e.seq)).toEqual(all.slice(-3).map((e) => e.seq));
    for (const e of events) expect(e.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(page['next_cursor']).toBe(all.at(-1)?.seq);
    expect(page['more']).toBe(false);

    const both = await run(sd, ['task', 'history', t.id, '--tail', '--after', '1']);
    expect(both.code).toBe(2);
  });
});
