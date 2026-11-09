/**
 * The next step for a refused command (issue #258): the daemon adds `details.guidance` to a refusal
 * that has none, so a caller learns what to run next from the error alone. It is added when the reply
 * is sent, never stored, so a replayed refusal names the task's version at that moment.
 */
type ErrorShape = {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
};

/** What the reply knows about the command's task; `version` is null when no such task exists. */
export type GuidanceContext = {
  readonly taskId: string | null;
  readonly version: number | null;
};

function isStale(e: ErrorShape): boolean {
  return e.message === 'stale_version' || e.details['reason'] === 'stale_version';
}

/** Guidance for a caller held below the role a command needs (`authz.ts`). */
export function forbiddenGuidance(reason: unknown, required: unknown): string {
  if (reason === 'project')
    return `The command names another project than the task's (${String(required)}); send it with --project ${String(required)}, or leave --project out.`;
  if ((reason === 'role' && required === 'admin') || reason === 'not_admin')
    return 'This command needs the admin role, which only the user has. Do not retry it: give the command to the user to run.';
  return 'This caller may not run this command. Do not retry it: give the command to the user to run.';
}

export function withGuidance<E extends ErrorShape>(e: E, ctx: GuidanceContext): E {
  if (typeof e.details['guidance'] === 'string') return e;
  const explain = ctx.taskId === null ? null : `cusr task explain ${ctx.taskId}`;
  const look = explain === null ? '' : ` See what the task allows now with: ${explain}.`;
  let guidance: string | null = null;
  const extra: Record<string, unknown> = {};
  switch (e.code) {
    case 'conflict':
      if (isStale(e) && ctx.version !== null) {
        extra['version'] = ctx.version;
        guidance =
          `The task is at version ${ctx.version} now, so nothing was changed.${look} If the command ` +
          `still applies, send it again with --expected-version ${ctx.version}.`;
      } else if (e.message === 'already_answered')
        guidance = `The question already has an answer, so this one was not taken.${look}`;
      else if (e.details['reason'] === 'question_not_open')
        guidance = `The question is closed or was withdrawn by a new revision; answer an open question from cusr inbox instead.${look}`;
      else guidance = `The task's current state does not allow this command.${look}`;
      break;
    case 'rejected':
      guidance = `The task's current state does not allow this command.${look}`;
      break;
    case 'nothing_to_recheck': {
      const target = e.details['target'];
      guidance = `There is nothing to recheck${typeof target === 'string' ? ` for ${target}` : ''}; the task waits on something else.${look}`;
      break;
    }
    case 'forbidden':
      guidance = forbiddenGuidance(e.details['reason'], e.details['required']);
      break;
  }
  if (guidance === null) return e;
  return { ...e, details: { ...e.details, ...extra, guidance } };
}
