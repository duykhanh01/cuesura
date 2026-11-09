import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../../src/cli/output.ts';
import type { RunSelection } from '../../../src/domain/run-config.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import type { EpochMs, Hash, Uuid } from '../../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, freezeOk, ownerAuthz, uuidOf } from '../../support/builders.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import {
  confirmedRuntime,
  createGrantStart,
  proposeAndConfirm,
  selectionFor,
} from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { publishToReview, toPublish } from '../../support/store-flows.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import {
  fakeGit,
  fakeGitHub,
  fakeHost,
  MANIFESTS,
  userConfig,
} from '../../support/preflight-fakes.ts';
import type { ConfigSource } from '../../../src/config/yaml-loader.ts';
import { MAX_FALLBACKS } from '../../../src/domain/run-config.ts';

// A confirmed run config must be runnable (issue #263): fallbacks default to the worker's ladder on add
// as on propose, a selection `run_options` does not offer is refused up front, no approval is asked for
// a rung that could not run, and a task nobody can ever give acceptance to is not created.

const tempDir = useTempDir('cusr-263-');
const CHECKPOINT = 'c'.repeat(40);
const QUALITY = {
  failure_class: 'quality',
  signature: 'Q1',
  invoked: true,
  usage: { basis: 'unavailable' },
} as const;

type Choice = { harness: string; model: string; effort: string };

const live: SeededDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.cleanup();
});

async function daemon(user?: ConfigSource): Promise<SeededDaemon> {
  const sd = new SeededDaemon(
    {},
    user === undefined
      ? () => ({})
      : (store) => ({
          confirm: {
            store,
            ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
            configInputs: () => Promise.resolve({ user, packs: PACKS, manifests: MANIFESTS }),
            now: () => 0,
          },
        }),
  );
  live.push(sd);
  await sd.start();
  return sd;
}

let request = 0;
const requestId = () => `0192bbbb-0000-7000-8000-${String(++request).padStart(12, '0')}`;

// The daemon's user config (test/fixtures/configs/valid/user.yaml): profile `standard`, coder sonnet/medium.
const WORKER: Choice = { harness: 'claude', model: 'sonnet', effort: 'medium' };
const run = (over: Record<string, unknown> = {}) => ({
  profile: 'standard',
  mode: 'direct-pr',
  reason: '',
  worker: WORKER,
  reviewer: null,
  ...over,
});

function add(sd: SeededDaemon, runConfig: unknown, task: Record<string, unknown> = {}) {
  return sd.command('assistant', {
    request_id: requestId(),
    kind: 'task_add',
    project: 'acme',
    task_id: null,
    expected_version: null,
    payload: {
      task: { title: 'T', base_branch: 'main', acceptance: ['works'], ...task },
      ...(runConfig === undefined ? {} : { run_config: runConfig }),
    },
  });
}

const result = (r: Awaited<ReturnType<typeof add>>) =>
  r.envelope.data?.['result'] as {
    task_id: string;
    version: number;
    run_config: { selection: RunSelection } | null;
  };

async function offered(sd: SeededDaemon, taskId: string): Promise<Choice[]> {
  const r = await sd.query('owner', { kind: 'run_options', task_id: taskId });
  const modes = (
    r.envelope.data as {
      modes: { mode: string; workers: { choice: Choice; fallbacks: Choice[] }[] }[];
    }
  ).modes;
  return modes.find((m) => m.mode === 'direct-pr')?.workers[0]?.fallbacks ?? [];
}

describe('fallbacks default to the worker ladder (#263)', () => {
  it('task add without fallbacks gets what task propose gets', async () => {
    const sd = await daemon();
    const added = result(await add(sd, run()));
    const ladder = await offered(sd, added.task_id);
    expect(ladder).not.toEqual([]);
    expect(added.run_config?.selection.fallbacks).toEqual(ladder);

    const proposed = await sd.command('assistant', {
      request_id: requestId(),
      kind: 'task_propose_run',
      project: 'acme',
      task_id: added.task_id,
      expected_version: added.version,
      payload: { run_config: run({ reason: 'again' }) },
    });
    expect(proposed.code).toBe(ExitCode.ok);
    expect(result(proposed).run_config?.selection.fallbacks).toEqual(ladder);
  });

  it('an explicit empty list still means none', async () => {
    const sd = await daemon();
    const added = result(await add(sd, run({ fallbacks: [] })));
    expect(added.run_config?.selection.fallbacks).toEqual([]);
  });

  it('the first escalation of a task added that way runs the configured rung', async () => {
    const sd = await daemon();
    const added = result(await add(sd, run()));
    await sd.stop();
    sd.seed((d) => {
      const id = added.task_id as Uuid;
      const t = d.task(id).task;
      const digest = d.task(id).run.proposal?.digest as Hash;
      d.must(id, { kind: 'confirm_task' });
      d.must(id, { kind: 'confirm_run_config', digest }, { authz: ownerAuthz() });
      d.must(id, { kind: 'request_execution' });
      d.store.grantNext(d.now as EpochMs);
      d.must(id, {
        kind: 'start',
        freeze: freezeOk(t, { mode: 'direct-pr' }),
        runtime: confirmedRuntime(d, t),
      });
      d.complete(id, d.pendingOne(id, 'prepare').id, 'succeeded', PREPARE_DATA);
      for (let i = 0; i < 2; i++) {
        if (d.task(id).wait?.detail.code === 'execution_slot') d.store.grantNext(d.now as EpochMs);
        d.complete(id, d.pendingOne(id, 'start_agent').id, 'failed', QUALITY);
      }
      if (d.task(id).wait?.detail.code === 'execution_slot') d.store.grantNext(d.now as EpochMs);
      const s = d.task(id);
      expect(s.status).not.toBe('FAILED');
      expect(d.pendingOne(id, 'start_agent').request).toMatchObject({
        binding: { model: 'sonnet', effort: 'high' },
      });
    });
  });
});

const REVIEWER: Choice = { harness: 'codex', model: 'sol', effort: 'medium' };
const fullReview = (over: Record<string, unknown> = {}) =>
  run({ mode: 'full-review', reviewer: REVIEWER, ...over });

async function offeredReviewer(sd: SeededDaemon, taskId: string): Promise<Choice[]> {
  const r = await sd.query('owner', { kind: 'run_options', task_id: taskId });
  const modes = (
    r.envelope.data as {
      modes: { mode: string; reviewer_fallbacks: { choice: Choice; fallbacks: Choice[] }[] }[];
    }
  ).modes;
  return modes.find((m) => m.mode === 'full-review')?.reviewer_fallbacks[0]?.fallbacks ?? [];
}

describe('reviewer fallbacks default to the reviewer ladder (#276)', () => {
  it('task add and task propose fill them; direct-pr has none', async () => {
    const sd = await daemon();
    const added = result(await add(sd, fullReview()));
    const ladder = await offeredReviewer(sd, added.task_id);
    expect(ladder).toEqual([{ harness: 'codex', model: 'sol', effort: 'high' }]);
    expect(added.run_config?.selection.reviewer_fallbacks).toEqual(ladder);

    const proposed = await sd.command('assistant', {
      request_id: requestId(),
      kind: 'task_propose_run',
      project: 'acme',
      task_id: added.task_id,
      expected_version: added.version,
      payload: { run_config: fullReview({ reason: 'again' }) },
    });
    expect(result(proposed).run_config?.selection.reviewer_fallbacks).toEqual(ladder);

    const direct = result(await add(sd, run()));
    expect(direct.run_config?.selection).not.toHaveProperty('reviewer_fallbacks');
  });

  it('an explicit empty list still means none', async () => {
    const sd = await daemon();
    const added = result(await add(sd, fullReview({ reviewer_fallbacks: [] })));
    expect(added.run_config?.selection.reviewer_fallbacks).toEqual([]);
  });

  it('a reviewer fallback off the reviewer ladder is refused with the valid values', async () => {
    const sd = await daemon();
    const r = await add(
      sd,
      fullReview({ reviewer_fallbacks: [{ harness: 'claude', model: 'opus', effort: 'high' }] }),
    );
    expect(r.code).toBe(ExitCode.conflict);
    expect(r.envelope.error).toMatchObject({
      code: 'rejected',
      details: {
        reason: 'run_config_not_offered',
        valid_values: { reviewer_fallbacks: [{ model: 'sol', effort: 'high' }] },
      },
    });
  });

  it('the first reviewer escalation of a full-review task runs the configured rung', async () => {
    const sd = await daemon();
    const added = result(await add(sd, fullReview()));
    await sd.stop();
    sd.seed((d) => {
      const id = added.task_id as Uuid;
      const t = d.task(id).task;
      const digest = d.task(id).run.proposal?.digest as Hash;
      d.must(id, { kind: 'confirm_task' });
      d.must(id, { kind: 'confirm_run_config', digest }, { authz: ownerAuthz() });
      d.must(id, { kind: 'request_execution' });
      d.store.grantNext(d.now as EpochMs);
      d.must(id, {
        kind: 'start',
        freeze: freezeOk(t, { mode: 'full-review' }),
        runtime: confirmedRuntime(d, t),
      });
      toPublish(d, t, CHECKPOINT);
      publishToReview(d, id, CHECKPOINT);
      for (let i = 0; i < 2; i++) {
        if (d.task(id).wait?.detail.code === 'execution_slot') d.store.grantNext(d.now as EpochMs);
        d.complete(id, d.pendingOne(id, 'start_agent').id, 'failed', QUALITY);
      }
      if (d.task(id).wait?.detail.code === 'execution_slot') d.store.grantNext(d.now as EpochMs);
      expect(d.task(id).status).not.toBe('FAILED');
      expect(d.pendingOne(id, 'start_agent').request).toMatchObject({
        binding: { harness: 'codex', model: 'sol', effort: 'high' },
      });
    });
  });
});

/** The fixture user config with `edit` applied to its text. */
function userWith(edit: (text: string) => string): ConfigSource {
  const base = userConfig();
  return { ...base, text: edit(base.text) };
}

const LADDER = '        - { effort: high }\n        - { model: opus, effort: high }';

describe('the default selection survives a large config (#263 review)', () => {
  it('a valid full-review pair past the run_options listing limit is accepted', async () => {
    // 9 worker and 8 reviewer bindings: the listing stops before it reaches sonnet with sol.
    const never = (model: string, effort: string) =>
      `      - { when: { size: [XS] }, model: ${model}, effort: ${effort} }`;
    const coders = ['haiku', 'opus', 'sol'].flatMap((m) =>
      ['low', 'medium', 'high'].map((e) => never(m, e)),
    );
    const reviewers = [
      ...['haiku', 'opus'].flatMap((m) => ['low', 'medium', 'high'].map((e) => never(m, e))),
      never('sonnet', 'low'),
    ];
    const user = userWith((t) =>
      t
        .replace(
          '      - when: { size: [L, XL] }\n        model: opus\n      - model: sonnet',
          [...coders.slice(0, 8), '      - model: sonnet'].join('\n'),
        )
        .replace(
          '    binding: [{ model: sol }]\n    escalation:',
          ['    binding:', ...reviewers, '      - model: sol', '    escalation:'].join('\n'),
        ),
    );
    const sd = await daemon(user);
    const added = await add(
      sd,
      run({ mode: 'full-review', reviewer: { harness: 'codex', model: 'sol', effort: 'medium' } }),
    );
    const options = await sd.query('owner', {
      kind: 'run_options',
      task_id: result(added).task_id,
    });
    expect(options.envelope.data?.['truncated']).toBe(true);
    expect(added.code).toBe(ExitCode.ok);
    expect(result(added).run_config?.selection.reviewer).toMatchObject({ model: 'sol' });
  });

  it('a ladder longer than a selection holds fills the lowest rungs, before the task exists', async () => {
    const rungs = [
      '{ effort: low }',
      '{ effort: high }',
      '{ model: haiku, effort: low }',
      '{ model: haiku, effort: medium }',
      '{ model: haiku, effort: high }',
      '{ model: sol, effort: low }',
      '{ model: sol, effort: medium }',
      '{ model: sol, effort: high }',
      '{ model: opus, effort: high }',
    ].map((r) => `        - ${r}`);
    const user = userWith((t) =>
      t
        .replaceAll(LADDER, rungs.join('\n'))
        .replace('allow_models: [sonnet, sol, haiku]', 'allow_models: [sonnet, sol, haiku, opus]')
        // Rung 9 needs 19 visits of each worker step.
        .replace(
          '    base: software_dev@1\n',
          '    base: software_dev@1\n    steps:\n' +
            ['code', 'ci_fix', 'fix_gates', 'fix_review']
              .map((step) => `      ${step}: { max_visits: 19 }\n`)
              .join(''),
        ),
    );
    const sd = await daemon(user);
    const added = await add(sd, run());
    expect(added.code).toBe(ExitCode.ok);
    const ladder = await offered(sd, result(added).task_id);
    expect(ladder.length).toBeGreaterThan(MAX_FALLBACKS);
    expect(result(added).run_config?.selection.fallbacks).toEqual(ladder.slice(0, MAX_FALLBACKS));
  });
});

describe('a selection run_options does not offer is refused up front (#263)', () => {
  it.each([
    ['profile', run({ profile: 'no-such-profile' }), { profile: ['standard'] }],
    [
      'worker',
      run({ worker: { harness: 'nope', model: 'no-such-model', effort: 'high' } }),
      { worker: [WORKER] },
    ],
    [
      'fallback',
      run({ fallbacks: [{ harness: 'claude', model: 'opus', effort: 'high' }] }),
      { fallbacks: [{ harness: 'claude', model: 'sonnet', effort: 'high' }] },
    ],
  ])('on add: a wrong %s, with the valid values, and no task left behind', async (_, rc, valid) => {
    const sd = await daemon();
    const r = await add(sd, rc);
    expect(r.code).toBe(ExitCode.conflict);
    expect(r.envelope.error).toMatchObject({
      code: 'rejected',
      details: { reason: 'run_config_not_offered', valid_values: valid },
    });
    const listed = await sd.query('owner', { kind: 'task_list' });
    expect((listed.envelope.data as { items: unknown[] }).items).toEqual([]);
  });

  it('on propose: a reviewer the mode does not offer', async () => {
    const sd = await daemon();
    const added = result(await add(sd, undefined));
    const r = await sd.command('assistant', {
      request_id: requestId(),
      kind: 'task_propose_run',
      project: 'acme',
      task_id: added.task_id,
      expected_version: added.version,
      payload: {
        run_config: run({
          mode: 'full-review',
          reviewer: { harness: 'codex', model: 'terra', effort: 'medium' },
        }),
      },
    });
    expect(r.envelope.error).toMatchObject({
      code: 'rejected',
      details: { valid_values: { reviewer: [{ model: 'sol' }] } },
    });
  });
});

describe('acceptance (#263)', () => {
  it('task add without acceptance is refused as invalid arguments', async () => {
    const sd = await daemon();
    const r = await add(sd, undefined, { acceptance: [] });
    expect(r.code).toBe(ExitCode.usage);
    expect(r.envelope.error).toMatchObject({ code: 'invalid_arguments' });
  });
});

describe('no escalation wait for a rung that cannot run (#263)', () => {
  const setup = () => new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
  const approvals = (d: StoreDriver, t: CanonicalTask) =>
    d.store.readEvents(t.id).filter((e) => e.type === 'ApprovalRequested');

  it('a reviewer rung outside the selection ends the task without asking for an approval', () => {
    const d = setup();
    try {
      const t = buildTask({ id: uuidOf(263) });
      // opus is above `auto_up_to_tier`, so the rung needs an approval, and it is not the confirmed reviewer.
      createGrantStart(d, t, 'full-review', {
        roles: {
          reviewer: {
            model: 'sol',
            effort: 'medium',
            permissions: 'read_only',
            ladder: [{ model: 'opus', effort: 'high' }],
          },
        },
      });
      toPublish(d, t, CHECKPOINT);
      publishToReview(d, t.id, CHECKPOINT);
      for (let i = 0; i < 2; i++) {
        if (d.task(t.id).wait?.detail.code === 'execution_slot') d.grantNext();
        d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', QUALITY);
      }
      expect(approvals(d, t)).toEqual([]);
      expect(d.task(t.id).wait?.detail.code).not.toBe('escalation');
      expect(d.task(t.id).terminal).toEqual({
        kind: 'FAILED',
        reason: 'run_config_unconfirmed:review:opus/high',
      });
    } finally {
      d.store.close();
    }
  });

  it('a confirmed reviewer fallback above auto_up_to_tier runs once approved (#276)', () => {
    const d = setup();
    try {
      const t = buildTask({ id: uuidOf(276) });
      const OPUS = { harness: 'claude', model: 'opus', effort: 'high' } as const;
      const roles = {
        reviewer: {
          model: 'sol',
          effort: 'medium' as const,
          permissions: 'read_only' as const,
          ladder: [{ model: 'opus', effort: 'high' as const }],
        },
      };
      const frozen = freezeOk(t, { mode: 'full-review', roles });
      d.must(t.id, { kind: 'create_task', task: t });
      proposeAndConfirm(d, t, {
        ...selectionFor(t, 'full-review', frozen.value.policy),
        reviewer_fallbacks: [OPUS],
      });
      d.must(t.id, { kind: 'request_execution' });
      d.store.grantNext(d.now as EpochMs);
      d.must(t.id, { kind: 'start', freeze: frozen, runtime: confirmedRuntime(d, t) });
      toPublish(d, t, CHECKPOINT);
      publishToReview(d, t.id, CHECKPOINT);
      for (let i = 0; i < 2; i++) {
        if (d.task(t.id).wait?.detail.code === 'execution_slot') d.grantNext();
        d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', QUALITY);
      }
      const wait = d.task(t.id).wait;
      expect(wait?.reason).toBe('approval');
      expect(approvals(d, t)).toHaveLength(1);
      d.must(
        t.id,
        { kind: 'approve', approval_request_id: wait?.detail['approval_id'] as Uuid },
        { authz: ownerAuthz() },
      );
      if (d.task(t.id).wait?.detail.code === 'execution_slot') d.grantNext();
      expect(d.task(t.id).status).not.toBe('FAILED');
      expect(d.pendingOne(t.id, 'start_agent').request).toMatchObject({ binding: OPUS });
    } finally {
      d.store.close();
    }
  });

  it('with no escalation left the task waits on the budget, not on an approval', () => {
    const d = setup();
    try {
      const t = buildTask({ id: uuidOf(264) });
      createGrantStart(d, t, 'direct-pr', {
        roles: {
          coder: { model: 'sonnet', effort: 'medium', ladder: [{ model: 'opus', effort: 'high' }] },
        },
        limits: { max_escalations: 0 },
      } as never);
      d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
      for (let i = 0; i < 2; i++) {
        if (d.task(t.id).wait?.detail.code === 'execution_slot') d.grantNext();
        d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', QUALITY);
      }
      expect(approvals(d, t)).toEqual([]);
      expect(d.task(t.id).wait?.detail).toMatchObject({
        code: 'escalations_exhausted',
        step: 'code',
      });
    } finally {
      d.store.close();
    }
  });
});
