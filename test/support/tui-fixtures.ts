import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { CUSR_COMMANDS } from '../../src/cli/commands.ts';
import { CONTROL_SOCKET } from '../../src/cli/output.ts';
import { runCli } from '../../src/cli/program.ts';
import type { CanonicalTask } from '../../src/domain/task.ts';
import { buildTask, freezeOk, uuidOf } from './builders.ts';
import { FileContentStore } from '../../src/adapters/publish-content.ts';
import { ingestOperationSpool } from '../../src/daemon/ingest.ts';
import { runLocation } from '../../src/daemon/retention.ts';
import { DETAIL_CODES, type OperationMirror } from '../../src/domain/state.ts';
import { EventLogWriter, RunDir, type FileLimits } from '../../src/runner/files.ts';
import { Redactor } from '../../src/runner/redact.ts';
import type { EpochMs, Uuid } from '../../src/shared/brand.ts';
import { openFileStoreForTest, storeDb } from '../../src/store/testing.ts';
import { STORE_FILE } from '../../src/daemon/main.ts';
import { PACKS } from './config-fixtures.ts';
import { ControlProxy } from './control-proxy.ts';
import { SeededDaemon, type Reply } from './daemon-task.ts';
import { fakeGit, fakeGitHub, fakeHost, MANIFESTS, userConfig } from './preflight-fakes.ts';
import { KEY, PtySession } from './pty.ts';
import { createGrantStart, proposeAndConfirm, selectionFor } from './runtime.ts';
import { agentData, ciData, gatesData, PREPARE_DATA, publishData, USAGE } from './scenario.ts';
import type { StoreDriver } from './store-driver.ts';
import { checkpointGates, createAndStart, toPublish, WALL, reviewToCi } from './store-flows.ts';

// What the US1 tests share: a real daemon seeded through the real store, `cusr` on a real PTY, and the CLI
// to compare the screen with.

/** Tall and wide enough that nothing a test compares scrolls away or gets cut. */
export const ROOMY = { cols: 140, rows: 60 } as const;

const HEAD = 'a'.repeat(40);

type DaemonOptions = {
  /** Extra project names in the user config, next to `acme`. */
  readonly projects?: readonly string[];
  /** Serves `task_recheck`; `observed` is called once for each time the PR is really read. */
  readonly recheck?: { readonly observed: () => void | Promise<void> };
};

type CusrOptions = {
  readonly cols?: number;
  readonly rows?: number;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
};

/** Registers cleanup for the file's tests and hands out what they need. */
export function useTui() {
  const sessions: PtySession[] = [];
  const daemons: SeededDaemon[] = [];
  const proxies: ControlProxy[] = [];
  const answering: AnsweringServer[] = [];
  afterEach(async () => {
    for (const s of sessions.splice(0)) s.dispose();
    for (const p of proxies.splice(0)) await p.stop();
    for (const a of answering.splice(0)) await a.stop();
    for (const d of daemons.splice(0)) await d.cleanup();
  });
  return {
    /** A stopped daemon to seed and start. Its clock reads now, so a time in status means something. */
    daemon(o: DaemonOptions = {}): SeededDaemon {
      const lines = ['acme', ...(o.projects ?? [])].map(
        (id) => `${id}: { base_branch: main, path: /srv/${id}, repo: acme/${id} }`,
      );
      // Seeded operations have no real runner unit; asking the host's systemd would make recovery depend
      // on whether a user bus is reachable.
      const noUnit = {
        inspectUnit: (id: string) =>
          Promise.resolve({
            unit: `cusr-${id}.service`,
            state: 'not_found' as const,
            invocation_id: null,
            cgroup: null,
          }),
      };
      let ids = 0;
      const sd: SeededDaemon = new SeededDaemon(noUnit, (store) => ({
        ...(o.recheck === undefined
          ? {}
          : {
              observe: async () => {
                await o.recheck?.observed();
                return { facts: [], failure: null };
              },
              drain: () => Promise.resolve(null),
              newId: () => uuidOf(9_000 + ids++),
            }),
        logs: { dataDir: sd.dataDir, redactor: new Redactor() },
        confirm: {
          store,
          ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
          configInputs: () =>
            Promise.resolve({
              user: userConfig({ project: lines.join('\n  ') }),
              packs: PACKS,
              manifests: MANIFESTS,
            }),
          now: () => sd.clock.now(),
        },
      }));
      sd.now = Date.now();
      daemons.push(sd);
      return sd;
    },
    cusr(dataDir: string, o: CusrOptions = {}): PtySession {
      const s = new PtySession({
        cols: o.cols ?? ROOMY.cols,
        rows: o.rows ?? ROOMY.rows,
        ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
        env: { CUSR_DATA_DIR: dataDir, CUSR_ACTOR: undefined, ...o.env },
      });
      sessions.push(s);
      return s;
    },
    async proxy(target: string): Promise<ControlProxy> {
      const p = await ControlProxy.start(target);
      proxies.push(p);
      return p;
    },
    async answering(body: string): Promise<AnsweringServer> {
      const a = await AnsweringServer.start(body);
      answering.push(a);
      return a;
    },
  };
}

/**
 * Answers every request with the same body: a daemon of another version, which no real daemon of this one
 * can play. A proxy retargeted here shows the client what such a daemon looks like over the socket.
 */
export class AnsweringServer {
  readonly socketPath: string;
  readonly #dir: string;
  readonly #server: Server;

  private constructor(dir: string, body: string) {
    this.#dir = dir;
    this.socketPath = join(dir, CONTROL_SOCKET);
    this.#server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(body);
      });
    });
  }

  static async start(body: string): Promise<AnsweringServer> {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-answering-')));
    const server = new AnsweringServer(dir, body);
    await new Promise<void>((resolve, reject) => {
      server.#server.once('error', reject);
      server.#server.listen(server.socketPath, resolve);
    });
    return server;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    rmSync(this.#dir, { recursive: true, force: true });
  }
}

/** The socket of a running daemon, for a proxy to point at. */
export function daemonSocket(sd: SeededDaemon): string {
  if (sd.daemon === null) throw new Error('daemon not running');
  return sd.daemon.socketPath;
}

export function taskAdd(n: number, title: string): Record<string, unknown> {
  return {
    request_id: uuidOf(5_000 + n),
    kind: 'task_add',
    project: 'acme',
    task_id: null,
    expected_version: null,
    payload: { task: { title, base_branch: 'main', acceptance: ['a'] } },
  };
}

/** Cancels through the daemon, as the CLI does; the status changes by the daemon's hand. */
export async function cancelTask(sd: SeededDaemon, taskId: string, n: number): Promise<Reply> {
  const shown = await sd.query('owner', { kind: 'task_show', task_id: taskId });
  return sd.command('owner', {
    request_id: uuidOf(6_000 + n),
    kind: 'task_cancel',
    project: 'acme',
    task_id: taskId,
    expected_version: shown.envelope.data?.['version'],
    payload: { reason: 'stop' },
  });
}

/** The attempt in the banner, or 0 when there is none. */
export function reconnectAttempt(screen: string): number {
  return Number(/Reconnecting \((\d+)\/30\)/.exec(screen)?.[1] ?? 0);
}

export type CliRun = {
  readonly code: number;
  readonly envelope: {
    readonly ok: boolean;
    readonly data?: Record<string, unknown>;
  };
};

/** The real CLI against the same daemon, for what the screen is compared with. */
export async function cliJson(sd: SeededDaemon, ...argv: string[]): Promise<CliRun> {
  let out = '';
  const code = await runCli(
    { name: 'cusr', description: '', version: '0' },
    [...argv, '--data-dir', sd.dataDir, '--json'],
    { stdout: (t) => (out += t), stderr: () => undefined },
    CUSR_COMMANDS,
  );
  return { code, envelope: JSON.parse(out) as CliRun['envelope'] };
}

export async function watermark(sd: SeededDaemon): Promise<number> {
  const r = await sd.query('owner', { kind: 'task_board', limit: 1 });
  return r.envelope.data?.['watermark'] as number;
}

/** Tasks to fill a list with: running, so none of them belongs in `Needs you`. */
export function seedRunning(
  d: StoreDriver,
  count: number,
  over: (n: number) => Partial<CanonicalTask> = () => ({}),
  from = 1,
): CanonicalTask[] {
  return Array.from({ length: count }, (_, i) => {
    const n = from + i;
    const t = buildTask({
      id: uuidOf(n),
      title: `Task ${String(n).padStart(3, '0')}`,
      ...over(n),
    });
    createAndStart(d, t);
    return t;
  });
}

function toCode(d: StoreDriver, t: CanonicalTask): void {
  createAndStart(d, t);
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
}

function toGates(d: StoreDriver, t: CanonicalTask): void {
  toCode(d, t);
  d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
}

function toReview(d: StoreDriver, t: CanonicalTask): void {
  toGates(d, t);
  d.complete(
    t.id,
    d.pendingOne(t.id, 'run_gates').id,
    'succeeded',
    gatesData({ build: true, unit: true }),
  );
}

/** Through the execution slot up to the first read of CI. */
function toCi(d: StoreDriver, t: CanonicalTask): void {
  createGrantStart(d, t);
  toPublish(d, t, HEAD);
  d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(HEAD));
  d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
    pr_ref: `acme#${t.id.slice(-2)}`,
    head_sha: HEAD,
  });
  reviewToCi(d, t.id);
}

/** A task stopped on the agent's question: the daemon says it needs the user. */
export function seedQuestion(d: StoreDriver, t: CanonicalTask): void {
  toCode(d, t);
  d.complete(
    t.id,
    d.pendingOne(t.id, 'start_agent').id,
    'succeeded',
    agentData('needs_input', { questions: ['Which database?'] }),
  );
}

/** A task on `escalation`: two quality failures, so the next rung waits for an admin. */
export function seedEscalation(d: StoreDriver, t: CanonicalTask): void {
  d.must(t.id, { kind: 'create_task', task: t });
  d.must(t.id, {
    kind: 'start',
    freeze: freezeOk(t, {
      limits: { max_wall_ms: WALL },
      roles: {
        coder: {
          model: 'sonnet',
          effort: 'medium',
          ladder: [{ model: 'opus', effort: 'high' }],
        },
      },
    }),
  });
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  for (let i = 0; i < 2; i++)
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
      failure_class: 'quality',
      signature: 'C1',
      invoked: true,
      usage: USAGE,
    });
}

/** One task for each thing US1 scenarios 2 and 3 name. */
export type Sample =
  | 'coding'
  | 'gates'
  | 'review'
  | 'waiting_ci'
  | 'question'
  | 'unconfirmed'
  | 'escalation'
  | 'merge'
  | 'cooldown'
  | 'cancelled';

export function seedEveryState(d: StoreDriver): Readonly<Record<Sample, CanonicalTask>> {
  const make = (n: number, title: string): CanonicalTask => buildTask({ id: uuidOf(n), title });
  const s = {
    coding: make(1, 'Sample coding'),
    gates: make(2, 'Sample gates'),
    review: make(3, 'Sample review'),
    waiting_ci: make(4, 'Sample waiting CI'),
    question: make(5, 'Sample question'),
    unconfirmed: make(6, 'Sample unconfirmed'),
    escalation: make(7, 'Sample escalation'),
    merge: make(8, 'Sample merge'),
    cooldown: make(9, 'Sample cooldown'),
    cancelled: make(10, 'Sample cancelled'),
  };
  toCode(d, s.coding);
  toGates(d, s.gates);
  toReview(d, s.review);

  toCi(d, s.merge);
  d.complete(
    s.merge.id,
    d.pendingOne(s.merge.id, 'await_ci').id,
    'succeeded',
    ciData(HEAD, { build: 'success', test: 'success' }),
  );

  seedQuestion(d, s.question);

  d.must(s.unconfirmed.id, { kind: 'create_task', task: s.unconfirmed });

  seedEscalation(d, s.escalation);

  toCode(d, s.cooldown);
  d.complete(s.cooldown.id, d.pendingOne(s.cooldown.id, 'start_agent').id, 'failed', {
    failure_class: 'rate_limit',
    reset_at: d.now + 60_000,
    invoked: true,
    usage: USAGE,
  });

  toCi(d, s.waiting_ci);
  d.complete(
    s.waiting_ci.id,
    d.pendingOne(s.waiting_ci.id, 'await_ci').id,
    'succeeded',
    ciData(HEAD, { build: 'pending' }),
  );

  d.must(s.cancelled.id, { kind: 'create_task', task: s.cancelled });
  d.must(s.cancelled.id, { kind: 'cancel', reason: 'No longer needed' });
  return s;
}

/** A task that holds the slot and one that waits for it, for the bar's slot and queue. */
export function seedSlotAndQueue(
  d: StoreDriver,
  ids: { readonly holder: number; readonly queued: number },
): { readonly holder: CanonicalTask; readonly queued: CanonicalTask } {
  const holder = buildTask({ id: uuidOf(ids.holder), title: 'Sample holder' });
  const queued = buildTask({ id: uuidOf(ids.queued), title: 'Sample queued' });
  createGrantStart(d, holder);
  d.must(queued.id, { kind: 'create_task', task: queued });
  proposeAndConfirm(d, queued, selectionFor(queued, 'full-review'));
  d.must(queued.id, { kind: 'request_execution' });
  return { holder, queued };
}

/** Both screen lines of the task with this title; throws when it is not there. */
export function rowOf(screen: string, title: string): string {
  const lines = screen.split('\n');
  const at = lines.findIndex((l) => l.includes(title));
  if (at < 0) throw new Error(`no row for ${title}\n${screen}`);
  return `${lines[at] ?? ''}\n${lines[at + 1] ?? ''}`;
}

/** The screen line carrying the selection. */
export function selectedLine(screen: string): string {
  return screen.split('\n').find((l) => l.startsWith('›')) ?? '';
}

// What the US2 tests add.

/**
 * One task per detail code of FR-029 feature 002. Most of these take a long failure story to reach, and what
 * is compared is what the daemon explains from the state, so the wait goes straight into the projection.
 */
export function seedEveryDetailCode(sd: SeededDaemon): readonly string[] {
  sd.seed((d) => {
    DETAIL_CODES.forEach((code, i) => {
      const t = buildTask({ id: uuidOf(100 + i), title: `Code ${code}` });
      d.must(t.id, { kind: 'create_task', task: t });
    });
  });
  const store = openFileStoreForTest(join(sd.dataDir, STORE_FILE));
  const db = storeDb(store);
  try {
    DETAIL_CODES.forEach((code, i) => {
      const id = uuidOf(100 + i);
      const row = db.prepare('SELECT state_json FROM tasks WHERE id = ?').get(id) as {
        state_json: string;
      };
      const state = {
        ...(JSON.parse(row.state_json) as Record<string, unknown>),
        status: 'WAITING',
        wait: {
          reason: 'policy',
          detail: { code, because: `detail of ${code}` },
          resume_when: [],
          exit_paths: [],
          resume: { kind: 'none' },
        },
      };
      db.prepare('UPDATE tasks SET state_json = ?, status = ? WHERE id = ?').run(
        JSON.stringify(state),
        'WAITING',
        id,
      );
    });
  } finally {
    store.close();
  }
  return DETAIL_CODES;
}

/**
 * A task waiting on `worktree_changed` the way the engine puts it there: prepared, then an agent step that
 * finds the tree changed. The daemon accepts a recheck of it, and `task_progress` names its worktree.
 */
export function seedWorktreesChanged(
  sd: SeededDaemon,
  tasks: readonly (readonly [number, string])[],
): string[] {
  const made = tasks.map(([n, title]) => buildTask({ id: uuidOf(n), title }));
  // One seeding for all of them: the driver numbers its ids afresh each time it opens the store.
  sd.seed((d) => {
    for (const t of made) {
      toCode(d, t);
      d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
        failure_class: 'unknown',
        message: 'the worktree changed outside the task since its last step',
        invoked: false,
        worktree: { known: 'a'.repeat(40), observed: 'b'.repeat(40) },
      });
    }
  });
  return made.map((t) => t.id);
}

export const seedWorktreeChanged = (sd: SeededDaemon, n: number, title: string): string =>
  seedWorktreesChanged(sd, [[n, title]])[0] as string;

/** A task through an agent run that reports this usage; `null` leaves the attempt running, so none is known. */
export function seedAgentUsage(
  d: StoreDriver,
  t: CanonicalTask,
  usage: Record<string, unknown> | null,
): void {
  toCode(d, t);
  if (usage === null) return;
  d.complete(
    t.id,
    d.pendingOne(t.id, 'start_agent').id,
    'succeeded',
    agentData('needs_input', { questions: ['More?'], usage }),
  );
}

const GREEN_HEAD = 'a'.repeat(40);

/** Up to a green PR waiting for the user's merge, with what the worker proposed for its merge. */
export function seedGreenPr(
  d: StoreDriver,
  sd: SeededDaemon,
  t: CanonicalTask,
  mode: 'direct-pr' | 'full-review',
  content: { readonly title: string; readonly message: string },
): void {
  createGrantStart(d, t, mode, {}, { merge_method: 'squash' });
  const stored = new FileContentStore(join(sd.base, 'content')).put({
    pr_title: content.title,
    pr_body: 'body',
    commit_message: content.message,
  });
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  d.complete(
    t.id,
    d.pendingOne(t.id, 'start_agent').id,
    'succeeded',
    agentData('done', { content: stored }),
  );
  d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(GREEN_HEAD));
  d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(GREEN_HEAD));
  d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
    pr_ref: 'acme#7',
    head_sha: GREEN_HEAD,
  });
  reviewToCi(d, t.id);
  d.complete(
    t.id,
    d.pendingOne(t.id, 'await_ci').id,
    'succeeded',
    ciData(
      GREEN_HEAD,
      { build: 'success', test: 'success' },
      {},
      {
        required: {
          kind: 'covered',
          github_required: 'none',
          github: [],
          snapshot_only: [],
        },
      },
    ),
  );
}

const LOG_LIMITS: FileLimits = {
  log_record_bytes: 256 * 1024,
  result_bytes: 2048,
  log_segment_bytes: 1024 * 1024,
  spool_bytes: 64 * 1024 * 1024,
};

/**
 * Writes the records of one operation as a runner would and ingests them, so `task_logs` serves them for
 * real. Works on the seeding store and on the running daemon's store alike, so a test can feed an open log.
 */
export class LogFeed {
  readonly #sd: SeededDaemon;
  #ids = 90_000;

  constructor(sd: SeededDaemon) {
    this.#sd = sd;
  }

  /** Claims the effect for operation `op`, once, and appends these records. */
  write(
    d: StoreDriver,
    taskId: string,
    effectId: string,
    op: string,
    kind: 'setup' | 'agent',
    records: readonly unknown[],
  ): void {
    const redactor = new Redactor();
    const known = d.task(taskId).operations[op];
    if (known === undefined) {
      const claimed = d.store.claimEffect(effectId as Uuid, d.now as EpochMs, {
        require_runtime: true,
        operation: {
          operation_id: op,
          kind,
          launch_nonce: `nonce-${op}`,
          unit: `cusr-${op}.service`,
          holds_slot: true,
        },
      });
      if (!claimed.ok) throw new Error(JSON.stringify(claimed.error));
    }
    const dir = RunDir.open({
      dataDir: this.#sd.dataDir,
      ...runLocation(d.task(taskId).operations[op] as OperationMirror),
      redactor,
      limits: LOG_LIMITS,
    });
    const log = EventLogWriter.open(dir, op);
    for (const r of records) {
      const appended = log.append('progress', r);
      if (!appended.ok) throw new Error(appended.error.code);
    }
    log.sync();
    const ingested = ingestOperationSpool(
      {
        store: d.store,
        dataDir: this.#sd.dataDir,
        redactor,
        limits: LOG_LIMITS,
        now: () => d.now,
        newId: () => uuidOf(this.#ids++),
      },
      taskId,
      op,
    );
    if (ingested.status !== 'ingested')
      throw new Error(`ingest of ${op}: ${JSON.stringify(ingested)}`);
  }
}

/** Selects the task with this title on Home and opens it. */
export async function openTask(s: PtySession, title: string): Promise<void> {
  await s.waitForText(title);
  // The time in status at the end of the row ticks by itself; only a move of the selection counts.
  const row = (): string => selectedLine(s.screenText()).replace(/(\s+\d+[smhd])+\s*$/, '');
  for (let i = 0; i < 400; i++) {
    if (row().includes(title)) break;
    const before = row();
    const lines = s.screenText().split('\n');
    const above =
      lines.findIndex((l) => l.includes(title)) < lines.indexOf(selectedLine(s.screenText()));
    s.send(above ? KEY.up : KEY.down);
    await s.waitFor(() => row() !== before, 3_000);
  }
  await enterDetail(s);
  await detailRead(s);
}

/** Enter opens a task on its stages and log; `d` goes on to Task detail. */
export async function enterDetail(s: PtySession): Promise<void> {
  s.send(KEY.enter);
  await s.waitForText('Logs:');
  s.send('d');
  await s.waitForText('Task detail');
}

/** Esc from Task detail comes back to the log under it; Esc again leaves the task for Home. */
export async function leaveTask(s: PtySession): Promise<void> {
  s.send(KEY.esc);
  await s.waitFor(
    () => s.screenText().includes('Logs:') && !s.screenText().includes('Task detail'),
  );
  s.send(KEY.esc);
  await s.waitFor(() => !s.screenText().includes('Logs:'));
}

/** Task detail shows what only whoever digs in needs: codes, commits, attempts and raw history. */
export async function technicalInfo(s: PtySession): Promise<void> {
  s.send('i');
  await s.waitForText('Agents and usage');
}

/** Task detail is on screen with the first reads of what the screen shows in. */
export async function detailRead(s: PtySession): Promise<void> {
  await s.waitForText('Task detail');
  await s.waitFor(
    () => s.screenText().includes('Progress') && !s.screenText().includes('Reading…'),
  );
}

/** The screen as one line, so text that wrapped still compares whole. */
export function flat(screen: string): string {
  return screen.replace(/\s+/g, ' ');
}

/** Opens the Actions menu of the selected task on Home, with `Recheck` listed. */
export async function openActionsMenu(s: PtySession): Promise<void> {
  s.send('a');
  await s.waitForText('Actions — ');
  await s.waitForText('Recheck');
}

/** Moves the Actions selection to `label`, up or down, waiting for each move to show. */
async function selectAction(s: PtySession, label: string): Promise<void> {
  await s.waitForText(label);
  for (let i = 0; i < 10 && !s.screenText().includes(`› ${label}`); i++) {
    const lines = s.screenText().split('\n');
    const at = lines.findIndex((l) => l.startsWith('›'));
    const want = lines.findIndex((l) => l.startsWith(`  ${label}`));
    const before = lines[at] ?? '';
    s.send(want >= 0 && want < at ? KEY.up : KEY.down);
    await s.waitFor(() => selectedLine(s.screenText()) !== before, 5_000);
  }
}

/** Chooses `label` in the open Actions menu and presses Enter. */
export async function pressAction(s: PtySession, label: string): Promise<void> {
  // A dialog opens once the menu has read `task_show` too, which the screen does not show: until then Enter
  // says the task is still being read. Moving clears that, and Enter is pressed again.
  const reading = (): boolean => flat(s.screenText()).includes('this task is still being read');
  for (let i = 0; i < 50; i++) {
    await selectAction(s, label);
    s.send(KEY.enter);
    await s.waitFor(
      () =>
        !s.screenText().includes(`› ${label}`) || /Nothing (was sent|to send)/.test(s.screenText()),
      5_000,
    );
    if (!reading()) return;
    s.send(KEY.down);
    await s.waitFor(() => !reading(), 5_000);
  }
}

/** Opens the Actions menu of the task with this title, once it has read the task. */
export async function openMenuOf(s: PtySession, title: string): Promise<void> {
  await openTask(s, title);
  s.send('a');
  await s.waitForText('Actions — ');
  await s.waitFor(() => /Read at \d\d:\d\d:\d\d/.test(s.screenText()));
}

/**
 * Recheck from the open menu, or from its dialog when that is open already: a plain Recheck is sent with
 * Ctrl-S, which this presses.
 */
export async function sendRecheck(s: PtySession): Promise<void> {
  if (!s.screenText().includes('Ctrl-S sends')) {
    await pressAction(s, 'Recheck');
    await s.waitForText('Ctrl-S sends');
  }
  s.send(KEY.ctrlS);
}

/**
 * A task waiting for a merge, whose Actions menu is open on a PTY behind a proxy that can refuse what the
 * client writes. `sent` lists every `task_recheck` written, refused or not.
 */
export async function recheckScene(tui: ReturnType<typeof useTui>) {
  let observed = 0;
  let hold: Promise<void> | null = null;
  let release: () => void = () => {};
  const sd = tui.daemon({
    recheck: {
      observed: async () => {
        observed++;
        await hold;
      },
    },
  });
  const t = buildTask({ id: uuidOf(1), title: 'Green PR' });
  sd.seed((d) => seedGreenPr(d, sd, t, 'full-review', { title: 'Title', message: 'Message' }));
  await sd.start();
  const proxy = await tui.proxy(daemonSocket(sd));
  const sent: { id: string; body: string }[] = [];
  /** `request_show` looks that reached the proxy. */
  let shows = 0;
  /** How many of the next commands never reach the daemon; `Infinity` for all. */
  const control = {
    refuseCommands: 0,
    refuseShows: false,
    refuseTaskShow: false,
    refuseAll: false,
    /** How many times each admitted `task_recheck` is delivered to the daemon again, once the first is in. */
    replays: 0,
    /** What the daemon answered to each replay. */
    replies: [] as string[],
  };
  proxy.refuse = (request) => {
    const body = request.slice(request.indexOf('\r\n\r\n') + 4);
    if (body.includes('"task_recheck"')) {
      sent.push({ id: /"request_id":"([^"]+)"/.exec(body)?.[1] ?? '', body });
      if (control.refuseCommands > 0) {
        control.refuseCommands -= 1;
        return true;
      }
      for (let i = 0; i < control.replays; i++)
        setTimeout(
          () => void proxy.replay(request).then((reply) => control.replies.push(reply)),
          1_000 + i * 200,
        );
    }
    if (body.includes('"request_show"')) shows += 1;
    return (
      control.refuseAll ||
      (control.refuseShows && body.includes('"request_show"')) ||
      (control.refuseTaskShow && body.includes('"task_show"'))
    );
  };
  const s = tui.cusr(proxy.dataDir);
  await s.waitForText('Green PR');
  await openActionsMenu(s);
  // The first `task_show` must have answered, or Enter says the task is still being read.
  await s.waitFor(() => /Read at \d\d:\d\d:\d\d/.test(s.screenText()));
  await new Promise((r) => setTimeout(r, 300));
  /** Makes the daemon keep the next `task_recheck` in progress: it answers `request_show` but not the command. */
  const holdDaemon = (): void => {
    hold = new Promise<void>((r) => (release = r));
  };
  return {
    sd,
    proxy,
    s,
    sent,
    control,
    observed: () => observed,
    shows: () => shows,
    holdDaemon,
    release: () => release(),
  };
}
