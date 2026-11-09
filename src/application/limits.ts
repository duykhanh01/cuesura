/** Shared with the CLI, which must not load the schemas that sit beside these to start fast. */

export const BOARD_LIMIT = 100;

export const DOCTOR_CLIENT_TIMEOUT_MS = 45_000;

export const UNSUPPORTED_COMMANDS = ['task_retry', 'merge_approve', 'yolo'] as const;

/** What to do instead of an unsupported command (FR-021, FR-045.01/02). */
export const UNSUPPORTED_GUIDANCE: Readonly<Record<(typeof UNSUPPORTED_COMMANDS)[number], string>> =
  {
    task_retry: 'task retry is not part of this version; use task add for an independent task',
    merge_approve:
      'merge approval is not part of this version; merge the PR on GitHub, then wait for the observation or run task recheck',
    yolo: 'yolo has no command: set yolo: true in the user config, or merge the PR on GitHub, then wait for the observation or run task recheck',
  };
