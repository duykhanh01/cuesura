import { afterEach, describe, expect, it } from 'vitest';
import { createDaemonPort } from '../../../src/tui/client/daemon-port.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import { buildTask, ownerAuthz, uuidOf } from '../../support/builders.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import { SeededDaemon, type SeededExtra } from '../../support/daemon-task.ts';
import {
  fakeGit,
  fakeGitHub,
  fakeHost,
  MANIFESTS,
  userConfig,
} from '../../support/preflight-fakes.ts';
import { createGrantStart, selectionFor } from '../../support/runtime.ts';

// The schemas of the interface against what a real daemon answers: a schema that only ever met a hand-made
// sample would turn every real response into "incompatible".

const live: SeededDaemon[] = [];
afterEach(async () => {
  for (const d of live.splice(0)) await d.cleanup();
});

const extra: SeededExtra = (store) => ({
  logs: { dataDir: '/nonexistent', redactor: new Redactor() },
  confirm: {
    store,
    ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
    configInputs: () =>
      Promise.resolve({
        user: userConfig(),
        packs: PACKS,
        manifests: MANIFESTS,
      }),
    now: () => 0,
  },
});

const TIMEOUT = 5_000;

describe('interface schemas against a real daemon', () => {
  async function seeded() {
    const sd = new SeededDaemon({}, extra);
    live.push(sd);
    const fresh = buildTask({
      id: uuidOf(1),
      requested_by: { kind: 'assistant', id: 'assistant' },
    });
    const proposed = buildTask({ id: uuidOf(2) });
    const running = buildTask({ id: uuidOf(3) });
    const cancelled = buildTask({ id: uuidOf(4) });
    sd.seed((d) => {
      d.must(fresh.id, { kind: 'create_task', task: fresh });
      d.must(proposed.id, { kind: 'create_task', task: proposed });
      d.must(
        proposed.id,
        {
          kind: 'propose_run_config',
          selection: selectionFor(proposed, 'full-review'),
        },
        { authz: ownerAuthz() },
      );
      d.must(cancelled.id, { kind: 'create_task', task: cancelled });
      d.must(cancelled.id, { kind: 'cancel', reason: 'stop' });
    });
    sd.seed((d) => createGrantStart(d, running, 'direct-pr'));
    await sd.start();
    const port = createDaemonPort({ dataDir: sd.dataDir, env: {} });
    return { sd, port, ids: { fresh, proposed, running, cancelled } };
  }

  it('reads health and the board', async () => {
    const { port } = await seeded();
    expect(await port.health(TIMEOUT)).toMatchObject({
      ok: true,
      value: { healthy: true },
    });
    const board = await port.board({ scope: 'all' }, TIMEOUT);
    expect(board).toMatchObject({ ok: true, value: { unchanged: false } });
    if (!board.ok || board.value.unchanged) return;
    expect(board.value.items).toHaveLength(4);
    const again = await port.board(
      { scope: 'all', if_changed_since: board.value.watermark },
      TIMEOUT,
    );
    expect(again).toMatchObject({ ok: true, value: { unchanged: true } });
  });

  it('reads the project list', async () => {
    const { port } = await seeded();
    expect(await port.projects(TIMEOUT)).toMatchObject({
      ok: true,
      value: { caller: { actor: 'owner' } },
    });
  });

  it('reads run options', async () => {
    const { port, ids } = await seeded();
    expect(await port.runOptions(ids.fresh.id, TIMEOUT)).toMatchObject({
      ok: true,
      value: { profile: { id: 'standard' } },
    });
  });

  it.each(['fresh', 'proposed', 'running', 'cancelled'] as const)(
    'reads every view of a %s task',
    async (which) => {
      const { port, ids } = await seeded();
      const id = ids[which].id;
      for (const [name, read] of [
        ['content', port.content(id, TIMEOUT)],
        ['progress', port.progress(id, TIMEOUT)],
        ['show', port.show(id, TIMEOUT)],
        ['explain', port.explain(id, TIMEOUT)],
        ['history', port.history(id, 0, TIMEOUT)],
        ['logs', port.logs({ taskId: id, after: 0 }, TIMEOUT)],
      ] as const) {
        const r = await read;
        expect(r.ok ? 'ok' : JSON.stringify(r.error), name).toBe('ok');
      }
    },
  );

  it('offers the actions task_explain reports', async () => {
    const { port, ids } = await seeded();
    const r = await port.explain(ids.fresh.id, TIMEOUT);
    expect(r).toMatchObject({
      ok: true,
      value: { allowed_actions: expect.any(Array) as unknown[] },
    });
  });

  it('reads a request, found or not', async () => {
    const { sd, port } = await seeded();
    await sd.command('owner', {
      request_id: uuidOf(600),
      kind: 'task_add',
      project: 'acme',
      task_id: null,
      expected_version: null,
      payload: {
        task: { title: 'x', base_branch: 'main', acceptance: ['a'] },
      },
    });
    expect(await port.requestShow(uuidOf(600), TIMEOUT)).toMatchObject({
      ok: true,
      value: { state: 'completed', outcome: { ok: true } },
    });
    await sd.command('owner', {
      request_id: uuidOf(601),
      kind: 'task_add',
      project: 'acme',
      task_id: null,
      expected_version: null,
      payload: { task: { title: '' } },
    });
    expect(await port.requestShow(uuidOf(601), TIMEOUT)).toMatchObject({
      ok: true,
      value: { outcome: { ok: false, error: { code: 'invalid_command' } } },
    });
    expect(await port.requestShow(uuidOf(602), TIMEOUT)).toMatchObject({
      ok: false,
      error: { kind: 'rejected', code: 'request_not_found' },
    });
  });
});
