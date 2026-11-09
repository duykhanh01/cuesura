/**
 * All commands use the daemon socket; the CLI never opens the store. Validate syntax before sending.
 * Mutations print a request ID so callers can retry safely after a timeout.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { stringify } from 'yaml';
import { CONTROL_SOCKET, errorEnvelope, renderEnvelope, type Envelope } from './output.ts';
import {
  callDaemon,
  clientErrorEnvelope,
  NETWORK_MUTATION_TIMEOUT_MS,
  readClientActor,
  resolveDataDir,
} from './client.ts';
import { exitCodeFor } from './errors.ts';
import { DATA_DIR, badFlag } from './base.ts';
import {
  BOARD_LIMIT,
  DOCTOR_CLIENT_TIMEOUT_MS,
  UNSUPPORTED_GUIDANCE,
} from '../application/limits.ts';
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
import {
  boardSummary,
  explainSummary,
  historySummary,
  listSummary,
  showSummary,
} from './summary.ts';

type Values = Readonly<Record<string, string | undefined>>;

export { DATA_DIR, badFlag } from './base.ts';

export async function call(
  values: Values,
  path: '/v1/command' | '/v1/query',
  body: unknown,
  requestId: string | null,
  timeoutMs?: number,
): Promise<Envelope> {
  const dataDir = resolveDataDir(values['dataDir']);
  const actor = readClientActor();
  const reply = actor.ok
    ? await callDaemon({
        socketPath: join(dataDir, CONTROL_SOCKET),
        actor: actor.value,
        method: 'POST',
        path,
        body,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
    : actor;
  if (!reply.ok) return clientErrorEnvelope(dataDir, reply.error, requestId);
  const env = reply.value.envelope;
  // An error raised before the daemon read the request still belongs to the ID this mutation sent.
  if (!env.ok && env.error.request_id === null && requestId !== null)
    return { ...env, error: { ...env.error, request_id: requestId } };
  return env;
}

const CHOICE_LISTS = [
  ['projects', 'valid projects'],
  ['models', 'configured models'],
] as const;

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
    for (const key of ['guidance', 'next_step']) {
      const text = envelope.error.details[key];
      if (typeof text === 'string') io.stderr(`cusr: ${text}\n`);
    }
    for (const [key, label] of CHOICE_LISTS) {
      const valid = envelope.error.details[key];
      if (Array.isArray(valid)) io.stderr(`cusr: ${label}: ${valid.join(', ') || '(none)'}\n`);
    }
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
    description:
      "Comma-separated fallback bindings in harness/model/effort format; defaults to the worker's ladder rungs from task options, '' for none",
  },
  {
    flags: '--reviewer-fallback <list>',
    description:
      "Comma-separated reviewer fallback bindings in harness/model/effort format; defaults to the reviewer's ladder rungs from task options, '' for none",
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
  const list = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .filter((x) => x !== '')
      .map((x) => choice(x));
  const fallbacks = list(values['fallback']);
  const reviewerFallbacks = list(values['reviewerFallback']);
  if (
    values['mode'] === undefined ||
    values['profile'] === undefined ||
    worker == null ||
    reviewer === null ||
    fallbacks.some((f) => f == null) ||
    reviewerFallbacks.some((f) => f == null)
  ) {
    return 'Run configuration requires --profile, --mode, and --worker in harness/model/effort format; full-review also requires --reviewer';
  }
  return {
    profile: values['profile'],
    mode: values['mode'],
    reason: values['reason'] ?? '',
    worker,
    reviewer: reviewer ?? null,
    // Without the flag the daemon fills the worker's ladder from `run_options` (#263).
    ...(values['fallback'] === undefined ? {} : { fallbacks }),
    ...(values['reviewerFallback'] === undefined ? {} : { reviewer_fallbacks: reviewerFallbacks }),
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

/** The command a person typed, for messages; `kind` is the daemon's name for it. */
const COMMAND_NAMES: Readonly<Record<string, string>> = {
  task_propose_run: 'task propose',
  approve_adopt: 'task approve',
  approve_escalation: 'task approve',
};

function commandName(kind: string): string {
  return COMMAND_NAMES[kind] ?? kind.replace(/^task_/, 'task ').replaceAll('_', '-');
}

const ID = '019a0000-0000-7000-8000-000000000001';
const FROM_SHOW =
  'Take --expected-version (version) and the run_config digest from cusr task show.';

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
  timeoutMs?: number,
): Promise<number> {
  const expected = version(values);
  if (expected === null)
    return usage(
      `${commandName(kind)} requires --expected-version with a non-negative integer`,
      json,
      io,
    );
  const requestId = values['requestId'] ?? uuidv7();
  const send = (project: string | null) =>
    call(
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
      timeoutMs,
    );
  const reply = await send(values['project'] ?? null);
  // A daemon older than #259 does not fill in the project of the task, so it is read here.
  if (values['project'] === undefined && needsProject(reply)) {
    const shown = await call(
      values,
      '/v1/query',
      { kind: 'task_show', task_id: taskId },
      requestId,
    );
    if (!shown.ok)
      return print({ ...shown, error: { ...shown.error, request_id: requestId } }, json, io);
    return print(await send((shown.data as { project: string }).project), json, io);
  }
  return print(reply, json, io);
}

function needsProject(reply: Envelope): boolean {
  const issues = reply.ok ? undefined : reply.error.details['issues'];
  return Array.isArray(issues) && issues.includes('project: required');
}

function readText(path: string): string {
  return readFileSync(path === '-' ? 0 : path, 'utf8').trimEnd();
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

/** Flags that describe the task itself; with --file the file does instead. */
const TASK_FLAGS = [
  ['title', '--title'],
  ['base', '--base'],
  ['description', '--description'],
  ['acceptance', '--acceptance'],
  ['priority', '--priority'],
  ['dependsOn', '--depends-on'],
] as const;

export const addCommand: CliCommand = {
  name: 'task add',
  description: 'Add a task from a JSON file or flags and return immediately',
  help: `The --file JSON object takes project, title, base_branch and acceptance (a list, at least one),
and optionally: strings type, description, profile, source_key and pr_ref (owner/repo#n); lists of
strings requirements, constraints, out_of_scope, labels and scope (paths or globs); depends_on (task
IDs); priority (integer -1000..1000); size (XS|S|M|L|XL or null); run_config (object). --title, --base, --description,
--acceptance, --priority and --depends-on cannot be combined with --file.
Set source_key to a key stable for the work (e.g. issue:acme#12): adding the same work again is then
refused as conflict task_exists with error.details.detail.task_id, instead of making a second task.

Then: cusr task options <id> lists modes and bindings; cusr task propose sets one (or pass the run
flags here); cusr task show gives version and run_config digest; cusr task confirm --run-config confirms.

Examples:
  cusr task add --file task.json --json
  cusr task add --project acme --title "Fix login" --base main --acceptance "Login works" --json`,
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
      flags: '--pr <owner/repo#n>',
      description: 'Continue this open PR: push to its head branch after task approve --kind adopt',
    },
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
    {
      flags: '--scope <paths>',
      description:
        'Comma-separated paths or globs the task expects to change; a task sharing them does not run alongside',
    },
    ...RUN_OPTIONS,
  ],
  async run(values, json, io) {
    let project = values['project'];
    let task: Record<string, unknown>;
    let fileRun: unknown;
    if (values['file'] !== undefined) {
      const mixed = TASK_FLAGS.filter(([key]) => values[key] !== undefined).map(([, flag]) => flag);
      if (mixed.length > 0)
        return usage(
          `task add --file cannot be combined with ${mixed.join(', ')}; put them in the JSON file`,
          json,
          io,
        );
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
      const priority = values['priority'] === undefined ? undefined : Number(values['priority']);
      if (priority !== undefined && !Number.isInteger(priority))
        return usage('--priority must be an integer', json, io);
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
        ...(priority === undefined ? {} : { priority }),
      };
    }
    if (values['pr'] !== undefined) task['pr_ref'] = values['pr'];
    if (values['scope'] !== undefined)
      task['scope'] = values['scope']
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
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
  help: `By default each event shows seq, type, revision, actor and at; --full adds payloads.
Continue with --after set to next_cursor while more is true; --tail shows the newest page.

Examples:
  cusr task history 019a0000-0000-7000-8000-000000000001 --tail
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
      flags: '--tail',
      description: 'Show the newest events instead of starting after --after',
    },
    {
      flags: '--full',
      description: 'Include each event payload and deduplication key',
    },
  ],
  run(values, json, io) {
    const after = values['after'] === undefined ? undefined : Number(values['after']);
    const limit = Number(values['limit'] ?? HISTORY_DEFAULT_LIMIT);
    const tail = values['tail'] !== undefined;
    if (tail && after !== undefined)
      return Promise.resolve(usage('--tail and --after cannot be used together', json, io));
    if ((after !== undefined && !Number.isInteger(after)) || !Number.isInteger(limit))
      return Promise.resolve(usage('--after and --limit must be integers', json, io));
    return query(
      values,
      {
        kind: 'task_history',
        task_id: values['id'],
        ...(after === undefined ? {} : { after }),
        ...(tail ? { tail } : {}),
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
  help: `Pick the values from cusr task options <id>: a choice {harness, model, effort} is written
harness/model/effort, e.g. claude/opus/high. ${FROM_SHOW}
Confirm afterwards with cusr task confirm --run-config <digest>.

Example:
  cusr task propose ${ID} --expected-version 3 --profile default --mode direct-pr \\
    --worker claude/opus/high --reason "small change" --json`,
  args: ['<id>'],
  options: [DATA_DIR, REQUEST_ID, PROJECT, EXPECTED_VERSION, ...RUN_OPTIONS],
  run(values, json, io) {
    if (version(values) === null)
      return Promise.resolve(
        usage('task propose requires --expected-version with a non-negative integer', json, io),
      );
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
  help: `${FROM_SHOW} Without --run-config this confirms the task, not the run.

Example:
  cusr task confirm ${ID} --expected-version 4 --run-config sha256:... --json`,
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
      NETWORK_MUTATION_TIMEOUT_MS,
    ),
};

export const cancelCommand: CliCommand = {
  name: 'task cancel',
  description: 'Request task cancellation; completed external actions are preserved',
  help: `${FROM_SHOW}\n\nExample:\n  cusr task cancel ${ID} --expected-version 5 --reason "not needed" --json`,
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
    {
      flags: '--force',
      description:
        'End the cancel even when no read shows the PR open or closed (the PR may be unread); a merge seen still ends DONE',
    },
  ],
  run: (values, json, io) =>
    mutate(
      values,
      'task_cancel',
      values['id'] as string,
      {
        reason: values['reason'] ?? 'Cancelled from the CLI',
        ...(values['force'] === undefined ? {} : { force: true }),
      },
      json,
      io,
      NETWORK_MUTATION_TIMEOUT_MS,
    ),
};

export const recheckCommand: CliCommand = {
  name: 'task recheck',
  description:
    'Recheck task configuration, pull request, drain, or worktree based on its current state',
  help: `Runs the check the current wait needs: config, PR, drain or worktree. ${FROM_SHOW}\n\nExample:\n  cusr task recheck ${ID} --expected-version 5 --json`,
  args: ['<id>'],
  options: [DATA_DIR, REQUEST_ID, PROJECT, EXPECTED_VERSION],
  run: (values, json, io) =>
    mutate(
      values,
      'task_recheck',
      values['id'] as string,
      {},
      json,
      io,
      NETWORK_MUTATION_TIMEOUT_MS,
    ),
};

export const pauseCommand: CliCommand = {
  name: 'task pause',
  description:
    'Pause a task: work already started finishes, no new step starts until it is resumed',
  help: `${FROM_SHOW}\n\nExample:\n  cusr task pause ${ID} --expected-version 5 --reason "wait for #12" --json`,
  args: ['<id>'],
  options: [
    DATA_DIR,
    REQUEST_ID,
    PROJECT,
    EXPECTED_VERSION,
    { flags: '--reason <text>', description: 'Why the task is paused, shown until it is resumed' },
    {
      flags: '--now',
      description:
        'Also stop the agent attempt running now; it starts over in a new session on resume',
    },
  ],
  run: (values, json, io) =>
    mutate(
      values,
      'task_pause',
      values['id'] as string,
      {
        reason: values['reason'] ?? 'Paused from the CLI',
        ...(values['now'] === undefined ? {} : { now: true }),
      },
      json,
      io,
    ),
};

export const resumeCommand: CliCommand = {
  name: 'task resume',
  description: 'Resume a paused task from the step it stopped at',
  help: `${FROM_SHOW}\n\nExample:\n  cusr task resume ${ID} --expected-version 6 --json`,
  args: ['<id>'],
  options: [DATA_DIR, REQUEST_ID, PROJECT, EXPECTED_VERSION],
  run: (values, json, io) => mutate(values, 'task_resume', values['id'] as string, {}, json, io),
};

export const messageCommand: CliCommand = {
  name: 'task message',
  description:
    'Send guidance from a text file to the agents of a task; it never widens the task or its acceptance criteria',
  help: `${FROM_SHOW}\n\nExample:\n  echo "Keep the public API unchanged" | cusr task message ${ID} --expected-version 5 --file - --json`,
  args: ['<id>'],
  options: [
    DATA_DIR,
    REQUEST_ID,
    PROJECT,
    EXPECTED_VERSION,
    { flags: '--file <file>', description: 'Text file containing the message; - reads stdin' },
    {
      flags: '--behavior <behavior>',
      description:
        'interrupt: stop a running coder/fixer turn and continue its session with the message; steer: the same, as no harness takes input mid-turn; queue: wait for the next turn. Default: steer for the assistant, interrupt for the owner',
    },
  ],
  async run(values, json, io) {
    const behavior = values['behavior'];
    if (values['file'] === undefined) return usage('task message requires --file', json, io);
    if (behavior !== undefined && !['steer', 'interrupt', 'queue'].includes(behavior))
      return usage('--behavior must be steer, interrupt or queue', json, io);
    let body: string;
    try {
      body = readText(values['file']);
    } catch (e) {
      return usage(
        `Cannot read ${values['file']}: ${e instanceof Error ? e.message : String(e)}`,
        json,
        io,
      );
    }
    if (body === '') return usage(`${values['file']} is empty`, json, io);
    return mutate(
      values,
      'task_message',
      values['id'] as string,
      { body, ...(behavior === undefined ? {} : { behavior }) },
      json,
      io,
    );
  },
};

/** A command on the daemon's own queue: no project, task or version. */
async function mutateQueue(
  values: Values,
  kind: 'queue_pause' | 'queue_resume',
  payload: unknown,
  json: boolean,
  io: CliIo,
): Promise<number> {
  const requestId = values['requestId'] ?? uuidv7();
  return print(
    await call(
      values,
      '/v1/command',
      {
        request_id: requestId,
        kind,
        project: null,
        task_id: null,
        expected_version: null,
        payload,
      },
      requestId,
    ),
    json,
    io,
  );
}

export const queuePauseCommand: CliCommand = {
  name: 'queue pause',
  description:
    'Stop starting tasks that have not started yet; started tasks go on. Kept across daemon restarts',
  help: `Example:\n  cusr queue pause --reason "maintenance" --json`,
  options: [
    DATA_DIR,
    REQUEST_ID,
    { flags: '--reason <text>', description: 'Why the queue is paused, shown by cusr status' },
  ],
  run: (values, json, io) =>
    mutateQueue(
      values,
      'queue_pause',
      { reason: values['reason'] ?? 'Paused from the CLI' },
      json,
      io,
    ),
};

export const queueResumeCommand: CliCommand = {
  name: 'queue resume',
  description: 'Let tasks that have not started yet be queued and started again',
  help: `Example:\n  cusr queue resume --json`,
  options: [DATA_DIR, REQUEST_ID],
  run: (values, json, io) => mutateQueue(values, 'queue_resume', {}, json, io),
};

export const continueCommand: CliCommand = {
  name: 'task continue',
  description: 'Keep a task on its current model after its quality loop ran out',
  help: `${FROM_SHOW}\n\nExample:\n  cusr task continue ${ID} --expected-version 7 --json`,
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
  description: 'Approve a model escalation (operate) or adopting a PR (admin)',
  help: `${FROM_SHOW} cusr task explain names the step and rung waiting for approval.\n\nExamples:\n  cusr task approve ${ID} --expected-version 7 --kind escalation --step code --rung 1 --json\n  cusr task approve ${ID} --expected-version 2 --kind adopt --head-sha <40-hex sha> --json`,
  args: ['<id>'],
  options: [
    DATA_DIR,
    REQUEST_ID,
    PROJECT,
    EXPECTED_VERSION,
    { flags: '--kind <kind>', description: 'Approval kind: escalation or adopt' },
    { flags: '--step <step>', description: 'Step requesting escalation' },
    { flags: '--rung <n>', description: 'Requested escalation rung' },
    { flags: '--head-sha <sha>', description: 'Full PR head SHA this adoption approves' },
  ],
  run(values, json, io) {
    if (values['kind'] === 'merge') return unsupported('merge_approve', json, io);
    if (values['kind'] === 'adopt') {
      const head = values['headSha'];
      if (head === undefined)
        return Promise.resolve(usage('task approve --kind adopt requires --head-sha', json, io));
      return mutate(
        values,
        'approve_adopt',
        values['id'] as string,
        { head_sha: head },
        json,
        io,
        NETWORK_MUTATION_TIMEOUT_MS,
      );
    }
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
  description:
    'Run the waiting step on another model after its quality loop ran out (admin); preview first, then --confirm',
  help: [
    'Without --confirm this only previews: it prints the rung, the binding it replaces or adds, whether the',
    'rung needs approval, and the new policy hash. Run it again with --confirm <policy_hash> to apply exactly',
    'that change; the task then goes on from the waiting step with its worktree, evidence and history.',
    '',
    'Examples:',
    `  cusr task amend-policy ${ID} --model opus --json`,
    `  cusr task amend-policy ${ID} --expected-version 7 --model opus --reason "loop ran out" \\`,
    '    --confirm <policy_hash> --json',
  ].join('\n'),
  args: ['<id>'],
  options: [
    DATA_DIR,
    REQUEST_ID,
    PROJECT,
    EXPECTED_VERSION,
    { flags: '--model <name>', description: 'Configured model to run the waiting step on' },
    {
      flags: '--effort <level>',
      description: 'Effort: low, medium or high (default: the current rung effort)',
    },
    { flags: '--reason <text>', description: 'Why the policy changes, recorded in task history' },
    { flags: '--confirm <hash>', description: 'Policy hash from the preview; applies the change' },
  ],
  run(values, json, io) {
    const taskId = values['id'] as string;
    const model = values['model'];
    if (model === undefined)
      return Promise.resolve(usage('task amend-policy requires --model', json, io));
    const change = {
      model,
      ...(values['effort'] === undefined ? {} : { effort: values['effort'] }),
    };
    const hash = values['confirm'];
    if (hash === undefined)
      return query(
        values,
        {
          kind: 'amend_policy_preview',
          task_id: taskId,
          ...change,
          ...(values['reason'] === undefined ? {} : { reason: values['reason'] }),
        },
        json,
        io,
      );
    if (values['reason'] === undefined)
      return Promise.resolve(usage('task amend-policy --confirm requires --reason', json, io));
    return mutate(
      values,
      'task_amend_policy',
      taskId,
      { ...change, reason: values['reason'], policy_hash: hash },
      json,
      io,
    );
  },
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
  description:
    'List what waits on you: open questions and tasks that need you without one (paused, escalation, config)',
  help: `Each item has kind (question or wait), wait_code, task_version and next, the command that moves it on.
queue_paused is set while cusr queue pause holds every task that has not started.

Examples:
  cusr inbox --json
  cusr inbox --task 019a0000-0000-7000-8000-000000000001
  cusr inbox --limit 50 --after NEXT_AFTER --json`,
  options: [
    DATA_DIR,
    { flags: '--project <id>', description: 'Filter by project ID' },
    { flags: '--task <id>', description: 'Filter by task ID' },
    { flags: '--limit <n>', description: 'Page size, from 1 to 100 (default: 100)' },
    { flags: '--after <cursor>', description: 'next_after from the previous page' },
  ],
  run(values, json, io) {
    const limit = values['limit'] === undefined ? undefined : Number(values['limit']);
    if (limit !== undefined && !Number.isInteger(limit))
      return Promise.resolve(usage('--limit must be an integer', json, io));
    return query(
      values,
      {
        kind: 'inbox',
        ...(values['project'] === undefined ? {} : { project: values['project'] }),
        ...(values['task'] === undefined ? {} : { task_id: values['task'] }),
        ...(limit === undefined ? {} : { limit }),
        ...(values['after'] === undefined ? {} : { after: values['after'] }),
      },
      json,
      io,
    );
  },
};

export const dispatchCommand: CliCommand = {
  name: 'dispatch',
  description:
    'Show the guidance for choosing run settings; cusr.dispatch.yaml overrides the config',
  help: `Prints the rules and default for choosing mode and bindings, and source: repo (cusr.dispatch.yaml),\nglobal (dispatch.yaml beside the user config) or none. Check the choice against cusr task options.\n\nExample:\n  cusr dispatch --project acme --json`,
  options: [DATA_DIR, { flags: '--project <id>', description: 'Project ID' }],
  async run(values, json, io) {
    if (values['project'] !== undefined)
      return query(values, { kind: 'dispatch', project: values['project'] }, json, io);
    // The valid projects come from the daemon; without it the usage error still stands.
    const listed = await call(values, '/v1/query', { kind: 'project_list' }, null);
    const projects = listed.ok
      ? (listed.data as { projects: { id: string }[] }).projects.map((p) => p.id)
      : null;
    return print(
      fail(
        'invalid_arguments',
        'dispatch requires --project',
        projects === null ? {} : { projects },
        null,
      ),
      json,
      io,
    );
  },
};

export const answerCommand: CliCommand = {
  name: 'answer',
  description: 'Answer a question from a text file; the first valid answer is accepted',
  help: `Take <question> and --expected-version (task_version) from cusr inbox.\n\nExample:\n  echo "Use the v2 endpoint" | cusr answer <question-id> --expected-version 5 --file - --json`,
  args: ['<question>'],
  options: [
    DATA_DIR,
    REQUEST_ID,
    EXPECTED_VERSION,
    { flags: '--file <file>', description: 'Text file containing the answer; - reads stdin' },
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
      answer = readText(values['file']);
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
  help: `Healthy: exit 0 with the checks in data.checks. Any failed check: exit 1, error code unhealthy,
and the checks, each failed one with its fix, in error.details.checks (data is null).
A passed systemd unit or terminal probe is reused for 30 seconds; a failed one runs again.

Examples:
  cusr doctor --json
  cusr doctor --project acme --json`,
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
    {
      flags: '--full',
      description:
        'With --json, repeat the whole row in attention for a task that is also in items',
    },
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
      // The table needs whole rows and already lists each task once.
      json ? unlessFull(values, boardSummary) : undefined,
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
