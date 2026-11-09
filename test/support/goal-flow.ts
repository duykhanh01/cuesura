import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { FakeHarness } from '../../src/adapters/harness/fake.ts';
import type {
  GitPort,
  GitHubFailure,
  GitHubRequest,
  GitHubResponse,
  HarnessPort,
} from '../../src/adapters/ports.ts';
import { FileContentStore } from '../../src/adapters/publish-content.ts';
import { notifyDependents } from '../../src/application/dependency.ts';
import { finalTask, goalProgress, unitTask } from '../../src/application/goals.ts';
import { integrationStartProblem } from '../../src/application/goal-tip.ts';
import type { Caller } from '../../src/application/authz.ts';
import { envelope } from '../../src/application/triage.ts';
import { goalBranchRound } from '../../src/daemon/goal-branch.ts';
import { firstParentHistory } from '../../src/adapters/git/goal-branch.ts';
import { Dispatcher } from '../../src/daemon/dispatch.ts';
import { buildHandlers, observeTaskPr, type HandlerDeps } from '../../src/daemon/handlers.ts';
import { advanceTaskPr, type YoloDeps, type YoloOutcome } from '../../src/daemon/yolo.ts';
import { goalBranchName, type Plan } from '../../src/domain/goal.ts';
import type { FrozenPolicy } from '../../src/domain/policy.ts';
import type { RunSelection } from '../../src/domain/run-config.ts';
import type { TaskState } from '../../src/domain/state.ts';
import type { CanonicalTask } from '../../src/domain/task.ts';
import { parallelGroups, planHash } from '../../src/engine/plan.ts';
import { SpawnExecutor } from '../../src/runner/commands.ts';
import { Redactor } from '../../src/runner/redact.ts';
import type { EpochMs, Uuid } from '../../src/shared/brand.ts';
import { hashCanonical } from '../../src/shared/hash.ts';
import { err, ok, type Result } from '../../src/shared/result.ts';
import type { Store } from '../../src/store/index.ts';
import { openFileStoreForTest } from '../../src/store/testing.ts';
import { buildPolicy, freezeOk, ownerAuthz, uuidOf } from './builders.ts';
import { FakeGitHub } from './fake-github.ts';
import { contentFile, passthrough } from './flow-env.ts';
import { gitSandbox, type GitSandbox } from './git-repo.ts';
import { confirmedRuntime, proposeAndConfirm } from './runtime.ts';
import { StoreDriver } from './store-driver.ts';
import { dbPath, useTempDir } from './temp-db.ts';
import { PACKS } from './config-fixtures.ts';
import { CUSR, MANIFESTS, fakeGitHub, fakeHost, userConfig } from './preflight-fakes.ts';
import type { StartDeps } from '../../src/application/start.ts';
import { realpathSync } from 'node:fs';

const realpathOrNull = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

// A goal with several units run end to end (007, lát E): real Git worktrees and a bare remote, a fake
// GitHub that merges into the remote with a real merge commit, fake workers, and the daemon's own
// handlers, yolo/goal merge, observation, dependency and goal passes. The start of a task freezes as
// the start service would, from the remote as it is then.

type Reply = Promise<Result<GitHubResponse, GitHubFailure>>;

/** The fake GitHub, reading branches, comparisons and merges from a real bare remote. */
export class RemoteGitHub extends FakeGitHub {
  readonly #git: GitSandbox;
  readonly #remote: string;
  readonly #work: string;
  /** Lets a test lose the answer of the next merge (it still happens), as a timeout would. */
  loseNextMergeAnswer = false;
  merges = 0;
  /** Runs before each request is answered, once: lets a test change things while the daemon awaits. */
  beforeNext: ((req: GitHubRequest) => void) | null = null;
  /** Runs once right before the next merge is applied, after the daemon's last read. */
  beforeMerge: (() => void) | null = null;

  constructor(git: GitSandbox, remote: string, work: string) {
    super('acme/app', 4242);
    this.#git = git;
    this.#remote = remote;
    this.#work = work;
    this.headOf = (branch) => {
      try {
        const sha = git.sh(remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
        if (!this.checks.has(sha)) this.checks.set(sha, { build: 'success', test: 'success' });
        return sha;
      } catch {
        return null;
      }
    };
  }

  #reply(status: number, body: unknown): Reply {
    return Promise.resolve(
      ok({ status, headers: {}, body, evidence_digest: hashCanonical({ status, body }) }),
    );
  }

  #fail(status: number, detail: string): Reply {
    return Promise.resolve(err({ reason: 'http_error', status, detail, retry_after_ms: null }));
  }

  #contains(tip: string, head: string): boolean {
    try {
      this.#git.sh(this.#remote, 'merge-base', '--is-ancestor', tip, head);
      return true;
    } catch {
      return false;
    }
  }

  override async request(req: GitHubRequest): Reply {
    const hook = this.beforeNext;
    if (hook !== null && req.path.includes('/check-runs')) {
      this.beforeNext = null;
      hook(req);
    }
    const merge = req.method === 'PUT' ? /\/pulls\/(\d+)\/merge$/.exec(req.path) : null;
    if (merge !== null) {
      this.calls.push(`${req.method} ${req.path}`);
      const pr = this.prs.find((p) => p.number === Number(merge[1]));
      const b = req.body as { sha: string; merge_method: string; commit_title?: string };
      if (pr === undefined || pr.merged_at !== null) return this.#fail(405, 'not mergeable');
      if (this.headOf(pr.head.ref) !== b.sha) return this.#fail(409, 'head moved');
      const late = this.beforeMerge;
      this.beforeMerge = null;
      late?.();
      const g = this.#git;
      g.sh(this.#work, 'fetch', '-q', 'origin');
      g.sh(this.#work, 'checkout', '-q', '-B', pr.base, `origin/${pr.base}`);
      g.sh(
        this.#work,
        'merge',
        '-q',
        '--no-ff',
        '-m',
        b.commit_title ?? `Merge #${pr.number}`,
        b.sha,
      );
      g.sh(this.#work, 'push', '-q', 'origin', `HEAD:refs/heads/${pr.base}`);
      const sha = g.sh(this.#work, 'rev-parse', 'HEAD');
      pr.head.sha = b.sha;
      this.merge(pr.number, sha);
      this.merges++;
      if (this.loseNextMergeAnswer) {
        this.loseNextMergeAnswer = false;
        return err({ reason: 'unknown', status: null, detail: 'timeout', retry_after_ms: null });
      }
      return this.#reply(200, { merged: true, sha });
    }
    if (req.method === 'GET') {
      const branch = req.path.includes('/rules/') ? null : /\/branches\/([^/]+)$/.exec(req.path);
      if (branch !== null) {
        this.calls.push(`${req.method} ${req.path}`);
        const name = decodeURIComponent(branch[1] as string);
        const sha = this.headOf(name);
        return sha === null
          ? this.#fail(404, 'Branch not found')
          : this.#reply(200, { name, protected: false, commit: { sha } });
      }
      const compare = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(req.path);
      if (compare !== null) {
        this.calls.push(`${req.method} ${req.path}`);
        const ahead = Number(
          this.#git.sh(this.#remote, 'rev-list', '--count', `${compare[1]}..${compare[2]}`),
        );
        return this.#reply(200, { ahead_by: ahead, behind_by: 0 });
      }
    }
    const r = await super.request(req);
    const pull = req.method === 'GET' ? /\/pulls\/(\d+)$/.exec(req.path) : null;
    if (pull === null || !r.ok) return r;
    const pr = this.prs.find((p) => p.number === Number(pull[1]));
    const tip = pr === undefined ? null : this.headOf(pr.base);
    const head = pr === undefined ? null : this.headOf(pr.head.ref);
    const state = tip !== null && head !== null && this.#contains(tip, head) ? 'clean' : 'behind';
    return ok({ ...r.value, body: { ...(r.value.body as object), mergeable_state: state } });
  }
}

const OWNER = { grant: { actor: 'owner' } } as unknown as Caller;
const GATES = { build: 'true', unit: 'true', lint: 'true', format_fix: 'true' };

/** The run selection a task's frozen policy accepts: the coder's binding, or the fixer's without one. */
function selectionOf(task: CanonicalTask, policy: FrozenPolicy): RunSelection {
  const step = policy.steps['code'] ?? policy.steps['fix_gates'];
  const b = (step as FrozenPolicy['steps'][string]).binding;
  return {
    task_id: task.id,
    revision: task.revision,
    profile: policy.profile,
    mode: 'direct-pr',
    reason: 'test',
    worker: { harness: b.harness, model: b.model, effort: b.effort },
    reviewer: null,
    fallbacks: [],
  };
}

const policyOf = (task: CanonicalTask, base: string) =>
  buildPolicy({
    task_id: task.id,
    revision: task.revision,
    project: task.project,
    base_sha: base,
    mode: 'direct-pr',
    gates: GATES,
    required_checks: ['build', 'test'],
    limits: { max_wall_ms: 3_600_000 },
    goal_final: task.goal?.role === 'final',
  });

export function goalFlowEnv(prefix: string) {
  const g = gitSandbox(prefix);
  afterAll(() => g.cleanup());
  const tempDir = useTempDir(`${prefix}db-`);
  let n = 0;
  return { g, setup };

  function setup(plan: Plan, o: { dataDir?: string; dbFile?: string } = {}) {
    // The project's own config at its base, so the real start service can run on this checkout.
    const project = g.repo(`acme${n++}`, {
      'README.md': 'acme\n',
      'cusr.yaml': CUSR,
      'AGENTS.md': '# Agents\n',
    });
    const remote = `${project}.remote.git`;
    g.sh(g.base, 'clone', '-q', '--bare', project, remote);
    g.sh(project, 'remote', 'add', 'origin', remote);
    const work = `${project}.work`;
    g.sh(g.base, 'clone', '-q', remote, work);
    const github = new RemoteGitHub(g, remote, work);
    const db = o.dbFile ?? dbPath(tempDir());
    const data = o.dataDir ?? `${project}.data`;
    const paths = {
      worktrees: join(data, 'worktrees'),
      markers: join(data, 'owners'),
      intents: join(data, 'intents'),
      scratch: join(data, 'scratch'),
      content: join(data, 'content'),
      receipts: join(data, 'receipts'),
    };
    const keys = new Map<string, string>();
    const done = {
      kind: 'result' as const,
      value: { schema_version: 1, status: 'done', summary: 'did it', questions: [], blocker: null },
    };
    const worker = new FakeHarness(
      {
        coder: Array.from({ length: 50 }, () => done),
        fixer: Array.from({ length: 50 }, () => done),
      },
      'claude',
    );
    const workerRuns: string[] = [];
    // Each unit writes its own file, so units never conflict; content as the context asks.
    const claude: HarnessPort = {
      harness: 'claude',
      manifest: worker.manifest,
      run: (input, signal) => {
        const file = contentFile(input.context.text);
        const id =
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(file)?.[0] ?? '';
        const key = keys.get(id) ?? 'final';
        workerRuns.push(`${input.role}:${key}`);
        writeFileSync(join(paths.worktrees, id, `${key}.txt`), `${key}\n`);
        writeFileSync(
          file,
          JSON.stringify({
            commit_message: `feat: unit ${key}\n\nDoes ${key}.`,
            pr_title: `Unit ${key}`,
            pr_body: `## Summary\nUnit ${key}.\n\n## Tests\nunit`,
          }),
        );
        return worker.run(input, signal);
      },
    };
    let ids = 40_000;
    const newId = (): string => uuidOf(ids++);
    let now = 1_800_000_000_000;
    const clock = { now: () => now as EpochMs, monotonic: () => now };
    const runner = g.runner();
    /** Runs once after the next goal branch probe answered, before the daemon reads its answer. */
    const gitHook: { afterProbe: (() => Promise<void>) | null } = { afterProbe: null };
    const git: GitPort = {
      run: async (req) => {
        const r = await runner.run(req);
        const hook = gitHook.afterProbe;
        if (
          hook !== null &&
          (req.args[0] === 'ls-remote' || req.args[0] === 'fetch') &&
          req.cwd === project
        ) {
          gitHook.afterProbe = null;
          await hook();
        }
        return r;
      },
    };
    const logs: string[] = [];

    let store: Store;
    let d: StoreDriver;
    let dispatcher: Dispatcher;
    let deps: HandlerDeps;
    let opened = 0;
    const open = (): void => {
      store = openFileStoreForTest(db);
      // A new driver per daemon, its IDs apart from the last one's, as a new daemon's are.
      d = new StoreDriver(store, ++opened);
      d.now = now;
      deps = {
        dataDir: data,
        store,
        git,
        github: () => github,
        harnesses: { claude },
        sandbox: passthrough,
        executor: new SpawnExecutor(),
        clock,
        redactor: new Redactor(),
        newId,
        paths,
        committer: { name: 'Cuesura', email: 'cusr@invalid' },
        remoteUrl: () => remote,
        abort: (id) => dispatcher.abort(id),
        settled: (id) => dispatcher.settled(id),
      };
      dispatcher = new Dispatcher({ store, clock, handlers: buildHandlers(deps), newId });
    };
    open();

    const yolo = (): YoloDeps => ({
      store,
      clock,
      newId,
      github: () => github,
      // The owner's yolo stays off: units merge by the confirmed plan alone.
      enabled: () => Promise.resolve(false),
      git,
      remoteUrl: () => remote,
      content: (ref, digest) => new FileContentStore(paths.content).get(ref, digest),
      log: (line) => logs.push(line),
    });
    const branchDeps = () => ({
      store,
      git,
      clock,
      remoteUrl: () => remote,
      location: () => Promise.resolve({ path: project, repo: 'acme/app' }),
      log: (line: string) => logs.push(line),
    });

    /** The goal confirmed straight in the store, as `goal confirm` records it. */
    function confirm(): {
      goalId: string;
      branch: string;
      units: Record<string, string>;
      final: string;
    } {
      const goalId = newId();
      const accept = (
        trigger: Parameters<Store['goals']['accept']>[0]['trigger'],
        k: string,
        within?: Parameters<Store['goals']['accept']>[1],
      ) => {
        const r = store.goals.accept(
          { goal_id: goalId, dedup_key: `${goalId}:${k}`, now, actor: 'owner', trigger },
          within,
        );
        if (!r.ok || r.value.decision.kind !== 'accepted') throw new Error(JSON.stringify(r));
      };
      accept(
        {
          kind: 'add',
          project: 'acme',
          base_branch: 'main',
          request: 'Export the report as CSV.',
          hints: {},
        },
        'add',
      );
      const hash = planHash(plan);
      accept({ kind: 'propose', plan, plan_version: 0, plan_hash: hash }, 'propose');
      const goal = store.goals.read(goalId);
      if (goal === null) throw new Error('no goal');
      const branch = goalBranchName(goalId, plan.summary);
      const keyToTask = new Map(plan.units.map((u) => [u.key, newId()]));
      for (const [k, id] of keyToTask) keys.set(id, k);
      const final = newId();
      const tasks: CanonicalTask[] = [];
      accept(
        {
          kind: 'confirm',
          plan_hash: hash,
          units: Object.fromEntries(keyToTask),
          branch: { name: branch, base_sha: g.sh(remote, 'rev-parse', 'refs/heads/main') },
          final_task_id: final,
        },
        'confirm',
        (tx) => {
          const create = (task: CanonicalTask) => {
            tasks.push(task);
            tx.acceptTask(
              envelope({
                task_id: task.id,
                dedup_key: `create:${task.id}`,
                trigger: { kind: 'create_task', task, intake_auto_confirm: true },
                now,
                ids: Array.from({ length: 8 }, newId),
                expected_version: 0,
                authz: ownerAuthz(),
              }),
            );
          };
          for (const layer of parallelGroups(plan) ?? [])
            for (const key of layer) {
              const unit = plan.units.find((u) => u.key === key);
              if (unit === undefined) continue;
              create(
                unitTask(goal, plan, unit, keyToTask.get(key) as string, keyToTask, OWNER, branch),
              );
            }
          create(finalTask(goal, plan, final, keyToTask, branch, OWNER));
        },
      );
      for (const task of tasks) proposeAndConfirm(d, task, selectionOf(task, policyOf(task, 'x')));
      return { goalId, branch, units: Object.fromEntries(keyToTask), final };
    }

    const tip = (branch: string): string => g.sh(remote, 'rev-parse', `refs/heads/${branch}`);

    /** What the start service does for a READY task holding a slot: freeze from the remote as it is now. */
    async function startHeld(): Promise<void> {
      for (let i = 0; i < 16; i++) {
        const r = store.grantNext(now as EpochMs, Array.from({ length: 8 }, newId), {
          capacity: 8,
        });
        if (!r.ok || r.value.kind !== 'decided' || r.value.outcome.decision.kind !== 'accepted')
          break;
      }
      for (const id of store.taskIdsByStatus(['READY'])) {
        const s = store.readTask(id as Uuid) as TaskState;
        if (s.policy_ref !== null || s.execution.holding === null) continue;
        if (s.task.goal?.role === 'final' && !control.startFinal) continue;
        g.sh(project, 'fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*');
        const final = s.task.goal?.role === 'final';
        const start = final ? tip(s.task.goal?.branch as string) : null;
        // As the start service: the integration task starts only on the goal branch the daemon wrote.
        const base =
          start === null
            ? tip(s.task.base_branch)
            : g.sh(project, 'merge-base', tip(s.task.base_branch), start);
        // Read as the start service reads it: from the goal's own base, through the one shared reader.
        const goalBase = final
          ? (store.goals.read(s.task.goal?.id ?? '')?.branch_base_sha ?? null)
          : null;
        const history =
          start === null || goalBase === null
            ? null
            : ((await firstParentHistory(runner, project, start, goalBase))?.history ?? null);
        if (
          final &&
          integrationStartProblem(
            store,
            s,
            history === null || start === null ? null : { tip: start, history },
          ) !== null
        )
          continue;
        d.now = now;
        d.must(s.id, {
          kind: 'start',
          freeze: freezeOk(s.task, {
            base_sha: base,
            mode: 'direct-pr',
            gates: GATES,
            required_checks: ['build', 'test'],
            limits: { max_wall_ms: 3_600_000 },
            goal_final: final,
          }),
          runtime: confirmedRuntime(d, s.task, {
            base_sha: base,
            project_path: project,
            target: {
              provider: 'github',
              repo: 'acme/app',
              immutable_repo_id: '4242',
              base_ref: s.task.base_branch,
            },
            ...(final ? {} : { merge_method: 'merge' as const }),
            ...(start === null ? {} : { start_sha: start }),
          }),
        });
      }
    }

    async function queue(): Promise<void> {
      for (const id of store.taskIdsByStatus(['READY'])) {
        const s = store.readTask(id as Uuid) as TaskState;
        if (s.policy_ref === null && s.execution.request === null)
          d.send(s.id, { kind: 'request_execution' });
      }
      for (const id of store.taskIdsByStatus(['WAITING'])) {
        const s = store.readTask(id as Uuid) as TaskState;
        if (s.wait?.detail.code === 'execution_slot') await startHeld();
      }
    }

    const outcomes: { task: string; outcome: YoloOutcome }[] = [];
    /** Off: tasks waiting for their merge are left there, for a test to merge them its own way. */
    const control = { merge: true, startFinal: true };

    /** One observation of a task's PR, its facts submitted as the observation service does. */
    async function observe(id: string): Promise<void> {
      const r = await observeTaskPr(
        { ...deps, local: { git, worktrees: paths.worktrees, remoteUrl: () => remote } },
        id,
        `observe:${id}:${now}`,
        'timer',
      );
      for (const fact of r.facts) d.send(id, fact);
    }

    /** One pass of everything the daemon runs. */
    async function round(): Promise<void> {
      d.now = now;
      await goalBranchRound(branchDeps());
      notifyDependents(store, now);
      await queue();
      await startHeld();
      dispatcher.tick();
      await dispatcher.settle();
      for (const id of store.taskIdsByStatus(['WAITING'])) {
        const s = store.readTask(id as Uuid) as TaskState;
        if (s.wait?.detail.code !== 'merge' || !control.merge) continue;
        outcomes.push({ task: id, outcome: await advanceTaskPr(yolo(), id) });
        await observe(id);
      }
      goalProgress(store, now);
      now += 61_000;
    }

    async function until(done: () => boolean, max = 120): Promise<void> {
      for (let i = 0; i < max; i++) {
        if (done()) return;
        await round();
      }
      if (!done()) {
        const states = store
          .taskIdsByStatus([
            'PENDING',
            'READY',
            'RUNNING',
            'WAITING',
            'DONE',
            'FAILED',
            'CANCELLED',
          ])
          .map((id) => {
            const s = store.readTask(id as Uuid) as TaskState;
            return `${keys.get(id) ?? 'final'} ${s.status} ${s.current_step ?? '-'} ${s.wait?.detail.code ?? '-'} ${JSON.stringify(s.wait?.detail ?? {}).slice(0, 300)}`;
          });
        throw new Error(
          `goal flow did not get there:\n${states.join('\n')}\nlog:\n${logs.join('\n')}`,
        );
      }
    }

    return {
      g,
      project,
      remote,
      github,
      get store() {
        return store;
      },
      get d() {
        return d;
      },
      confirm,
      round,
      until,
      tip,
      outcomes,
      gitHook,
      /** One goal branch round alone, as the daemon runs it. */
      branchRound: () => goalBranchRound(branchDeps()),
      control,
      observe,
      logs,
      workerRuns,
      yolo,
      task: (id: string) => store.readTask(id as Uuid) as TaskState,
      /** Closes the store as a dying daemon would, and opens it again for the next one. */
      restart: async () => {
        await dispatcher.stop();
        store.close();
        open();
      },
      /** The real start service on this checkout: preflight, freeze and submit, as cusrd runs it. */
      startDeps: (prompts?: StartDeps['docs']['prompts']): StartDeps => ({
        store,
        ports: {
          // `origin` is the bare remote here; preflight only reads its URL to match the GitHub repo.
          git: {
            run: (req) =>
              req.args.join(' ') === 'config --get remote.origin.url'
                ? Promise.resolve({
                    kind: 'exited' as const,
                    code: 0,
                    stdout: 'https://github.com/acme/app.git\n',
                    stderr: '',
                    truncated: false,
                  })
                : runner.run(req),
          },
          github: fakeGitHub(),
          host: { ...fakeHost(), realpath: (p: string) => Promise.resolve(realpathOrNull(p)) },
        },
        configInputs: () =>
          Promise.resolve({
            user: userConfig({
              project: `acme: { base_branch: main, path: ${project}, repo: acme/app }`,
            }),
            packs: PACKS,
            manifests: MANIFESTS,
          }),
        docs: {
          prompts:
            prompts ??
            ((names) => Promise.resolve(names.map((name) => ({ name, content: `# ${name}\n` })))),
          attachments: () => Promise.resolve([]),
        },
        now: () => now,
        newId,
      }),
      now: () => now,
      setNow: (t: number) => {
        now = t;
      },
    };
  }
}
