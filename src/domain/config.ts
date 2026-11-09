import type { Hash } from '../shared/brand.ts';
import type { Binding, CiRule, Effort, Limits } from './policy.ts';
import type { MergeMethod } from './merge-method.ts';
import type { Predicate, Workflow } from './workflow.ts';

/**
 * Normalized configuration types live in domain so the pure policy layer does not depend on
 * config.
 */

export type ModelInfo = { harness: string; id: string; tier: number };

/** Ladder changes accumulate from the preceding rung. */
export type LadderStep = {
  effort?: Effort;
  model?: string;
  add_context?: string[];
};

export type BindingRule = {
  when: Predicate | null;
  model: string;
  effort: Effort;
};

export type NormalizedRole = {
  permissions: Binding['permissions'];
  binding: BindingRule[];
  limits: Binding['limits'];
  ladder: LadderStep[];
  scope: 'step' | 'task';
  prompt: string | null;
  context: string[];
};

export type NormalizedProfile = {
  workflow: string | null;
  allow_roles: string[] | null;
  allow_models: string[] | null;
  allow_no_gates: boolean;
  /** null means the task has no cap. */
  escalation: {
    enabled: boolean;
    auto_up_to_tier: number;
    above: 'ask_human' | 'deny';
    max_escalations: number | null;
  };
  classes: Limits['classes'];
  backoff: Limits['backoff'];
  overridable: string[];
};

export type NormalizedProject = {
  extends: string[];
  setup: string[];
  /** Commands the project needs that its gates do not name; absent when not declared. */
  tools?: string[];
  gates: Record<string, string>;
  autofix: Record<string, string>;
  log_digest: Record<string, unknown>;
  signature: Record<string, unknown>;
  ci_rules: CiRule[];
  required_checks: string[];
  pools: Record<string, number>;
  hotspots: string[];
  conventions: string[];
  profile: string | null;
  /** Path of the PR template in the repo, when several exist (task-execution-modes.md). */
  pr_template?: string;
  /** Path of the review comment template in the repo; absent means the built-in one. */
  review_template?: string;
  /** `merge.method` as declared; absent when not declared, so the normalized project keeps its hash. */
  merge_method?: MergeMethod;
};

export type NormalizedUser = {
  harnesses: Record<string, { cmd: string; auth: 'subscription' | 'api_key'; pool: string }>;
  pools: Record<string, number>;
  models: Record<string, ModelInfo>;
  roles: Record<string, NormalizedRole>;
  workflows: Record<string, Workflow>;
  projects: Record<string, { base_branch: string; protected_branches: string[] }> | null;
  permissions: Record<string, Binding['permissions']>;
  yolo: boolean;
  /** Present only when on, so tasks frozen without it keep their config hash. */
  autonomous?: true;
};

export const DIAGNOSTIC_CODES = [
  'yaml_syntax',
  'duplicate_key',
  'unsupported_tag',
  'alias_limit',
  'file_too_large',
  // Schema
  'schema_invalid',
  'forbidden_key',
  'unknown_pack',

  'unknown_role',
  'unknown_model',
  'unknown_pool',
  'unknown_gate',
  'unknown_step',
  'unknown_profile',
  'workflow_key_removed',
  // Thang (4)
  'unreachable_rung',
  'rung_beyond_role',
  // Binding (5)
  'no_initial_binding',
  // Predicate (6)
  'unknown_predicate',

  // Gate
  'required_gate_missing',
  'no_gates_not_allowed',
  // Profile
  'profile_cycle',
  'override_not_allowed',
  'override_exceeds_caller',
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export type KeyPath = (string | number)[];

export type Diagnostic = {
  code: DiagnosticCode;
  severity: 'error';
  file: string;
  line: number;
  col: number;
  path: KeyPath;
  message: string;
};

export type ValidatedConfig = {
  files: { user: string; project: string | null };
  user: NormalizedUser;

  profiles: Record<string, NormalizedProfile>;

  project: NormalizedProject | null;
  hashes: { user: Hash; project: Hash | null; packs: Record<string, Hash> };
  /** Retain raw merged values so overrides can be applied and validated again. */
  raw: {
    user: Record<string, unknown>;
    profiles: Record<string, Record<string, unknown>>;
    project: Record<string, unknown> | null;
  };
};
