import type { CiClass, CiRule } from '../domain/policy.ts';
import type { Check } from '../domain/trigger.ts';

export type Classification =
  | {
      kind: 'class';
      class: CiClass;
      by_check: { check: string; class: CiClass }[];
    }
  | { kind: 'unclassified'; checks: string[] };

const SEVERITY: Record<CiClass, number> = {
  code: 3,
  autofix: 2,
  flaky_or_infra: 1,
};

function logMatches(pattern: string, log: string | undefined): boolean {
  if (log === undefined) return false;
  try {
    return new RegExp(pattern).test(log);
  } catch {
    // The loader validates regex syntax; use substring matching if compilation still fails.
    return log.includes(pattern);
  }
}

export function ruleMatches(rule: CiRule, c: Check): boolean {
  const m = rule.match;
  if (m.job !== undefined && m.job !== c.job) return false;
  if (m.check !== undefined && m.check !== c.name) return false;
  if (m.log_pattern !== undefined && !logMatches(m.log_pattern, c.log_excerpt)) return false;
  return true;
}

/**
 * The first matching rule classifies each failed check; a failure no rule matches counts as `code`,
 * so it goes to the bounded CI fixer rather than waiting for a person. Only a result with no failed
 * check to read is unclassified.
 */
export function classifyFailures(
  rules: readonly CiRule[],
  checks: readonly Check[],
): Classification {
  const failures = checks.filter((c) => c.state === 'failure');
  const byCheck: { check: string; class: CiClass }[] = [];
  for (const c of failures) {
    const rule = rules.find((r) => ruleMatches(r, c));
    byCheck.push({ check: c.name, class: rule?.class ?? 'code' });
  }
  if (failures.length === 0) return { kind: 'unclassified', checks: [] };
  const worst = byCheck.reduce((a, b) => (SEVERITY[b.class] > SEVERITY[a.class] ? b : a));
  return { kind: 'class', class: worst.class, by_check: byCheck };
}
