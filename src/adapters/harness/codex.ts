/**
 * Codex CLI adapter (T069, FR-011/012/033). Argv follows the shape the T007 fixtures proved on 0.165.0
 * (`pinned-codex.json`) and `prove-harness` re-proves for each pinned binary: `exec --json` with the role schema file and `--output-last-message`
 * into a per-operation scratch file, `approval_policy="never"` and cwd pinned to the worktree. The owner's
 * `config.toml` (linked into the private home) loads as in an interactive session, with every feature
 * on; the flags here override it. Coder/fixer get
 * `workspace-write` plus scratch, the reviewer `read-only`; the inner sandbox is only switched off in
 * the external_verified mode the manifest selected. Nothing here names a model.
 *
 * `--json` emits no event for a command that a rule or the sandbox refused; Codex logs it on stderr
 * (`codex_core::tools::router ... Rejected`), so denials come from stderr and never from the model's
 * own words (T006/T007 evidence). Usage is the sum of `turn.completed.usage`; Codex reports no cost.
 * The session is recorded (no `--ephemeral`) in the private home: `spawn_agent` loads the parent
 * thread's rollout, so an ephemeral session cannot start sub-agents ("no rollout found for thread id").
 *
 * Resume (#218) is `exec <same options> resume <thread id> -`. On 0.167.0 the `resume` subcommand has
 * no `-C`, `--sandbox` or `--add-dir` of its own, but the `exec` options before it apply to the resumed
 * turn (its rollout `turn_context` records the new cwd and sandbox), so argv and the effective
 * permissions stay those of a new session. The resumed run emits `thread.started` with the same id.
 */
import { existsSync } from 'node:fs';
import { UuidSchema } from '../../shared/brand.ts';
import { hashCanonical } from '../../shared/hash.ts';
import type { Usage } from '../../domain/trigger.ts';
import type { PermissionDenial } from '../ports.ts';
import {
  bypassToken,
  classifyFailure,
  DETAIL_MAX,
  isRec,
  osDeniedWrite,
  str,
  validCounters,
  type NativeWriteCheck,
  type PinnedRun,
  type PlanResult,
  type VendorAdapter,
  type VendorFacts,
  type VendorPin,
  type VendorPlanInput,
  type VendorRead,
} from './vendor.ts';

export const CODEX_OUTPUT_FILE = 'final-response.json';

/** Home directory codex reads execpolicy rules from; every file under it must pin its content. */
const RULES_DIR = '.codex/rules/';

function sandboxArgs(input: VendorPlanInput): string[] {
  if (input.host_execution && input.role === 'reviewer') return ['--sandbox', 'read-only'];
  if (input.inner_mode === 'full_access' || input.inner_mode === 'external_verified')
    return ['--sandbox', 'danger-full-access'];
  return input.role === 'reviewer'
    ? ['--sandbox', 'read-only']
    : [
        '--sandbox',
        'workspace-write',
        ...[input.paths.scratch, ...(input.paths.git ?? [])].flatMap((d) => ['--add-dir', d]),
      ];
}

function plan(pin: VendorPin, input: VendorPlanInput): PlanResult {
  const fail = (message: string): PlanResult => ({
    ok: false,
    error: { code: 'policy_violation', message },
  });
  if (pin.vendor !== 'codex') return fail(`pin is for ${pin.vendor}`);
  if (
    input.host_execution &&
    input.inner_mode !== (pin.permission_mode === 'full-access' ? 'full_access' : 'native')
  )
    return fail('host permission mode must match the explicit pin');
  if (input.host_execution && input.inner_mode === 'external_verified')
    return fail('external_verified needs the removed outer sandbox');
  if (pin.settings !== null) return fail('codex takes no settings document; rules go to the home');
  const unpinned = pin.home_files.find((f) => f.to.startsWith(RULES_DIR) && f.sha256 === undefined);
  if (unpinned !== undefined) return fail(`rule file ${unpinned.to} has no pinned sha256`);
  if (input.model === '') return fail('model is not configured');
  // The ref is a positional argument: only a thread UUID may reach argv, never an option.
  if (input.session !== null && !UuidSchema.safeParse(input.session.ref).success)
    return fail('codex session ref is not a thread id');
  const auto =
    input.host_execution && pin.permission_mode !== 'full-access' && input.role !== 'reviewer';
  const argv = [
    pin.binary.realpath,
    'exec',
    '-c',
    auto ? 'approval_policy="on-request"' : 'approval_policy="never"',
    ...(auto ? ['-c', 'approvals_reviewer="auto_review"'] : []),
    '--json',
    '--output-schema',
    `${input.paths.schema}/${input.schema.file_name}`,
    '--output-last-message',
    `${input.paths.scratch}/${CODEX_OUTPUT_FILE}`,
    '--model',
    input.model,
    ...(input.effort === null ? [] : ['-c', `model_reasoning_effort="${input.effort}"`]),
    '-C',
    input.cwd,
    ...sandboxArgs(input),
    ...(input.session === null ? [] : ['resume', input.session.ref]),
    '-',
  ];
  // `danger-full-access` is the sandbox switch itself, allowed only in external_verified (above).
  const bypass = bypassToken([argv, pin.env]);
  if (bypass !== null) return fail(`permission bypass token rejected: ${bypass}`);
  // Effective permission settings for every role of this mode, so one hash covers the binary's config.
  const effective = {
    approval_policy: input.host_execution
      ? {
          worker: pin.permission_mode === 'full-access' ? 'never' : 'on-request',
          reviewer: 'never',
        }
      : 'never',
    ...(input.host_execution ? { approvals_reviewer: 'auto_review' } : {}),
    sandbox: Object.fromEntries(
      (['coder', 'fixer', 'reviewer'] as const).map((role) => [
        role,
        sandboxArgs({
          ...input,
          role,
          paths: input.host_execution
            ? { ...input.paths, scratch: '<scratch>', git: ['<git>'] }
            : input.paths,
        }),
      ]),
    ),
    user_config: true,
    ephemeral: false,
    home_files: pin.home_files.map((f) => ({
      to: f.to,
      sha256: f.sha256 ?? null,
    })),
  };
  return {
    ok: true,
    value: {
      vendor: 'codex',
      argv,
      stdin: 'prompt',
      context_files: [],
      schema_files: [{ name: input.schema.file_name, content: input.schema.file_content }],
      result: { kind: 'file', scratch_name: CODEX_OUTPUT_FILE },
      settings_hash: hashCanonical(effective),
    },
  };
}

// codex_core::tools::router logs the refused exec on stderr; exec --json has no event for it.
const CODEX_REJECTED = /codex_core::tools::router: .*Rejected\(\\?"`(.*)` rejected: ([^\\"]*)/;

/** Codex runs a command through the login shell and logs it that way; a command with its own quotes stays as logged. */
const SHELL_WRAPPER = /^(?:\S*\/)?(?:ba|da|z)?sh -l?c '([^']*)'$/;

function unwrapShell(logged: string): string {
  return SHELL_WRAPPER.exec(logged)?.[1] ?? logged;
}

function failureOf(detail: string): NonNullable<VendorFacts['failure']> {
  const d = detail.slice(0, DETAIL_MAX);
  return { kind: classifyFailure(d, null), detail: d, reset_at: null };
}

function read(input: VendorRead): VendorFacts {
  const warnings: string[] = [];
  let failed: VendorFacts['failure'] = null;
  // A top-level `error` is also what codex prints while it reconnects a dropped stream on its own
  // ("Reconnecting... 1/5"); it only fails the run when no turn completes after it.
  let pending: VendorFacts['failure'] = null;
  let incomplete = false;
  let turns = 0;
  let tokens = 0;
  let session: string | null = null;
  for (const p of input.stdout.filter(isRec)) {
    if (p['type'] === 'thread.started') session = str(p['thread_id']) ?? session;
    else if (p['type'] === 'turn.completed') {
      if (pending !== null) {
        warnings.push(`recovered: ${pending.detail}`.slice(0, DETAIL_MAX));
        pending = null;
      }
      const u = p['usage'];
      if (
        !validCounters(
          u,
          ['input_tokens', 'output_tokens'],
          ['cached_input_tokens', 'cache_write_input_tokens'],
        )
      ) {
        incomplete = true;
        continue;
      }
      // cached_input_tokens is part of input_tokens here; only input and output are added.
      tokens += (u['input_tokens'] as number) + (u['output_tokens'] as number);
      turns++;
    } else if (p['type'] === 'turn.failed') {
      failed = failureOf((isRec(p['error']) ? str(p['error']['message']) : null) ?? 'turn.failed');
    } else if (p['type'] === 'error') {
      pending = failureOf(str(p['message']) ?? 'error');
    } else if (
      p['type'] === 'item.completed' &&
      isRec(p['item']) &&
      p['item']['type'] === 'error'
    ) {
      warnings.push((str(p['item']['message']) ?? 'item error').slice(0, DETAIL_MAX));
    }
  }
  const failure = failed ?? pending;
  const denials: PermissionDenial[] = [];
  for (const line of input.stderr.split('\n')) {
    const m = CODEX_REJECTED.exec(line);
    if (m !== null)
      denials.push({
        tool: 'exec_command',
        command: m[1] === undefined ? null : unwrapShell(m[1]),
        ...(m[2] === undefined ? {} : { message: m[2] }),
        source: 'codex_stderr',
      });
  }
  const usage: Usage =
    turns === 0 || incomplete ? { basis: 'unavailable' } : { basis: 'reported', tokens };
  return {
    usage,
    usage_source: usage.basis === 'reported' ? 'codex turn.completed.usage' : null,
    permission_denials: denials,
    failure,
    session_ref: session,
    reported_model: null,
    final:
      failure === null
        ? { kind: 'file' }
        : { kind: 'missing', reason: `vendor failure ${failure.kind}` },
    warnings,
    truncated_records: input.truncated_records,
  };
}

/**
 * `exec --json` has no event for a command the sandbox refused, so a run shows only the model's word. The sandbox
 * of the pinned binary is run directly instead, with no model: a harmless command must pass, which shows the
 * sandbox itself starts, and the write must fail with an OS error and leave nothing behind.
 */
function nativeWriteDenied(check: NativeWriteCheck): boolean {
  const profile = check.role === 'reviewer' ? ':read-only' : ':workspace';
  const inSandbox = (...command: string[]): PinnedRun =>
    check.runPinned([
      'sandbox',
      '--permission-profile',
      profile,
      '-C',
      check.worktree,
      '--',
      ...command,
    ]);
  if (inSandbox('/usr/bin/true').status !== 0) return false;
  const write = inSandbox('/usr/bin/touch', check.marker);
  return (
    write.status !== 0 &&
    write.status !== null &&
    osDeniedWrite(write.output, check.marker) &&
    !existsSync(check.marker)
  );
}

export const codexAdapter: VendorAdapter = {
  vendor: 'codex',
  resume_supported: true,
  needs_short_tmpdir: false,
  worktree_state: [],
  git_dir_state: [],
  nativeWriteDenied,
  plan,
  read,
};
