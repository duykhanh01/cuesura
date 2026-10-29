/**
 * Repo-controlled commands (T038, FR-004, contracts/execution.md "Prepare, gate và publish"): setup,
 * gates and autofix run exactly the frozen command string as `/bin/sh -c <command>` inside the Isolated
 * sandbox, never on the host. Each run is capped by the frozen command wall (10 minutes by default) and
 * by what is left of the task deadline, and always produces a receipt.
 *
 * Retry safety is declared per role. An `unknown` outcome (the process may have run and written) of a
 * command that is not declared safe must wait for a human instead of being run again.
 */
import { spawn } from 'node:child_process';
import type { Clock, SandboxLaunchPlan, SandboxLayout, SandboxProvider } from '../adapters/ports.ts';
import type { EpochMs, Hash } from '../shared/brand.ts';
import { hashText } from '../shared/hash.ts';
import type { Redactor } from './redact.ts';

export const COMMAND_ROLES = ['setup', 'gate', 'autofix'] as const;
export type CommandRole = (typeof COMMAND_ROLES)[number];

/**
 * Setup reinstalls from the frozen lockfile/command and gates only check and build, so re-running them
 * after an unknown outcome is safe; autofix rewrites sources, so an unknown autofix waits for a human.
 */
export const RETRY_SAFETY: Readonly<Record<CommandRole, 'safe' | 'unsafe'>> = { setup: 'safe', gate: 'safe', autofix: 'unsafe' };

export const DEFAULT_COMMAND_WALL_MS = 10 * 60_000;
const OUTPUT_BYTES = 4 * 1024 * 1024;
const TAIL_BYTES = 4 * 1024;

export type ExecOutcome =
  | { readonly kind: 'exited'; readonly code: number; readonly output: string; readonly truncated: boolean }
  | { readonly kind: 'timeout'; readonly output: string; readonly truncated: boolean }
  /** Provably never started (spawn error before a process existed). */
  | { readonly kind: 'not_launched'; readonly message: string }
  /** Started, but how it ended is not known (killed by a signal we did not send, lost pipe). */
  | { readonly kind: 'unknown'; readonly message: string; readonly output: string };

/** Runs a sandbox launch plan; the default spawns it directly, the systemd runner replaces it later. */
export interface CommandExecutor {
  run(plan: SandboxLaunchPlan, opts: { readonly timeout_ms: number; readonly max_output_bytes: number }): Promise<ExecOutcome>;
}

export const RECEIPT_STATUSES = ['passed', 'failed', 'timeout', 'deadline', 'not_launched', 'unknown'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export type CommandReceipt = {
  readonly role: CommandRole;
  readonly name: string;
  readonly command: string;
  readonly command_digest: Hash;
  readonly layout_digest: Hash | null;
  readonly status: ReceiptStatus;
  readonly exit_code: number | null;
  readonly started_at: EpochMs | null;
  readonly finished_at: EpochMs;
  readonly wall_ms: number;
  /** Redacted combined output: digest of what was captured, its tail, and whether capture was capped. */
  readonly output: { readonly digest: Hash; readonly bytes: number; readonly tail: string; readonly truncated: boolean };
  readonly retry: 'safe' | 'unsafe';
  readonly detail: string | null;
};

export type CommandSpec = {
  readonly role: CommandRole;
  readonly name: string;
  readonly command: string;
  readonly layout: Omit<SandboxLayout, 'role' | 'private_home'>;
  /** Frozen per-command wall (runtime.limits.command_wall_ms). */
  readonly wall_ms: number;
  readonly deadline_at: EpochMs | null;
};

export type CommandDeps = {
  readonly sandbox: SandboxProvider;
  readonly executor: CommandExecutor;
  readonly clock: Clock;
  readonly redactor: Redactor;
};

function tail(text: string): string {
  const b = Buffer.from(text, 'utf8');
  return b.length <= TAIL_BYTES ? text : b.subarray(b.length - TAIL_BYTES).toString('utf8').replace(/^�+/, '');
}

/** Whether a receipt may be followed by running the same command again without asking a human. */
export function mayRetry(r: CommandReceipt): boolean {
  if (r.status === 'not_launched') return true;
  return r.status === 'unknown' ? r.retry === 'safe' : true;
}

export async function runCommand(deps: CommandDeps, spec: CommandSpec): Promise<CommandReceipt> {
  const now = deps.clock.now();
  const left = spec.deadline_at === null ? Number.POSITIVE_INFINITY : spec.deadline_at - now;
  const wall = Math.min(spec.wall_ms, left);
  const base = { role: spec.role, name: spec.name, command: spec.command, command_digest: hashText(spec.command), retry: RETRY_SAFETY[spec.role] };
  const none = { digest: hashText(''), bytes: 0, tail: '', truncated: false };
  if (wall <= 0) {
    return { ...base, layout_digest: null, status: 'deadline', exit_code: null, started_at: null, finished_at: now, wall_ms: 0, output: none, detail: 'task deadline reached before the command started' };
  }
  const plan = deps.sandbox.plan({ ...spec.layout, role: spec.role, private_home: null }, ['/bin/sh', '-c', spec.command]);
  if (!plan.ok) {
    return { ...base, layout_digest: null, status: 'not_launched', exit_code: null, started_at: null, finished_at: deps.clock.now(), wall_ms: wall, output: none, detail: `${plan.error.code}: ${plan.error.message}` };
  }
  const started = deps.clock.now();
  const r = await deps.executor.run(plan.value, { timeout_ms: wall, max_output_bytes: OUTPUT_BYTES });
  const finished = deps.clock.now();
  const raw = r.kind === 'not_launched' ? '' : r.output;
  const redacted = deps.redactor.text(raw);
  const output = { digest: hashText(redacted), bytes: Buffer.byteLength(redacted), tail: tail(redacted), truncated: 'truncated' in r ? r.truncated : false };
  const common = { ...base, layout_digest: plan.value.layout_digest, wall_ms: wall, finished_at: finished, output };
  switch (r.kind) {
    case 'exited':
      return { ...common, status: r.code === 0 ? 'passed' : 'failed', exit_code: r.code, started_at: started, detail: null };
    case 'timeout':
      return { ...common, status: 'timeout', exit_code: null, started_at: started, detail: `killed after ${wall} ms` };
    case 'not_launched':
      return { ...common, status: 'not_launched', exit_code: null, started_at: null, detail: r.message };
    case 'unknown':
      return { ...common, status: 'unknown', exit_code: null, started_at: started, detail: r.message };
  }
}

/** Spawns the plan's argv directly in its own process group; the group is killed on timeout. */
export class SpawnExecutor implements CommandExecutor {
  run(plan: SandboxLaunchPlan, opts: { readonly timeout_ms: number; readonly max_output_bytes: number }): Promise<ExecOutcome> {
    const [file, ...args] = plan.argv;
    if (file === undefined) return Promise.resolve({ kind: 'not_launched', message: 'empty argv' });
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(file, args, { cwd: plan.cwd, env: { ...plan.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      } catch (e) {
        resolve({ kind: 'not_launched', message: e instanceof Error ? e.message : String(e) });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      let timedOut = false;
      let spawned = false;
      const take = (b: Buffer): void => {
        const room = opts.max_output_bytes - size;
        if (room <= 0) {
          truncated = true;
          return;
        }
        if (b.length > room) truncated = true;
        chunks.push(b.subarray(0, room));
        size += Math.min(b.length, room);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('spawn', () => {
        spawned = true;
      });
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, opts.timeout_ms);
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve(spawned ? { kind: 'unknown', message: e.message, output: Buffer.concat(chunks).toString('utf8') } : { kind: 'not_launched', message: e.message });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const output = Buffer.concat(chunks).toString('utf8');
        if (timedOut) return resolve({ kind: 'timeout', output, truncated });
        if (code === null) return resolve({ kind: 'unknown', message: `terminated by ${signal ?? 'unknown signal'}`, output });
        resolve({ kind: 'exited', code, output, truncated });
      });
    });
  }
}
