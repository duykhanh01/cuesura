import type { CiClass, CiRule } from '../domain/policy.ts';
import type { Check } from '../domain/trigger.ts';

export type Classification =
  | { kind: 'class'; class: CiClass; by_check: { check: string; class: CiClass }[] }
  | { kind: 'unclassified'; checks: string[] };

/** Thứ tự nghiêm trọng khi nhiều check thất bại khác lớp (research R-21). */
const SEVERITY: Record<CiClass, number> = { code: 3, autofix: 2, flaky_or_infra: 1 };

function logMatches(pattern: string, log: string | undefined): boolean {
  if (log === undefined) return false;
  try {
    return new RegExp(pattern).test(log);
  } catch {
    // Loader đã kiểm cú pháp regex; chuỗi không biên dịch được thì so như chuỗi con.
    return log.includes(pattern);
  }
}

/** Mọi trường khai báo trong `match` phải khớp. */
export function ruleMatches(rule: CiRule, c: Check): boolean {
  const m = rule.match;
  if (m.job !== undefined && m.job !== c.job) return false;
  if (m.check !== undefined && m.check !== c.name) return false;
  if (m.log_pattern !== undefined && !logMatches(m.log_pattern, c.log_excerpt)) return false;
  return true;
}

/**
 * Áp rule đầu tiên khớp cho từng check `failure` (research R-21). Check thất bại không khớp rule nào làm
 * cả kết quả thành `unclassified` (WAITING `human_input` `ci_unclassified`); không có check thất bại nào
 * cũng là `unclassified`.
 */
export function classifyFailures(rules: readonly CiRule[], checks: readonly Check[]): Classification {
  const failures = checks.filter((c) => c.state === 'failure');
  const byCheck: { check: string; class: CiClass }[] = [];
  const unmatched: string[] = [];
  for (const c of failures) {
    const rule = rules.find((r) => ruleMatches(r, c));
    if (rule) byCheck.push({ check: c.name, class: rule.class });
    else unmatched.push(c.name);
  }
  if (failures.length === 0 || unmatched.length > 0) return { kind: 'unclassified', checks: unmatched };
  const worst = byCheck.reduce((a, b) => (SEVERITY[b.class] > SEVERITY[a.class] ? b : a));
  return { kind: 'class', class: worst.class, by_check: byCheck };
}
