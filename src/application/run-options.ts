/**
 * `run_options` (FR-025, R-07): the modes and bindings a run selection may name for one task. It runs the
 * code start runs, `freezePolicy` and `checkSelection`, instead of deriving a list from the config, so
 * what it offers cannot drift from what start accepts: a binding depends on the task through `when`, and
 * coder and fixer must take the same choice. `cusr.yaml` comes from the base ref this machine already has,
 * without a fetch; start reads the newest base and checks again, so this is a list to choose from and not
 * evidence. Prompts and attachments are stood in for: nothing frozen here is kept.
 */
import { z } from 'zod';
import type { ConfigSource } from '../config/yaml-loader.ts';
import { validateConfig } from '../config/validate.ts';
import type { ValidatedConfig } from '../domain/config.ts';
import type { FrozenPolicy } from '../domain/policy.ts';
import {
  EXECUTION_MODES,
  sameChoice,
  type ExecutionMode,
  type RunChoice,
  type RunSelection,
} from '../domain/run-config.ts';
import { isTerminal, type TaskState } from '../domain/state.ts';
import { freezePolicy, type FreezeError } from '../policy/freeze.ts';
import { UuidSchema } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import { authorize, type Caller } from './authz.ts';
import type { ConfirmDeps } from './confirm.ts';
import { readLocalBaseConfig } from './preflight.ts';
import type { AppError } from './queries.ts';
import { checkSelection } from './run-config.ts';

/** At most this many mode, worker and reviewer combinations are tried per task. */
export const RUN_OPTION_COMBINATIONS = 64;

const WORKER_ROLES = ['coder', 'fixer'];
const REVIEWER_ROLES = ['reviewer'];
const DIAGNOSTICS = 20;
const NO_REVIEWER: readonly (RunChoice | null)[] = [null];

const QuerySchema = z
  .object({ kind: z.literal('run_options'), task_id: UuidSchema })
  .strict();

export type RunOptionsDeps = Pick<
  ConfirmDeps,
  'store' | 'ports' | 'configInputs'
>;

const configInvalid = (
  message: string,
  diagnostics: string[] = [],
): AppError => ({
  code: 'config_invalid',
  message,
  details: { diagnostics: diagnostics.slice(0, DIAGNOSTICS) },
});

const choiceKey = (c: RunChoice): string =>
  `${c.harness}/${c.model}/${c.effort}`;

function unique(choices: readonly RunChoice[]): RunChoice[] {
  return [...new Map(choices.map((c) => [choiceKey(c), c])).values()];
}

/** Every binding the given roles declare, in the order of the config. */
function declared(
  config: ValidatedConfig,
  roles: readonly string[],
): RunChoice[] {
  const out: RunChoice[] = [];
  for (const role of roles)
    for (const rule of config.user.roles[role]?.binding ?? []) {
      const harness = config.user.models[rule.model]?.harness;
      if (harness !== undefined)
        out.push({ harness, model: rule.model, effort: rule.effort });
    }
  return unique(out);
}

/** Ladder rungs a worker step could escalate to, other than the choice itself. Denied rungs never run. */
function fallbacksOf(policy: FrozenPolicy, worker: RunChoice): RunChoice[] {
  const rungs = Object.values(policy.steps)
    .filter((s) => WORKER_ROLES.includes(s.role))
    .flatMap((s) => s.ladder)
    .filter((r) => r.state !== 'denied')
    .map((r) => ({
      harness: r.binding.harness,
      model: r.binding.model,
      effort: r.binding.effort,
    }));
  return unique(rungs).filter((c) => !sameChoice(worker, c));
}

function freezeProblem(e: FreezeError): string[] {
  return e.code === 'config_invalid'
    ? e.diagnostics.map((d) => `${d.code}: ${d.message}`)
    : [e.code];
}

type ModeOptions = {
  readonly mode: ExecutionMode;
  readonly when_to_use: string | null;
  readonly reviewers: RunChoice[];
  readonly workers: { choice: RunChoice; fallbacks: RunChoice[] }[];
};

function optionsForMode(
  s: TaskState,
  config: ValidatedConfig,
  baseSha: string,
  profile: string,
  mode: ExecutionMode,
  whenToUse: string | null,
  budget: { left: number; skipped: boolean },
  problems: string[],
): ModeOptions {
  const workers = new Map<
    string,
    { choice: RunChoice; fallbacks: RunChoice[] }
  >();
  const reviewers = new Map<string, RunChoice>();
  const workerChoices = declared(config, WORKER_ROLES);
  const reviewerChoices =
    mode === 'full-review' ? declared(config, REVIEWER_ROLES) : NO_REVIEWER;
  // Stand-ins: a missing document fails the freeze, but its content is not what is being checked.
  const prompts = Object.values(config.user.roles).flatMap((r) =>
    r.prompt === null ? [] : [{ name: r.prompt, content: '' }],
  );
  const conventions = (config.project?.conventions ?? []).map((name) => ({
    name,
    content: '',
  }));
  const attachments = s.task.attachments.map((a) => ({
    name: a.name,
    media_type: a.media_type,
    content: '',
  }));
  for (const worker of workerChoices)
    for (const reviewer of reviewerChoices) {
      if (budget.left <= 0) {
        budget.skipped = true;
        break;
      }
      budget.left -= 1;
      const frozen = freezePolicy({
        config,
        task: s.task,
        base_sha: baseSha,
        attachments,
        prompts,
        conventions,
        mode,
        selection: { worker, reviewer },
      });
      if (!frozen.ok) {
        problems.push(...freezeProblem(frozen.error));
        continue;
      }
      const selection: RunSelection = {
        task_id: s.id,
        revision: s.revision,
        profile,
        mode,
        reason: '',
        worker,
        reviewer,
        fallbacks: [],
      };
      if (checkSelection(frozen.value.policy, selection).length > 0) continue;
      workers.set(choiceKey(worker), {
        choice: worker,
        fallbacks: fallbacksOf(frozen.value.policy, worker),
      });
      if (reviewer !== null) reviewers.set(choiceKey(reviewer), reviewer);
    }
  return {
    mode,
    when_to_use: whenToUse,
    reviewers: [...reviewers.values()],
    workers: [...workers.values()],
  };
}

export async function runOptions(
  deps: RunOptionsDeps,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
): Promise<Result<unknown, AppError>> {
  const q = QuerySchema.safeParse(body);
  if (!q.success)
    return err({
      code: 'invalid_request',
      message: 'task_id is required',
      details: {},
    });
  const s = deps.store.readTask(q.data.task_id);
  if (s === null || !authorize(caller, { role: 'read', project: s.project }).ok)
    return err({
      code: 'task_not_found',
      message: `no task ${q.data.task_id}`,
      details: {},
    });
  if (s.policy_ref !== null || isTerminal(s.status))
    return err({
      code: 'conflict',
      message: 'the run config of this task can no longer change',
      details: { status: s.status },
    });

  const { user, packs } = await deps.configInputs();
  const userOnly = validateConfig({ user, packs: {} });
  if (!userOnly.ok)
    return err(
      configInvalid(
        'the user config is invalid',
        userOnly.error.map((d) => `${d.code}: ${d.message}`),
      ),
    );
  const path = userOnly.value.locations[s.project]?.path ?? null;
  if (path === null)
    return err(
      configInvalid(`projects.${s.project}.path is not set in the user config`),
    );

  const base = await readLocalBaseConfig(
    deps.ports.git,
    path,
    s.task.base_branch,
  );
  if (!base.ok)
    return err(
      base.error.kind === 'invalid'
        ? configInvalid(base.error.detail)
        : {
            code: 'options_unavailable',
            message: base.error.detail,
            details: {},
          },
    );
  const project: ConfigSource | null = base.value.config;
  const validated = validateConfig({
    user,
    ...(project === null ? {} : { project }),
    packs,
  });
  if (!validated.ok)
    return err(
      configInvalid(
        `the config at base ${base.value.base_sha} is invalid`,
        validated.error.map((d) => `${d.code}: ${d.message}`),
      ),
    );
  const { config, runtime } = validated.value;
  if (runtime === null)
    return err(configInvalid('the `runtime:` section is required by cusrd'));

  const profile = s.task.profile ?? config.project?.profile ?? null;
  if (profile === null)
    return err(
      configInvalid(
        'neither the task nor the project selects a profile; set `profile:` in cusr.yaml',
      ),
    );

  const budget = { left: RUN_OPTION_COMBINATIONS, skipped: false };
  const problems: string[] = [];
  const modes = EXECUTION_MODES.flatMap((mode) => {
    const allowed = runtime.modes[mode];
    return allowed === undefined
      ? []
      : [
          optionsForMode(
            s,
            config,
            base.value.base_sha,
            profile,
            mode,
            allowed.when_to_use,
            budget,
            problems,
          ),
        ];
  });
  // Nothing froze at all: the config is the problem, not the choices.
  if (problems.length > 0 && modes.every((m) => m.workers.length === 0))
    return err(
      configInvalid('no run selection can be frozen for this task', [
        ...new Set(problems),
      ]),
    );
  return ok({
    task_id: s.id,
    revision: s.revision,
    version: s.version,
    profile: {
      id: profile,
      source: s.task.profile === null ? 'project' : 'task',
    },
    modes,
    truncated: budget.skipped,
  });
}
