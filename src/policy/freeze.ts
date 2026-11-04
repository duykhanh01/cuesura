import { hashCanonical } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type {
  Diagnostic,
  DiagnosticCode,
  NormalizedProfile,
  ValidatedConfig,
} from '../domain/config.ts';
import {
  FrozenPolicySchema,
  type Binding,
  type FrozenExecutionContext,
  type FrozenPolicy,
  type Limits,
  type StepPolicy,
} from '../domain/policy.ts';
import type { CanonicalTask } from '../domain/task.ts';
import { isAgentStep, type StepDef, type Workflow } from '../domain/workflow.ts';
import { sameChoice, type ExecutionMode, type RunSelection } from '../domain/run-config.ts';
import {
  modeGraph,
  modeWorkflowName,
  SOFTWARE_DEV_NAME,
} from '../engine/workflows/software-dev.ts';
import { bindingFacts, resolveBinding } from './binding.ts';
import { finalizeContext, finalizePolicy, type DocContent } from './finalize.ts';
import { buildLadder, computeFloorMaps, type EscalationPolicy } from './ladder.ts';
import { structureHash } from './structure-hash.ts';

export type FreezeError =
  | { code: 'config_invalid'; diagnostics: Diagnostic[] }
  | { code: 'no_valid_binding'; step: string; role: string }
  | { code: 'override_exceeds_caller'; keys: string[] };

export type AttachmentContent = {
  name: string;
  media_type: string;
  content: string;
};

export type FreezePolicyInput = {
  config: ValidatedConfig;
  task: CanonicalTask;
  base_sha: string;
  attachments: AttachmentContent[];
  /**
   * Prompt contents keyed by configured name. The caller reads files; the pure core only snapshots
   * their contents.
   */
  prompts?: DocContent[];

  conventions?: DocContent[];
  /** 002: the confirmed execution mode; the graph is then `software_dev@2:<mode>` (task-execution-modes.md). */
  mode?: ExecutionMode;
  /** 002: the confirmed bindings; each picks among the rules its role declares, it adds none. */
  selection?: Pick<RunSelection, 'worker' | 'reviewer'>;
};

export type Frozen = { policy: FrozenPolicy; context: FrozenExecutionContext };

function invalid(
  file: string,
  code: DiagnosticCode,
  path: (string | number)[],
  message: string,
): Result<never, FreezeError> {
  return err({
    code: 'config_invalid',
    diagnostics: [{ code, severity: 'error', file, line: 1, col: 1, path, message }],
  });
}

/**
 * Deduplicate and sort referenced documents. Missing content prevents all snapshots from being
 * frozen.
 */
function snapshotDocs(
  names: readonly (string | null)[],
  provided: readonly DocContent[],
  kind: 'prompts' | 'conventions',
): Result<DocContent[], FreezeError> {
  const wanted = [...new Set(names.filter((n): n is string => n !== null))].sort();
  const out: DocContent[] = [];
  for (const name of wanted) {
    const doc = provided.find((d) => d.name === name);
    if (doc === undefined)
      return invalid(
        `<${kind}>`,
        'schema_invalid',
        [kind, name],
        `Content for '${name}' is required to freeze the context`,
      );
    out.push({ name: doc.name, content: doc.content });
  }
  return ok(out);
}

function stepBinding(
  config: ValidatedConfig,
  profile: NormalizedProfile,
  name: string,
  step: StepDef,
  task: CanonicalTask,
  selection: FreezePolicyInput['selection'],
): Result<StepPolicy, FreezeError> {
  const roleName = step.role as string;
  const role = config.user.roles[roleName];
  const noBinding = err({
    code: 'no_valid_binding' as const,
    step: name,
    role: roleName,
  });
  if (role === undefined) return noBinding;
  if (profile.allow_roles !== null && !profile.allow_roles.includes(roleName)) return noBinding;
  const facts = bindingFacts(task);
  const wanted =
    roleName === 'coder' || roleName === 'fixer'
      ? selection?.worker
      : roleName === 'reviewer'
        ? selection?.reviewer
        : null;
  const confirmed = role.binding.filter((rule) => {
    const harness = config.user.models[rule.model]?.harness;
    return (
      wanted != null &&
      harness !== undefined &&
      sameChoice(wanted, { harness, model: rule.model, effort: rule.effort })
    );
  });
  // No declared rule matches: the first one stands and `checkSelection` reports the mismatch.
  const chosen =
    resolveBinding(confirmed, facts, profile.allow_models) ??
    resolveBinding(role.binding, facts, profile.allow_models);
  if (chosen === null) return noBinding;

  const model = config.user.models[chosen.rule.model];
  if (model === undefined) return noBinding;
  // Reviewers are always read-only; user configuration can lower role permissions, never raise them.
  const readOnly =
    step.kind === 'review' ||
    role.permissions === 'read_only' ||
    config.user.permissions[roleName] === 'read_only';
  const initial: Binding = {
    harness: model.harness,
    model: chosen.rule.model,
    model_id: model.id,
    effort: chosen.rule.effort,
    add_context: [],
    permissions: readOnly ? 'read_only' : 'write',
    limits: role.limits,
  };
  const esc: EscalationPolicy = {
    auto_up_to_tier: profile.escalation.auto_up_to_tier,
    above: profile.escalation.above,
    allow_models: profile.allow_models,
  };
  const steps = profile.escalation.enabled
    ? role.ladder.slice(0, step.max_rung ?? role.ladder.length)
    : [];
  const ladder = buildLadder(initial, steps, config.user.models, esc);
  return ok({
    role: roleName,
    binding: initial,
    ladder,
    floor_map: {},
    escalation_scope: role.scope,
  });
}

function gatesOf(
  config: ValidatedConfig,
  profile: NormalizedProfile,
  w: Workflow,
): Result<FrozenPolicy['gates'], FreezeError> {
  const file = config.files.project ?? '<project>';
  const project = config.project;
  const commands: Record<string, string> = {
    ...(project?.gates ?? {}),
    ...(project?.autofix ?? {}),
  };
  if (Object.keys(project?.gates ?? {}).length === 0 && !profile.allow_no_gates) {
    return invalid(
      file,
      'no_gates_not_allowed',
      ['gates'],
      'The project declares no gates and the profile does not enable allow_no_gates',
    );
  }
  const by_step: FrozenPolicy['gates']['by_step'] = {};
  for (const [name, step] of Object.entries(w.steps)) {
    if (step.kind !== 'gate') continue;
    const run = step.run ?? [];
    // Without required, all declared gates in run are mandatory; undeclared gates remain optional and are skipped.

    const required = step.required ?? run.filter((g) => g in commands);
    const missing = required.find((g) => !(g in commands));
    if (missing !== undefined) {
      return invalid(
        file,
        'required_gate_missing',
        ['gates'],
        `Required gate '${missing}' used by step '${name}' is not declared`,
      );
    }

    by_step[name] = {
      run: run.filter((g) => g in commands),
      required,
      skipped: run.filter((g) => !(g in commands)),
    };
  }
  return ok({ commands, by_step });
}

/**
 * Freeze policy and execution context atomically for one revision. Only the selected workflow is
 * checked; any snapshot failure returns neither snapshot. Configuration overrides must already be
 * applied.
 */
export function freezePolicy(input: FreezePolicyInput): Result<Frozen, FreezeError> {
  const { config, task } = input;
  const userFile = config.files.user;

  const profileName = task.profile ?? config.project?.profile ?? null;
  if (profileName === null)
    return invalid(
      userFile,
      'unknown_profile',
      ['profile'],
      'Neither the task nor the project selects a profile',
    );
  const profile = config.profiles[profileName];
  if (profile === undefined)
    return invalid(
      userFile,
      'unknown_profile',
      ['profiles', profileName],
      `Profile '${profileName}' does not exist`,
    );
  const projects = config.user.projects;
  if (projects !== null && !(task.project in projects)) {
    return invalid(
      userFile,
      'schema_invalid',
      ['projects', task.project],
      `Project '${task.project}' is not in the repository allowlist`,
    );
  }
  const workflowName = profile.workflow as string;
  const configured = config.user.workflows[workflowName];
  if (configured === undefined)
    return invalid(
      userFile,
      'schema_invalid',
      ['profiles', profileName, 'workflow'],
      `Workflow '${workflowName}' does not exist`,
    );

  const workflow = input.mode === undefined ? configured : modeGraph(configured, input.mode);

  const steps: Record<string, StepPolicy> = {};
  for (const name of Object.keys(workflow.steps).sort()) {
    const step = workflow.steps[name] as StepDef;
    if (!isAgentStep(step)) continue;
    const r = stepBinding(config, profile, name, step, task, input.selection);
    if (!r.ok) return r;
    steps[name] = r.value;
  }
  const floorMaps = computeFloorMaps(
    Object.fromEntries(Object.entries(steps).map(([n, s]) => [n, s.ladder])),
  );
  for (const [n, s] of Object.entries(steps)) s.floor_map = floorMaps[n] ?? {};

  const gates = gatesOf(config, profile, workflow);
  if (!gates.ok) return gates;

  const attachments = [];
  for (const ref of task.attachments) {
    const a = input.attachments.find((x) => x.name === ref.name);
    if (a === undefined) {
      return invalid(
        '<attachments>',
        'schema_invalid',
        ['attachments', ref.name],
        `Attachment '${ref.name}' has no content`,
      );
    }
    attachments.push({
      name: a.name,
      media_type: a.media_type,
      content: a.content,
    });
  }
  const prompts = snapshotDocs(
    Object.values(steps).map((st) => config.user.roles[st.role]?.prompt ?? null),
    input.prompts ?? [],
    'prompts',
  );
  if (!prompts.ok) return prompts;
  const conventions = snapshotDocs(
    config.project?.conventions ?? [],
    input.conventions ?? [],
    'conventions',
  );
  if (!conventions.ok) return conventions;

  const limits: Limits = {
    max_agent_runs: null,
    max_wall_ms: null,
    max_escalations: profile.escalation.max_escalations,
    classes: profile.classes,
    backoff: profile.backoff,
    extra_visits: {},
  };
  const permissions: Record<string, Binding['permissions']> = {};
  for (const s of Object.values(steps)) permissions[s.role] = s.binding.permissions;

  const policy = finalizePolicy({
    schema_version: 1,
    task_id: task.id,
    revision: task.revision,
    base_sha: input.base_sha,
    project: task.project,
    profile: profileName,

    workflow_name: input.mode === undefined ? SOFTWARE_DEV_NAME : modeWorkflowName(input.mode),
    workflow,
    structure_hash: structureHash(workflow),
    steps,
    ci: {
      required_checks: config.project?.required_checks ?? [],
      rules: config.project?.ci_rules ?? [],
    },
    gates: gates.value,
    limits,
    permissions,
    protected_branches: projects?.[task.project]?.protected_branches ?? [task.base_branch],
    config_hashes: {
      user: config.hashes.user,
      project: config.hashes.project,
      packs: config.hashes.packs,
      effective: hashCanonical({
        user: config.user,
        project: config.project,
        profile: profileName,
        profile_def: profile,
      }),
    },
    policy_version: 1,
  });
  // Preserve the Result contract if configuration validation and policy constraints diverge.

  const checked = FrozenPolicySchema.safeParse(policy);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    return invalid(
      userFile,
      'schema_invalid',
      (issue?.path ?? []) as (string | number)[],
      `Invalid policy: ${issue?.message ?? 'schema validation failed'}`,
    );
  }

  const context = finalizeContext({
    schema_version: 1,
    task_id: task.id,
    revision: task.revision,
    base_sha: input.base_sha,
    request: {
      title: task.title,
      description: task.description,
      requirements: task.requirements,
      constraints: task.constraints,
      out_of_scope: task.out_of_scope,
    },
    acceptance: task.acceptance,
    attachments,
    prompt_refs: prompts.value,
    conventions: conventions.value,
  });
  // Snapshots must not share mutable references with the task or configuration.
  return ok(structuredClone({ policy, context }));
}
