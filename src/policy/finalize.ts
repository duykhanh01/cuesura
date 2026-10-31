import type { Hash } from '../shared/brand.ts';
import { hashCanonical, hashText } from '../shared/hash.ts';
import type { FrozenExecutionContext, FrozenPolicy } from '../domain/policy.ts';

export type UnhashedPolicy = Omit<FrozenPolicy, 'policy_hash'>;
export type UnhashedContext = Omit<FrozenExecutionContext, 'context_hash'>;

export function policyHash(p: UnhashedPolicy): Hash {
  return hashCanonical(p);
}

export function finalizePolicy(p: UnhashedPolicy): FrozenPolicy {
  return { ...p, policy_hash: policyHash(p) };
}

export function verifyPolicyHash(p: FrozenPolicy): boolean {
  const { policy_hash, ...rest } = p;
  return policyHash(rest) === policy_hash;
}

export type DocContent = { name: string; content: string };

function snapshotDoc<T extends DocContent>(d: T): T & { content_hash: Hash } {
  return { ...d, content_hash: hashText(d.content) };
}

export function finalizeContext(
  c: Omit<UnhashedContext, 'attachments' | 'prompt_refs' | 'conventions'> & {
    attachments: { name: string; media_type: string; content: string }[];
    prompt_refs: DocContent[];
    conventions: DocContent[];
  },
): FrozenExecutionContext {
  const body: UnhashedContext = {
    ...c,
    attachments: c.attachments.map(snapshotDoc),
    prompt_refs: c.prompt_refs.map(snapshotDoc),
    conventions: c.conventions.map(snapshotDoc),
  };
  return { ...body, context_hash: hashCanonical(body) };
}

export function verifyContextHash(c: FrozenExecutionContext): boolean {
  const { context_hash, ...rest } = c;
  return hashCanonical(rest) === context_hash;
}
