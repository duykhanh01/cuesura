import type { Hash } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { ValidatedConfig } from '../domain/config.ts';
import type { AuthzContext } from '../domain/policy.ts';
import {
  computeRuntimeHash,
  FrozenRuntimeContextSchema,
  RUNTIME_SCHEMA_VERSION,
  type FrozenRuntimeContext,
} from '../domain/runtime.ts';
import type { MergeMethod } from '../domain/merge-method.ts';
import type {
  ExecutionMode,
  PrTemplate,
  RunConfigSnapshot,
  RunSelection,
} from '../domain/run-config.ts';
import type { CanonicalTask } from '../domain/task.ts';
import { DAEMON_COMPLETION_MODE } from './capabilities.ts';
import type { DocContent } from '../policy/finalize.ts';
import {
  freezePolicy,
  type AttachmentContent,
  type Frozen,
  type FreezeError,
} from '../policy/freeze.ts';
import type { Locator } from './checks.ts';
import { applyOverrides, type TaskOverrides } from './merge.ts';
import type { RuntimeConfig } from './normalize.ts';
import { analyze } from './validate.ts';
import { DEFAULT_LIMITS } from './yaml-loader.ts';

export type FreezeInput = {
  config: ValidatedConfig;
  task: CanonicalTask;
  overrides?: TaskOverrides;
  caller: AuthzContext;
  base_sha: string;
  attachments: AttachmentContent[];
  prompts?: DocContent[];
  conventions?: DocContent[];
  mode?: ExecutionMode;
  selection?: Pick<RunSelection, 'worker' | 'reviewer'>;
};

const atOverrides: Locator = () => ({ file: '<overrides>', line: 1, col: 1 });

/**
 * Apply overrides to the raw configuration, then validate again. Policy freezing stays in
 * src/policy so the pure policy layer does not depend on config I/O.
 */
export function freeze(input: FreezeInput): Result<Frozen, FreezeError> {
  const overrides = input.overrides ?? {};
  const profileName = input.task.profile ?? input.config.project?.profile ?? null;
  if (
    Object.keys(overrides).length === 0 ||
    profileName === null ||
    !(profileName in input.config.profiles)
  ) {
    return freezePolicy(input);
  }

  const { raw, hashes, files } = input.config;
  const profile = input.config.profiles[profileName];
  const applied = applyOverrides(
    {
      roles: (raw.user.roles ?? {}) as Record<string, unknown>,
      profile: raw.profiles[profileName] ?? {},
      project: raw.project ?? {},
    },
    overrides,
    profile?.overridable ?? [],
    input.caller,
  );
  if (!applied.ok) {
    return applied.error.code === 'override_not_allowed'
      ? err({ code: 'config_invalid', diagnostics: applied.error.diagnostics })
      : err({ code: 'override_exceeds_caller', keys: applied.error.keys });
  }

  const user = {
    ...raw.user,
    roles: applied.value.roles,
    profiles: { ...raw.profiles, [profileName]: applied.value.profile },
  };
  const project = raw.project === null ? null : applied.value.project;
  const re = analyze({
    user,
    project,
    hasProject: project !== null,
    atUser: atOverrides,
    atProject: atOverrides,
    files,
    packHashes: hashes.packs,
    maxProfileDepth: DEFAULT_LIMITS.max_profile_depth,
  });
  if (!re.ok) return err({ code: 'config_invalid', diagnostics: re.error });
  // File hashes stay unchanged; normalized overrides contribute to config_hashes.effective.
  return freezePolicy({ ...input, config: { ...re.value.config, hashes } });
}

export type RuntimeFreezeInput = {
  runtime: RuntimeConfig;
  task_id: string;
  revision: number;
  base_sha: string;

  project_path: string;
  target: { repo: string; immutable_repo_id: string; base_ref: string };

  capability_refs: Record<string, Hash>;
  run_config?: RunConfigSnapshot;
  pr_template?: PrTemplate | null;
  review_template?: PrTemplate;
  merge_method?: MergeMethod;
  role_prompts?: Readonly<Record<string, string>>;
  setup_commands?: readonly string[];
};

export type RuntimeFreezeError = {
  code: 'runtime_invalid';
  issues: { path: (string | number)[]; message: string }[];
};

/**
 * Freeze runtime separately so policy and execution-context hashes stay unchanged. Store
 * credential references only.
 */
export function freezeRuntimeContext(
  input: RuntimeFreezeInput,
): Result<FrozenRuntimeContext, RuntimeFreezeError> {
  const body: Omit<FrozenRuntimeContext, 'runtime_hash'> = {
    schema_version: RUNTIME_SCHEMA_VERSION,
    task_id: input.task_id,
    revision: input.revision,
    base_sha: input.base_sha,
    completion_mode: DAEMON_COMPLETION_MODE,
    network_mode: 'internet_outbound',
    isolation: { mode: 'native', provider: 'host' },
    project_path: input.project_path,
    target: { provider: 'github', ...input.target },
    limits: { ...input.runtime.limits },
    capability_refs: { ...input.capability_refs },
    credential_refs: input.runtime.credential_refs.map((c) => ({
      name: c.name,
      file: c.file,
    })),
    ...(input.run_config === undefined ? {} : { run_config: structuredClone(input.run_config) }),
    ...(input.pr_template === undefined ? {} : { pr_template: input.pr_template }),
    ...(input.review_template === undefined ? {} : { review_template: input.review_template }),
    ...(input.merge_method === undefined ? {} : { merge_method: input.merge_method }),
    ...(input.role_prompts === undefined ? {} : { role_prompts: { ...input.role_prompts } }),
    ...(input.setup_commands === undefined || input.setup_commands.length === 0
      ? {}
      : { setup_commands: [...input.setup_commands] }),
  };
  const parsed = FrozenRuntimeContextSchema.safeParse({
    ...body,
    runtime_hash: computeRuntimeHash(body),
  });
  if (!parsed.success) {
    return err({
      code: 'runtime_invalid',
      issues: parsed.error.issues.map((i) => ({
        path: i.path as (string | number)[],
        message: i.message,
      })),
    });
  }
  return ok(parsed.data);
}
