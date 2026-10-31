import type { Hash } from '../shared/brand.ts';
import type { Binding, CiRule, Effort, Limits } from './policy.ts';
import type { MergeMethod } from './merge-method.ts';
import type { Predicate, Workflow } from './workflow.ts';

/**
 * Cấu hình đã kiểm tra và chuẩn hoá (thời lượng là ms, mặc định đã điền). `src/config` tạo ra nó,
 * `src/policy` đọc nó; kiểu nằm ở domain để policy không phụ thuộc config (research R-12).
 */

export type ModelInfo = { harness: string; id: string; tier: number };

/** Một bước của thang: đổi effort, model hoặc thêm context so với nấc trước (cộng dồn). */
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
  /** `null` khi thiếu; bộ kiểm tra báo `no_task_bound`. */
  max_agent_runs: number | null;
  max_wall_ms: number | null;
  max_decider_calls: number;
  escalation: {
    enabled: boolean;
    auto_up_to_tier: number;
    above: 'ask_human' | 'deny';
    max_escalations: number;
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
  /** `merge.method` as declared; absent when not declared, so the normalized project keeps its hash. */
  merge_method?: MergeMethod;
};

export type NormalizedUser = {
  harnesses: Record<
    string,
    { cmd: string; auth: 'subscription' | 'api_key'; pool: string }
  >;
  pools: Record<string, number>;
  models: Record<string, ModelInfo>;
  roles: Record<string, NormalizedRole>;
  workflows: Record<string, Workflow>;
  projects: Record<
    string,
    { base_branch: string; protected_branches: string[] }
  > | null;
  permissions: Record<string, Binding['permissions']>;
  yolo: boolean;
};

export const DIAGNOSTIC_CODES = [
  // Cú pháp (FR-002)
  'yaml_syntax',
  'duplicate_key',
  'unsupported_tag',
  'alias_limit',
  'file_too_large',
  // Schema
  'schema_invalid',
  'forbidden_key',
  'unknown_pack',
  // Tham chiếu (FR-003 kiểm tra 1)
  'unknown_role',
  'unknown_model',
  'unknown_pool',
  'unknown_gate',
  'unknown_step',
  'unknown_profile',
  // Outcome (2)
  'outcome_without_target',
  'outcome_not_in_kind',
  // Chu trình (3)
  'unbounded_cycle',
  'no_task_bound',
  // Thang (4)
  'unreachable_rung',
  'rung_beyond_role',
  // Binding (5)
  'no_initial_binding',
  // Predicate (6)
  'unknown_predicate',
  // Chế độ quyết định (FR-006)
  'decision_mode_forbidden',
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

/** Chẩn đoán cấu hình theo contracts/config.md "Định dạng chẩn đoán". */
export type Diagnostic = {
  code: DiagnosticCode;
  severity: 'error';
  file: string;
  line: number;
  col: number;
  path: KeyPath;
  message: string;
};

/** Cấu hình đã kiểm tra, đủ để chốt chính sách mà không đọc lại file. */
export type ValidatedConfig = {
  files: { user: string; project: string | null };
  user: NormalizedUser;
  /** Profile đã phẳng hoá theo `extends`. */
  profiles: Record<string, NormalizedProfile>;
  /** `cusr.yaml` đã hợp nhất với pack. */
  project: NormalizedProject | null;
  hashes: { user: Hash; project: Hash | null; packs: Record<string, Hash> };
  /** Cấu hình thô (profile đã phẳng hoá, project đã hợp nhất pack) để áp override rồi kiểm tra lại. */
  raw: {
    user: Record<string, unknown>;
    profiles: Record<string, Record<string, unknown>>;
    project: Record<string, unknown> | null;
  };
};
