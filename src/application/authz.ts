import type { AuthzContext, AuthzRole } from '../domain/policy.ts';

// Server-side authorization (contracts/cli-daemon.md). Only processes of the daemon's UID reach the
// control socket (directory 0700, socket 0600), and any of them could act as the owner. The actor a
// caller declares is therefore a guardrail for well-behaved callers, not a security boundary: an
// assistant that declares itself is held to read/operate, so it cannot administer by mistake.

export const CALLER_ACTORS = ['owner', 'assistant'] as const;
export type CallerActor = (typeof CALLER_ACTORS)[number];

/** Header carrying the declared actor; absent means the owner. */
export const ACTOR_HEADER = 'x-cusr-actor';

export type Grant = { actor: string; roles: AuthzRole[] };
export type Caller = { grant: Grant };

const GRANTS: Record<CallerActor, readonly AuthzRole[]> = {
  owner: ['read', 'operate', 'admin'],
  assistant: ['read', 'operate'],
};

export type AuthzError =
  | { code: 'unauthenticated' }
  | { code: 'forbidden'; reason: 'role' | 'project'; required: string };

export function isCallerActor(v: string): v is CallerActor {
  return (CALLER_ACTORS as readonly string[]).includes(v);
}

/** The caller for a declared actor; `null` for a name that is not one of `CALLER_ACTORS`. */
export function callerFor(declared: string | null | undefined): Caller | null {
  const actor = declared === null || declared === undefined || declared === '' ? 'owner' : declared;
  if (!isCallerActor(actor)) return null;
  return { grant: { actor, roles: [...GRANTS[actor]] } };
}

/** `read` never mutates; `operate` never grants admin; `admin` stays with the owner. */
export function authorize(
  caller: Caller | null,
  need: { role: AuthzRole },
): { ok: true } | { ok: false; error: AuthzError } {
  if (caller === null) return { ok: false, error: { code: 'unauthenticated' } };
  if (!caller.grant.roles.includes(need.role))
    return {
      ok: false,
      error: { code: 'forbidden', reason: 'role', required: need.role },
    };
  return { ok: true };
}

/** The AuthzContext stamped on core envelopes, derived from the caller only. */
export function authzContext(caller: Caller, now: number): AuthzContext {
  return {
    actor: caller.grant.actor,
    roles: [...caller.grant.roles],
    issued_by: `socket:${caller.grant.actor}`,
    issued_at: now,
  };
}
