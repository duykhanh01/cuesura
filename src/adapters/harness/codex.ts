/**
 * Codex CLI adapter (T069, FR-011/012/033). Argv follows the pinned 0.165.0 shape the T007 fixtures
 * proved (`pinned-codex.json`): `exec --json` with the role schema file and `--output-last-message`
 * into a per-operation scratch file, apps/plugins/MCP installs disabled, `approval_policy="never"`,
 * user config ignored, an ephemeral session and cwd pinned to the worktree. Coder/fixer get
 * `workspace-write` plus scratch, the reviewer `read-only`; the inner sandbox is only switched off in
 * the external_verified mode the manifest selected. Nothing here names a model.
 *
 * `--json` emits no event for a command that a rule or the sandbox refused; Codex logs it on stderr
 * (`codex_core::tools::router ... Rejected`), so denials come from stderr and never from the model's
 * own words (T006/T007 evidence). Usage is the sum of `turn.completed.usage`; Codex reports no cost.
 * No resume argv is pinned for this binary, so a session is never passed.
 */
import { hashCanonical } from '../../shared/hash.ts';
import type { Usage } from '../../domain/trigger.ts';
import type { PermissionDenial } from '../ports.ts';
import {
  bypassToken,
  classifyFailure,
  DETAIL_MAX,
  isRec,
  str,
  validCounters,
  type PlanResult,
  type VendorAdapter,
  type VendorFacts,
  type VendorPin,
  type VendorPlanInput,
  type VendorRead,
} from './vendor.ts';

export const CODEX_OUTPUT_FILE = 'final-response.json';
const DISABLED_FEATURES = [
  'apps',
  'plugins',
  'remote_plugin',
  'plugin_sharing',
  'skill_mcp_dependency_install',
] as const;

/** Home directory codex reads execpolicy rules from; every file under it must pin its content. */
const RULES_DIR = '.codex/rules/';

function sandboxArgs(input: VendorPlanInput): string[] {
  if (input.inner_mode === 'external_verified')
    return ['--sandbox', 'danger-full-access'];
  return input.role === 'reviewer'
    ? ['--sandbox', 'read-only']
    : ['--sandbox', 'workspace-write', '--add-dir', input.paths.scratch];
}

function plan(pin: VendorPin, input: VendorPlanInput): PlanResult {
  const fail = (message: string): PlanResult => ({
    ok: false,
    error: { code: 'policy_violation', message },
  });
  if (pin.vendor !== 'codex') return fail(`pin is for ${pin.vendor}`);
  if (pin.settings !== null)
    return fail('codex takes no settings document; rules go to the home');
  const unpinned = pin.home_files.find(
    (f) => f.to.startsWith(RULES_DIR) && f.sha256 === undefined,
  );
  if (unpinned !== undefined)
    return fail(`rule file ${unpinned.to} has no pinned sha256`);
  if (input.model === '') return fail('model is not configured');
  if (input.session !== null)
    return {
      ok: false,
      error: {
        code: 'resume_unsupported',
        message: 'no resume form is pinned for this codex binary',
      },
    };
  const argv = [
    pin.binary.realpath,
    'exec',
    ...DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
    '-c',
    'approval_policy="never"',
    '--json',
    '--output-schema',
    `${input.paths.schema}/${input.schema.file_name}`,
    '--output-last-message',
    `${input.paths.scratch}/${CODEX_OUTPUT_FILE}`,
    '--model',
    input.model,
    ...(input.effort === null
      ? []
      : ['-c', `model_reasoning_effort="${input.effort}"`]),
    '--ignore-user-config',
    '--ephemeral',
    '-C',
    input.cwd,
    ...sandboxArgs(input),
    '-',
  ];
  // `danger-full-access` is the sandbox switch itself, allowed only in external_verified (above).
  const bypass = bypassToken([argv, pin.env]);
  if (bypass !== null)
    return fail(`permission bypass token rejected: ${bypass}`);
  // Effective permission settings for every role of this mode, so one hash covers the binary's config.
  const effective = {
    disabled: DISABLED_FEATURES,
    approval_policy: 'never',
    sandbox: Object.fromEntries(
      (['coder', 'fixer', 'reviewer'] as const).map((role) => [
        role,
        sandboxArgs({ ...input, role }),
      ]),
    ),
    ignore_user_config: true,
    ephemeral: true,
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
      schema_files: [
        { name: input.schema.file_name, content: input.schema.file_content },
      ],
      result: { kind: 'file', scratch_name: CODEX_OUTPUT_FILE },
      settings_hash: hashCanonical(effective),
    },
  };
}

// codex_core::tools::router logs the refused exec on stderr; exec --json has no event for it.
const CODEX_REJECTED =
  /codex_core::tools::router: .*Rejected\(\\?"`(.*)` rejected: ([^\\"]*)/;

function read(input: VendorRead): VendorFacts {
  const warnings: string[] = [];
  let failure: VendorFacts['failure'] = null;
  let incomplete = false;
  let turns = 0;
  let tokens = 0;
  let session: string | null = null;
  for (const p of input.stdout.filter(isRec)) {
    if (p['type'] === 'thread.started')
      session = str(p['thread_id']) ?? session;
    else if (p['type'] === 'turn.completed') {
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
    } else if (p['type'] === 'turn.failed' || p['type'] === 'error') {
      const detail = (
        (p['type'] === 'turn.failed'
          ? isRec(p['error'])
            ? str(p['error']['message'])
            : null
          : str(p['message'])) ?? String(p['type'])
      ).slice(0, DETAIL_MAX);
      failure = { kind: classifyFailure(detail, null), detail, reset_at: null };
    } else if (
      p['type'] === 'item.completed' &&
      isRec(p['item']) &&
      p['item']['type'] === 'error'
    ) {
      warnings.push(
        (str(p['item']['message']) ?? 'item error').slice(0, DETAIL_MAX),
      );
    }
  }
  const denials: PermissionDenial[] = [];
  for (const line of input.stderr.split('\n')) {
    const m = CODEX_REJECTED.exec(line);
    if (m !== null)
      denials.push({
        tool: 'exec_command',
        command: m[1] ?? null,
        source: 'codex_stderr',
      });
  }
  const usage: Usage =
    turns === 0 || incomplete
      ? { basis: 'unavailable' }
      : { basis: 'reported', tokens };
  return {
    usage,
    usage_source:
      usage.basis === 'reported' ? 'codex turn.completed.usage' : null,
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

export const codexAdapter: VendorAdapter = {
  vendor: 'codex',
  resume_supported: false,
  plan,
  read,
};
