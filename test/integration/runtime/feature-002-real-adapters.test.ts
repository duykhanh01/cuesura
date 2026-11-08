/**
 * T071/T077/T138 the daemon flow with the real adapters (no model, no systemd, no bwrap): RunnerHarness
 * for Claude (worker) and Codex (reviewer) over the real runner lifecycle, a stand-in binary replaying
 * the T007 runs, real Git worktree/commit/push to a bare remote, fake GitHub. The worker writes its
 * commit/PR content inside its own scratch and it is copied out; the reviewer reads the fixed
 * checkpoint; each attempt's manifest is the one confirmed with the task; reservations are consumed
 * only for runs that happened. This is fixture replay, not an end-to-end smoke with real vendors.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HostExecutionProvider, probeLayoutShapes } from '../../../src/runner/sandbox.ts';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../../src/adapters/harness/claude.ts';
import { codexAdapter } from '../../../src/adapters/harness/codex.ts';
import { hostInnerMode, type VendorPin } from '../../../src/adapters/harness/vendor.ts';
import type { SandboxProvider } from '../../../src/adapters/ports.ts';
import { Dispatcher } from '../../../src/daemon/dispatch.ts';
import { planRetention, taskRunEntries } from '../../../src/daemon/retention.ts';
import { buildHandlers, type HandlerDeps } from '../../../src/daemon/handlers.ts';
import type { CapabilityManifest } from '../../../src/domain/runtime.ts';
import type { ExecutionMode } from '../../../src/domain/run-config.ts';
import { SpawnExecutor } from '../../../src/runner/commands.ts';
import { RUN_FILES, RunDir } from '../../../src/runner/files.ts';
import { attemptLayoutInputs, RunnerHarness } from '../../../src/runner/invocation.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs, Hash } from '../../../src/shared/brand.ts';
import { hashCanonical, hashText } from '../../../src/shared/hash.ts';
import { ok } from '../../../src/shared/result.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, freezeOk, uuidOf } from '../../support/builders.ts';
import { FakeGitHub } from '../../support/fake-github.ts';
import { gitSandbox } from '../../support/git-repo.ts';
import { homeFileContent, REAL } from '../../support/harness-fixtures.ts';
import {
  evidenceManifest,
  fakeVendorPin,
  HOST_POLICY_HASH,
  InlineProcessPort,
  PassThroughSandbox,
  tempDir,
} from '../../support/runner-harness.ts';
import { confirmedRuntime, proposeAndConfirm, selectionFor } from '../../support/runtime.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const g = gitSandbox('cusr-real-adapters-');
afterAll(() => g.cleanup());
const tempDb = useTempDir('cusr-real-adapters-db-');
const dirs: string[] = [];
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 50));
  const { rmSync } = await import('node:fs');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Gates run `/bin/sh -c` directly here; these tests assert gate results and checkpoint ownership. */
const gateSandbox: SandboxProvider = {
  provider: 'bwrap',
  plan: (layout, command) =>
    ok({
      isolation_mode: 'isolated',
      provider: 'bwrap',
      role: layout.role,
      argv: [...command],
      cwd: layout.worktree,
      env: { PATH: '/usr/bin:/bin' },
      network: 'internet_outbound',
      mount_sources: [],
      layout_digest: hashText(layout.role),
      layout_shape: hashText(layout.role),
      proof_refs: [],
    }),
};

let n = 0;

function setup(o: {
  mode: ExecutionMode;
  sameVendor?: boolean;
  hostExecution?: boolean;
  reviewerWrites?: boolean;
  confirmed?: (m: Record<string, CapabilityManifest>) => Record<string, Hash>;
}) {
  const project = g.repo(`real${n++}`);
  const base = g.sh(project, 'rev-parse', 'HEAD');
  const remote = `${project}.remote.git`;
  g.sh(g.base, 'clone', '-q', '--bare', project, remote);
  const data = `${project}.data`;
  const d = new StoreDriver(openFileStoreForTest(dbPath(tempDb())));
  d.now = Date.now();
  const github = new FakeGitHub();
  github.headOf = (branch) => {
    try {
      const sha = g.sh(remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
      if (!github.checks.has(sha)) github.checks.set(sha, { build: 'success', test: 'success' });
      return sha;
    } catch {
      return null;
    }
  };
  const paths = {
    worktrees: join(data, 'worktrees'),
    markers: join(data, 'owners'),
    intents: join(data, 'intents'),
    scratch: join(data, 'scratch'),
    content: join(data, 'content'),
    receipts: join(data, 'receipts'),
  };
  const bin = tempDir('cusr-real-bin-', dirs);
  const credDir = join(bin, 'cred');
  mkdirSync(credDir);
  const replay = join(bin, 'replay');
  cpSync(join(REAL, 's0-claude-coder-1793172185'), join(replay, 'worker'), {
    recursive: true,
  });
  cpSync(join(REAL, 's0-claude-reviewer-1793180331'), join(replay, 'reviewer'), {
    recursive: true,
  });
  const pins: Record<'claude' | 'codex', VendorPin> = {
    claude: fakeVendorPin('claude', bin, {
      FAKE_VENDOR_REPLAY: join(replay, 'worker'),
      ...(o.sameVendor === true ? { FAKE_VENDOR_REVIEWER_REPLAY: join(replay, 'reviewer') } : {}),
      ...(o.reviewerWrites === true ? { FAKE_VENDOR_REVIEWER_WRITE: '1' } : {}),
      FAKE_VENDOR_MODE: 'publish,write_worktree',
      FAKE_VENDOR_ECHO_MODEL: '1',
    }),
    codex: fakeVendorPin('codex', bin, {
      FAKE_VENDOR_REPLAY: join(REAL, 's0-codex-reviewer-1793180367'),
    }),
  };
  const credentials: Record<string, { name: string; file: string }> = {};
  for (const pin of Object.values(pins))
    for (const h of pin.home_files) {
      const file = join(credDir, `${h.credential}.json`);
      writeFileSync(
        file,
        homeFileContent(
          h,
          JSON.stringify({
            accessToken: `sk-ant-canary-${h.credential}-0123456789`,
          }),
        ),
      );
      credentials[h.credential] = { name: h.credential, file };
    }
  const sandbox = o.hostExecution === true ? new HostExecutionProvider() : new PassThroughSandbox();
  const manifest = (pin: VendorPin): CapabilityManifest => {
    if (o.hostExecution !== true) return evidenceManifest(pin);
    const shapes = probeLayoutShapes(sandbox, {
      roles: ['coder', 'fixer', 'reviewer'],
      ...attemptLayoutInputs(pin, 'probe'),
    });
    if (!shapes.ok) throw new Error(shapes.error.message);
    const inner = hostInnerMode(pin);
    return evidenceManifest(
      pin,
      {
        isolation_mode: 'native',
        selected_inner_mode: inner === 'native' ? 'internal_required' : inner,
      },
      shapes.value,
    );
  };
  const manifests = {
    claude: manifest(pins.claude),
    codex: manifest(pins.codex),
  };
  const proc = new InlineProcessPort(join(data, 'runtime'));
  const real = (vendor: 'claude' | 'codex'): RunnerHarness =>
    new RunnerHarness({
      harness: vendor,
      adapter: vendor === 'claude' ? claudeAdapter : codexAdapter,
      pin: pins[vendor],
      manifest: manifests[vendor],
      isolation: 'internal_required',
      process: proc,
      sandbox,
      host_policy_hash: HOST_POLICY_HASH,
      data_dir: join(data, 'runtime'),
      credentials,
      redactor: new Redactor(),
      clock: {
        now: () => Date.now() as EpochMs,
        monotonic: () => performance.now(),
      },
      limits: { term_grace_ms: 300, kill_verify_ms: 1_000, stall_ms: null },
      poll_ms: 20,
    });
  let ids = 30_000;
  const clock = { now: () => d.now as EpochMs, monotonic: () => d.now };
  const newId = (): string => uuidOf(ids++);
  let dispatcher: Dispatcher | null = null;
  const deps: HandlerDeps = {
    dataDir: join(data, 'runtime'),
    store: d.store,
    git: g.runner(),
    github: () => github,
    harnesses: { claude: real('claude'), codex: real('codex') },
    sandbox: gateSandbox,
    executor: new SpawnExecutor(),
    clock,
    redactor: new Redactor(),
    newId,
    paths,
    committer: { name: 'Cuesura', email: 'cusr@invalid' },
    remoteUrl: () => remote,
    abort: (id) => dispatcher?.abort(id) ?? false,
  };
  dispatcher = new Dispatcher({
    store: d.store,
    clock,
    handlers: buildHandlers(deps),
    newId,
  });
  const task = buildTask();

  const start = (): void => {
    d.must(task.id, { kind: 'create_task', task });
    const frozen = freezeOk(task, {
      base_sha: base,
      gates: { build: 'true', unit: 'true', lint: 'true', format_fix: 'true' },
      required_checks: ['build', 'test'],
      limits: { max_wall_ms: 3_600_000 },
      mode: o.mode,
      ...(o.sameVendor === true
        ? {
            roles: {
              reviewer: {
                model: 'sonnet',
                effort: 'medium',
                permissions: 'read_only',
                ladder: [],
              },
            },
          }
        : {}),
    });
    proposeAndConfirm(d, task, selectionFor(task, o.mode, frozen.value.policy));
    d.must(task.id, { kind: 'request_execution' });
    const granted = d.store.grantNext(d.now as EpochMs, [newId()]);
    if (!granted.ok || granted.value.kind !== 'decided') throw new Error(JSON.stringify(granted));
    const runtime = confirmedRuntime(d, task, {
      base_sha: base,
      project_path: project,
      target: {
        provider: 'github',
        repo: 'acme/app',
        immutable_repo_id: '4242',
        base_ref: 'main',
      },
      pr_template: null,
      capability_refs: o.confirmed?.(manifests) ?? {
        claude: manifests.claude.manifest_hash,
        codex: manifests.codex.manifest_hash,
      },
    });
    d.must(task.id, { kind: 'start', freeze: frozen, runtime });
  };
  // Like cusrd, a free slot goes to the task when it queued for one again (full-review after its PR).
  const settle = async (max = 40): Promise<void> => {
    for (let i = 0; i < max; i++) {
      const queued =
        d.task(task.id).wait?.detail.code === 'execution_slot' && d.store.readSlots().length === 0;
      if (queued) d.store.grantNext(d.now as EpochMs, [newId(), newId(), newId(), newId()]);
      const r = dispatcher.tick();
      await dispatcher.settle();
      d.now = Math.max(d.now + 1_000, Date.now());
      if (r.started.length === 0 && !queued) return;
    }
    throw new Error('flow did not settle');
  };
  const grant = () => {
    const r = d.store.grantNext(d.now as EpochMs, [newId(), newId(), newId(), newId()]);
    return r.ok ? r.value.kind : r.error;
  };
  return {
    d,
    task,
    grant,
    github,
    remote,
    proc,
    start,
    settle,
    data,
    worktree: join(paths.worktrees, task.id),
  };
}

const types = (f: ReturnType<typeof setup>): string[] =>
  f.d.store.readEvents(f.task.id).map((e) => e.type);

describe.each(['full-review', 'direct-pr'] as const)(
  'daemon flow with the real adapters in %s',
  (mode) => {
    it('worker and reviewer run through RunnerHarness to one green PR with the worker content', async () => {
      const f = setup({ mode });
      f.start();
      await f.settle();
      const s = f.d.task(f.task.id);
      expect(s.wait).toMatchObject({
        reason: 'approval',
        detail: { code: 'merge' },
      });
      // The worker's edit is in the checkpoint commit the PR carries.
      const cp = s.run.checkpoint;
      expect(cp).not.toBeNull();
      expect(g.sh(f.worktree, 'show', '--name-only', '--format=', cp?.sha ?? '')).toContain(
        'agent-wrote.txt',
      );
      expect(
        g.sh(
          f.remote,
          'rev-parse',
          `refs/heads/${g.sh(f.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')}`,
        ),
      ).toBe(cp?.sha);
      expect(f.github.prs).toHaveLength(1);
      expect(f.github.prs[0]).toMatchObject({ title: 'Fix add' });
      // Coder and, in full-review, the reviewer: one launch each, each with a finalized result.
      const roles = f.proc.launches.map((l) => l.run_id);
      expect(roles).toHaveLength(mode === 'full-review' ? 2 : 1);
      for (const id of roles) {
        const run = RunDir.open({
          dataDir: join(f.data, 'runtime'),
          kind: 'runs',
          id,
          redactor: new Redactor(),
          create: false,
        });
        expect(run.readFinal(RUN_FILES.result).state).toBe('valid');
        const files = readdirSync(join(run.dir, 'private-home'), {
          recursive: true,
        }).map(String);
        expect(files.filter((p) => p.endsWith('.json'))).toEqual([]);
      }
      const ev = types(f);
      expect(ev.filter((t) => t === 'BudgetConsumed')).toHaveLength(roles.length);
      expect(ev).not.toContain('BudgetReleased');
      // Records and files of each run were committed with its result: that commit is their ACK.
      expect(ev.filter((t) => t === 'OutputIngested')).toHaveLength(roles.length);
      expect(Object.values(s.artifacts).map((a) => a.kind)).toEqual(
        expect.arrayContaining(['events', 'exit', 'result']),
      );
      // Retention: kept while the task runs; once terminal and old enough, every run may go.
      const entries = taskRunEntries(s, {
        dataDir: join(f.data, 'runtime'),
        redactor: new Redactor(),
        terminal: false,
      }).filter((r) => r.kind === 'runs');
      expect(entries).toHaveLength(roles.length);
      const month = 31 * 24 * 3_600_000;
      expect(
        planRetention({
          runs: entries,
          worktrees: [],
          now: Date.now() + month,
          retention_ms: month - 1,
        }).keep_runs.map((k) => k.reason),
      ).toEqual(entries.map(() => 'task_not_terminal'));
      expect(
        planRetention({
          runs: entries.map((r) => ({ ...r, task_terminal: true })),
          worktrees: [],
          now: Date.now() + month,
          retention_ms: month - 1,
        }).delete_runs,
      ).toHaveLength(roles.length);
      if (mode === 'full-review') expect(ev).toContain('ReviewVerdictRecorded');
      else expect(ev).not.toContain('ReviewVerdictRecorded');
    });
  },
);

describe('the confirmed manifest is the one in force (T070/T071)', () => {
  it('a manifest changed since confirmation that still meets the frozen requirements is recorded and the step runs on it (#249)', async () => {
    const f = setup({
      mode: 'direct-pr',
      confirmed: (m) => ({
        claude: hashCanonical('another proof'),
        codex: (m.codex as CapabilityManifest).manifest_hash,
      }),
    });
    f.start();
    await f.settle();
    const accepted = f.d.store
      .readEvents(f.task.id)
      .find((e) => e.type === 'ManifestChangeAccepted');
    expect(accepted?.payload).toMatchObject({
      harness: 'claude',
      previous: hashCanonical('another proof'),
    });
    // The first try launched nothing and gave its reservation back; the next one ran on the new manifest.
    expect(types(f)).toContain('BudgetReleased');
    expect(f.proc.launches.length).toBeGreaterThan(0);
    expect(f.d.task(f.task.id).wait?.detail.code).toBe('merge');
  });
});

describe('T139 M03 same vendor/model through the host launcher', () => {
  it('one confirmed harness serves worker and reviewer with separate homes/sessions, one PR', async () => {
    const f = setup({
      mode: 'full-review',
      sameVendor: true,
      hostExecution: true,
    });
    f.start();
    await f.settle();
    const state = f.d.task(f.task.id);
    expect(state.wait?.detail.code, JSON.stringify(state.wait)).toBe('merge');
    expect(f.proc.launches).toHaveLength(2);
    const [worker, reviewer] = f.proc.launches;
    expect(worker?.argv[0]).toBe(reviewer?.argv[0]);
    expect(worker?.argv).not.toContain('--bind');
    expect(worker?.argv).not.toContain('--no-session-persistence');
    expect(reviewer?.argv).not.toContain('--no-session-persistence');
    expect(reviewer?.argv.join(' ')).not.toMatch(/Edit|Write/);
    expect(reviewer?.argv).not.toContain('--resume');
    expect(worker?.run_id).not.toBe(reviewer?.run_id);
    const attempts = Object.values(state.attempts);
    expect(new Set(attempts.map((a) => a.binding)).size).toBe(1);
    const results = f.proc.launches.map((l) =>
      RunDir.open({
        dataDir: join(f.data, 'runtime'),
        kind: 'runs',
        id: l.run_id,
        redactor: new Redactor(),
        create: false,
      }).readFinal(RUN_FILES.result),
    );
    expect(results.every((r) => r.state === 'valid')).toBe(true);
    expect(f.github.prs).toHaveLength(1);
    expect(state.run.reviews).toMatchObject([
      { verdict: 'approve', sha: state.run.checkpoint?.sha },
    ]);
    expect(f.d.store.verifyProjections().ok).toBe(true);
  });

  it('a same-vendor reviewer may write; what it wrote is put back and never reaches the PR', async () => {
    const f = setup({
      mode: 'full-review',
      sameVendor: true,
      hostExecution: true,
      reviewerWrites: true,
    });
    f.start();
    await f.settle();
    const state = f.d.task(f.task.id);
    expect(state.wait?.detail.code, JSON.stringify(state.wait)).toBe('merge');
    expect(f.proc.launches).toHaveLength(2);
    expect(existsSync(join(f.worktree, 'reviewer-wrote.txt'))).toBe(false);
    expect(existsSync(join(f.worktree, 'agent-wrote.txt'))).toBe(true);
    expect(state.run.reviews).toMatchObject([{ verdict: 'approve' }]);
    expect(f.github.prs).toHaveLength(1);
  });
});
