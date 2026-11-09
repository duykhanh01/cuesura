import { describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import { confirmTask, type ConfirmDeps } from '../../../src/application/confirm.ts';
import { startTask, type StartDeps } from '../../../src/application/start.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { selectionDigest } from '../../../src/domain/run-config.ts';
import { buildTask, ownerAuthz, uuidOf } from '../../support/builders.ts';
import { proposeAndConfirm } from '../../support/runtime.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import {
  configuredSelection,
  CUSR,
  fakeGit,
  fakeGitHub,
  fakeHost,
  MANIFESTS,
  SHA,
  userConfig,
  type GitOpts,
  type HostOpts,
} from '../../support/preflight-fakes.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import {
  DEFAULT_PR_TEMPLATE_PATH,
  DEFAULT_REVIEW_TEMPLATE_PATH,
} from '../../../src/domain/templates.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-confirm-start-');

const OWNER: Caller = {
  grant: {
    actor: 'owner',
    roles: ['read', 'operate', 'admin'],
  },
};

type Env = {
  host?: HostOpts;
  git?: GitOpts;
  github?: Parameters<typeof fakeGitHub>[0];
};

function setup(env: Env = {}) {
  const path = dbPath(tempDir());
  const d = new StoreDriver(openFileStoreForTest(path));
  const live: Env = { ...env };
  let ids = 5_000;
  const ports = () => ({
    git: fakeGit(live.git),
    github: fakeGitHub(live.github),
    host: fakeHost(live.host),
  });
  const gitCalls: string[][] = [];
  const base = {
    store: d.store,
    configInputs: () =>
      Promise.resolve({
        user: userConfig(),
        packs: PACKS,
        manifests: MANIFESTS,
      }),
    now: () => d.now,
  };
  const confirmDeps = (): ConfirmDeps => {
    const p = ports();
    return {
      ...base,
      ports: {
        ...p,
        git: { run: (c) => (gitCalls.push([...c.args]), p.git.run(c)) },
      },
    };
  };
  const startDeps = (over: Partial<StartDeps> = {}): StartDeps => ({
    ...base,
    ports: ports(),
    docs: {
      prompts: (names) => Promise.resolve(names.map((name) => ({ name, content: `# ${name}\n` }))),
      attachments: () => Promise.resolve([]),
    },
    newId: () => uuidOf(ids++),
    ...over,
  });
  return { d, live, gitCalls, confirmDeps, startDeps, path };
}

function confirmCmd(
  d: StoreDriver,
  task: CanonicalTask,
  n: number,
  over: { expected_version?: number; project?: string } = {},
) {
  return {
    request_id: uuidOf(800 + n),
    project: over.project ?? task.project,
    task_id: task.id,
    expected_version: over.expected_version ?? d.task(task.id).version,
    assigned_ids: Array.from({ length: 8 }, (_, i) => uuidOf(900 + n * 10 + i)),
  };
}

const fromAssistant = (over: Partial<CanonicalTask> = {}) =>
  buildTask({ requested_by: { kind: 'assistant', id: 'bot' }, ...over });

function grant(d: StoreDriver, task: CanonicalTask): string {
  d.must(task.id, { kind: 'request_execution' });
  const g = d.store.grantNext(d.now as EpochMs);
  if (!g.ok || g.value.kind !== 'decided') throw new Error(`grant failed: ${JSON.stringify(g)}`);
  return g.value.request_id;
}

const eventTypes = (d: StoreDriver, task: CanonicalTask) =>
  d.store.readEvents(task.id).map((e) => e.type);

describe('task confirm runs triage, then one preflight candidate (T031, FR-002.02/03)', () => {
  it('confirms, checks config once and leaves the task READY without a snapshot, slot or effect', async () => {
    const { d, confirmDeps } = setup();
    const task = fromAssistant();
    d.must(task.id, { kind: 'create_task', task });
    expect(d.task(task.id)).toMatchObject({
      status: 'PENDING',
      wait: { detail: { code: 'needs_confirmation' } },
    });

    const r = await confirmTask(confirmDeps(), OWNER, confirmCmd(d, task, 1));
    expect(r).toMatchObject({
      ok: true,
      value: { status: 'READY', config_check: 'checked' },
    });
    const s = d.task(task.id);
    expect(s.policy_ref).toBeNull();
    expect(s.execution).toMatchObject({ request: null, holding: null });
    expect(d.pending(task.id)).toEqual([]);
    expect(eventTypes(d, task)).not.toContain('PolicyFrozen');
  });

  it('a failed check keeps PENDING/needs_info with the cause and fix; only a new request retries', async () => {
    const { d, live, confirmDeps } = setup({ host: { userBus: false } });
    const task = fromAssistant();
    d.must(task.id, { kind: 'create_task', task });
    const first = confirmCmd(d, task, 1);
    expect(await confirmTask(confirmDeps(), OWNER, first)).toMatchObject({
      ok: true,
      value: { status: 'PENDING', config_check: 'checked' },
    });
    expect(d.task(task.id).wait).toMatchObject({
      reason: 'needs_info',
      detail: {
        code: 'capability_missing',
        error: {
          code: 'capability_missing',
          problems: [
            {
              cause: 'systemd_user_unavailable',
              runbook: expect.stringContaining('deploy/README.md') as unknown,
            },
          ],
        },
      },
    });
    expect(d.pending(task.id)).toEqual([]);

    // The host is fixed; replaying the first request does not change its recorded result.
    live.host = {};
    const version = d.task(task.id).version;
    expect(await confirmTask(confirmDeps(), OWNER, first)).toMatchObject({
      ok: true,
      value: { status: 'PENDING', config_check: 'recorded_earlier' },
    });
    expect(d.task(task.id).version).toBe(version);

    // A new request re-reads the base and the host and moves the task to READY.
    expect(await confirmTask(confirmDeps(), OWNER, confirmCmd(d, task, 2))).toMatchObject({
      ok: true,
      value: { status: 'READY', config_check: 'checked' },
    });
  });

  it('a config problem found by a READY task withdraws nothing it did not have and records config_invalid', async () => {
    const { d, confirmDeps } = setup({
      git: { remote: 'https://github.com/evil/app.git' },
    });
    const task = buildTask();
    d.must(task.id, { kind: 'create_task', task });
    expect(d.task(task.id).status).toBe('READY');
    expect(await confirmTask(confirmDeps(), OWNER, confirmCmd(d, task, 1))).toMatchObject({
      ok: true,
      value: {
        status: 'PENDING',
        wait: { detail: { code: 'config_invalid' } },
      },
    });
  });

  it('triage blockers come first: no preflight while acceptance or a dependency is missing', async () => {
    const { d, gitCalls, confirmDeps } = setup();
    const noAcceptance = fromAssistant({
      id: uuidOf(1),
      source_key: 'cli:a',
      acceptance: [],
    });
    d.must(noAcceptance.id, { kind: 'create_task', task: noAcceptance });
    expect(await confirmTask(confirmDeps(), OWNER, confirmCmd(d, noAcceptance, 1))).toMatchObject({
      ok: true,
      value: {
        status: 'PENDING',
        wait: { detail: { code: 'missing_acceptance' } },
        config_check: 'skipped',
      },
    });

    const dep = buildTask({ id: uuidOf(2), source_key: 'cli:dep' });
    d.must(dep.id, { kind: 'create_task', task: dep });
    const child = fromAssistant({
      id: uuidOf(3),
      source_key: 'cli:child',
      depends_on: [dep.id],
    });
    d.must(child.id, { kind: 'create_task', task: child });
    expect(await confirmTask(confirmDeps(), OWNER, confirmCmd(d, child, 2))).toMatchObject({
      ok: true,
      value: {
        status: 'PENDING',
        wait: { detail: { code: 'dependency_pending' } },
        config_check: 'skipped',
      },
    });
    expect(gitCalls).toEqual([]);
  });

  it('an infrastructure failure records no candidate', async () => {
    const { d, confirmDeps } = setup({ github: 'unknown' });
    const task = fromAssistant();
    d.must(task.id, { kind: 'create_task', task });
    const r = await confirmTask(confirmDeps(), OWNER, confirmCmd(d, task, 1));
    expect(r).toMatchObject({
      ok: true,
      value: {
        status: 'READY',
        config_check: 'unavailable',
        unavailable: { check: 'github_repo' },
      },
    });
    expect(eventTypes(d, task)).toEqual([
      'TaskCreated',
      'TaskPending',
      'TaskConfirmed',
      'TaskReady',
    ]);
  });

  it('checks the command against the task project and the expected version', async () => {
    const { d, confirmDeps } = setup();
    const task = fromAssistant();
    d.must(task.id, { kind: 'create_task', task });
    expect(
      await confirmTask(confirmDeps(), OWNER, confirmCmd(d, task, 2, { project: 'elsewhere' })),
    ).toMatchObject({
      ok: false,
      error: { code: 'forbidden', reason: 'project' },
    });
    expect(
      await confirmTask(confirmDeps(), OWNER, confirmCmd(d, task, 3, { expected_version: 99 })),
    ).toMatchObject({
      ok: false,
      error: { code: 'conflict', reason: 'stale_version' },
    });
    expect(d.task(task.id).status).toBe('PENDING');
  });
});

describe('start freezes one snapshot under the slot before RUNNING (T032, FR-002.01)', () => {
  it('re-runs preflight and commits RuntimeConfigured with PolicyFrozen, then the worktree effect', async () => {
    const { d, startDeps } = setup();
    const task = buildTask();
    d.must(task.id, { kind: 'create_task', task });
    proposeAndConfirm(d, task, await configuredSelection(task, 'full-review'));
    grant(d, task);

    const r = await startTask(startDeps(), task.id);
    expect(r).toMatchObject({ kind: 'submitted', frozen: true });
    const s = d.task(task.id);
    expect(s.status).toBe('RUNNING');
    const configured = d.store.readEvents(task.id).find((e) => e.type === 'RuntimeConfigured');
    expect(configured?.payload).toMatchObject({
      runtime: {
        base_sha: SHA,
        revision: 1,
        target: {
          repo: 'acme/app',
          immutable_repo_id: '4242',
          base_ref: 'main',
        },
      },
    });
    expect(s.runtime_ref).toMatchObject({ revision: 1 });
    expect(configured?.payload).toMatchObject({
      runtime: {
        run_config: {
          mode: 'full-review',
          digest: s.run.proposal?.digest,
          confirmation: { actor: 'owner', channel: 'token:owner' },
        },
        pr_template: { path: DEFAULT_PR_TEMPLATE_PATH },
        review_template: { path: DEFAULT_REVIEW_TEMPLATE_PATH },
      },
    });
    expect(d.store.readPolicy(task.id, 1)?.workflow_name).toBe('software_dev@2:full-review');
    expect(s.run.mode).toBe('full-review');
    const types = eventTypes(d, task);
    expect(types.indexOf('RuntimeConfigured')).toBeLessThan(types.indexOf('PolicyFrozen'));
    expect(d.store.readPolicy(task.id, 1)?.base_sha).toBe(SHA);
    expect(d.pending(task.id, 'prepare')).toHaveLength(1);

    // A second start finds the snapshot and freezes nothing again.
    expect(await startTask(startDeps(), task.id)).toEqual({
      kind: 'not_startable',
      reason: 'already_started',
    });
    expect(eventTypes(d, task).filter((t) => t === 'PolicyFrozen')).toHaveLength(1);
  });

  it('does not start without the slot', async () => {
    const { d, startDeps } = setup();
    const task = buildTask();
    d.must(task.id, { kind: 'create_task', task });
    expect(await startTask(startDeps(), task.id)).toEqual({
      kind: 'not_startable',
      reason: 'slot_not_held',
    });
  });

  it('a failed preflight at start leaves PENDING/needs_info, no snapshot, and returns the slot', async () => {
    const { d, startDeps } = setup({ host: { userBus: false } });
    const task = buildTask();
    d.must(task.id, { kind: 'create_task', task });
    proposeAndConfirm(d, task, await configuredSelection(task, 'full-review'));
    grant(d, task);
    expect(await startTask(startDeps(), task.id)).toMatchObject({
      kind: 'submitted',
      frozen: false,
    });
    const s = d.task(task.id);
    expect(s).toMatchObject({
      status: 'PENDING',
      policy_ref: null,
      runtime_ref: null,
      wait: { reason: 'needs_info', detail: { code: 'capability_missing' } },
    });
    expect(s.execution.holding).toBeNull();
    expect(d.store.readSlots()).toEqual([]);
    expect(d.pending(task.id)).toEqual([]);
  });

  it('an infrastructure failure at start returns the slot and keeps the task READY', async () => {
    const { d, startDeps } = setup({
      git: { fetch: { code: 128, stderr: 'fatal: unable to access' } },
    });
    const task = buildTask();
    d.must(task.id, { kind: 'create_task', task });
    proposeAndConfirm(d, task, await configuredSelection(task, 'full-review'));
    grant(d, task);
    expect(await startTask(startDeps(), task.id)).toMatchObject({
      kind: 'unavailable',
      check: 'base',
    });
    expect(d.task(task.id)).toMatchObject({
      status: 'READY',
      policy_ref: null,
    });
    expect(d.store.readSlots()).toEqual([]);
  });

  it('a task changed during preflight is a conflict and keeps no snapshot', async () => {
    const { d, startDeps } = setup();
    const task = buildTask();
    d.must(task.id, { kind: 'create_task', task });
    proposeAndConfirm(d, task, await configuredSelection(task, 'full-review'));
    grant(d, task);
    const deps = startDeps({
      configInputs: () => {
        // The source revises the task while preflight is in flight; the start then carries a stale version.
        d.must(task.id, {
          kind: 'source_updated',
          task: { ...task, description: 'Changed while starting.' },
        });
        return Promise.resolve({
          user: userConfig(),
          packs: PACKS,
          manifests: MANIFESTS,
        });
      },
    });
    const r = await startTask(deps, task.id);
    expect(r).toMatchObject({
      kind: 'conflict',
      error: { code: 'conflict', reason: 'stale_version' },
    });
    expect(d.task(task.id).policy_ref).toBeNull();
  });

  it('nothing starts on an unconfirmed, stale or mismatched selection (T135, M01/M02)', async () => {
    const { d, startDeps } = setup();
    const task = buildTask();
    d.must(task.id, { kind: 'create_task', task });
    const sel = await configuredSelection(task, 'full-review');
    d.must(task.id, { kind: 'propose_run_config', selection: sel });
    grant(d, task);
    // Proposed but not confirmed: the slot goes back, nothing is frozen.
    expect(await startTask(startDeps(), task.id)).toEqual({
      kind: 'not_startable',
      reason: 'run_config_unconfirmed',
    });
    expect(d.store.readSlots()).toEqual([]);
    expect(d.task(task.id).policy_ref).toBeNull();

    // Confirmed, then a different selection is proposed: the old confirmation no longer covers it.
    d.must(
      task.id,
      { kind: 'confirm_run_config', digest: selectionDigest(sel) },
      { authz: ownerAuthz() },
    );
    d.must(task.id, {
      kind: 'propose_run_config',
      selection: { ...sel, reason: 'changed' },
    });
    grant(d, task);
    expect(await startTask(startDeps(), task.id)).toEqual({
      kind: 'not_startable',
      reason: 'run_config_unconfirmed',
    });

    // Confirmed, but the bindings differ from what the config resolves to: wait for a new confirmation.
    const wrong = {
      ...sel,
      worker: {
        ...sel.worker,
        effort: sel.worker.effort === 'high' ? ('low' as const) : ('high' as const),
      },
    };
    proposeAndConfirm(d, task, wrong);
    grant(d, task);
    expect(await startTask(startDeps(), task.id)).toMatchObject({
      kind: 'submitted',
      frozen: false,
    });
    expect(d.task(task.id)).toMatchObject({
      status: 'PENDING',
      policy_ref: null,
      wait: {
        reason: 'needs_info',
        detail: { code: 'run_config_unconfirmed' },
      },
    });
  });

  it('direct-pr freezes a graph without review and needs no reviewer capability (M01/M03)', async () => {
    const { d, startDeps } = setup();
    const task = buildTask();
    d.must(task.id, { kind: 'create_task', task });
    proposeAndConfirm(d, task, await configuredSelection(task, 'direct-pr'));
    grant(d, task);
    const deps = startDeps({
      configInputs: () =>
        Promise.resolve({
          user: userConfig(),
          packs: PACKS,
          manifests: { claude: MANIFESTS.claude, codex: null },
        }),
    });
    expect(await startTask(deps, task.id)).toMatchObject({
      kind: 'submitted',
      frozen: true,
    });
    const policy = d.store.readPolicy(task.id, 1);
    expect(policy?.workflow_name).toBe('software_dev@2:direct-pr');
    expect(Object.values(policy?.workflow.steps ?? {}).some((st) => st.kind === 'review')).toBe(
      false,
    );
    expect(Object.values(policy?.steps ?? {}).map((st) => st.role)).not.toContain('reviewer');
    expect(policy?.workflow.steps['gates']?.next['pass']).toBe('publish');
    expect(d.task(task.id).run.mode).toBe('direct-pr');
  });

  it('freezes which prompt each role uses, and runs the confirmed binding among those a role declares', async () => {
    const { d, startDeps } = setup();
    // The first rule that matches an L task is opus; the user confirmed the other one.
    const task = buildTask({ size: 'L', profile: 'heavy' });
    d.must(task.id, { kind: 'create_task', task });
    const sel = await configuredSelection(task, 'direct-pr');
    expect(sel.worker.model).toBe('opus');
    proposeAndConfirm(d, task, {
      ...sel,
      worker: { harness: 'claude', model: 'sonnet', effort: 'medium' },
    });
    grant(d, task);
    expect(await startTask(startDeps(), task.id)).toMatchObject({
      kind: 'submitted',
      frozen: true,
    });
    const policy = d.store.readPolicy(task.id, 1);
    expect(policy?.steps['code']?.binding.model).toBe('sonnet');
    // Read from the project config at the frozen base.
    expect(d.store.readRuntimeContext(task.id, 1)?.setup_commands).toEqual(['npm ci']);
    expect(d.store.readRuntimeContext(task.id, 1)?.role_prompts).toMatchObject({
      coder: 'prompts/coder.md',
      fixer: 'prompts/fixer.md',
    });
  });

  it('refuses a role prompt that could never fit, before anything is frozen and while the file can still be fixed', async () => {
    const { d, startDeps } = setup();
    const task = buildTask();
    d.must(task.id, { kind: 'create_task', task });
    proposeAndConfirm(d, task, await configuredSelection(task, 'direct-pr'));
    grant(d, task);
    const docs = {
      prompts: (names: readonly string[]) =>
        Promise.resolve(names.map((name) => ({ name, content: 'x'.repeat(200 * 1024) }))),
      attachments: () => Promise.resolve([]),
    };
    await startTask(startDeps({ docs }), task.id);
    expect(d.store.readPolicy(task.id, 1)).toBeNull();
    expect(d.store.readRuntimeContext(task.id, 1)).toBeNull();
    const s = d.task(task.id);
    expect(s.wait?.detail).toMatchObject({ code: 'config_invalid' });
    expect(JSON.stringify(s.wait?.detail)).toContain('limits.context_bytes');
  });

  it('freezes merge.method from the base: squash by default, the override when declared; invalid config waits (SPEC §14.2)', async () => {
    const started = async (cusr: string | undefined) => {
      const env = setup(cusr === undefined ? {} : { git: { cusr } });
      const task = buildTask();
      env.d.must(task.id, { kind: 'create_task', task });
      proposeAndConfirm(env.d, task, await configuredSelection(task, 'direct-pr'));
      grant(env.d, task);
      const r = await startTask(env.startDeps(), task.id);
      return {
        r,
        rt: env.d.store.readRuntimeContext(task.id, 1),
        s: env.d.task(task.id),
      };
    };
    const plain = await started(undefined);
    expect(plain.r).toMatchObject({ kind: 'submitted', frozen: true });
    expect(plain.rt?.merge_method).toBe('squash');
    const rebase = await started(`${CUSR}merge: { method: rebase }\n`);
    expect(rebase.rt?.merge_method).toBe('rebase');
    // Nothing about the method is an admission check: the policy is the same for every method.
    expect(rebase.rt?.runtime_hash).not.toBe(plain.rt?.runtime_hash);
    const bad = await started(`${CUSR}merge: { method: fast_forward }\n`);
    expect(bad.r).toMatchObject({ kind: 'submitted', frozen: false });
    expect(bad.rt).toBeNull();
    expect(bad.s).toMatchObject({
      status: 'PENDING',
      wait: { detail: { code: 'config_invalid' } },
    });
  });

  it.each(['squash', 'merge', 'rebase'] as const)(
    'T139 M02: %s survives config change and SQLite reopen, even when squash is disabled on GitHub',
    async (method) => {
      const f = setup({
        git: { cusr: `${CUSR}merge: { method: ${method} }\n` },
      });
      const task = buildTask();
      f.d.must(task.id, { kind: 'create_task', task });
      proposeAndConfirm(f.d, task, await configuredSelection(task, 'direct-pr'));
      grant(f.d, task);
      const deps = f.startDeps();
      const github = deps.ports.github;
      const start = {
        ...deps,
        ports: {
          ...deps.ports,
          github: {
            request: async (req: Parameters<typeof github.request>[0]) => {
              const r = await github.request(req);
              return r.ok
                ? {
                    ...r,
                    value: {
                      ...r.value,
                      body: {
                        ...(r.value.body as object),
                        allow_squash_merge: false,
                      },
                    },
                  }
                : r;
            },
          },
        },
      };
      expect(await startTask(start, task.id)).toMatchObject({
        kind: 'submitted',
        frozen: true,
      });
      const before = f.d.store.readRuntimeContext(task.id, 1);
      expect(before?.merge_method).toBe(method);
      f.live.git = {
        cusr: `${CUSR}merge: { method: ${method === 'merge' ? 'squash' : 'merge'} }\n`,
      };
      f.d.store.close();
      const reopened = openFileStoreForTest(f.path);
      try {
        expect(reopened.readRuntimeContext(task.id, 1)).toEqual(before);
        expect(await startTask({ ...f.startDeps(), store: reopened }, task.id)).toEqual({
          kind: 'not_startable',
          reason: 'already_started',
        });
        expect(reopened.readRuntimeContext(task.id, 1)).toEqual(before);
        expect(reopened.verifyProjections().ok).toBe(true);
      } finally {
        reopened.close();
      }
    },
  );

  it('freezes the one PR template of the base; several without a choice wait (M05)', async () => {
    const one = setup({
      git: {
        templates: {
          '.github/pull_request_template.md': '## Summary\n## Tests\n',
        },
      },
    });
    const task = buildTask();
    one.d.must(task.id, { kind: 'create_task', task });
    proposeAndConfirm(one.d, task, await configuredSelection(task, 'direct-pr'));
    grant(one.d, task);
    expect(await startTask(one.startDeps(), task.id)).toMatchObject({
      kind: 'submitted',
      frozen: true,
    });
    const rt = one.d.store.readRuntimeContext(task.id, 1);
    expect(rt?.pr_template).toMatchObject({
      path: '.github/pull_request_template.md',
      content: '## Summary\n## Tests\n',
    });

    const many = setup({
      git: {
        templates: {
          '.github/PULL_REQUEST_TEMPLATE/a.md': 'a',
          '.github/PULL_REQUEST_TEMPLATE/b.md': 'b',
        },
      },
    });
    many.d.must(task.id, { kind: 'create_task', task });
    proposeAndConfirm(many.d, task, await configuredSelection(task, 'direct-pr'));
    grant(many.d, task);
    expect(await startTask(many.startDeps(), task.id)).toMatchObject({
      kind: 'submitted',
      frozen: false,
    });
    expect(many.d.task(task.id)).toMatchObject({
      status: 'PENDING',
      wait: {
        detail: {
          code: 'config_invalid',
          error: { problems: [{ check: 'pr_template' }] },
        },
      },
    });
  });
  it('T139 M05: an explicit choice among multiple templates freezes that exact base blob', async () => {
    const chosen = '.github/PULL_REQUEST_TEMPLATE/detail.md';
    const f = setup({
      git: {
        cusr: `${CUSR}pr_template: ${chosen}\n`,
        templates: {
          '.github/PULL_REQUEST_TEMPLATE/short.md': '# Short\n',
          [chosen]: '# Detail\nKeep acceptance and tests.\n',
        },
      },
    });
    const task = buildTask();
    f.d.must(task.id, { kind: 'create_task', task });
    proposeAndConfirm(f.d, task, await configuredSelection(task, 'direct-pr'));
    grant(f.d, task);
    expect(await startTask(f.startDeps(), task.id)).toMatchObject({
      kind: 'submitted',
      frozen: true,
    });
    expect(f.d.store.readRuntimeContext(task.id, 1)?.pr_template).toMatchObject({
      path: chosen,
      content: '# Detail\nKeep acceptance and tests.\n',
    });
  });
});
