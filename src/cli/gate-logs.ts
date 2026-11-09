/**
 * `task gates` and `task gate-log`: one gate's output, read by bytes. Plain output goes to stdout as the
 * command wrote it, cleaned for a terminal; what was left out is said on stderr, so a pipe stays clean.
 */
import { ANSI, cleanLog, sanitize } from '../tui/terminal/safe-text.ts';
import { ExitCode, okEnvelope, type Envelope } from './output.ts';
import type { CliCommand, CliIo } from './program.ts';
import { DATA_DIR, badFlag, call, print } from './tasks.ts';

/** What a person reads without asking for more: where failures are reported is the end of a log. */
export const GATE_LOG_DEFAULT_BYTES = 64 * 1024;
/** A gate that passed has nothing to find at its end, so it shows less; its failures are elsewhere. */
export const GATE_LOG_PASSED_BYTES = 4 * 1024;
const PAGE_BYTES = 1024 * 1024;

type GateRow = {
  readonly gate: string;
  readonly passed: boolean;
  readonly log: string;
  readonly bytes?: number;
  readonly truncated?: boolean;
};
type Rounds = {
  readonly task_id: string;
  readonly rounds: readonly {
    readonly round: number;
    readonly step: string;
    readonly passed: boolean;
    readonly gates: readonly GateRow[];
  }[];
};

type LogPage = {
  readonly gate: string;
  readonly round: number;
  readonly passed?: boolean;
  readonly state: 'available' | 'expired' | 'missing';
  readonly text?: string;
  readonly offset?: number;
  readonly next_offset?: number;
  readonly size?: number;
  readonly complete?: boolean;
  readonly truncated?: boolean;
};

/**
 * A line end or colour code a page may have cut: it waits for the page that completes it. A CR before a
 * cut code waits too, or it would end a line on its own and the LF after the code would add another.
 */
const UNFINISHED = new RegExp(String.raw`(?:\r?\u001b(?:\[[0-9;?]*[ -/]*)?|\r)$`);

/** `cleanLog` over pages, which end at any byte. */
function pageCleaner(): { push(text: string): string; end(): string } {
  let held = '';
  return {
    push(text) {
      const all = (held + text).replace(ANSI, '');
      held = UNFINISHED.exec(all)?.[0] ?? '';
      return cleanLog(all.slice(0, all.length - held.length));
    },
    end: () => cleanLog(held),
  };
}

function kib(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

function renderRounds(data: unknown): string {
  const { rounds, task_id } = data as Rounds;
  if (rounds.length === 0) return 'No gates have run yet.\n';
  const lines = rounds.flatMap((r) => [
    `Round ${String(r.round)} · ${sanitize(r.step)} · ${r.passed ? 'passed' : 'failed'}`,
    ...r.gates.map((g) => {
      const size = g.bytes === undefined ? '' : ` ${kib(g.bytes)}`;
      const state = g.log === 'available' ? '' : ` (log ${g.log})`;
      return `  ${g.passed ? '✓' : '✕'} ${sanitize(g.gate)}${size}${g.truncated === true ? ' truncated' : ''}${state}`;
    }),
  ]);
  return `${lines.join('\n')}\nRead one: cusr task gate-log ${sanitize(task_id)} <gate>\n`;
}

export const gatesCommand: CliCommand = {
  name: 'task gates',
  description: 'List each round of gates and whether its logs can still be read',
  help: `Example:\n  cusr task gates 019a0000-0000-7000-8000-000000000001`,
  args: ['<id>'],
  options: [DATA_DIR],
  async run(values, json, io) {
    const envelope = await call(
      values,
      '/v1/query',
      { kind: 'task_gates', task_id: values['id'] },
      null,
    );
    return print(envelope, json, io, renderRounds);
  },
};

const STATE_NOTE: Readonly<Record<'expired' | 'missing', string>> = {
  expired: 'expired: retention removed it',
  missing: 'not recorded',
};

function count(raw: string | undefined, min: number): number | null | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(n) && n >= min ? n : null;
}

type Fetch = (
  values: Readonly<Record<string, string | undefined>>,
  body: Record<string, unknown>,
) => Promise<Envelope>;

async function readAll(
  fetch: Fetch,
  values: Readonly<Record<string, string | undefined>>,
  body: Record<string, unknown>,
  start: number,
  onPage: (page: LogPage) => void,
): Promise<Envelope> {
  let offset = start;
  let round: Record<string, unknown> = {};
  for (;;) {
    const envelope = await fetch(values, { ...body, ...round, offset, limit: PAGE_BYTES });
    if (!envelope.ok) return envelope;
    const page = envelope.data as LogPage;
    onPage(page);
    // Left to itself each read would take the latest round, and a new one can finish between pages.
    round = { round: page.round };
    if (page.state !== 'available' || page.complete === true) return envelope;
    // A page always moves on unless the log shrank under the read, which only retention does.
    if ((page.next_offset ?? offset) <= offset) return envelope;
    offset = page.next_offset ?? offset;
  }
}

function printState(page: LogPage, io: CliIo): number {
  const note = page.state === 'available' ? null : STATE_NOTE[page.state];
  if (note !== null) io.stdout(`Log of ${sanitize(page.gate)}: ${note}.\n`);
  return ExitCode.ok;
}

export function gateLogCommandWith(fetch: Fetch): CliCommand {
  return {
    name: 'task gate-log',
    description: "Show one gate's redacted output; bounded unless --full",
    help: `By default prints the end of the log, which is where failures are reported, and says on
stderr how much came before it; less of it for a gate that passed. The latest round that ran the gate is read unless --round says
otherwise; cusr task gates lists them.

Examples:
  cusr task gate-log 019a0000-0000-7000-8000-000000000001 unit
  cusr task gate-log 019a0000-0000-7000-8000-000000000001 unit --round 2 --full > unit.log`,
    args: ['<id>', '<gate>'],
    options: [
      DATA_DIR,
      { flags: '--round <n>', description: 'Round of gates, from 1 (default: the latest)' },
      { flags: '--full', description: 'Read the whole log' },
      {
        flags: '--offset <bytes>',
        description: 'Read forward from this byte instead of the end',
      },
      {
        flags: '--limit <bytes>',
        description: `Bytes to read, 1024 to ${String(PAGE_BYTES)} (default: ${String(GATE_LOG_DEFAULT_BYTES)}, ${String(GATE_LOG_PASSED_BYTES)} for a gate that passed)`,
      },
    ],
    async run(values, json, io) {
      const round = count(values['round'], 1);
      const offset = count(values['offset'], 0);
      const limit = count(values['limit'], 1024);
      if (round === null) return badFlag('--round must be a positive integer.', {}, json, io);
      if (offset === null) return badFlag('--offset must be a whole number.', {}, json, io);
      if (limit === null || (limit !== undefined && limit > PAGE_BYTES))
        return badFlag(`--limit must be between 1024 and ${String(PAGE_BYTES)}.`, {}, json, io);
      const full = values['full'] !== undefined;
      if (full && limit !== undefined)
        return badFlag('--full and --limit cannot be used together.', {}, json, io);

      const body = {
        kind: 'task_gate_log',
        task_id: values['id'],
        gate: values['gate'],
        ...(round === undefined ? {} : { round }),
      };

      if (full) {
        const parts: string[] = [];
        const cleaner = pageCleaner();
        let last: LogPage | null = null;
        const envelope = await readAll(fetch, values, body, offset ?? 0, (page) => {
          last = page;
          if (json) parts.push(page.text ?? '');
          else if (page.text !== undefined) io.stdout(cleaner.push(page.text));
        });
        if (!json) io.stdout(cleaner.end());
        if (!envelope.ok) return print(envelope, json, io);
        const done = last as LogPage | null;
        if (done === null) return ExitCode.ok;
        if (json) return print(okEnvelope({ ...done, text: parts.join('') }), json, io);
        return printState(done, io);
      }

      const read = (o: Record<string, unknown>) => fetch(values, { ...body, ...o });
      let envelope: Envelope;
      if (limit !== undefined || offset !== undefined)
        envelope = await read({
          limit: limit ?? GATE_LOG_DEFAULT_BYTES,
          ...(offset === undefined ? { tail: true } : { offset }),
        });
      else {
        // Whether the gate passed is known only from the reply: a failed one is read again at full size.
        envelope = await read({ tail: true, limit: GATE_LOG_PASSED_BYTES });
        const first = envelope.ok ? (envelope.data as LogPage) : null;
        if (first?.passed === false && (first.offset ?? 0) > 0)
          envelope = await read({ round: first.round, tail: true, limit: GATE_LOG_DEFAULT_BYTES });
      }
      if (json || !envelope.ok) return print(envelope, json, io);
      const page = envelope.data as LogPage;
      if (page.state !== 'available') return printState(page, io);
      io.stdout(cleanLog(page.text ?? ''));
      const from = page.offset ?? 0;
      const size = page.size ?? 0;
      if (offset === undefined && from > 0)
        io.stderr(
          `cusr: showing the last ${kib(size - from)} of ${kib(size)}; --full reads it all.\n`,
        );
      else if (page.complete === false)
        io.stderr(`cusr: more follows; continue with --offset ${String(page.next_offset)}.\n`);
      if (page.truncated === true)
        io.stderr('cusr: the command wrote more than was kept; the log has a marker at the cut.\n');
      return ExitCode.ok;
    },
  };
}

export const gateLogCommand = gateLogCommandWith((values, body) =>
  call(values, '/v1/query', body, null),
);
