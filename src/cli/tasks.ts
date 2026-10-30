/**
 * Task commands over the control socket (T048, T108–T115). Every call carries the caller's token; the CLI
 * never opens the database. Syntax and schema errors stop here, before anything reaches the daemon. A
 * mutation has a request ID, generated when not given and printed back in every outcome, so a caller can
 * replay it after a timeout and get the first result.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { stringify } from 'yaml';
import {
  CONTROL_SOCKET,
  errorEnvelope,
  renderEnvelope,
  type Envelope,
} from './output.ts';
import { callDaemon, readClientToken, resolveDataDir } from './client.ts';
import { exitCodeFor } from './errors.ts';
import { UNSUPPORTED_GUIDANCE } from '../application/commands.ts';
import { DOCTOR_CLIENT_TIMEOUT_MS } from '../application/doctor.ts';
import type { CliCommand, CliIo } from './program.ts';

type Values = Readonly<Record<string, string | undefined>>;

const DATA_DIR = {
  flags: '--data-dir <dir>',
  description: 'daemon data directory (default $CUSR_DATA_DIR or ~/.cusr)',
};

/** One call to the daemon; a transport failure comes back as an envelope too, with the exit it maps to. */
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
    code:
      reply.error.code === 'token' ? 'token_unavailable' : 'daemon_unreachable',
    message: reply.error.message,
    details: {},
    request_id: requestId,
  });
}

export function print(envelope: Envelope, json: boolean, io: CliIo): number {
  if (json) io.stdout(renderEnvelope(envelope));
  else if (envelope.ok) io.stdout(stringify(envelope.data));
  else {
    const id = envelope.error.request_id;
    io.stderr(
      `cusr: ${envelope.error.code}: ${envelope.error.message}${id === null ? '' : ` (request ${id})`}\n`,
    );
    const guidance = envelope.error.details['guidance'];
    if (typeof guidance === 'string') io.stderr(`cusr: ${guidance}\n`);
    const checks = envelope.error.details['checks'] as
      | { name: string; status: string; detail: string; fix: string | null }[]
      | undefined;
    for (const c of checks ?? [])
      if (c.status === 'fail')
        io.stderr(
          `cusr: ${c.name}: ${c.detail}${c.fix === null ? '' : `; fix: ${c.fix}`}\n`,
        );
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
  values: Values,
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
  description: 'idempotency key (default: a new UUIDv7, printed in the result)',
};
const EXPECTED_VERSION = {
  flags: '--expected-version <n>',
  description: 'task version you saw (from task show)',
};
const PROJECT = {
  flags: '--project <id>',
  description: 'project of the task (default: looked up from the task)',
};

function version(values: Values): number | null {
  const raw = values['expectedVersion'];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Sends one mutation of an existing task, looking its project up first unless `--project` names it. */
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
    return usage(`${kind} needs --expected-version N`, json, io);
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
      return print(
        { ...shown, error: { ...shown.error, request_id: requestId } },
        json,
        io,
      );
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

async function query(
  values: Values,
  body: Record<string, unknown>,
  json: boolean,
  io: CliIo,
  timeoutMs?: number,
): Promise<number> {
  return print(
    await call(values, '/v1/query', body, null, timeoutMs),
    json,
    io,
  );
}

/** The JSON task input of `task add --file` (contracts/cli-daemon.md); the daemon validates its fields. */
function readJsonFile(path: string): Record<string, unknown> | string {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : `${path} does not hold a JSON object`;
  } catch (e) {
    return `cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export const addCommand: CliCommand = {
  name: 'task add',
  description: 'add a task from --file or flags; does not wait for a PR',
  options: [
    DATA_DIR,
    REQUEST_ID,
    {
      flags: '--file <file>',
      description:
        'JSON task input: project, title, base_branch, acceptance, …',
    },
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
        return usage(
          'task add needs a project in --file or --project',
          json,
          io,
        );
    } else {
      const { title, base } = values;
      if (project === undefined || title === undefined || base === undefined)
        return usage(
          'task add needs --file, or --project, --title and --base',
          json,
          io,
        );
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
        ...(values['priority'] === undefined
          ? {}
          : { priority: Number(values['priority']) }),
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
  description:
    'show a task: status, step, wait, version, PR, head, usage and evidence sources',
  args: ['<id>'],
  options: [DATA_DIR],
  run: (values, json, io) =>
    query(values, { kind: 'task_show', task_id: values['id'] }, json, io),
};

export const listCommand: CliCommand = {
  name: 'task list',
  description: 'list tasks you may read, at most 100 per page',
  options: [
    DATA_DIR,
    { flags: '--limit <n>', description: 'page size, at most 100' },
    { flags: '--cursor <id>', description: 'next_cursor of the previous page' },
    { flags: '--project <id>', description: 'only this project' },
    { flags: '--status <status>', description: 'only this status' },
  ],
  run(values, json, io) {
    const limit =
      values['limit'] === undefined ? undefined : Number(values['limit']);
    if (limit !== undefined && !Number.isInteger(limit))
      return Promise.resolve(usage('--limit needs a whole number', json, io));
    return query(
      values,
      {
        kind: 'task_list',
        ...(limit === undefined ? {} : { limit }),
        ...(values['cursor'] === undefined ? {} : { cursor: values['cursor'] }),
        ...(values['project'] === undefined
          ? {}
          : { project: values['project'] }),
        ...(values['status'] === undefined ? {} : { status: values['status'] }),
      },
      json,
      io,
    );
  },
};

export const explainCommand: CliCommand = {
  name: 'task explain',
  description:
    'why a task waits, what ways out it has and which limits are spent; never calls a model',
  args: ['<id>'],
  options: [DATA_DIR],
  run: (values, json, io) =>
    query(values, { kind: 'task_explain', task_id: values['id'] }, json, io),
};

export const historyCommand: CliCommand = {
  name: 'task history',
  description: 'the accepted events of a task, in order',
  args: ['<id>'],
  options: [
    DATA_DIR,
    { flags: '--after <seq>', description: 'only events after this seq' },
    { flags: '--limit <n>', description: 'page size, at most 500' },
  ],
  run(values, json, io) {
    const after =
      values['after'] === undefined ? undefined : Number(values['after']);
    const limit =
      values['limit'] === undefined ? undefined : Number(values['limit']);
    if (
      (after !== undefined && !Number.isInteger(after)) ||
      (limit !== undefined && !Number.isInteger(limit))
    )
      return Promise.resolve(
        usage('--after and --limit need whole numbers', json, io),
      );
    return query(
      values,
      {
        kind: 'task_history',
        task_id: values['id'],
        ...(after === undefined ? {} : { after }),
        ...(limit === undefined ? {} : { limit }),
      },
      json,
      io,
    );
  },
};

export const proposeCommand: CliCommand = {
  name: 'task propose',
  description:
    'propose the mode and harness/model/effort a task runs with (confirmed separately)',
  args: ['<id>'],
  options: [DATA_DIR, REQUEST_ID, PROJECT, EXPECTED_VERSION, ...RUN_OPTIONS],
  run(values, json, io) {
    const run = runProposal(values);
    if (run === undefined || typeof run === 'string')
      return Promise.resolve(
        usage(
          run ?? 'task propose needs --profile, --mode and --worker',
          json,
          io,
        ),
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
    'confirm a task (and, with --run-config, the run selection shown by show) and re-check its config',
  args: ['<id>'],
  options: [
    DATA_DIR,
    REQUEST_ID,
    PROJECT,
    EXPECTED_VERSION,
    {
      flags: '--run-config <digest>',
      description:
        'digest of the run selection you reviewed (owner token only)',
    },
  ],
  run: (values, json, io) =>
    mutate(
      values,
      'task_confirm',
      values['id'] as string,
      values['runConfig'] === undefined
        ? {}
        : { run_config_digest: values['runConfig'] },
      json,
      io,
    ),
};

export const cancelCommand: CliCommand = {
  name: 'task cancel',
  description:
    'cancel a task; nothing sent is taken back and a merge already made still ends DONE',
  args: ['<id>'],
  options: [
    DATA_DIR,
    REQUEST_ID,
    PROJECT,
    EXPECTED_VERSION,
    { flags: '--reason <text>', description: 'why (recorded in the history)' },
  ],
  run: (values, json, io) =>
    mutate(
      values,
      'task_cancel',
      values['id'] as string,
      { reason: values['reason'] ?? 'cancelled from the CLI' },
      json,
      io,
    ),
};

export const recheckCommand: CliCommand = {
  name: 'task recheck',
  description:
    'one bounded check chosen from the task state (config, PR, drain or worktree); no agent, merge or new head',
  args: ['<id>'],
  options: [DATA_DIR, REQUEST_ID, PROJECT, EXPECTED_VERSION],
  run: (values, json, io) =>
    mutate(values, 'task_recheck', values['id'] as string, {}, json, io),
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
  description: 'approve an escalation (admin); merge approval is not supported',
  args: ['<id>'],
  options: [
    DATA_DIR,
    REQUEST_ID,
    PROJECT,
    EXPECTED_VERSION,
    { flags: '--kind <kind>', description: 'escalation' },
    { flags: '--step <step>', description: 'step of the escalation' },
    { flags: '--rung <n>', description: 'rung of the escalation' },
  ],
  run(values, json, io) {
    if (values['kind'] === 'merge')
      return unsupported('merge_approve', json, io);
    const rung = values['rung'] === undefined ? NaN : Number(values['rung']);
    if (
      values['kind'] !== 'escalation' ||
      values['step'] === undefined ||
      !Number.isInteger(rung)
    )
      return Promise.resolve(
        usage(
          'task approve needs --kind escalation, --step and --rung',
          json,
          io,
        ),
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
  description: 'not supported: use task add for an independent task',
  args: ['[id]'],
  options: [DATA_DIR, REQUEST_ID, EXPECTED_VERSION],
  run: (_values, json, io) => unsupported('task_retry', json, io),
};

export const amendPolicyCommand: CliCommand = {
  name: 'task amend-policy',
  description: 'not supported: cancel and use task add with the new config',
  args: ['[id]'],
  options: [DATA_DIR, REQUEST_ID, EXPECTED_VERSION],
  run: (_values, json, io) => unsupported('task_amend_policy', json, io),
};

export const yoloCommand: CliCommand = {
  name: 'yolo',
  description: 'not supported: merge the PR on GitHub, then task recheck',
  args: ['[id]'],
  options: [DATA_DIR],
  run: (_values, json, io) => unsupported('yolo', json, io),
};

export const inboxCommand: CliCommand = {
  name: 'inbox',
  description: 'open questions of the tasks you may read',
  options: [
    DATA_DIR,
    { flags: '--project <id>', description: 'only this project' },
    { flags: '--task <id>', description: 'only this task' },
  ],
  run: (values, json, io) =>
    query(
      values,
      {
        kind: 'inbox',
        ...(values['project'] === undefined
          ? {}
          : { project: values['project'] }),
        ...(values['task'] === undefined ? {} : { task_id: values['task'] }),
      },
      json,
      io,
    ),
};

export const answerCommand: CliCommand = {
  name: 'answer',
  description:
    'answer a question from a text file; the first valid answer wins',
  args: ['<question>'],
  options: [
    DATA_DIR,
    REQUEST_ID,
    EXPECTED_VERSION,
    { flags: '--file <file>', description: 'file holding the answer' },
  ],
  async run(values, json, io) {
    const expected = version(values);
    if (values['file'] === undefined || expected === null)
      return usage('answer needs --file and --expected-version N', json, io);
    let answer: string;
    try {
      answer = readFileSync(values['file'], 'utf8').trimEnd();
    } catch (e) {
      return usage(
        `cannot read ${values['file']}: ${e instanceof Error ? e.message : String(e)}`,
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
      return print(
        { ...where, error: { ...where.error, request_id: requestId } },
        json,
        io,
      );
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
  description:
    'check the store, recovery, host, sandbox, paths, credentials and manifests; no model, sudo or provisioning',
  options: [
    DATA_DIR,
    { flags: '--project <id>', description: 'also check this project' },
  ],
  run: (values, json, io) =>
    query(
      values,
      {
        kind: 'doctor',
        ...(values['project'] === undefined
          ? {}
          : { project: values['project'] }),
      },
      json,
      io,
      DOCTOR_CLIENT_TIMEOUT_MS,
    ),
};
