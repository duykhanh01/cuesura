/**
 * Vendor stream summary for the spike harness (T007): usage, permission denials, rate-limit state and
 * failure class read from the runner's events.jsonl records and stderr. The runner stays
 * vendor-agnostic; this is the only place that knows Claude stream-json / Codex exec --json shapes.
 *
 * Shapes are taken from the real 2026-10-28 captures (Claude Code 2.1.306, codex-cli 0.165.0).
 * Failure shapes never observed live (rate limit rejected, auth, refusal, turn.failed) are covered
 * by synthetic fixtures only and must not be reported as proven.
 */
export type StreamVendor = 'claude' | 'codex' | 'fixture';

export type StreamUsage =
  | {
      readonly status: 'reported';
      readonly source: string;
      readonly input_tokens: number;
      readonly cached_input_tokens: number;
      readonly cache_write_input_tokens: number;
      readonly output_tokens: number;
      readonly cost_usd: number | null;
    }
  | { readonly status: 'unavailable'; readonly reason: string };

export type PermissionDenial = {
  readonly tool: string;
  readonly command: string | null;
  readonly source: 'claude_event' | 'claude_result' | 'codex_stderr';
};

export type FailureKind = 'rate_limited' | 'auth' | 'refusal' | 'vendor_error';

export type StreamSummary = {
  readonly usage: StreamUsage;
  readonly permission_denials: readonly PermissionDenial[];
  readonly rate_limit: {
    readonly status: string;
    readonly type: string | null;
    readonly resets_at: number | null;
  } | null;
  readonly failure: {
    readonly kind: FailureKind;
    readonly detail: string;
  } | null;
  readonly warnings: readonly string[];
  readonly truncated_records: number;
};

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function validUsage(v: unknown, optional: readonly string[]): v is Rec {
  if (!isRec(v)) return false;
  const counter = (n: unknown): boolean =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  return (
    counter(v['input_tokens']) &&
    counter(v['output_tokens']) &&
    optional.every((k) => v[k] === undefined || counter(v[k]))
  );
}

/** Parses runner events.jsonl text into vendor payloads; truncated records are counted, not parsed. */
export function streamPayloads(eventsText: string): {
  payloads: Rec[];
  truncated: number;
} {
  const payloads: Rec[] = [];
  let truncated = 0;
  for (const line of eventsText.split('\n')) {
    if (line.trim() === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      truncated++;
      continue;
    }
    if (!isRec(rec) || rec['truncated'] === true) {
      truncated++;
      continue;
    }
    if (isRec(rec['data'])) payloads.push(rec['data']);
  }
  return { payloads, truncated };
}

function classify(detail: string, status: number | null): FailureKind {
  if (status === 429 || /\b429\b|rate.?limit|too many requests/i.test(detail))
    return 'rate_limited';
  if (
    status === 401 ||
    status === 403 ||
    /\b40[13]\b|unauthori[sz]ed|forbidden|not logged in|invalid api key/i.test(
      detail,
    )
  )
    return 'auth';
  return 'vendor_error';
}

function summarizeClaude(
  payloads: readonly Rec[],
): Omit<StreamSummary, 'truncated_records'> {
  const denials: PermissionDenial[] = [];
  const seen = new Set<string>();
  let rateLimit: StreamSummary['rate_limit'] = null;
  let failure: StreamSummary['failure'] = null;
  let usage: StreamUsage = {
    status: 'unavailable',
    reason: 'no result record',
  };
  for (const p of payloads) {
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
      const status = str(info['status']) ?? 'unknown';
      rateLimit = {
        status,
        type: str(info['rateLimitType']),
        resets_at:
          typeof info['resetsAt'] === 'number' ? info['resetsAt'] : null,
      };
      if (status === 'rejected')
        failure = {
          kind: 'rate_limited',
          detail: `rate_limit_event ${rateLimit.type ?? 'unknown'} rejected`,
        };
    } else if (
      p['type'] === 'assistant' &&
      isRec(p['message']) &&
      p['message']['stop_reason'] === 'refusal'
    ) {
      failure = { kind: 'refusal', detail: 'assistant stop_reason refusal' };
    } else if (p['type'] === 'result') {
      const u = validUsage(p['usage'], [
        'cache_read_input_tokens',
        'cache_creation_input_tokens',
      ])
        ? p['usage']
        : null;
      usage =
        u === null
          ? {
              status: 'unavailable',
              reason: 'result usage missing or malformed',
            }
          : {
              status: 'reported',
              source: 'claude result.usage',
              input_tokens: num(u['input_tokens']),
              cached_input_tokens: num(u['cache_read_input_tokens']),
              cache_write_input_tokens: num(u['cache_creation_input_tokens']),
              output_tokens: num(u['output_tokens']),
              cost_usd:
                typeof p['total_cost_usd'] === 'number'
                  ? p['total_cost_usd']
                  : null,
            };
      if (Array.isArray(p['permission_denials'])) {
        for (const d of p['permission_denials']) {
          if (
            !isRec(d) ||
            (str(d['tool_use_id']) !== null &&
              seen.has(str(d['tool_use_id']) as string))
          )
            continue;
          const input = isRec(d['tool_input']) ? d['tool_input'] : {};
          denials.push({
            tool: str(d['tool_name']) ?? 'unknown',
            command: str(input['command']) ?? str(input['file_path']),
            source: 'claude_result',
          });
        }
      }
      if (p['stop_reason'] === 'refusal' || num(p['safety_stops']) > 0)
        failure = {
          kind: 'refusal',
          detail: `result stop_reason ${String(p['stop_reason'])}, safety_stops ${num(p['safety_stops'])}`,
        };
      else if (p['is_error'] === true) {
        const status =
          typeof p['api_error_status'] === 'number'
            ? p['api_error_status']
            : null;
        const detail =
          `${String(p['subtype'])}: ${str(p['result']) ?? ''}`.slice(0, 500);
        failure = { kind: classify(detail, status), detail };
      }
    }
  }
  return {
    usage,
    permission_denials: denials,
    rate_limit: rateLimit,
    failure,
    warnings: [],
  };
}

// codex_core::tools::router logs the refused exec on stderr; exec --json has no event for it.
const CODEX_REJECTED =
  /codex_core::tools::router: .*Rejected\(\\?"`(.*)` rejected: ([^\\"]*)/;

function summarizeCodex(
  payloads: readonly Rec[],
  stderr: string,
): Omit<StreamSummary, 'truncated_records'> {
  const warnings: string[] = [];
  let failure: StreamSummary['failure'] = null;
  let incompleteUsage = false;
  const totals = { input: 0, cached: 0, write: 0, output: 0, turns: 0 };
  for (const p of payloads) {
    if (p['type'] === 'turn.completed') {
      if (
        !validUsage(p['usage'], [
          'cached_input_tokens',
          'cache_write_input_tokens',
        ])
      ) {
        incompleteUsage = true;
        continue;
      }
      const u = p['usage'];
      totals.input += num(u['input_tokens']);
      totals.cached += num(u['cached_input_tokens']);
      totals.write += num(u['cache_write_input_tokens']);
      totals.output += num(u['output_tokens']);
      totals.turns++;
    } else if (p['type'] === 'turn.failed') {
      const detail =
        (isRec(p['error']) ? str(p['error']['message']) : null) ??
        'turn.failed';
      failure = { kind: classify(detail, null), detail: detail.slice(0, 500) };
    } else if (p['type'] === 'error') {
      const detail = str(p['message']) ?? 'error';
      failure = { kind: classify(detail, null), detail: detail.slice(0, 500) };
    } else if (
      p['type'] === 'item.completed' &&
      isRec(p['item']) &&
      p['item']['type'] === 'error'
    ) {
      warnings.push((str(p['item']['message']) ?? 'item error').slice(0, 500));
    }
  }
  const denials: PermissionDenial[] = [];
  for (const line of stderr.split('\n')) {
    const m = CODEX_REJECTED.exec(line);
    if (m !== null)
      denials.push({
        tool: 'exec_command',
        command: m[1] ?? null,
        source: 'codex_stderr',
      });
  }
  const usage: StreamUsage =
    totals.turns === 0 || incompleteUsage
      ? {
          status: 'unavailable',
          reason: 'turn.completed usage missing or malformed',
        }
      : {
          status: 'reported',
          source: 'codex turn.completed.usage',
          input_tokens: totals.input,
          cached_input_tokens: totals.cached,
          cache_write_input_tokens: totals.write,
          output_tokens: totals.output,
          cost_usd: null,
        };
  return {
    usage,
    permission_denials: denials,
    rate_limit: null,
    failure,
    warnings,
  };
}

export function summarizeStream(
  vendor: StreamVendor,
  eventsText: string,
  stderr: string,
): StreamSummary {
  const { payloads, truncated } = streamPayloads(eventsText);
  if (vendor === 'fixture') {
    return {
      usage: {
        status: 'unavailable',
        reason: 'fixture vendor reports no usage',
      },
      permission_denials: [],
      rate_limit: null,
      failure: null,
      warnings: [],
      truncated_records: truncated,
    };
  }
  const s =
    vendor === 'claude'
      ? summarizeClaude(payloads)
      : summarizeCodex(payloads, stderr);
  return { ...s, truncated_records: truncated };
}
