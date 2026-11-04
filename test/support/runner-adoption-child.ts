/**
 * Daemon stand-in for the runner adoption tests (T081), run as
 * `node test/support/runner-adoption-child.ts <args.json>`, in the foreground or as its own user unit.
 * Like cusrd it first recovers the store against the real host (systemd, the kernel operation lock,
 * /proc), then claims and launches the agent operation only while its effect is still pending, and
 * stays up until it is killed or its unit stops. Every step is appended to `log` as one JSON line.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { STORE_FILE } from '../../src/daemon/main.ts';
import { recoverStore } from '../../src/daemon/startup.ts';
import { unitName } from '../../src/runner/identity.ts';
import { Redactor } from '../../src/runner/redact.ts';
import { SystemdSupervisor, inspectUnit } from '../../src/runner/supervisor.ts';
import { asEpochMs, type Uuid } from '../../src/shared/brand.ts';

export type AdoptionChildArgs = {
  readonly data_dir: string;
  readonly task_id: string;
  readonly effect_id: string;
  readonly operation_id: string;
  readonly now: number;
  /** Runner entrypoint prefix handed to the supervisor. */
  readonly runner: readonly string[];
  readonly argv: readonly string[];
  readonly log: string;
  /** Stay up right after the claim commits, before any unit exists. */
  readonly stop_after_claim: boolean;
};

const file = process.argv[2];
if (file === undefined) throw new Error('missing args file');
const args = JSON.parse(readFileSync(file, 'utf8')) as AdoptionChildArgs;
const log = (entry: Record<string, unknown>): void =>
  appendFileSync(args.log, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
const hang = (): void => {
  setInterval(() => undefined, 60_000);
};

const recovered = await recoverStore({
  path: join(args.data_dir, STORE_FILE),
  dataDir: args.data_dir,
  redactor: new Redactor(),
  inspect: (id) => inspectUnit(id),
  now: () => args.now,
  newId: uuidv7,
});
if (!recovered.ok) {
  log({ step: 'open_failed', error: recovered.error });
  process.exit(3);
}
const { store, report } = recovered.value;
log({
  step: 'recovered',
  operations: report.operations.map((o) => ({
    id: o.operation_id,
    status: o.finding.status,
    reason: o.finding.reason,
  })),
  held: report.held,
  blocked: report.blocked,
});

const effect = store.readTask(args.task_id as Uuid)?.effects[args.effect_id];
if (effect?.status !== 'pending') {
  const op = store.readTask(args.task_id as Uuid)?.operations[args.operation_id];
  log({ step: 'adopted', effect: effect?.status, operation: op?.status });
  hang();
} else {
  const claimed = store.claimEffect(args.effect_id as Uuid, asEpochMs(args.now), {
    require_runtime: true,
    operation: {
      operation_id: args.operation_id,
      kind: 'agent',
      launch_nonce: 'dispatch-1',
      unit: unitName(args.operation_id),
      holds_slot: true,
    },
  });
  if (!claimed.ok) {
    log({ step: 'claim_failed', error: claimed.error });
    process.exit(4);
  }
  const attempt = store.readTask(args.task_id as Uuid)?.effects[args.effect_id]?.attempt_id;
  log({ step: 'claimed', attempt });
  if (args.stop_after_claim || attempt == null) hang();
  else {
    const launched = await new SystemdSupervisor({
      dataDir: args.data_dir,
      runnerCommand: args.runner,
    }).launch({
      operation_id: args.operation_id,
      kind: 'agent',
      run_dir_kind: 'runs',
      run_id: attempt,
      argv: [...args.argv],
      cwd: args.data_dir,
      env: { PATH: '/usr/bin:/bin' },
      wall_ms: 300_000,
      deadline_at: asEpochMs(Date.now() + 300_000),
      term_grace_ms: 2_000,
      kill_verify_ms: 2_000,
      launch_nonce: `launch-${args.operation_id}`,
    });
    log({ step: 'launched', result: launched });
    hang();
  }
}
