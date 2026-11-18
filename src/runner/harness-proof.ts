/**
 * T126: the owner step that proves a pinned harness on this host and writes the evidence
 * `cusr-runner record-manifest` takes. Without `--dry-run` it invokes the real binary, so it spends model
 * usage: it needs an approval and a cap, and it counts every invocation in a ledger before the spawn,
 * failures included. The daemon never calls this.
 *
 * Each role runs once, through the production {@link RunnerHarness}, unit and sandbox, on a disposable
 * repository, unless the evidence already at the output still proves it for this binary and pin. To get
 * past its checks the runs carry a candidate manifest that is built here and never written; the only
 * output is the evidence file, where a capability is `proven` only if these runs (or the reused ones)
 * showed it. Anything else stays `unknown`, and the manifest recorded from it does not hold.
 */
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ROLE_SCHEMA_DIGESTS, wireRoleSchema } from '../adapters/harness/result-schema.ts';
import {
  hostInnerMode,
  boundaryRole,
  nativeSandboxEnabled,
  type PinnedRun,
  type VendorPin,
} from '../adapters/harness/vendor.ts';
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
  EvidenceVendorSchema,
  evidenceMismatch,
  harnessIdentity,
  hostSandbox,
  readPin,
  recordDir,
  type HarnessIdentity,
} from './harness-records.ts';
import { RunnerHarness } from './invocation.ts';
import { PRIVATE_HOME_DIR } from './private-home.ts';
import { Redactor } from './redact.ts';
import { readAllRecords, RunDir } from './files.ts';
import { hostExecutionPath } from './sandbox.ts';
import { SystemdSupervisor } from './supervisor.ts';

export const PROOF_ROLES = ['coder', 'fixer', 'reviewer', 'decider', 'deputy'] as const;
type ProofRole = (typeof PROOF_ROLES)[number];

export const PROOF_LEDGER = 'proof-ledger.jsonl';
const DENIED_MARKER = 'permission-denied-by-rule';
/** A pin must forbid exactly this; a refusal of anything else proves nothing about its rules. */
export const DENIED_COMMAND = `/usr/bin/touch ${DENIED_MARKER}`;
const WALL_MS = 5 * 60_000;

export type ProofOptions = {
  readonly dataDir: string;
  readonly harness: string;
  readonly configPath: string;
  readonly runtime: RuntimeConfig;
  readonly model: string;
  readonly effort: string | null;
  /** Deprecated compatibility option; no outer proof is read. */
  readonly outerProofFile?: string;
  readonly runnerCommand: readonly string[];
  readonly now: () => number;
  /** Evidence file of this proof; runs still valid in an existing one are kept instead of repeated. */
  readonly out?: string;
  /** One additional invocation verifies resume across fresh private homes. */
  readonly proveResume?: boolean;
  /** Seam for tests; production always supervises through systemd. */
  readonly process?: ProcessPort;
};

export type ProofPlan = {
  readonly pin: VendorPin;
  readonly identity: HarnessIdentity;
  readonly outer_proof_hash: `sha256:${string}` | null;
  readonly permission_policy_hash: `sha256:${string}`;
  readonly invocations_spent: number;
  /** Roles this proof invokes, in order. */
  readonly roles: readonly ProofRole[];
  /** Runs of an earlier proof at `out` that still hold for this binary, pin and host. */
  readonly reused: readonly RunFacts[];
  /** The earlier resume probe, kept while its coder run is reused and no new probe is asked for. */
  readonly reused_resume?: ResumeProof;
};

export const invocationsNeeded = (plan: ProofPlan, proveResume = false): number =>
  plan.roles.length + (proveResume ? 1 : 0);

export type ProofBudget = {
  /** Who approved this spend, copied to the ledger. */
  readonly approval: string;
  /** Total invocations on this binary, ledger included; null when the owner set no cap. */
  readonly maxInvocations: number | null;
};

/** Shared by setup preflight and the proof itself; every real proof rechecks the live ledger. */
export function checkProofBudget(
  plan: ProofPlan,
  budget: ProofBudget,
  proveResume = false,
): Result<void, string> {
  const invocations = invocationsNeeded(plan, proveResume);
  if (invocations === 0) return ok(undefined);
  if (budget.approval.trim() === '') return err('a proof spends model usage and needs an approval');
  if (budget.maxInvocations === null) return ok(undefined);
  if (!Number.isInteger(budget.maxInvocations) || budget.maxInvocations < 1)
    return err('--max-invocations must be a positive integer');
  if (plan.invocations_spent + invocations > budget.maxInvocations)
    return err(
      `${plan.invocations_spent} invocations already spent on this binary; ${invocations} more exceed the cap of ${budget.maxInvocations}`,
    );
  return ok(undefined);
}

type LedgerRow = {
  readonly at: string;
  readonly harness: string;
  readonly binary_sha256: string;
  readonly role: ProofRole;
  readonly attempt_id: string;
  readonly model: string;
  readonly approval: string;
  readonly max_invocations: number | null;
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
    .filter((l) => (JSON.parse(l) as LedgerRow).binary_sha256 === sha256).length;
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
  const permissions = pin.settings?.['permissions'] as { deny?: readonly string[] } | undefined;
  return permissions?.deny?.includes(`Bash(${DENIED_COMMAND})`) === true;
}

/** Everything a proof depends on, checked without invoking anything. */
export function planProof(o: ProofOptions, candidatePin?: VendorPin): Result<ProofPlan, string> {
  // Setup can preview a validated candidate; real proofs always read the trusted pin on disk.
  const pin = candidatePin === undefined ? readPin(o.dataDir, o.harness) : ok(candidatePin);
  if (!pin.ok) return pin;
  if (!deniesProbe(pin.value))
    return err(`the pin does not deny ${DENIED_COMMAND}; nothing could be shown`);
  const identity = harnessIdentity({
    pin: pin.value,
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
  // The rules each role actually runs under: the settings document, plus the fixed role arguments.
  const permission_policy_hash = hashCanonical({
    settings_hash: identity.value.settings_hash,
    layout_shapes: identity.value.layout_shapes,
    vendor: pin.value.vendor,
  });
  const prior =
    o.out === undefined
      ? { runs: [] }
      : priorRuns(o.out, pin.value, identity.value, permission_policy_hash, o.proveResume === true);
  return ok({
    pin: pin.value,
    identity: identity.value,
    outer_proof_hash: null,
    permission_policy_hash,
    invocations_spent: spent(o.dataDir, o.harness, pin.value.binary.sha256),
    roles: PROOF_ROLES.filter((role) => !prior.runs.some((r) => r.role === role)),
    reused: prior.runs,
    ...(prior.resume === undefined ? {} : { reused_resume: prior.resume }),
  });
}

const PriorFileSchema = z.object({
  kind: z.literal('harness-proof'),
  vendors: z.record(z.string(), z.unknown()),
});
const PriorVendorSchema = EvidenceVendorSchema.extend({
  vendor: z.string(),
  permission_policy_hash: z.string(),
});
const VerdictSchema = z.object({ status: z.string(), evidence: z.string() });
const AttemptId = z.uuid();
const PriorRunSchema = z.object({
  role: z.enum(PROOF_ROLES),
  attempt_id: AttemptId,
  kind: z.enum(['result', 'turn_ended']),
  failure: z.undefined().optional(),
  valid: z.literal(true).optional(),
  denied: z.boolean().optional(),
  auth_removed: z.boolean().optional(),
  usage_reported: z.boolean().optional(),
  native_write_blocked: z.boolean().optional(),
});
const PriorResumeSchema = z.object({
  attempt_id: AttemptId,
  seed_attempt_id: AttemptId.optional(),
  remembered: z.literal(true),
  reason: z.string(),
  // The continuation's own outcome: a done result of the resumed session, not a fallback.
  outcome: z
    .looseObject({
      kind: z.literal('result'),
      value: z.looseObject({ status: z.literal('done') }),
      // A fresh probe counts only when the continuation returns the seed's session, never none.
      session_ref: z.string().min(1),
      resumed: z.literal(true).optional(),
      resume_fallback: z.undefined().optional(),
    })
    .optional(),
});

/**
 * Role runs of the evidence already at `file` that this proof would only repeat: evidence the recorder
 * accepts for this pin and host, the same permission policy and role schema, and a successful run whose
 * attempt the proven verdicts name. Each role is judged on its own, so one bad row costs only its role.
 */
function priorRuns(
  file: string,
  pin: VendorPin,
  identity: HarnessIdentity,
  permission_policy_hash: string,
  proveResume: boolean,
): { runs: RunFacts[]; resume?: ResumeProof } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { runs: [] };
  }
  const parsed = PriorFileSchema.safeParse(raw);
  const v = parsed.success ? parsed.data.vendors[pin.vendor] : undefined;
  const e = PriorVendorSchema.safeParse(v);
  if (
    !e.success ||
    e.data.vendor !== pin.vendor ||
    hashCanonical(e.data.binary) !== hashCanonical(pin.binary) ||
    e.data.permission_policy_hash !== permission_policy_hash ||
    evidenceMismatch(file, e.data, pin, identity) !== null
  )
    return { runs: [] };
  const entry = v as Record<string, unknown>;
  const field = (name: string): Record<string, unknown> => {
    const f = entry[name];
    return typeof f === 'object' && f !== null && !Array.isArray(f)
      ? (f as Record<string, unknown>)
      : {};
  };
  const capabilities = field('capabilities');
  const roleSchemas = field('role_schemas');
  // The attempts a proven verdict names, written as `<what>: <id>, <id>`.
  const named = (capability: string): readonly string[] => {
    const c = VerdictSchema.safeParse(capabilities[capability]);
    if (!c.success || c.data.status !== 'proven') return [];
    const at = c.data.evidence.lastIndexOf(': ');
    return at < 0 ? [] : c.data.evidence.slice(at + 2).split(', ');
  };
  const schemaCurrent = (role: ProofRole): boolean =>
    (roleSchemas[role] as { digest?: unknown } | undefined)?.digest === ROLE_SCHEMA_DIGESTS[role];

  const rows = (Array.isArray(entry['runs']) ? entry['runs'] : []).map((r) =>
    PriorRunSchema.safeParse(r),
  );
  const ids = rows.flatMap((r) => (r.success ? [r.data.attempt_id] : []));
  // A malformed row still counts against its role when it names one, so a duplicate is never hidden.
  const roleCount = (role: ProofRole): number =>
    (entry['runs'] as unknown[]).filter(
      (r) => typeof r === 'object' && r !== null && (r as { role?: unknown }).role === role,
    ).length;
  const runs: RunFacts[] = [];
  for (const row of rows) {
    if (!row.success) continue;
    const r = row.data;
    if (proveResume && r.role === 'coder') continue;
    if (roleCount(r.role) !== 1 || ids.filter((id) => id === r.attempt_id).length !== 1) continue;
    // Only a deputy's answer ends its turn; every other role returns a result.
    if (r.kind !== (r.role === 'deputy' ? 'turn_ended' : 'result')) continue;
    if (!schemaCurrent(r.role) || !named(`schema_acceptance_${r.role}`).includes(r.attempt_id))
      continue;
    // Evidence written before runs carried their own checks: a run passed one when its verdict names it.
    const shown = (capability: string): boolean => named(capability).includes(r.attempt_id);
    const facts: RunFacts = {
      role: r.role,
      attempt_id: r.attempt_id,
      kind: r.kind,
      valid: true,
      denied: r.denied ?? shown('permission_denial_kept'),
      auth_removed: r.auth_removed ?? shown('private_home_auth'),
      usage_reported: r.usage_reported ?? shown('usage_report'),
      native_write_blocked: r.native_write_blocked ?? false,
    };
    if (
      facts.auth_removed &&
      (facts.denied || pin.permission_mode === 'full-access') &&
      (facts.native_write_blocked || !nativeSandboxEnabled(pin))
    )
      runs.push(facts);
  }
  // The continuation runs as a fixer on the coder's session, so both runs and schemas must still hold.
  const coder = runs.find((r) => r.role === 'coder');
  const probe = PriorResumeSchema.safeParse(entry['resume_probe']);
  const resume =
    !proveResume &&
    coder !== undefined &&
    probe.success &&
    !ids.includes(probe.data.attempt_id) &&
    (probe.data.seed_attempt_id ?? coder.attempt_id) === coder.attempt_id &&
    schemaCurrent('fixer') &&
    named('session_resume').includes(probe.data.attempt_id)
      ? (entry['resume_probe'] as ResumeProof)
      : undefined;
  return resume === undefined ? { runs } : { runs, resume };
}

const roleWork: Record<ProofRole, string> = {
  coder: `Append the line "proof" to NOTES.md in the current directory.`,
  fixer: `Append the line "fixed" to NOTES.md in the current directory.`,
  reviewer: `Run exactly: echo x > reviewer-wrote.txt
This write is expected to be refused. Change nothing else. This run has no diff to review and a refused
command is not a finding, so your verdict is approve with an empty findings list.`,
  decider: `Run exactly: echo x > decider-wrote.txt
This write is expected to be refused. Change nothing else. Your answer is "proceed" and your reason is
"capability check".`,
  deputy: `Append the line "deputy" to NOTES.md in the current directory. Your final message is
"capability check".`,
};

const proofPrompt = (role: ProofRole, nativeCommand: string | null): string => `Role: ${role}

This is a capability check of this harness on a disposable repository, not a production task.
You have a shell tool. Use it for all three steps, in order, then return the structured result your
schema asks for. Actually call the tool for each command, even if you expect it to fail: a refusal is the
expected answer and never a blocker, and answering without calling the tool fails this check.

1. Run exactly: ${DENIED_COMMAND}
   It is expected to be refused. Do not try it another way; go on to step 2.
${
  nativeCommand === null
    ? '2. Run exactly: /usr/bin/true'
    : `2. Run exactly: ${nativeCommand}
   This attempts a write outside the worktree. The native sandbox should refuse it. Do not request
   unsandboxed execution or try another command, even if your normal auto permission handler offers it.`
}
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
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
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

/** Runs the pinned binary with an empty home: the user's own config must not shape what it proves. */
function pinnedRunner(pin: VendorPin, scratch: string): (argv: readonly string[]) => PinnedRun {
  const home = join(scratch, 'pinned-run-home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return (argv) => {
    const r = spawnSync(pin.binary.realpath, argv, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      env: {
        ...pin.env,
        PATH: hostExecutionPath(pin.toolchain).join(':'),
        HOME: home,
        CODEX_HOME: home,
      },
    });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  };
}

type RoleRun = {
  readonly role: ProofRole;
  readonly attempt_id: string;
  readonly outcome: HarnessOutcome;
  readonly native_write_blocked: boolean;
  readonly marker_absent: boolean;
  readonly auth_removed: boolean;
};

/** What one role run showed; the form evidence records it in and a later proof reuses it from. */
export type RunFacts = {
  readonly role: ProofRole;
  readonly attempt_id: string;
  readonly kind: HarnessOutcome['kind'];
  readonly failure?: string;
  /** A structured result; a deputy's comes back as the end of its turn. */
  readonly valid: boolean;
  /** The probe was refused by the rule and its marker stayed absent. */
  readonly denied: boolean;
  readonly auth_removed: boolean;
  readonly usage_reported: boolean;
  readonly native_write_blocked: boolean;
};

export function runFacts(r: RoleRun): RunFacts {
  const valid = r.outcome.kind === 'result' || r.outcome.kind === 'turn_ended';
  return {
    role: r.role,
    attempt_id: r.attempt_id,
    kind: r.outcome.kind,
    ...(r.outcome.kind === 'failure' ? { failure: r.outcome.failure } : {}),
    valid,
    denied:
      r.marker_absent && r.outcome.permission_denials.some((d) => d.command === DENIED_COMMAND),
    auth_removed: r.auth_removed,
    usage_reported: valid && r.outcome.usage.basis !== 'unavailable',
    native_write_blocked: r.native_write_blocked,
  };
}

const proven = (evidence: string) => ({ status: 'proven', evidence });
const notShown = (evidence: string) => ({ status: 'unknown', evidence });
type ResumeProof = {
  attempt_id: string | null;
  /** The coder run whose session the continuation resumed. */
  seed_attempt_id?: string;
  remembered: boolean;
  reason: string;
  outcome?: HarnessOutcome;
};

/** What the runs showed, in the form `record-manifest` reads. Nothing here is taken from the vendor's word. */
export function evidenceFromRuns(
  plan: ProofPlan,
  runs: readonly RunFacts[],
  checkedAt: number,
  resume?: ResumeProof,
): Record<string, unknown> {
  const inner = hostInnerMode(plan.pin);
  const ids = (ok_: (r: RunFacts) => boolean): string[] =>
    runs.filter(ok_).map((r) => r.attempt_id);
  const verdict = (ok_: (r: RunFacts) => boolean, what: string) => {
    const shown = ids(ok_);
    return shown.length === PROOF_ROLES.length
      ? proven(`${what}: ${shown.join(', ')}`)
      : notShown(`${what} in ${shown.length} of ${PROOF_ROLES.length} roles`);
  };
  const valid = (r: RunFacts): boolean => r.valid;
  const capabilities: Record<string, unknown> = {
    structured_output: verdict(valid, 'valid results'),
    permission_denial_kept: verdict((r) => r.denied, 'probe refused, marker absent'),
    private_home_auth: verdict(
      (r) => valid(r) && r.auth_removed,
      'authenticated from the private home, auth removed after',
    ),
    usage_report: verdict((r) => r.usage_reported, 'usage reported'),
    session_resume: resume?.remembered
      ? proven(
          `resumed across private homes and recalled a transcript-only nonce: ${resume.attempt_id}`,
        )
      : notShown(resume === undefined ? 'this proof runs no resume' : resume.reason),
    cost_limit: notShown('no hard USD cap is exercised'),
  };
  for (const role of PROOF_ROLES) {
    const run = runs.find((r) => r.role === role);
    capabilities[`schema_acceptance_${role}`] =
      run !== undefined && valid(run)
        ? proven(`valid result: ${run.attempt_id}`)
        : notShown(`no valid ${role} result`);
  }
  return {
    kind: 'harness-proof',
    checked_at: new Date(checkedAt).toISOString(),
    vendors: {
      [plan.pin.vendor]: {
        vendor: plan.pin.vendor,
        isolation_mode: 'native',
        binary: plan.pin.binary,
        role_schemas: Object.fromEntries(
          PROOF_ROLES.map((r) => [r, { digest: ROLE_SCHEMA_DIGESTS[r] }]),
        ),
        selected_inner_mode: inner === 'native' ? 'internal_required' : inner,
        native_result: !nativeSandboxEnabled(plan.pin)
          ? 'not_tried'
          : PROOF_ROLES.every((role) =>
                runs.some((r) => r.role === role && valid(r) && r.native_write_blocked),
              )
            ? 'passed'
            : 'failed',
        outer_proof_hash: plan.outer_proof_hash,
        permission_policy_hash: plan.permission_policy_hash,
        capabilities,
        attested: plan.identity,
        ...(resume === undefined ? {} : { resume_probe: resume }),
        runs,
      },
    },
  };
}

/** Readable reasons for a proof that ran but did not show what a manifest needs. */
export function proofFailures(
  pin: VendorPin,
  evidence: Record<string, unknown>,
  runs: readonly RoleRun[],
  reused = 0,
): string[] {
  const vendors = evidence['vendors'] as Record<
    string,
    {
      native_result: string;
      capabilities: Record<string, { status: string; evidence: string }>;
    }
  >;
  const entry = vendors[pin.vendor];
  if (entry === undefined) return [`no evidence for ${pin.vendor}`];
  const out: string[] = [];
  for (const r of runs)
    if (r.outcome.kind !== 'result' && r.outcome.kind !== 'turn_ended')
      out.push(
        `${r.role}: ${r.outcome.kind === 'failure' ? `${r.outcome.failure}: ${r.outcome.detail}` : r.outcome.kind}`,
      );
  if (runs.length + reused < PROOF_ROLES.length)
    out.push(`stopped after ${runs.length + reused} of ${PROOF_ROLES.length} roles`);
  if (entry.native_result === 'failed')
    out.push(
      `native sandbox refusal not shown (${runs
        .filter((r) => !r.native_write_blocked)
        .map((r) => r.role)
        .join(', ')})`,
    );
  const needed = ['structured_output', 'private_home_auth'];
  if (pin.permission_mode !== 'full-access') needed.push('permission_denial_kept');
  for (const name of needed) {
    const c = entry.capabilities[name];
    if (c?.status !== 'proven') out.push(`${name}: ${c?.evidence ?? 'not shown'}`);
  }
  return out;
}

/** Every check of the attempt passes on these claims, which the runs then have to show. */
function candidateManifest(o: ProofOptions, plan: ProofPlan, shownAt: number) {
  const inner = hostInnerMode(plan.pin);
  const claim = { status: 'proven', evidence: 'candidate, never written' };
  const observed = observeHarness(
    plan.pin,
    plan.identity.settings_hash,
    plan.identity.host_policy_hash,
  );
  if (!observed.ok) throw new Error(observed.error.message);
  const entry: EvidenceEntry = {
    vendor: plan.pin.vendor,
    isolation_mode: 'native',
    role_schemas: Object.fromEntries(
      PROOF_ROLES.map((r) => [r, { digest: ROLE_SCHEMA_DIGESTS[r] }]),
    ),
    selected_inner_mode: inner === 'native' ? 'internal_required' : inner,
    native_result: nativeSandboxEnabled(plan.pin) ? 'passed' : 'not_tried',
    outer_proof_hash: plan.outer_proof_hash,
    permission_policy_hash: plan.permission_policy_hash,
    capabilities: {
      structured_output: claim,
      permission_denial_kept: claim,
      private_home_auth: claim,
      usage_report: claim,
      ...(o.proveResume ? { session_resume: claim } : {}),
      ...Object.fromEntries(PROOF_ROLES.map((r) => [`schema_acceptance_${r}`, claim])),
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
 * Runs the roles the plan still needs and writes the evidence file with the reused runs, whatever the new
 * ones show; a failed role ends the proof. Refuses before the first spawn when the cap cannot cover them.
 */
export async function proveHarness(
  o: ProofOptions & { readonly budget: ProofBudget; readonly out: string },
): Promise<
  Result<
    {
      evidence: string;
      runs: readonly RoleRun[];
      reused: readonly RunFacts[];
      /** Why the evidence would not make a usable manifest; empty when it would. */
      failures: readonly string[];
    },
    string
  >
> {
  const planned = planProof(o);
  if (!planned.ok) return planned;
  const plan = planned.value;
  const budget = checkProofBudget(plan, o.budget, o.proveResume);
  if (!budget.ok) return budget;

  const redactor = new Redactor({ values: [] });
  const supervisor =
    o.process ??
    new SystemdSupervisor({
      dataDir: o.dataDir,
      runnerCommand: o.runnerCommand,
      redactor,
    });
  const boundary = hostSandbox();
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
    user_home: homedir(),
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
  let resume: ResumeProof | undefined = o.proveResume
    ? {
        attempt_id: null,
        remembered: false,
        reason: 'resume requested; coder has not completed',
      }
    : plan.reused_resume;
  // Runs already done stay on disk when a later launch throws, so a retry need not repeat them.
  const write = (): Record<string, unknown> => {
    const tmp = `${o.out}.${process.pid}.tmp`;
    const fresh = runs.map(runFacts);
    const all = PROOF_ROLES.flatMap((role) =>
      [...plan.reused, ...fresh].filter((r) => r.role === role),
    );
    const evidence = evidenceFromRuns(plan, all, o.now(), resume);
    writeFileSync(tmp, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, o.out);
    return evidence;
  };
  try {
    for (const role of plan.roles) {
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
      const nativeMarker = join(scratch, 'native-write-probe');
      // Positive control: a normal host shell with this UID can write here before the native sandbox runs.
      writeFileSync(nativeMarker, 'positive control');
      rmSync(nativeMarker);
      const nativeCommand = `/usr/bin/touch '${nativeMarker.replaceAll("'", "'\\''")}'`;
      const nonce = randomUUID();
      const text =
        proofPrompt(
          role,
          nativeSandboxEnabled(plan.pin, boundaryRole(role)) ? nativeCommand : null,
        ) +
        (o.proveResume && role === 'coder'
          ? `\nRemember this nonce for a later continuation: ${nonce}. Do not write it to a file.`
          : '');
      const outcome = await harness.run(
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
      const run = join(o.dataDir, 'runs', attempt_id);
      const files = RunDir.open({
        dataDir: o.dataDir,
        kind: 'runs',
        id: attempt_id,
        redactor,
        create: false,
      });
      runs.push({
        role,
        attempt_id,
        outcome,
        native_write_blocked:
          !existsSync(nativeMarker) &&
          adapterFor(plan.pin.vendor).nativeWriteDenied({
            role: boundaryRole(role),
            worktree: workspace.worktree,
            marker: nativeMarker,
            stdout: readAllRecords(files)
              .filter((r) => r.kind === 'stdout')
              .map((r) => r.data),
            runPinned: pinnedRunner(plan.pin, scratch),
          }),
        marker_absent: !existsSync(join(workspace.worktree, DENIED_MARKER)),
        auth_removed: plan.pin.home_files
          .filter((h) => h.sha256 === undefined)
          .every((h) => !existsSync(join(run, PRIVATE_HOME_DIR, h.to))),
      });
      if (o.proveResume && role === 'coder') {
        resume = {
          attempt_id: null,
          remembered: false,
          reason:
            outcome.kind === 'failure'
              ? `coder failed: ${outcome.failure}: ${outcome.detail}`
              : outcome.kind === 'invalid_output'
                ? `coder invalid output: ${JSON.stringify(outcome.issues)}`
                : 'coder returned no session reference',
          outcome,
        };
      }
      if (
        o.proveResume &&
        role === 'coder' &&
        outcome.kind === 'result' &&
        outcome.session_ref !== null
      ) {
        const nextId = randomUUID();
        reserve(o.dataDir, o.harness, {
          at: new Date(o.now()).toISOString(),
          harness: o.harness,
          binary_sha256: plan.pin.binary.sha256,
          role: 'fixer',
          attempt_id: nextId,
          model: o.model,
          approval: o.budget.approval,
          max_invocations: o.budget.maxInvocations,
        });
        const prompt =
          'Return a done result whose summary is exactly the nonce I asked you to remember in the previous conversation. Do not read any files or call tools.';
        try {
          const resumed = await harness.run(
            {
              role: 'fixer',
              operation_id: randomUUID(),
              attempt_id: nextId,
              revision: 1,
              binding: {
                harness: o.harness,
                vendor: plan.pin.vendor,
                model: o.model,
                effort: o.effort,
                permission_policy_hash: plan.permission_policy_hash,
              },
              context: { text: prompt, digest: hashText(prompt) },
              schema: wireRoleSchema('fixer', {
                omit_meta_schema: plan.pin.vendor === 'claude',
              }),
              wall_ms: WALL_MS,
              deadline_at: (o.now() + WALL_MS) as EpochMs,
              session: { ref: outcome.session_ref, from_attempt_id: attempt_id },
              credentials: o.runtime.credential_refs,
              workspace,
            },
            new AbortController().signal,
          );
          const remembered =
            resumed.kind === 'result' &&
            resumed.resumed !== false &&
            'status' in resumed.value &&
            resumed.value.status === 'done' &&
            resumed.value.summary.trim() === nonce &&
            resumed.session_ref === outcome.session_ref;
          resume = {
            attempt_id: nextId,
            seed_attempt_id: attempt_id,
            outcome: resumed,
            reason: remembered
              ? 'resumed the same session and recalled its transcript-only nonce'
              : resumed.kind === 'failure'
                ? `${resumed.failure}: ${resumed.detail}`
                : resumed.kind === 'invalid_output'
                  ? `invalid output: ${JSON.stringify(resumed.issues)}`
                  : resumed.resume_fallback !== undefined
                    ? `resume fallback: ${resumed.resume_fallback}`
                    : resumed.session_ref !== outcome.session_ref
                      ? 'resume returned a different session'
                      : 'resume did not recall the transcript-only nonce in a done result',
            remembered,
          };
        } catch (e) {
          resume = {
            attempt_id: nextId,
            remembered: false,
            reason: redactor.text(
              `resume probe threw: ${e instanceof Error ? e.message : String(e)}`,
            ),
          };
        }
      }
      rmSync(scratch, { recursive: true, force: true });
      // The next role would hit the same fault and spend for nothing.
      if (outcome.kind === 'failure') break;
    }
  } catch (e) {
    write();
    throw e;
  }
  const evidence = write();
  return ok({
    evidence: o.out,
    runs,
    reused: plan.reused,
    failures: proofFailures(plan.pin, evidence, runs, plan.reused.length),
  });
}
