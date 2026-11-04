import type { AuthzContext, AuthzRole } from '../domain/policy.ts';
import { tokenDigest, type Grant, type TokenMap } from './access-tokens.ts';

// Server-side authorization (contracts/cli-daemon.md). The caller's identity comes only
// from the bearer token; actor/role fields in a request body or header are never trusted.

export type Caller = { grant: Grant };

export type AuthzError =
  | { code: 'unauthenticated' }
  | { code: 'forbidden'; reason: 'role' | 'project'; required: string };

export function authenticate(tokens: TokenMap, bearer: string | null | undefined): Caller | null {
  if (typeof bearer !== 'string' || bearer.length === 0 || bearer.length > 256) return null;
  const grant = tokens.byDigest.get(tokenDigest(bearer));
  return grant === undefined ? null : { grant };
}

/** `read` never mutates; `operate` never grants escalation or admin; `admin` stays with the owner token. */
export function authorize(
  caller: Caller | null,
  need: { role: AuthzRole; project?: string | null },
): { ok: true } | { ok: false; error: AuthzError } {
  if (caller === null) return { ok: false, error: { code: 'unauthenticated' } };
  const g = caller.grant;
  if (!g.roles.includes(need.role))
    return {
      ok: false,
      error: { code: 'forbidden', reason: 'role', required: need.role },
    };
  if (
    need.project !== undefined &&
    need.project !== null &&
    g.projects !== '*' &&
    !g.projects.includes(need.project)
  ) {
    return {
      ok: false,
      error: { code: 'forbidden', reason: 'project', required: need.project },
    };
  }
  return { ok: true };
}

/** Projects a caller may see in list/status queries. */
export function visibleProjects(caller: Caller, all: readonly string[]): string[] {
  return caller.grant.projects === '*'
    ? [...all]
    : all.filter((p) => caller.grant.projects.includes(p));
}

/** The AuthzContext stamped on core envelopes, derived from the verified grant only. */
export function authzContext(caller: Caller, now: number): AuthzContext {
  return {
    actor: caller.grant.actor,
    roles: [...caller.grant.roles],
    issued_by: `token:${caller.grant.id}`,
    issued_at: now,
  };
}
