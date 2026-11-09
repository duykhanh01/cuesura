/**
 * Upgrade from the decider of feature 006 (007, FR-122, R-13). A run it left on disk is closed with
 * `decider_ran` (`apply: false`, `superseded`), which settles the agent run it held, and its record goes.
 * A run that may still be going is first stopped; until that is proven, its record stays and its task
 * gets no deputy turn (constitution II: no replacement before the old attempt has provably ended).
 * `DeciderRan` events and `agent:decider` answers stay in the log and replay as before.
 */
import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock, HarnessInput, HarnessPort } from '../adapters/ports.ts';
import { submit } from '../application/triage.ts';
import { MAX_ENVELOPE_IDS } from '../domain/trigger.ts';
import type { Uuid } from '../shared/brand.ts';
import type { Store } from '../store/index.ts';

type RunRecord = {
  readonly task_id: string;
  readonly question_id: string;
  readonly input: HarnessInput;
};

/** Whether the run is proven not to be running any more: never launched, or stopped. */
async function ended(harness: HarnessPort | undefined, input: HarnessInput): Promise<boolean> {
  if (harness?.started?.(input.attempt_id) === false) return true;
  if (harness?.stop === undefined) return false;
  try {
    return (await harness.stop(input)) !== 'unknown';
  } catch {
    return false;
  }
}

/** Closes what the decider left; returns the tasks whose run could not be proven ended yet. */
export async function retireDecider(deps: {
  readonly store: Store;
  readonly clock: Pick<Clock, 'now'>;
  readonly newId: () => string;
  readonly harnesses: Readonly<Record<string, HarnessPort>>;
  readonly recordsDir: string;
  readonly log?: (line: string) => void;
}): Promise<ReadonlySet<string>> {
  const held = new Set<string>();
  if (!existsSync(deps.recordsDir)) return held;
  for (const name of readdirSync(deps.recordsDir)) {
    const file = join(deps.recordsDir, name);
    let record: RunRecord;
    try {
      record = JSON.parse(readFileSync(file, 'utf8')) as RunRecord;
    } catch {
      rmSync(file, { force: true });
      continue;
    }
    const attempt = record.input.attempt_id;
    const s = deps.store.readTask(record.task_id as Uuid);
    if (s !== null && s.decider_runs?.[attempt] === undefined) {
      const harness = deps.harnesses[record.input.binding.harness];
      if (!(await ended(harness, record.input))) {
        held.add(record.task_id);
        deps.log?.(
          `decider upgrade: run ${attempt} not proven ended; task ${record.task_id} waits`,
        );
        continue;
      }
      const r = submit(deps.store, {
        task_id: record.task_id,
        dedup_key: `decider:${attempt}`,
        trigger: {
          kind: 'decider_ran',
          question_id: record.question_id as Uuid,
          attempt_id: attempt,
          usage: { basis: 'unavailable' },
          invoked: harness?.started?.(attempt) !== false,
          decision: null,
          apply: false,
          failure: 'superseded',
        },
        now: deps.clock.now(),
        ids: Array.from({ length: MAX_ENVELOPE_IDS }, () => deps.newId()),
      });
      if (!r.ok) {
        deps.log?.(`decider upgrade: task ${record.task_id}: ${r.error.code}`);
        // Kept for the next round; any other refusal leaves nothing to settle.
        if (r.error.code === 'write_failed') {
          held.add(record.task_id);
          continue;
        }
      }
    }
    rmSync(file, { force: true });
  }
  try {
    rmdirSync(deps.recordsDir);
  } catch {
    // Not empty or already gone: nothing else depends on it.
  }
  return held;
}
