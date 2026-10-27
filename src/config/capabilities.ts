import type { Workflow } from '../domain/workflow.ts';
import { isSupportedStructure, unsupportedDecisionPoints } from '../policy/support.ts';
import type { Locator } from './checks.ts';

/** Cấu hình hợp lệ nhưng có phần feature này chưa chạy được (contracts/core-api.md, research R-20). */
export type UnsupportedFeature = {
  code: 'decision_mode_unsupported' | 'unsupported_workflow';
  workflow: string;
  points?: string[];
  file: string;
  line: number;
  col: number;
};

/** Không làm cấu hình lỗi; `freeze` chặn task dùng đúng workflow đó (FR-039, FR-041). */
export function findUnsupported(workflows: Record<string, Workflow>, at: Locator): UnsupportedFeature[] {
  const out: UnsupportedFeature[] = [];
  for (const wn of Object.keys(workflows).sort()) {
    const w = workflows[wn] as Workflow;
    if (!isSupportedStructure(w)) {
      out.push({ code: 'unsupported_workflow', workflow: wn, ...at(['workflows', wn]) });
    }
    const points = unsupportedDecisionPoints(w);
    if (points.length > 0) {
      out.push({ code: 'decision_mode_unsupported', workflow: wn, points, ...at(['workflows', wn, 'decisions', points[0] as string]) });
    }
  }
  return out;
}
