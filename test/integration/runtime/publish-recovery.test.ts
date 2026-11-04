/**
 * Publish recovery across a daemon death (T082, FR-003/004, FR-017/018, FR-041.03). The daemon's own
 * handlers run on a real SQLite file, a real Git worktree and bare remote, and a stateful fake GitHub.
 * The daemon dies right before or after the external effect (ref CAS of the checkpoint commit, push,
 * PR create) and before its receipt is committed; startup recovery then runs on the same file. The
 * operation is lost and its effect unknown, nothing is sent a second time, and the durable evidence
 * (commit intent, remote ref, marker PR) recovers the one logical effect without a second commit, push
 * or PR, or reports the conflict when someone else moved first. 422 and lost answers are probed before
 * any decision. H05: restart while reviewer A's result is on disk but not ingested and drift B is
 * recorded keeps the fact, blocker and A's operation, and never reruns the reviewer or routes publish.
 *
 * After the restart the daemon's own `reconcile` effect (T089/T090) probes what the crash left and
 * settles the effect: the recovered commit, push or PR is recorded once and the flow goes on, a moved
 * remote or a duplicate marker fails for a person, an unreadable GitHub keeps it unknown. Setup and
 * autofix without a safe retry are in `command-recovery.test.ts`; the local remainder after a late push
 * with the drain (T091).
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, describe, expect, it } from 'vitest';
import { FileCommitIntentStore, commitCheckpoint } from '../../../src/adapters/git/commit.ts';
import { probeCommit, probeLocalRemainder } from '../../../src/adapters/git/reconcile.ts';
import { notifyDependents } from '../../../src/application/dependency.ts';
import { drainRound } from '../../../src/daemon/drain.ts';
import { pushBranch } from '../../../src/adapters/git/push.ts';
import { taskBranch } from '../../../src/adapters/git/worktree.ts';
import { createOrRecoverPr, type PrSpec } from '../../../src/adapters/github/publish.ts';
import { FakeHarness } from '../../../src/adapters/harness/fake.ts';
import type {
  GitCommand,
  GitHubFailure,
  GitHubRequest,
  GitHubResponse,
  GitPort,
  GitResult,
  HarnessPort,
  SandboxProvider,
} from '../../../src/adapters/ports.ts';
import { Dispatcher } from '../../../src/daemon/dispatch.ts';
import { buildHandlers, type HandlerDeps } from '../../../src/daemon/handlers.ts';
import { STORE_FILE } from '../../../src/daemon/main.ts';
import { recoverStore, type StartupDeps } from '../../../src/daemon/startup.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { RUN_FILES, RunDir } from '../../../src/runner/files.ts';
import type { PidRecord } from '../../../src/runner/identity.ts';
import type { RunnerExit } from '../../../src/runner/lifecycle.ts';
import {
  CommandJournal,
  SpawnExecutor,
  type CommandExecutor,
} from '../../../src/runner/commands.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { hashText } from '../../../src/shared/hash.ts';
import { err, ok, type Result } from '../../../src/shared/result.ts';
import type { Store } from '../../../src/store/index.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, DEFAULT_CI_RULES, freezeOk, uuidOf } from '../../support/builders.ts';
import { FakeGitHub } from '../../support/fake-github.ts';
import { gitSandbox } from '../../support/git-repo.ts';
import {
  confirmedRuntime,
  createGrantStart,
  proposeAndConfirm,
  selectionFor,
} from '../../support/runtime.ts';
import { agentData, reviewData } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { checkpointGates, currentReviewInput, publishToReview } from '../../support/store-flows.ts';
import { useTempDir } from '../../support/temp-db.ts';

const g = gitSandbox('cusr-publish-recovery-');
afterAll(() => g.cleanup());
const tempDir = useTempDir('cusr-publish-recovery-db-');

const passthrough: SandboxProvider = {
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

const CONTENT = {
  commit_message: 'Add name search\n\nSearch tasks by name.',
  pr_title: 'Add name search',
  pr_body: '## Summary\nSearch by name.',
};

/** Where the daemon dies: right before or right after the matching external call returns. */
type Crash =
  | {
      readonly at: 'before' | 'after';
      readonly git: (args: readonly string[]) => boolean;
    }
  | { readonly at: 'after'; readonly github: (req: GitHubRequest) => boolean }
  /** While the repo command runs: its journal holds `started`, never its receipt. */
  | { readonly at: 'during'; readonly exec: (command: string) => boolean };

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const gitOp = (name: string) => (args: readonly string[]) => args[0] === name;
const postPulls = (req: GitHubRequest) => req.method === 'POST' && req.path.endsWith('/pulls');

let n = 0;

/**
 * One project with its bare remote and GitHub, and the daemon that runs on its store. `crash` arms a
 * kill point; `restart` closes the store the dead daemon left and runs startup recovery on the file.
 */
function world(task: CanonicalTask, o: { required?: string[] } = {}) {
  const project = g.repo(`acme${n++}`);
  const base = g.sh(project, 'rev-parse', 'HEAD');
  const remote = `${project}.remote.git`;
  g.sh(g.base, 'clone', '-q', '--bare', project, remote);
  const data = `${project}.data`;
  const dir = tempDir();
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
  const worktree = join(paths.worktrees, task.id);
  const coder = new FakeHarness(
    {
      coder: [
        {
          kind: 'result',
          value: {
            schema_version: 1,
            status: 'done',
            summary: 'added search',
            questions: [],
            blocker: null,
          },
        },
      ],
    },
    'claude',
  );
  const claude: HarnessPort = {
    harness: 'claude',
    manifest: coder.manifest,
    run: (input, signal) => {
      writeFileSync(join(worktree, 'search.ts'), 'export const search = (q: string) => q;\n');
      const m = /as JSON \{[^}]*\} to (\S+\.json)\./.exec(input.context.text);
      if (m !== null) writeFileSync(m[1] as string, JSON.stringify(CONTENT));
      return coder.run(input, signal);
    },
  };

  /** Every git command any daemon life ran, in order. */
  const gitLedger: string[][] = [];
  let crash: Crash | null = null;
  let dead = false;
  const real = g.runner();
  const git: GitPort = {
    run: async (req: GitCommand): Promise<GitResult> => {
      if (dead) return never();
      const c = crash;
      if (c !== null && 'git' in c && c.at === 'before' && c.git(req.args)) {
        dead = true;
        return never();
      }
      gitLedger.push([...req.args]);
      const r = await real.run(req);
      if (c !== null && 'git' in c && c.at === 'after' && c.git(req.args)) {
        dead = true;
        return never();
      }
      return r;
    },
  };
  /**
   * What the next POST answers after the PR really exists: a 422, or an answer lost with GitHub then
   * unreadable until `failReads(false)`.
   */
  let answer: 'as_is' | '422' | 'lost' = 'as_is';
  let readsFail = false;
  const githubPort = {
    request: async (req: GitHubRequest): Promise<Result<GitHubResponse, GitHubFailure>> => {
      if (dead) return never();
      if (readsFail && req.method === 'GET')
        return err({
          reason: 'unknown',
          status: null,
          detail: 'connection reset',
          retry_after_ms: null,
        });
      const r = await github.request(req);
      const c = crash;
      if (c !== null && 'github' in c && c.github(req)) {
        dead = true;
        return never();
      }
      if (postPulls(req) && answer !== 'as_is') {
        const failure: GitHubFailure =
          answer === '422'
            ? {
                reason: 'http_error',
                status: 422,
                detail: 'HTTP 422',
                retry_after_ms: null,
              }
            : {
                reason: 'unknown',
                status: null,
                detail: 'connection reset',
                retry_after_ms: null,
              };
        if (answer === 'lost') readsFail = true;
        answer = 'as_is';
        return err(failure);
      }
      return r;
    },
  };

  const spawn = new SpawnExecutor();
  /** Every repo command any daemon life ran (gates, autofix), by its frozen command string. */
  const execLedger: string[] = [];
  const executor: CommandExecutor = {
    run: (plan, opts) => {
      if (dead) return never();
      const command = plan.argv.at(-1) ?? '';
      execLedger.push(command);
      const c = crash;
      if (c !== null && 'exec' in c && c.exec(command)) {
        dead = true;
        return never();
      }
      return spawn.run(plan, opts);
    },
  };

  let ids = 30_000;
  const newId = (): string => uuidOf(ids++);
  let d = new StoreDriver(openFileStoreForTest(join(dir, STORE_FILE)));
  let dispatcher: Dispatcher;
  const live = (store: Store): void => {
    const clock = { now: () => d.now as EpochMs, monotonic: () => d.now };
    const deps: HandlerDeps = {
      dataDir: data,
      store,
      git,
      github: () => githubPort,
      harnesses: { claude, codex: new FakeHarness({ reviewer: [] }, 'codex') },
      sandbox: passthrough,
      executor,
      clock,
      redactor: new Redactor(),
      newId,
      paths,
      committer: { name: 'Cuesura', email: 'cusr@invalid' },
      remoteUrl: () => remote,
      abort: (id) => dispatcher.abort(id),
    };
    dispatcher = new Dispatcher({
      store,
      clock,
      handlers: buildHandlers(deps),
      newId,
    });
  };
  live(d.store);

  const start = (): void => {
    d.must(task.id, { kind: 'create_task', task });
    const frozen = freezeOk(task, {
      base_sha: base,
      gates: {
        build: 'true',
        unit: 'true',
        lint: 'true',
        format_fix: 'true format',
      },
      required_checks: ['build', 'test', ...(o.required ?? [])],
      ci_rules: [{ match: { check: 'format' }, class: 'autofix' }, ...DEFAULT_CI_RULES],
      limits: { max_wall_ms: 3_600_000 },
      mode: 'direct-pr',
    });
    proposeAndConfirm(d, task, selectionFor(task, 'direct-pr', frozen.value.policy));
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
    });
    d.must(task.id, { kind: 'start', freeze: frozen, runtime });
  };

  const tick = async (): Promise<number> => {
    const r = dispatcher.tick();
    await dispatcher.settle();
    d.now += 1_000;
    return r.started.length;
  };

  /** Runs until `kind` is pending; it is the next effect the daemon starts. */
  const until = async (kind: string): Promise<void> => {
    for (let i = 0; i < 40; i++) {
      if (d.pending(task.id).some((e) => e.kind === kind)) return;
      if ((await tick()) === 0) break;
    }
    throw new Error(`never reached ${kind}: ${JSON.stringify(d.pending(task.id))}`);
  };

  /** Runs until a `run_gates` of `step` is pending; the slot is granted whenever the task waits for it. */
  const untilStep = async (step: string): Promise<void> => {
    for (let i = 0; i < 60; i++) {
      if (d.task(task.id).wait?.detail['code'] === 'execution_slot')
        d.store.grantNext(d.now as EpochMs, [newId(), newId(), newId()]);
      const s = d.task(task.id);
      if (d.pending(task.id, 'run_gates').some((e) => s.effects[e.id]?.step === step)) return;
      if ((await tick()) === 0) break;
    }
    const s = d.task(task.id);
    throw new Error(
      `never reached ${step}: ${JSON.stringify({ status: s.status, step: s.current_step, wait: s.wait, effects: Object.values(s.effects).map((e) => [e.kind, e.step, e.status]) })}`,
    );
  };

  /** Starts the next effect with the kill point armed and waits for the daemon to die there. */
  const dieAt = async (c: Crash): Promise<void> => {
    crash = c;
    expect(dispatcher.tick().started).toHaveLength(1);
    for (let i = 0; i < 600 && !dead; i++) await new Promise((r) => setTimeout(r, 10));
    expect(dead).toBe(true);
  };

  const probes = (): Omit<StartupDeps, 'path'> => ({
    dataDir: dir,
    redactor: new Redactor(),
    inspect: (id) =>
      Promise.resolve({
        unit: `cusr-op-${id}.service`,
        state: 'not_found',
        invocation_id: null,
        cgroup: null,
      }),
    probeLock: () => 'free',
    now: () => d.now,
    newId: uuidv7,
  });

  /** The killed daemon's store is closed as it left it; a new daemon life recovers the same file. */
  const restart = async () => {
    d.store.close();
    const r = await recoverStore({ ...probes(), path: join(dir, STORE_FILE) });
    if (!r.ok) throw new Error(`recover: ${JSON.stringify(r.error)}`);
    const now = d.now;
    d = new StoreDriver(r.value.store, 9);
    d.now = now;
    crash = null;
    dead = false;
    live(d.store);
    return r.value.report;
  };

  const kinds = (kind: string) =>
    Object.values(d.task(task.id).effects).filter((e) => e.kind === kind);
  const branch = taskBranch(task.id, task.title);
  const remoteHead = (): string | null => {
    try {
      return g.sh(remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    } catch {
      return null;
    }
  };

  return {
    get d() {
      return d;
    },
    github,
    gitLedger,
    execLedger,
    remote,
    base,
    worktree,
    branch,
    paths,
    git,
    githubPort,
    start,
    tick,
    until,
    untilStep,
    dieAt,
    restart,
    kinds,
    remoteHead,
    answer: (a: '422' | 'lost') => {
      answer = a;
    },
    failReads: (on: boolean) => {
      readsFail = on;
    },
  };
}

type World = ReturnType<typeof world>;

const count = (w: World, name: string) => w.gitLedger.filter((a) => a[0] === name).length;
const posts = (w: World) => w.github.calls.filter((c) => c.startsWith('POST')).length;

/**
 * After a restart the in-flight operation is lost and its effect unknown; the next daemon round runs
 * its reconcile, which settles it to `status` and closes the lost operation with it. Nothing is sent
 * again, and the requests the probe took are counted apart from the one logical effect.
 */
async function expectReconciled(
  w: World,
  task: CanonicalTask,
  kind: string,
  report: Awaited<ReturnType<World['restart']>>,
  status: 'succeeded' | 'failed' | 'unknown' | 'pending',
) {
  expect(report.operations).toMatchObject([{ finding: { status: 'lost' }, effect: 'unknown' }]);
  expect(report.held).toBeNull();
  const [probe] = w.d.pending(task.id, 'reconcile');
  const effect = w.d.task(task.id).effects[String(probe?.request['effect_id'])];
  if (effect === undefined) throw new Error('no reconcile target');
  expect(effect.kind).toBe(kind);
  expect(effect.status).toBe('unknown');
  const same = () => w.kinds(kind).filter((e) => e.step === effect.step).length;
  await w.tick();
  const s = w.d.task(task.id);
  expect(s.effects[effect.id]?.status).toBe(status);
  expect(s.effects[probe?.id ?? '']?.status).toBe('succeeded');
  const result = w.d.store
    .readEvents(task.id)
    .find(
      (e) =>
        e.type === 'EffectCompleted' &&
        (e.payload as { effect_id: string }).effect_id === probe?.id,
    )?.payload as { result: { finding: string; requests: object } } | undefined;
  expect(result?.result.requests).toBeDefined();
  const ops = Object.values(s.operations).filter((o) => o.effect_id === effect.id);
  expect(ops.map((o) => o.status)).toEqual([status === 'unknown' ? 'lost' : 'finished']);
  expect(same()).toBe(1);
  expect(w.d.store.verifyProjections().ok).toBe(true);
}

const prSpec = (w: World, task: CanonicalTask): PrSpec => {
  const [effect] = w.kinds('create_pr');
  return {
    repo: 'acme/app',
    immutable_repo_id: '4242',
    head_branch: w.branch,
    base: task.base_branch,
    head_sha: w.d.task(task.id).head_sha ?? '',
    title: CONTENT.pr_title,
    body: CONTENT.pr_body,
    task_id: task.id,
    revision: 1,
    operation_key: effect?.idem_key ?? '',
  };
};

describe('checkpoint commit interrupted around the ref CAS (FR-017/018)', () => {
  it.each(['before', 'after'] as const)(
    'killed %s update-ref: no second commit; the stored intent recovers the one OID',
    async (at) => {
      const task = buildTask();
      const w = world(task);
      w.start();
      await w.until('run_gates');
      const parent = g.sh(w.worktree, 'rev-parse', 'HEAD');
      await w.dieAt({ at, git: gitOp('update-ref') });
      expect(count(w, 'update-ref')).toBe(at === 'before' ? 0 : 1);
      const report = await w.restart();
      await expectReconciled(w, task, 'run_gates', report, 'succeeded');
      // Gates are declared safe: the reconcile ran them again and found the intent's one commit.
      expect(count(w, 'update-ref')).toBe(1);
      expect(count(w, 'push')).toBe(0);

      const intents = new FileCommitIntentStore(w.paths.intents);
      const [file] = readdirSync(w.paths.intents);
      const key = (file ?? '').replace(/\.json$/, '');
      const intent = intents.load(key);
      if (intent === null) throw new Error('no commit intent');
      expect(intent.parent).toBe(parent);
      expect(await probeCommit(w.git, intents, key)).toMatchObject({
        kind: 'committed',
      });

      expect(w.d.task(task.id).run.checkpoint?.sha).toBe(intent.oid);
      const { schema_version: _v, oid: _oid, ...input } = intent;
      expect(await commitCheckpoint(w.git, intents, input)).toMatchObject({
        kind: 'recovered',
        intent: { oid: intent.oid },
      });
      expect(g.sh(w.worktree, 'rev-list', '--count', `${parent}..${intent.branch}`)).toBe('1');
      expect(g.sh(w.worktree, 'log', '-1', '--format=%B', intent.oid)).toBe(CONTENT.commit_message);
      // The flow goes on from the recovered checkpoint: that very SHA is pushed, once.
      await w.until('create_pr');
      expect(w.remoteHead()).toBe(intent.oid);
      expect(count(w, 'push')).toBe(1);
    },
  );
});

describe('push interrupted after the remote moved (FR-017/018, FR-041.03)', () => {
  it('killed after the push, before its receipt: the remote holds the SHA once; a probe sees it pushed and pushes nothing', async () => {
    const task = buildTask();
    const w = world(task);
    w.start();
    await w.until('publish');
    const sha = w.d.task(task.id).run.checkpoint?.sha ?? '';
    await w.dieAt({ at: 'after', git: gitOp('push') });
    expect(w.remoteHead()).toBe(sha);
    const report = await w.restart();
    await expectReconciled(w, task, 'publish', report, 'succeeded');
    // The pushed SHA is the published head; the PR comes next, nothing is pushed again.
    expect(w.d.task(task.id).head_sha).toBe(sha);
    await w.until('create_pr');

    const pushes = count(w, 'push');
    expect(
      await pushBranch(w.git, {
        cwd: w.worktree,
        remote_url: w.remote,
        branch: w.branch,
        expected_old: null,
        new_sha: sha,
      }),
    ).toEqual({ kind: 'already_pushed', remote_sha: sha });
    expect(count(w, 'push')).toBe(pushes);
    expect(pushes).toBe(1);
    expect(posts(w)).toBe(0);
  });

  it('a remote that diverged while the daemon was down is reported and never overwritten', async () => {
    const task = buildTask();
    const w = world(task);
    w.start();
    await w.until('publish');
    const sha = w.d.task(task.id).run.checkpoint?.sha ?? '';
    await w.dieAt({ at: 'before', git: gitOp('push') });
    expect(w.remoteHead()).toBeNull();
    // Someone else publishes the branch first.
    const other = g.repo(`other${n++}`, { 'x.txt': 'theirs\n' });
    g.sh(other, 'push', '-q', w.remote, `HEAD:refs/heads/${w.branch}`);
    const theirs = w.remoteHead();
    const report = await w.restart();
    await expectReconciled(w, task, 'publish', report, 'failed');
    const s = w.d.task(task.id);
    expect(s.run.head_drift).toMatchObject({
      expected: null,
      observed: theirs,
    });
    expect(s.head_sha).toBeNull();
    for (let i = 0; i < 3; i++) await w.tick();
    expect(w.kinds('publish')).toHaveLength(1);
    expect(w.kinds('create_pr')).toEqual([]);

    const r = await pushBranch(w.git, {
      cwd: w.worktree,
      remote_url: w.remote,
      branch: w.branch,
      expected_old: null,
      new_sha: sha,
    });
    expect(r).toEqual({ kind: 'head_changed', remote_sha: theirs });
    expect(w.remoteHead()).toBe(theirs);
    expect(count(w, 'push')).toBe(0);
  });
});

describe('PR create interrupted after GitHub made it (FR-017/018)', () => {
  it('killed after the 201, before its receipt: one PR; the marker probe recovers it without sending again', async () => {
    const task = buildTask();
    const w = world(task);
    w.start();
    await w.until('create_pr');
    await w.dieAt({ at: 'after', github: postPulls });
    expect(w.github.prs).toHaveLength(1);
    const report = await w.restart();
    await expectReconciled(w, task, 'create_pr', report, 'succeeded');
    expect(w.d.task(task.id).pr_ref).toBe('acme/app#7');
    expect(posts(w)).toBe(1);

    const r = await createOrRecoverPr(w.githubPort, prSpec(w, task));
    expect(r).toMatchObject({ kind: 'recovered', pr: { number: 7 } });
    expect(w.github.prs).toHaveLength(1);
    expect(posts(w)).toBe(1);
    expect(count(w, 'push')).toBe(1);
  });

  it('a second PR carrying the same marker is a conflict: neither is claimed and nothing is created', async () => {
    const task = buildTask();
    const w = world(task);
    w.start();
    await w.until('create_pr');
    await w.dieAt({ at: 'after', github: postPulls });
    const ours = w.github.prs[0];
    if (ours === undefined) throw new Error('no PR');
    w.github.prs.push({ ...ours, number: 8, id: 800 });
    const report = await w.restart();
    await expectReconciled(w, task, 'create_pr', report, 'failed');
    expect(w.d.task(task.id).pr_ref).toBeNull();
    for (let i = 0; i < 3; i++) await w.tick();
    expect(w.kinds('create_pr')).toHaveLength(1);

    const r = await createOrRecoverPr(w.githubPort, prSpec(w, task));
    expect(r).toMatchObject({
      kind: 'conflict',
      reason: 'multiple',
      prs: [7, 8],
    });
    expect(posts(w)).toBe(1);
  });

  it('a 422 for a PR that was in fact created is probed: the daemon records that PR and creates no other', async () => {
    const task = buildTask();
    const w = world(task);
    w.start();
    await w.until('create_pr');
    w.answer('422');
    await w.tick();
    const s = w.d.task(task.id);
    expect(s.pr_ref).toBe('acme/app#7');
    expect(w.kinds('create_pr')[0]?.status).toBe('succeeded');
    expect(w.github.prs).toHaveLength(1);
    expect(posts(w)).toBe(1);
  });

  it('an answer lost with GitHub unreadable stays unknown across a restart; once readable the probe finds the one PR', async () => {
    const task = buildTask();
    const w = world(task);
    w.start();
    await w.until('create_pr');
    w.answer('lost');
    await w.tick();
    const [effect] = w.kinds('create_pr');
    expect(effect?.status).toBe('unknown');
    expect(w.github.prs).toHaveLength(1);

    const report = await w.restart();
    expect(report.unresolved).toEqual([]);
    for (let i = 0; i < 3; i++) await w.tick();
    expect(w.kinds('create_pr')).toHaveLength(1);
    expect(w.d.task(task.id).effects[effect?.id ?? '']?.status).toBe('unknown');
    expect(posts(w)).toBe(1);

    w.failReads(false);
    expect(await createOrRecoverPr(w.githubPort, prSpec(w, task))).toMatchObject({
      kind: 'recovered',
      pr: { number: 7 },
    });
    expect(posts(w)).toBe(1);
  });
});

describe('gate and autofix commands interrupted (FR-003/004, T090)', () => {
  /** A task whose PR is up with the `format` check red: the next work is the `ci_autofix` gate. */
  async function atAutofix(task: CanonicalTask): Promise<World> {
    const w = world(task, { required: ['format'] });
    w.start();
    await w.until('create_pr');
    const sha = w.d.task(task.id).head_sha ?? '';
    w.github.checks.set(sha, {
      build: 'success',
      test: 'success',
      format: 'failure',
    });
    await w.untilStep('ci_autofix');
    return w;
  }
  const journal = (w: World, effectId: string) =>
    new CommandJournal(join(w.paths.receipts, effectId)).read();
  const autofix = (w: World) => w.kinds('run_gates').filter((e) => e.step === 'ci_autofix');

  it('a gate killed while it ran is declared safe: the reconcile runs the gates again and the flow goes on', async () => {
    const task = buildTask();
    const w = world(task);
    w.start();
    await w.until('run_gates');
    await w.dieAt({ at: 'during', exec: (c) => c === 'true' });
    const [gate] = w.kinds('run_gates');
    expect(journal(w, gate?.id ?? '')).toMatchObject({
      ok: true,
      commands: [{ name: 'build', started: true, receipt: null }],
    });
    const report = await w.restart();
    await expectReconciled(w, task, 'run_gates', report, 'succeeded');
    expect(w.d.task(task.id).run.checkpoint?.sha).toMatch(/^[0-9a-f]{40}$/);
    await w.until('create_pr');
    expect(count(w, 'push')).toBe(1);
  });

  it('autofix killed before any command spawned: the journal proves nothing ran, so it goes back to the queue', async () => {
    const task = buildTask();
    const w = await atAutofix(task);
    const fixes = w.execLedger.filter((c) => c === 'true format').length;
    await w.dieAt({ at: 'before', git: () => true });
    const [fix] = autofix(w);
    expect(journal(w, fix?.id ?? '')).toEqual({ ok: true, commands: [] });
    const report = await w.restart();
    await expectReconciled(w, task, 'run_gates', report, 'pending');
    // Same logical effect, same key: it runs once now and the flow publishes the fix.
    await w.tick();
    expect(autofix(w)).toHaveLength(1);
    expect(autofix(w)[0]?.status).toBe('succeeded');
    expect(w.execLedger.filter((c) => c === 'true format')).toHaveLength(fixes + 1);
  });

  it('autofix killed while its command ran may have written: it stays unknown with its claim, and the worktree is kept', async () => {
    const task = buildTask();
    const w = await atAutofix(task);
    writeFileSync(join(w.worktree, 'half-formatted.ts'), 'x\n');
    await w.dieAt({ at: 'during', exec: (c) => c === 'true format' });
    const report = await w.restart();
    await expectReconciled(w, task, 'run_gates', report, 'unknown');
    const s = w.d.task(task.id);
    expect(s.status).toBe('WAITING');
    const [fix] = autofix(w);
    expect(s.effects[fix?.id ?? '']?.status).toBe('unknown');
    for (let i = 0; i < 3; i++) await w.tick();
    expect(w.execLedger.filter((c) => c === 'true format')).toHaveLength(1);
    expect(g.sh(w.worktree, 'status', '--porcelain')).toContain('half-formatted.ts');
  });

  it('autofix whose receipts are all on disk is recorded from them, without running it again', async () => {
    const task = buildTask();
    const w = await atAutofix(task);
    await w.dieAt({ at: 'during', exec: (c) => c === 'true format' });
    const [fix] = autofix(w);
    // The command ended and its receipt reached the journal just before the daemon died.
    const j = new CommandJournal(join(w.paths.receipts, fix?.id ?? ''));
    j.append({
      kind: 'receipt',
      receipt: {
        role: 'autofix',
        name: 'format_fix',
        command: 'true format',
        command_digest: hashText('true format'),
        layout_digest: null,
        status: 'passed',
        exit_code: 0,
        started_at: w.d.now as EpochMs,
        finished_at: w.d.now as EpochMs,
        wall_ms: 1,
        output: { digest: hashText(''), bytes: 0, tail: '', truncated: false },
        retry: 'unsafe',
        detail: null,
      },
    });
    const report = await w.restart();
    await expectReconciled(w, task, 'run_gates', report, 'succeeded');
    expect(w.execLedger.filter((c) => c === 'true format')).toHaveLength(1);
    // The recorded pass routes on: the gates run on the fixed tree before anything is published.
    await w.untilStep('gates');
  });
});

describe('merge recorded while the daemon died with work in flight (T091, FR-034.02/03, FR-040.02–09)', () => {
  it('after the restart the merge stands, the late read is evidence only, the local remainder is kept and recorded, DONE once and only then the dependent', async () => {
    const task = buildTask();
    const child = buildTask({
      id: uuidOf(2),
      source_key: 'cli:2',
      depends_on: [task.id],
    });
    const w = world(task);
    w.start();
    w.d.must(child.id, { kind: 'create_task', task: child });
    await w.until('await_ci');
    const head = w.d.task(task.id).head_sha ?? '';
    // The CI read of the PR is in flight when the daemon dies.
    await w.dieAt({
      at: 'after',
      github: (r) => r.method === 'GET' && /\/pulls\/7$/.test(r.path),
    });
    // The user merged; the observation service had recorded the proof before the daemon died.
    const MERGE = 'e'.repeat(40);
    w.github.merge(7, MERGE);
    const subject = {
      provider: 'github' as const,
      immutable_repo_id: '4242',
      subject_id: '700',
      target_ref: 'main',
      head_ref: w.branch,
    };
    w.d.must(task.id, {
      kind: 'observation_result',
      observation: {
        observation_id: 'obs-merge',
        source: 'recheck',
        requested_at: w.d.now,
        observed_at: w.d.now,
        generation: 0,
        subject,
        status: 'merged',
        observed_head: head,
        raw_evidence_ref: 'ev-merge',
        completeness: { merge_proof: true, quality: false },
      },
      remote_digest: `sha256:${'d'.repeat(64)}`,
    });
    w.d.must(task.id, {
      kind: 'external_completion',
      proof: {
        subject,
        merged_at: w.d.now,
        merged_head_sha: head,
        checked_head_sha: null,
        merge_commit_sha: MERGE,
        observation_id: 'obs-merge',
        evidence_ref: 'ev-merge',
      },
      unverified_reason: null,
    });
    // Local work made after the merge: a commit not on the remote and an uncommitted file.
    writeFileSync(join(w.worktree, 'after-merge.ts'), 'export {};\n');
    g.sh(w.worktree, 'add', 'after-merge.ts');
    g.sh(w.worktree, 'commit', '-qm', 'local follow-up');
    const local = g.sh(w.worktree, 'rev-parse', 'HEAD');
    writeFileSync(join(w.worktree, 'scratch.txt'), 'notes\n');

    const report = await w.restart();
    expect(report.operations).toMatchObject([{ finding: { status: 'lost' }, effect: 'unknown' }]);
    let s = w.d.task(task.id);
    expect(s.completion?.proof.merge_commit_sha).toBe(MERGE);
    expect(s.wait?.detail['code']).toBe('merge_cleanup_pending');
    expect(s.status).toBe('WAITING');
    expect(notifyDependents(w.d.store, w.d.now)).toEqual([]);
    expect(w.d.task(child.id).status).not.toBe('READY');

    // Merge first: the drain round after the restart stops nothing, keeps the claim of the read whose
    // end is unproven, and records what the worktree still holds.
    const port = {
      launch: () => Promise.reject(new Error('no launch in a drain')),
      inspect: (id: string) =>
        Promise.resolve({
          unit: `cusr-op-${id}.service`,
          state: 'not_found' as const,
          invocation_id: null,
          cgroup: null,
        }),
      stop: () => Promise.resolve('not_running' as const),
    };
    const round = await drainRound(
      {
        store: w.d.store,
        process: port,
        clock: { now: () => w.d.now as EpochMs, monotonic: () => w.d.now },
        local: () =>
          probeLocalRemainder(w.git, {
            worktree: w.worktree,
            remote_url: w.remote,
            branch: w.branch,
            base_sha: w.base,
          }),
      },
      task.id,
    );
    expect(round?.pending_operations).toHaveLength(1);
    s = w.d.task(task.id);
    expect(s.status).toBe('WAITING');
    expect(s.completion?.local_remainder).toMatchObject({
      worktree: w.worktree,
      local_head: local,
      remote_head: head,
      dirty: true,
      unpushed: true,
      detail: null,
    });

    // The reconcile reads the PR again: the late read is evidence only; nothing resumes or publishes,
    // and with nothing left open the task ends DONE.
    await w.tick();
    s = w.d.task(task.id);
    expect(w.kinds('await_ci')[0]?.status).toBe('succeeded');
    expect(Object.values(s.operations).map((o) => o.status)).not.toContain('lost');
    expect(w.d.pending(task.id)).toEqual([]);
    expect(s.status).toBe('DONE');
    expect(s.completion?.local_remainder?.local_head).toBe(local);
    // Kept as it is: nothing reset, cleaned or pushed to match the merge.
    expect(g.sh(w.worktree, 'rev-parse', 'HEAD')).toBe(local);
    expect(g.sh(w.worktree, 'status', '--porcelain')).toContain('scratch.txt');
    expect(w.remoteHead()).toBe(head);
    expect(count(w, 'push')).toBe(1);
    const completed = w.d.store.readEvents(task.id).filter((e) => e.type === 'TaskCompleted');
    expect(completed).toHaveLength(1);
    notifyDependents(w.d.store, w.d.now);
    expect(w.d.task(child.id).status).toBe('READY');
    expect(w.d.store.verifyProjections().ok).toBe(true);
  });
});

describe('merge found by the reconcile of a lost CI read (T093, FR-040.02)', () => {
  it('the reconcile records the merge it reads; the drain then ends the task DONE once', async () => {
    const task = buildTask();
    const w = world(task);
    w.start();
    await w.until('await_ci');
    const MERGE = 'e'.repeat(40);
    w.github.merge(7, MERGE);
    // The daemon dies right after GitHub answered the read, before anything was recorded.
    await w.dieAt({
      at: 'after',
      github: (r) => r.method === 'GET' && /\/pulls\/7$/.test(r.path),
    });
    expect(w.d.task(task.id).completion).toBeNull();
    const report = await w.restart();
    expect(report.operations).toMatchObject([{ finding: { status: 'lost' }, effect: 'unknown' }]);
    await w.tick();
    let s = w.d.task(task.id);
    expect(s.completion?.proof.merge_commit_sha).toBe(MERGE);
    expect(w.kinds('await_ci')[0]?.status).toBe('succeeded');
    const port = {
      launch: () => Promise.reject(new Error('no launch in a drain')),
      inspect: (id: string) =>
        Promise.resolve({
          unit: `cusr-op-${id}.service`,
          state: 'not_found' as const,
          invocation_id: null,
          cgroup: null,
        }),
      stop: () => Promise.resolve('not_running' as const),
    };
    await drainRound(
      {
        store: w.d.store,
        process: port,
        clock: { now: () => w.d.now as EpochMs, monotonic: () => w.d.now },
      },
      task.id,
    );
    s = w.d.task(task.id);
    expect(s.status).toBe('DONE');
    expect(w.d.store.readEvents(task.id).filter((e) => e.type === 'TaskCompleted')).toHaveLength(1);
    expect(w.d.store.verifyProjections().ok).toBe(true);
  });
});

describe('H05 restart: reviewer A finished on disk, not ingested, drift B recorded (FR-041.03)', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const OP = uuidOf(951);

  it('keeps the drift, the blocker and A as unknown; no second reviewer, commit, publish, posted review or ready PR', async () => {
    const dir = tempDir();
    let d = new StoreDriver(openFileStoreForTest(join(dir, STORE_FILE)));
    const task = buildTask();
    createGrantStart(d, task, 'full-review');
    d.complete(task.id, d.pendingOne(task.id, 'prepare').id, 'succeeded', {
      base_sha: 'base0000',
      worktree_ref: 'wt',
      branch: 'b',
      setup: { ran: false, passed: true },
    });
    d.complete(task.id, d.pendingOne(task.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(task.id, d.pendingOne(task.id, 'run_gates').id, 'succeeded', checkpointGates(A));
    publishToReview(d, task.id, A);
    const reviewer = d.pendingOne(task.id, 'start_agent');
    const input = currentReviewInput(d, task.id);
    const claimed = d.store.claimEffect(reviewer.id as Uuid, d.now as EpochMs, {
      require_runtime: true,
      operation: {
        operation_id: OP,
        kind: 'agent',
        launch_nonce: 'dispatch-1',
        unit: `cusr-op-${OP}.service`,
        holds_slot: true,
      },
    });
    if (!claimed.ok) throw new Error(JSON.stringify(claimed.error));
    const attempt = d.task(task.id).effects[reviewer.id]?.attempt_id;
    if (attempt == null) throw new Error('no attempt');

    // A's runner finished and wrote its result; the daemon died before ingesting it.
    const run = RunDir.open({
      dataDir: dir,
      kind: 'runs',
      id: attempt,
      redactor: new Redactor(),
    });
    run.createLaunchMarker({
      schema_version: 1,
      operation_id: OP,
      attempt_id: attempt,
      launch_nonce: 'launch-1',
      boot_id: 'boot-1',
      runner_pid: 4241,
      at: new Date(d.now).toISOString(),
    });
    const pid: PidRecord = {
      schema_version: 1,
      operation_id: OP,
      launch_nonce: 'launch-1',
      boot_id: 'boot-1',
      pid: 4242,
      pgid: 4242,
      start_ticks: 7,
      runner_pid: 4241,
      runner_start_ticks: 1,
      invocation_id: null,
      cgroup: null,
    };
    run.writeJson(RUN_FILES.pid, pid);
    run.writeJson(RUN_FILES.result, {
      schema_version: 1,
      verdict: 'approve',
      summary: 'looks right',
      findings: [],
    });
    const exit: RunnerExit = {
      schema_version: 1,
      operation_id: OP,
      run_id: attempt,
      launch_nonce: 'launch-1',
      outcome: 'exited',
      exit_code: 0,
      signal: null,
      spawned: true,
      started_at: d.now - 1_000,
      ended_at: d.now,
      duration_ms: 1_000,
      deadline_at: d.now + 60_000,
      termination: {
        term_sent: false,
        kill_sent: false,
        tree_empty_verified: true,
        scope: 'unit_cgroup',
        killed_after_exit: 0,
      },
      progress: { last_progress_at: d.now, last_reasons: [], samples: 1 },
      artifacts: { records: 0, last_seq: 0, truncated_records: 0 },
      error: null,
    };
    run.writeExit(exit);
    d.must(task.id, {
      kind: 'head_drift',
      expected: A,
      observed: B,
      source: 'observation',
      evidence_ref: 'obs:B',
    });
    const drifted = d.task(task.id);

    d.store.close();
    const r = await recoverStore({
      path: join(dir, STORE_FILE),
      dataDir: dir,
      redactor: new Redactor(),
      inspect: (id) =>
        Promise.resolve({
          unit: `cusr-op-${id}.service`,
          state: 'exited',
          invocation_id: null,
          cgroup: null,
        }),
      probeLock: () => 'free',
      identity: { bootId: () => 'boot-1', startTicks: () => null },
      now: () => d.now,
      newId: uuidv7,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const now = d.now;
    d = new StoreDriver(r.value.store, 9);
    d.now = now;
    try {
      expect(r.value.report.operations).toMatchObject([
        {
          operation_id: OP,
          finding: { status: 'finished', outcome: 'succeeded' },
          effect: 'unknown',
        },
      ]);
      const s = d.task(task.id);
      expect(s.run.head_drift).toEqual(drifted.run.head_drift);
      expect(s.blockers.map((b) => b.code)).toContain('head_changed');
      expect(s.effects[reviewer.id]?.status).toBe('unknown');
      expect(s.run.reviews).toEqual(drifted.run.reviews);
      expect(s.head_sha).toBe(A);

      // A's result arrives through reconcile: recorded as A's, it routes nothing while B stands.
      d.must(task.id, {
        kind: 'effect_reconciled',
        effect_id: reviewer.id as Uuid,
        finding: 'executed_succeeded',
        data: reviewData('approve', A, { input_digest: input }),
      });
      const after = d.task(task.id);
      expect(after.effects[reviewer.id]?.status).toBe('succeeded');
      expect(after.blockers.map((b) => b.code)).toContain('head_changed');
      expect(after.run.head_drift).toMatchObject({ expected: A, observed: B });
      expect(d.pending(task.id, 'publish')).toEqual([]);
      expect(d.pending(task.id, 'create_pr')).toEqual([]);
      expect(d.pending(task.id, 'post_review')).toEqual([]);
      expect(d.pending(task.id, 'mark_ready')).toEqual([]);
      expect(d.pending(task.id, 'run_gates')).toEqual([]);
      expect(
        Object.values(after.effects).filter((e) => e.step === 'review' && e.kind === 'start_agent'),
      ).toHaveLength(1);
      expect(d.store.verifyProjections().ok).toBe(true);
    } finally {
      d.store.close();
    }
  });
});
