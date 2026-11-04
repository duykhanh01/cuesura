/**
 * Opt-in smoke tests require CUSR_SMOKE_REAL and can consume model usage or write to the
 * configured sandbox repositories. A skipped real scenario remains unverified; local rehearsals do
 * not replace it.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  PROJECT_KINDS,
  redGateTaskFile,
  SmokeDriver,
  taskFile,
  type Envelope,
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

  /** The PR as GitHub itself reports it, not as the daemon recorded it. */
  pull(prRef: string): { state: string; merged: boolean; head_sha: string } {
    const number = prRef.split('#')[1];
    const r = spawnSync('gh', ['api', `repos/${this.direction.repo}/pulls/${number}`], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (r.status !== 0) throw new Error(`gh: ${r.stderr}`);
    const pr = JSON.parse(r.stdout) as {
      state: string;
      merged: boolean;
      head: { sha: string };
    };
    return { state: pr.state, merged: pr.merged, head_sha: pr.head.sha };
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
