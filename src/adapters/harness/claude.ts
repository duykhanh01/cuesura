/**
 * Claude Code adapter (T068, FR-011/012/033). Argv and settings follow the pinned 2.1.306 shape the
 * T007 fixtures proved (`pinned-claude.json`): print mode with stream-json, the role schema inline
 * (without the `$schema` declaration that version refuses), user/project setting sources and MCP
 * servers disabled, a read-only settings file the runner writes, and the reviewer without Edit/Write.
 * Production derives auto/full-access permissions from the pin and keeps reviewer writes denied.
 * Archived outer-sandbox plans retain their recorded permission mode. Nothing here names a model.
 *
 * Facts are read from stream-json records: `system/permission_denied` events and the result record's
 * `permission_denials`, `rate_limit_event`, refusal stop reasons, `result.usage`/`total_cost_usd`, the
 * session id and the reported model. The final answer is the last record's `structured_output`.
 */
import { hashCanonical } from '../../shared/hash.ts';
import type { EpochMs } from '../../shared/brand.ts';
import type { Usage } from '../../domain/trigger.ts';
import type { PermissionDenial } from '../ports.ts';
import {
  bypassToken,
  hostInnerMode,
  nativeSandboxEnabled,
  classifyFailure,
  DETAIL_MAX,
  isRec,
  osDeniedWrite,
  str,
  validCounters,
  type NativeWriteCheck,
  type PlanResult,
  type Rec,
  type StreamFinal,
  type VendorAdapter,
  type VendorFacts,
  type VendorPin,
  type VendorPlanInput,
  type VendorRead,
} from './vendor.ts';

export const CLAUDE_SETTINGS_FILE = 'claude-settings.json';
export const CLAUDE_RESULT_POINTER = ['structured_output'] as const;
const REVIEWER_DISALLOWED = 'Edit,Write';
/** Auto-approving modes rejected by the archived outer-sandbox contract. */
const APPROVING_MODES = new Set(['bypassPermissions', 'acceptEdits', 'auto']);

function settingsFor(
  pin: VendorPin,
  input: VendorPlanInput,
): { ok: true; value: Rec } | { ok: false; message: string } {
  const base = pin.settings;
  if (base === null) return { ok: false, message: 'claude pin has no settings document' };
  const permissions = base['permissions'];
  if (!isRec(permissions)) return { ok: false, message: 'claude settings have no permissions' };
  const mode = input.host_execution
    ? pin.permission_mode === 'full-access' && input.role !== 'reviewer'
      ? 'bypassPermissions'
      : 'auto'
    : permissions['defaultMode'];
  if (typeof mode !== 'string' || (!input.host_execution && APPROVING_MODES.has(mode)))
    return {
      ok: false,
      message: `claude permission mode ${String(mode)} is not allowed`,
    };
  const sandbox = isRec(base['sandbox']) ? base['sandbox'] : {};
  if (!input.host_execution && sandbox['allowUnsandboxedCommands'] !== false)
    return {
      ok: false,
      message: 'claude settings must set sandbox.allowUnsandboxedCommands=false',
    };
  if (
    input.host_execution &&
    sandbox['enabled'] !== undefined &&
    typeof sandbox['enabled'] !== 'boolean'
  )
    return { ok: false, message: 'sandbox.enabled must be a boolean' };
  const filesystem = isRec(sandbox['filesystem']) ? sandbox['filesystem'] : {};
  const network = isRec(sandbox['network']) ? sandbox['network'] : {};
  const allowWrite: unknown = filesystem['allowWrite'] ?? [];
  const denyWrite: unknown = filesystem['denyWrite'] ?? [];
  if (
    !Array.isArray(allowWrite) ||
    !allowWrite.every((p: unknown) => typeof p === 'string') ||
    !Array.isArray(denyWrite) ||
    !denyWrite.every((p: unknown) => typeof p === 'string')
  )
    return {
      ok: false,
      message: 'native filesystem rules must be arrays of paths',
    };
  const hostPath = (path: string): string => {
    const entry = Object.entries(input.paths).find(
      ([name]) => path === `/cusr/${name}` || path.startsWith(`/cusr/${name}/`),
    );
    return entry === undefined ? path : entry[1] + path.slice(`/cusr/${entry[0]}`.length);
  };
  const mappedAllowWrite = allowWrite.map((path: unknown) => hostPath(String(path)));
  const mappedDenyWrite = denyWrite.map((path: unknown) => hostPath(String(path)));
  const native = input.host_execution
    ? nativeSandboxEnabled(pin, input.role)
    : input.inner_mode === 'native';
  if (input.host_execution && input.inner_mode === 'external_verified')
    return {
      ok: false,
      message: 'external_verified needs the removed outer sandbox',
    };
  return {
    ok: true,
    value: {
      ...base,
      ...(input.host_execution ? { permissions: { ...permissions, defaultMode: mode } } : {}),
      sandbox: {
        ...sandbox,
        enabled: native,
        failIfUnavailable: native,
        allowUnsandboxedCommands: false,
        ...(input.host_execution && native
          ? {
              // On Linux the sandbox blocks socket(AF_UNIX) unless this is set, which breaks tests that
              // start a daemon on a Unix socket. The settings document can still turn it off.
              network: {
                ...network,
                allowAllUnixSockets: network['allowAllUnixSockets'] ?? true,
              },
              filesystem: {
                ...filesystem,
                allowWrite: [
                  ...new Set([
                    ...mappedAllowWrite,
                    input.paths.home,
                    input.paths.scratch,
                    ...(input.paths.tmp === undefined ? [] : [input.paths.tmp]),
                  ]),
                ],
                denyWrite: [...mappedDenyWrite, ...(input.role === 'reviewer' ? [input.cwd] : [])],
              },
            }
          : {}),
      },
    },
  };
}

function plan(pin: VendorPin, input: VendorPlanInput): PlanResult {
  const fail = (message: string): PlanResult => ({
    ok: false,
    error: { code: 'policy_violation', message },
  });
  if (pin.vendor !== 'claude') return fail(`pin is for ${pin.vendor}`);
  if (input.host_execution && input.inner_mode !== hostInnerMode(pin))
    return fail('host permission mode must match the explicit pin');
  if (pin.tools === null || pin.tools.length === 0) return fail('claude pin needs tools');
  if (input.model === '') return fail('model is not configured');
  const settings = settingsFor(pin, input);
  if (!settings.ok) return fail(settings.message);
  const settingsFile = `${input.paths.context}/${CLAUDE_SETTINGS_FILE}`;
  const stableSettings = input.host_execution
    ? settingsFor(pin, {
        ...input,
        role: 'coder',
        cwd: '<worktree>',
        paths: {
          home: '<home>',
          scratch: '<scratch>',
          context: '<context>',
          schema: '<schema>',
          tmp: '<tmp>',
        },
      })
    : settings;
  if (!stableSettings.ok) return fail(stableSettings.message);
  const caps = [input.max_turns, pin.max_turns].filter((v): v is number => typeof v === 'number');
  const maxTurns = caps.length === 0 ? null : Math.min(...caps);
  const argv = [
    pin.binary.realpath,
    '-p',
    '--verbose',
    ...(maxTurns === null ? [] : ['--max-turns', String(maxTurns)]),
    '--tools',
    pin.tools.join(','),
    '--output-format',
    'stream-json',
    '--json-schema',
    JSON.stringify(input.schema.schema),
    '--model',
    input.model,
    ...(input.effort === null ? [] : ['--effort', input.effort]),
    '--settings',
    settingsFile,
    ...(input.session === null ? [] : ['--resume', input.session.ref]),
    ...(input.role === 'reviewer' ? ['--disallowedTools', REVIEWER_DISALLOWED] : []),
  ];
  const bypass = bypassToken(
    input.host_execution && pin.permission_mode === 'full-access'
      ? [pin.env]
      : [argv, settings.value, pin.env],
  );
  if (bypass !== null) return fail(`permission bypass token rejected: ${bypass}`);
  if (input.schema.schema['$schema'] !== undefined)
    return fail('claude 2.1.306 needs the schema without its $schema declaration');
  return {
    ok: true,
    value: {
      vendor: 'claude',
      argv,
      stdin: 'prompt',
      context_files: [
        {
          name: CLAUDE_SETTINGS_FILE,
          content: `${JSON.stringify(settings.value, null, 2)}\n`,
        },
      ],
      schema_files: [],
      result: { kind: 'stdout_json', pointer: CLAUDE_RESULT_POINTER },
      settings_hash: hashCanonical(stableSettings.value),
    },
  };
}

function readUsage(p: Rec): { usage: Usage; source: string | null } {
  const u = p['usage'];
  if (
    !validCounters(
      u,
      ['input_tokens', 'output_tokens'],
      ['cache_read_input_tokens', 'cache_creation_input_tokens'],
    )
  )
    return { usage: { basis: 'unavailable' }, source: null };
  // input_tokens excludes cache reads/writes in this stream, so every counter is added.
  const tokens =
    (u['input_tokens'] as number) +
    ((u['cache_read_input_tokens'] as number | undefined) ?? 0) +
    ((u['cache_creation_input_tokens'] as number | undefined) ?? 0) +
    (u['output_tokens'] as number);
  const cost = p['total_cost_usd'];
  return {
    usage: {
      basis: 'reported',
      tokens,
      ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { cost } : {}),
    },
    source: 'claude result.usage',
  };
}

function finalOf(last: unknown): StreamFinal {
  if (!isRec(last) || last['type'] !== 'result')
    return { kind: 'missing', reason: 'last record is not a complete result' };
  let v: unknown = last;
  for (const k of CLAUDE_RESULT_POINTER) v = isRec(v) ? v[k] : undefined;
  if (v === undefined || v === null)
    return { kind: 'missing', reason: 'result has no structured_output' };
  return { kind: 'found', raw: JSON.stringify(v), value: v };
}

function read(input: VendorRead): VendorFacts {
  const denials: PermissionDenial[] = [];
  const seen = new Set<string>();
  let failure: VendorFacts['failure'] = null;
  let usage: Usage = { basis: 'unavailable' };
  let usageSource: string | null = null;
  let session: string | null = null;
  let model: string | null = null;
  let resetAt: EpochMs | null = null;
  const records = input.stdout.filter(isRec);
  /** What each tool call asked for; a refusal event only carries a sentence and the call's ID. */
  const requested = new Map<string, string>();
  for (const p of records) {
    session = str(p['session_id']) ?? session;
    if (p['type'] === 'assistant')
      for (const block of contentBlocks(p)) {
        const id = str(block['id']);
        const toolInput = block['input'];
        if (block['type'] === 'tool_use' && id !== null && isRec(toolInput)) {
          const asked = str(toolInput['command']) ?? str(toolInput['file_path']);
          if (asked !== null) requested.set(id, asked);
        }
      }
    if (p['type'] === 'system' && p['subtype'] === 'init') model = str(p['model']) ?? model;
    if (p['type'] === 'system' && p['subtype'] === 'permission_denied') {
      const id = str(p['tool_use_id']);
      if (id !== null) seen.add(id);
      const message = str(p['message']);
      denials.push({
        tool: str(p['tool_name']) ?? 'unknown',
        command: id === null ? null : (requested.get(id) ?? null),
        ...(message === null ? {} : { message }),
        source: 'claude_event',
      });
    } else if (p['type'] === 'rate_limit_event' && isRec(p['rate_limit_info'])) {
      const info = p['rate_limit_info'];
      const resets = info['resetsAt'];
      if (typeof resets === 'number' && Number.isFinite(resets))
        resetAt = (resets * 1000) as EpochMs;
      if (info['status'] === 'rejected')
        failure = {
          kind: 'rate_limited',
          detail: `rate_limit_event ${str(info['rateLimitType']) ?? 'unknown'} rejected`,
          reset_at: resetAt,
        };
    } else if (
      p['type'] === 'assistant' &&
      isRec(p['message']) &&
      p['message']['stop_reason'] === 'refusal'
    ) {
      failure = {
        kind: 'refusal',
        detail: 'assistant stop_reason refusal',
        reset_at: null,
      };
    } else if (p['type'] === 'result') {
      const u = readUsage(p);
      usage = u.usage;
      usageSource = u.source;
      if (Array.isArray(p['permission_denials'])) {
        for (const d of p['permission_denials']) {
          const id = isRec(d) ? str(d['tool_use_id']) : null;
          if (!isRec(d) || (id !== null && seen.has(id))) continue;
          const ti = isRec(d['tool_input']) ? d['tool_input'] : {};
          denials.push({
            tool: str(d['tool_name']) ?? 'unknown',
            command: str(ti['command']) ?? str(ti['file_path']),
            source: 'claude_result',
          });
        }
      }
      const stops = p['safety_stops'];
      if (p['stop_reason'] === 'refusal' || (typeof stops === 'number' && stops > 0))
        failure = {
          kind: 'refusal',
          detail: `result stop_reason ${String(p['stop_reason'])}, safety_stops ${typeof stops === 'number' ? stops : 0}`,
          reset_at: null,
        };
      else if (p['is_error'] === true) {
        const status = typeof p['api_error_status'] === 'number' ? p['api_error_status'] : null;
        const detail = `${String(p['subtype'])}: ${str(p['result']) ?? ''}`.slice(0, DETAIL_MAX);
        const kind =
          p['subtype'] === 'error_max_turns' ? 'turn_limit' : classifyFailure(detail, status);
        failure = {
          kind,
          detail,
          reset_at: kind === 'rate_limited' ? resetAt : null,
        };
      }
    }
  }
  return {
    usage,
    usage_source: usageSource,
    permission_denials: denials,
    failure,
    session_ref: session,
    reported_model: model,
    final:
      failure === null
        ? finalOf(input.stdout.at(-1))
        : { kind: 'missing', reason: `vendor failure ${failure.kind}` },
    warnings: [],
    truncated_records: input.truncated_records,
  };
}

function contentBlocks(record: Record<string, unknown>): Record<string, unknown>[] {
  const message = record['message'];
  const content = isRec(message) ? message['content'] : undefined;
  return Array.isArray(content) ? content.filter(isRec) : [];
}

/** A sandbox refusal is a failed Bash result for the call that named the marker. */
function nativeWriteDenied(check: NativeWriteCheck): boolean {
  const calls = new Set<string>();
  for (const event of check.stdout) {
    if (!isRec(event)) continue;
    for (const block of contentBlocks(event)) {
      const input = block['input'];
      if (
        event['type'] === 'assistant' &&
        block['type'] === 'tool_use' &&
        block['name'] === 'Bash' &&
        typeof block['id'] === 'string' &&
        isRec(input) &&
        typeof input['command'] === 'string' &&
        input['command'].includes(check.marker)
      )
        calls.add(block['id']);
      if (
        event['type'] === 'user' &&
        block['type'] === 'tool_result' &&
        typeof block['tool_use_id'] === 'string' &&
        calls.has(block['tool_use_id']) &&
        block['is_error'] === true &&
        osDeniedWrite(block['content'], check.marker)
      )
        return true;
    }
  }
  return false;
}

export const claudeAdapter: VendorAdapter = {
  vendor: 'claude',
  resume_supported: true,
  // The sandbox makes its bridge sockets directly under os.tmpdir(), and a socket path holds 108 bytes.
  needs_short_tmpdir: true,
  worktree_state: ['.claude/.cc-writes'],
  git_dir_state: ['branches', 'remotes', 'config.worktree', 'info/.claude-sandbox-noreplace'],
  nativeWriteDenied,
  plan,
  read,
};
