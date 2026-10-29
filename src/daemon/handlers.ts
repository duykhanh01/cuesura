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
 * Known gaps, kept explicit: setup commands are not in the frozen snapshot yet, so `prepare` reports
 * `setup.ran = false`; `reconcile` answers `still_unknown` until recovery (T090) probes each kind.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRoleContext,
  type PublishContent,
  type RepairState,
  type RoleFailure,
} from '../adapters/context.ts';
import {
  FileContentStore,
  readContentFile,
  validateContent,
} from '../adapters/publish-content.ts';
import { runAutofix, runGates } from '../adapters/gates.ts';
import {
  takeCheckpoint,
  type CheckpointSpec,
} from '../adapters/git/checkpoint.ts';
import {
  commitCheckpoint,
  FileCommitIntentStore,
} from '../adapters/git/commit.ts';
import { pushBranch } from '../adapters/git/push.ts';
import {
  ensureWorktree,
  markerPath,
  taskBranch,
} from '../adapters/git/worktree.ts';
import {
  ROLES,
  wireRoleSchema,
  type Role,
} from '../adapters/harness/result-schema.ts';
import { toMergeProof } from '../adapters/github/merge-proof.ts';
import { observePull } from '../adapters/github/observe.ts';
import {
  createOrRecoverPr,
  updatePrDescription,
} from '../adapters/github/publish.ts';
import { rerunFailedJobs } from '../adapters/github/rerun.ts';
import type {
  Clock,
  GitHubPort,
  GitPort,
  HarnessOutcome,
  HarnessPort,
  SandboxProvider,
} from '../adapters/ports.ts';
import type { Effect } from '../domain/effect.ts';
import type {
  Binding,
  FrozenExecutionContext,
  FrozenPolicy,
} from '../domain/policy.ts';
import type { FrozenRuntimeContext, Observation } from '../domain/runtime.ts';
import type { TaskState } from '../domain/state.ts';
import type { z } from 'zod';
import type {
  AwaitCiDataSchema,
  RequiredCheckVerdict,
  Trigger,
  TriggerEnvelope,
} from '../domain/trigger.ts';
import {
  evaluateRequired,
  type RequiredVerdict,
} from '../engine/required-checks.ts';
import type { OperationClaim } from '../engine/runtime.ts';
import type { CommandExecutor } from '../runner/commands.ts';
import { InvocationUnknown } from '../runner/invocation.ts';
import type { Redactor } from '../runner/redact.ts';
import type { EpochMs, Uuid } from '../shared/brand.ts';
import { hashCanonical, hashText } from '../shared/hash.ts';
import { reviewInputDigest } from '../engine/review-evidence.ts';
import type { Store } from '../store/index.ts';
import type { EffectHandler, EffectHandlers } from './dispatch.ts';
import { resultEnvelopes, type EffectOutcome } from './ingest.ts';

export type HandlerDeps = {
  readonly store: Store;
  readonly git: GitPort;
  /** A fresh GitHub port per effect: call caps and the round window count per round. */
  readonly github: () => GitHubPort;
  readonly harnesses: Readonly<Record<string, HarnessPort>>;
  readonly sandbox: SandboxProvider;
  readonly executor: CommandExecutor;
  readonly clock: Clock;
  readonly redactor: Redactor;
  readonly newId: () => string;
  readonly paths: {
    readonly worktrees: string;
    readonly markers: string;
    readonly intents: string;
    readonly scratch: string;
    readonly content: string;
  };
  readonly committer: { readonly name: string; readonly email: string };
  /** Push URL of a repo slug, from the runtime snapshot (never the repo's own remote config). */
  readonly remoteUrl: (repo: string) => string;
  /** Aborts the in-flight handler of an effect (the dispatcher's `abort`). */
  readonly abort: (effectId: string) => boolean;
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

function load(deps: HandlerDeps, effect: Effect): Loaded {
  const s = deps.store.readTask(effect.task_id as Uuid);
  if (s === null || s.policy_ref === null)
    throw new Skip(failed('infra', 'task not started'));
  const policy = deps.store.readPolicy(
    s.id as Uuid,
    s.policy_ref.revision,
    s.policy_ref.version,
  );
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
    throw new Skip(
      unknown(
        `git common dir: ${r.kind === 'exited' ? r.stderr.trim() : r.kind}`,
      ),
    );
  return r.stdout.trim();
}

function where(deps: HandlerDeps, l: Loaded) {
  return {
    worktree: join(deps.paths.worktrees, l.s.id),
    branch: taskBranch(l.s.id, l.s.task.title),
    scratch: join(deps.paths.scratch, l.s.id),
  };
}

async function checkpointSpec(
  deps: HandlerDeps,
  l: Loaded,
): Promise<CheckpointSpec> {
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

async function headOf(
  deps: HandlerDeps,
  cwd: string,
): Promise<{ sha: string; tree: string }> {
  const r = await deps.git.run({
    args: ['rev-parse', 'HEAD', 'HEAD^{tree}'],
    cwd,
    timeout_ms: 10_000,
    max_output_bytes: 4096,
    stdin: null,
  });
  if (r.kind !== 'exited' || r.code !== 0)
    throw new Skip(unknown('worktree HEAD unreadable'));
  const [sha, tree] = r.stdout.trim().split('\n');
  return { sha: sha as string, tree: tree as string };
}

// ---- prepare ----

async function prepare(
  deps: HandlerDeps,
  effect: Effect,
): Promise<EffectOutcome> {
  const l = load(deps, effect);
  const base =
    typeof effect.request['base_sha'] === 'string'
      ? effect.request['base_sha']
      : l.rt.base_sha;
  const wt = await ensureWorktree(deps.git, {
    task_id: l.s.id,
    title: l.s.task.title,
    project_realpath: l.rt.project_path,
    common_git_dir: await commonDir(deps, l.rt.project_path),
    base_sha: base,
    worktrees_root: deps.paths.worktrees,
    markers_dir: deps.paths.markers,
    nonce: effect.id,
  });
  if (wt.kind === 'unknown') return unknown(wt.detail);
  if (wt.kind === 'mismatch')
    return failed('infra', `worktree ${wt.reason}: ${wt.detail}`);
  const tree = await worktreeTree(deps, l);
  if (!tree.ok) return tree.outcome;
  return {
    outcome: 'succeeded',
    data: {
      base_sha: base,
      worktree_ref: wt.worktree_path,
      branch: wt.branch,
      setup: { ran: false, passed: true },
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
      cp.error.kind === 'unknown'
        ? unknown(cp.error.detail)
        : failed('infra', cp.error.detail),
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
function currentContent(
  deps: HandlerDeps,
  s: TaskState,
): PublishContent | null {
  const c = s.run.content;
  return c === null || c.revision !== s.revision
    ? null
    : contentStore(deps).get(c.ref, c.digest);
}

/** Failures the repair is about, newest evidence of this revision, each with the SHA it was seen on. */
function failuresFor(s: TaskState): {
  cause: RepairState['cause'] | null;
  failures: RoleFailure[];
} {
  const rev = s.revision;
  const gate = s.evidence.gates
    .filter((g) => g.valid && g.revision === rev)
    .at(-1);
  const review = s.run.reviews
    .filter((r) => r.valid && r.revision === rev)
    .at(-1);
  const ci = s.evidence.ci.filter((c) => c.valid && c.revision === rev).at(-1);
  const cp = s.run.checkpoint?.sha ?? null;
  const step = s.current_step ?? '';
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
        detail: [f.signature ?? 'gate failed', f.log_excerpt ?? '']
          .filter((x) => x !== '')
          .join('\n'),
        sha: cp,
      })),
    };
  }
  if (step === 'fix_review' && review?.verdict === 'request_changes') {
    const findings =
      review.findings.length > 0
        ? review.findings
        : [{ severity: 'major', msg: 'the reviewer requested changes' }];
    return {
      cause: 'review',
      failures: findings.map((f) => ({
        source: 'review',
        name: `${f.severity}${f.file === undefined ? '' : ` ${f.file}${f.line === undefined ? '' : `:${f.line}`}`}`,
        detail: f.msg,
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
    checkpoint_sha:
      l.s.run.checkpoint?.revision === l.s.revision
        ? l.s.run.checkpoint.sha
        : null,
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

const HARNESS_FAILURE_CLASS: Record<string, string> = {
  rate_limited: 'rate_limit',
  auth: 'auth_config',
  refusal: 'refused',
  vendor_error: 'infra',
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
  o: HarnessOutcome,
  head: string | null,
  inputDigest: string | null,
): EffectOutcome {
  if (o.kind === 'failure')
    return {
      outcome: 'failed',
      data: {
        failure_class: HARNESS_FAILURE_CLASS[o.failure] ?? 'unknown',
        message: o.detail,
        // The reservation is released only when the harness provably never ran (FR-010/016).
        invoked: o.invoked,
        usage: o.usage,
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
      questions: v.questions.map((q) => q.question),
      usage: o.usage,
      invoked: true,
    },
  };
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

async function startAgent(
  deps: HandlerDeps,
  effect: Effect,
  signal: AbortSignal,
  op: OperationClaim,
  mirror: { attempt_id: string | null; step: string | null },
  extra: Trigger[] = [],
): Promise<EffectOutcome> {
  const l = load(deps, effect);
  const role = effect.request['role'];
  const binding = effect.request['binding'] as Binding | undefined;
  if (
    typeof role !== 'string' ||
    !(ROLES as readonly string[]).includes(role) ||
    binding === undefined
  )
    return failed('auth_config', `role ${String(role)} is not run by cusrd`);
  const harness = deps.harnesses[binding.harness];
  if (harness === undefined)
    return failed('auth_config', `no harness ${binding.harness}`);
  // The manifest confirmed with the task must still be the one in force; a re-proved or changed
  // binary needs a new confirmation, never a silent switch between attempts (T070/T071).
  const confirmed = l.rt.capability_refs[binding.harness];
  if (confirmed !== undefined && confirmed !== harness.manifest.manifest_hash)
    return {
      outcome: 'failed',
      data: {
        failure_class: 'auth_config',
        message: `harness ${binding.harness} manifest changed since the run was confirmed`,
        invoked: false,
      },
    };
  const r = role as Role;
  const step = mirror.step ?? r;
  // A worker starts only on the tree the task last left (T072): a change made by someone else in
  // between is not the attempt's to take. Nothing is invoked; the engine waits for a person.
  const known = l.s.run.worktree_tree ?? null;
  if (WORKER_ROLES.includes(r) && known !== null) {
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
  const inputDigest =
    r === 'reviewer' ? reviewInputDigest(l.s, l.policy, step) : null;
  const worker = WORKER_ROLES.includes(r);
  const fix = failuresFor(l.s);
  const repairing =
    r === 'fixer' || (step !== 'code' && worker && fix.cause !== null);
  const scratch = where(deps, l).scratch;
  const contentName = `publish-${op.operation_id}.json`;
  const file = join(scratch, contentName);
  // A sandboxed worker writes into its own run scratch; the harness copies the file out to `file`.
  const agentFile =
    harness.agent_paths === undefined
      ? file
      : join(harness.agent_paths.scratch, contentName);
  if (worker) mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const answers = Array.isArray(effect.request['answers'])
    ? (effect.request['answers'] as { question_id: string; answer: string }[])
    : [];
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
    prompt: null,
    answers,
    failures: repairing ? fix.failures : [],
    diff: review?.diff ?? null,
    ...(repairing
      ? {
          repair:
            fix.cause === null ? null : await repairState(deps, l, fix.cause),
        }
      : {}),
    publish: worker
      ? {
          template: l.rt.pr_template ?? null,
          current: currentContent(deps, l.s),
          file: agentFile,
        }
      : null,
    ...(r === 'reviewer' ? { pr_content: currentContent(deps, l.s) } : {}),
    limits: {
      context_bytes: l.rt.limits.context_bytes,
      review_diff_bytes: l.rt.limits.review_diff_bytes,
    },
    redactor: deps.redactor,
  });
  if (!built.ok) {
    return r === 'reviewer'
      ? failed(
          'infra',
          `review context missing: ${built.error.missing.join(', ')}`,
        )
      : {
          outcome: 'succeeded',
          data: {
            schema_checked: true,
            status: 'needs_context',
            summary: `missing context: ${built.error.missing.join(', ')}`,
            usage: { basis: 'unavailable' },
            invoked: false,
          },
        };
  }
  const wall = binding.limits.wall_timeout_ms ?? 45 * 60_000;
  const resume = sessionFor(effect.request, harness);
  let out: HarnessOutcome;
  try {
    out = await harness.run(
      {
        role: r,
        operation_id: op.operation_id,
        attempt_id: mirror.attempt_id ?? effect.id,
        revision: l.s.revision,
        binding: {
          harness: binding.harness,
          vendor: harness.manifest.vendor,
          model: binding.model_id,
          effort: binding.effort,
          permission_policy_hash:
            harness.manifest.permission_policy_hash ?? hashCanonical('none'),
        },
        context: { text: built.value.text, digest: built.value.digest },
        schema: wireRoleSchema(r, { omit_meta_schema: false }),
        wall_ms: wall,
        deadline_at: (l.s.deadline_at ?? deps.clock.now() + wall) as EpochMs,
        session: resume.session,
        ...(worker && harness.agent_paths !== undefined
          ? { collect: [{ scratch_name: contentName, host_path: file }] }
          : {}),
        ...(harness.agent_paths === undefined
          ? {}
          : { workspace: await workspaceOf(deps, l) }),
      },
      signal,
    );
  } catch (e) {
    // Launch or end not proven: the effect is reconciled, its reservation kept (contracts/execution.md §5).
    if (e instanceof InvocationUnknown) return unknown(e.message);
    throw e;
  }
  // The run's records and files go into the store with the result; that commit is their ACK.
  if (out.ingest !== undefined)
    extra.push({
      kind: 'ingest_record',
      operation_id: out.ingest.operation_id as Uuid,
      cursor: out.ingest.cursor,
      records: out.ingest.records,
      digest: out.ingest.digest,
      artifacts: [...out.ingest.artifacts],
    });
  const plain = agentOutcome(r, out, review?.sha ?? null, inputDigest);
  // Sessions are a worker concern: a reviewer always runs in its own new, read-only session.
  const outcome = worker ? withSession(plain, out, resume) : plain;
  if (!worker) return outcome;
  const accepted = acceptContent(deps, l, file, outcome);
  // What the attempt left is now the task's tree; an attempt never invoked changed nothing.
  if (out.kind === 'failure' && out.invoked === false) return accepted;
  const after = await worktreeTree(deps, l);
  return after.ok ? withWorktreeTree(accepted, after.tree) : accepted;
}

/** The task worktree and the Git dirs a sandboxed role sees read-only (common dir, worktree admin dir). */
async function workspaceOf(
  deps: HandlerDeps,
  l: Loaded,
): Promise<{ worktree: string; git_dirs: string[] }> {
  const worktree = where(deps, l).worktree;
  const admin = (
    await gitText(deps, worktree, ['rev-parse', '--absolute-git-dir'], 4096)
  ).trim();
  const common = await commonDir(deps, l.rt.project_path);
  return {
    worktree,
    git_dirs: admin === common ? [common] : [common, admin],
  };
}

type ResumeChoice = {
  readonly session: { readonly ref: string } | null;
  readonly fallback: string | null;
  readonly asked: boolean;
};

/**
 * Resumes the engine's chosen worker session only when the harness proved resume works; otherwise a new
 * session with the reason recorded. The context is the full repair packet in both cases (M04).
 */
export function sessionFor(
  request: Record<string, unknown>,
  harness: HarnessPort,
): ResumeChoice {
  const plan = request['resume'] as
    { session_ref?: unknown } | null | undefined;
  const reason =
    typeof request['resume_reason'] === 'string'
      ? request['resume_reason']
      : null;
  if (
    plan === undefined ||
    plan === null ||
    typeof plan.session_ref !== 'string'
  )
    return { session: null, fallback: reason, asked: false };
  if (harness.manifest.capabilities.resume !== 'proven')
    return {
      session: null,
      fallback: `resume_${harness.manifest.capabilities.resume}`,
      asked: true,
    };
  return { session: { ref: plan.session_ref }, fallback: null, asked: true };
}

function withSession(
  out: EffectOutcome,
  o: HarnessOutcome,
  r: ResumeChoice,
): EffectOutcome {
  if (out.outcome !== 'succeeded') return out;
  const extra = {
    session_ref: o.session_ref,
    ...(r.asked || r.fallback !== null ? { resumed: r.session !== null } : {}),
    ...(r.fallback === null ? {} : { resume_fallback: r.fallback }),
  };
  return {
    outcome: 'succeeded',
    data: { ...(out.data as Record<string, unknown>), ...extra },
  };
}

// ---- gates ----

/** The gate step whose pass leads to review or publish: it ends with the checkpoint commit. */
function commitStep(policy: FrozenPolicy, step: string | null): boolean {
  const pass =
    step === null ? undefined : policy.workflow.steps[step]?.next['pass'];
  const next = pass === undefined ? undefined : policy.workflow.steps[pass];
  return next?.kind === 'review' || next?.action === 'git.publish';
}

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
      cp.error.kind === 'unknown'
        ? unknown(cp.error.detail)
        : failed('infra', cp.error.detail),
    );
  if (cp.value.tree_oid !== tree)
    throw new Skip({
      outcome: 'succeeded',
      data: { results: [], tree: cp.value.tree_oid, stable: false },
    });
  const content = currentContent(deps, l.s);
  const ref = l.s.run.content;
  if (content === null || ref === null)
    throw new Skip(
      failed('infra', 'no accepted publish content for the commit message'),
    );
  const head = await headOf(deps, spec.worktree_path);
  let sha = head.sha;
  let committed = false;
  if (tree !== head.tree) {
    const at = deps.clock.now();
    const c = await commitCheckpoint(
      deps.git,
      new FileCommitIntentStore(deps.paths.intents),
      {
        key: `${l.s.id}.r${l.s.revision}.${effect.id}`,
        worktree_path: spec.worktree_path,
        branch: spec.branch,
        tree,
        parent: cp.value.parent_oid,
        author: { ...deps.committer, at },
        committer: { ...deps.committer, at },
        message: content.commit_message,
      },
    );
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
  return {
    sha,
    tree,
    base_sha: l.rt.base_sha,
    diff_digest: hashText(raw),
    content_digest: ref.digest,
    committed,
  };
}

async function gates(
  deps: HandlerDeps,
  effect: Effect,
  step: string | null,
): Promise<EffectOutcome> {
  const l = load(deps, effect);
  const list = Array.isArray(effect.request['gates'])
    ? (effect.request['gates'] as { gate: string; cmd: string }[])
    : [];
  const required = Array.isArray(effect.request['required'])
    ? (effect.request['required'] as string[])
    : [];
  const w = where(deps, l);
  const spec = await checkpointSpec(deps, l);
  const input = {
    commands: list.map((g) => ({ name: g.gate, command: g.cmd })),
    layout: {
      worktree: w.worktree,
      git_dirs: [spec.common_git_dir],
      scratch: w.scratch,
      context: null,
      schema: null,
      toolchain: [],
      env: {},
      network: 'internet_outbound' as const,
    },
    wall_ms: l.rt.limits.command_wall_ms,
    deadline_at: l.s.deadline_at as EpochMs | null,
    checkpoint: spec,
  };
  if (step === 'ci_autofix') {
    const r = await runAutofix(deps, input);
    if (r.kind === 'unknown')
      return r.retry_allowed ? failed('infra', r.detail) : unknown(r.detail);
    return { outcome: 'succeeded', data: r.data ?? { results: [] } };
  }
  const r = await runGates(deps, input);
  if (r.kind === 'unknown')
    return r.retry_allowed ? failed('infra', r.detail) : unknown(r.detail);
  const data = r.data ?? { results: [], tree: '', stable: true };
  const must = required.length > 0 ? required : data.results.map((x) => x.gate);
  const passed =
    must.length > 0 &&
    must.every((g) => data.results.some((x) => x.gate === g && x.passed));
  if (!passed || !data.stable || !commitStep(l.policy, step))
    return { outcome: 'succeeded', data };
  return {
    outcome: 'succeeded',
    data: {
      ...data,
      checkpoint: await checkpointCommit(deps, l, effect, data.tree),
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
  const l = load(deps, effect);
  const sha =
    typeof effect.request['sha'] === 'string' ? effect.request['sha'] : null;
  const cp = l.s.run.checkpoint;
  if (
    sha === null ||
    cp === null ||
    cp.sha !== sha ||
    cp.revision !== l.s.revision
  )
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
    await gitText(
      deps,
      spec.worktree_path,
      ['rev-parse', `refs/heads/${spec.branch}`],
      1024,
    )
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
      outcome: failed(
        'auth_config',
        'worktree or branch changed after the checkpoint',
      ),
      extra: [drift],
    };
  }
  const published =
    l.s.evidence.publishes.filter((p) => p.valid).at(-1)?.head_sha ?? null;
  const r = await pushBranch(deps.git, {
    cwd: spec.worktree_path,
    remote_url: deps.remoteUrl(l.rt.target.repo),
    branch: spec.branch,
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
  const contains = await deps.git.run({
    args: ['merge-base', '--is-ancestor', l.rt.base_sha, sha],
    cwd: spec.worktree_path,
    timeout_ms: 10_000,
    max_output_bytes: 1024,
    stdin: null,
  });
  return {
    outcome: {
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
    },
    extra: [],
  };
}

// ---- create_pr / await_ci ----

function prNumber(ref: string | null): number | null {
  const m = ref === null ? null : /#(\d+)$/.exec(ref);
  return m === null ? null : Number(m[1]);
}

async function createPr(
  deps: HandlerDeps,
  effect: Effect,
): Promise<EffectOutcome> {
  const l = load(deps, effect);
  if (l.s.head_sha === null) return failed('infra', 'no published head');
  const content = currentContent(deps, l.s);
  if (content === null) return failed('infra', 'no accepted PR content');
  if (effect.request['update'] === true) return describePr(deps, l, content);
  const r = await createOrRecoverPr(deps.github(), {
    repo: l.rt.target.repo,
    immutable_repo_id: l.rt.target.immutable_repo_id,
    head_branch: taskBranch(l.s.id, l.s.task.title),
    base: l.s.task.base_branch,
    head_sha: l.s.head_sha,
    title: content.pr_title,
    body: content.pr_body,
    task_id: l.s.id,
    revision: l.s.revision,
    operation_key: effect.idem_key,
  });
  if (r.kind === 'created' || r.kind === 'recovered') {
    const prBody = {
      content_digest: l.s.run.content?.digest ?? hashCanonical(content),
      body_digest: r.body_digest,
      operation_key: effect.idem_key,
      revision: l.s.revision,
    };
    return {
      outcome: 'succeeded',
      data: {
        pr_ref: `${l.rt.target.repo}#${r.pr.number}`,
        head_sha: r.pr.head_sha,
        body_digest: r.body_digest,
        pr_body: prBody,
      },
    };
  }
  if (r.kind === 'unknown') return unknown(r.detail);
  // Someone else's PR, a forged or edited marker/body, or content we refuse: a person reconciles.
  if (r.kind === 'conflict' || r.kind === 'content_rejected')
    return failed(
      'auth_config',
      `pull request ${r.kind}: ${'reason' in r ? r.reason : r.field}`,
    );
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
 */
export async function observeTaskPr(
  deps: HandlerDeps,
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
    },
    now,
  );
  const known = l.s.observation?.subject ?? null;
  const subjectOf = (
    pull: { id: number | null; head: { ref: string | null } } | null,
  ) =>
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
      generation:
        source === 'timer' ? (l.s.observation?.budget.generation ?? 0) : 0,
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
      const proof = toMergeProof(
        obs.merge,
        first.observation.subject,
        l.s.head_sha,
        {
          observation_id: first.observation.observation_id,
          evidence_ref: evidenceRef,
        },
      );
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
  const checks =
    obs.checks?.checks.map((c) => ({ name: c.name, state: c.state })) ?? [];
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
  if (
    l.s.head_sha !== null &&
    obs.pull.head.sha !== null &&
    obs.pull.head.sha !== l.s.head_sha
  ) {
    facts.push({
      kind: 'head_drift',
      expected: l.s.head_sha,
      observed: obs.pull.head.sha,
      source: 'observation',
      evidence_ref: evidenceRef,
    });
    return { ci: noCi(obs.pull.head.sha), failure: null, facts };
  }
  const first = facts[0];
  if (first?.kind === 'observation_result') first.ci = ci;
  return { ci, failure: null, facts };
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
  const n = prNumber(l.s.pr_ref);
  const pb = l.s.run.pr_body;
  const digest = l.s.run.content?.digest ?? null;
  if (n === null || pb === null || digest === null)
    return failed('infra', 'no PR description to update');
  const r = await updatePrDescription(deps.github(), {
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
  });
  switch (r.kind) {
    case 'updated':
    case 'already_current':
      return {
        outcome: 'succeeded',
        data: {
          pr_ref: l.s.pr_ref as string,
          head_sha: l.s.head_sha as string,
          body_digest: r.body_digest,
          pr_body: {
            ...pb,
            content_digest: digest,
            body_digest: r.body_digest,
          },
        },
      };
    case 'unknown':
      return unknown(r.detail);
    case 'body_changed':
      return failed(
        'auth_config',
        `PR description was edited on GitHub (${r.observed_digest}); not overwritten`,
      );
    case 'content_rejected':
      return failed('auth_config', `PR content rejected: ${r.field}`);
    case 'rejected':
      return failed('auth_config', `PR update refused: HTTP ${r.status}`);
  }
}

/** `await_ci`: the observation facts plus the CI data of the head as the effect's own result. */
export async function observeTask(
  deps: HandlerDeps,
  taskId: string,
  evidenceRef: string,
): Promise<{ outcome: EffectOutcome; extra: Trigger[] }> {
  const r = await observeTaskPr(deps, taskId, evidenceRef, 'timer');
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
async function rerunCi(
  deps: HandlerDeps,
  effect: Effect,
): Promise<EffectOutcome> {
  const l = load(deps, effect);
  const head =
    typeof effect.request['head_sha'] === 'string'
      ? effect.request['head_sha']
      : null;
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

// ---- service effects ----

function stopAttempt(
  deps: HandlerDeps,
  mirror: { target_effect_id: string | null },
): EffectOutcome {
  const target = mirror.target_effect_id;
  if (target !== null) deps.abort(target);
  return { outcome: 'succeeded', data: { stopped: true } };
}

/** Builds every handler the daemon runs for runtime tasks; `merge` has none by construction. */
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
      const mirror = deps.store.readTask(effect.task_id as Uuid)?.effects[
        effect.id
      ];
      let result: { outcome: EffectOutcome; extra: Trigger[] };
      try {
        if (mirror === undefined)
          throw new Skip(failed('infra', 'effect not in task state'));
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
  ) =>
    wrap(async (e, s, o, m) => ({ outcome: await f(e, s, o, m), extra: [] }));
  return {
    prepare: plain((e) => prepare(deps, e)),
    start_agent: wrap(async (e, s, o, m) => {
      const extra: Trigger[] = [];
      return { outcome: await startAgent(deps, e, s, o, m, extra), extra };
    }),
    run_gates: plain((e, _s, _o, m) => gates(deps, e, m.step)),
    publish: wrap((e) => publish(deps, e)),
    create_pr: plain((e) => createPr(deps, e)),
    await_ci: wrap((e, _s, o) =>
      observeTask(deps, e.task_id, `op:${o.operation_id}`),
    ),
    rerun_ci: plain((e) => rerunCi(deps, e)),
    stop_attempt: plain((_e, _s, _o, m) =>
      Promise.resolve(stopAttempt(deps, m)),
    ),
    reconcile: plain(() =>
      Promise.resolve({
        outcome: 'succeeded',
        data: { finding: 'still_unknown' },
      }),
    ),
  };
}
