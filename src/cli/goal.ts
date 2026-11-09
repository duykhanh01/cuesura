/** `cusr goal …` (007, contracts/goal.md): goal commands and reads, through the daemon socket. */
import { readFileSync } from 'node:fs';
import { v7 as uuidv7 } from 'uuid';
import { DATA_DIR } from './base.ts';
import type { CliCommand, CliIo } from './program.ts';
import {
  call,
  commandMeta,
  print,
  query,
  readJsonFile,
  readText,
  REASON,
  REQUEST_ID,
  usage,
} from './tasks.ts';

type Values = Readonly<Record<string, string | undefined>>;

const ID = '019a0000-0000-7000-8000-0000000000a1';
const EXPECTED_VERSION = {
  flags: '--expected-version <n>',
  description: 'Expected goal version from cusr goal show',
};
const PROJECT = { flags: '--project <id>', description: "Project ID (default: the goal's)" };
const LEASE_NOTE =
  'From the assistant (CUSR_ACTOR=assistant) a goal write needs the session holding the lease: cusr assistant register --take.';

async function send(
  values: Values,
  kind: string,
  goalId: string | null,
  payload: unknown,
  json: boolean,
  io: CliIo,
): Promise<number> {
  let expected: number | null = null;
  if (kind !== 'goal_add') {
    const raw = values['expectedVersion'];
    const n = raw === undefined ? NaN : Number(raw);
    if (!Number.isInteger(n) || n < 0)
      return usage(`${kind.replace('_', ' ')} requires --expected-version`, json, io);
    expected = n;
  }
  const meta = commandMeta(values);
  if (typeof meta === 'string') return usage(meta, json, io);
  const requestId = values['requestId'] ?? uuidv7();
  return print(
    await call(
      values,
      '/v1/command',
      {
        request_id: requestId,
        kind,
        project: values['project'] ?? null,
        task_id: null,
        goal_id: goalId,
        expected_version: expected,
        payload,
        ...meta,
      },
      requestId,
    ),
    json,
    io,
  );
}

/** Text from `--file` (`-` is stdin) or the flag itself. */
function textOf(values: Values, flag: string): string | null {
  const file = values['file'];
  if (file !== undefined) return readText(file);
  return values[flag] ?? null;
}

function planOf(values: Values): unknown {
  const file = values['plan'];
  if (file === undefined) return 'requires --plan <file>';
  if (file === '-') {
    try {
      return JSON.parse(readFileSync(0, 'utf8')) as unknown;
    } catch (e) {
      return `stdin: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return readJsonFile(file);
}

function planVersion(values: Values): number | null {
  const n = Number(values['planVersion']);
  return values['planVersion'] !== undefined && Number.isInteger(n) && n >= 0 ? n : null;
}

export const goalAddCommand: CliCommand = {
  name: 'goal add',
  description:
    'Give the deputy a goal from a request kept verbatim; it plans the work for your review',
  help: `The request is read from --file (- reads stdin) or --request. Without a deputy role the goal waits
for cusr goal propose. ${LEASE_NOTE}

Examples:
  cusr goal add --project acme --base main --file request.md --json
  echo "Export the report as CSV" | cusr goal add --project acme --base main --file - --json`,
  options: [
    DATA_DIR,
    REQUEST_ID,
    { flags: '--project <id>', description: 'Project ID from the user configuration' },
    { flags: '--base <branch>', description: 'Base branch the goal ends in' },
    { flags: '--request <text>', description: 'The request' },
    { flags: '--file <file>', description: 'Text file holding the request; - reads stdin' },
    { flags: '--single-task', description: 'Hint: one unit is enough' },
    { flags: '--hint <text>', description: 'A free hint for the plan (agent, model, mode…)' },
    REASON,
  ],
  run(values, json, io) {
    const request = textOf(values, 'request');
    if (values['project'] === undefined || values['base'] === undefined || request === null)
      return Promise.resolve(
        usage('goal add requires --project, --base and --request or --file', json, io),
      );
    const hints = {
      ...(values['singleTask'] === undefined ? {} : { single_task: true }),
      ...(values['hint'] === undefined ? {} : { note: values['hint'] }),
    };
    return send(
      values,
      'goal_add',
      null,
      {
        request,
        base_branch: values['base'],
        ...(Object.keys(hints).length === 0 ? {} : { hints }),
      },
      json,
      io,
    );
  },
};

export const goalReviseCommand: CliCommand = {
  name: 'goal revise',
  description: 'Replace the request of a goal; the plan is made again and confirmed again',
  help: `Plans built on the old request are refused afterwards. ${LEASE_NOTE}

Example:
  cusr goal revise ${ID} --expected-version 3 --file request.md --json`,
  args: ['<id>'],
  options: [
    DATA_DIR,
    REQUEST_ID,
    PROJECT,
    EXPECTED_VERSION,
    { flags: '--request <text>', description: 'The new request' },
    { flags: '--file <file>', description: 'Text file holding it; - reads stdin' },
    REASON,
  ],
  run(values, json, io) {
    const request = textOf(values, 'request');
    if (request === null)
      return Promise.resolve(usage('goal revise requires --request or --file', json, io));
    return send(values, 'goal_revise', values['id'] as string, { request }, json, io);
  },
};

export const goalNoteCommand: CliCommand = {
  name: 'goal note',
  description:
    "Add an entry to the goal's ledger: a directive from you, an observation from the deputy",
  help: `${LEASE_NOTE}

Example:
  cusr goal note ${ID} --expected-version 4 --text "Keep the JSON export unchanged" --json`,
  args: ['<id>'],
  options: [
    DATA_DIR,
    REQUEST_ID,
    PROJECT,
    EXPECTED_VERSION,
    { flags: '--text <text>', description: 'The note' },
    { flags: '--file <file>', description: 'Text file holding it; - reads stdin' },
    REASON,
  ],
  run(values, json, io) {
    const text = textOf(values, 'text');
    if (text === null)
      return Promise.resolve(usage('goal note requires --text or --file', json, io));
    return send(values, 'goal_note', values['id'] as string, { text }, json, io);
  },
};

const PLAN_OPTIONS = [
  DATA_DIR,
  REQUEST_ID,
  PROJECT,
  EXPECTED_VERSION,
  { flags: '--plan <file>', description: 'The plan as JSON (contracts/goal.md); - reads stdin' },
  { flags: '--plan-version <n>', description: 'The plan_version you read from cusr goal show' },
  REASON,
  { flags: '--hypothesis <text>', description: 'Deputy: what is believed to be wrong' },
  { flags: '--expect <text>', description: 'Deputy: what should be seen if the hypothesis holds' },
];

function planCommand(kind: 'goal_propose' | 'goal_amend') {
  return (values: Values, json: boolean, io: CliIo): Promise<number> => {
    const plan = planOf(values);
    if (typeof plan === 'string') return Promise.resolve(usage(plan, json, io));
    const v = planVersion(values);
    if (v === null)
      return Promise.resolve(usage('--plan-version must be a non-negative integer', json, io));
    return send(values, kind, values['id'] as string, { plan, plan_version: v }, json, io);
  };
}

export const goalProposeCommand: CliCommand = {
  name: 'goal propose',
  description: 'Propose the plan of a goal not yet confirmed; it waits for cusr goal confirm',
  help: `The reply carries plan_hash and parallel_groups. A plan_version older than the goal's is refused
as conflict plan_version.

Example:
  cusr goal propose ${ID} --expected-version 1 --plan plan.json --plan-version 0 --reason "first plan" --json`,
  args: ['<id>'],
  options: PLAN_OPTIONS,
  run: planCommand('goal_propose'),
};

export const goalAmendCommand: CliCommand = {
  name: 'goal amend',
  description:
    'Change a confirmed plan: execution changes apply at once, scope changes wait for confirmation',
  help: `Scope changes (units added or removed, title, description, acceptance, summary, non-goals, a wider
goal scope) hold the units they touch at their next step until cusr goal confirm.

Example:
  cusr goal amend ${ID} --expected-version 6 --plan plan.json --plan-version 1 --reason "split dependency" --json`,
  args: ['<id>'],
  options: PLAN_OPTIONS,
  run: planCommand('goal_amend'),
};

export const goalConfirmCommand: CliCommand = {
  name: 'goal confirm',
  description: 'Confirm the proposed plan or the pending amendment by its hash; units start',
  help: `A hash other than the current one is refused as conflict with the current hash. ${LEASE_NOTE}

Example:
  cusr goal confirm ${ID} --expected-version 2 --plan-hash sha256:… --json`,
  args: ['<id>'],
  options: [
    DATA_DIR,
    REQUEST_ID,
    PROJECT,
    EXPECTED_VERSION,
    { flags: '--plan-hash <hash>', description: 'plan_hash from cusr goal show' },
    REASON,
  ],
  run(values, json, io) {
    if (values['planHash'] === undefined)
      return Promise.resolve(usage('goal confirm requires --plan-hash', json, io));
    return send(
      values,
      'goal_confirm',
      values['id'] as string,
      { plan_hash: values['planHash'] },
      json,
      io,
    );
  },
};

export const goalCancelCommand: CliCommand = {
  name: 'goal cancel',
  description: 'Cancel a goal and every unfinished task of it',
  help: `${LEASE_NOTE}

Example:
  cusr goal cancel ${ID} --expected-version 7 --reason "not needed" --json`,
  args: ['<id>'],
  options: [DATA_DIR, REQUEST_ID, PROJECT, EXPECTED_VERSION, REASON],
  run: (values, json, io) =>
    send(
      values,
      'goal_cancel',
      values['id'] as string,
      values['reason'] === undefined ? {} : { reason: values['reason'] },
      json,
      io,
    ),
};

export const goalShowCommand: CliCommand = {
  name: 'goal show',
  description:
    'Show a goal: request, plan, parallel groups, version, hash, unit progress and incidents',
  help: `Any session may read; no lease needed. A task ID outside any goal shows as its implicit goal.

Example:
  cusr goal show ${ID} --json`,
  args: ['<id>'],
  options: [DATA_DIR],
  run: (values, json, io) => query(values, { kind: 'goal_show', goal_id: values['id'] }, json, io),
};

export const goalListCommand: CliCommand = {
  name: 'goal list',
  description: 'List open goals, or all with --all',
  help: `Example:\n  cusr goal list --project acme --json`,
  options: [
    DATA_DIR,
    { flags: '--project <id>', description: 'Only this project' },
    { flags: '--all', description: 'Include goals that ended' },
  ],
  run: (values, json, io) =>
    query(
      values,
      {
        kind: 'goal_list',
        ...(values['project'] === undefined ? {} : { project: values['project'] }),
        ...(values['all'] === undefined ? {} : { all: true }),
      },
      json,
      io,
    ),
};
