/**
 * Normalizer of GitHub required-check reads into `RequiredEvidence` (FR-042.02/05/06, contracts/github.md
 *). Checked against archived S0.3/T008 fixtures, as a pure function over responses the gh port already
 * fetched: the observe
 * step (T044) reads the branch, then classic protection when GitHub says the branch is protected, then
 * every page of `/rules/branches/{target}`, then each ruleset in `rulesetIdsToRead`.
 *
 * A read that failed, a page cap, a missing permission or a malformed body is `unknown`, never an empty
 * list. The one 404 accepted is classic protection answering "Branch not protected" while rulesets apply
 * (seen live 2026-10-28); any other 404, e.g. "Not Found" for a reader without access, stays unknown.
 * Every 200 protection body must carry a `url` naming this repo's and branch's protection, or it is
 * unknown. Without `required_status_checks` it means status checks are not enabled (the field is
 * optional in GitHub's schema; not yet seen live).
 */
import {
  CHECK_ENFORCEMENTS,
  type CheckEnforcement,
  type RequiredEvidence,
  type RequiredIdentity,
  type RequiredProvenance,
  binds,
} from '../../domain/runtime.ts';

/** One GET as the gh port returned it; `body` is the parsed JSON, also for an HTTP error when present. */
export type GhRead =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | {
      readonly ok: false;
      readonly status: number | null;
      readonly body: unknown;
      readonly reason: string;
    };

/** Every page of a list endpoint; `complete: false` when the page or byte cap cut it short. */
export type GhList =
  | {
      readonly ok: true;
      readonly items: readonly unknown[];
      readonly complete: boolean;
    }
  | { readonly ok: false; readonly reason: string };

export type RequirementReads = {
  /** `owner/name` and the target branch the reads were made for. */
  readonly target: { readonly repo: string; readonly branch: string };
  readonly branch: GhRead;
  /** Read only when the branch reports `protected: true`; `null` otherwise. */
  readonly protection: GhRead | null;
  /** `null` when the observe step stopped before reading rules. */
  readonly rules: GhList | null;
  readonly rulesets: ReadonlyMap<number, GhRead>;
};

type Obj = Readonly<Record<string, unknown>>;
const obj = (v: unknown): Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const positiveInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;

/** GitHub leaves an app unpinned as absent, null or -1; any other value must be a positive app id. */
function appOf(v: unknown): RequiredIdentity['app'] | null {
  if (v === undefined || v === null || v === -1) return 'any';
  return positiveInt(v);
}

/** The body's own `url` must be this branch's protection endpoint; owner/repo compare case-insensitively. */
function isProtectionOf(body: unknown, target: RequirementReads['target']): boolean {
  const url = str(obj(body)['url']);
  if (url === null) return false;
  const m = /^https:\/\/[^/]+\/repos\/([^/]+\/[^/]+)\/branches\/(.+)\/protection$/.exec(url);
  if (m === null || (m[1] as string).toLowerCase() !== target.repo.toLowerCase()) return false;
  const branch = m[2] as string;
  return branch === target.branch || branch === encodeURIComponent(target.branch);
}

function notProtected(r: GhRead): boolean {
  return !r.ok && r.status === 404 && obj(r.body)['message'] === 'Branch not protected';
}

/** Ruleset IDs the rules list references, in first-seen order; their enforcement must be read too. */
export function rulesetIdsToRead(rules: GhList): number[] {
  if (!rules.ok) return [];
  const ids: number[] = [];
  for (const r of rules.items) {
    const id = positiveInt(obj(r)['ruleset_id']);
    if (obj(r)['type'] === 'required_status_checks' && id !== null && !ids.includes(id))
      ids.push(id);
  }
  return ids;
}

export function normalizeRequirements(
  reads: RequirementReads,
  observedAt: number,
): RequiredEvidence {
  const partial: RequiredIdentity[] = [];
  const unknown = (basis: string): RequiredEvidence => ({
    kind: 'unknown',
    partial,
    basis,
    observed_at: observedAt,
  });

  if (!reads.branch.ok) return unknown(`branch read failed: ${reads.branch.reason}`);
  const isProtected = obj(reads.branch.body)['protected'];
  if (typeof isProtected !== 'boolean') return unknown('branch protected flag missing');

  let classic: RequiredProvenance['classic'] = 'unprotected_branch';
  if (isProtected) {
    const prot = reads.protection;
    if (prot === null) return unknown('classic protection not read');
    if (notProtected(prot)) classic = 'not_protected';
    else if (!prot.ok) return unknown(`classic protection unreadable: ${prot.reason}`);
    // Every 200 body must name this branch's protection, whatever its status-check section says.
    else if (!isProtectionOf(prot.body, reads.target))
      return unknown("classic protection body is not this branch's protection");
    else if (obj(prot.body)['required_status_checks'] === undefined)
      classic = 'read_no_status_checks';
    else {
      classic = 'read';
      const fail = classicChecks(prot.body, partial);
      if (fail !== null) return unknown(fail);
    }
  }

  const rules = reads.rules;
  if (rules === null) return unknown('branch rules not read');
  if (!rules.ok) return unknown(`branch rules unreadable: ${rules.reason}`);
  if (!rules.complete) return unknown('branch rules truncated by page cap');
  const rulesetIds: number[] = [];
  for (const rule of rules.items) {
    const r = obj(rule);
    if (str(r['type']) === null) return unknown('branch rule type missing or malformed');
    if (r['type'] !== 'required_status_checks') continue;
    const id = positiveInt(r['ruleset_id']);
    if (id === null) return unknown('required-check rule without ruleset id');
    const enforcement = enforcementOf(reads.rulesets.get(id));
    if (enforcement === null) return unknown(`ruleset ${id} enforcement unreadable`);
    if (!rulesetIds.includes(id)) rulesetIds.push(id);
    const list = obj(r['parameters'])['required_status_checks'];
    if (!Array.isArray(list)) return unknown('rule required check list missing or malformed');
    for (const c of list) {
      const name = str(obj(c)['context']);
      const app = appOf(obj(c)['integration_id']);
      if (name === null || app === null) return unknown('rule check identity malformed');
      partial.push({ name, app, source: 'rules', enforcement, ruleset_id: id });
    }
  }

  const provenance = {
    branch_protected: isProtected,
    classic,
    ruleset_ids: rulesetIds,
  };
  const identities = [...partial];
  if (identities.some(binds))
    return {
      kind: 'known',
      identities,
      provenance,
      basis: 'classic and/or active rules',
      observed_at: observedAt,
    };
  const basis = isProtected
    ? 'protected, no binding required checks'
    : 'unprotected, no binding required-check rules';
  return {
    kind: 'none',
    identities,
    provenance,
    basis,
    observed_at: observedAt,
  };
}

/** Appends classic identities to `out`; returns the reason when the body cannot be trusted. */
function classicChecks(body: unknown, out: RequiredIdentity[]): string | null {
  const raw = obj(body)['required_status_checks'];
  // An explicit null says there are none; an absent section is handled by the caller.
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'classic required checks malformed';
  const rsc = obj(raw);
  if (Array.isArray(rsc['checks'])) {
    for (const c of rsc['checks'] as unknown[]) {
      const name = str(obj(c)['context']);
      const app = appOf(obj(c)['app_id']);
      if (name === null || app === null) return 'classic check identity malformed';
      out.push({
        name,
        app,
        source: 'classic',
        enforcement: 'classic',
        ruleset_id: null,
      });
    }
    return null;
  }
  if (rsc['checks'] === undefined && Array.isArray(rsc['contexts'])) {
    for (const name of rsc['contexts'] as unknown[]) {
      if (str(name) === null) return 'classic contexts malformed';
      out.push({
        name: name as string,
        app: 'any',
        source: 'classic',
        enforcement: 'classic',
        ruleset_id: null,
      });
    }
    return null;
  }
  return 'classic required check list missing or malformed';
}

function enforcementOf(r: GhRead | undefined): Exclude<CheckEnforcement, 'classic'> | null {
  if (r === undefined || !r.ok) return null;
  const e = obj(r.body)['enforcement'];
  return typeof e === 'string' &&
    e !== 'classic' &&
    (CHECK_ENFORCEMENTS as readonly string[]).includes(e)
    ? (e as Exclude<CheckEnforcement, 'classic'>)
    : null;
}
