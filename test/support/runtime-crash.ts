/**
 * Runtime crash driver (T093, FR-036, FR-041.03, SC-004), shared by the reliability test and the daemon
 * life it kills (`runtime-crash-child.ts`). One daemon life is a real process on a real SQLite file: it
 * recovers the store like cusrd, then runs the daemon's own handlers on a real Git worktree and bare
 * remote, a fake GitHub kept in a file (it outlives the process), real gate commands and, for agent
 * runs, the real systemd user manager and `cusr-runner`. Every external request and every store write
 * passes a kill point; the life appends it to the ledger and SIGKILLs itself when the planned
 * `(key, occurrence)` comes up, so a seed reproduces the same kill.
 *
 * Kill points carry their phase: before the effect (claim, before a mutating request), after the
 * external success (after a push, a PR POST, a unit start, an ACK), and before or after the durable
 * ingest of the result (the store write that records it). Reads are logged but never planned as the
 * first kill of a run.
 */
import {
  clearOperationMark,
  stopOperationProcesses,
  writeOperationMark,
} from '../../src/runner/process-tag.ts';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { GitCommandRunner } from '../../src/adapters/git/command.ts';
import { FakeHarness } from '../../src/adapters/harness/fake.ts';
import type {
  GitHubPort,
  GitPort,
  HarnessPort,
  SandboxProvider,
} from '../../src/adapters/ports.ts';
import { notifyDependents } from '../../src/application/dependency.ts';
import { Dispatcher } from '../../src/daemon/dispatch.ts';
import { drainRound, drainingTasks } from '../../src/daemon/drain.ts';
import { buildHandlers } from '../../src/daemon/handlers.ts';
import { STORE_FILE } from '../../src/daemon/main.ts';
import type { EffectKind } from '../../src/domain/effect.ts';
import type { TaskStatus } from '../../src/domain/state.ts';
import type { CanonicalTask } from '../../src/domain/task.ts';
import { RUN_FILES, type FileLimits } from '../../src/runner/files.ts';
import { SpawnExecutor, type CommandExecutor } from '../../src/runner/commands.ts';
import { Redactor } from '../../src/runner/redact.ts';
import type { EpochMs, Uuid } from '../../src/shared/brand.ts';
import { canonicalJson } from '../../src/shared/canonical-json.ts';
import { hashText } from '../../src/shared/hash.ts';
import { ok } from '../../src/shared/result.ts';
import type { Store } from '../../src/store/index.ts';
import { FakeGitHub, type FakeGitHubState } from './fake-github.ts';
import { GIT_BIN } from './git-repo.ts';

export const GROUPS = [
  'spawn_adoption',
  'output_ack',
  'commit_push',
  'pr_create',
  'merge_drain',
  'h05',
] as const;
export type Group = (typeof GROUPS)[number];

export const PHASES = ['before_effect', 'after_external', 'before_ingest', 'after_ingest'] as const;
export type Phase = (typeof PHASES)[number];

export type KillPoint = { readonly key: string; readonly occurrence: number };
export type Hit = {
  readonly life: number;
  readonly key: string;
  readonly occurrence: number;
  readonly phase: Phase | 'read';
};

/** Counts every kill point a life passes, logs it, and SIGKILLs the life at the planned one. */
export class KillSwitch {
  readonly #counts = new Map<string, number>();
  readonly #ledger: string;
  readonly #life: number;
  readonly #kill: KillPoint | null;

  constructor(ledger: string, life: number, kill: KillPoint | null) {
    this.#ledger = ledger;
    this.#life = life;
    this.#kill = kill;
  }

  hit(key: string, phase: Phase | 'read'): void {
    const occurrence = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, occurrence);
    const hit: Hit = { life: this.#life, key, occurrence, phase };
    // Written before the kill: the ledger's last line is where the life died.
    appendFileSync(this.#ledger, `${JSON.stringify(hit)}\n`);
    if (this.#kill?.key === key && this.#kill.occurrence === occurrence)
      process.kill(process.pid, 'SIGKILL');
  }
}

export function readLedger(file: string): Hit[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Hit);
}

/** Every write a daemon life makes to the store passes a kill point before and after it commits. */
export function guardStore(store: Store, sw: KillSwitch): Store {
  return new Proxy(store, {
    get(target, key) {
      if (key === 'accept')
        return (envelope: Parameters<Store['accept']>[0]) => {
          const k = `store:${envelope.trigger.kind}`;
          sw.hit(`${k}:before`, 'before_ingest');
          const r = target.accept(envelope);
          sw.hit(`${k}:after`, 'after_ingest');
          return r;
        };
      if (key === 'claimEffect')
        return (...args: Parameters<Store['claimEffect']>) => {
          const k = `claim:${target.readEffect(args[0])?.kind ?? 'unknown'}`;
          sw.hit(`${k}:before`, 'before_effect');
          const r = target.claimEffect(...args);
          sw.hit(`${k}:after`, 'before_effect');
          return r;
        };
      const v: unknown = Reflect.get(target, key, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

// ---- layout ----

/** Everything one run touches lives under `root`, so a template copied back to the same path is whole. */
export type Layout = {
  readonly root: string;
  readonly project: string;
  readonly remote: string;
  readonly data: string;
  readonly store: string;
  readonly github: string;
  readonly ledger: string;
  readonly spawns: string;
  readonly hooks: string;
  readonly paths: {
    readonly worktrees: string;
    readonly markers: string;
    readonly intents: string;
    readonly scratch: string;
    readonly content: string;
    readonly receipts: string;
  };
};

export function layout(root: string): Layout {
  const data = join(root, 'data');
  return {
    root,
    project: join(root, 'project'),
    remote: join(root, 'remote.git'),
    data,
    store: join(data, STORE_FILE),
    github: join(root, 'github.json'),
    ledger: join(root, 'ledger.jsonl'),
    spawns: join(root, 'spawns'),
    hooks: join(root, '.empty-hooks'),
    paths: {
      worktrees: join(data, 'worktrees'),
      markers: join(data, 'owners'),
      intents: join(data, 'intents'),
      scratch: join(data, 'scratch'),
      content: join(data, 'content'),
      receipts: join(data, 'receipts'),
    },
  };
}

function gitEnv(root: string): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@x',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@x',
    GIT_AUTHOR_DATE: '@1800000000 +0000',
    GIT_COMMITTER_DATE: '@1800000000 +0000',
  };
}

/** Plain git for the test's own setup and checks; throws on failure. */
export function sh(lay: Layout, cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    env: gitEnv(lay.root),
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

export function remoteHead(lay: Layout, branch: string): string | null {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: lay.remote,
    env: gitEnv(lay.root),
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Ref updates of `branch` on the bare remote: one per push that moved it. */
export function remotePushes(lay: Layout, branch: string): number {
  const r = spawnSync('git', ['reflog', 'show', '--format=%H', `refs/heads/${branch}`, '--'], {
    cwd: lay.remote,
    env: gitEnv(lay.root),
    encoding: 'utf8',
  });
  return r.status === 0
    ? r.stdout
        .trim()
        .split('\n')
        .filter((l) => l !== '').length
    : 0;
}

/** A project with one commit on `main` and its bare remote, which logs every ref update. */
export function createRepos(lay: Layout): string {
  mkdirSync(lay.hooks, { recursive: true });
  sh(lay, lay.root, 'init', '-q', '-b', 'main', lay.project);
  writeFileSync(join(lay.project, 'a.txt'), 'hello\n');
  sh(lay, lay.project, 'add', '-A');
  sh(lay, lay.project, 'commit', '-qm', 'init');
  sh(lay, lay.root, 'clone', '-q', '--bare', lay.project, lay.remote);
  sh(lay, lay.remote, 'config', 'core.logAllRefUpdates', 'always');
  return sh(lay, lay.project, 'rev-parse', 'HEAD');
}

function gitRunner(lay: Layout): GitCommandRunner {
  return new GitCommandRunner({
    git: GIT_BIN,
    emptyHooksDir: lay.hooks,
    safeDirectories: [lay.root],
    credentialHelper: null,
    home: lay.root,
    protocols: ['file'],
    env: { ...process.env, ...gitEnv(lay.root) },
    passEnv: [],
  });
}

// ---- GitHub kept in a file ----

export function loadGitHub(lay: Layout): FakeGitHub {
  const gh = new FakeGitHub();
  if (existsSync(lay.github))
    gh.restore(JSON.parse(readFileSync(lay.github, 'utf8')) as FakeGitHubState);
  return gh;
}

/** temp → rename: a kill never leaves half a GitHub behind. */
export function saveGitHub(lay: Layout, gh: FakeGitHub): void {
  const tmp = `${lay.github}.tmp`;
  writeFileSync(tmp, JSON.stringify(gh.snapshot()));
  renameSync(tmp, lay.github);
}

const pathShape = (path: string): string =>
  path
    .replace(/^repos\/[^/]+\/[^/]+\/?/, '')
    .replace(/[0-9a-f]{40}/g, ':sha')
    .replace(/\/\d+/g, '/:n');

/** The fake answers from the file and writes its new state back before the answer returns. */
function fileGitHub(lay: Layout, sw: KillSwitch): GitHubPort {
  return {
    request: async (req) => {
      const gh = loadGitHub(lay);
      gh.headOf = (branch) => {
        const sha = remoteHead(lay, branch);
        if (sha !== null && !gh.checks.has(sha))
          gh.checks.set(sha, { build: 'success', test: 'success' });
        return sha;
      };
      const write = req.method !== 'GET';
      const key = `github:${req.method} ${pathShape(req.path)}`;
      sw.hit(`${key}:before`, write ? 'before_effect' : 'read');
      const r = await gh.request(req);
      saveGitHub(lay, gh);
      // An answer GitHub gave (a write done, or a merge or CI state read) that nothing recorded yet.
      sw.hit(`${key}:after`, 'after_external');
      return r;
    },
  };
}

// ---- the daemon's handlers ----

export const CONTENT = {
  commit_message: 'Add name search\n\nSearch tasks by name.',
  pr_title: 'Add name search',
  pr_body: '## Summary\nSearch by name.',
};

const passthrough: SandboxProvider = {
  provider: 'bwrap',
  plan: (l, command) =>
    ok({
      isolation_mode: 'isolated',
      provider: 'bwrap',
      role: l.role,
      argv: [...command],
      cwd: l.worktree,
      env: { PATH: '/usr/bin:/bin' },
      network: 'internet_outbound',
      mount_sources: [],
      layout_digest: hashText(l.role),
      layout_shape: hashText(l.role),
      proof_refs: [],
    }),
};

const SEARCH_TS = 'export const search = (q: string) => q;\n';

function harnesses(lay: Layout, taskId: string, sw: KillSwitch): Record<string, HarnessPort> {
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
  const approve = {
    kind: 'result' as const,
    value: {
      schema_version: 1,
      verdict: 'approve',
      summary: 'looks right',
      findings: [],
    },
  };
  const reviewer = new FakeHarness({ reviewer: [approve, approve] }, 'codex');
  const guarded = (h: HarnessPort, before?: HarnessPort['run']) => ({
    harness: h.harness,
    manifest: h.manifest,
    run: async (...a: Parameters<HarnessPort['run']>) => {
      sw.hit(`harness:${h.harness}:before`, 'before_effect');
      const out = await (before ?? h.run.bind(h))(...a);
      sw.hit(`harness:${h.harness}:after`, 'after_external');
      return out;
    },
  });
  return {
    // The fake model edits the worktree and writes its commit/PR content where it was told to.
    claude: guarded(coder, (input, signal) => {
      writeFileSync(join(lay.paths.worktrees, taskId, 'search.ts'), SEARCH_TS);
      const m = /as JSON \{[^}]*\} to (\S+\.json)\./.exec(input.context.text);
      if (m !== null) writeFileSync(m[1] as string, JSON.stringify(CONTENT));
      return coder.run(input, signal);
    }),
    codex: guarded(reviewer),
  };
}

export type FlowTarget =
  | { readonly pending: EffectKind; readonly step?: string }
  | { readonly status: TaskStatus }
  | { readonly idle: true };

export type Clock = { t: number };

/** The daemon of one life: its handlers and dispatcher on `store`, every outside call behind `sw`. */
export function flowDaemon(
  lay: Layout,
  store: Store,
  sw: KillSwitch,
  clock: Clock,
  taskId: string,
): Dispatcher {
  const real = gitRunner(lay);
  const git: GitPort = {
    run: async (req) => {
      const op = req.args[0] ?? '';
      const mutating = op === 'update-ref' || op === 'push';
      sw.hit(`git:${op}:before`, mutating ? 'before_effect' : 'read');
      const r = await real.run(req);
      sw.hit(`git:${op}:after`, mutating ? 'after_external' : 'read');
      return r;
    },
  };
  const spawn = new SpawnExecutor();
  const executor: CommandExecutor = {
    run: async (plan, opts) => {
      const command = plan.argv.at(-1) ?? '';
      sw.hit(`exec:${command}:before`, 'before_effect');
      const r = await spawn.run(plan, opts);
      sw.hit(`exec:${command}:after`, 'after_external');
      return r;
    },
  };
  const c = { now: () => clock.t as EpochMs, monotonic: () => clock.t };
  let dispatcher: Dispatcher | null = null;
  const handlers = buildHandlers({
    dataDir: lay.data,
    store,
    git,
    github: () => fileGitHub(lay, sw),
    harnesses: harnesses(lay, taskId, sw),
    sandbox: passthrough,
    executor,
    clock: c,
    redactor: new Redactor(),
    newId: uuidv7,
    paths: lay.paths,
    committer: { name: 'Cuesura', email: 'cusr@invalid' },
    remoteUrl: () => lay.remote,
    abort: (id) => dispatcher?.abort(id) ?? false,
    settled: (id) => dispatcher?.settled(id) ?? Promise.resolve(),
    stopLocal: (id) => stopOperationProcesses(lay.data, id),
  });
  // Marks as the daemon writes them, so recovery and local stops read the same evidence it would.
  dispatcher = new Dispatcher({
    store,
    clock: c,
    handlers,
    newId: uuidv7,
    marks: {
      write: (id) => writeOperationMark(lay.data, id),
      clear: (id) => clearOperationMark(lay.data, id),
    },
  });
  return dispatcher;
}

function reached(store: Store, taskId: string, target: FlowTarget): boolean {
  if ('idle' in target) return false;
  const s = store.readTask(taskId as Uuid);
  if (s === null) return false;
  if ('status' in target) return s.status === target.status;
  return Object.values(s.effects).some(
    (e) =>
      e.kind === target.pending &&
      e.status === 'pending' &&
      (target.step === undefined || e.step === target.step),
  );
}

/**
 * The loop cusrd runs, one round at a time: grant the slot, release dependents, run a drain round for a
 * merged task, then dispatch. Stops before dispatching once `target` holds, or after three idle rounds.
 */
export const HELD_WAIT_MS = 60_000;

export async function driveFlow(
  store: Store,
  dispatcher: Dispatcher,
  clock: Clock,
  taskId: string,
  target: FlowTarget,
  sw: KillSwitch,
  /**
   * While startup left new work held, repeats recovery as the running daemon does each second, until it
   * resolves or {@link HELD_WAIT_MS} runs out; returns whether work is still held. A process of this user
   * that the scan cannot read (ssh, sudo) holds it only for as long as it lives.
   */
  followHeld?: () => Promise<boolean>,
): Promise<'reached' | 'idle'> {
  let idle = 0;
  const heldUntil = Date.now() + HELD_WAIT_MS;
  while (followHeld !== undefined && (await followHeld())) {
    if (Date.now() >= heldUntil) return 'idle';
    await new Promise((r) => setTimeout(r, 200));
  }
  for (let i = 0; i < 80; i++) {
    const s = store.readTask(taskId as Uuid);
    if (s?.wait?.detail['code'] === 'execution_slot')
      store.grantNext(clock.t as EpochMs, [uuidv7(), uuidv7(), uuidv7()]);
    notifyDependents(store, clock.t);
    let drained = false;
    for (const id of drainingTasks(store)) {
      sw.hit('drain:round:before', 'before_effect');
      const before = store.readTask(id as Uuid)?.version;
      await drainRound(
        {
          store,
          process: {
            launch: () => Promise.reject(new Error('no launch in a drain')),
            inspect: (op) =>
              Promise.resolve({
                unit: `cusr-op-${op}.service`,
                state: 'not_found' as const,
                invocation_id: null,
                cgroup: null,
              }),
            stop: () => Promise.resolve('not_running' as const),
          },
          clock: { now: () => clock.t as EpochMs, monotonic: () => clock.t },
        },
        id,
      );
      drained ||= store.readTask(id as Uuid)?.version !== before;
    }
    if (reached(store, taskId, target)) return 'reached';
    const r = dispatcher.tick();
    await dispatcher.settle();
    clock.t += 1_000;
    idle = r.started.length === 0 && !drained ? idle + 1 : 0;
    if (idle >= 3) break;
  }
  return 'idle';
}

// ---- one daemon life ----

export type LifeArgs = {
  readonly group: Group;
  readonly root: string;
  readonly life: number;
  readonly now: number;
  readonly kill: KillPoint | null;
  readonly task_id: string;
  /** flow groups: where the life stops. */
  readonly target?: FlowTarget;
  /** spawn_adoption: the runner entrypoint and the harness it spawns. */
  readonly runner?: readonly string[];
  readonly argv?: readonly string[];
  /** output_ack */
  readonly operation_id?: string;
  readonly limits?: FileLimits;
  readonly batch_records?: number;
};

export type LifeRun = {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

export function runLife(child: string, args: LifeArgs): LifeRun {
  const file = join(args.root, `life-${args.life}.json`);
  writeFileSync(file, JSON.stringify(args));
  const r = spawnSync(process.execPath, [child, file], {
    env: { ...process.env, CUSR_CRASH_AT: '', CUSR_CRASH_AFTER: '' },
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (r.error) throw r.error;
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

// ---- evidence ----

export type Committed = {
  readonly integrity: string;
  readonly verified: boolean;
  readonly mismatches: number;
  /** Digest of every event row, by global_seq. */
  readonly events: readonly string[];
  readonly digest: string;
};

/** The store as a dead daemon left it: integrity, every projection replayed from the log, the log. */
export function committedOf(
  db: {
    pragma: (s: string, o: { simple: true }) => unknown;
    prepare: (s: string) => { all: () => unknown[] };
  },
  verify: () => { ok: boolean; mismatches: readonly unknown[] },
): Committed {
  const integrity = String(db.pragma('integrity_check', { simple: true }));
  const v = verify();
  const rows = db.prepare('SELECT * FROM events ORDER BY global_seq').all();
  const accepted = db
    .prepare(
      'SELECT dedup_key, request_hash, outcome_json FROM accepted_triggers ORDER BY dedup_key',
    )
    .all();
  return {
    integrity,
    verified: v.ok,
    mismatches: v.mismatches.length,
    events: rows.map((r) => hashText(canonicalJson(r))),
    digest: hashText(canonicalJson({ events: rows, accepted })),
  };
}

export const runFile = (runDir: string, f: keyof typeof RUN_FILES): string =>
  join(runDir, RUN_FILES[f]);

/** Template task used by every flow group. */
export type FlowTemplate = {
  readonly task: CanonicalTask;
  readonly dependent: CanonicalTask | null;
  readonly base: string;
  readonly branch: string;
  readonly now: number;
};
