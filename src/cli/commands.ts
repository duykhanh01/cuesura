import { statusCommand } from './client.ts';
import { logsCommand } from './logs.ts';
import {
  addCommand,
  amendPolicyCommand,
  answerCommand,
  approveCommand,
  cancelCommand,
  confirmCommand,
  doctorCommand,
  explainCommand,
  historyCommand,
  inboxCommand,
  listCommand,
  proposeCommand,
  recheckCommand,
  retryCommand,
  showCommand,
  yoloCommand,
} from './tasks.ts';
import type { CliCommand } from './program.ts';

/** Every subcommand of `cusr` (contracts/cli-daemon.md "Lệnh và quyền"). */
export const CUSR_COMMANDS: readonly CliCommand[] = [
  statusCommand,
  doctorCommand,
  inboxCommand,
  answerCommand,
  yoloCommand,
  addCommand,
  showCommand,
  listCommand,
  explainCommand,
  historyCommand,
  logsCommand,
  proposeCommand,
  confirmCommand,
  cancelCommand,
  recheckCommand,
  approveCommand,
  retryCommand,
  amendPolicyCommand,
];
