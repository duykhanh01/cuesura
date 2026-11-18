/**
 * Opt-in smoke tests require CUSR_SMOKE_REAL and can consume model usage or write to the
 * configured sandbox repositories. A skipped real scenario remains unverified; local rehearsals do
 * not replace it.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { parse } from 'yaml';
import { STORE_FILE } from '../../src/daemon/main.ts';
import { z } from 'zod';
import {
  PROJECT_KINDS,
  redGateTaskFile,
  repoDir,
  SANDBOX_PROJECT,
  SmokeDriver,
  taskFile,
  type Envelope,
  type HistoryEvent,
  type ProjectKind,
  type RunChoice,
} from './smoke.ts';

const Direction = z
  .object({
    /** User config whose role bindings make this direction's worker and reviewer. */
    config: z.string().startsWith('/'),
    data_dir: z.string().startsWith('/'),
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    run: z
      .object({
        profile: z.string(),
        mode: z.enum(['direct-pr', 'full-review']),
        worker: z.string(),
        reviewer: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const RealSmokeSchema = z
  .object({
    /** One line on who approved this spend and its cap; copied to the ledger, enforced by the operator. */
    approval: z.string().min(1),
    /** Appended with each scenario's URLs, SHAs and config for the acceptance report. */
    ledger: z.string().startsWith('/'),
    node: Direction,
    python: Direction,
  })
  .strict();
export type RealSmoke = z.infer<typeof RealSmokeSchema>;

/** The operator's file, or null when the real half was not asked for; a bad file is an error, not a skip. */
export function loadRealSmoke(env: NodeJS.ProcessEnv = process.env): RealSmoke | null {
  const file = env['CUSR_SMOKE_REAL'];
  if (file === undefined || file === '') return null;
  return RealSmokeSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

const dist = (name: string): string =>
  fileURLToPath(new URL(`../../dist/cli/${name}.js`, import.meta.url));

export class RealRun extends SmokeDriver {
  readonly smoke: RealSmoke;
  readonly kind: ProjectKind;
  readonly direction: z.infer<typeof Direction>;
  #child: ChildProcess | null = null;
  #stderr = '';

  constructor(smoke: RealSmoke, kind: ProjectKind) {
    super();
    this.smoke = smoke;
    this.kind = kind;
    this.direction = smoke[kind];
  }

  protected override logTail(): string {
    return this.#stderr.slice(-2000);
  }

  override cli(...argv: string[]): Promise<{ code: number; env: Envelope }> {
    const r = spawnSync(
      process.execPath,
      [dist('cusr'), ...argv, '--data-dir', this.direction.data_dir, '--json'],
      { encoding: 'utf8', timeout: 60_000 },
    );
    return Promise.resolve({
      code: r.status ?? 3,
      env: JSON.parse(r.stdout) as Envelope,
    });
  }

  protected daemonEntry(): string {
    return dist('cusrd');
  }

  /** The daemon in the foreground of this process, as `cusrd --config`. */
  async startDaemon(): Promise<void> {
    const child = spawn(
      process.execPath,
      [
        this.daemonEntry(),
        '--config',
        this.direction.config,
        '--data-dir',
        this.direction.data_dir,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    this.#child = child;
    // Readiness is this child's alone: the log keeps the lines of every daemon before it.
    let own = '';
    await new Promise<void>((resolve, reject) => {
      child.stderr?.on('data', (d: Buffer) => {
        own += d.toString();
        this.#stderr += d.toString();
        if (own.includes('listening on')) resolve();
      });
      child.once('exit', (code) => reject(new Error(`cusrd exited ${code}: ${this.#stderr}`)));
    });
  }

  async stopDaemon(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    this.#child = null;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.removeAllListeners('exit');
    const gone = new Promise((r) => child.once('exit', r));
    child.kill(signal);
    await gone;
  }

  addTask(): Promise<string> {
    const run: RunChoice = this.direction.run;
    return this.addAndConfirm(taskFile(this.kind), run);
  }

  /** No reviewer: the scenario is about the gate, and each call spends usage. */
  addRedGateTask(): Promise<string> {
    return this.addAndConfirm(redGateTaskFile(this.kind), {
      ...this.direction.run,
      mode: 'direct-pr',
      reviewer: null,
    });
  }

  /** The PR as GitHub itself reports it, not as the daemon recorded it; only on this direction's repo. */
  pull(prRef: string): {
    state: string;
    merged: boolean;
    head_sha: string;
    merge_commit_sha: string | null;
  } {
    const pr = ghJson(
      `repos/${this.direction.repo}/pulls/${prNumber(prRef, this.direction.repo)}`,
    ) as {
      state: string;
      merged: boolean;
      merge_commit_sha: string | null;
      head: { sha: string };
    };
    return {
      state: pr.state,
      merged: pr.merged,
      head_sha: pr.head.sha,
      merge_commit_sha: pr.merged ? pr.merge_commit_sha : null,
    };
  }

  /**
   * Before the daemon starts, read offline: the config names only this direction's sandbox project and data
   * dir and leaves merging to the operator; the data dir holds no task a daemon would resume; GitHub says the
   * repo is a private sandbox. Anything else stops the run unspent.
   */
  assertSafeStart(): void {
    const config = configProblem(
      readFileSync(this.direction.config, 'utf8'),
      this.kind,
      this.direction,
    );
    if (config !== null) throw new Error(`${this.direction.config}: ${config}`);
    const left = unfinishedTasks(this.direction.data_dir);
    if (left.length > 0)
      throw new Error(
        `${this.direction.data_dir} has tasks a daemon would resume: ${left.join(', ')}`,
      );
    const repo = ghJson(`repos/${this.direction.repo}`) as {
      full_name: string;
      private: boolean;
      name: string;
    };
    const problem = sandboxProblem(this.direction.repo, repo);
    if (problem !== null) throw new Error(problem);
  }

  /** GitHub's check runs on `head`, read only. */
  checkRuns(head: string): CheckRun[] {
    const r = ghJson(`repos/${this.direction.repo}/commits/${head}/check-runs?per_page=100`) as {
      check_runs: CheckRun[];
    };
    return r.check_runs;
  }

  /** Every attempt the task's history asked for. */
  async attempts(id: string): Promise<Attempt[]> {
    return attemptsOf(await this.history(id));
  }

  record(scenario: string, facts: Record<string, unknown>): void {
    appendFileSync(
      this.smoke.ledger,
      `${JSON.stringify({
        at: new Date().toISOString(),
        scenario,
        kind: this.kind,
        repo: this.direction.repo,
        run: this.direction.run,
        approval: this.smoke.approval,
        ...facts,
      })}\n`,
    );
  }
}

export const REAL_KINDS = PROJECT_KINDS;

function ghJson(path: string): unknown {
  const r = spawnSync('gh', ['api', path], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`gh api ${path}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** The number of a PR reference, which must be on `repo`: a PR elsewhere is never read or acted on. */
export function prNumber(prRef: string, repo: string): number {
  const m = /^([^#\s]+)#(\d+)$/.exec(prRef);
  if (m === null || m[1] !== repo) throw new Error(`${prRef} is not a PR of ${repo}`);
  return Number(m[2]);
}

/** Why a direction's user config is not safe to start a daemon on, or null. */
export function configProblem(
  text: string,
  kind: ProjectKind,
  direction: { readonly repo: string; readonly data_dir: string },
): string | null {
  const config = parse(text) as {
    projects?: Record<string, { repo?: string }>;
    runtime?: { data_dir?: string };
    yolo?: unknown;
  };
  // With yolo on, the daemon merges a green PR itself instead of waiting for the operator.
  if (config.yolo !== undefined && config.yolo !== false) return 'yolo must be off';
  const projects = Object.entries(config.projects ?? {});
  if (projects.length !== 1 || config.projects?.[SANDBOX_PROJECT[kind]]?.repo !== direction.repo)
    return `must hold only ${SANDBOX_PROJECT[kind]} on ${direction.repo}, has ${JSON.stringify(projects.map(([id, p]) => `${id}:${p.repo}`))}`;
  if (config.runtime?.data_dir !== direction.data_dir)
    return `keeps its data in ${config.runtime?.data_dir}, not ${direction.data_dir}`;
  return null;
}

/** Tasks of a data dir that are not terminal, read from its store file without a daemon; none if it has none. */
export function unfinishedTasks(dataDir: string): string[] {
  const file = join(dataDir, STORE_FILE);
  if (!existsSync(file)) return [];
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return (
      db
        .prepare("SELECT id FROM tasks WHERE status NOT IN ('DONE', 'FAILED', 'CANCELLED')")
        .all() as { id: string }[]
    ).map((r) => r.id);
  } finally {
    db.close();
  }
}

/** Why `repo` is not a sandbox to write to, or null. */
export function sandboxProblem(
  repo: string,
  github: { full_name: string; private: boolean; name: string },
): string | null {
  if (github.full_name !== repo) return `${repo} is ${github.full_name} on GitHub`;
  if (!github.private) return `${repo} is public`;
  if (!/sandbox/.test(github.name)) return `${repo} is not named as a sandbox`;
  return null;
}

export type CheckRun = {
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
};

/** The checks the fixture project's CI must pass, from its `cusr.yaml`. */
export function requiredChecks(kind: ProjectKind): string[] {
  const cusr = parse(readFileSync(join(repoDir(kind), 'cusr.yaml'), 'utf8')) as {
    ci: { required_checks: string[] };
  };
  return cusr.ci.required_checks;
}

/**
 * Why `head` is not green, or null: every required check has a run on that very head and the latest of each
 * succeeded. A missing check, a run on another head or an empty list is not green.
 */
export function notGreen(
  runs: readonly CheckRun[],
  head: string,
  required: readonly string[],
): string | null {
  if (required.length === 0) return 'no required checks';
  for (const name of required) {
    const own = runs.filter((r) => r.name === name && r.head_sha === head);
    if (own.length === 0) return `no ${name} run on ${head}`;
    const bad = own.find((r) => r.conclusion !== 'success');
    if (bad !== undefined) return `${name} is ${bad.status}/${bad.conclusion} on ${head}`;
  }
  return null;
}

/** Why a task is not DONE on a verified merge of `head`, or null. */
export function notVerifiedDone(task: Record<string, unknown>, head: string): string | null {
  if (task['status'] !== 'DONE') return `status ${String(task['status'])}`;
  const c = task['completion'] as {
    merged_head_sha?: string;
    checked_head_sha?: string;
    merge_commit_sha?: string;
    unverified?: unknown;
  } | null;
  if (c === null || c === undefined) return 'no completion';
  if (c.checked_head_sha !== head || c.merged_head_sha !== head)
    return `checked ${c.checked_head_sha}, merged ${c.merged_head_sha}, expected ${head}`;
  if (c.unverified !== null) return `unverified: ${JSON.stringify(c.unverified)}`;
  if (!/^[0-9a-f]{40}$/.test(c.merge_commit_sha ?? '')) return 'no merge commit';
  return null;
}

export type Attempt = { readonly step: string; readonly binding: string };

export function attemptsOf(events: readonly HistoryEvent[]): Attempt[] {
  return events
    .filter((e) => e.type === 'AttemptRequested')
    .map((e) => ({ step: String(e.payload['step']), binding: String(e.payload['binding']) }));
}

type Binding = { harness: string; model: string; effort: string };
/** The worker's vendor for each direction; the reviewer is the other one. */
export const WORKER_HARNESS: Readonly<Record<ProjectKind, 'claude' | 'codex'>> = {
  node: 'claude',
  python: 'codex',
};
const WORKER_STEPS = ['code', 'fix_gates', 'fix_review', 'fix_minor', 'ci_fix'];

/**
 * Why a task did not run as its cell of the T079 matrix, or null: the confirmed selection has this
 * direction's worker vendor and, in `full-review` only, the other vendor reviewing; and every worker and
 * review attempt of its history ran on that very binding, so no fallback stands in for the vendor.
 */
export function matrixProblem(
  kind: ProjectKind,
  mode: 'direct-pr' | 'full-review',
  selection: { mode: string; worker: Binding; reviewer: Binding | null },
  attempts: readonly Attempt[],
): string | null {
  const worker = WORKER_HARNESS[kind];
  const reviewer = worker === 'claude' ? 'codex' : 'claude';
  if (selection.mode !== mode) return `mode ${selection.mode}`;
  if (selection.worker.harness !== worker) return `worker ${selection.worker.harness}`;
  if (mode === 'direct-pr' ? selection.reviewer !== null : selection.reviewer?.harness !== reviewer)
    return `reviewer ${JSON.stringify(selection.reviewer)}`;
  const bound = (b: Binding): string => `${b.model}/${b.effort}`;
  const work = attempts.filter((a) => WORKER_STEPS.includes(a.step));
  const review = attempts.filter((a) => a.step === 'review');
  if (work.length === 0) return 'no worker attempt';
  const off = work.find((a) => a.binding !== bound(selection.worker));
  if (off !== undefined) return `${off.step} ran on ${off.binding}`;
  if (selection.reviewer === null) return review.length === 0 ? null : 'a review in direct-pr';
  if (review.length === 0) return 'no review attempt';
  const r = selection.reviewer;
  const offReview = review.find((a) => a.binding !== bound(r));
  return offReview === undefined ? null : `review ran on ${offReview.binding}`;
}
