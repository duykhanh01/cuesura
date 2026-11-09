/**
 * One daemon life for the runtime crash driver (T093), run as
 * `node test/support/runtime-crash-child.ts <life.json>`. Like cusrd it first recovers the store
 * (writer lock, schema, projections, operation reconcile, spool ingest), then works until its target
 * holds. The kill switch SIGKILLs it at the planned point; otherwise it prints a summary and exits 0,
 * or 5 when it went idle short of its target.
 */
import fs, { existsSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { ingestOperationSpool } from '../../src/daemon/ingest.ts';
import {
  heldReason,
  recoverOperations,
  recoverStore,
  type StartupDeps,
} from '../../src/daemon/startup.ts';
import { isUnresolved } from '../../src/engine/runtime.ts';
import { ACKED_DIR } from '../../src/runner/files.ts';
import { unitName } from '../../src/runner/identity.ts';
import { Redactor } from '../../src/runner/redact.ts';
import { SystemdSupervisor, inspectUnit } from '../../src/runner/supervisor.ts';
import { asEpochMs, type Uuid } from '../../src/shared/brand.ts';
import { openStore, type Store } from '../../src/store/index.ts';
import {
  KillSwitch,
  driveFlow,
  flowDaemon,
  guardStore,
  layout,
  runFile,
  type LifeArgs,
} from './runtime-crash.ts';

const file = process.argv[2];
if (file === undefined) throw new Error('missing life file');
const args = JSON.parse(readFileSync(file, 'utf8')) as LifeArgs;
const lay = layout(args.root);
const sw = new KillSwitch(lay.ledger, args.life, args.kill);
const clock = { t: args.now };
const done = (code: number, summary: Record<string, unknown>): never => {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exit(code);
};

/**
 * Startup recovery. The host probes are the real ones (systemd, the kernel lock, /proc) only where a
 * real unit can exist; operations of the flow groups run inside the daemon and have none.
 */
async function recover(host: boolean): Promise<{ store: Store; held: string | null }> {
  const base: StartupDeps = {
    path: lay.store,
    dataDir: lay.data,
    redactor: new Redactor(),
    inspect: (id) => inspectUnit(id),
    now: () => clock.t,
    newId: uuidv7,
  };
  const r = await recoverStore(
    host
      ? base
      : {
          ...base,
          inspect: (id) =>
            Promise.resolve({
              unit: unitName(id),
              state: 'not_found',
              invocation_id: null,
              cgroup: null,
            }),
          probeLock: () => 'free',
        },
  );
  if (!r.ok) return done(3, { open_failed: r.error });
  if (r.value.report.blocked !== null) done(4, { blocked: r.value.report.blocked });
  return { store: r.value.store, held: r.value.report.held };
}

async function flow(): Promise<void> {
  if (args.target === undefined) throw new Error('flow life without target');
  const { store: raw, held } = await recover(false);
  const store = guardStore(raw, sw);
  const dispatcher = flowDaemon(lay, store, sw, clock, args.task_id);
  dispatcher.hold(held);
  let holding = held;
  const outcome = await driveFlow(
    store,
    dispatcher,
    clock,
    args.task_id,
    args.target,
    sw,
    async () => {
      if (holding === null) return false;
      const r = await recoverOperations({
        store,
        dataDir: lay.data,
        redactor: new Redactor(),
        inspect: (id) =>
          Promise.resolve({
            unit: unitName(id),
            state: 'not_found',
            invocation_id: null,
            cgroup: null,
          }),
        probeLock: () => 'free',
        now: () => clock.t,
        newId: uuidv7,
      });
      holding = heldReason(r.reconcile.unresolved);
      dispatcher.hold(holding);
      return holding !== null;
    },
  );
  const s = raw.readTask(args.task_id as Uuid);
  raw.close();
  done(outcome === 'reached' || 'idle' in args.target ? 0 : 5, {
    outcome,
    status: s?.status,
    wait: s?.wait?.detail['code'] ?? null,
    held: holding,
    effects: Object.values(s?.effects ?? {}).map((e) => [e.kind, e.step, e.status]),
  });
}

/**
 * An agent run under systemd: claim and launch while the effect is pending, then follow the operation
 * through reconcile and spool ingest until it resolves, as cusrd does for runs no handler owns.
 */
async function spawn(): Promise<void> {
  if (args.runner === undefined || args.argv === undefined)
    throw new Error('spawn life without runner');
  const deps = {
    dataDir: lay.data,
    redactor: new Redactor(),
    inspect: (id: string) => inspectUnit(id),
    now: () => clock.t,
    newId: uuidv7,
  };
  const recovered = await recover(true);
  const raw = recovered.store;
  let held = recovered.held;
  const store = guardStore(raw, sw);
  const seen = new Set<string>();
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    const s = store.readTask(args.task_id as Uuid);
    if (s === null) throw new Error('no task');
    const pending = Object.values(s.effects).find(
      (e) => e.kind === 'start_agent' && e.status === 'pending',
    );
    if (pending !== undefined && held === null) {
      const op = uuidv7();
      const claimed = store.claimEffect(pending.id as Uuid, asEpochMs(clock.t), {
        require_runtime: true,
        operation: {
          operation_id: op,
          kind: 'agent',
          launch_nonce: `dispatch-${op}`,
          unit: unitName(op),
          holds_slot: true,
        },
      });
      if (!claimed.ok) done(6, { claim_failed: claimed.error });
      const attempt = store.readTask(args.task_id as Uuid)?.effects[pending.id]?.attempt_id;
      if (attempt == null) done(6, { no_attempt: pending.id });
      sw.hit('spawn:launch:before', 'before_effect');
      const launched = await new SystemdSupervisor({
        dataDir: lay.data,
        runnerCommand: args.runner,
      }).launch({
        operation_id: op,
        kind: 'agent',
        run_dir_kind: 'runs',
        run_id: attempt as string,
        argv: [...args.argv],
        cwd: lay.data,
        env: { PATH: '/usr/bin:/bin' },
        wall_ms: 120_000,
        deadline_at: asEpochMs(Date.now() + 120_000),
        term_grace_ms: 2_000,
        kill_verify_ms: 2_000,
        launch_nonce: `launch-${op}`,
      });
      if (!launched.ok) done(6, { launch_failed: launched.error });
      sw.hit('spawn:launch:after', 'after_external');
      continue;
    }
    const open = Object.values(s.operations).filter((o) => o.kind === 'agent' && isUnresolved(o));
    if (open.length === 0) break;
    // The pass runs only once each open run has exited or its unit is gone, so the exit receipt is
    // always seen (and its kill point passed) before the pass ingests it.
    let ready = true;
    for (const o of open) {
      const attempt = s.effects[o.effect_id]?.attempt_id;
      if (attempt == null) continue;
      const dir = join(lay.data, 'runs', attempt);
      for (const f of ['pid', 'exit'] as const)
        if (!seen.has(`${o.id}:${f}`) && existsSync(runFile(dir, f))) {
          seen.add(`${o.id}:${f}`);
          sw.hit(`spawn:${f}:after`, 'after_external');
        }
      if (!seen.has(`${o.id}:exit`) && (await inspectUnit(o.id)).state === 'active') ready = false;
    }
    if (!ready) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    const r = await recoverOperations({ ...deps, store });
    held = heldReason(r.reconcile.unresolved);
    await new Promise((r) => setTimeout(r, 100));
  }
  const s = raw.readTask(args.task_id as Uuid);
  raw.close();
  done(0, {
    operations: Object.values(s?.operations ?? {}).map((o) => [o.id, o.status]),
    effects: Object.values(s?.effects ?? {}).map((e) => [e.kind, e.status]),
  });
}

/**
 * The daemon side of a runner's spool: ingest from the committed cursor in small batches and ACK
 * (move sealed segments out of the spool) only behind it. ACK passes a kill point at each segment it moves.
 */
function spool(): void {
  if (args.operation_id === undefined) throw new Error('spool life without op');
  const rename = fs.renameSync;
  fs.renameSync = (from: fs.PathLike, to: fs.PathLike) => {
    const ack = String(to).includes(`/${ACKED_DIR}/`);
    if (ack) sw.hit('ack:move:before', 'before_effect');
    rename(from, to);
    if (ack) sw.hit('ack:move:after', 'after_external');
  };
  syncBuiltinESMExports();
  const opened = openStore(lay.store);
  if (!opened.ok) return done(3, { open_failed: opened.error });
  const store = guardStore(opened.value, sw);
  const reports = [];
  for (let i = 0; i < 100; i++) {
    const r = ingestOperationSpool(
      {
        store,
        dataDir: lay.data,
        redactor: new Redactor(),
        ...(args.limits === undefined ? {} : { limits: args.limits }),
        now: () => clock.t,
        newId: uuidv7,
        batchRecords: args.batch_records ?? 4,
      },
      args.task_id,
      args.operation_id,
    );
    reports.push({ status: r.status, records: r.records, acked: r.acked });
    if (r.status !== 'ingested') break;
  }
  opened.value.close();
  const last = reports.at(-1);
  done(last?.status === 'up_to_date' ? 0 : 5, { reports });
}

if (args.group === 'spawn_adoption') await spawn();
else if (args.group === 'output_ack') spool();
else await flow();
