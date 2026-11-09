import { describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import { confirmTask, type ConfirmDeps } from '../../../src/application/confirm.ts';
import {
  PENDING_PREFLIGHT_BACKOFF,
  PendingPreflight,
} from '../../../src/daemon/pending-preflight.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import {
  fakeGit,
  fakeGitHub,
  fakeHost,
  MANIFESTS,
  userConfig,
  type GitOpts,
  type HostOpts,
} from '../../support/preflight-fakes.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-pending-preflight-');

const OWNER: Caller = { grant: { actor: 'owner', roles: ['read', 'operate', 'admin'] } };

type Env = { host?: HostOpts; git?: GitOpts; github?: Parameters<typeof fakeGitHub>[0] };

function setup(env: Env = {}) {
  const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
  const live: Env = { ...env };
  const deps: ConfirmDeps = {
    store: d.store,
    // Read on each check, so a test can fix the environment between rounds.
    get ports() {
      return { git: fakeGit(live.git), github: fakeGitHub(live.github), host: fakeHost(live.host) };
    },
    configInputs: () => Promise.resolve({ user: userConfig(), packs: PACKS, manifests: MANIFESTS }),
    now: () => d.now,
  };
  return { d, live, deps, round: new PendingPreflight(deps) };
}

async function confirm(d: StoreDriver, deps: ConfirmDeps, task: CanonicalTask): Promise<void> {
  d.must(task.id, { kind: 'create_task', task });
  const r = await confirmTask(deps, OWNER, {
    request_id: uuidOf(800),
    project: task.project,
    task_id: task.id,
    expected_version: d.task(task.id).version,
    assigned_ids: Array.from({ length: 8 }, (_, i) => uuidOf(900 + i)),
  });
  expect(r.ok).toBe(true);
}

const fromAssistant = (over: Partial<CanonicalTask> = {}) =>
  buildTask({ requested_by: { kind: 'assistant', id: 'bot' }, ...over });

describe('the daemon preflights PENDING tasks again on causes outside the config (#249)', () => {
  it('a missing host capability is checked on a backoff and the task turns READY once fixed', async () => {
    const { d, live, deps, round } = setup({ host: { userBus: false } });
    const task = fromAssistant();
    await confirm(d, deps, task);
    expect(d.task(task.id).wait?.detail.code).toBe('capability_missing');
    const version = d.task(task.id).version;

    // Still broken: checked, and the same result adds no event.
    expect(await round.round()).toEqual({ checked: [task.id], recorded: [] });
    expect(d.task(task.id).version).toBe(version);

    // Fixed, but the backoff holds the next check.
    live.host = {};
    expect(await round.round()).toEqual({ checked: [], recorded: [] });
    d.now += PENDING_PREFLIGHT_BACKOFF.first_ms;
    expect(await round.round()).toEqual({ checked: [task.id], recorded: [task.id] });
    expect(d.task(task.id).status).toBe('READY');
    expect(await round.round()).toEqual({ checked: [], recorded: [] });
  });

  it('the backoff doubles while the cause stays, up to its cap', async () => {
    const { d, deps, round } = setup({ host: { userBus: false } });
    const task = fromAssistant();
    await confirm(d, deps, task);
    await round.round();
    d.now += PENDING_PREFLIGHT_BACKOFF.first_ms;
    expect((await round.round()).checked).toEqual([task.id]);
    d.now += PENDING_PREFLIGHT_BACKOFF.first_ms;
    expect((await round.round()).checked).toEqual([]);
    d.now += PENDING_PREFLIGHT_BACKOFF.first_ms;
    expect((await round.round()).checked).toEqual([task.id]);
  });

  it('a base that is an unmerged PR branch turns READY once that PR is merged', async () => {
    const base = 'cusr/feature-a';
    const { d, live, deps, round } = setup({
      github: { default_branch: 'main', pulls: [{ number: 139, base: { ref: 'main' } }] },
    });
    const task = fromAssistant({ base_branch: base });
    await confirm(d, deps, task);
    expect(d.task(task.id).wait?.detail).toMatchObject({
      code: 'config_invalid',
      error: { problems: [{ check: 'stacked_base' }] },
    });
    expect(await round.round()).toEqual({ checked: [task.id], recorded: [] });

    live.github = { default_branch: 'main', pulls: [] };
    d.now += PENDING_PREFLIGHT_BACKOFF.first_ms;
    expect((await round.round()).recorded).toEqual([task.id]);
    expect(d.task(task.id).status).toBe('READY');
  });

  it('leaves a real config error to the person', async () => {
    const { d, deps, round } = setup({ git: { remote: 'https://github.com/evil/app.git' } });
    const task = buildTask();
    await confirm(d, deps, task);
    expect(d.task(task.id).wait?.detail.code).toBe('config_invalid');
    expect(await round.round()).toEqual({ checked: [], recorded: [] });
  });
});
