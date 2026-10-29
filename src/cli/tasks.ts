/**
 * `cusr add`, `cusr show`, `cusr confirm` (T048): minimal task commands over the control socket, enough
 * to drive the fake US1 flow. Every call carries the caller's token; the CLI never opens the database.
 * The full task surface (list, explain, answer, cancel, recheck) belongs to US6.
 */
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import {
  CONTROL_SOCKET,
  errorEnvelope,
  ExitCode,
  renderEnvelope,
  type Envelope,
} from './output.ts';
import {
  callDaemon,
  exitCodeFor,
  readClientToken,
  resolveDataDir,
} from './client.ts';
import type { CliCommand, CliIo } from './program.ts';

const DATA_DIR = {
  flags: '--data-dir <dir>',
  description: 'daemon data directory (default $CUSR_DATA_DIR or ~/.cusr)',
};

async function send(
  values: Readonly<Record<string, string | undefined>>,
  path: '/v1/command' | '/v1/query',
  body: unknown,
  json: boolean,
  io: CliIo,
): Promise<number> {
  const dataDir = resolveDataDir(values['dataDir']);
  const token = readClientToken(dataDir);
  const reply = token.ok
    ? await callDaemon({
        socketPath: join(dataDir, CONTROL_SOCKET),
        token: token.value,
        method: 'POST',
        path,
        body,
      })
    : token;
  if (!reply.ok) {
    const envelope = errorEnvelope({
      code:
        reply.error.code === 'token'
          ? 'token_unavailable'
          : 'daemon_unreachable',
      message: reply.error.message,
      details: {},
      request_id: null,
    });
    if (json) io.stdout(renderEnvelope(envelope));
    else io.stderr(`cusr: ${reply.error.message}\n`);
    return reply.error.code === 'token' ? ExitCode.usage : ExitCode.connection;
  }
  return print(reply.value.envelope, json, io);
}

function print(envelope: Envelope, json: boolean, io: CliIo): number {
  if (json) io.stdout(renderEnvelope(envelope));
  else if (envelope.ok)
    io.stdout(`${JSON.stringify(envelope.data, null, 2)}\n`);
  else io.stderr(`cusr: ${envelope.error.code}: ${envelope.error.message}\n`);
  return exitCodeFor(envelope);
}

function usage(message: string, json: boolean, io: CliIo): number {
  const envelope = errorEnvelope({
    code: 'invalid_arguments',
    message,
    details: {},
    request_id: null,
  });
  if (json) io.stdout(renderEnvelope(envelope));
  else io.stderr(`cusr: ${message}\n`);
  return ExitCode.usage;
}

/** `harness/model/effort`, as the user config names them. */
function choice(
  v: string | undefined,
): { harness: string; model: string; effort: string } | null | undefined {
  if (v === undefined) return undefined;
  const [harness, model, effort, ...rest] = v.split('/');
  return harness && model && effort && rest.length === 0
    ? { harness, model, effort }
    : null;
}

const RUN_OPTIONS = [
  {
    flags: '--profile <name>',
    description: 'profile the run selection is for',
  },
  {
    flags: '--mode <mode>',
    description: 'direct-pr or full-review (see runtime.modes.*.when_to_use)',
  },
  { flags: '--worker <h/m/e>', description: 'worker harness/model/effort' },
  {
    flags: '--reviewer <h/m/e>',
    description: 'reviewer harness/model/effort (full-review only)',
  },
  {
    flags: '--fallback <list>',
    description: 'comma-separated harness/model/effort the worker may move to',
  },
  { flags: '--reason <text>', description: 'why this mode and bindings' },
];

/** The run selection from flags; undefined when none given, a string when malformed. */
function runProposal(
  values: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> | string | undefined {
  if (values['mode'] === undefined && values['worker'] === undefined)
    return undefined;
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
    return 'a run selection needs --profile, --mode and --worker h/m/e (and --reviewer h/m/e for full-review)';
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

/** `--request-id` lets a caller retry the same request; the daemon replays its first result. */
const REQUEST_ID = {
  flags: '--request-id <uuid>',
  description: 'idempotency key (default: a new UUIDv7)',
};

export const addCommand: CliCommand = {
  name: 'add',
  description: 'add a task (title, acceptance and base branch required)',
  options: [
    DATA_DIR,
    REQUEST_ID,
    { flags: '--project <id>', description: 'project id from the user config' },
    { flags: '--title <text>', description: 'task title' },
    { flags: '--base <branch>', description: 'base branch' },
    {
      flags: '--acceptance <text>',
      description: 'acceptance criteria, one per line',
    },
    { flags: '--description <text>', description: 'description' },
    {
      flags: '--depends-on <ids>',
      description: 'comma-separated task ids this task waits for',
    },
    { flags: '--priority <n>', description: 'higher runs first (default 0)' },
    ...RUN_OPTIONS,
  ],
  run(values, json, io) {
    const { project, title, base } = values;
    if (project === undefined || title === undefined || base === undefined)
      return Promise.resolve(
        usage('add needs --project, --title and --base', json, io),
      );
    const task = {
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
      ...(values['priority'] === undefined
        ? {}
        : { priority: Number(values['priority']) }),
    };
    const run = runProposal(values);
    if (typeof run === 'string') return Promise.resolve(usage(run, json, io));
    return send(
      values,
      '/v1/command',
      {
        request_id: values['requestId'] ?? uuidv7(),
        kind: 'task_add',
        project,
        task_id: null,
        expected_version: null,
        payload: { task, ...(run === undefined ? {} : { run_config: run }) },
      },
      json,
      io,
    );
  },
};

export const showCommand: CliCommand = {
  name: 'show',
  description: 'show a task: status, wait, version, PR, head and completion',
  options: [DATA_DIR, { flags: '--task <id>', description: 'task id' }],
  run(values, json, io) {
    if (values['task'] === undefined)
      return Promise.resolve(usage('show needs --task', json, io));
    return send(
      values,
      '/v1/query',
      { kind: 'task_show', task_id: values['task'] },
      json,
      io,
    );
  },
};

export const proposeCommand: CliCommand = {
  name: 'propose',
  description:
    'propose the mode and harness/model/effort a task runs with (confirmed separately)',
  options: [
    DATA_DIR,
    REQUEST_ID,
    { flags: '--project <id>', description: 'project of the task' },
    { flags: '--task <id>', description: 'task id' },
    {
      flags: '--task-version <n>',
      description: 'task version you saw (from show)',
    },
    ...RUN_OPTIONS,
  ],
  run(values, json, io) {
    const version = Number(values['taskVersion']);
    if (
      values['task'] === undefined ||
      values['project'] === undefined ||
      !Number.isInteger(version)
    )
      return Promise.resolve(
        usage('propose needs --project, --task and --task-version', json, io),
      );
    const run = runProposal(values);
    if (run === undefined || typeof run === 'string')
      return Promise.resolve(
        usage(run ?? 'propose needs --profile, --mode and --worker', json, io),
      );
    return send(
      values,
      '/v1/command',
      {
        request_id: values['requestId'] ?? uuidv7(),
        kind: 'task_propose_run',
        project: values['project'],
        task_id: values['task'],
        expected_version: version,
        payload: { run_config: run },
      },
      json,
      io,
    );
  },
};

export const confirmCommand: CliCommand = {
  name: 'confirm',
  description:
    'confirm a task (and, with --run-config, the run selection shown by show) and re-check its config',
  options: [
    DATA_DIR,
    REQUEST_ID,
    { flags: '--project <id>', description: 'project of the task' },
    { flags: '--task <id>', description: 'task id' },
    {
      flags: '--task-version <n>',
      description: 'task version you saw (from show)',
    },
    {
      flags: '--run-config <digest>',
      description:
        'digest of the run selection you reviewed (owner token only)',
    },
  ],
  run(values, json, io) {
    const version = Number(values['taskVersion']);
    if (
      values['task'] === undefined ||
      values['project'] === undefined ||
      !Number.isInteger(version)
    )
      return Promise.resolve(
        usage('confirm needs --project, --task and --task-version', json, io),
      );
    return send(
      values,
      '/v1/command',
      {
        request_id: values['requestId'] ?? uuidv7(),
        kind: 'task_confirm',
        project: values['project'],
        task_id: values['task'],
        expected_version: version,
        payload:
          values['runConfig'] === undefined
            ? {}
            : { run_config_digest: values['runConfig'] },
      },
      json,
      io,
    );
  },
};
