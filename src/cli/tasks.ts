/**
 * All commands use the daemon socket; the CLI never opens the store. Validate syntax before sending.
 * Mutations print a request ID so callers can retry safely after a timeout.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { stringify } from 'yaml';
import {
  CONTROL_SOCKET,
  ExitCode,
  errorEnvelope,
  renderEnvelope,
  type Envelope,
} from './output.ts';
import { callDaemon, readClientToken, resolveDataDir } from './client.ts';
import { exitCodeFor } from './errors.ts';
import { BOARD_LIMIT } from '../application/board.ts';
import { UNSUPPORTED_GUIDANCE } from '../application/commands.ts';
import { DOCTOR_CLIENT_TIMEOUT_MS } from '../application/doctor.ts';
import { TASK_STATUSES } from '../domain/state.ts';
import { UuidSchema } from '../shared/brand.ts';
import type { CliCommand, CliIo } from './program.ts';
import {
  renderBoard,
  renderHistory,
  renderProgress,
  renderTaskList,
  type Render,
} from './render.ts';
import { explainSummary, historySummary, listSummary, showSummary } from './summary.ts';

type Values = Readonly<Record<string, string | undefined>>;

export const DATA_DIR = {
  flags: '--data-dir <dir>',
  description: 'Daemon data directory (default: $CUSR_DATA_DIR or ~/.cusr)',
};

async function call(
  values: Values,
  path: '/v1/command' | '/v1/query',
  body: unknown,
  requestId: string | null,
  timeoutMs?: number,
): Promise<Envelope> {
  const dataDir = resolveDataDir(values['dataDir']);
  const token = readClientToken(dataDir);
  const reply = token.ok
    ? await callDaemon({
        socketPath: join(dataDir, CONTROL_SOCKET),
        token: token.value,
        method: 'POST',
        path,
        body,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
    : token;
  if (reply.ok) return reply.value.envelope;
  return errorEnvelope({
    code: reply.error.code === 'token' ? 'token_unavailable' : 'daemon_unreachable',
    message: reply.error.message,
    details: {},
    request_id: requestId,
  });
}

export function print(
  envelope: Envelope,
  json: boolean,
  io: CliIo,
  render: Render = stringify,
): number {
  if (json) io.stdout(renderEnvelope(envelope));
  else if (envelope.ok) io.stdout(render(envelope.data));
  else {
    const id = envelope.error.request_id;
    io.stderr(
      `cusr: ${envelope.error.code}: ${envelope.error.message}${id === null ? '' : ` (request ${id})`}\n`,
    );
    const guidance = envelope.error.details['guidance'];
    if (typeof guidance === 'string') io.stderr(`cusr: ${guidance}\n`);
    const issues = envelope.error.details['issues'];
    if (Array.isArray(issues)) for (const issue of issues) io.stderr(`cusr: ${String(issue)}\n`);
    const checks = envelope.error.details['checks'] as
      | { name: string; status: string; detail: string; fix: string | null }[]
      | undefined;
    for (const c of checks ?? [])
      if (c.status === 'fail')
        io.stderr(`cusr: ${c.name}: ${c.detail}${c.fix === null ? '' : `; fix: ${c.fix}`}\n`);
  }
  return exitCodeFor(envelope);
}

function fail(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
  requestId: string | null,
): Envelope {
  return errorEnvelope({ code, message, details, request_id: requestId });
}

function usage(message: string, json: boolean, io: CliIo): number {
  return print(fail('invalid_arguments', message, {}, null), json, io);
}

/** A flag this command can check itself: the message says how to fix it, with no error code in front. */
export function badFlag(
  message: string,
  details: Readonly<Record<string, unknown>>,
  json: boolean,
  io: CliIo,
): number {
  if (json) return print(fail('invalid_arguments', message, details, null), json, io);
  io.stderr(`cusr: ${message}\n`);
  return ExitCode.usage;
}

function badChoice(
  flag: string,
  given: string,
  valid: readonly string[],
  json: boolean,
  io: CliIo,
): number {
  return badFlag(
    `invalid ${flag} ${JSON.stringify(given)}.\nValid values: ${valid.join(', ')}.`,
    { valid_values: valid },
    json,
    io,
  );
}

function choice(
  v: string | undefined,
): { harness: string; model: string; effort: string } | null | undefined {
  if (v === undefined) return undefined;
  const [harness, model, effort, ...rest] = v.split('/');
  return harness && model && effort && rest.length === 0 ? { harness, model, effort } : null;
}

const RUN_OPTIONS = [
  {
    flags: '--profile <name>',
    description: 'Profile for this run configuration',
  },
  {
    flags: '--mode <mode>',
    description: 'Execution mode: direct-pr or full-review',
  },
  {
    flags: '--worker <h/m/e>',
    description: 'Worker binding in harness/model/effort format',
  },
  {
    flags: '--reviewer <h/m/e>',
    description: 'Reviewer binding in harness/model/effort format (full-review only)',
  },
  {
    flags: '--fallback <list>',
    description: 'Comma-separated fallback bindings in harness/model/effort format',
  },
  {
    flags: '--reason <text>',
    description: 'Reason for the selected mode and bindings',
  },
];

/** The run selection from flags; undefined when none given, a string when malformed. */
function runProposal(values: Values): Record<string, unknown> | string | undefined {
  if (values['mode'] === undefined && values['worker'] === undefined) return undefined;
  const worker = choice(values['worker']);
  const reviewer = choice(values['reviewer']);
  const fallbacks = (values['fallback'] ?? '')
    .split(',')
    .filter((x) => x !== '')
    .map((x) => choice(x));
  if (
    values['mode'] === undefined ||
    values['profile'] === undefined ||
    worker == null ||
    reviewer === null ||
    fallbacks.some((f) => f == null)
  ) {
    return 'Run configuration requires --profile, --mode, and --worker in harness/model/effort format; full-review also requires --reviewer';
  }
  return {
    profile: values['profile'],
    mode: values['mode'],
    reason: values['reason'] ?? '',
    worker,
    reviewer: reviewer ?? null,
    fallbacks,
  };
}

const REQUEST_ID = {
  flags: '--request-id <uuid>',
  description: 'Request ID for safe retries (default: a new UUIDv7, included in the result)',
};
const EXPECTED_VERSION = {
  flags: '--expected-version <n>',
  description: 'Expected task version from cusr task show',
};
const PROJECT = {
  flags: '--project <id>',
  description: 'Project ID (default: resolved from the task)',
};

function version(values: Values): number | null {
  const raw = values['expectedVersion'];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

async function mutate(
  values: Values,
  kind: string,
  taskId: string,
  payload: unknown,
  json: boolean,
  io: CliIo,
): Promise<number> {
  const expected = version(values);
  if (expected === null)
    return usage(`${kind} requires --expected-version with a non-negative integer`, json, io);
  const requestId = values['requestId'] ?? uuidv7();
  let project = values['project'];
  if (project === undefined) {
    const shown = await call(
      values,
      '/v1/query',
      { kind: 'task_show', task_id: taskId },
      requestId,
    );
    if (!shown.ok)
      return print({ ...shown, error: { ...shown.error, request_id: requestId } }, json, io);
    project = (shown.data as { project: string }).project;
  }
  return print(
    await call(
      values,
      '/v1/command',
      {
        request_id: requestId,
        kind,
        project,
        task_id: taskId,
        expected_version: expected,
        payload,
      },
      requestId,
    ),
    json,
    io,
  );
}

/** `view` reshapes a successful reply before it is printed, for both `--json` and the human output. */
export async function query(
  values: Values,
  body: Record<string, unknown>,
  json: boolean,
  io: CliIo,
  timeoutMs?: number,
  render?: Render,
  view?: (data: unknown) => unknown,
): Promise<number> {
  const reply = await call(values, '/v1/query', body, null, timeoutMs);
  return print(
    reply.ok && view !== undefined ? { ...reply, data: view(reply.data) } : reply,
    json,
    io,
    render,
  );
}

const FULL = {
  flags: '--full',
  description: 'Print the complete reply, including evidence, log excerpts and provenance',
};

/** The summary view unless `--full` asked for the complete reply. */
const unlessFull = (
  values: Values,
  summary: (data: unknown) => unknown,
): ((data: unknown) => unknown) | undefined => (values['full'] === undefined ? summary : undefined);

/** The JSON task input of `task add --file` (contracts/cli-daemon.md); the daemon validates its fields. */
function readJsonFile(path: string): Record<string, unknown> | string {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : `${path} must contain a JSON object`;
  } catch (e) {
    return `Cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export const addCommand: CliCommand = {
  name: 'task add',
  description: 'Add a task from a JSON file or flags and return immediately',
  options: [
    DATA_DIR,
    REQUEST_ID,
    {
      flags: '--file <file>',
      description: 'JSON task file containing project, title, base_branch, and acceptance',
    },
    {
      flags: '--project <id>',
      description: 'Project ID from the user configuration',
    },
    { flags: '--title <text>', description: 'Task title' },
    { flags: '--base <branch>', description: 'Base branch' },
    {
      flags: '--acceptance <text>',
      description: 'Acceptance criteria, one per line',
    },
    { flags: '--description <text>', description: 'Task description' },
    {
      flags: '--depends-on <ids>',
      description: 'Comma-separated dependency task IDs',
    },
    {
      flags: '--priority <n>',
      description: 'Scheduling priority; higher values run first (default: 0)',
    },
    ...RUN_OPTIONS,
  ],
  async run(values, json, io) {
    let project = values['project'];
    let task: Record<string, unknown>;
    let fileRun: unknown;
    if (values['file'] !== undefined) {
      const file = readJsonFile(values['file']);
      if (typeof file === 'string') return usage(file, json, io);
      const { project: fileProject, run_config, ...rest } = file;
      if (typeof fileProject === 'string') project ??= fileProject;
      fileRun = run_config;
      task = rest;
      if (project === undefined)
        return usage('task add requires a project in the JSON file or --project', json, io);
    } else {
      const { title, base } = values;
      if (project === undefined || title === undefined || base === undefined)
        return usage('task add requires --file or all of --project, --title, and --base', json, io);
      task = {
        title,
        base_branch: base,
        description: values['description'] ?? '',
        acceptance: (values['acceptance'] ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s !== ''),
        depends_on: (values['dependsOn'] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== ''),
        ...(values['priority'] === undefined ? {} : { priority: Number(values['priority']) }),
      };
    }
    const flagged = runProposal(values);
    if (typeof flagged === 'string') return usage(flagged, json, io);
    const run = flagged ?? fileRun;
    const requestId = values['requestId'] ?? uuidv7();
    return print(
      await call(
        values,
        '/v1/command',
        {
          request_id: requestId,
          kind: 'task_add',
          project,
          task_id: null,
          expected_version: null,
          payload: { task, ...(run === undefined ? {} : { run_config: run }) },
        },
        requestId,
      ),
      json,
      io,
    );
  },
};

export const showCommand: CliCommand = {
  name: 'task show',
  description: 'Show task status, step, wait, pull request, version and run configuration digest',
  help: `By default: identity, status, step, wait, PR, version and run_config digest for mutations.
--full adds provenance, usage, merge, deadline and execution details.

Examples:
  cusr task show 019a0000-0000-7000-8000-000000000001 --json
  cusr task show 019a0000-0000-7000-8000-000000000001 --full --json`,
  args: ['<id>'],
  options: [DATA_DIR, FULL],
  run: (values, json, io) =>
    query(
      values,
      { kind: 'task_show', task_id: values['id'] },
      json,
      io,
      undefined,
      undefined,
      unlessFull(values, showSummary),
    ),
};

export const TASK_LIST_DEFAULT_LIMIT = 20;
const LIST_ORDERS = ['newest', 'oldest'];

export const listCommand: CliCommand = {
  name: 'task list',
  description: `List accessible tasks, newest first, ${TASK_LIST_DEFAULT_LIMIT} per page by default`,
  help: `Every task stays reachable: follow next_cursor page by page, filter with --project and
--status, or use --order oldest to start from the first task.

Examples:
  cusr task list
  cusr task list --project acme --status WAITING
  cusr task list --limit 100 --cursor 019a0000-0000-7000-8000-000000000001 --json`,
  options: [
    DATA_DIR,
    {
      flags: '--limit <n>',
      description: `Page size, from 1 to 100 (default: ${TASK_LIST_DEFAULT_LIMIT})`,
    },
    {
      flags: '--cursor <id>',
      description: 'Pagination cursor (next_cursor) from the previous result',
    },
    { flags: '--project <id>', description: 'Filter by project ID' },
    { flags: '--status <status>', description: 'Filter by task status' },
    {
      flags: '--order <order>',
      description: 'newest (default) or oldest task first',
    },
    {
      flags: '--full',
      description: 'Print every field of each task, such as version and head',
    },
  ],
  run(values, json, io) {
    const limit = Number(values['limit'] ?? TASK_LIST_DEFAULT_LIMIT);
    if (!Number.isInteger(limit))
      return Promise.resolve(usage('--limit must be an integer', json, io));
    const order = values['order'] ?? 'newest';
    if (!LIST_ORDERS.includes(order))
      return Promise.resolve(badChoice('--order', order, LIST_ORDERS, json, io));
    const filters = (
      [
        ['--project', values['project']],
        ['--status', values['status']],
        ['--order', values['order']],
        ['--limit', values['limit']],
        ['--data-dir', values['dataDir']],
      ] as const
    ).flatMap(([flag, value]) => (value === undefined ? [] : [flag, value]));
    return query(
      values,
      {
        kind: 'task_list',
        limit,
        order,
        ...(values['cursor'] === undefined ? {} : { cursor: values['cursor'] }),
        ...(values['project'] === undefined ? {} : { project: values['project'] }),
        ...(values['status'] === undefined ? {} : { status: values['status'] }),
      },
      json,
      io,
      undefined,
      values['full'] === undefined ? renderTaskList(filters) : undefined,
      unlessFull(values, listSummary),
    );
  },
};

export const explainCommand: CliCommand = {
  name: 'task explain',
  description:
    'Explain where a task is: step, wait reason, running binding, queue, pull request and next actions',
  help: `By default: status, step, wait, blockers, running binding, queue position, PR, what failed
last (names only) and allowed actions; empty fields are left out. --full prints the complete
explanation with evidence and log excerpts; task logs and task history show the records behind it.

Examples:
  cusr task explain 019a0000-0000-7000-8000-000000000001 --json
  cusr task explain 019a0000-0000-7000-8000-000000000001 --full --json`,
  args: ['<id>'],
  options: [DATA_DIR, FULL],
  run: (values, json, io) =>
    query(
      values,
      { kind: 'task_explain', task_id: values['id'] },
      json,
      io,
      undefined,
      undefined,
      unlessFull(values, explainSummary),
    ),
};

export const HISTORY_DEFAULT_LIMIT = 50;

export const historyCommand: CliCommand = {
  name: 'task history',
  description: `Show accepted task events in sequence order, ${HISTORY_DEFAULT_LIMIT} per page by default`,
  help: `By default each event shows seq, type, revision and actor; --full adds payloads.
Continue with --after set to next_cursor while more is true.

Examples:
  cusr task history 019a0000-0000-7000-8000-000000000001
  cusr task history 019a0000-0000-7000-8000-000000000001 --after 120 --full --json`,
  args: ['<id>'],
  options: [
    DATA_DIR,
    {
      flags: '--after <seq>',
      description: 'Show events after this sequence number',
    },
    {
      flags: '--limit <n>',
      description: `Page size, at most 500 (default: ${HISTORY_DEFAULT_LIMIT})`,
    },
    {
      flags: '--full',
      description: 'Include each event payload and deduplication key',
    },
  ],
  run(values, json, io) {
    const after = values['after'] === undefined ? undefined : Number(values['after']);
    const limit = Number(values['limit'] ?? HISTORY_DEFAULT_LIMIT);
    if ((after !== undefined && !Number.isInteger(after)) || !Number.isInteger(limit))
      return Promise.resolve(usage('--after and --limit must be integers', json, io));
    return query(
      values,
      {
        kind: 'task_history',
        task_id: values['id'],
        ...(after === undefined ? {} : { after }),
        limit,
      },
      json,
      io,
      undefined,
      renderHistory,
      unlessFull(values, historySummary),
    );
  },
};

export const proposeCommand: CliCommand = {
  name: 'task propose',
  description: 'Propose a task execution mode and model bindings for confirmation',
  args: ['<id>'],
  options: [DATA_DIR, REQUEST_ID, PROJECT, EXPECTED_VERSION, ...RUN_OPTIONS],
  run(values, json, io) {
    const run = runProposal(values);
    if (run === undefined || typeof run === 'string')
      return Promise.resolve(
        usage(run ?? 'task propose requires --profile, --mode, and --worker', json, io),
      );
    return mutate(
      values,
      'task_propose_run',
      values['id'] as string,
      { run_config: run },
      json,
      io,
    );
  },
};

export const confirmCommand: CliCommand = {
  name: 'task confirm',
  description:
    'Confirm a task and revalidate its configuration; use --run-config to confirm the proposed run',
  args: ['<id>'],
  options: [
    DATA_DIR,
    REQUEST_ID,
    PROJECT,
    EXPECTED_VERSION,
    {
      flags: '--run-config <digest>',
      description: 'Run configuration digest from cusr task show',
    },
  ],
  run: (values, json, io) =>
    mutate(
      values,
      'task_confirm',
      values['id'] as string,
      values['runConfig'] === undefined ? {} : { run_config_digest: values['runConfig'] },
      json,
      io,
    ),
};

export const cancelCommand: CliCommand = {
  name: 'task cancel',
  description: 'Request task cancellation; completed external actions are preserved',
  args: ['<id>'],
  options: [
    DATA_DIR,
    REQUEST_ID,
    PROJECT,
    EXPECTED_VERSION,
    {
      flags: '--reason <text>',
      description: 'Cancellation reason recorded in task history',
    },
  ],
  run: (values, json, io) =>
    mutate(
      values,
      'task_cancel',
      values['id'] as string,
      { reason: values['reason'] ?? 'Cancelled from the CLI' },
      json,
      io,
    ),
};

export const recheckCommand: CliCommand = {
  name: 'task recheck',
  description:
    'Recheck task configuration, pull request, drain, or worktree based on its current state',
  args: ['<id>'],
  options: [DATA_DIR, REQUEST_ID, PROJECT, EXPECTED_VERSION],
  run: (values, json, io) => mutate(values, 'task_recheck', values['id'] as string, {}, json, io),
};

export const continueCommand: CliCommand = {
  name: 'task continue',
  description: 'Keep a task on its current model after its quality loop ran out',
  args: ['<id>'],
  options: [DATA_DIR, REQUEST_ID, PROJECT, EXPECTED_VERSION],
  run: (values, json, io) => mutate(values, 'task_continue', values['id'] as string, {}, json, io),
};

function unsupported(
  key: keyof typeof UNSUPPORTED_GUIDANCE,
  json: boolean,
  io: CliIo,
): Promise<number> {
  return Promise.resolve(
    print(
      fail(
        'unsupported_feature',
        `${key} is not supported`,
        { kind: key, guidance: UNSUPPORTED_GUIDANCE[key] },
        null,
      ),
      json,
      io,
    ),
  );
}

export const approveCommand: CliCommand = {
  name: 'task approve',
  description: 'Approve a model escalation (admin required)',
  args: ['<id>'],
  options: [
    DATA_DIR,
    REQUEST_ID,
    PROJECT,
    EXPECTED_VERSION,
    { flags: '--kind <kind>', description: 'Approval kind: escalation' },
    { flags: '--step <step>', description: 'Step requesting escalation' },
    { flags: '--rung <n>', description: 'Requested escalation rung' },
  ],
  run(values, json, io) {
    if (values['kind'] === 'merge') return unsupported('merge_approve', json, io);
    const rung = values['rung'] === undefined ? NaN : Number(values['rung']);
    if (values['kind'] !== 'escalation' || values['step'] === undefined || !Number.isInteger(rung))
      return Promise.resolve(
        usage('task approve requires --kind escalation, --step, and an integer --rung', json, io),
      );
    return mutate(
      values,
      'approve_escalation',
      values['id'] as string,
      { step: values['step'], rung },
      json,
      io,
    );
  },
};

export const retryCommand: CliCommand = {
  name: 'task retry',
  description: 'Unsupported; use cusr task add to create an independent task',
  args: ['[id]'],
  options: [DATA_DIR, REQUEST_ID, EXPECTED_VERSION],
  run: (_values, json, io) => unsupported('task_retry', json, io),
};

export const amendPolicyCommand: CliCommand = {
  name: 'task amend-policy',
  description: 'Unsupported; cancel the task and create one with the updated configuration',
  args: ['[id]'],
  options: [DATA_DIR, REQUEST_ID, EXPECTED_VERSION],
  run: (_values, json, io) => unsupported('task_amend_policy', json, io),
};

export const yoloCommand: CliCommand = {
  name: 'yolo',
  description:
    'No command; set yolo: true in the user config, or merge the pull request on GitHub and run cusr task recheck',
  args: ['[id]'],
  options: [DATA_DIR],
  run: (_values, json, io) => unsupported('yolo', json, io),
};

export const inboxCommand: CliCommand = {
  name: 'inbox',
  description: 'List open questions for accessible tasks',
  options: [
    DATA_DIR,
    { flags: '--project <id>', description: 'Filter by project ID' },
    { flags: '--task <id>', description: 'Filter by task ID' },
  ],
  run: (values, json, io) =>
    query(
      values,
      {
        kind: 'inbox',
        ...(values['project'] === undefined ? {} : { project: values['project'] }),
        ...(values['task'] === undefined ? {} : { task_id: values['task'] }),
      },
      json,
      io,
    ),
};

export const dispatchCommand: CliCommand = {
  name: 'dispatch',
  description: 'Show the configured guidance for choosing run settings',
  options: [DATA_DIR, { flags: '--project <id>', description: 'Project ID' }],
  run: (values, json, io) =>
    values['project'] === undefined
      ? Promise.resolve(usage('dispatch requires --project', json, io))
      : query(values, { kind: 'dispatch', project: values['project'] }, json, io),
};

export const answerCommand: CliCommand = {
  name: 'answer',
  description: 'Answer a question from a text file; the first valid answer is accepted',
  args: ['<question>'],
  options: [
    DATA_DIR,
    REQUEST_ID,
    EXPECTED_VERSION,
    { flags: '--file <file>', description: 'Text file containing the answer' },
  ],
  async run(values, json, io) {
    const expected = version(values);
    if (values['file'] === undefined || expected === null)
      return usage(
        'answer requires --file and --expected-version with a non-negative integer',
        json,
        io,
      );
    let answer: string;
    try {
      answer = readFileSync(values['file'], 'utf8').trimEnd();
    } catch (e) {
      return usage(
        `Cannot read ${values['file']}: ${e instanceof Error ? e.message : String(e)}`,
        json,
        io,
      );
    }
    const requestId = values['requestId'] ?? uuidv7();
    const question = values['question'] as string;
    const where = await call(
      values,
      '/v1/query',
      { kind: 'question_show', question_id: question },
      requestId,
    );
    if (!where.ok)
      return print({ ...where, error: { ...where.error, request_id: requestId } }, json, io);
    const found = where.data as { task_id: string; project: string };
    return print(
      await call(
        values,
        '/v1/command',
        {
          request_id: requestId,
          kind: 'answer',
          project: found.project,
          task_id: found.task_id,
          expected_version: expected,
          payload: { question_id: question, answer },
        },
        requestId,
      ),
      json,
      io,
    );
  },
};

export const doctorCommand: CliCommand = {
  name: 'doctor',
  description: 'Check daemon health, host prerequisites, credentials, and harness capabilities',
  options: [DATA_DIR, { flags: '--project <id>', description: 'Include checks for this project' }],
  run: (values, json, io) =>
    query(
      values,
      {
        kind: 'doctor',
        ...(values['project'] === undefined ? {} : { project: values['project'] }),
      },
      json,
      io,
      DOCTOR_CLIENT_TIMEOUT_MS,
    ),
};

const BOARD_SCOPES = ['active', 'terminal', 'all'];

export const boardCommand: CliCommand = {
  name: 'task board',
  description: 'List tasks and highlight those that need your attention.',
  help: `Examples:
  cusr task board
  cusr task board --project acme --status WAITING
  cusr task board --scope all --limit 20
  cusr task board --json`,
  options: [
    DATA_DIR,
    { flags: '--project <id>', description: 'Only this project' },
    {
      flags: '--status <status>',
      description: `Only this status, in uppercase: ${TASK_STATUSES.join(', ')}`,
    },
    {
      flags: '--scope <scope>',
      description: 'active (default), terminal or all',
    },
    {
      flags: '--limit <n>',
      description: `Page size, from 1 to ${BOARD_LIMIT}`,
    },
    { flags: '--cursor <id>', description: 'Show tasks after this task ID' },
  ],
  run(values, json, io) {
    const { project, status, scope, cursor } = values;
    const limit = values['limit'];
    if (
      limit !== undefined &&
      (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > BOARD_LIMIT)
    )
      return Promise.resolve(
        badFlag(`--limit must be an integer between 1 and ${BOARD_LIMIT}.`, {}, json, io),
      );
    if (status !== undefined && !(TASK_STATUSES as readonly string[]).includes(status))
      return Promise.resolve(badChoice('--status', status, TASK_STATUSES, json, io));
    if (scope !== undefined && !BOARD_SCOPES.includes(scope))
      return Promise.resolve(badChoice('--scope', scope, BOARD_SCOPES, json, io));
    if (project === '')
      return Promise.resolve(badFlag('--project must not be empty.', {}, json, io));
    if (cursor !== undefined && !UuidSchema.safeParse(cursor).success)
      return Promise.resolve(
        badFlag(`invalid --cursor ${JSON.stringify(cursor)}: it must be a task ID.`, {}, json, io),
      );
    return query(
      values,
      {
        kind: 'task_board',
        ...(project === undefined ? {} : { project }),
        ...(status === undefined ? {} : { status }),
        ...(scope === undefined ? {} : { scope }),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
        ...(cursor === undefined ? {} : { cursor }),
      },
      json,
      io,
      undefined,
      renderBoard(
        (
          [
            ['--project', project],
            ['--status', status],
            ['--scope', scope],
            ['--limit', limit],
            ['--data-dir', values['dataDir']],
          ] as const
        ).flatMap(([flag, value]) => (value === undefined ? [] : [flag, value])),
      ),
    );
  },
};

function taskRead(kind: string, name: string, description: string, render?: Render): CliCommand {
  return {
    name,
    description,
    help: `Example:\n  cusr ${name} 019a0000-0000-7000-8000-000000000001`,
    args: ['<id>'],
    options: [DATA_DIR],
    run: (values, json, io) =>
      query(values, { kind, task_id: values['id'] }, json, io, undefined, render),
  };
}

export const contentCommand = taskRead(
  'task_content',
  'task content',
  "Show a task's request and run configuration.",
);
export const progressCommand = taskRead(
  'task_progress',
  'task progress',
  'Show visited, current, and remaining workflow steps.',
  renderProgress,
);
export const optionsCommand = taskRead(
  'run_options',
  'task options',
  'List available execution modes and models for a task.',
);
