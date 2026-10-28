/** Điểm ngắt của research R-08 theo thứ tự trong transaction `accept`; `after_runtime` thêm cho bảng runtime 002. */
export const CRASH_POINTS = [
  'after_dedup',
  'after_events',
  'after_projection',
  'after_effects',
  'after_timers',
  'after_runtime',
  'before_commit',
  'after_commit',
] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

export type CrashHook = (point: CrashPoint) => void;

export const NO_CRASH: CrashHook = () => {};

/**
 * Đọc `CUSR_CRASH_AT=<point>` một lần lúc mở kho. `CUSR_CRASH_AFTER=<n>` (mặc định 1) chọn lần thứ n đi
 * qua điểm đó, để bộ test ngắt giữa một chuỗi tín hiệu. Biến không đặt thì hook không làm gì.
 *
 * `SIGKILL` không chạy handler hay flush nào, gần với mất điện hơn `process.exit` (R-08).
 */
export function crashHookFromEnv(env: NodeJS.ProcessEnv = process.env): CrashHook {
  const at = env['CUSR_CRASH_AT'];
  if (at === undefined || at === '') return NO_CRASH;
  if (!(CRASH_POINTS as readonly string[]).includes(at))
    throw new Error(`CUSR_CRASH_AT không hợp lệ: ${at}`);
  const after = Number(env['CUSR_CRASH_AFTER'] || '1');
  if (!Number.isInteger(after) || after < 1)
    throw new Error(`CUSR_CRASH_AFTER không hợp lệ: ${env['CUSR_CRASH_AFTER']}`);
  let hits = 0;
  return (point) => {
    if (point !== at || ++hits !== after) return;
    process.kill(process.pid, 'SIGKILL');
  };
}
