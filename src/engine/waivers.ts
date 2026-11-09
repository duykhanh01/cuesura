/**
 * Waivers in effect (007, FR-045, R-20). Pure. A waiver lets through exactly what it names within its
 * scope: a finding by key while the review blocks on the same key set, a gate while it fails with the
 * same filtered error lines, a CI check on the head it was waived on. A PR into a protected branch takes
 * no check waiver.
 */
import type { FrozenPolicy } from '../domain/policy.ts';
import type { Check } from '../domain/trigger.ts';
import type { ReviewEvidence, TaskState, Waiver, WaiverTarget } from '../domain/state.ts';
import { branchMatches } from '../domain/workflow.ts';
import {
  blockingKeys,
  gateSignature,
  latestGateFailure,
  latestRejection,
  reviewScope,
} from './failure-signature.ts';

type WithWaivers = Pick<TaskState, 'run'>;

const waiversOf = (s: WithWaivers): readonly Waiver[] => s.run.waivers ?? [];

export function protectedTarget(
  policy: Pick<FrozenPolicy, 'protected_branches'>,
  base: string,
): boolean {
  return policy.protected_branches.some((b) => branchMatches(b, base));
}

function covers(s: WithWaivers, kind: WaiverTarget['kind'], key: string, scope: string): boolean {
  return waiversOf(s).some(
    (w) => w.target.kind === kind && w.target.key === key && w.scope === scope,
  );
}

/** A failed gate result that a waiver covers. */
export function gateWaived(
  s: WithWaivers,
  r: { gate: string; passed: boolean; log_excerpt?: string | null | undefined },
): boolean {
  return !r.passed && covers(s, 'gate', r.gate, gateSignature(r.gate, r.log_excerpt));
}

/** Whether the required gates passed, a covered failure counting as passed; and which were waived. */
export function gatesPass(
  s: WithWaivers,
  required: readonly string[],
  results: readonly { gate: string; passed: boolean; log_excerpt?: string | null | undefined }[],
): { passed: boolean; waived: string[] } {
  const waived = results.filter((r) => gateWaived(s, r)).map((r) => r.gate);
  const passed =
    required.length > 0 &&
    required.every((g) => results.some((r) => r.gate === g && (r.passed || waived.includes(g))));
  return { passed, waived };
}

/** Every blocking finding of this rejection has a waiver for its key on its key set. */
export function reviewWaived(s: WithWaivers, review: Pick<ReviewEvidence, 'findings'>): boolean {
  const keys = blockingKeys(review);
  const scope = reviewScope(review);
  return keys.length > 0 && keys.every((k) => covers(s, 'finding', k, scope));
}

/** The waivers that let this rejection through, by ID. */
export function reviewWaivers(s: WithWaivers, review: Pick<ReviewEvidence, 'findings'>): string[] {
  const scope = reviewScope(review);
  return waiversOf(s)
    .filter((w) => w.target.kind === 'finding' && w.scope === scope)
    .map((w) => w.id);
}

type CheckRun = Pick<Check, 'name' | 'state' | 'source' | 'app_id' | 'run'>;

/**
 * The scope of a check waiver: the head, and the source, app and run ID of the failed run. A rerun or a
 * check of the same name from another app is another run. Null for a check read without its run.
 */
export function checkScope(head: string, c: CheckRun): string | null {
  return c.source === undefined || c.run === undefined
    ? null
    : `${head}#${c.source}:${c.app_id ?? '-'}:${c.run}`;
}

/** Names of the failed checks of `head` whose very run is waived; none on a protected target. */
export function waivedChecks(
  s: WithWaivers & Pick<TaskState, 'task'>,
  policy: Pick<FrozenPolicy, 'protected_branches'>,
  head: string | null,
  checks: readonly CheckRun[],
): ReadonlySet<string> {
  if (head === null || protectedTarget(policy, s.task.base_branch)) return new Set();
  return new Set(
    checks
      .filter((c) => {
        const scope = c.state === 'failure' ? checkScope(head, c) : null;
        return scope !== null && covers(s, 'check', c.name, scope);
      })
      .map((c) => c.name),
  );
}

export type WaiveRefusal =
  | 'waive_target_unknown'
  | 'waive_protected'
  | 'waive_duplicate'
  | 'waive_no_head'
  | 'waive_no_run';

/** The scope a new waiver of `target` takes now, or why it cannot be waived. */
export function waiverScope(
  s: TaskState,
  policy: Pick<FrozenPolicy, 'protected_branches'>,
  target: WaiverTarget,
): { ok: true; scope: string } | { ok: false; reason: WaiveRefusal } {
  let scope: string | null = null;
  switch (target.kind) {
    case 'finding': {
      const review = latestRejection(s);
      if (review !== null && blockingKeys(review).includes(target.key)) scope = reviewScope(review);
      break;
    }
    case 'gate': {
      const failed = latestGateFailure(s)?.failed?.find((f) => f.gate === target.key);
      if (failed !== undefined) scope = gateSignature(failed.gate, failed.log_excerpt);
      break;
    }
    case 'check': {
      if (protectedTarget(policy, s.task.base_branch))
        return { ok: false, reason: 'waive_protected' };
      const head = s.head_sha;
      if (head === null) return { ok: false, reason: 'waive_no_head' };
      const ci = s.evidence.ci.findLast(
        (c) => c.valid && c.revision === s.revision && c.head_sha === head,
      );
      const run = ci?.checks.find((c) => c.name === target.key && c.state === 'failure');
      if (run !== undefined) {
        scope = checkScope(head, run);
        if (scope === null) return { ok: false, reason: 'waive_no_run' };
      }
      break;
    }
  }
  if (scope === null) return { ok: false, reason: 'waive_target_unknown' };
  if (covers(s, target.kind, target.key, scope)) return { ok: false, reason: 'waive_duplicate' };
  return { ok: true, scope };
}

/** Waivers the PR body has not listed yet (FR-046); merge waits for them. */
export function unlistedWaivers(s: WithWaivers & Pick<TaskState, 'pr_ref'>): string[] {
  if (s.pr_ref === null) return [];
  const listed = new Set(s.run.pr_body?.waivers ?? []);
  return waiversOf(s)
    .map((w) => w.id)
    .filter((id) => !listed.has(id));
}

/** The PR body section that lists the waivers, always as waived, never as passed (FR-046). */
/** One waiver as the PR lists it: always as waived. */
export function waiverLine(w: Waiver): string {
  return `**waived** ${w.target.kind} \`${w.target.key}\` by ${w.by}: ${w.reason ?? 'no reason'} — evidence: ${w.evidence}`;
}

export function waiversSection(waivers: readonly Waiver[]): string {
  if (waivers.length === 0) return '';
  const lines = waivers.map((w) => `- ${waiverLine(w)}`);
  return [
    '## Waivers',
    '',
    'These did not pass; each was let through with the evidence given.',
    '',
    ...lines,
  ].join('\n');
}
