import { err, ok, type Result } from '../shared/result.ts';
import { FrozenPolicySchema, hasRole, type AuthzContext, type FrozenPolicy } from '../domain/policy.ts';
import { policyHash } from './finalize.ts';

/** Phần chính sách được amendment đổi; graph workflow và danh tính revision không thuộc tập này (FR-005). */
export const AMENDABLE_KEYS = [
  'steps',
  'ci',
  'gates',
  'limits',
  'decision_modes',
  'permissions',
  'protected_branches',
] as const;
export type PolicyChange = Partial<Pick<FrozenPolicy, (typeof AMENDABLE_KEYS)[number]>>;

/** Khoá đổi graph workflow: v1 không cho đổi khi task đang chạy. */
const WORKFLOW_KEYS = ['workflow', 'workflow_name', 'structure_hash'];

export type AmendmentError = { code: 'not_admin' | 'workflow_change_forbidden' | 'invalid'; detail?: string };

/**
 * Đề xuất amendment (FR-005, FR-036): cần `AuthzContext` có `admin`; tên actor hay `requested_by` tự
 * khai không thay được. Không đổi đầu vào; chỉ tạo chính sách mới, có hiệu lực khi đi qua tín hiệu `amend`.
 */
export function proposeAmendment(input: {
  current: FrozenPolicy;
  change: PolicyChange;
  reason: string;
  authz: AuthzContext | null | undefined;
}): Result<FrozenPolicy, AmendmentError> {
  if (!hasRole(input.authz, 'admin')) return err({ code: 'not_admin' });
  const keys = Object.keys(input.change);
  if (keys.some((k) => WORKFLOW_KEYS.includes(k))) return err({ code: 'workflow_change_forbidden' });
  const unknown = keys.filter((k) => !(AMENDABLE_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) return err({ code: 'invalid', detail: `không amend được: ${unknown.join(', ')}` });
  if (input.reason.trim() === '') return err({ code: 'invalid', detail: 'amendment cần lý do' });

  const { policy_hash: _old, ...rest } = input.current;
  // Bản sao sâu: chính sách mới không dùng chung object với `current` hay `change`, nên sửa đầu vào sau
  // này không đổi được nó mà hash vẫn giữ nguyên (FR-005).
  const next = structuredClone({ ...rest, ...input.change, policy_version: input.current.policy_version + 1 });
  // Feature 001 chỉ chạy chế độ `human` (FR-039).
  if (Object.values(next.decision_modes).some((m) => m !== 'human')) {
    return err({ code: 'invalid', detail: 'chỉ chế độ quyết định human được chốt' });
  }
  const amended = { ...next, policy_hash: policyHash(next) };
  const parsed = FrozenPolicySchema.safeParse(amended);
  if (!parsed.success) return err({ code: 'invalid', detail: parsed.error.issues[0]?.message ?? 'schema' });
  return ok(amended);
}
