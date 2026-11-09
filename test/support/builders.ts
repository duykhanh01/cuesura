import { asEpochMs, asUuid, type EpochMs, type Uuid } from '../../src/shared/brand.ts';
import type { CanonicalTask } from '../../src/domain/task.ts';
import type {
  AuthzContext,
  AuthzRole,
  Binding,
  CiRule,
  FrozenExecutionContext,
  FrozenPolicy,
  Limits,
  StepPolicy,
} from '../../src/domain/policy.ts';
import { isAgentStep, type Workflow } from '../../src/domain/workflow.ts';
import {
  computeRequestHash,
  type Trigger,
  type TriggerEnvelope,
} from '../../src/domain/trigger.ts';
import {
  modeGraph,
  modeWorkflowName,
  SOFTWARE_DEV,
  SOFTWARE_DEV_NAME,
} from '../../src/engine/workflows/software-dev.ts';
import type { ExecutionMode } from '../../src/domain/run-config.ts';
import {
  buildLadder,
  computeFloorMaps,
  type EscalationPolicy,
  type LadderStep,
  type ModelInfo,
} from '../../src/policy/ladder.ts';
import { finalizeContext, finalizePolicy } from '../../src/policy/finalize.ts';
import { structureHash } from '../../src/policy/structure-hash.ts';
import { hashCanonical } from '../../src/shared/hash.ts';

export function uuidOf(n: number): Uuid {
  return asUuid(`00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
}

export class IdSource {
  private next: number;
  constructor(seed = 1) {
    this.next = seed * 1_000_000;
  }
  take(n: number): Uuid[] {
    const out: Uuid[] = [];
    for (let i = 0; i < n; i++) out.push(uuidOf(this.next++));
    return out;
  }
}

export const T0 = asEpochMs(1_800_000_000_000);

// ---------- Authz ----------

export function authz(roles: AuthzRole[] = ['operate'], actor = 'owner'): AuthzContext {
  return { actor, roles, issued_by: 'test-daemon', issued_at: T0 };
}

/** The owner's own token. */
export function ownerAuthz(): AuthzContext {
  return {
    actor: 'owner',
    roles: ['read', 'operate', 'admin'],
    issued_by: 'token:owner',
    issued_at: T0,
  };
}

// ---------- Task ----------

export function buildTask(over: Partial<CanonicalTask> = {}): CanonicalTask {
  const id = over.id ?? uuidOf(1);
  return {
    schema_version: 1,
    id,
    title: 'Add customer search',
    type: 'implementation',
    project: 'acme',
    base_branch: 'main',
    description: 'Allow searching for customers by name.',
    requirements: ['API /customers?q='],
    acceptance: ['Searching by name returns matching customers'],
    constraints: [],
    out_of_scope: [],
    attachments: [],
    group: null,
    parent: null,
    depends_on: [],
    priority: 0,
    size: 'M',
    labels: [],
    profile: null,
    requested_by: { kind: 'human', id: 'owner' },
    revision: 1,
    source_key: `cli:${id}`,
    retry_of: null,
    ...over,
  };
}

// ---------- Policy ----------

export const MODELS: Record<string, ModelInfo> = {
  haiku: { harness: 'claude', id: 'haiku', tier: 1 },
  sonnet: { harness: 'claude', id: 'sonnet', tier: 2 },
  opus: { harness: 'claude', id: 'opus', tier: 3 },
  sol: { harness: 'codex', id: 'sol-1', tier: 2 },
  terra: { harness: 'codex', id: 'terra-1', tier: 3 },
};

export type RoleSpec = {
  model: string;
  effort?: Binding['effort'];
  permissions?: Binding['permissions'];
  ladder?: LadderStep[];
  scope?: 'step' | 'task';
};

export const DEFAULT_ROLES: Record<string, RoleSpec> = {
  coder: {
    model: 'sonnet',
    effort: 'medium',
    ladder: [{ effort: 'high' }, { model: 'opus', effort: 'high' }],
  },
  fixer: {
    model: 'sonnet',
    effort: 'medium',
    ladder: [{ effort: 'high' }, { model: 'opus', effort: 'high' }],
  },
  reviewer: {
    model: 'sol',
    effort: 'medium',
    permissions: 'read_only',
    ladder: [{ effort: 'high' }],
  },
  scout: {
    model: 'sol',
    effort: 'medium',
    permissions: 'read_only',
    ladder: [],
  },
};

export const DEFAULT_LIMITS: Limits = {
  max_agent_runs: 30,
  max_wall_ms: 6 * 3_600_000,
  max_escalations: 4,
  extra_visits: {},
  classes: {
    infra_retries: 3,
    timeout_retries: 1,
    invalid_output_repairs: 1,
    invalid_output_fresh: 1,
    quality_tries_per_rung: 3,
  },
  backoff: {
    rate_limit: {
      base_ms: 60_000,
      factor: 2,
      max_ms: 1_800_000,
      max_attempts: 5,
    },
    infra: { base_ms: 5_000, factor: 2, max_ms: 300_000, max_attempts: 3 },
  },
};

export type PolicyOptions = {
  task_id?: string;
  revision?: number;
  base_sha?: string;
  project?: string;
  roles?: Partial<Record<string, RoleSpec>>;
  escalation?: Partial<EscalationPolicy>;
  limits?: Partial<Omit<Limits, 'classes' | 'backoff'>> & {
    classes?: Partial<Limits['classes']>;
    backoff?: Partial<Limits['backoff']>;
  };
  required_checks?: string[];
  ci_rules?: CiRule[];
  workflow?: Workflow;
  gates?: Record<string, string>;
  policy_version?: number;
  protected_branches?: string[];
  /** 002: freeze the `software_dev@2:<mode>` graph derived from `workflow`. */
  mode?: ExecutionMode;
};

export const DEFAULT_CI_RULES: CiRule[] = [
  { match: { log_pattern: 'ETIMEDOUT|runner lost' }, class: 'flaky_or_infra' },
  { match: { job: 'format' }, class: 'autofix' },
  { match: { job: 'test' }, class: 'code' },
  { match: { job: 'build' }, class: 'code' },
];

export function buildPolicy(o: PolicyOptions = {}): FrozenPolicy {
  const workflow =
    o.mode === undefined
      ? (o.workflow ?? SOFTWARE_DEV)
      : modeGraph(o.workflow ?? SOFTWARE_DEV, o.mode);
  const roles: Record<string, RoleSpec> = { ...DEFAULT_ROLES };
  for (const [k, v] of Object.entries(o.roles ?? {})) if (v) roles[k] = v;
  const esc: EscalationPolicy = {
    auto_up_to_tier: 2,
    above: 'ask_human',
    allow_models: null,
    ...o.escalation,
  };
  const ladders: Record<string, ReturnType<typeof buildLadder>> = {};
  const roleOf: Record<string, string> = {};
  for (const [name, step] of Object.entries(workflow.steps)) {
    if (!isAgentStep(step) || step.role === undefined) continue;
    const spec = roles[step.role];
    if (!spec) throw new Error(`builder: role ${step.role} is missing`);
    const info = MODELS[spec.model] as ModelInfo;
    const initial: Binding = {
      harness: info.harness,
      model: spec.model,
      model_id: info.id,
      effort: spec.effort ?? 'medium',
      add_context: [],
      permissions: spec.permissions ?? 'write',
      limits: {
        max_turns: 80,
        stall_timeout_ms: 600_000,
        wall_timeout_ms: 2_700_000,
      },
    };
    ladders[name] = buildLadder(initial, spec.ladder ?? [], MODELS, esc);
    roleOf[name] = step.role;
  }
  const floorMaps = computeFloorMaps(ladders);
  const steps: Record<string, StepPolicy> = {};
  for (const [name, ladder] of Object.entries(ladders)) {
    const role = roleOf[name] as string;
    steps[name] = {
      role,
      binding: (ladder[0] as (typeof ladder)[number]).binding,
      ladder,
      floor_map: floorMaps[name] ?? {},
      escalation_scope: roles[role]?.scope ?? 'step',
    };
  }
  const commands = o.gates ?? {
    build: 'npm run build',
    unit: 'npm test',
    lint: 'npm run lint',
    format_fix: 'npm run format',
  };
  const by_step: FrozenPolicy['gates']['by_step'] = {};
  for (const [name, step] of Object.entries(workflow.steps)) {
    if (step.kind !== 'gate') continue;
    const run = (step.run ?? []).filter((g) => g in commands);
    by_step[name] = {
      run,
      required: step.required ?? [],
      skipped: (step.run ?? []).filter((g) => !(g in commands)),
    };
  }
  const limits: Limits = {
    ...DEFAULT_LIMITS,
    ...o.limits,
    classes: { ...DEFAULT_LIMITS.classes, ...o.limits?.classes },
    backoff: { ...DEFAULT_LIMITS.backoff, ...o.limits?.backoff },
  };
  const permissions: Record<string, 'read_only' | 'write'> = {};
  for (const [r, spec] of Object.entries(roles)) permissions[r] = spec.permissions ?? 'write';
  const h = hashCanonical('fixture');
  return finalizePolicy({
    schema_version: 1,
    task_id: o.task_id ?? uuidOf(1),
    revision: o.revision ?? 1,
    base_sha: o.base_sha ?? 'base0000',
    project: o.project ?? 'acme',
    profile: 'standard',
    workflow_name: o.mode === undefined ? SOFTWARE_DEV_NAME : modeWorkflowName(o.mode),
    workflow,
    structure_hash: structureHash(workflow),
    steps,
    ci: {
      required_checks: o.required_checks ?? [],
      rules: o.ci_rules ?? DEFAULT_CI_RULES,
    },
    gates: { commands, by_step },
    limits,
    permissions,
    protected_branches: o.protected_branches ?? ['main'],
    config_hashes: { user: h, project: h, packs: {}, effective: h },
    policy_version: o.policy_version ?? 1,
  });
}

export function buildContext(
  task: CanonicalTask,
  base_sha = 'base0000',
  attachments: { name: string; media_type: string; content: string }[] = [],
): FrozenExecutionContext {
  return finalizeContext({
    schema_version: 1,
    task_id: task.id,
    revision: task.revision,
    base_sha,
    request: {
      title: task.title,
      description: task.description,
      requirements: task.requirements,
      constraints: task.constraints,
      out_of_scope: task.out_of_scope,
    },
    acceptance: task.acceptance,
    attachments,
    prompt_refs: [],
    conventions: [],
  });
}

export function freezeOk(
  task: CanonicalTask,
  o: PolicyOptions = {},
): {
  ok: true;
  value: { policy: FrozenPolicy; context: FrozenExecutionContext };
} {
  return {
    ok: true,
    value: {
      policy: buildPolicy({
        task_id: task.id,
        revision: task.revision,
        project: task.project,
        ...o,
      }),
      context: buildContext(task, o.base_sha),
    },
  };
}

export type EnvelopeOptions = {
  now?: number;
  ids?: Uuid[];
  authz?: AuthzContext;
  expected_version?: number;
  dedup_key?: string;
};

let dedupCounter = 0;

export function envelope(
  taskId: string,
  trigger: Trigger,
  o: EnvelopeOptions = {},
): TriggerEnvelope {
  const env = {
    schema_version: 1 as const,
    task_id: taskId as Uuid,
    dedup_key: o.dedup_key ?? `test:${++dedupCounter}`,
    trigger,
    now: (o.now ?? T0) as EpochMs,
    ids: o.ids ?? [],
    ...(o.authz !== undefined ? { authz: o.authz } : {}),
    ...(o.expected_version !== undefined ? { expected_version: o.expected_version } : {}),
  };
  return { ...env, request_hash: computeRequestHash(env) };
}

export { asEpochMs };
