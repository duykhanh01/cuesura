import type { CliCommand } from './program.ts';
import { renderProjects } from './render.ts';
import { DATA_DIR, query } from './tasks.ts';

export const projectListCommand: CliCommand = {
  name: 'project list',
  description: 'List accessible projects and profiles.',
  help: `Examples:
  cusr project list
  cusr project list --json`,
  options: [DATA_DIR],
  run: (values, json, io) =>
    query(values, { kind: 'project_list' }, json, io, undefined, renderProjects),
};
