import type { AppError } from './queries.ts';

/** The refusal of a task query whose `task_id` is missing or is not a task ID. */
export function badTaskId(body: Readonly<Record<string, unknown>>): AppError {
  const given = body['task_id'];
  if (typeof given !== 'string' || given === '')
    return { code: 'invalid_request', message: 'task_id is required', details: {} };
  return {
    code: 'invalid_request',
    message: `task_id ${JSON.stringify(given)} is not a task ID`,
    details: {
      guidance:
        'A task ID is the full UUID, e.g. 019a0000-0000-7000-8000-000000000001; find it with: cusr task list',
    },
  };
}
