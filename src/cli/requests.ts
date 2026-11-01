import type { CliCommand } from './program.ts';
import { renderRequest } from './render.ts';
import { DATA_DIR, query } from './tasks.ts';

export const requestShowCommand: CliCommand = {
  name: 'request show',
  description: 'Show the status and result of a submitted request.',
  help: `Notes:
  A request that was found exits 0, even if its operation was rejected: the lookup itself succeeded.
  Read the first line of the output, or outcome.ok with --json, to see what happened to the operation.

Example:
  cusr request show 019a0000-0000-7000-8000-000000000001`,
  args: ['<request_id>'],
  options: [DATA_DIR],
  run: (values, json, io) =>
    query(
      values,
      { kind: 'request_show', request_id: values['request_id'] },
      json,
      io,
      undefined,
      renderRequest,
    ),
};
