/**
 * Effect handlers of the 002 daemon (T047): each one reads the committed task, its frozen policy,
 * context and runtime snapshot, does its I/O through the ports, and returns facts (see ingest.ts). The
 * dispatcher calls a handler only after the claim committed, and only for runtime tasks; a merge is
 * never handled. Handlers never choose a task status, a retry or a route.
 *
 * Head discipline (task-execution-modes.md M06): the gate step ends, once every required gate passed on
 * one final tree, with the checkpoint commit of that tree on the task branch, using the worker's commit
 * message. The reviewer (`full-review` only) reads the fixed base..checkpoint diff and the PR content;
 * publish pushes that exact SHA and refuses a worktree, branch or remote that moved since. Worker
 * content (commit message, PR title/body) comes from a file outside the worktree, checked and stored by
 * digest before it is used (M05).
 *
 * `reconcile` (T090) probes the effect it targets by kind before anything is sent again; see
 * {@link reconcileEffect}.
 */
import {
  headOf as gitHead,
  restoreWorktree,
  WorktreeBaselineSchema,
} from '../adapters/git/restore.ts';
import { writeAtomicIn } from '../runner/files.ts';
import {
  updateBase,
  baseRepairScope,
  baseUpdateIntentKey,
  checkBaseMerge,
} from '../adapters/git/update-base.ts';
import { BaseUpdateSchema } from '../domain/runtime.ts';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  buildRoleContext,
  gateEvidenceFor,
  type PublishContent,
  type RepairState,
  type RoleFailure,
  type WorkerReport,
} from '../adapters/context.ts';
import { FileContentStore, readContentFile, validateContent } from '../adapters/publish-content.ts';
import {
  failureSignature,
  gateResultOf,
  runAutofix,
  runGates,
  runSetup,
  type CommandSetInput,
  fixerExcerpt,
} from '../adapters/gates.ts';
import { readBaseConflicts } from '../adapters/git/base-conflicts.ts';
import { takeCheckpoint, type CheckpointSpec } from '../adapters/git/checkpoint.ts';
import { commitCheckpoint, FileCommitIntentStore } from '../adapters/git/commit.ts';
import { pushBranch } from '../adapters/git/push.ts';
import {
  probeCommit,
  probeLocalRemainder,
  probePush,
  type LocalRemainderProbe,
} from '../adapters/git/reconcile.ts';
import { ensureWorktree, markerPath, taskBranch } from '../adapters/git/worktree.ts';
import { ROLES, wireRoleSchema, type Role } from '../adapters/harness/result-schema.ts';
import { manifestShortfalls } from '../application/capabilities.ts';
import { toMergeProof } from '../adapters/github/merge-proof.ts';
import { observePull } from '../adapters/github/observe.ts';
import {
  createOrRecoverPr,
  updatePrDescription,
  type DescriptionUpdate,
  type PrFact,
  type PrSpec,
} from '../adapters/github/publish.ts';
import { probeDescription, probePr, probeRerun } from '../adapters/github/reconcile.ts';
import { rerunFailedJobs } from '../adapters/github/rerun.ts';
import {
  findPosted,
  markReady,
  postReview,
  probeReady,
  renderReview,
  type ReadyOutcome,
} from '../adapters/github/review.ts';
import { defaultReviewTemplate } from '../domain/templates.ts';
import type {
  Clock,
  GitHubPort,
  GitPort,
  HarnessFailure,
  HarnessInput,
  HarnessOutcome,
  HarnessPort,
  ProcessPort,
  SandboxProvider,
  StopOutcome,
} from '../adapters/ports.ts';
import type { Effect } from '../domain/effect.ts';
import type { Binding, FrozenExecutionContext, FrozenPolicy } from '../domain/policy.ts';
import {
  AGENT_LOST_SIGNATURE,
  type FrozenRuntimeContext,
  type Observation,
} from '../domain/runtime.ts';
import type { TaskState } from '../domain/state.ts';
import { isMinorStep } from '../domain/workflow.ts';
import { MINOR_FIX_STEP } from '../engine/workflows/software-dev.ts';
import type { z } from 'zod';
import type {
  AwaitCiDataSchema,
  FailureClass,
  RequiredCheckVerdict,
  Trigger,
  TriggerEnvelope,
} from '../domain/trigger.ts';
import { evaluateRequired, type RequiredVerdict } from '../engine/required-checks.ts';
import type { OperationClaim } from '../engine/runtime.ts';
import {
  CommandJournal,
  STOP_KILL_VERIFY_MS,
  STOP_TERM_GRACE_MS,
  type CommandExecutor,
} from '../runner/commands.ts';
import { InvocationUnknown } from '../runner/invocation.ts';
import type { Redactor } from '../runner/redact.ts';
import type { EpochMs, Uuid } from '../shared/brand.ts';
import { hashCanonical, hashText } from '../shared/hash.ts';
import { claimable } from '../engine/claim.ts';
import { reviewInputDigest } from '../engine/review-evidence.ts';
import type { Store } from '../store/index.ts';
import type { EffectHandler, EffectHandlers } from './dispatch.ts';
import { DRAIN_KILL_VERIFY_MS, DRAIN_TERM_GRACE_MS } from './drain.ts';
import { ingestOperationSpool, resultEnvelopes, type EffectOutcome } from './ingest.ts';
import { isUnresolved } from '../engine/runtime.ts';

export type HandlerDeps = {
  /** Runner spool directory shared by execution and ingestion. */
  readonly dataDir: string;
  readonly latch?: (reason: string) => void;
  readonly store: Store;
  readonly git: GitPort;
  /** A fresh GitHub port per effect: call caps and the round window count per round. */
  readonly github: () => GitHubPort;
  readonly harnesses: Readonly<Record<string, HarnessPort>>;
  readonly sandbox: SandboxProvider;
  readonly executor: CommandExecutor;
  /** Read-only directories gates see besides `/usr` (the node of the daemon, say); none by default. */
  readonly gate_toolchain?: readonly string[];
  readonly clock: Clock;
  readonly redactor: Redactor;
  readonly newId: () => string;
  readonly paths: {
    readonly worktrees: string;
    readonly markers: string;
    readonly intents: string;
    readonly scratch: string;
    readonly content: string;
    /** Command journals, one directory per effect (FR-004): what recovery reads before a retry. */
    readonly receipts: string;
  };
  readonly committer: { readonly name: string; readonly email: string };
  /** Push URL of a repo slug, from the runtime snapshot (never the repo's own remote config). */
  readonly remoteUrl: (repo: string) => string;
  /** Aborts the in-flight handler of an effect (the dispatcher's `abort`). */
  readonly abort: (effectId: string) => boolean;
  /**
   * Resolves once an aborted handler has returned (the dispatcher's `settled`), so a stop never reports
   * done while that handler may still spawn something.
   */
  readonly settled?: (effectId: string) => Promise<void>;
  /**
   * Stops a runner no handler of this process owns (adopted after a restart) with the drain's
   * TERM/KILL/verify bounds (FR-025.02); without it such a runner keeps going until its own result.
   */
  readonly process?: ProcessPort;
  /**
   * Stops the tagged processes of a local operation (setup, gate) and verifies they are gone; usually
   * `stopOperationProcesses` over the daemon's data dir. Without it a local operation runs to its own bound.
   */
  readonly stopLocal?: (operationId: string) => Promise<StopOutcome>;
};

type Loaded = {
  s: TaskState;
  policy: FrozenPolicy;
  context: FrozenExecutionContext;
  rt: FrozenRuntimeContext;
};

class Skip extends Error {
  readonly outcome: EffectOutcome;
  constructor(outcome: EffectOutcome) {
    super(outcome.outcome === 'unknown' ? outcome.detail : outcome.outcome);
    this.outcome = outcome;
  }
}

const failed = (failure_class: string, message: string): EffectOutcome => ({
  outcome: 'failed',
  data: { failure_class, message },
});
const unknown = (detail: string): EffectOutcome => ({
  outcome: 'unknown',
  detail,
});

function load(deps: Pick<HandlerDeps, 'store'>, effect: Effect): Loaded {
  const s = deps.store.readTask(effect.task_id as Uuid);
  if (s === null || s.policy_ref === null) throw new Skip(failed('infra', 'task not started'));
  const policy = deps.store.readPolicy(s.id as Uuid, s.policy_ref.revision, s.policy_ref.version);
  const context = deps.store.readContext(s.id as Uuid, s.revision);
  const rt = deps.store.readRuntimeContext(s.id as Uuid, s.revision);
  if (policy === null || context === null || rt === null)
    throw new Skip(failed('infra', 'frozen snapshot missing'));
  return { s, policy, context, rt };
}

async function commonDir(deps: HandlerDeps, project: string): Promise<string> {
  const r = await deps.git.run({
    args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    cwd: project,
    timeout_ms: 10_000,
    max_output_bytes: 4096,
    stdin: null,
  });
  if (r.kind !== 'exited' || r.code !== 0)
    throw new Skip(unknown(`git common dir: ${r.kind === 'exited' ? r.stderr.trim() : r.kind}`));
  return r.stdout.trim();
}

/**
 * The branch the task publishes to. An adopted PR keeps its own head branch on the remote; locally the
 * task still works on its private `cusr/` branch, so a checkout of that head elsewhere cannot collide.
 */
const remoteBranch = (s: TaskState): string =>
  s.adoption?.head_branch ?? taskBranch(s.id, s.task.title);

function where(deps: HandlerDeps, l: Loaded) {
  return {
    worktree: join(deps.paths.worktrees, l.s.id),
    branch: taskBranch(l.s.id, l.s.task.title),
    scratch: join(deps.paths.scratch, l.s.id),
  };
}

async function checkpointSpec(deps: HandlerDeps, l: Loaded): Promise<CheckpointSpec> {
  const w = where(deps, l);
  return {
    task_id: l.s.id,
    revision: l.s.revision,
    project_realpath: l.rt.project_path,
    common_git_dir: await commonDir(deps, l.rt.project_path),
    worktree_path: w.worktree,
    branch: w.branch,
    base_sha: l.rt.base_sha,
    owner_marker: markerPath(deps.paths.markers, l.s.id),
  };
}

async function headOf(deps: HandlerDeps, cwd: string): Promise<{ sha: string; tree: string }> {
  const r = await deps.git.run({
    args: ['rev-parse', 'HEAD', 'HEAD^{tree}'],
    cwd,
    timeout_ms: 10_000,
    max_output_bytes: 4096,
    stdin: null,
  });
  if (r.kind !== 'exited' || r.code !== 0) throw new Skip(unknown('worktree HEAD unreadable'));
  const [sha, tree] = r.stdout.trim().split('\n');
  return { sha: sha as string, tree: tree as string };
}

/** How often a running local handler re-reads its task for a cancel or merge proof. */
const HALT_POLL_MS = 200;

type Guard = {
  /** The handler's ports: no Git or gate command starts once the guard fired. */
  readonly deps: HandlerDeps;
  /** Fires on the handler's own abort, or once the task records a cancel or a merge proof. */
  readonly signal: AbortSignal;
  /** A command it stopped could not be seen gone (its process group may still run). */
  readonly unverified: () => boolean;
  readonly dispose: () => void;
};

/**
 * Local setup and gate work, guarded at the moment each command would start and while it runs: the
 * handler's own abort (a stop) or a cancel or merge proof committed to the task meanwhile ends it
 * (FR-025.01/02, FR-040.02). The task is read again before every command and every HALT_POLL_MS, so a
 * snapshot taken before an await never lets work start after the cancel.
 */
function guard(deps: HandlerDeps, taskId: string, outer: AbortSignal): Guard {
  const ac = new AbortController();
  // A store that cannot be read (closed at shutdown, failing) stops the work as well.
  const halted = (): boolean => {
    try {
      const s = deps.store.readTask(taskId as Uuid);
      return s === null || s.cancellation !== null || s.completion !== null;
    } catch {
      return true;
    }
  };
  const check = (): boolean => {
    if (!ac.signal.aborted && (outer.aborted || halted())) ac.abort();
    return ac.signal.aborted;
  };
  // Polling ends with the guard: once it fired, nothing reads the store again (the daemon may be
  // closing it after the dispatcher's abort).
  const timer = setInterval(check, HALT_POLL_MS);
  ac.signal.addEventListener('abort', () => clearInterval(timer), {
    once: true,
  });
  const onOuter = (): void => ac.abort();
  outer.addEventListener('abort', onOuter, { once: true });
  if (outer.aborted) ac.abort();
  let unverified = false;
  return {
    signal: ac.signal,
    unverified: () => unverified,
    dispose: () => {
      clearInterval(timer);
      outer.removeEventListener('abort', onOuter);
    },
    deps: {
      ...deps,
      git: {
        run: (cmd) =>
          check()
            ? Promise.resolve({
                kind: 'spawn_failed',
                message: 'stopped: stop, cancel or merge recorded',
              })
            : deps.git.run(cmd),
      },
      executor: {
        run: async (plan, o) => {
          if (check())
            return {
              kind: 'not_launched',
              message: 'stopped: stop, cancel or merge recorded',
            };
          const out = await deps.executor.run(plan, {
            ...o,
            signal: ac.signal,
          });
          if (out.kind === 'unknown' && out.stop === 'unverified') unverified = true;
          return out;
        },
      },
    },
  };
}

/** What a guarded local handler reports once its guard fired: failed when all it ran is seen gone. */
function stoppedOutcome(g: Guard): EffectOutcome {
  return g.unverified()
    ? unknown('stopped; a process group was not seen gone')
    : failed('infra', 'stopped: stop, cancel or merge recorded');
}

/** What the local work a probe ran left behind: a stop it could not see through to the end. */
type LocalTrace = { unverified: boolean };

async function guarded(
  deps: HandlerDeps,
  taskId: string,
  outer: AbortSignal,
  run: (g: Guard) => Promise<EffectOutcome>,
  trace?: LocalTrace,
): Promise<EffectOutcome> {
  const g = guard(deps, taskId, outer);
  try {
    if (g.signal.aborted) return stoppedOutcome(g);
    const out = await run(g);
    return g.signal.aborted ? stoppedOutcome(g) : out;
  } finally {
    g.dispose();
    if (trace !== undefined && g.unverified()) trace.unverified = true;
  }
}

/** Never silently execute a task frozen under the former outer-sandbox contract on the host. */
function requireNativeExecution(deps: HandlerDeps, l: Loaded): void {
  if (
    deps.sandbox.provider === 'host' &&
    (l.rt.isolation.mode !== 'native' || l.rt.isolation.provider !== 'host')
  )
    throw new Skip(
      failed(
        'auth_config',
        'task was frozen for outer bwrap; start a new task with native execution',
      ),
    );
}

// ---- prepare ----

async function prepare(deps: HandlerDeps, effect: Effect): Promise<EffectOutcome> {
  const l = load(deps, effect);
  requireNativeExecution(deps, l);
  const base =
    typeof effect.request['base_sha'] === 'string' ? effect.request['base_sha'] : l.rt.base_sha;
  const wt = await ensureWorktree(deps.git, {
    task_id: l.s.id,
    title: l.s.task.title,
    project_realpath: l.rt.project_path,
    common_git_dir: await commonDir(deps, l.rt.project_path),
    base_sha: base,
    ...(l.s.adoption === undefined ? {} : { start_sha: l.s.adoption.head_sha }),
    worktrees_root: deps.paths.worktrees,
    markers_dir: deps.paths.markers,
    nonce: effect.id,
  });
  if (wt.kind === 'unknown') return unknown(wt.detail);
  if (wt.kind === 'mismatch') return failed('infra', `worktree ${wt.reason}: ${wt.detail}`);
  // Before the tree is read: what setup leaves is where the task starts. Declared safe to run again, so a
  // retry or a reconcile of this effect simply runs it again.
  const commands = (l.rt.setup_commands ?? []).map((command, i) => ({
    name: `setup-${i + 1}`,
    command,
  }));
  const spec = await checkpointSpec(deps, l);
  // A sandbox refuses a mount source that does not exist, and no worker has made this one yet.
  if (commands.length > 0) mkdirSync(where(deps, l).scratch, { recursive: true, mode: 0o700 });
  const setup = await runSetup(
    { ...deps, journal: journalOf(deps, effect.id) },
    {
      commands,
      layout: commandLayout(deps, l, spec),
      wall_ms: l.rt.limits.command_wall_ms,
      deadline_at: l.s.deadline_at as EpochMs | null,
      checkpoint: spec,
    },
  );
  if (setup.kind === 'unknown')
    return setup.retry_allowed ? failed('infra', setup.detail) : unknown(setup.detail);
  const stopped = setup.receipts.find((r) => r.status !== 'passed');
  if (stopped !== undefined)
    return failed(
      // Out of time is one retry then a person (SPEC §9.2), not the infra backoff.
      stopped.status === 'timeout' || stopped.status === 'deadline' ? 'timeout' : 'infra',
      `setup_failed: ${failureSignature(stopped)}: ${stopped.detail ?? stopped.output.tail.slice(-1024)}`,
    );
  const tree = await worktreeTree(deps, l);
  if (!tree.ok) return tree.outcome;
  return {
    outcome: 'succeeded',
    data: {
      base_sha: base,
      worktree_ref: wt.worktree_path,
      branch: wt.branch,
      setup: { ran: commands.length > 0, passed: true },
      worktree_tree: tree.tree,
    },
  };
}

/** The task worktree's full working tree (tracked, untracked, deleted) as a Git tree, read once (T072). */
async function worktreeTree(
  deps: HandlerDeps,
  l: Loaded,
): Promise<{ ok: true; tree: string } | { ok: false; outcome: EffectOutcome }> {
  const cp = await takeCheckpoint(deps.git, await checkpointSpec(deps, l));
  if (cp.ok) return { ok: true, tree: cp.value.tree_oid };
  return {
    ok: false,
    outcome:
      cp.error.kind === 'unknown' ? unknown(cp.error.detail) : failed('infra', cp.error.detail),
  };
}

/** Adds the worktree tree a worker attempt left to its outcome, success or failure (T072). */
function withWorktreeTree(out: EffectOutcome, tree: string): EffectOutcome {
  if (out.outcome !== 'succeeded' && out.outcome !== 'failed') return out;
  return {
    ...out,
    data: { ...(out.data as Record<string, unknown>), worktree_tree: tree },
  } as EffectOutcome;
}

// ---- start_agent ----

const WORKER_ROLES: readonly Role[] = ['coder', 'fixer'];

function contentStore(deps: HandlerDeps): FileContentStore {
  return new FileContentStore(deps.paths.content);
}

/** The current worker content of this revision, read back by digest; null when none was accepted yet. */
function currentContent(deps: HandlerDeps, s: TaskState): PublishContent | null {
  const c = s.run.content;
  return c === null || c.revision !== s.revision ? null : contentStore(deps).get(c.ref, c.digest);
}

/**
 * The review approved the change; these findings are minor. A fix that changes other files than the
 * findings' files and tests is not carried by the approval: it goes back through review.
 */
const MINOR_SCOPE =
  'The review approved this change; this finding is minor. Fix it where it is: change only the files named in these findings and their tests. If that is not enough, leave it and say why in your summary.';

function reviewFailures(review: TaskState['run']['reviews'][number]): RoleFailure[] {
  const findings =
    review.findings.length > 0
      ? review.findings
      : [{ severity: 'major', msg: 'the reviewer requested changes' }];
  return findings.map((f) => ({
    source: 'review',
    name: `${f.severity}${f.file === undefined ? '' : ` ${f.file}${f.line === undefined ? '' : `:${f.line}`}`}`,
    detail: f.msg,
    sha: review.sha,
  }));
}

/** Failures the repair is about, newest evidence of this revision, each with the SHA it was seen on. */
function failuresFor(
  s: TaskState,
  policy: FrozenPolicy,
): {
  cause: RepairState['cause'] | null;
  failures: RoleFailure[];
} {
  const rev = s.revision;
  const gate = s.evidence.gates.filter((g) => g.valid && g.revision === rev).at(-1);
  const review = s.run.reviews.filter((r) => r.valid && r.revision === rev).at(-1);
  const ci = s.evidence.ci.filter((c) => c.valid && c.revision === rev).at(-1);
  const cp = s.run.checkpoint?.sha ?? null;
  const step = s.current_step ?? '';
  const update = s.run.base_update;
  if (
    update?.conflict !== undefined &&
    update.certificate === undefined &&
    step === (update.fix_step ?? policy.workflow.steps[update.gate_step]?.next['fail'])
  ) {
    const conflict: RoleFailure = {
      source: 'gate',
      name: 'base-conflict',
      sha: update.head_sha,
      detail: `Resolve this merge conflict in one attempt. Conflicting files: ${update.conflict.files.join(', ')}. Keep both task and base behavior. Regenerate lockfiles and generated files with the project's own tool (for example the package manager's install) instead of merging them by hand. ${update.fix_step === undefined ? 'Changes outside these files require review.' : 'Fix the review findings listed with it in the same attempt.'} Do not run git commit or push.`,
    };
    // In a review/fix round (#239) the same attempt also takes the rejected review's findings.
    const findings =
      update.fix_step !== undefined && review?.verdict === 'request_changes'
        ? reviewFailures(review)
        : [];
    return {
      cause: findings.length > 0 ? 'review' : 'gate',
      failures: [conflict, ...findings],
    };
  }
  if (step === 'fix_gates' && gate !== undefined && !gate.passed) {
    const failed = gate.failed ?? [];
    const list =
      failed.length > 0
        ? failed
        : [{ gate: gate.step, signature: gate.signature, log_excerpt: null }];
    return {
      cause: 'gate',
      failures: list.map((f) => ({
        source: 'gate',
        name: f.gate,
        detail: [f.signature ?? 'gate failed', fixerExcerpt(f.log_excerpt ?? '', list.length)]
          .filter((x) => x !== '')
          .join('\n'),
        sha: cp,
      })),
    };
  }
  if (step === 'fix_review' && review?.verdict === 'request_changes')
    return { cause: 'review', failures: reviewFailures(review) };
  if (step === MINOR_FIX_STEP && review?.verdict === 'approve') {
    return {
      cause: 'review',
      failures: review.findings
        .filter((f) => f.severity === 'minor')
        .map((f) => ({
          source: 'review',
          name: `${f.severity}${f.file === undefined ? '' : ` ${f.file}${f.line === undefined ? '' : `:${f.line}`}`}`,
          detail: `${f.msg}\n${MINOR_SCOPE}`,
          sha: review.sha,
        })),
    };
  }
  if (ci !== undefined) {
    const failed = ci.checks.filter((c) => c.state === 'failure');
    if (failed.length > 0)
      return {
        cause: 'ci',
        failures: failed.map((c) => ({
          source: 'ci',
          name: c.name,
          detail: c.log_excerpt ?? 'failed',
          sha: ci.head_sha,
        })),
      };
  }
  return { cause: null, failures: [] };
}

async function gitText(
  deps: HandlerDeps,
  cwd: string,
  args: string[],
  max = 256 * 1024,
): Promise<string> {
  const r = await deps.git.run({
    args,
    cwd,
    timeout_ms: 30_000,
    max_output_bytes: max,
    stdin: null,
  });
  if (r.kind !== 'exited' || r.code !== 0)
    throw new Skip(unknown(`git ${args[0] ?? ''} unreadable`));
  return r.stdout;
}

/** The repair packet, rebuilt from reconciled state for every repair call (M04). */
async function repairState(
  deps: HandlerDeps,
  l: Loaded,
  cause: RepairState['cause'],
): Promise<RepairState> {
  const w = where(deps, l);
  return {
    cause,
    base_sha: l.rt.base_sha,
    checkpoint_sha: l.s.run.checkpoint?.revision === l.s.revision ? l.s.run.checkpoint.sha : null,
    published_sha: l.s.head_sha,
    pr_ref: l.s.pr_ref,
    worktree_status: await gitText(
      deps,
      w.worktree,
      ['status', '--porcelain=v1', '--untracked-files=all'],
      64 * 1024,
    ),
    diff: await gitText(
      deps,
      w.worktree,
      ['diff', '--no-color', '--no-ext-diff', l.rt.base_sha],
      l.rt.limits.review_diff_bytes,
    ),
  };
}

/** Roles the frozen policy may run on `harness`, through a step's binding or any rung of its ladder. */
function harnessRoles(policy: FrozenPolicy, harness: string): Role[] {
  const roles = Object.values(policy.steps)
    .filter(
      (p) => p.binding.harness === harness || p.ladder.some((r) => r.binding.harness === harness),
    )
    .map((p) => p.role)
    .filter((r): r is Role => (ROLES as readonly string[]).includes(r));
  return [...new Set(roles)].sort();
}

const HARNESS_FAILURE_CLASS: Record<HarnessFailure, FailureClass> = {
  rate_limited: 'rate_limit',
  // An overloaded provider clears in minutes, not seconds: the rate-limit backoff fits, the infra one
  // would be spent before capacity comes back.
  overloaded: 'rate_limit',
  auth: 'auth_config',
  refusal: 'refused',
  vendor_error: 'infra',
  turn_limit: 'timeout',
  timeout: 'timeout',
  process_failed: 'infra',
  missing_output: 'invalid_output',
  cancelled: 'infra',
  capability_missing: 'auth_config',
  // A person looks at the worktree before anything continues (US4.3).
  boundary_violation: 'unknown',
};

function agentOutcome(
  role: Role,
  harness: string,
  o: HarnessOutcome,
  head: string | null,
  inputDigest: string | null,
): EffectOutcome {
  if (o.kind === 'failure')
    return {
      outcome: 'failed',
      data: {
        failure_class: HARNESS_FAILURE_CLASS[o.failure],
        ...(o.failure === 'auth' ? { auth: { harness } } : {}),
        message: o.detail,
        // The reservation is released only when the harness provably never ran (FR-010/016).
        invoked: o.invoked,
        usage: o.usage,
        // A stopped run (a message interrupted it, #154) keeps its session for the next turn too.
        ...(o.failure === 'turn_limit' || o.failure === 'cancelled'
          ? { session_ref: o.session_ref }
          : {}),
        ...(o.reset_at === null ? {} : { reset_at: o.reset_at }),
      },
    };
  const digest = inputDigest === null ? {} : { input_digest: inputDigest };
  if (o.kind === 'invalid_output') {
    return role === 'reviewer'
      ? {
          outcome: 'succeeded',
          data: {
            schema_checked: false,
            verdict: 'request_changes',
            findings: [],
            head_sha: head ?? 'none',
            usage: o.usage,
            ...digest,
          },
        }
      : {
          outcome: 'succeeded',
          data: {
            schema_checked: false,
            status: 'blocked',
            summary: 'invalid output',
            usage: o.usage,
          },
        };
  }
  const v = o.value;
  if ('answer' in v) return failed('auth_config', 'a decider result is not an attempt outcome');
  if ('verdict' in v) {
    return {
      outcome: 'succeeded',
      data: {
        schema_checked: true,
        verdict: v.verdict,
        findings: v.findings.map((f) => ({
          severity: f.severity,
          file: f.file,
          ...(f.line === null ? {} : { line: f.line }),
          msg: f.message,
        })),
        summary: v.summary,
        head_sha: head ?? 'none',
        usage: o.usage,
        ...digest,
      },
    };
  }
  return {
    outcome: 'succeeded',
    data: {
      schema_checked: true,
      status: v.status,
      summary: v.summary,
      questions: v.questions.map((q) =>
        q.options.length === 0 ? q.question : `${q.question}\nOptions: ${q.options.join(' | ')}`,
      ),
      ...(v.blocker === null ? {} : { blocker: v.blocker }),
      usage: o.usage,
      invoked: true,
    },
  };
}

/**
 * A rejecting review also carries the files changed since the commit the previous rejecting review of
 * this revision saw, so the engine can tell a finding the fixer left alone from one it got wrong. Left
 * out when there is no such review or Git cannot say.
 */
async function withChangedSince(
  deps: HandlerDeps,
  l: Loaded,
  head: string,
  o: EffectOutcome,
): Promise<EffectOutcome> {
  if (o.outcome !== 'succeeded') return o;
  const data = o.data as Record<string, unknown>;
  if (data['verdict'] !== 'request_changes' || data['schema_checked'] !== true) return o;
  const changed = await changedSinceRejection(deps, l, head);
  return changed === null ? o : { ...o, data: { ...data, changed_since: changed } };
}

/**
 * Files changed from the commit the last rejecting review of this revision saw to `head`; null when
 * the last review did not reject or Git cannot say.
 */
async function changedSinceRejection(
  deps: HandlerDeps,
  l: Loaded,
  head: string,
): Promise<{ sha: string; paths: string[] } | null> {
  const prior = l.s.run.reviews.filter((v) => v.valid && v.revision === l.s.revision).at(-1);
  if (prior?.verdict !== 'request_changes') return null;
  return changedFrom(deps, l, prior.sha, head);
}

/** Files a minor fix changed from the commit the approving review saw to `head`. */
async function changedSinceApproval(
  deps: HandlerDeps,
  l: Loaded,
  head: string,
): Promise<{ sha: string; paths: string[] } | null> {
  const prior = l.s.run.reviews.filter((v) => v.valid && v.revision === l.s.revision).at(-1);
  if (prior?.verdict !== 'approve') return null;
  return changedFrom(deps, l, prior.sha, head);
}

async function changedFrom(
  deps: HandlerDeps,
  l: Loaded,
  since: string,
  head: string,
): Promise<{ sha: string; paths: string[] } | null> {
  const r = await deps.git.run({
    args: ['diff', '--name-only', '-z', '--no-renames', since, head],
    cwd: where(deps, l).worktree,
    timeout_ms: 30_000,
    max_output_bytes: 1024 * 1024,
    stdin: null,
  });
  if (r.kind !== 'exited' || r.code !== 0 || r.truncated) return null;
  return { sha: since, paths: r.stdout.split('\0').filter((p) => p !== '') };
}

/**
 * What the coders and fixers of this revision reported since the last review whose verdict was recorded,
 * in order (#215). A review that failed, was stopped before its verdict counted or was reused saw none of
 * them, so it does not reset the list. Not part of the review input digest: the same code gets the same
 * verdict whatever the worker claimed.
 */
export function workerReports(s: TaskState, policy: FrozenPolicy): WorkerReport[] {
  const attempts = Object.values(s.attempts).filter(
    (a) => a.revision === s.revision && a.status === 'finished',
  );
  const seen = new Set(
    s.run.reviews.filter((r) => r.revision === s.revision).map((r) => r.attempt_id),
  );
  const roleOf = (step: string): string | undefined => policy.steps[step]?.role;
  const last = attempts.findLastIndex((a) => seen.has(a.id));
  return attempts.slice(last + 1).flatMap((a) => {
    const role = roleOf(a.step);
    return (role === 'coder' || role === 'fixer') && a.summary !== undefined
      ? [{ role, step: a.step, attempt_id: a.id, n: a.n, summary: a.summary }]
      : [];
  });
}

function redactedSummary(o: EffectOutcome, redactor: Redactor): EffectOutcome {
  if (o.outcome !== 'succeeded') return o;
  const data = o.data as Record<string, unknown>;
  const summary = data['summary'];
  return typeof summary === 'string'
    ? { ...o, data: { ...data, summary: redactor.text(summary) } }
    : o;
}

/** The fixed range a `full-review` reviewer reads: frozen base .. checkpoint commit, never the working copy. */
async function reviewRange(
  deps: HandlerDeps,
  l: Loaded,
): Promise<{
  sha: string;
  diff: { text: string; paths: string[]; from: string; to: string };
}> {
  const cp = l.s.run.checkpoint;
  if (cp === null || cp.revision !== l.s.revision)
    throw new Skip(failed('infra', 'no checkpoint commit to review'));
  const w = where(deps, l);
  const text = await gitText(
    deps,
    w.worktree,
    ['diff', '--no-color', '--no-ext-diff', cp.base_sha, cp.sha],
    l.rt.limits.review_diff_bytes * 4,
  );
  const names = await gitText(
    deps,
    w.worktree,
    ['diff', '--name-only', '-z', cp.base_sha, cp.sha],
    1024 * 1024,
  );
  return {
    sha: cp.sha,
    diff: {
      text,
      paths: names.split('\0').filter((p) => p !== ''),
      from: cp.base_sha,
      to: cp.sha,
    },
  };
}

/**
 * After a worker run: its content file (fresh for this operation, outside the worktree) is checked and
 * stored. A `done` without any accepted content, or with content that fails the check (a control
 * marker included), is not a valid output.
 */
function acceptContent(
  deps: HandlerDeps,
  l: Loaded,
  file: string,
  out: EffectOutcome,
): EffectOutcome {
  if (out.outcome !== 'succeeded') return out;
  const data = out.data as {
    schema_checked: boolean;
    status?: string;
    summary?: string;
  };
  if (!data.schema_checked || data.status !== 'done') return out;
  const read = readContentFile(file);
  if (!read.ok)
    return {
      outcome: 'succeeded',
      data: {
        ...data,
        schema_checked: false,
        summary: `publish content rejected: ${read.error.map((p) => `${p.field}: ${p.message}`).join('; ')}`,
      },
    };
  if (read.value === null) {
    return currentContent(deps, l.s) === null
      ? {
          outcome: 'succeeded',
          data: {
            ...data,
            schema_checked: false,
            summary: 'publish content missing',
          },
        }
      : out;
  }
  const v = validateContent(read.value);
  if (!v.ok)
    return {
      outcome: 'succeeded',
      data: {
        ...data,
        schema_checked: false,
        summary: `publish content rejected: ${v.error.map((p) => `${p.field}: ${p.message}`).join('; ')}`,
      },
    };
  return {
    outcome: 'succeeded',
    data: { ...data, content: contentStore(deps).put(v.value) },
  };
}

/** Named after the effect, since every run of one review goes back to the same point. */
function reviewBaselineFile(deps: HandlerDeps, taskId: string, effectId: string): string {
  return join(deps.paths.scratch, taskId, `review-baseline-${effectId}.json`);
}

/**
 * Puts back what a review changed, from the baseline saved before it ran, so a daemon that restarted in
 * between restores the same way. Without a readable baseline the tree stays as it is, and a tree that
 * changed makes the next worker step wait for a person (T072); so does a restore that fails.
 */
async function restoreAfterReview(
  deps: HandlerDeps,
  taskId: string,
  effectId: string,
): Promise<void> {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(reviewBaselineFile(deps, taskId, effectId), 'utf8'));
  } catch {
    return;
  }
  const before = WorktreeBaselineSchema.safeParse(saved);
  if (before.success)
    await restoreWorktree(deps.git, join(deps.paths.worktrees, taskId), before.data);
}

async function startAgent(
  deps: HandlerDeps,
  effect: Effect,
  signal: AbortSignal,
  op: OperationClaim,
  mirror: { attempt_id: string | null; step: string | null },
  extra: Trigger[] = [],
  refreshes = 1,
  /** Rebuild the original input and read the finished run's outcome; never launch (T090). */
  recovering = false,
): Promise<EffectOutcome> {
  const l = load(deps, effect);
  requireNativeExecution(deps, l);
  const role = effect.request['role'];
  const binding = effect.request['binding'] as Binding | undefined;
  if (
    typeof role !== 'string' ||
    !(ROLES as readonly string[]).includes(role) ||
    binding === undefined
  )
    return failed('auth_config', `role ${String(role)} is not run by cusrd`);
  const harness = deps.harnesses[binding.harness];
  if (harness === undefined) return failed('auth_config', `no harness ${binding.harness}`);
  // The manifest confirmed with the task must still be the one in force; a re-proved or changed
  // binary is never a silent switch between attempts (T070/T071). Nothing is invoked: the engine records
  // the new manifest in `run.manifest_refs` and runs the step again when it still meets what the task
  // froze for (#249), and otherwise waits on `manifest_changed` for a person's `recheck`.
  const confirmed =
    l.s.run.manifest_refs?.[binding.harness] ?? l.rt.capability_refs[binding.harness];
  const inForce = harness.manifest.manifest_hash;
  if (confirmed !== undefined && confirmed !== inForce) {
    const shortfalls = manifestShortfalls(
      binding.harness,
      harness.manifest,
      harnessRoles(l.policy, binding.harness),
      false,
    );
    return {
      outcome: 'failed',
      data: {
        failure_class: 'auth_config',
        message: `harness ${binding.harness} manifest changed since the run was confirmed${
          shortfalls.length === 0 ? '' : `: ${shortfalls.join('; ')}`
        }`,
        invoked: false,
        manifest: {
          harness: binding.harness,
          known: confirmed,
          observed: inForce,
          compatible: shortfalls.length === 0,
        },
      },
    };
  }
  const r = role as Role;
  const step = mirror.step ?? r;
  // A worker starts only on the tree the task last left (T072): a change made by someone else in
  // between is not the attempt's to take. Nothing is invoked; the engine waits for a person.
  const known = l.s.run.worktree_tree ?? null;
  if (!recovering && WORKER_ROLES.includes(r) && known !== null) {
    const now = await worktreeTree(deps, l);
    if (!now.ok) return now.outcome;
    if (now.tree !== known)
      return {
        outcome: 'failed',
        data: {
          failure_class: 'unknown',
          message: 'the worktree changed outside the task since its last step',
          invoked: false,
          worktree: { known, observed: now.tree },
        },
      };
  }
  const review = r === 'reviewer' ? await reviewRange(deps, l) : null;
  const inputDigest = r === 'reviewer' ? reviewInputDigest(l.s, l.policy, step) : null;
  const worker = WORKER_ROLES.includes(r);
  const fix = failuresFor(l.s, l.policy);
  const repairing = r === 'fixer' || (step !== 'code' && worker && fix.cause !== null);
  const scratch = where(deps, l).scratch;
  const contentName = `publish-${op.operation_id}.json`;
  const file = join(scratch, contentName);
  // A sandboxed worker writes into its own run scratch; the harness copies the file out to `file`.
  const agentFile =
    harness.agent_paths === undefined
      ? file
      : join(
          typeof harness.agent_paths.scratch === 'function'
            ? harness.agent_paths.scratch(mirror.attempt_id ?? effect.id)
            : harness.agent_paths.scratch,
          contentName,
        );
  if (worker) mkdirSync(scratch, { recursive: true, mode: 0o700 });
  // Repairs cross steps: keep every answered question of this revision, not the queued step's old packet.
  const answers = Object.values(l.s.questions).flatMap((q) =>
    q.revision === l.s.revision && q.status === 'answered' && q.answer !== null
      ? [{ question_id: q.id, question: q.body, answer: q.answer }]
      : [],
  );
  // Only the messages the engine listed at the request: one sent after the launch must not change the
  // input, or recovery could not match the run it launched (#154); the next turn carries it.
  const listed = Array.isArray(effect.request['messages'])
    ? (effect.request['messages'] as unknown[])
    : [];
  const messages = (l.s.messages ?? []).flatMap((m) =>
    listed.includes(m.id) ? [{ by: m.by, at: m.at, body: m.body }] : [],
  );
  const built = buildRoleContext({
    role: r,
    step,
    revision: l.s.revision,
    context: l.context,
    binding: {
      harness: binding.harness,
      model: binding.model,
      effort: binding.effort,
    },
    prompt: l.rt.role_prompts?.[r] ?? null,
    answers,
    ...(messages.length === 0 ? {} : { messages }),
    failures: repairing ? fix.failures : [],
    diff: review?.diff ?? null,
    ...(repairing
      ? {
          repair: fix.cause === null ? null : await repairState(deps, l, fix.cause),
        }
      : {}),
    publish: worker
      ? {
          template: l.rt.pr_template ?? null,
          current: currentContent(deps, l.s),
          file: agentFile,
        }
      : null,
    ...(r === 'reviewer'
      ? {
          pr_content: currentContent(deps, l.s),
          gate_evidence: review === null ? null : gateEvidenceFor(l.s, l.policy.gates, review.sha),
          worker_reports: workerReports(l.s, l.policy),
        }
      : {}),
    limits: {
      context_bytes: l.rt.limits.context_bytes,
      review_diff_bytes: l.rt.limits.review_diff_bytes,
    },
    redactor: deps.redactor,
  });
  if (!built.ok) {
    // A diff or PR content not there yet may come on a retry; a prompt that cannot fit never will.
    const lasting = built.error.missing.some(
      (m) => m === 'context_budget' || m.startsWith('prompt:'),
    );
    return r === 'reviewer' && !lasting
      ? {
          outcome: 'failed',
          data: {
            failure_class: 'infra',
            message: `review context missing: ${built.error.missing.join(', ')}`,
            invoked: false,
          },
        }
      : {
          outcome: 'succeeded',
          data: {
            schema_checked: true,
            status: 'needs_context',
            summary: `missing context: ${built.error.missing.join(', ')}`,
            missing: built.error.missing,
            usage: { basis: 'unavailable' },
            invoked: false,
          },
        };
  }
  const workspace = harness.agent_paths === undefined ? undefined : await workspaceOf(deps, l);
  // Git/context reads yield: reconcile once more immediately before the harness can spawn.
  const current = deps.store.readTask(effect.task_id as Uuid);
  const allowed =
    current !== null && claimable(current, effect, deps.clock.now(), { require_runtime: true }).ok;
  if (!recovering && (signal.aborted || !allowed || current?.version !== l.s.version)) {
    if (!signal.aborted && allowed && refreshes > 0)
      return startAgent(deps, effect, signal, op, mirror, extra, refreshes - 1);
    if (!worker)
      return {
        outcome: 'failed',
        data: {
          failure_class: 'infra',
          message: 'state changed while preparing review context',
          invoked: false,
        },
      };
    return {
      outcome: 'succeeded',
      data: {
        schema_checked: true,
        status: 'needs_context',
        summary: 'state changed while preparing context; reconcile before another attempt',
        usage: { basis: 'unavailable' },
        invoked: false,
      },
    };
  }
  const wall = binding.limits.wall_timeout_ms;
  const resume = sessionFor(effect.request, harness);
  // Without a task deadline the run's is fixed by its operation, so recovery rebuilds the same input.
  const registered = l.s.operations[op.operation_id]?.registered_at ?? deps.clock.now();
  // Where a reviewer's worktree goes back to after it ran: HEAD and the full working tree. On disk
  // before the launch, since the review may outlive this daemon.
  if (r === 'reviewer' && !recovering) {
    const head = await gitHead(deps.git, where(deps, l).worktree);
    const tree = await worktreeTree(deps, l);
    if (head === null || !tree.ok)
      return {
        outcome: 'failed',
        data: {
          failure_class: 'infra',
          message: 'cannot read the worktree before the review',
          invoked: false,
        },
      };
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    writeAtomicIn(
      scratch,
      basename(reviewBaselineFile(deps, l.s.id, effect.id)),
      Buffer.from(JSON.stringify({ head, tree: tree.tree })),
    );
  }
  let out: HarnessOutcome;
  try {
    const input: HarnessInput = {
      role: r,
      operation_id: op.operation_id,
      attempt_id: mirror.attempt_id ?? effect.id,
      revision: l.s.revision,
      binding: {
        harness: binding.harness,
        vendor: harness.manifest.vendor,
        model: binding.model_id,
        effort: binding.effort,
        permission_policy_hash: harness.manifest.permission_policy_hash ?? hashCanonical('none'),
      },
      context: { text: built.value.text, digest: built.value.digest },
      schema: wireRoleSchema(r, { omit_meta_schema: false }),
      wall_ms: wall,
      deadline_at: (l.s.deadline_at ??
        (wall === null ? null : registered + wall)) as EpochMs | null,
      session: resume.session,
      max_turns: binding.limits.max_turns,
      credentials: l.rt.credential_refs,
      limits: {
        term_grace_ms: l.rt.limits.term_grace_ms,
        kill_verify_ms: l.rt.limits.kill_verify_ms,
        stall_ms: binding.limits.stall_timeout_ms,
      },
      ...(worker && harness.agent_paths !== undefined
        ? { collect: [{ scratch_name: contentName, host_path: file }] }
        : {}),
      ...(workspace === undefined ? {} : { workspace }),
      view: { project: l.s.project, title: `${r}: ${l.s.task.title}` },
    };
    if (!recovering) out = await harness.run(input, signal);
    else if (harness.recover === undefined)
      throw new InvocationUnknown(`harness ${binding.harness} cannot recover a finished run`);
    else out = harness.recover(input);
  } catch (e) {
    // Launch or end not proven: the effect is reconciled, its reservation kept (contracts/execution.md §5).
    if (e instanceof InvocationUnknown) return unknown(e.message);
    throw e;
  }
  // Commit finalized records and artifacts through the same cursor-based ingester in every runtime.
  // ACK remains gated on both the operation and its effect being resolved.
  if (out.ingest !== undefined) {
    const report = ingestOperationSpool(
      {
        store: deps.store,
        dataDir: deps.dataDir,
        redactor: deps.redactor,
        now: () => deps.clock.now(),
        newId: deps.newId,
      },
      effect.task_id,
      out.ingest.operation_id,
    );
    if (
      report.status === 'write_failed' ||
      report.status === 'rejected' ||
      report.status === 'unreadable' ||
      report.status === 'no_run_dir'
    ) {
      if (report.status === 'write_failed')
        deps.latch?.(`store write failed during spool ingest: ${report.detail ?? ''}`);
      return unknown(`spool ingest ${report.status}: ${report.detail ?? ''}`);
    }
  }
  // The reviewer may edit, run checks and commit; what it changed never reaches the task. A restore
  // that fails leaves the tree changed, and the next worker step waits for a person on that (T072).
  if (r === 'reviewer' && !(out.kind === 'failure' && out.invoked === false))
    await restoreAfterReview(deps, l.s.id, effect.id);
  const raw = agentOutcome(r, binding.harness, out, review?.sha ?? null, inputDigest);
  // A worker's summary is kept in state and shown to the next reviewer, so it is stored redacted.
  const verdict = worker ? redactedSummary(raw, deps.redactor) : raw;
  const plain = review === null ? verdict : await withChangedSince(deps, l, review.sha, verdict);
  const outcome = withSession(plain, out, resume);
  if (!worker) return outcome;
  const accepted = acceptContent(deps, l, file, outcome);
  // What the attempt left is now the task's tree; an attempt never invoked changed nothing.
  if (out.kind === 'failure' && out.invoked === false) return accepted;
  if (minorStep(l.policy, mirror.step) && !workerDone(accepted)) await restoreCheckpoint(deps, l);
  const after = await worktreeTree(deps, l);
  if (!after.ok) return accepted;
  const recorded = withWorktreeTree(accepted, after.tree);
  const update = l.s.run.base_update;
  if (
    update?.conflict !== undefined &&
    update.certificate === undefined &&
    // In a review/fix round a gate fixer may follow the conflict fixer before the merge is certified.
    (update.fixer_attempt_id === mirror.attempt_id || update.fix_step !== undefined) &&
    recorded.outcome === 'succeeded'
  ) {
    const scope = await baseRepairScope(
      deps.git,
      where(deps, l).worktree,
      update.head_sha,
      update.conflict,
      after.tree,
    );
    return {
      ...recorded,
      data: {
        ...(recorded.data as Record<string, unknown>),
        base_repair: scope,
      },
    };
  }
  return recorded;
}

/** Where a role outside the attempt flow runs on this task. */
export function taskWorkspace(
  deps: HandlerDeps,
  taskId: string,
): Promise<{ worktree: string; git_dirs: string[] }> {
  return workspaceOf(deps, load(deps, { task_id: taskId } as Effect));
}

/** The task worktree and the Git dirs a sandboxed role sees read-only (common dir, worktree admin dir). */
async function workspaceOf(
  deps: HandlerDeps,
  l: Loaded,
): Promise<{ worktree: string; git_dirs: string[] }> {
  const worktree = where(deps, l).worktree;
  const admin = (await gitText(deps, worktree, ['rev-parse', '--absolute-git-dir'], 4096)).trim();
  const common = await commonDir(deps, l.rt.project_path);
  return {
    worktree,
    git_dirs: admin === common ? [common] : [common, admin],
  };
}

type ResumeChoice = {
  readonly session: HarnessInput['session'];
  readonly fallback: string | null;
  readonly asked: boolean;
};

/**
 * Resumes the engine's chosen worker session only when the harness proved resume works; otherwise a new
 * session with the reason recorded. The context is the full repair packet in both cases (M04).
 */
export function sessionFor(request: Record<string, unknown>, harness: HarnessPort): ResumeChoice {
  const plan = request['resume'] as
    | { session_ref?: unknown; from_attempt_id?: unknown }
    | null
    | undefined;
  const reason = typeof request['resume_reason'] === 'string' ? request['resume_reason'] : null;
  if (plan === undefined || plan === null || typeof plan.session_ref !== 'string')
    return { session: null, fallback: reason, asked: false };
  if (harness.manifest.capabilities.resume !== 'proven')
    return {
      session: null,
      fallback: `resume_${harness.manifest.capabilities.resume}`,
      asked: true,
    };
  return {
    session: {
      ref: plan.session_ref,
      ...(typeof plan.from_attempt_id === 'string'
        ? { from_attempt_id: plan.from_attempt_id }
        : {}),
    },
    fallback: null,
    asked: true,
  };
}

function withSession(out: EffectOutcome, o: HarnessOutcome, r: ResumeChoice): EffectOutcome {
  if (out.outcome !== 'succeeded') return out;
  const fallback = o.resume_fallback ?? r.fallback;
  const extra = {
    session_ref: o.session_ref,
    ...(r.asked || fallback !== null ? { resumed: o.resumed ?? r.session !== null } : {}),
    ...(fallback === null ? {} : { resume_fallback: fallback }),
  };
  return {
    outcome: 'succeeded',
    data: { ...(out.data as Record<string, unknown>), ...extra },
  };
}

// ---- gates ----

function minorStep(policy: FrozenPolicy, step: string | null): boolean {
  const def = step === null ? undefined : policy.workflow.steps[step];
  return def !== undefined && isMinorStep(def);
}

function workerDone(o: EffectOutcome): boolean {
  if (o.outcome !== 'succeeded') return false;
  const d = o.data as { status?: unknown; schema_checked?: unknown };
  return d.schema_checked === true && d.status === 'done';
}

/**
 * Drops a minor fix: the worktree goes back to the approved checkpoint, so the task carries on from the
 * commit the review approved. Returns the tree it restored, or null when there was nothing to restore
 * to or Git could not; a tree left changed makes the next worker step wait for a person (T072).
 */
async function restoreCheckpoint(deps: HandlerDeps, l: Loaded): Promise<string | null> {
  const cp = l.s.run.checkpoint;
  if (cp === null || cp.revision !== l.s.revision) return null;
  const r = await restoreWorktree(deps.git, where(deps, l).worktree, {
    head: cp.sha,
    tree: cp.tree,
  });
  return r.ok ? cp.tree : null;
}

/** The gate step whose pass leads to review or publish: it ends with the checkpoint commit. */
function commitStep(policy: FrozenPolicy, step: string | null): boolean {
  const pass = step === null ? undefined : policy.workflow.steps[step]?.next['pass'];
  const next = pass === undefined ? undefined : policy.workflow.steps[pass];
  return next?.kind === 'review' || next?.action === 'git.publish';
}

/** Key of the checkpoint commit a gate effect makes: one logical commit per effect. */
const commitKey = (s: TaskState, effectId: string): string => `${s.id}.r${s.revision}.${effectId}`;

/** The command journal of one effect, kept across daemon lives (FR-004). */
const journalOf = (deps: HandlerDeps, effectId: string): CommandJournal =>
  new CommandJournal(join(deps.paths.receipts, effectId));

/**
 * Commits the tree every required gate passed on (M06), with the worker's commit message. A tree equal
 * to HEAD keeps HEAD: a worker that changed nothing does not make a new commit.
 */
async function checkpointCommit(
  deps: HandlerDeps,
  l: Loaded,
  effect: Effect,
  tree: string,
): Promise<Record<string, unknown>> {
  const spec = await checkpointSpec(deps, l);
  const cp = await takeCheckpoint(deps.git, spec);
  if (!cp.ok)
    throw new Skip(
      cp.error.kind === 'unknown' ? unknown(cp.error.detail) : failed('infra', cp.error.detail),
    );
  if (cp.value.tree_oid !== tree)
    throw new Skip({
      outcome: 'succeeded',
      data: { results: [], tree: cp.value.tree_oid, stable: false },
    });
  const content = currentContent(deps, l.s);
  const ref = l.s.run.content;
  if (content === null || ref === null)
    throw new Skip(failed('infra', 'no accepted publish content for the commit message'));
  const head = await headOf(deps, spec.worktree_path);
  let sha = head.sha;
  let committed = false;
  if (
    tree !== head.tree ||
    (l.s.run.base_update?.conflict !== undefined &&
      l.s.run.base_update.certificate === undefined &&
      head.sha === l.s.run.base_update.head_sha)
  ) {
    const intents = new FileCommitIntentStore(deps.paths.intents);
    const key = commitKey(l.s, effect.id);
    // A recovered run commits the same tree on the same parent: it reuses the stored times, so the
    // commit is the one the intent names, never a second one (FR-018).
    const prior = intents.load(key);
    const at =
      prior !== null && prior.tree === tree && prior.parent === cp.value.parent_oid
        ? prior.author.at
        : deps.clock.now();
    const c = await commitCheckpoint(deps.git, intents, {
      key,
      worktree_path: spec.worktree_path,
      branch: spec.branch,
      tree,
      parent: cp.value.parent_oid,
      ...(l.s.run.base_update?.conflict !== undefined &&
      l.s.run.base_update.certificate === undefined &&
      cp.value.parent_oid === l.s.run.base_update.head_sha
        ? { merge_parent: l.s.run.base_update.base_sha }
        : {}),
      author: { ...deps.committer, at },
      committer: { ...deps.committer, at },
      message: content.commit_message,
    });
    if (c.kind === 'unknown') throw new Skip(unknown(c.detail));
    if (c.kind !== 'committed' && c.kind !== 'recovered')
      throw new Skip(failed('infra', `commit ${c.kind}`));
    sha = c.intent.oid;
    committed = c.kind === 'committed';
  }
  const raw = await gitText(
    deps,
    spec.worktree_path,
    ['diff', '--raw', '--no-abbrev', '--no-renames', l.rt.base_sha, sha],
    4 * 1024 * 1024,
  );
  const conflicts = await readBaseConflicts(
    deps.git,
    spec.worktree_path,
    l.rt.target.base_ref,
    sha,
  );
  return {
    sha,
    tree,
    base_sha: l.rt.base_sha,
    diff_digest: hashText(raw),
    content_digest: ref.digest,
    committed,
    ...(conflicts === undefined ? {} : { base_conflicts: conflicts }),
  };
}

/** The sandbox of a project command (setup, gate, autofix): no context, no schema, no harness auth. */
function commandLayout(
  deps: HandlerDeps,
  l: Loaded,
  spec: CheckpointSpec,
): CommandSetInput['layout'] {
  const w = where(deps, l);
  return {
    worktree: w.worktree,
    git_dirs: [spec.common_git_dir],
    scratch: w.scratch,
    context: null,
    schema: null,
    toolchain: [...(deps.gate_toolchain ?? [])],
    env: {},
    network: 'internet_outbound',
  };
}

/** Run under a {@link guard}: its ports refuse new commands once it fired; the caller reports that. */
/**
 * Gates of a minor fix that fail drop the fix like failed gates do: the worktree goes back to the
 * approved checkpoint first. An outcome not known yet is left as it is for reconcile to read; if the
 * fix is dropped then, the approved tree is the task's own and a changed worktree waits (T072).
 */
async function gates(
  deps: HandlerDeps,
  effect: Effect,
  step: string | null,
  signal: AbortSignal,
): Promise<EffectOutcome> {
  const l = load(deps, effect);
  if (!minorStep(l.policy, step)) return runGateStep(deps, effect, step, signal);
  const out = await runGateStep(deps, effect, step, signal);
  if (out.outcome === 'failed') await restoreCheckpoint(deps, l);
  return out;
}

async function runGateStep(
  deps: HandlerDeps,
  effect: Effect,
  step: string | null,
  signal: AbortSignal,
): Promise<EffectOutcome> {
  const l = load(deps, effect);
  requireNativeExecution(deps, l);
  const list = Array.isArray(effect.request['gates'])
    ? (effect.request['gates'] as { gate: string; cmd: string }[])
    : [];
  const required = Array.isArray(effect.request['required'])
    ? (effect.request['required'] as string[])
    : [];
  const spec = await checkpointSpec(deps, l);
  const update = l.s.run.base_update;
  let manualClean: { tree: string; files: string[] } | undefined;
  if (update?.manual_resolution !== undefined && update.conflict === undefined) {
    const plan = new FileCommitIntentStore(deps.paths.intents).load(
      baseUpdateIntentKey(spec, update),
    );
    if (plan !== null && plan.conflict_files === undefined) {
      const head = await headOf(deps, spec.worktree_path);
      if (
        plan.parent !== update.head_sha ||
        plan.merge_parent !== update.base_sha ||
        plan.branch !== spec.branch ||
        plan.worktree_path !== spec.worktree_path ||
        (head.sha !== plan.oid && head.sha !== l.s.run.checkpoint?.sha)
      )
        return failed('refused', 'local head does not match the durable base update');
      manualClean = { tree: plan.tree, files: [] };
    }
  }
  if (effect.request['base_update'] !== undefined && manualClean === undefined) {
    const update = BaseUpdateSchema.safeParse(effect.request['base_update']);
    if (!update.success) return failed('auth_config', 'invalid base update request');
    const result = await updateBase(deps.git, new FileCommitIntentStore(deps.paths.intents), {
      ...update.data,
      checkpoint: spec,
      remote: deps.remoteUrl(l.rt.target.repo),
      identity: deps.committer,
      at: deps.clock.now(),
    });
    if (result.kind === 'conflict')
      return {
        outcome: 'succeeded',
        data: {
          results: [],
          tree: result.tree,
          stable: true,
          base_conflict: { tree: result.tree, files: result.files },
        },
      };
    if (result.kind !== 'updated')
      return result.kind === 'unknown' ? unknown(result.detail) : failed('refused', result.detail);
  }
  const repairScope = async (tree: string) => {
    const baseline = update?.conflict ?? manualClean;
    if (baseline === undefined || update === undefined) return undefined;
    const scope = await baseRepairScope(
      deps.git,
      spec.worktree_path,
      update.head_sha,
      baseline,
      tree,
    );
    return update.manual_resolution !== undefined &&
      scope.markers === false &&
      scope.problem === undefined
      ? { ...scope, unresolved: false }
      : scope;
  };
  if (update?.conflict !== undefined && update.certificate === undefined) {
    const before = await worktreeTree(deps, l);
    if (!before.ok) return before.outcome;
    const head = await headOf(deps, spec.worktree_path);
    // Recovery may change files, never accept an unrelated local commit silently.
    if (head.sha !== update.head_sha && head.sha !== l.s.run.checkpoint?.sha)
      return failed('refused', 'local head changed during conflict repair');
    if (
      update.manual_resolution === undefined &&
      update.scope !== undefined &&
      before.tree !== update.scope.tree
    )
      return failed('refused', 'worktree changed after conflict scope check');
    const scope = await repairScope(before.tree);
    if (scope?.unresolved)
      return failed('refused', scope.problem ?? 'conflict paths unchanged or markers remain');
  }
  const input = {
    commands: list.map((g) => ({ name: g.gate, command: g.cmd })),
    layout: commandLayout(deps, l, spec),
    wall_ms: l.rt.limits.command_wall_ms,
    deadline_at: l.s.deadline_at as EpochMs | null,
    checkpoint: spec,
  };
  // A stop request reaches every gate command: none is spawned after it, a running one is ended.
  const run = { ...deps, journal: journalOf(deps, effect.id) };
  if (step === 'ci_autofix') {
    const r = await runAutofix(run, input);
    if (r.kind === 'unknown')
      return r.retry_allowed ? failed('infra', r.detail) : unknown(r.detail);
    return { outcome: 'succeeded', data: r.data ?? { results: [] } };
  }
  const r = await runGates(run, input);
  // Stopped: nothing is committed from a run cut short; the guard reports how it ended.
  if (signal.aborted) return failed('infra', 'stopped');
  if (r.kind === 'unknown') return r.retry_allowed ? failed('infra', r.detail) : unknown(r.detail);
  const data = r.data ?? { results: [], tree: '', stable: true };
  const must = required.length > 0 ? required : data.results.map((x) => x.gate);
  const passed =
    must.length > 0 && must.every((g) => data.results.some((x) => x.gate === g && x.passed));
  const minor = minorStep(l.policy, step);
  if (minor && (!passed || !data.stable)) {
    await restoreCheckpoint(deps, l);
    return { outcome: 'succeeded', data };
  }
  if (!passed || !data.stable || !commitStep(l.policy, step)) return { outcome: 'succeeded', data };
  const scope =
    update !== undefined && update.certificate === undefined
      ? await repairScope(data.tree)
      : undefined;
  if (scope?.unresolved)
    return failed('refused', 'gate left conflict markers; no checkpoint applied');
  const checkpoint = await checkpointCommit(deps, l, effect, data.tree);
  const changed =
    typeof checkpoint['sha'] === 'string'
      ? minor
        ? await changedSinceApproval(deps, l, checkpoint['sha'])
        : await changedSinceRejection(deps, l, checkpoint['sha'])
      : null;
  return {
    outcome: 'succeeded',
    data: {
      ...data,
      ...(scope === undefined ? {} : { base_scope: scope }),
      checkpoint,
      ...(changed === null ? {} : { changed_since: changed }),
    },
  };
}

// ---- publish ----

/**
 * Pushes the checkpoint SHA the evidence is about (M06, H03/H04). Before the push the local branch,
 * HEAD and worktree must still be that commit; the push itself keeps the expected-old guard at the
 * remote update and only fast-forwards. A remote or worktree that moved is a head drift fact, not a
 * retry.
 */
async function publish(
  deps: HandlerDeps,
  effect: Effect,
): Promise<{ outcome: EffectOutcome; extra: Trigger[] }> {
  if (effect.request['salvage'] !== undefined)
    return { outcome: await salvage(deps, effect), extra: [] };
  const l = load(deps, effect);
  const sha = typeof effect.request['sha'] === 'string' ? effect.request['sha'] : null;
  const cp = l.s.run.checkpoint;
  if (sha === null || cp === null || cp.sha !== sha || cp.revision !== l.s.revision)
    return {
      outcome: failed('infra', 'publish without the current checkpoint'),
      extra: [],
    };
  const spec = await checkpointSpec(deps, l);
  const now = await takeCheckpoint(deps.git, spec);
  if (!now.ok)
    return {
      outcome:
        now.error.kind === 'unknown'
          ? unknown(now.error.detail)
          : failed('infra', now.error.detail),
      extra: [],
    };
  const head = await headOf(deps, spec.worktree_path);
  const branch = (
    await gitText(deps, spec.worktree_path, ['rev-parse', `refs/heads/${spec.branch}`], 1024)
  ).trim();
  if (head.sha !== sha || branch !== sha || now.value.tree_oid !== cp.tree) {
    const drift: Trigger = {
      kind: 'head_drift',
      expected: sha,
      observed: head.sha === sha ? `tree:${now.value.tree_oid}` : head.sha,
      source: 'worktree',
      evidence_ref: `effect:${effect.id}`,
    };
    return {
      outcome: failed('auth_config', 'worktree or branch changed after the checkpoint'),
      extra: [drift],
    };
  }
  const published = publishedHead(l.s);
  const r = await pushBranch(deps.git, {
    cwd: spec.worktree_path,
    remote_url: deps.remoteUrl(l.rt.target.repo),
    branch: remoteBranch(l.s),
    expected_old: published,
    new_sha: sha,
  });
  if (r.kind === 'unknown') return { outcome: unknown(r.detail), extra: [] };
  if (r.kind === 'head_changed') {
    const drift: Trigger = {
      kind: 'head_drift',
      expected: published,
      observed: r.remote_sha,
      source: 'publish_probe',
      evidence_ref: `effect:${effect.id}`,
    };
    return {
      outcome: failed('auth_config', 'remote branch moved'),
      extra: [drift],
    };
  }
  if (r.kind !== 'pushed' && r.kind !== 'already_pushed')
    return { outcome: failed('infra', `push ${r.kind}`), extra: [] };
  return {
    outcome: await pushedOutcome(deps, l, spec.worktree_path, sha),
    extra: [],
  };
}

/** What a salvage publishes, fixed by its request so a rerun or a probe sends and looks for the same. */
function salvageOf(l: Loaded, effect: Effect): { reason: string; title: string } {
  const o = effect.request['salvage'] as { reason?: unknown; title?: unknown };
  return {
    reason: typeof o.reason === 'string' ? o.reason : 'failed',
    title: typeof o.title === 'string' ? o.title : l.s.task.title,
  };
}

function salvagePrSpec(l: Loaded, effect: Effect, sha: string): PrSpec {
  const { reason, title } = salvageOf(l, effect);
  return {
    repo: l.rt.target.repo,
    immutable_repo_id: l.rt.target.immutable_repo_id,
    head_branch: remoteBranch(l.s),
    base: l.s.task.base_branch,
    head_sha: sha,
    title: `[failed] ${title}`,
    body: `This task failed and its work is kept here as a draft for a person to look at.\n\nReason: ${reason}`,
    task_id: l.s.id,
    revision: l.s.revision,
    operation_key: effect.idem_key,
    draft: true,
  };
}

async function salvagedOutcome(
  deps: HandlerDeps,
  l: Loaded,
  cwd: string,
  sha: string,
  pr: PrFact,
): Promise<EffectOutcome> {
  const pushed = await pushedOutcome(deps, l, cwd, sha);
  if (pushed.outcome !== 'succeeded') return pushed;
  return {
    outcome: 'succeeded',
    data: {
      ...(pushed.data as Record<string, unknown>),
      pr_ref: `${l.rt.target.repo}#${pr.number}`,
    },
  };
}

/**
 * A failing task's work as a draft PR (#247): what the worktree holds is committed on the task branch
 * (no gate passed, so no checkpoint exists), pushed, and opened as a draft whose body gives the reason.
 * Nothing beyond the frozen base means nothing to show, and no PR is opened. It keeps the guarantees of
 * the usual path: the commit intent fixes the commit, an unknown push or PR outcome is reconciled by
 * {@link probeSalvage} through the PR marker, and a rerun under the same key repeats nothing.
 */
async function salvage(deps: HandlerDeps, effect: Effect): Promise<EffectOutcome> {
  const l = load(deps, effect);
  const { reason, title } = salvageOf(l, effect);
  const spec = await checkpointSpec(deps, l);
  const cp = await takeCheckpoint(deps.git, spec);
  if (!cp.ok)
    return cp.error.kind === 'unknown'
      ? unknown(cp.error.detail)
      : failed('infra', `worktree: ${cp.error.detail}`);
  const head = await headOf(deps, spec.worktree_path);
  let sha = head.sha;
  if (cp.value.tree_oid !== head.tree) {
    const intents = new FileCommitIntentStore(deps.paths.intents);
    const key = commitKey(l.s, effect.id);
    // As for a checkpoint: a rerun commits the same tree on the same parent with the stored times.
    const prior = intents.load(key);
    const at =
      prior !== null && prior.tree === cp.value.tree_oid && prior.parent === cp.value.parent_oid
        ? prior.author.at
        : deps.clock.now();
    const c = await commitCheckpoint(deps.git, intents, {
      key,
      worktree_path: spec.worktree_path,
      branch: spec.branch,
      tree: cp.value.tree_oid,
      parent: cp.value.parent_oid,
      author: { ...deps.committer, at },
      committer: { ...deps.committer, at },
      message: `WIP: ${title}\n\nUnfinished work of a failed task: ${reason}`,
    });
    if (c.kind === 'unknown') return unknown(c.detail);
    if (c.kind !== 'committed' && c.kind !== 'recovered')
      return failed('infra', `commit ${c.kind}`);
    sha = c.intent.oid;
  }
  if (sha === l.rt.base_sha) return failed('refused', 'nothing to publish beyond the base');
  const r = await pushBranch(deps.git, {
    cwd: spec.worktree_path,
    remote_url: deps.remoteUrl(l.rt.target.repo),
    branch: remoteBranch(l.s),
    expected_old: publishedHead(l.s),
    new_sha: sha,
  });
  if (r.kind === 'unknown') return unknown(r.detail);
  if (r.kind !== 'pushed' && r.kind !== 'already_pushed') return failed('infra', `push ${r.kind}`);
  const pr = await createOrRecoverPr(deps.github(), salvagePrSpec(l, effect, sha));
  if (pr.kind === 'unknown') return unknown(pr.detail);
  if (pr.kind !== 'created' && pr.kind !== 'recovered')
    return failed('infra', `pull request ${pr.kind}`);
  return salvagedOutcome(deps, l, spec.worktree_path, sha, pr.pr);
}

/** The salvage PR found by its marker links it; otherwise the salvage runs again under its key. */
async function probeSalvage(deps: HandlerDeps, target: Effect): Promise<Probe> {
  const l = load(deps, target);
  const cwd = where(deps, l).worktree;
  const head = await headOf(deps, cwd);
  if (head.sha === l.rt.base_sha)
    return { finding: 'not_executed', detail: 'nothing committed beyond the base' };
  const r = await probePr(deps.github(), salvagePrSpec(l, target, head.sha));
  switch (r.kind) {
    case 'recovered':
      return fromOutcome(await salvagedOutcome(deps, l, cwd, head.sha, r.pr));
    case 'absent':
    case 'unclaimed':
      return { finding: 'not_executed', detail: 'no salvage PR yet; it runs again' };
    case 'unknown':
      return still(r.detail);
    default:
      return {
        finding: 'executed_failed',
        failure_class: 'infra',
        detail: `pull request ${r.kind}`,
      };
  }
}

/**
 * The head published by the last valid publish, else the head an adoption approved: what the remote
 * branch is expected to hold now. Null only for a branch that must not exist yet.
 */
const publishedHead = (s: TaskState): string | null =>
  s.evidence.publishes.filter((p) => p.valid).at(-1)?.head_sha ?? s.adoption?.head_sha ?? null;

/** A publish whose SHA is on the remote: the head and how it relates to the frozen base. */
async function pushedOutcome(
  deps: HandlerDeps,
  l: Loaded,
  cwd: string,
  sha: string,
): Promise<EffectOutcome> {
  const contains = await deps.git.run({
    args: ['merge-base', '--is-ancestor', l.rt.base_sha, sha],
    cwd,
    timeout_ms: 10_000,
    max_output_bytes: 1024,
    stdin: null,
  });
  return {
    outcome: 'succeeded',
    data: {
      head_sha: sha,
      base_relation: {
        head_sha: sha,
        base_ref: l.s.task.base_branch,
        base_sha: l.rt.base_sha,
        head_contains_base: contains.kind === 'exited' && contains.code === 0,
      },
    },
  };
}

// ---- create_pr / await_ci ----

function prNumber(ref: string | null): number | null {
  const m = ref === null ? null : /#(\d+)$/.exec(ref);
  return m === null ? null : Number(m[1]);
}

/** Identity of the task's PR: repo, head/base tuple and the marker with this operation's key. */
function prSpecOf(l: Loaded, head: string, content: PublishContent, operationKey: string): PrSpec {
  return {
    repo: l.rt.target.repo,
    immutable_repo_id: l.rt.target.immutable_repo_id,
    head_branch: remoteBranch(l.s),
    base: l.s.task.base_branch,
    head_sha: head,
    title: content.pr_title,
    body: content.pr_body,
    task_id: l.s.id,
    revision: l.s.revision,
    operation_key: operationKey,
  };
}

/** The task's PR, created or found again, as `create_pr` data. */
function prOutcome(
  l: Loaded,
  content: PublishContent,
  operationKey: string,
  pr: PrFact,
  bodyDigest: string,
): EffectOutcome {
  return {
    outcome: 'succeeded',
    data: {
      pr_ref: `${l.rt.target.repo}#${pr.number}`,
      head_sha: pr.head_sha,
      body_digest: bodyDigest,
      pr_body: {
        content_digest: l.s.run.content?.digest ?? hashCanonical(content),
        body_digest: bodyDigest,
        operation_key: operationKey,
        revision: l.s.revision,
      },
    },
  };
}

async function createPr(deps: HandlerDeps, effect: Effect): Promise<EffectOutcome> {
  const l = load(deps, effect);
  if (l.s.head_sha === null) return failed('infra', 'no published head');
  const content = currentContent(deps, l.s);
  if (content === null) return failed('infra', 'no accepted PR content');
  if (effect.request['update'] === true) return describePr(deps, l, content);
  const r = await createOrRecoverPr(deps.github(), {
    ...prSpecOf(l, l.s.head_sha, content, effect.idem_key),
    draft: effect.request['draft'] === true,
  });
  if (r.kind === 'created' || r.kind === 'recovered')
    return prOutcome(l, content, r.operation_key ?? effect.idem_key, r.pr, r.body_digest);
  if (r.kind === 'unknown') return unknown(r.detail);
  // Someone else's PR or a forged or edited marker/body: a person reconciles.
  if (r.kind === 'conflict') return failed('auth_config', `pull request conflict: ${r.reason}`);
  // Content GitHub or we refuse is the content's fault, not the credentials' (#249).
  if (r.kind === 'content_rejected')
    return failed('invalid_output', `PR content rejected: ${r.field}`);
  if (r.kind === 'content_invalid')
    return failed('invalid_output', `PR content refused after fitting it: ${r.detail}`);
  return failed('infra', `pull request ${r.kind}`);
}

type CiData = z.infer<typeof AwaitCiDataSchema>;

/** What one read of the task's PR established: CI data of its head (or why none), and facts for the engine. */
export type ObservedPr = {
  readonly ci: CiData | null;
  readonly failure: string | null;
  readonly facts: Trigger[];
};

/**
 * One read of the task's PR. Every readable outcome yields an `observation_result` (merged, open,
 * closed, or unknown for a read that could not be trusted) bound to the window's generation; a merge
 * with complete evidence adds the merge proof, a head the task did not push adds a drift fact, and an
 * open PR carries the CI data of its head. Shared by `await_ci`, the observation service and recheck.
 * With `local`, a head a worker pushed from the task worktree (between the pushed head and the
 * worktree HEAD) is the task's own and no drift; it carries no CI evidence until the daemon pushes.
 */
export async function observeTaskPr(
  deps: Pick<HandlerDeps, 'store' | 'github' | 'clock' | 'newId'> & {
    readonly local?: {
      readonly git: GitPort;
      readonly worktrees: string;
      /** Lets a drift be checked as GitHub's "Update branch" (#110); without it every drift is plain. */
      readonly remoteUrl?: (repo: string) => string;
    };
  },
  taskId: string,
  evidenceRef: string,
  source: Observation['source'],
): Promise<ObservedPr> {
  let l: Loaded;
  try {
    l = load(deps, { task_id: taskId } as Effect);
  } catch (e) {
    if (e instanceof Skip) return { ci: null, failure: e.message, facts: [] };
    throw e;
  }
  const n = prNumber(l.s.pr_ref);
  if (n === null) return { ci: null, failure: 'no PR to observe', facts: [] };
  const now = deps.clock.now();
  const obs = await observePull(
    deps.github(),
    {
      repo: l.rt.target.repo,
      immutable_repo_id: l.rt.target.immutable_repo_id,
      pr_number: n,
      pr_id: null,
      target: l.s.task.base_branch,
      skipped_before: l.s.run.pr_ready_at ?? null,
    },
    now,
  );
  const known = l.s.observation?.subject ?? null;
  const subjectOf = (pull: { id: number | null; head: { ref: string | null } } | null) =>
    known ??
    (pull?.id == null
      ? null
      : {
          provider: 'github' as const,
          immutable_repo_id: l.rt.target.immutable_repo_id,
          subject_id: String(pull.id),
          target_ref: l.s.task.base_branch,
          head_ref: pull.head.ref ?? 'unknown',
        });
  const observation = (
    status: Observation['status'],
    head: string | null,
    digest: unknown,
    merge_proof = false,
  ): Trigger[] => {
    const subject = subjectOf(obs.pull);
    if (subject === null) return [];
    const o: Observation = {
      observation_id: deps.newId(),
      source,
      requested_at: now,
      observed_at: deps.clock.now(),
      generation: source === 'timer' ? (l.s.observation?.budget.generation ?? 0) : 0,
      subject,
      status,
      observed_head: head,
      raw_evidence_ref: evidenceRef,
      completeness: { merge_proof, quality: status === 'open' },
    };
    return [
      {
        kind: 'observation_result',
        observation: o,
        remote_digest: hashCanonical({ status, head, digest }),
      },
    ];
  };
  const noCi = (head: string | null): CiData => ({
    head_sha: head ?? l.s.head_sha ?? 'none',
    required_set: { names: [], source: 'policy', complete: false },
    checks: [],
  });
  if (obs.status === 'merged') {
    const facts = observation(
      'merged',
      obs.pull.head.sha,
      obs.merge,
      obs.merge.completeness === 'complete',
    );
    const first = facts[0];
    if (first?.kind === 'observation_result') {
      const proof = toMergeProof(obs.merge, first.observation.subject, l.s.head_sha, {
        observation_id: first.observation.observation_id,
        evidence_ref: evidenceRef,
      });
      if (proof !== null)
        facts.push({
          kind: 'external_completion',
          proof,
          unverified_reason: null,
        });
    }
    return { ci: noCi(obs.pull.head.sha), failure: null, facts };
  }
  // A PR moved to another branch: its CI there is no evidence for the task's target (FR-041.05).
  if (obs.status === 'target_mismatch') {
    const ci = {
      ...noCi(obs.pull.head.sha),
      target_ref: obs.pull.base.ref ?? 'unknown',
      ...(obs.pull.merged === true ? { target_merged: true } : {}),
    };
    // The fact carries the other branch so every reader (CI wait, observation, recheck) sees the mismatch.
    const target = {
      ref: obs.pull.base.ref ?? 'unknown',
      merged: obs.pull.merged === true,
    };
    const facts = observation('unknown', obs.pull.head.sha, { target });
    const first = facts[0];
    if (first?.kind === 'observation_result') first.target = target;
    return { ci, failure: null, facts };
  }
  if (obs.status !== 'open' && obs.status !== 'closed') {
    return {
      ci: null,
      failure: `observation ${obs.status}: ${obs.reasons.join('; ')}`,
      facts: observation('unknown', obs.pull?.head.sha ?? null, {
        status: obs.status,
        reasons: obs.reasons,
      }),
    };
  }
  if (obs.status === 'closed')
    return {
      ci: { ...noCi(obs.pull.head.sha), pr_state: 'closed' },
      failure: null,
      facts: observation('closed', obs.pull.head.sha, null),
    };
  const verdict = evaluateRequired(obs.required, l.policy.ci.required_checks);
  const names = verdict.kind === 'covered' ? [...verdict.github] : [];
  const checks = obs.checks?.checks.map((c) => ({ name: c.name, state: c.state })) ?? [];
  const complete =
    verdict.kind === 'covered' &&
    obs.checks !== null &&
    obs.checks.complete &&
    obs.checks.collisions.length === 0;
  const ci: CiData = {
    head_sha: obs.pull.head.sha as string,
    required_set: { names, source: 'branch_protection', complete },
    checks,
    required: requiredData(verdict),
  };
  const facts = observation('open', obs.pull.head.sha, {
    required: ci.required,
    checks,
    complete,
  });
  // A PR head that is not the head this task pushed: a drift fact, never the new expected head (H01).
  if (l.s.head_sha !== null && obs.pull.head.sha !== null && obs.pull.head.sha !== l.s.head_sha) {
    if (
      deps.local !== undefined &&
      (await workerPushed(deps.local, l, l.s.head_sha, obs.pull.head.sha))
    )
      return { ci: noCi(obs.pull.head.sha), failure: null, facts };
    const merge =
      deps.local?.remoteUrl === undefined
        ? null
        : await checkBaseMerge(deps.local.git, {
            cwd: join(deps.local.worktrees, l.s.id),
            remote: deps.local.remoteUrl(l.rt.target.repo),
            target: l.s.task.base_branch,
            expected: l.s.head_sha,
            observed: obs.pull.head.sha,
          });
    facts.push({
      kind: 'head_drift',
      expected: l.s.head_sha,
      observed: obs.pull.head.sha,
      source: 'observation',
      evidence_ref: evidenceRef,
      ...(merge?.kind === 'clean' ? { base_merge: { base_sha: merge.base_sha } } : {}),
    });
    return { ci: noCi(obs.pull.head.sha), failure: null, facts };
  }
  const first = facts[0];
  if (first?.kind === 'observation_result') first.ci = ci;
  return { ci, failure: null, facts };
}

/** The description update of the task's PR to `content`: same PR, same marker, the body it last sent. */
function descriptionOf(l: Loaded, content: PublishContent): DescriptionUpdate | null {
  const n = prNumber(l.s.pr_ref);
  const pb = l.s.run.pr_body;
  if (n === null || pb === null || l.s.run.content === null) return null;
  return {
    repo: l.rt.target.repo,
    pr_number: n,
    expected_body_digest: pb.body_digest,
    spec: {
      title: content.pr_title,
      body: content.pr_body,
      task_id: l.s.id,
      revision: pb.revision,
      operation_key: pb.operation_key,
    },
  };
}

function describedOutcome(l: Loaded, bodyDigest: string): EffectOutcome {
  return {
    outcome: 'succeeded',
    data: {
      pr_ref: l.s.pr_ref as string,
      head_sha: l.s.head_sha as string,
      body_digest: bodyDigest,
      pr_body: {
        ...(l.s.run.pr_body as NonNullable<TaskState['run']['pr_body']>),
        content_digest: l.s.run.content?.digest as string,
        body_digest: bodyDigest,
      },
    },
  };
}

/**
 * Updates the title/description of the task's own PR to the newest worker content after a repair (M05/M07):
 * same PR, same marker; a body someone else edited is a reconciliation for a person, never overwritten.
 */
async function describePr(
  deps: HandlerDeps,
  l: Loaded,
  content: PublishContent,
): Promise<EffectOutcome> {
  const u = descriptionOf(l, content);
  if (u === null) return failed('infra', 'no PR description to update');
  const r = await updatePrDescription(deps.github(), u);
  switch (r.kind) {
    case 'updated':
    case 'already_current':
      return describedOutcome(l, r.body_digest);
    case 'unknown':
      return unknown(r.detail);
    case 'body_changed':
      return failed(
        'auth_config',
        `PR description was edited on GitHub (${r.observed_digest}); not overwritten`,
      );
    case 'content_rejected':
      return failed('invalid_output', `PR content rejected: ${r.field}`);
    case 'content_invalid':
      return failed('invalid_output', `PR content refused after fitting it: ${r.detail}`);
    case 'rejected':
      return failed('auth_config', `PR update refused: HTTP ${r.status}`);
  }
}

/** Whether `observed` lies between the head the task pushed and its worktree HEAD. */
async function workerPushed(
  local: { readonly git: GitPort; readonly worktrees: string },
  l: Loaded,
  pushed: string,
  observed: string,
): Promise<boolean> {
  const cwd = join(local.worktrees, l.s.id);
  const ancestor = async (a: string, b: string): Promise<boolean> => {
    const r = await local.git.run({
      args: ['merge-base', '--is-ancestor', a, b],
      cwd,
      timeout_ms: 30_000,
      max_output_bytes: 1024,
      stdin: null,
    });
    return r.kind === 'exited' && r.code === 0;
  };
  return (await ancestor(pushed, observed)) && (await ancestor(observed, 'HEAD'));
}

/** `await_ci`: the observation facts plus the CI data of the head as the effect's own result. */
export async function observeTask(
  deps: HandlerDeps,
  taskId: string,
  evidenceRef: string,
): Promise<{ outcome: EffectOutcome; extra: Trigger[] }> {
  const r = await observeTaskPr(
    {
      ...deps,
      local: { git: deps.git, worktrees: deps.paths.worktrees, remoteUrl: deps.remoteUrl },
    },
    taskId,
    evidenceRef,
    'timer',
  );
  // The effect's own result carries the CI; the observation fact need not repeat it.
  for (const f of r.facts) if (f.kind === 'observation_result') delete f.ci;
  if (r.ci === null)
    return {
      outcome: failed('infra', r.failure ?? 'observation failed'),
      extra: r.facts,
    };
  return { outcome: { outcome: 'succeeded', data: r.ci }, extra: r.facts };
}

/** The evaluator's verdict as effect data (plain arrays, closed schema). */
export function requiredData(v: RequiredVerdict): RequiredCheckVerdict {
  switch (v.kind) {
    case 'covered':
      return {
        kind: 'covered',
        github_required: v.github_required,
        github: [...v.github],
        ...(v.app_pinned === undefined ? {} : { app_pinned: v.app_pinned.map((p) => ({ ...p })) }),
        snapshot_only: [...v.snapshot_only],
      };
    case 'required_checks_mismatch':
      return {
        kind: 'required_checks_mismatch',
        missing_from_snapshot: [...v.missing_from_snapshot],
        app_pinned: v.app_pinned.map((p) => ({ ...p })),
        snapshot_only: [...v.snapshot_only],
      };
    case 'unknown':
      return { kind: 'unknown', basis: v.basis };
  }
}

// ---- rerun_ci ----

/**
 * Re-runs the failed jobs of the head's workflow runs once (T057). The engine only gets here for a
 * failure the frozen ci rules call infra/flaky, within the step's limit; a lost POST is unknown and is
 * reconciled, never posted again.
 */
async function rerunCi(deps: HandlerDeps, effect: Effect): Promise<EffectOutcome> {
  const l = load(deps, effect);
  const head = typeof effect.request['head_sha'] === 'string' ? effect.request['head_sha'] : null;
  if (head === null || head !== l.s.head_sha)
    return failed('infra', 'rerun for a head that is not the published head');
  const checks = Array.isArray(effect.request['checks'])
    ? (effect.request['checks'] as string[])
    : [];
  const r = await rerunFailedJobs(deps.github(), {
    repo: l.rt.target.repo,
    head_sha: head,
    checks,
  });
  switch (r.kind) {
    case 'rerun':
      return {
        outcome: 'succeeded',
        data: { head_sha: head, rerun_checks: [...r.checks] },
      };
    case 'nothing_to_rerun':
      return failed('unknown', `nothing to rerun: ${r.reason}`);
    case 'failed':
      return failed('auth_config', `rerun refused: ${r.detail}`);
    case 'unknown':
      return r.sent.length === 0 && /unreadable|incomplete/.test(r.detail)
        ? failed('infra', r.detail)
        : unknown(r.detail);
  }
}

// ---- mark_ready / post_review ----

function prOf(l: Loaded): { repo: string; n: number } {
  const n = prNumber(l.s.pr_ref);
  if (n === null) throw new Skip(failed('infra', 'no PR to act on'));
  return { repo: l.rt.target.repo, n };
}

function readyOutcome(l: Loaded, r: ReadyOutcome): EffectOutcome {
  switch (r.kind) {
    case 'ready':
      return {
        outcome: 'succeeded',
        data: { pr_ref: l.s.pr_ref, ready_at: r.ready_at },
      };
    // A closed, merged or retargeted PR, or one whose head moved, is the CI wait's to judge: it observes
    // the PR and records the merge, mismatch or drift.
    case 'closed':
    case 'retargeted':
    case 'head_moved':
      return {
        outcome: 'succeeded',
        data: { pr_ref: l.s.pr_ref, ready_at: null },
      };
    case 'rejected':
      return failed('auth_config', `ready for review refused: ${r.detail}`);
    case 'unknown':
      return unknown(r.detail);
  }
}

/** Turns the task's draft PR ready after the review approved it, so the repo's CI runs from here. */
async function markReadyEffect(deps: HandlerDeps, effect: Effect): Promise<EffectOutcome> {
  const l = load(deps, effect);
  const { repo, n } = prOf(l);
  if (l.s.head_sha === null) return failed('infra', 'no published head');
  return readyOutcome(
    l,
    await markReady(deps.github(), repo, n, {
      head_sha: l.s.head_sha,
      target: l.s.task.base_branch,
    }),
  );
}

function reviewMarker(taskId: string, attemptId: string): string {
  return `<!-- cusr:review task=${taskId} attempt=${attemptId} -->`;
}

/**
 * Posts the recorded verdict of one review attempt as a COMMENT review on the PR. It is a record for the
 * reader, not a step the task depends on: anything that keeps it from being posted is reported in the
 * data and the task goes on.
 */
async function postReviewEffect(deps: HandlerDeps, effect: Effect): Promise<EffectOutcome> {
  const l = load(deps, effect);
  const n = prNumber(l.s.pr_ref);
  const attemptId = String(effect.request['attempt_id']);
  const result = (
    outcome: 'posted' | 'not_posted' | 'unknown',
    detail: string | null,
    review_id: number | null = null,
  ): EffectOutcome => ({
    outcome: 'succeeded',
    data: { attempt_id: attemptId, outcome, review_id, inline: 0, detail },
  });
  const review = l.s.run.reviews.find((r) => r.attempt_id === attemptId);
  if (n === null || review === undefined)
    return result('not_posted', 'no PR or no recorded review');
  const marker = reviewMarker(l.s.id, review.attempt_id);
  const body = renderReview({
    template: (l.rt.review_template ?? defaultReviewTemplate()).content,
    round: typeof effect.request['round'] === 'number' ? effect.request['round'] : 1,
    review,
    marker,
  });
  const r = await postReview(deps.github(), {
    repo: l.rt.target.repo,
    pr_number: n,
    commit_id: review.sha,
    marker,
    body,
  });
  return r.kind === 'posted' ? result('posted', null, r.review_id) : result(r.kind, r.detail);
}

async function probeMarkReady(deps: HandlerDeps, target: Effect): Promise<Probe> {
  const l = load(deps, target);
  const { repo, n } = prOf(l);
  const r = await probeReady(deps.github(), repo, n);
  if (r.kind === 'draft') return { finding: 'not_executed', detail: 'PR is still a draft' };
  return fromOutcome(readyOutcome(l, r));
}

async function probePostReview(deps: HandlerDeps, target: Effect): Promise<Probe> {
  const l = load(deps, target);
  const n = prNumber(l.s.pr_ref);
  const attemptId = target.request['attempt_id'];
  if (n === null || typeof attemptId !== 'string')
    return { finding: 'not_executed', detail: 'nothing was posted' };
  const seen = await findPosted(deps.github(), {
    repo: l.rt.target.repo,
    pr_number: n,
    marker: reviewMarker(l.s.id, attemptId),
  });
  if (typeof seen === 'object' && seen !== null) return still(seen.error);
  // An interrupted send may still land: absent now is no proof it never will, so it is not sent again.
  return {
    finding: 'executed_succeeded',
    data: {
      attempt_id: attemptId,
      outcome: seen === null ? 'unknown' : 'posted',
      review_id: seen,
      inline: 0,
      detail: seen === null ? 'interrupted; no review with its marker yet' : null,
    },
  };
}

// ---- reconcile ----

type Reconciled = Extract<Trigger, { kind: 'effect_reconciled' }>;

/** What a probe established about the target effect, and the facts that go with it. */
type Probe =
  | {
      readonly finding: 'executed_succeeded';
      readonly data: unknown;
      readonly extra?: Trigger[];
    }
  | {
      readonly finding: 'executed_failed';
      readonly failure_class: NonNullable<Reconciled['failure_class']>;
      readonly signature?: string;
      readonly detail: string;
      /** The handler's whole failure data, when a run was read back (session, worktree tree, usage). */
      readonly data?: unknown;
      readonly extra?: Trigger[];
    }
  | { readonly finding: 'not_executed'; readonly detail: string }
  | { readonly finding: 'still_unknown'; readonly detail: string };

const still = (detail: string): Probe => ({
  finding: 'still_unknown',
  detail,
});

/**
 * A handler outcome turned into a finding: a fresh, complete run of a safe operation is its result,
 * with the facts that run observed (a merge seen by a CI read, T093).
 */
function fromOutcome(o: EffectOutcome, extra: Trigger[] = []): Probe {
  if (o.outcome === 'unknown') return still(o.detail);
  if (o.outcome === 'succeeded') return { finding: 'executed_succeeded', data: o.data, extra };
  const f = o.data as {
    failure_class: NonNullable<Reconciled['failure_class']>;
    message?: string;
  };
  return {
    finding: 'executed_failed',
    failure_class: f.failure_class,
    detail: f.message ?? 'failed',
    data: o.data,
    extra,
  };
}

/**
 * Setup/gates and autofix (FR-004). Gates and setup are declared safe to run again: after a lost run
 * they run again on the worktree as it is, and a checkpoint commit already made is found by its intent
 * (same tree and parent give the same OID). A branch some other hand moved keeps its checkpoint and
 * waits; nothing is reset. Autofix rewrites sources and is not safe: only its journal decides, either
 * nothing ever spawned (then the claim may go back) or every command it started has a receipt.
 */
async function probeGates(
  deps: HandlerDeps,
  target: Effect,
  step: string | null,
  signal: AbortSignal,
  trace: LocalTrace,
): Promise<Probe> {
  const l = load(deps, target);
  const journal = journalOf(deps, target.id).read();
  if (!journal.ok) return still(journal.detail);
  if (step === 'ci_autofix') {
    const spawned = journal.commands.filter((c) => c.started);
    if (spawned.length === 0)
      return {
        finding: 'not_executed',
        detail: 'journal: no autofix command was spawned',
      };
    const receipts = journal.commands.flatMap((c) => (c.receipt === null ? [] : [c.receipt]));
    const listed = Array.isArray(target.request['gates']) ? target.request['gates'].length : 0;
    const last = receipts.at(-1);
    const complete =
      spawned.every((c) => c.receipt !== null) &&
      receipts.every((r) => r.status !== 'unknown') &&
      (receipts.length === listed || (last !== undefined && last.status !== 'passed'));
    if (!complete) return still('autofix may have run and written; a person decides');
    return {
      finding: 'executed_succeeded',
      data: { results: receipts.map(gateResultOf) },
    };
  }
  const commit = await probeCommit(
    deps.git,
    new FileCommitIntentStore(deps.paths.intents),
    commitKey(l.s, target.id),
  );
  if (commit.kind === 'unknown') return still(`commit: ${commit.detail}`);
  if (commit.kind === 'head_changed')
    return still(
      `branch at ${commit.found ?? 'nothing'}, not the checkpoint ${commit.intent.oid}; kept as is`,
    );
  // Run again under the guard: a cancel or merge recorded while this probe runs stops it too.
  return fromOutcome(
    await guarded(
      deps,
      target.task_id,
      signal,
      (g) => gates(g.deps, target, step, g.signal),
      trace,
    ),
  );
}

/** Push by remote ref against expected old/new (FR-018): pushed is recorded, never pushed twice. */
async function probePublish(deps: HandlerDeps, target: Effect, done: boolean): Promise<Probe> {
  if (target.request['salvage'] !== undefined) return probeSalvage(deps, target);
  const l = load(deps, target);
  const sha = typeof target.request['sha'] === 'string' ? target.request['sha'] : null;
  if (sha === null) return still('publish without a SHA');
  const cwd = where(deps, l).worktree;
  const published = publishedHead(l.s);
  const r = await probePush(deps.git, {
    cwd,
    remote_url: deps.remoteUrl(l.rt.target.repo),
    branch: remoteBranch(l.s),
    expected_old: published,
    new_sha: sha,
  });
  switch (r.kind) {
    case 'pushed':
      return fromOutcome(await pushedOutcome(deps, l, cwd, sha));
    case 'not_pushed':
      return {
        finding: 'not_executed',
        detail: 'remote at the expected old head or behind it on the task branch',
      };
    case 'head_changed':
      return {
        finding: 'executed_failed',
        failure_class: 'auth_config',
        detail: 'remote branch moved',
        // After a merge proof the remote is history; no new drift is raised (FR-040.03).
        extra: done
          ? []
          : [
              {
                kind: 'head_drift',
                expected: published,
                observed: r.remote_sha,
                source: 'publish_probe',
                evidence_ref: `effect:${target.id}`,
              },
            ],
      };
    case 'unknown':
      return still(`remote: ${r.detail}`);
  }
}

/** The PR by tuple and marker in every state, or the description by body digest (FR-017/018). */
async function probeCreatePr(deps: HandlerDeps, target: Effect): Promise<Probe> {
  const l = load(deps, target);
  const content = currentContent(deps, l.s);
  if (content === null) return still('no accepted PR content to compare');
  if (target.request['update'] === true) {
    const u = descriptionOf(l, content);
    if (u === null) return still('no PR description to compare');
    const r = await probeDescription(deps.github(), u);
    switch (r.kind) {
      case 'current':
        return fromOutcome(describedOutcome(l, r.body_digest));
      case 'not_applied':
        return {
          finding: 'not_executed',
          detail: 'PR still carries the previous body',
        };
      case 'body_changed':
        return {
          finding: 'executed_failed',
          failure_class: 'auth_config',
          detail: `PR description was edited on GitHub (${r.observed_digest})`,
        };
      case 'unknown':
        return still(r.detail);
    }
  }
  if (l.s.head_sha === null) return still('no published head');
  const r = await probePr(deps.github(), prSpecOf(l, l.s.head_sha, content, target.idem_key));
  switch (r.kind) {
    case 'recovered':
      return fromOutcome(
        prOutcome(l, content, r.operation_key ?? target.idem_key, r.pr, r.body_digest),
      );
    case 'absent':
      return {
        finding: 'not_executed',
        detail: 'no PR on the tuple in any state',
      };
    // A worker's PR for this task: the create runs again and takes it over.
    case 'unclaimed':
      return {
        finding: 'not_executed',
        detail: `PR #${r.pr.number} on the task branch has no marker yet`,
      };
    case 'conflict':
      return {
        finding: 'executed_failed',
        failure_class: 'auth_config',
        detail: `pull request conflict: ${r.reason} ${r.prs.join(',')}`,
      };
    case 'closed':
    case 'head_changed':
      return {
        finding: 'executed_failed',
        failure_class: 'infra',
        detail: `pull request ${r.kind}`,
      };
    case 'unknown':
      return still(r.detail);
  }
}

/** A rerun has no remote idempotency: only a later run attempt since the claim proves it happened. */
async function probeRerunCi(
  deps: HandlerDeps,
  target: Effect,
  since: number | null,
): Promise<Probe> {
  const head = typeof target.request['head_sha'] === 'string' ? target.request['head_sha'] : null;
  const checks = Array.isArray(target.request['checks'])
    ? (target.request['checks'] as string[])
    : [];
  if (head === null || since === null) return still('rerun without a head');
  const l = load(deps, target);
  const r = await probeRerun(deps.github(), {
    repo: l.rt.target.repo,
    head_sha: head,
    checks,
    since,
  });
  return r.kind === 'rerun'
    ? {
        finding: 'executed_succeeded',
        data: { head_sha: head, rerun_checks: [...r.checks] },
      }
    : still(r.detail);
}

/**
 * An agent run that ended while no daemon read it (US3.2): its outcome comes back through the harness's
 * recovery path, from what the run finalized and for the input the handler rebuilds, never by running
 * the agent again. A run not proven finished (lost, unknown) is not read here: resume is the engine's.
 */
async function probeAgent(
  deps: HandlerDeps,
  target: Effect,
  mirror: TaskState['effects'][string],
  ops: readonly TaskState['operations'][string][],
): Promise<Probe> {
  const finished = ops.filter((o) => o.kind === 'agent' && o.status === 'finished');
  const op = finished[0];
  // Every run of the attempt is proven gone without a result (recovery found no process left): the
  // attempt is lost. It was launched, so it counts; the engine decides the next attempt and resumes a
  // session at most once (FR-035, FR-038).
  const runs = ops.filter((o) => o.kind === 'agent');
  if (finished.length === 0 && runs.length > 0 && runs.every((o) => o.status === 'lost')) {
    if (target.request['role'] === 'reviewer')
      await restoreAfterReview(deps, target.task_id, target.id);
    else {
      const l = load(deps, target);
      if (minorStep(l.policy, mirror.step)) await restoreCheckpoint(deps, l);
    }
    return {
      finding: 'executed_failed',
      failure_class: 'infra',
      signature: AGENT_LOST_SIGNATURE,
      detail: 'runner gone without a result',
    };
  }
  if (finished.length !== 1 || op === undefined)
    return still('no single finished agent run to read back');
  const extra: Trigger[] = [];
  let out: EffectOutcome;
  try {
    out = await startAgent(
      deps,
      target,
      new AbortController().signal,
      {
        operation_id: op.id,
        kind: op.kind,
        launch_nonce: op.launch_nonce,
        unit: op.unit,
        holds_slot: op.holds_slot,
      },
      mirror,
      extra,
      0,
      true,
    );
  } catch (e) {
    // The input could not be rebuilt: that says nothing about how the run ended.
    if (e instanceof Skip) return still(`input not rebuilt: ${e.message}`);
    throw e;
  }
  if (out.outcome === 'succeeded')
    out = {
      outcome: 'succeeded',
      data: { ...(out.data as Record<string, unknown>), invoked: true },
    };
  return fromOutcome(out, extra);
}

/**
 * Probes the effect a `reconcile` targets before anything is sent again (T090, SPEC.md §13.2,
 * FR-003/004/017/018/034.01). Only operations that ran inside the daemon are probed here; while one of
 * them is still registered or running in this daemon nothing is touched. An agent run that finished is
 * read back through its harness; one whose runs are all proven lost is a failed, counted run, and the
 * engine weighs the next attempt and any resume (T099, FR-035); any other agent run stays unknown.
 * Reads that fail or evidence that does not decide keep the effect unknown. Once the finding is definite, the target's lost or
 * unknown operations are closed with it, which is what lets the claim and the slot go.
 */
async function reconcileEffect(
  deps: HandlerDeps,
  effect: Effect,
  mirror: TaskState['effects'][string],
  signal: AbortSignal,
): Promise<{ outcome: EffectOutcome; extra: Trigger[] }> {
  // Setup or gates this probe ran again and could not see stopped: this reconcile's own operation
  // stays unresolved, so its processes are reconciled by their tag before anything ends (FR-025.02).
  const trace: LocalTrace = { unverified: false };
  let git = 0;
  let github = 0;
  const counted: HandlerDeps = {
    ...deps,
    git: { run: (c) => (git++, deps.git.run(c)) },
    github: () => {
      const port = deps.github();
      return { request: (r) => (github++, port.request(r)) };
    },
  };
  const s = deps.store.readTask(effect.task_id as Uuid);
  const targetId = mirror.target_effect_id;
  const target = targetId === null ? null : deps.store.readEffect(targetId);
  const tm = targetId === null ? undefined : s?.effects[targetId];
  const done = (p: Probe, extra: Trigger[]) =>
    trace.unverified
      ? {
          outcome: unknown(`a local process this probe ran was not seen gone (${p.finding})`),
          extra: [],
        }
      : doneOk(p, extra);
  const doneOk = (p: Probe, extra: Trigger[]) => ({
    outcome: {
      outcome: 'succeeded' as const,
      data: {
        finding: p.finding,
        ...('detail' in p ? { detail: p.detail } : {}),
        // Requests the probe took; one logical effect may need several (pages, re-reads).
        requests: { git, github },
      },
    },
    extra,
  });
  if (
    s === null ||
    target === null ||
    tm === undefined ||
    (tm.status !== 'unknown' && tm.status !== 'started')
  )
    return done(still('nothing open to reconcile'), []);
  const ops = Object.values(s.operations).filter((o) => o.effect_id === target.id);
  if (ops.some((o) => o.status === 'registered' || o.status === 'running'))
    return done(still('an operation of the effect is still running'), []);
  // An operation of this daemon left unknown (a stop not seen through, an outcome never read) may still
  // have processes: they are stopped by their tag and seen gone before anything is probed, run again or
  // closed, a reconcile of a reconcile included (FR-025.02, FR-034.01). Agent runs have their own probe.
  for (const o of ops.filter((x) => x.kind !== 'agent' && x.status === 'unknown')) {
    if (deps.stopLocal === undefined)
      return done(still(`operation ${o.id} unknown; its processes cannot be checked`), []);
    if ((await deps.stopLocal(o.id)) === 'unknown')
      return done(still(`operation ${o.id} not seen gone`), []);
  }

  let p: Probe;
  // Local setup and gates leave nothing outside the worktree: after a cancel or a merge proof one cut
  // short is recorded as stopped instead of run again.
  const settling = s.cancellation !== null || s.completion !== null;
  // Recorded as stopped only once nothing of it is left running: each of its local operations is
  // stopped by its tag and seen gone; otherwise it stays unknown and is probed again (FR-025.02).
  const notRunAgain = async (): Promise<Probe> => {
    if (deps.stopLocal === undefined) return still('cannot check its processes are gone');
    for (const o of ops.filter((x) => x.kind !== 'agent')) {
      const r = await deps.stopLocal(o.id);
      if (r === 'unknown') return still(`operation ${o.id} not seen gone`);
    }
    return {
      finding: 'executed_failed',
      failure_class: 'infra',
      signature: 'stopped',
      detail: 'cut short by a cancel or a merge; not run again',
    };
  };
  switch (target.kind) {
    case 'prepare':
      // Worktree adoption checks ownership first; setup is declared safe to run again, but never once
      // the task is cancelling or merged: no business work starts then (FR-025.01, FR-040.02).
      p = settling
        ? await notRunAgain()
        : fromOutcome(
            await guarded(counted, target.task_id, signal, (g) => prepare(g.deps, target), trace),
          );
      break;
    case 'run_gates':
      p =
        settling && tm.step !== 'ci_autofix'
          ? await notRunAgain()
          : await probeGates(counted, target, tm.step, signal, trace);
      break;
    case 'publish':
      p = await probePublish(counted, target, s.completion !== null);
      break;
    case 'create_pr':
      p = await probeCreatePr(counted, target);
      break;
    case 'mark_ready':
      p = await probeMarkReady(counted, target);
      break;
    case 'post_review':
      p = await probePostReview(counted, target);
      break;
    case 'await_ci': {
      const o = await observeTask(counted, target.task_id, `op:${effect.id}`);
      p = fromOutcome(o.outcome, o.extra);
      break;
    }
    case 'rerun_ci':
      p = await probeRerunCi(
        counted,
        target,
        ops.reduce<number | null>(
          (m, o) => (m === null ? o.registered_at : Math.min(m, o.registered_at)),
          null,
        ),
      );
      break;
    case 'stop_attempt':
      p = fromOutcome(await stopAttempt(deps, effect.task_id, tm));
      break;
    case 'reconcile':
      // A reconcile only probes and repeats what is declared safe: an interrupted one runs again under
      // its key, and its own target is probed then (T093).
      p = {
        finding: 'not_executed',
        detail: 'an interrupted reconcile is run again',
      };
      break;
    case 'start_agent':
      p = await probeAgent(counted, target, tm, ops);
      break;
    case 'merge':
    case 'observe_external':
      p = still(`${target.kind} is not probed here`);
      break;
  }
  if (p.finding === 'still_unknown') return done(p, []);

  const now = deps.clock.now();
  const extra: Trigger[] = ops
    .filter((o) => o.kind !== 'agent' && (o.status === 'lost' || o.status === 'unknown'))
    .map((o) => ({
      kind: 'operation_result' as const,
      operation_id: o.id as Uuid,
      status: 'finished' as const,
      outcome: p.finding === 'executed_succeeded' ? 'succeeded' : 'failed',
      invocation_id: null,
      processes: [],
      started_at: o.started_at as never,
      finished_at: now as never,
      receipt_digest: hashCanonical({
        operation: o.id,
        reconciled_by: effect.id,
        finding: p.finding,
      }),
    }));
  if ('extra' in p && p.extra !== undefined) extra.push(...p.extra);
  extra.push({
    kind: 'effect_reconciled',
    effect_id: target.id as Uuid,
    finding: p.finding,
    requests: { git, github },
    ...(p.finding === 'executed_succeeded' ? { data: p.data } : {}),
    ...(p.finding === 'executed_failed'
      ? {
          failure_class: p.failure_class,
          ...(p.signature === undefined ? {} : { signature: p.signature }),
          ...(p.data === undefined ? {} : { data: p.data }),
        }
      : {}),
  });
  return done(p, extra);
}

// ---- service effects ----

/** How long a stop waits for an aborted local handler: its command's TERM grace and KILL check, plus margin. */
const HANDLER_STOP_WAIT_MS = STOP_TERM_GRACE_MS + STOP_KILL_VERIFY_MS + 5_000;

/**
 * Stops the work behind `target_effect_id`: the in-flight handler is aborted (an agent invocation stops
 * its own unit), a runner no handler owns is stopped through the process port, and the processes of a
 * local setup or gate operation are stopped by their tag; each stop is verified. The operation stays
 * unresolved until its receipt; a stop that cannot be verified is `unknown`.
 */
async function stopAttempt(
  deps: HandlerDeps,
  task: string,
  mirror: { target_effect_id: string | null },
): Promise<EffectOutcome> {
  const target = mirror.target_effect_id;
  if (target === null) return { outcome: 'succeeded', data: { stopped: false } };
  const aborted = deps.abort(target);
  const stops: { operation_id: string; outcome: StopOutcome }[] = [];
  const ops = Object.values(deps.store.readTask(task as Uuid)?.operations ?? {}).filter(
    (o) => o.effect_id === target && isUnresolved(o),
  );
  // An aborted local handler stops spawning and ends its running command (TERM, grace, KILL); wait for
  // it to return, bounded, so nothing it does after the scan below goes unseen. Without proof that it
  // returned, the stop is not done: the handler may still be about to spawn.
  if (aborted && ops.some((o) => o.kind !== 'agent')) {
    if (deps.settled === undefined)
      return unknown('local handler aborted; its return cannot be awaited');
    let timer: NodeJS.Timeout | undefined;
    const returned = await Promise.race([
      deps.settled(target).then(() => true),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), HANDLER_STOP_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!returned)
      return unknown(`local handler of ${target} did not return within ${HANDLER_STOP_WAIT_MS} ms`);
  }
  for (const op of ops) {
    if (op.kind !== 'agent') {
      // Whatever is left of a local operation is stopped by its tag: TERM, grace, KILL, verified.
      if (deps.stopLocal !== undefined)
        stops.push({
          operation_id: op.id,
          outcome: await deps.stopLocal(op.id),
        });
      continue;
    }
    if (!aborted && deps.process !== undefined) {
      const unit = await deps.process.inspect(op.id);
      stops.push({
        operation_id: op.id,
        outcome:
          unit.state === 'active'
            ? await deps.process.stop(op.id, {
                term_grace_ms: DRAIN_TERM_GRACE_MS,
                kill_verify_ms: DRAIN_KILL_VERIFY_MS,
              })
            : unit.state === 'unknown'
              ? 'unknown'
              : 'not_running',
      });
    }
  }
  if (stops.some((x) => x.outcome === 'unknown'))
    return unknown(
      `stop of ${stops
        .filter((x) => x.outcome === 'unknown')
        .map((x) => x.operation_id)
        .join(',')} not verified`,
    );
  return {
    outcome: 'succeeded',
    data: {
      stopped: aborted || stops.some((x) => x.outcome === 'stopped'),
      aborted,
      stops,
    },
  };
}

/** Builds every handler the daemon runs for runtime tasks; `merge` has none by construction. */
/** What the task's worktree still holds (FR-040.06), for a drain round; null once there is no worktree. */
export async function localRemainderOf(
  deps: Pick<HandlerDeps, 'store' | 'git' | 'paths' | 'remoteUrl'>,
  taskId: string,
): Promise<LocalRemainderProbe | null> {
  const s = deps.store.readTask(taskId as Uuid);
  if (s === null) return null;
  const rt = deps.store.readRuntimeContext(s.id as Uuid, s.revision);
  const worktree = join(deps.paths.worktrees, s.id);
  if (rt === null || !existsSync(worktree)) return null;
  return probeLocalRemainder(deps.git, {
    worktree,
    remote_url: deps.remoteUrl(rt.target.repo),
    branch: remoteBranch(s),
    base_sha: rt.base_sha,
  });
}

export function buildHandlers(deps: HandlerDeps): EffectHandlers {
  const wrap =
    (
      run: (
        effect: Effect,
        signal: AbortSignal,
        op: OperationClaim,
        mirror: TaskState['effects'][string],
      ) => Promise<{ outcome: EffectOutcome; extra: Trigger[] }>,
    ): EffectHandler =>
    async (effect, signal, op): Promise<TriggerEnvelope[]> => {
      const started = deps.clock.now();
      const mirror = deps.store.readTask(effect.task_id as Uuid)?.effects[effect.id];
      let result: { outcome: EffectOutcome; extra: Trigger[] };
      try {
        if (mirror === undefined) throw new Skip(failed('infra', 'effect not in task state'));
        result = await run(effect, signal, op, mirror);
      } catch (e) {
        if (!(e instanceof Skip)) throw e;
        result = { outcome: e.outcome, extra: [] };
      }
      return resultEnvelopes(
        effect,
        op,
        mirror?.attempt_id ?? null,
        result.outcome,
        { now: deps.clock.now(), started_at: started, newId: deps.newId },
        result.extra,
      );
    };
  const plain = (
    f: (
      effect: Effect,
      signal: AbortSignal,
      op: OperationClaim,
      mirror: TaskState['effects'][string],
    ) => Promise<EffectOutcome>,
  ) => wrap(async (e, s, o, m) => ({ outcome: await f(e, s, o, m), extra: [] }));
  return {
    prepare: plain((e, s) => guarded(deps, e.task_id, s, (g) => prepare(g.deps, e))),
    start_agent: wrap(async (e, s, o, m) => {
      const extra: Trigger[] = [];
      return { outcome: await startAgent(deps, e, s, o, m, extra), extra };
    }),
    run_gates: plain((e, s, _o, m) =>
      guarded(deps, e.task_id, s, (g) => gates(g.deps, e, m.step, g.signal)),
    ),
    publish: wrap((e) => publish(deps, e)),
    create_pr: plain((e) => createPr(deps, e)),
    mark_ready: plain((e) => markReadyEffect(deps, e)),
    post_review: plain((e) => postReviewEffect(deps, e)),
    await_ci: wrap((e, _s, o) => observeTask(deps, e.task_id, `op:${o.operation_id}`)),
    rerun_ci: plain((e) => rerunCi(deps, e)),
    stop_attempt: plain((e, _s, _o, m) => stopAttempt(deps, e.task_id, m)),
    reconcile: wrap((e, s, _o, m) => reconcileEffect(deps, e, m, s)),
  };
}
