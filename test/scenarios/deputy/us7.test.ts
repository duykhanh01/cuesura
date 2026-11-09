import { afterEach, describe, expect, it } from 'vitest';
import { withDeputyAssumptions } from '../../../src/adapters/github/publish.ts';
import type { HarnessInput } from '../../../src/adapters/ports.ts';
import { DEPUTY_ACTOR } from '../../../src/domain/deputy.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import type { Store } from '../../../src/store/index.ts';
import { buildTask } from '../../support/builders.ts';
import { deputyDaemon, handoffBody, type DeputyDaemon } from '../../support/deputy.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { agentData, PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';

// 007 US7 (T025): the worker's questions follow `autonomous`; the deputy answers as itself, a later
// question at the same step goes to it too, and its answers become the PR's assumptions.

const live: DeputyDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.sd.cleanup();
});

function ask(d: StoreDriver, taskId: string, question: string): void {
  d.complete(
    taskId,
    d.pendingOne(taskId, 'start_agent').id,
    'succeeded',
    agentData('needs_input', { questions: [question] }),
  );
}

const version = (store: Store, id: string): number => store.readTask(id as Uuid)?.version ?? -1;
const turnOf = (input: HarnessInput): string => input.deputy_turn as string;
const questions = (store: Store, id: string) =>
  Object.values(store.readTask(id as Uuid)?.questions ?? {});

/** A task whose worker asked; each turn of the deputy answers with the next of `answers`. */
async function asking(answers: readonly string[], autonomous: boolean) {
  const t = buildTask();
  const ctx: { store: Store | null; x: DeputyDaemon | null } = { store: null, x: null };
  const steps = answers.map((answer) => ({
    kind: 'turn_ended' as const,
    act: async (input: HarnessInput) => {
      const store = ctx.store as Store;
      const q = questions(store, t.id).find((x) => x.status === 'open');
      const r = await (ctx.x as DeputyDaemon).asDeputy(turnOf(input), {
        kind: 'answer',
        task_id: t.id,
        expected_version: version(store, t.id),
        payload: { question_id: q?.id, answer },
        reason: 'the repo uses it everywhere',
      });
      expect(r.envelope.ok, JSON.stringify(r.envelope)).toBe(true);
      await (ctx.x as DeputyDaemon).asDeputy(turnOf(input), handoffBody('answered', 'spec'));
    },
  }));
  const x = deputyDaemon(steps, { autonomous });
  ctx.x = x;
  live.push(x);
  x.sd.seed((d) => {
    createGrantStart(d, t, 'direct-pr');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    ask(d, t.id, 'Which encoding?');
  });
  const running = await x.sd.start();
  ctx.store = running.store;
  return { ...x, t, store: running.store };
}

describe('US7: questions of the worker follow autonomous', () => {
  it('goes to the deputy while autonomous is on, also for a later question at the same step', async () => {
    const x = await asking(['UTF-8', 'No BOM'], true);
    await x.deputy().round();
    await x.deputy().idle();
    const d = new StoreDriver(x.store);
    d.now = x.sd.now;
    ask(d, x.t.id, 'And the BOM?');
    x.sd.now = d.now;
    await x.deputy().round();
    await x.deputy().idle();

    const qs = questions(x.store, x.t.id);
    expect(qs.map((q) => [q.status, q.answered_by])).toEqual([
      ['answered', DEPUTY_ACTOR],
      ['answered', DEPUTY_ACTOR],
    ]);
    expect(x.store.deputy.turnsOf({ task_id: x.t.id }).map((t) => [t.kind, t.state])).toEqual([
      ['question', 'done'],
      ['question', 'done'],
    ]);
  });

  it('goes to the owner while autonomous is off, and to the deputy once it is turned on', async () => {
    const x = await asking(['UTF-8'], false);
    await x.deputy().round();
    await x.deputy().idle();
    expect(x.harness.calls).toEqual([]);
    const peek = await x.sd.query('assistant', { kind: 'attention_peek' });
    expect(
      ((peek.envelope.data?.['tasks'] ?? []) as { task_id: string }[]).map((i) => i.task_id),
    ).toEqual([x.t.id]);

    x.setAutonomous(true);
    await x.deputy().round();
    await x.deputy().idle();
    expect(x.harness.calls).toHaveLength(1);
    expect(x.harness.calls[0]?.context.text).toContain('Which encoding?');
  });
});

describe('US7: the deputy answers are the assumptions of the PR', () => {
  it('adds one fixed section after the worker body, and nothing without answers', () => {
    expect(withDeputyAssumptions('Fixes add.', [])).toBe('Fixes add.');
    const body = withDeputyAssumptions('Fixes add.\n', [
      { question: 'Which\nencoding?', answer: 'UTF-8, as the repo does.' },
    ]);
    expect(body).toBe(
      'Fixes add.\n\n## Assumptions made by the deputy\n\n- **Which encoding?**\n  UTF-8, as the repo does.\n',
    );
  });
});
