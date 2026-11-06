/**
 * A log record in words. Harnesses write their own event streams (Claude's stream-json, Codex's JSON events),
 * which read as noise to a person; this turns the kinds a person cares about into one labelled line and drops
 * bookkeeping that says nothing (token counters, redraw hints, a rate limit that still allows). Anything it
 * does not know reads as one line naming its type, and keeps its compact JSON for the full-output view, so
 * no record a person might need disappears and none fills the log with JSON.
 */

export type Tone = 'say' | 'tool' | 'result' | 'ok' | 'error' | 'warn' | 'info';

export type Described = {
  /** At most `LABEL_WIDTH` cells: who or what, such as `Agent`, `Bash`, `Done`. */
  readonly label: string;
  readonly body: string;
  readonly tone: Tone;
  /** Replaces `body` in the full-output view. */
  readonly full?: string;
};

export const LABEL_WIDTH = 7;

type Obj = Readonly<Record<string, unknown>>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function oneLine(text: string, max = 400): string {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const first = (lines[0] ?? '').trim();
  const cut = first.length > max ? `${first.slice(0, max)}…` : first;
  const more = lines.length - 1;
  return more > 0 ? `${cut}  (+${more} ${more === 1 ? 'line' : 'lines'})` : cut;
}

/** An output without the blank lines around it. How much of it shows is for the screen to say. */
function trimmed(text: string): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  while (lines.length > 0 && (lines[0] ?? '').trim() === '') lines.shift();
  return lines.join('\n');
}

function compact(v: unknown): string {
  return JSON.stringify(v) ?? String(v);
}

function seconds(ms: unknown): string | null {
  return typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : null;
}

/** What a tool call is about, by the inputs that name it; the whole input only when none does. */
function toolTarget(name: string, input: unknown): string {
  if (!isObj(input)) return '';
  for (const key of [
    'command',
    'file_path',
    'path',
    'pattern',
    'url',
    'query',
    'description',
    'prompt',
  ]) {
    const v = str(input[key]);
    if (v !== null) return oneLine(v, 300);
  }
  return name === 'StructuredOutput' ? 'final answer' : oneLine(compact(input), 200);
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map((c) => (isObj(c) ? (str(c['text']) ?? '') : '')).join('\n');
  return compact(content);
}

/** Tool names as short labels; others are cut to the label's width. */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  StructuredOutput: 'Answer',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit',
  TodoWrite: 'Todo',
  WebFetch: 'Fetch',
  WebSearch: 'Search',
};

function toolLabel(name: string): string {
  return (Object.hasOwn(TOOL_LABELS, name) ? (TOOL_LABELS[name] ?? name) : name).slice(
    0,
    LABEL_WIDTH,
  );
}

/** A worker's final answer is JSON with a summary; that summary is what a person wants to read. */
function summaryOf(result: string): string {
  try {
    const parsed: unknown = JSON.parse(result);
    if (isObj(parsed)) {
      const summary = str(parsed['summary']);
      if (summary !== null) return summary;
    }
  } catch {
    // Not JSON: the text is the answer.
  }
  return result;
}

/**
 * System records that only count or redraw. A denial is here too: it comes back as the tool's error result,
 * which is where it is shown.
 */
const HIDDEN_SYSTEM: ReadonlySet<string> = new Set([
  'thinking_tokens',
  'permission_check_status',
  'permission_denied',
  'ui_invalidate',
  // The tool call that started it is already shown, and its end has a line of its own.
  'task_started',
  'task_progress',
]);

/** What a record calls itself, for a line that stands in for its JSON. */
function typeName(value: unknown): string {
  if (!isObj(value)) return compact(value);
  return str(value['subtype']) ?? str(value['type']) ?? 'record';
}

/** A piece this does not know: its type on the line, all of it in the full-output view. */
function unknown(label: string, value: unknown): Described {
  return {
    label: label.slice(0, LABEL_WIDTH),
    body: oneLine(typeName(value), 120),
    tone: 'info',
    full: compact(value),
  };
}

function claude(d: Obj): Described[] | null {
  const type = str(d['type']);
  switch (type) {
    case 'system': {
      const sub = str(d['subtype']);
      if (sub === 'init') {
        const model = str(d['model']);
        return [
          {
            label: 'Start',
            body: `Session started${model === null ? '' : ` · ${model}`}`,
            tone: 'info',
          },
        ];
      }
      if (sub === 'task_notification') {
        const summary = str(d['summary']);
        if (summary === null) return null;
        const status = str(d['status']);
        return [
          {
            label: 'Task',
            body: status === null ? summary : `${summary} (${status})`,
            tone: 'info',
          },
        ];
      }
      // Only bookkeeping known to say nothing is left out; another subtype shows as it came.
      return sub !== null && HIDDEN_SYSTEM.has(sub) ? [] : [unknown('System', d)];
    }
    // A heartbeat every 30 seconds while a tool runs: the tool's result says how it went.
    case 'tool_progress':
      return [];
    case 'rate_limit_event': {
      const info = isObj(d['rate_limit_info']) ? d['rate_limit_info'] : {};
      const status = str(info['status']);
      if (status === 'allowed') return [];
      if (status === null) return null;
      return [{ label: 'Limit', body: `Rate limited (${status})`, tone: 'warn' }];
    }
    case 'assistant':
    case 'user': {
      const message = isObj(d['message']) ? d['message'] : {};
      const content = Array.isArray(message['content']) ? message['content'] : [];
      const user = type === 'user';
      return content.flatMap((c): Described[] => {
        if (!isObj(c)) return [unknown('content', c)];
        switch (c['type']) {
          case 'text': {
            const text = str(c['text']) ?? '';
            if (text.trim() === '') return [];
            // What the session was told, not what the agent said: its first line is enough here.
            return user
              ? [{ label: 'Prompt', body: oneLine(text), tone: 'info' }]
              : [{ label: 'Agent', body: summaryOf(text.trim()), tone: 'say' }];
          }
          case 'redacted_thinking':
            return [];
          case 'thinking': {
            const text = str(c['thinking']) ?? '';
            return text.trim() === ''
              ? []
              : [{ label: 'Think', body: oneLine(text), tone: 'info' }];
          }
          case 'tool_use': {
            const name = str(c['name']) ?? 'Tool';
            return [
              {
                label: toolLabel(name),
                body: toolTarget(name, c['input']),
                tone: 'tool',
              },
            ];
          }
          case 'tool_result': {
            const text = trimmed(toolResultText(c['content']));
            if (c['is_error'] === true) return [{ label: 'Error', body: text, tone: 'error' }];
            return [
              {
                label: 'Result',
                body: text === '' ? '(no output)' : text,
                tone: 'result',
              },
            ];
          }
          default:
            return [unknown(str(c['type']) ?? 'content', c)];
        }
      });
    }
    case 'result': {
      const parts = [
        typeof d['num_turns'] === 'number' ? `${d['num_turns']} turns` : null,
        seconds(d['duration_ms']),
        typeof d['total_cost_usd'] === 'number' ? `$${d['total_cost_usd'].toFixed(2)}` : null,
      ].filter((p) => p !== null);
      const failed = d['is_error'] === true;
      const out: Described[] = [
        {
          label: failed ? 'Failed' : 'Done',
          body: parts.join(' · ') || (str(d['subtype']) ?? ''),
          tone: failed ? 'error' : 'ok',
        },
      ];
      const result = str(d['result']);
      if (result !== null && result.trim() !== '')
        out.push({ label: 'Summary', body: summaryOf(result), tone: 'say' });
      return out;
    }
    default:
      return null;
  }
}

function codexItem(item: Obj, done: boolean): Described[] {
  switch (item['type']) {
    case 'agent_message': {
      const text = str(item['text']) ?? '';
      return done && text.trim() !== ''
        ? [{ label: 'Agent', body: summaryOf(text.trim()), tone: 'say' }]
        : [];
    }
    case 'reasoning': {
      const text = str(item['text']) ?? '';
      return done && text.trim() !== ''
        ? [{ label: 'Think', body: oneLine(text), tone: 'info' }]
        : [];
    }
    case 'command_execution': {
      const command = oneLine(str(item['command']) ?? '', 300);
      if (!done) return [{ label: 'Shell', body: command, tone: 'tool' }];
      const code = item['exit_code'];
      const output = trimmed(str(item['aggregated_output']) ?? '');
      const failed = typeof code === 'number' && code !== 0;
      const body = failed
        ? `Exit ${code}${output === '' ? '' : `\n${output}`}`
        : output === ''
          ? '(no output)'
          : output;
      return [
        {
          label: failed ? 'Error' : 'Result',
          body,
          tone: failed ? 'error' : 'result',
        },
      ];
    }
    case 'file_change': {
      if (!done) return [];
      const changes = Array.isArray(item['changes']) ? item['changes'] : [];
      const paths = changes
        .map((c) => (isObj(c) ? str(c['path']) : null))
        .filter((p) => p !== null);
      return [
        {
          label: 'Edit',
          body: paths.length === 0 ? 'files changed' : paths.join(', '),
          tone: 'tool',
        },
      ];
    }
    case 'error':
      return [
        {
          label: 'Error',
          body: str(item['message']) ?? compact(item),
          tone: 'error',
        },
      ];
    default: {
      if (!done) return [];
      return [unknown('Item', item)];
    }
  }
}

function codex(d: Obj): Described[] | null {
  const type = str(d['type']);
  switch (type) {
    case 'thread.started':
    case 'turn.started':
      return [];
    case 'item.started':
    case 'item.updated':
      return isObj(d['item']) && type === 'item.started' ? codexItem(d['item'], false) : [];
    case 'item.completed':
      return isObj(d['item']) ? codexItem(d['item'], true) : [];
    case 'turn.completed': {
      const usage = isObj(d['usage']) ? d['usage'] : {};
      const out = usage['output_tokens'];
      return [
        {
          label: 'Done',
          body: `Turn finished${typeof out === 'number' ? ` · ${out} output tokens` : ''}`,
          tone: 'ok',
        },
      ];
    }
    case 'turn.failed':
    case 'error': {
      const error = isObj(d['error']) ? d['error'] : d;
      return [
        {
          label: 'Error',
          body: str(error['message']) ?? compact(error),
          tone: 'error',
        },
      ];
    }
    default:
      return null;
  }
}

const isPlainText = (v: unknown): v is { readonly text: string } =>
  isObj(v) && Object.keys(v).length === 1 && typeof v['text'] === 'string';

/** The lines a record reads as; empty for bookkeeping a person never needs to see. */
export function describeRecord(kind: string, given: unknown): Described[] {
  // The runner wraps a line of output that is not JSON this way; it is text, not a record.
  const data = isPlainText(given) ? given['text'] : given;
  if (typeof data === 'string')
    return data.trim() === ''
      ? []
      : [
          {
            // Plain output speaks for itself; only stderr is worth naming.
            label: kind === 'stderr' ? 'stderr' : '',
            body: data.replace(/\n+$/, ''),
            tone: kind === 'stderr' ? 'warn' : 'info',
          },
        ];
  if (isObj(data)) {
    const known = claude(data) ?? codex(data);
    if (known !== null) return known;
  }
  return [unknown(kind, data)];
}
