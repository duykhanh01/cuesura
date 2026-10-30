import type { RunnerExit } from '../../src/runner/lifecycle.ts';

/** A clean exit.json of an operation that ended at `endedAt`. */
export function runExit(OP: string, endedAt: number): RunnerExit {
  return {
    schema_version: 1,
    operation_id: OP,
    run_id: OP,
    launch_nonce: 'nonce-1',
    outcome: 'exited',
    exit_code: 0,
    signal: null,
    spawned: true,
    started_at: endedAt - 1_000,
    ended_at: endedAt,
    duration_ms: 1_000,
    deadline_at: endedAt + 60_000,
    termination: {
      term_sent: false,
      kill_sent: false,
      tree_empty_verified: true,
      scope: 'unit_cgroup',
      killed_after_exit: 0,
    },
    progress: { last_progress_at: endedAt, last_reasons: [], samples: 1 },
    artifacts: { records: 0, last_seq: 0, truncated_records: 0 },
    error: null,
  };
}
