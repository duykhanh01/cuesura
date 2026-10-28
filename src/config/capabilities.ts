import type { NormalizedUser } from '../domain/config.ts';
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

/** Daemon 002 chỉ hoàn tất khi merge được xác nhận từ bên ngoài; không cấu hình nào đổi được. */
export const DAEMON_COMPLETION_MODE = 'external_confirmation' as const;

/** Tính năng cấu hình hợp lệ ở 001 nhưng daemon 002 không chạy (contracts/cli-daemon.md). */
export type DaemonUnsupportedFeature = {
  code: 'unsupported_feature';
  feature: 'yolo';
  file: string;
  line: number;
  col: number;
};

/**
 * `cusr.yaml` không khai được merge/yolo (khoá chỉ thuộc người dùng); phía người dùng, `yolo: true` vẫn
 * hợp lệ với 001 nên chỉ được báo ở đây để daemon từ chối thay vì tự merge.
 */
export function findDaemonUnsupported(user: NormalizedUser, at: Locator): DaemonUnsupportedFeature[] {
  return user.yolo ? [{ code: 'unsupported_feature', feature: 'yolo', ...at(['yolo']) }] : [];
}
