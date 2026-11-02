import type { Workflow } from '../domain/workflow.ts';
import { isSupportedStructure } from '../policy/support.ts';
import type { Locator } from './checks.ts';

export type UnsupportedFeature = {
  code: 'unsupported_workflow';
  workflow: string;
  file: string;
  line: number;
  col: number;
};

/** Valid configuration may use an unsupported workflow; freeze rejects only tasks that select it. */
export function findUnsupported(
  workflows: Record<string, Workflow>,
  at: Locator,
): UnsupportedFeature[] {
  const out: UnsupportedFeature[] = [];
  for (const wn of Object.keys(workflows).sort()) {
    const w = workflows[wn] as Workflow;
    if (!isSupportedStructure(w)) {
      out.push({
        code: 'unsupported_workflow',
        workflow: wn,
        ...at(['workflows', wn]),
      });
    }
  }
  return out;
}

export const DAEMON_COMPLETION_MODE = 'external_confirmation' as const;
