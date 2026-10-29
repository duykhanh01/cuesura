import type { Hash } from '../shared/brand.ts';
import {
  FORBIDDEN_DECIDER_POINTS,
  type DecisionPoint,
  type Workflow,
} from '../domain/workflow.ts';
import { SOFTWARE_DEV } from '../engine/workflows/software-dev.ts';
import { structureHash } from './structure-hash.ts';

/** Feature 001 chỉ chạy được graph của `software_dev@1` (FR-041, research R-11). */
export const SOFTWARE_DEV_STRUCTURE: Hash = structureHash(SOFTWARE_DEV);

export function isSupportedStructure(w: Workflow): boolean {
  return structureHash(w) === SOFTWARE_DEV_STRUCTURE;
}

/** Điểm quyết định dùng chế độ decider mà feature 001 chưa thực thi (FR-039). Điểm bị cấm đã là lỗi (FR-006). */
export function unsupportedDecisionPoints(w: Workflow): string[] {
  return Object.entries(w.decisions)
    .filter(
      ([p, mode]) =>
        mode !== 'human' &&
        !FORBIDDEN_DECIDER_POINTS.includes(p as DecisionPoint),
    )
    .map(([p]) => p)
    .sort();
}
