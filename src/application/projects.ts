/**
 * `project_list` (FR-005): who the caller is and which projects the config declares, for an interface that
 * must not ask the user for a project name it could list. Names only: the config's credential references
 * and tool paths stay in the daemon.
 */
import { z } from 'zod';
import { validateConfig } from '../config/validate.ts';
import { trustedConfirmer } from '../domain/run-config.ts';
import { err, ok, type Result } from '../shared/result.ts';
import { authzContext, type Caller } from './authz.ts';
import type { ConfigInputs } from './confirm.ts';
import type { AppError } from './queries.ts';

const QuerySchema = z.object({ kind: z.literal('project_list') }).strict();

export type ProjectsDeps = {
  readonly configInputs: ConfigInputs;
  readonly now: () => number;
};

export async function projectList(
  deps: ProjectsDeps,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
): Promise<Result<unknown, AppError>> {
  if (!QuerySchema.safeParse(body).success)
    return err({
      code: 'invalid_request',
      message: 'project_list takes no parameters',
      details: {},
    });
  const { user } = await deps.configInputs();
  const validated = validateConfig({ user, packs: {} });
  if (!validated.ok)
    return err({
      code: 'config_invalid',
      message: 'the user config is invalid',
      details: {
        diagnostics: validated.error.map(
          (d) => `${d.file}:${d.line}:${d.col} ${d.code}: ${d.message}`,
        ),
      },
    });
  const { locations, config } = validated.value;
  const { grant } = caller;
  return ok({
    caller: {
      actor: grant.actor,
      roles: [...grant.roles],
      trusted_confirmer: trustedConfirmer(authzContext(caller, deps.now())),
    },
    projects: Object.keys(locations)
      .sort()
      .map((id) => ({ id, repo: locations[id]?.repo ?? null })),
    profiles: Object.keys(config.profiles).sort(),
  });
}
