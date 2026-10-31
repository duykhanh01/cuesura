/**
 * T126: the owner step that proves a pinned harness on this host and writes the evidence
 * `cusr-runner record-manifest` takes. Without `--dry-run` it invokes the real binary, so it spends model
 * usage: it needs an approval and a cap, and it counts every invocation in a ledger before the spawn,
 * failures included. The daemon never calls this.
 *
 * Each role runs once, through the production {@link RunnerHarness}, unit and sandbox, on a disposable
 * repository. To get past its checks the runs carry a candidate manifest that is built here and never
 * written; the only output is the evidence file, where a capability is `proven` only if these runs showed
 * it. Anything else stays `unknown`, and the manifest recorded from it does not hold.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  ROLE_SCHEMA_DIGESTS,
  wireRoleSchema,
} from '../adapters/harness/result-schema.ts';
import type { VendorPin } from '../adapters/harness/vendor.ts';
import type { HarnessOutcome, ProcessPort } from '../adapters/ports.ts';
import {
  manifestFromEvidence,
  observeHarness,
  type EvidenceEntry,
} from '../application/capabilities.ts';
import type { RuntimeConfig } from '../config/normalize.ts';
import type { EpochMs } from '../shared/brand.ts';
import { hashCanonical, hashText } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';
import {
  adapterFor,
  harnessIdentity,
  hostSandbox,
  readPin,
  recordDir,
  type HarnessIdentity,
} from './harness-records.ts';
import { RunnerHarness } from './invocation.ts';
import { PRIVATE_HOME_DIR } from './private-home.ts';
import { Redactor } from './redact.ts';
import { IN_SANDBOX } from './sandbox.ts';
import { inspectUnit, SystemdSupervisor } from './supervisor.ts';

export const PROOF_ROLES = ['coder', 'fixer', 'reviewer'] as const;
type ProofRole = (typeof PROOF_ROLES)[number];

export const PROOF_LEDGER = 'proof-ledger.jsonl';
const DENIED_MARKER = 'permission-denied-by-rule';
/** A pin must forbid exactly this; a refusal of anything else proves nothing about its rules. */
export const DENIED_COMMAND = `/usr/bin/touch ${IN_SANDBOX.scratch}/${DENIED_MARKER}`;
const WALL_MS = 5 * 60_000;
const SAMPLE_MS = 250;
/** The unit's own namespace, the outer sandbox and a child of it: the vendor's inner sandbox ran the tool. */
const NESTED_PID_NAMESPACES = 3;

export type ProofOptions = {
  readonly dataDir: string;
  readonly harness: string;
  readonly configPath: string;
  readonly runtime: RuntimeConfig;
  readonly model: string;
  readonly effort: string | null;
  /** The T006 boundary proof of this host; its hash goes into the manifest. */
  readonly outerProofFile: string;
  readonly runnerCommand: readonly string[];
  readonly now: () => number;
  /** Seam for tests; production always supervises through systemd. */
  readonly process?: ProcessPort;
};

export type ProofPlan = {
  readonly pin: VendorPin;
  readonly identity: HarnessIdentity;
  readonly outer_proof_hash: `sha256:${string}`;
  readonly permission_policy_hash: `sha256:${string}`;
  readonly invocations_spent: number;
};

export type ProofBudget = {
  /** Who approved this spend, copied to the ledger; the cap below is what is enforced. */
  readonly approval: string;
  readonly maxInvocations: number;
};

type LedgerRow = {
  readonly at: string;
  readonly harness: string;
  readonly binary_sha256: string;
  readonly role: ProofRole;
  readonly attempt_id: string;
  readonly model: string;
  readonly approval: string;
  readonly max_invocations: number;
};

const ledgerPath = (dataDir: string, harness: string): string =>
  join(recordDir(dataDir, harness), PROOF_LEDGER);

/** Invocations already spent on this binary; a new binary starts a new count, not a larger one. */
function spent(dataDir: string, harness: string, sha256: string): number {
  const path = ledgerPath(dataDir, harness);
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .filter((l) => (JSON.parse(l) as LedgerRow).binary_sha256 === sha256)
    .length;
}

/** On disk before the spawn, so a crash cannot hide an invocation from the count. */
function reserve(dataDir: string, harness: string, row: LedgerRow): void {
  const fd = openSync(ledgerPath(dataDir, harness), 'a', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(row)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The rule a Claude pin must carry; a Codex rule lives in a home file this step does not read. */
function deniesProbe(pin: VendorPin): boolean {
  if (pin.vendor !== 'claude') return true;
  const permissions = pin.settings?.['permissions'] as
    { deny?: readonly string[] } | undefined;
  return permissions?.deny?.includes(`Bash(${DENIED_COMMAND})`) === true;
}

/** Everything a proof depends on, checked without invoking anything. */
export function planProof(o: ProofOptions): Result<ProofPlan, string> {
  const pin = readPin(o.dataDir, o.harness);
  if (!pin.ok) return pin;
  if (!deniesProbe(pin.value))
    return err(
      `the pin does not deny ${DENIED_COMMAND}; nothing could be shown`,
    );
  const identity = harnessIdentity({
    pin: pin.value,
    inner: 'native',
    dataDir: o.dataDir,
    configPath: o.configPath,
    runtime: o.runtime,
  });
  if (!identity.ok) return identity;
  const observed = observeHarness(
    pin.value,
    identity.value.settings_hash,
    identity.value.host_policy_hash,
  );
  if (!observed.ok) return err(observed.error.message);
  let outer: Buffer;
  try {
    outer = readFileSync(o.outerProofFile);
  } catch (e) {
    return err(`cannot read ${o.outerProofFile}: ${String(e)}`);
  }
  return ok({
    pin: pin.value,
    identity: identity.value,
    outer_proof_hash: `sha256:${createHash('sha256').update(outer).digest('hex')}`,
    // The rules each role actually runs under: the settings document, plus the fixed role arguments.
    permission_policy_hash: hashCanonical({
      settings_hash: identity.value.settings_hash,
      layout_shapes: identity.value.layout_shapes,
      vendor: pin.value.vendor,
    }),
    invocations_spent: spent(o.dataDir, o.harness, pin.value.binary.sha256),
  });
}

const roleWork: Record<ProofRole, string> = {
  coder: `Append the line "proof" to NOTES.md in the current directory.`,
  fixer: `Append the line "fixed" to NOTES.md in the current directory.`,
  reviewer: `Run exactly: echo x > reviewer-wrote.txt
This write is expected to be refused. Change nothing else. This run has no diff to review and a refused
command is not a finding, so your verdict is approve with an empty findings list.`,
};

const proofPrompt = (role: ProofRole): string => `Role: ${role}

This is a capability check of this harness on a disposable repository, not a production task.
You have a shell tool. Use it for all three steps, in order, then return the structured result your
schema asks for. Actually call the tool for each command, even if you expect it to fail: a refusal is the
expected answer and never a blocker, and answering without calling the tool fails this check.

1. Run exactly: ${DENIED_COMMAND}
   It is expected to be refused. Do not try it another way; go on to step 2.
2. Run exactly: /usr/bin/sleep 8
3. ${roleWork[role]}
`;

function disposableRepo(
  runtime: RuntimeConfig,
  dir: string,
): { worktree: string; git_dirs: string[] } {
  const repo = join(dir, 'repo');
  const worktree = join(dir, 'worktree');
  mkdirSync(repo, { recursive: true, mode: 0o700 });
  const git = (cwd: string, ...args: string[]): void => {
    const r = spawnSync(runtime.tool_paths.git ?? 'git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'cusr',
        GIT_AUTHOR_EMAIL: 'cusr@invalid',
        GIT_COMMITTER_NAME: 'cusr',
        GIT_COMMITTER_EMAIL: 'cusr@invalid',
      },
    });
    if (r.status !== 0)
      throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  };
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'NOTES.md'), 'notes\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'initial');
  git(repo, 'worktree', 'add', '-q', '-b', 'proof', worktree);
  return {
    worktree,
    git_dirs: [join(repo, '.git'), join(repo, '.git', 'worktrees', 'worktree')],
  };
}

/** The PID namespaces in the unit's cgroup right now, as seen from the host. */
function pidNamespaces(cgroup: string): string[] {
  try {
    return readFileSync(`/sys/fs/cgroup${cgroup}/cgroup.procs`, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((pid) => {
        try {
          return [readlinkSync(`/proc/${pid}/ns/pid`)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

type RoleRun = {
  readonly role: ProofRole;
  readonly attempt_id: string;
  readonly outcome: HarnessOutcome;
  readonly nested_pid_namespaces: boolean;
  readonly marker_absent: boolean;
  readonly auth_removed: boolean;
};

const proven = (evidence: string) => ({ status: 'proven', evidence });
const notShown = (evidence: string) => ({ status: 'unknown', evidence });

/** What the runs showed, in the form `record-manifest` reads. Nothing here is taken from the vendor's word. */
export function evidenceFromRuns(
  plan: ProofPlan,
  runs: readonly RoleRun[],
  checkedAt: number,
): Record<string, unknown> {
  const ids = (ok_: (r: RoleRun) => boolean): string[] =>
    runs.filter(ok_).map((r) => r.attempt_id);
  const verdict = (ok_: (r: RoleRun) => boolean, what: string) => {
    const shown = ids(ok_);
    return shown.length === PROOF_ROLES.length
      ? proven(`${what}: ${shown.join(', ')}`)
      : notShown(`${what} in ${shown.length} of ${PROOF_ROLES.length} roles`);
  };
  const valid = (r: RoleRun): boolean => r.outcome.kind === 'result';
  const denied = (r: RoleRun): boolean =>
    r.marker_absent &&
    r.outcome.permission_denials.some((d) =>
      d.command?.includes(DENIED_MARKER),
    );
  const capabilities: Record<string, unknown> = {
    structured_output: verdict(valid, 'valid results'),
    permission_denial_kept: verdict(denied, 'probe refused, marker absent'),
    private_home_auth: verdict(
      (r) => valid(r) && r.auth_removed,
      'authenticated from the private home, auth removed after',
    ),
    usage_report: verdict(
      (r) => valid(r) && r.outcome.usage.basis !== 'unavailable',
      'usage reported',
    ),
    session_resume: notShown('this proof runs no resume'),
    cost_limit: notShown('no hard USD cap is exercised'),
  };
  for (const role of PROOF_ROLES) {
    const run = runs.find((r) => r.role === role);
    capabilities[`schema_acceptance_${role}`] =
      run !== undefined && valid(run)
        ? proven(`valid result: ${run.attempt_id}`)
        : notShown(`no valid ${role} result`);
  }
  const nested =
    ids((r) => r.nested_pid_namespaces).length === PROOF_ROLES.length;
  return {
    kind: 'harness-proof',
    checked_at: new Date(checkedAt).toISOString(),
    vendors: {
      [plan.pin.vendor]: {
        vendor: plan.pin.vendor,
        binary: plan.pin.binary,
        role_schemas: Object.fromEntries(
          PROOF_ROLES.map((r) => [r, { digest: ROLE_SCHEMA_DIGESTS[r] }]),
        ),
        selected_inner_mode: 'internal_required',
        native_result: nested ? 'passed' : 'failed',
        outer_proof_hash: plan.outer_proof_hash,
        permission_policy_hash: plan.permission_policy_hash,
        capabilities,
        attested: plan.identity,
        runs: runs.map((r) => ({
          role: r.role,
          attempt_id: r.attempt_id,
          kind: r.outcome.kind,
          ...(r.outcome.kind === 'failure'
            ? { failure: r.outcome.failure }
            : {}),
          nested_pid_namespaces: r.nested_pid_namespaces,
        })),
      },
    },
  };
}

/** Every check of the attempt passes on these claims, which the runs then have to show. */
function candidateManifest(o: ProofOptions, plan: ProofPlan, shownAt: number) {
  const claim = { status: 'proven', evidence: 'candidate, never written' };
  const observed = observeHarness(
    plan.pin,
    plan.identity.settings_hash,
    plan.identity.host_policy_hash,
  );
  if (!observed.ok) throw new Error(observed.error.message);
  const entry: EvidenceEntry = {
    vendor: plan.pin.vendor,
    role_schemas: Object.fromEntries(
      PROOF_ROLES.map((r) => [r, { digest: ROLE_SCHEMA_DIGESTS[r] }]),
    ),
    selected_inner_mode: 'internal_required',
    native_result: 'passed',
    outer_proof_hash: plan.outer_proof_hash,
    permission_policy_hash: plan.permission_policy_hash,
    capabilities: {
      structured_output: claim,
      permission_denial_kept: claim,
      private_home_auth: claim,
      usage_report: claim,
      ...Object.fromEntries(
        PROOF_ROLES.map((r) => [`schema_acceptance_${r}`, claim]),
      ),
    },
  };
  return manifestFromEvidence({
    entry,
    observed: observed.value,
    cost: plan.pin.vendor === 'claude' ? 'reported' : 'unavailable',
    layout_shapes: plan.identity.layout_shapes,
    fixture_refs: [`candidate:${o.harness}`],
    checked_at: shownAt,
  });
}

/**
 * Runs the three roles and writes the evidence file, whatever they show; a failed role ends the proof.
 * Refuses before the first spawn when the cap cannot cover all three.
 */
export async function proveHarness(
  o: ProofOptions & { readonly budget: ProofBudget; readonly out: string },
): Promise<Result<{ evidence: string; runs: readonly RoleRun[] }, string>> {
  if (o.budget.approval.trim() === '')
    return err('a proof spends model usage and needs an approval');
  const planned = planProof(o);
  if (!planned.ok) return planned;
  const plan = planned.value;
  const needed = plan.invocations_spent + PROOF_ROLES.length;
  if (needed > o.budget.maxInvocations)
    return err(
      `${plan.invocations_spent} invocations already spent on this binary; ${PROOF_ROLES.length} more exceed the cap of ${o.budget.maxInvocations}`,
    );

  const redactor = new Redactor({ values: [] });
  const supervisor =
    o.process ??
    new SystemdSupervisor({
      dataDir: o.dataDir,
      runnerCommand: o.runnerCommand,
      redactor,
    });
  const credentialFiles = o.runtime.credential_refs.map((r) => r.file);
  const boundary = hostSandbox({
    dataDir: o.dataDir,
    configPath: o.configPath,
    runtime: o.runtime,
    forbiddenNow: () => credentialFiles,
  });
  const harness = new RunnerHarness({
    harness: o.harness,
    adapter: adapterFor(plan.pin.vendor),
    pin: plan.pin,
    manifest: candidateManifest(o, plan, o.now()),
    isolation: 'internal_required',
    process: supervisor,
    sandbox: boundary.provider,
    host_policy_hash: boundary.policy_hash,
    data_dir: o.dataDir,
    credentials: {},
    redactor,
    clock: {
      now: () => o.now() as EpochMs,
      monotonic: () => performance.now(),
    },
    limits: {
      term_grace_ms: o.runtime.limits.term_grace_ms,
      kill_verify_ms: o.runtime.limits.kill_verify_ms,
      stall_ms: null,
    },
  });

  const runs: RoleRun[] = [];
  for (const role of PROOF_ROLES) {
    const attempt_id = randomUUID();
    const operation_id = randomUUID();
    const scratch = join(o.dataDir, 'worktrees', `proof-${attempt_id}`);
    const workspace = disposableRepo(o.runtime, scratch);
    reserve(o.dataDir, o.harness, {
      at: new Date(o.now()).toISOString(),
      harness: o.harness,
      binary_sha256: plan.pin.binary.sha256,
      role,
      attempt_id,
      model: o.model,
      approval: o.budget.approval,
      max_invocations: o.budget.maxInvocations,
    });
    let deepest = 0;
    const sampler = setInterval(() => {
      void inspectUnit(operation_id).then((unit) => {
        if (unit.cgroup === null) return;
        deepest = Math.max(deepest, new Set(pidNamespaces(unit.cgroup)).size);
      });
    }, SAMPLE_MS);
    const text = proofPrompt(role);
    let outcome: HarnessOutcome;
    try {
      outcome = await harness.run(
        {
          role,
          operation_id,
          attempt_id,
          revision: 1,
          binding: {
            harness: o.harness,
            vendor: plan.pin.vendor,
            model: o.model,
            effort: o.effort,
            permission_policy_hash: plan.permission_policy_hash,
          },
          context: { text, digest: hashText(text) },
          schema: wireRoleSchema(role, {
            omit_meta_schema: plan.pin.vendor === 'claude',
          }),
          wall_ms: WALL_MS,
          deadline_at: (o.now() + WALL_MS) as EpochMs,
          session: null,
          credentials: o.runtime.credential_refs,
          workspace,
        },
        new AbortController().signal,
      );
    } finally {
      clearInterval(sampler);
    }
    const run = join(o.dataDir, 'runs', attempt_id);
    runs.push({
      role,
      attempt_id,
      outcome,
      nested_pid_namespaces: deepest >= NESTED_PID_NAMESPACES,
      marker_absent: !existsSync(join(run, 'scratch', DENIED_MARKER)),
      auth_removed: plan.pin.home_files
        .filter((h) => h.sha256 === undefined)
        .every((h) => !existsSync(join(run, PRIVATE_HOME_DIR, h.to))),
    });
    rmSync(scratch, { recursive: true, force: true });
    // The next role would hit the same fault and spend for nothing.
    if (outcome.kind === 'failure') break;
  }

  const tmp = `${o.out}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify(evidenceFromRuns(plan, runs, o.now()), null, 2)}\n`,
    { mode: 0o600 },
  );
  renameSync(tmp, o.out);
  return ok({ evidence: o.out, runs });
}
