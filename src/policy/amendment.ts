import { err, ok, type Result } from '../shared/result.ts';
import {
  FrozenPolicySchema,
  hasRole,
  type AuthzContext,
  type FrozenPolicy,
} from '../domain/policy.ts';
import { policyHash } from './finalize.ts';

export const AMENDABLE_KEYS = [
  'steps',
  'ci',
  'gates',
  'limits',
  'permissions',
  'protected_branches',
] as const;
export type PolicyChange = Partial<Pick<FrozenPolicy, (typeof AMENDABLE_KEYS)[number]>>;

const WORKFLOW_KEYS = ['workflow', 'workflow_name', 'structure_hash'];

export type AmendmentError = {
  code: 'not_admin' | 'workflow_change_forbidden' | 'invalid';
  detail?: string;
};

/**
 * Requires trusted admin authorization; an actor name alone grants nothing. Return a new policy
 * without mutating inputs. It takes effect only after the amend trigger is accepted.
 */
export function proposeAmendment(input: {
  current: FrozenPolicy;
  change: PolicyChange;
  reason: string;
  authz: AuthzContext | null | undefined;
}): Result<FrozenPolicy, AmendmentError> {
  if (!hasRole(input.authz, 'admin')) return err({ code: 'not_admin' });
  const keys = Object.keys(input.change);
  if (keys.some((k) => WORKFLOW_KEYS.includes(k)))
    return err({ code: 'workflow_change_forbidden' });
  const unknown = keys.filter((k) => !(AMENDABLE_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0)
    return err({
      code: 'invalid',
      detail: `Unsupported amendment fields: ${unknown.join(', ')}`,
    });
  if (input.reason.trim() === '')
    return err({
      code: 'invalid',
      detail: 'A policy amendment requires a reason',
    });

  const { policy_hash: _old, ...rest } = input.current;
  // Deep-copy so later mutations of current or change cannot alter the policy while preserving its hash.

  const next = structuredClone({
    ...rest,
    ...input.change,
    policy_version: input.current.policy_version + 1,
  });

  const amended = { ...next, policy_hash: policyHash(next) };
  const parsed = FrozenPolicySchema.safeParse(amended);
  if (!parsed.success)
    return err({
      code: 'invalid',
      detail: parsed.error.issues[0]?.message ?? 'schema',
    });
  return ok(amended);
}
