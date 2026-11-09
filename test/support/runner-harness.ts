/**
 * Test doubles around the real {@link RunnerHarness}: archived-plan fixture replay
 * and an in-process process port that runs the real runner lifecycle without systemd. They exercise
 * everything the harness does around the boundary (pin, manifest, home, files, records, validation),
 * never native harness isolation itself. Host launches and systemd recovery have separate suites.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  manifestFromEvidence,
  observeHarness,
  type EvidenceEntry,
} from '../../src/application/capabilities.ts';
import { claudeAdapter } from '../../src/adapters/harness/claude.ts';
import { codexAdapter } from '../../src/adapters/harness/codex.ts';
import { wireRoleSchema } from '../../src/adapters/harness/result-schema.ts';
import { hostInnerMode, type VendorPin } from '../../src/adapters/harness/vendor.ts';
import type {
  LaunchError,
  OperationLaunch,
  ProcessPort,
  SandboxLaunchPlan,
  SandboxLayout,
  SandboxPlanError,
  SandboxProvider,
  StopOutcome,
  UnitObservation,
} from '../../src/adapters/ports.ts';
import type { CapabilityManifest } from '../../src/domain/runtime.ts';
import { RUN_FILES, RunDir } from '../../src/runner/files.ts';
import { execOperation } from '../../src/runner/lifecycle.ts';
import { homeSecretValues, readInstalledAuth } from '../../src/runner/private-home.ts';
import { Redactor } from '../../src/runner/redact.ts';
import { IN_SANDBOX } from '../../src/runner/sandbox.ts';
import { InvocationSpecSchema } from '../../src/runner/supervisor.ts';
import { hashCanonical } from '../../src/shared/hash.ts';
import type { Hash } from '../../src/shared/brand.ts';
import { err, ok, type Result } from '../../src/shared/result.ts';
import { readRealJson, vendorPin } from './harness-fixtures.ts';

export const FAKE_VENDOR = fileURLToPath(
  new URL('../fixtures/runtime/fake-vendor/vendor.js', import.meta.url),
);

/**
 * Maps the fixed in-sandbox paths onto the host layout and runs the command directly. Test only: it
 * enforces nothing, which is exactly what lets the write-zone canary be observed.
 */
/** The layout shape {@link PassThroughSandbox} reports for a role. */
export function passThroughShape(role: string): Hash {
  return hashCanonical(['pass-through', role]);
}

const PASS_THROUGH_SHAPES: Readonly<Record<string, Hash>> = Object.fromEntries(
  (['coder', 'fixer', 'reviewer'] as const).map((r) => [r, passThroughShape(r)]),
);

export class PassThroughSandbox implements SandboxProvider {
  readonly provider = 'bwrap' as const;
  readonly plans: SandboxLayout[] = [];
  fail: SandboxPlanError | null = null;

  plan(
    layout: SandboxLayout,
    command: readonly string[],
  ): Result<SandboxLaunchPlan, SandboxPlanError> {
    if (this.fail !== null) return err(this.fail);
    this.plans.push(layout);
    const map: [string, string | null][] = [
      [IN_SANDBOX.scratch, layout.scratch],
      [IN_SANDBOX.context, layout.context],
      [IN_SANDBOX.schema, layout.schema],
      [IN_SANDBOX.home, layout.private_home],
    ];
    const rewrite = (a: string): string =>
      map.reduce((s, [from, to]) => (to === null ? s : s.split(from).join(to)), a);
    return ok({
      isolation_mode: 'isolated',
      provider: 'bwrap',
      role: layout.role,
      argv: command.map(rewrite),
      cwd: layout.worktree,
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: layout.private_home ?? '/nonexistent',
        FAKE_SANDBOX_SCRATCH: layout.scratch,
        ...layout.env,
      },
      network: 'internet_outbound',
      mount_sources: [],
      layout_digest: hashCanonical(layout),
      layout_shape: passThroughShape(layout.role),
      proof_refs: ['test:pass-through'],
    });
  }
}

/** Runs the real lifecycle in this process instead of a transient unit. */
export class InlineProcessPort implements ProcessPort {
  readonly launches: OperationLaunch[] = [];
  readonly #running = new Map<string, { done: boolean; stop: () => void }>();
  readonly dataDir: string;
  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  launch(
    spec: OperationLaunch,
  ): Promise<Result<{ unit: string; invocation_id: string | null }, LaunchError>> {
    this.launches.push(spec);
    const probe = RunDir.open({
      dataDir: this.dataDir,
      kind: spec.run_dir_kind,
      id: spec.run_id,
      redactor: new Redactor(),
    });
    probe.writeJson(
      RUN_FILES.invocation,
      InvocationSpecSchema.parse({
        schema_version: 1,
        operation_id: spec.operation_id,
        kind: spec.kind,
        run_dir_kind: spec.run_dir_kind,
        run_id: spec.run_id,
        argv: [...spec.argv],
        cwd: spec.cwd,
        env: { ...spec.env },
        wall_ms: spec.wall_ms,
        deadline_at: spec.deadline_at,
        term_grace_ms: spec.term_grace_ms,
        kill_verify_ms: spec.kill_verify_ms,
        launch_nonce: spec.launch_nonce,
        stdin: spec.stdin ?? null,
        stall_ms: spec.stall_ms ?? null,
        watch: [...(spec.watch ?? [])],
      }),
    );
    const run = RunDir.open({
      dataDir: this.dataDir,
      kind: spec.run_dir_kind,
      id: spec.run_id,
      redactor: new Redactor({
        values: homeSecretValues(readInstalledAuth(probe)),
      }),
    });
    const entry = { done: false, stop: (): void => undefined };
    this.#running.set(spec.operation_id, entry);
    void execOperation(run, {
      sample_ms: 50,
      onStop: (s) => {
        entry.stop = s;
        return () => undefined;
      },
    }).finally(() => (entry.done = true));
    return Promise.resolve(ok({ unit: `inline-${spec.operation_id}`, invocation_id: null }));
  }

  inspect(operationId: string): Promise<UnitObservation> {
    const e = this.#running.get(operationId);
    return Promise.resolve({
      unit: `inline-${operationId}`,
      state: e === undefined ? 'not_found' : e.done ? 'exited' : 'active',
      invocation_id: null,
      cgroup: null,
    });
  }

  stop(operationId: string): Promise<StopOutcome> {
    const e = this.#running.get(operationId);
    if (e === undefined || e.done) return Promise.resolve('not_running');
    e.stop();
    return Promise.resolve('stopped');
  }
}

type Evidence = { vendors: Record<'claude' | 'codex', EvidenceEntry> };

/** A copy of the fake vendor whose digest the pin records, so a test can change it on disk. */
export function fakeVendorPin(
  vendor: 'claude' | 'codex',
  dir: string,
  env: Record<string, string> = {},
): VendorPin {
  const bin = join(dir, `${vendor}-bin.js`);
  cpSync(FAKE_VENDOR, bin);
  const sha = createHash('sha256').update(readFileSync(bin)).digest('hex');
  const pin = vendorPin(vendor);
  return {
    ...pin,
    binary: { ...pin.binary, realpath: realpathSync(bin), sha256: sha },
    env: { ...env },
    home_files: pin.home_files,
  };
}

export const HOST_POLICY_HASH = hashCanonical('test host policy');

/** The manifest a doctor would record for this pin from the T007 evidence. */
export function evidenceManifest(
  pin: VendorPin,
  over: Partial<EvidenceEntry> = {},
  layoutShapes: Readonly<Record<string, Hash>> = PASS_THROUGH_SHAPES,
): CapabilityManifest {
  const adapter = pin.vendor === 'claude' ? claudeAdapter : codexAdapter;
  const evidence = readRealJson<Evidence>('capability-manifest.json');
  const entry = { ...evidence.vendors[pin.vendor], ...over };
  const host_execution = entry.isolation_mode === 'native';
  const inner = host_execution
    ? hostInnerMode(pin)
    : entry.selected_inner_mode === 'external_verified'
      ? 'external_verified'
      : 'native';
  const plan = adapter.plan(pin, {
    role: 'coder',
    model: 'm',
    effort: null,
    schema: wireRoleSchema('coder', {
      omit_meta_schema: pin.vendor === 'claude',
    }),
    cwd: '/w',
    paths: IN_SANDBOX,
    host_execution,
    inner_mode: inner,
    session: null,
  });
  if (!plan.ok) throw new Error(plan.error.message);
  const observed = observeHarness(pin, plan.value.settings_hash, HOST_POLICY_HASH);
  if (!observed.ok) throw new Error(observed.error.message);
  return manifestFromEvidence({
    entry,
    observed: observed.value,
    cost: pin.vendor === 'claude' ? 'reported' : 'unavailable',
    layout_shapes: layoutShapes,
    fixture_refs: ['test/fixtures/runtime/spike-0/harness/real-20261028/capability-manifest.json'],
    checked_at: 0,
  });
}

export function tempDir(prefix: string, dirs: string[]): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
