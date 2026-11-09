import type { TaskState } from '../domain/state.ts';
import { hashCanonical } from '../shared/hash.ts';

/**
 * The task minus what background work moves (issue #262): the version, effect/timer/operation
 * bookkeeping, ingested output, the CI poll counters, the PR observation schedule (its rounds, ids
 * and times) and the timer a wait is armed on. Everything else stays, so any field a command may decide on (the wait and its detail,
 * accepted baselines, attempts, budget use, questions, run config, ...) still makes an earlier version
 * stale when it changes. A field moved only by background work belongs here, never a decision input.
 */
export function materialView(s: TaskState): Record<string, unknown> {
  const {
    version: _version,
    effects: _effects,
    timers: _timers,
    operations: _operations,
    artifacts: _artifacts,
    ci_polls: _ciPolls,
    observation,
    wait,
    run,
    ...rest
  } = s;
  const { ci_wait: _ciWait, ...runRest } = run;
  return {
    ...rest,
    run: runRest,
    observation:
      observation === null
        ? null
        : {
            subject: observation.subject,
            expired: observation.expired,
            last:
              observation.last === null
                ? null
                : { status: observation.last.status, head: observation.last.observed_head },
          },
    wait:
      wait === null
        ? null
        : {
            ...wait,
            detail: { ...wait.detail, timer_id: null },
            resume_when: wait.resume_when.filter((w) => !w.startsWith('timer(')),
          },
  };
}

export function materialDigest(s: TaskState): string {
  return hashCanonical(materialView(s));
}
