import { evalPredicate, type PredicateFacts } from '../domain/workflow.ts';
import type { BindingRule } from '../domain/config.ts';
import type { CanonicalTask } from '../domain/task.ts';

export function bindingFacts(task: CanonicalTask): PredicateFacts {
  return {
    labels: task.labels,
    size: task.size,
    task_type: task.type,
    attempt: 1,
    target_branch: task.base_branch,
  };
}

export function resolveBinding(
  rules: readonly BindingRule[],
  facts: PredicateFacts,
  allowModels: readonly string[] | null,
): { index: number; rule: BindingRule } | null {
  for (const [index, rule] of rules.entries()) {
    if (rule.when !== null && !evalPredicate(rule.when, facts)) continue;
    if (allowModels !== null && !allowModels.includes(rule.model)) continue;
    return { index, rule };
  }
  return null;
}
