/**
 * Setup, gate and autofix effects (T038, FR-004). Runs the frozen commands in order through
 * {@link runCommand}, after a worktree checkpoint (the commands may write), and turns the receipts into
 * the effect data the engine already understands. The adapter never picks a task status: a receipt it
 * cannot interpret becomes `unknown`, with whether running it again is allowed.
 */
import type { GitPort } from './ports.ts';
import type { WorktreeCheckpoint } from '../domain/runtime.ts';
import { excerptOf } from '../runner/command-output.ts';
import {
  mayRetry,
  runCommand,
  type CommandDeps,
  type CommandLogRef,
  type CommandReceipt,
  type CommandRole,
  type CommandSpec,
} from '../runner/commands.ts';
import type { EpochMs } from '../shared/brand.ts';
import { takeCheckpoint, type CheckpointSpec } from './git/checkpoint.ts';

export type CommandSetDeps = CommandDeps & { readonly git: GitPort };

export type CommandSetInput = {
  readonly commands: readonly {
    readonly name: string;
    readonly command: string;
  }[];
  readonly layout: CommandSpec['layout'];
  readonly wall_ms: number | null;
  readonly deadline_at: EpochMs | null;
  readonly checkpoint: CheckpointSpec;
};

export type CommandSetOutcome =
  | {
      readonly kind: 'completed';
      readonly checkpoint: WorktreeCheckpoint;
      readonly receipts: readonly CommandReceipt[];
    }
  /** Stopped at a receipt whose outcome is unknown; `retry_allowed` false means a human decides. */
  | {
      readonly kind: 'unknown';
      readonly checkpoint: WorktreeCheckpoint | null;
      readonly receipts: readonly CommandReceipt[];
      readonly retry_allowed: boolean;
      readonly detail: string;
    };

/** Short, stable failure signature used for streak/loop detection; never contains raw output. */
export function failureSignature(r: CommandReceipt): string {
  return r.status === 'failed'
    ? `${r.role}:${r.name}:exit_${r.exit_code ?? '?'}:${r.output.digest.slice(7, 19)}`
    : `${r.role}:${r.name}:${r.status}`;
}

async function runSet(
  deps: CommandSetDeps,
  role: CommandRole,
  input: CommandSetInput,
  stopOnFailure: boolean,
): Promise<CommandSetOutcome> {
  const cp = await takeCheckpoint(deps.git, input.checkpoint);
  if (!cp.ok)
    return {
      kind: 'unknown',
      checkpoint: null,
      receipts: [],
      retry_allowed: cp.error.kind === 'unknown',
      detail: `checkpoint: ${cp.error.detail}`,
    };
  const receipts: CommandReceipt[] = [];
  for (const c of input.commands) {
    const r = await runCommand(deps, {
      role,
      name: c.name,
      command: c.command,
      layout: input.layout,
      wall_ms: input.wall_ms,
      deadline_at: input.deadline_at,
    });
    receipts.push(r);
    if (r.status === 'unknown')
      return {
        kind: 'unknown',
        checkpoint: cp.value,
        receipts,
        retry_allowed: mayRetry(r),
        detail: `${c.name}: ${r.detail ?? 'unknown outcome'}`,
      };
    if (stopOnFailure && r.status !== 'passed') break;
  }
  return { kind: 'completed', checkpoint: cp.value, receipts };
}

export type GateResult = {
  gate: string;
  passed: boolean;
  signature?: string;
  log_excerpt?: string;
  log?: CommandLogRef;
};

/** Passes over the required set when a gate or formatter keeps changing the tree (M06). */
export const GATE_TREE_PASSES = 3;

/** The gate result a receipt stands for; also what recovery rebuilds from a journal. */
export function gateResultOf(r: CommandReceipt): GateResult {
  const log = r.output.log == null ? {} : { log: r.output.log };
  if (r.status === 'passed') return { gate: r.name, passed: true, ...log };
  const excerpt = r.output.excerpt ?? r.output.tail;
  return {
    gate: r.name,
    passed: false,
    signature: failureSignature(r),
    ...(excerpt === '' ? {} : { log_excerpt: excerpt }),
    ...log,
  };
}

/**
 * The fixer's failures are a required part of its context, which is never cut and refuses to start past
 * 128 KiB, so however many gates fail together they share this much and leave room for the rest.
 */
const FIXER_GATE_LOG_BYTES = 48 * 1024;

/** One failed gate's excerpt as the fixer gets it when `failures` gates failed together. */
export function fixerExcerpt(excerpt: string, failures: number): string {
  const limit = Math.floor(FIXER_GATE_LOG_BYTES / Math.max(1, failures));
  return excerptOf(excerpt, Buffer.byteLength(excerpt), limit);
}

/**
 * `run_gates`: every gate runs, and every result must hold for one final tree (M06). The tree is
 * recorded before and after each gate; when a gate (a formatter, say) changed it, the whole set runs
 * again on the new tree, as long as every command is declared safe to retry and passes remain. A tree
 * that still moves after the last pass is reported `stable: false`, which blocks commit and publish.
 */
export async function runGates(
  deps: CommandSetDeps,
  input: CommandSetInput,
): Promise<
  CommandSetOutcome & {
    readonly data?: { results: GateResult[]; tree: string; stable: boolean };
  }
> {
  let last: CommandSetOutcome | null = null;
  for (let pass = 1; pass <= GATE_TREE_PASSES; pass++) {
    const before = await takeCheckpoint(deps.git, input.checkpoint);
    if (!before.ok)
      return {
        kind: 'unknown',
        checkpoint: null,
        receipts: [],
        retry_allowed: before.error.kind === 'unknown',
        detail: `checkpoint: ${before.error.detail}`,
      };
    const receipts: CommandReceipt[] = [];
    let moved = false;
    for (const c of input.commands) {
      const r = await runCommand(deps, {
        role: 'gate',
        name: c.name,
        command: c.command,
        layout: input.layout,
        wall_ms: input.wall_ms,
        deadline_at: input.deadline_at,
      });
      receipts.push(r);
      if (r.status === 'unknown')
        return {
          kind: 'unknown',
          checkpoint: before.value,
          receipts,
          retry_allowed: mayRetry(r),
          detail: `${c.name}: ${r.detail ?? 'unknown outcome'}`,
        };
      const after = await takeCheckpoint(deps.git, input.checkpoint);
      if (!after.ok)
        return {
          kind: 'unknown',
          checkpoint: before.value,
          receipts,
          retry_allowed: after.error.kind === 'unknown',
          detail: `checkpoint: ${after.error.detail}`,
        };
      if (after.value.tree_oid !== before.value.tree_oid) moved = true;
    }
    last = { kind: 'completed', checkpoint: before.value, receipts };
    if (!moved)
      return {
        ...last,
        data: {
          results: receipts.map(gateResultOf),
          tree: before.value.tree_oid,
          stable: true,
        },
      };
    if (!receipts.every((r) => r.retry === 'safe')) break;
  }
  const end = await takeCheckpoint(deps.git, input.checkpoint);
  const out = last as Extract<CommandSetOutcome, { kind: 'completed' }>;
  return {
    ...out,
    data: {
      results: out.receipts.map(gateResultOf),
      tree: end.ok ? end.value.tree_oid : out.checkpoint.tree_oid,
      stable: false,
    },
  };
}

/** Setup of `prepare`: commands run in order and stop at the first that does not pass. */
export async function runSetup(
  deps: CommandSetDeps,
  input: CommandSetInput,
): Promise<CommandSetOutcome & { readonly setup?: { ran: boolean; passed: boolean } }> {
  if (input.commands.length === 0) {
    const cp = await takeCheckpoint(deps.git, input.checkpoint);
    if (!cp.ok)
      return {
        kind: 'unknown',
        checkpoint: null,
        receipts: [],
        retry_allowed: cp.error.kind === 'unknown',
        detail: `checkpoint: ${cp.error.detail}`,
      };
    return {
      kind: 'completed',
      checkpoint: cp.value,
      receipts: [],
      setup: { ran: false, passed: true },
    };
  }
  const out = await runSet(deps, 'setup', input, true);
  if (out.kind !== 'completed') return out;
  return {
    ...out,
    setup: {
      ran: true,
      passed: out.receipts.every((r) => r.status === 'passed'),
    },
  };
}

/** Autofix gates (`ci_autofix`): same data shape as gates; an unknown outcome is never retried blindly. */
export async function runAutofix(
  deps: CommandSetDeps,
  input: CommandSetInput,
): Promise<CommandSetOutcome & { readonly data?: { results: GateResult[] } }> {
  const out = await runSet(deps, 'autofix', input, true);
  if (out.kind !== 'completed') return out;
  return { ...out, data: { results: out.receipts.map(gateResultOf) } };
}
