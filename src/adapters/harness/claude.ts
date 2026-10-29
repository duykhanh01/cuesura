/**
 * Claude Code adapter (T068, FR-011/012/033). Argv and settings follow the pinned 2.1.306 shape the
 * T007 fixtures proved (`pinned-claude.json`): print mode with stream-json, the role schema inline
 * (without the `$schema` declaration that version refuses), user/project setting sources and MCP
 * servers disabled, a read-only settings file the runner writes, and the reviewer without Edit/Write.
 * The permission mode and rules come unchanged from the pin; the only switch is `sandbox.enabled`,
 * set from the inner mode the capability manifest selected. Nothing here names a model.
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
  classifyFailure,
  DETAIL_MAX,
  isRec,
  str,
  validCounters,
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
const EMPTY_MCP = '{"mcpServers":{}}';
/** Permission modes that approve on the user's behalf; never produced or accepted. */
const APPROVING_MODES = new Set(['bypassPermissions', 'acceptEdits', 'auto']);

function settingsFor(
  pin: VendorPin,
  input: VendorPlanInput,
): { ok: true; value: Rec } | { ok: false; message: string } {
  const base = pin.settings;
  if (base === null)
    return { ok: false, message: 'claude pin has no settings document' };
  const permissions = base['permissions'];
  if (!isRec(permissions))
    return { ok: false, message: 'claude settings have no permissions' };
  const mode = permissions['defaultMode'];
  if (typeof mode !== 'string' || APPROVING_MODES.has(mode))
    return {
      ok: false,
      message: `claude permission mode ${String(mode)} is not allowed`,
    };
  const sandbox = isRec(base['sandbox']) ? base['sandbox'] : {};
  if (sandbox['allowUnsandboxedCommands'] !== false)
    return {
      ok: false,
      message:
        'claude settings must set sandbox.allowUnsandboxedCommands=false',
    };
  const native = input.inner_mode === 'native';
  return {
    ok: true,
    value: {
      ...base,
      sandbox: {
        ...sandbox,
        enabled: native,
        failIfUnavailable: native,
        allowUnsandboxedCommands: false,
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
  if (pin.max_turns === null || pin.tools === null || pin.tools.length === 0)
    return fail('claude pin needs max_turns and tools');
  if (input.model === '') return fail('model is not configured');
  const settings = settingsFor(pin, input);
  if (!settings.ok) return fail(settings.message);
  const settingsFile = `${input.paths.context}/${CLAUDE_SETTINGS_FILE}`;
  const argv = [
    pin.binary.realpath,
    '-p',
    '--verbose',
    '--max-turns',
    String(pin.max_turns),
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
    ...(input.session === null
      ? ['--no-session-persistence']
      : ['--resume', input.session.ref]),
    '--setting-sources',
    '',
    '--safe-mode',
    '--strict-mcp-config',
    '--mcp-config',
    EMPTY_MCP,
    ...(input.role === 'reviewer'
      ? ['--disallowedTools', REVIEWER_DISALLOWED]
      : []),
  ];
  const bypass = bypassToken([argv, settings.value, pin.env]);
  if (bypass !== null)
    return fail(`permission bypass token rejected: ${bypass}`);
  if (input.schema.schema['$schema'] !== undefined)
    return fail(
      'claude 2.1.306 needs the schema without its $schema declaration',
    );
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
      settings_hash: hashCanonical(settings.value),
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
      ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
        ? { cost }
        : {}),
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
  for (const p of records) {
    session = str(p['session_id']) ?? session;
    if (p['type'] === 'system' && p['subtype'] === 'init')
      model = str(p['model']) ?? model;
    if (p['type'] === 'system' && p['subtype'] === 'permission_denied') {
      const id = str(p['tool_use_id']);
      if (id !== null) seen.add(id);
      denials.push({
        tool: str(p['tool_name']) ?? 'unknown',
        command: str(p['message']),
        source: 'claude_event',
      });
    } else if (
      p['type'] === 'rate_limit_event' &&
      isRec(p['rate_limit_info'])
    ) {
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
      if (
        p['stop_reason'] === 'refusal' ||
        (typeof stops === 'number' && stops > 0)
      )
        failure = {
          kind: 'refusal',
          detail: `result stop_reason ${String(p['stop_reason'])}, safety_stops ${typeof stops === 'number' ? stops : 0}`,
          reset_at: null,
        };
      else if (p['is_error'] === true) {
        const status =
          typeof p['api_error_status'] === 'number'
            ? p['api_error_status']
            : null;
        const detail =
          `${String(p['subtype'])}: ${str(p['result']) ?? ''}`.slice(
            0,
            DETAIL_MAX,
          );
        const kind = classifyFailure(detail, status);
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

export const claudeAdapter: VendorAdapter = {
  vendor: 'claude',
  resume_supported: true,
  plan,
  read,
};
