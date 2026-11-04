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
 * Read crash settings once at store open. CUSR_CRASH_AFTER selects the nth visit (default: 1).
 * SIGKILL skips handlers and flushing, approximating sudden power loss.
 */
export function crashHookFromEnv(env: NodeJS.ProcessEnv = process.env): CrashHook {
  const at = env['CUSR_CRASH_AT'];
  if (at === undefined || at === '') return NO_CRASH;
  if (!(CRASH_POINTS as readonly string[]).includes(at))
    throw new Error(`Invalid CUSR_CRASH_AT: ${at}`);
  const after = Number(env['CUSR_CRASH_AFTER'] || '1');
  if (!Number.isInteger(after) || after < 1)
    throw new Error(`Invalid CUSR_CRASH_AFTER: ${env['CUSR_CRASH_AFTER']}`);
  let hits = 0;
  return (point) => {
    if (point !== at || ++hits !== after) return;
    process.kill(process.pid, 'SIGKILL');
  };
}
