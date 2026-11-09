import type { CliCommand } from './program.ts';

/**
 * The commands of `cusr` by name, each loaded only when run: most modules pull in zod and yaml, which a
 * hook or `--version` must not pay for. Same names and order as `CUSR_COMMANDS`.
 */
export interface LazyCommand {
  readonly name: string;
  readonly load: () => Promise<CliCommand>;
}

type Commands<M> = { [K in keyof M]: M[K] extends CliCommand ? K : never }[keyof M];

function from<M>(load: () => Promise<M>) {
  return (name: string, key: Commands<M>): LazyCommand => ({
    name,
    load: async () => (await load())[key] as CliCommand,
  });
}

const init = from(() => import('./init.ts'));
const client = from(() => import('./client.ts'));
const tasks = from(() => import('./tasks.ts'));
const assistant = from(() => import('./assistant.ts'));
const logs = from(() => import('./logs.ts'));
const gateLogs = from(() => import('./gate-logs.ts'));
const requests = from(() => import('./requests.ts'));
const projects = from(() => import('./projects.ts'));
const report = from(() => import('./report.ts'));

export const LAZY_COMMANDS: readonly LazyCommand[] = [
  init('init', 'initCommand'),
  client('status', 'statusCommand'),
  tasks('doctor', 'doctorCommand'),
  tasks('dispatch', 'dispatchCommand'),
  tasks('inbox', 'inboxCommand'),
  assistant('assistant wait', 'assistantWaitCommand'),
  assistant('assistant register', 'assistantRegisterCommand'),
  assistant('assistant unregister', 'assistantUnregisterCommand'),
  assistant('assistant hook', 'assistantHookCommand'),
  assistant('assistant session-start', 'assistantSessionStartCommand'),
  tasks('answer', 'answerCommand'),
  tasks('yolo', 'yoloCommand'),
  tasks('task add', 'addCommand'),
  tasks('task show', 'showCommand'),
  tasks('task list', 'listCommand'),
  tasks('task explain', 'explainCommand'),
  tasks('task history', 'historyCommand'),
  logs('task logs', 'logsCommand'),
  gateLogs('task gates', 'gatesCommand'),
  gateLogs('task gate-log', 'gateLogCommand'),
  tasks('task propose', 'proposeCommand'),
  tasks('task confirm', 'confirmCommand'),
  tasks('task cancel', 'cancelCommand'),
  tasks('task recheck', 'recheckCommand'),
  tasks('task continue', 'continueCommand'),
  tasks('task pause', 'pauseCommand'),
  tasks('task resume', 'resumeCommand'),
  tasks('task message', 'messageCommand'),
  tasks('queue pause', 'queuePauseCommand'),
  tasks('queue resume', 'queueResumeCommand'),
  tasks('task approve', 'approveCommand'),
  tasks('task retry', 'retryCommand'),
  tasks('task amend-policy', 'amendPolicyCommand'),
  requests('request show', 'requestShowCommand'),
  projects('project list', 'projectListCommand'),
  tasks('task board', 'boardCommand'),
  report('report', 'reportCommand'),
  tasks('task content', 'contentCommand'),
  tasks('task progress', 'progressCommand'),
  tasks('task options', 'optionsCommand'),
];

const VALUE_GLOBALS = new Set(['--data-dir']);

/**
 * Only the command argv names, or none for a bare `--version`; anything else (help, a typo) gets them all
 * so commander can list and reject as before.
 */
export async function commandsFor(
  argv: readonly string[],
  all: readonly LazyCommand[] = LAZY_COMMANDS,
): Promise<CliCommand[]> {
  const words: string[] = [];
  let version = false;
  let help = false;
  for (let i = 0; i < argv.length && words.length < 2; i++) {
    const a = argv[i] as string;
    if (VALUE_GLOBALS.has(a)) i++;
    else if (a === '-V' || a === '--version') version = true;
    else if (a === '-h' || a === '--help') help = true;
    else if (!a.startsWith('-')) words.push(a);
  }
  if (words.length === 0 && version && !help) return [];
  const match =
    all.find((c) => words.length === 2 && c.name === words.join(' ')) ??
    all.find((c) => c.name === words[0]);
  if (match !== undefined) return [await match.load()];
  return Promise.all(all.map((c) => c.load()));
}
