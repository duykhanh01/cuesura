/**
 * T140: the wiring `cusrd` runs with, end to end on this host. `productionControl` under the real daemon
 * loop drives a seeded task through a transient systemd unit, host launch and real Git to a green PR on a
 * bare remote, then to DONE after a merge, with nothing else calling the dispatcher, timers, observation or
 * drain. Only the vendor binary (a replay of the T007 runs, no model) and GitHub are stand-ins, and no
 * network is used. Harness records are the files an owner writes, loaded the way the daemon loads them.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RUNTIME_LIMITS } from '../../../src/domain/runtime.ts';
import {
  hostInnerMode,
  nativeSandboxEnabled,
  type VendorPin,
} from '../../../src/adapters/harness/vendor.ts';
import { startDaemon, STORE_FILE, systemClock } from '../../../src/daemon/main.ts';
import {
  productionControl,
  readPrompts,
  type ProductionSeams,
} from '../../../src/daemon/production.ts';
import { validateConfig } from '../../../src/config/validate.ts';
import {
  harnessIdentity,
  harnessRecordProblem,
  hostSandbox,
  loadHarnessRecord,
  recordManifest,
} from '../../../src/runner/harness-records.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, freezeOk } from '../../support/builders.ts';
import { FakeGitHub } from '../../support/fake-github.ts';
import { gitSandbox } from '../../support/git-repo.ts';
import { homeFileContent, REAL } from '../../support/harness-fixtures.ts';
import { fakeVendorPin } from '../../support/runner-harness.ts';
import { confirmedRuntime, proposeAndConfirm, selectionFor } from '../../support/runtime.ts';
import { StoreDriver } from '../../support/store-driver.ts';

const EVIDENCE = join(REAL, 'capability-manifest.json');

const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-production-')));
const g = gitSandbox('cusr-production-git-');
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
  g.cleanup();
});
let n = 0;

/** A user config with a `runtime` section; the daemon reads it from disk like any other. */
function setup() {
  const dir = join(base, `h${n++}`);
  mkdirSync(dir, { recursive: true });
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { mode: 0o700 });
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const configPath = join(dir, 'config.yaml');
  const credential = join(dir, 'claude-auth.json');
  // Next to the binary: the only host directory of this test the sandbox mounts.
  const replay = join(bin, 'replay');
  cpSync(join(REAL, 's0-claude-coder-1793172185'), replay, { recursive: true });
  const pin = fakeVendorPin('claude', bin, {
    FAKE_VENDOR_REPLAY: replay,
    FAKE_VENDOR_MODE: 'publish,write_worktree',
    FAKE_VENDOR_ECHO_MODEL: '1',
  });
  const refs = Object.fromEntries(
    pin.home_files.map((h) => [h.credential, `${credential}.${h.credential}`]),
  );
  for (const h of pin.home_files)
    writeFileSync(
      refs[h.credential] as string,
      homeFileContent(h, JSON.stringify({ accessToken: 'sk-ant-canary-0123456789' })),
    );
  writeFileSync(
    configPath,
    [
      'version: 1',
      'harnesses:',
      '  claude: { cmd: claude, auth: subscription, pool: anthropic }',
      'pools: { anthropic: 1 }',
      'runtime:',
      `  data_dir: ${dataDir}`,
      '  credential_refs:',
      ...Object.entries(refs).map(([k, v]) => `    ${k}: ${v}`),
      '',
    ].join('\n'),
  );
  const validated = validateConfig({
    user: { file: configPath, text: readFileSync(configPath, 'utf8') },
    packs: {},
  });
  if (!validated.ok) throw new Error(JSON.stringify(validated.error));
  const runtime = validated.value.runtime;
  if (runtime === null) throw new Error('no runtime');
  const recordDir = join(dataDir, 'harnesses', 'claude');
  mkdirSync(recordDir, { recursive: true, mode: 0o700 });
  const writePin = (p: VendorPin): void =>
    writeFileSync(join(recordDir, 'pin.json'), JSON.stringify(p), {
      mode: 0o600,
    });
  /** Evidence as `cusr-runner record-manifest` takes it: a proof of exactly this pin on this host. */
  const evidenceFor = (p: VendorPin): string => {
    const raw = JSON.parse(readFileSync(EVIDENCE, 'utf8')) as {
      vendors: Record<string, Record<string, unknown>>;
    };
    const attested = harnessIdentity({
      pin: p,
      dataDir,
      configPath,
      runtime,
    });
    if (!attested.ok) throw new Error(attested.error);
    const inner = hostInnerMode(p);
    raw.vendors['claude'] = {
      ...raw.vendors['claude'],
      isolation_mode: 'native',
      selected_inner_mode: inner === 'native' ? 'internal_required' : inner,
      native_result: nativeSandboxEnabled(p) ? 'passed' : 'not_tried',
      outer_proof_hash: null,
      binary: { sha256: p.binary.sha256 },
      attested: attested.value,
    };
    const file = join(dir, 'evidence.json');
    writeFileSync(file, JSON.stringify(raw));
    return file;
  };
  return {
    refs,
    dir,
    dataDir,
    configPath,
    runtime,
    pin,
    recordDir,
    writePin,
    evidenceFor,
  };
}

describe('harness records', () => {
  it('keeps a shell proof valid when the daemon has another PATH and no terminal environment', () => {
    const h = setup();
    try {
      vi.stubEnv('PATH', `${process.env['PATH'] ?? ''}:/shell/nvm/bin`);
      vi.stubEnv('TERM', 'xterm');
      vi.stubEnv('LANG', 'en_US.UTF-8');
      vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/1000');
      h.writePin(h.pin);
      const evidenceFile = h.evidenceFor(h.pin);
      vi.stubEnv('PATH', '/usr/bin:/bin');
      vi.stubEnv('TERM', undefined);
      vi.stubEnv('LANG', undefined);
      vi.stubEnv('XDG_RUNTIME_DIR', undefined);
      vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', undefined);
      const record = recordManifest({
        dataDir: h.dataDir,
        harness: 'claude',
        configPath: h.configPath,
        runtime: h.runtime,
        evidenceFile,
        fixtureRef: 'shell-proof',
        now: 1,
      });
      if (!record.ok) throw new Error(record.error);
      expect(
        harnessRecordProblem(
          { pin: h.pin, manifest: record.value },
          {
            isolation: 'internal_required',
            host_policy_hash: hostSandbox().policy_hash,
          },
        ),
      ).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['auto', 'full-access'] as const)(
    'requires a new proof when %s Claude sandbox configuration changes',
    (permission_mode) => {
      const h = setup();
      const off = {
        ...h.pin,
        permission_mode,
        settings: { ...h.pin.settings, sandbox: {} },
      };
      h.writePin(off);
      const r = recordManifest({
        dataDir: h.dataDir,
        harness: 'claude',
        configPath: h.configPath,
        runtime: h.runtime,
        evidenceFile: h.evidenceFor(off),
        fixtureRef: 'test-only-permissions',
        now: 1,
      });
      if (!r.ok) throw new Error(r.error);
      expect(r.value.native_result).toBe('not_tried');
      const opts = {
        isolation: 'internal_required' as const,
        host_policy_hash: hostSandbox().policy_hash,
      };
      expect(harnessRecordProblem({ pin: off, manifest: r.value }, opts)).toBeNull();
      const on = {
        ...off,
        settings: { ...off.settings, sandbox: { enabled: true } },
      };
      expect(harnessRecordProblem({ pin: on, manifest: r.value }, opts)).not.toBeNull();
      h.writePin(on);
      const again = recordManifest({
        dataDir: h.dataDir,
        harness: 'claude',
        configPath: h.configPath,
        runtime: h.runtime,
        evidenceFile: h.evidenceFor(on),
        fixtureRef: 'test-only-native',
        now: 1,
      });
      if (!again.ok) throw new Error(again.error);
      expect(harnessRecordProblem({ pin: on, manifest: again.value }, opts)).toBeNull();
      expect(again.value.native_result).toBe('passed');
    },
  );

  it('records explicit full access separately and refuses a subsequent implicit mode change', () => {
    const h = setup();
    const pin = {
      ...h.pin,
      permission_mode: 'full-access' as const,
      settings: { ...h.pin.settings, sandbox: { enabled: false } },
    };
    h.writePin(pin);
    const r = recordManifest({
      dataDir: h.dataDir,
      harness: 'claude',
      configPath: h.configPath,
      runtime: h.runtime,
      evidenceFile: h.evidenceFor(pin),
      fixtureRef: 'test-only-native-evidence',
      now: 1,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toMatchObject({
      provider: 'host',
      isolation_mode: 'native',
      selected_inner_mode: 'full_access',
      native_result: 'not_tried',
    });
    const opts = {
      isolation: 'internal_required' as const,
      host_policy_hash: hostSandbox().policy_hash,
    };
    expect(harnessRecordProblem({ pin, manifest: r.value }, opts)).toBeNull();
    expect(
      harnessRecordProblem({ pin: { ...pin, permission_mode: 'auto' }, manifest: r.value }, opts),
    ).toContain('permission mode differs');
  });

  it('records a manifest only from evidence of the pinned binary', () => {
    const h = setup();
    h.writePin(h.pin);
    const stale = recordManifest({
      dataDir: h.dataDir,
      harness: 'claude',
      configPath: h.configPath,
      runtime: h.runtime,
      evidenceFile: EVIDENCE,
      fixtureRef: EVIDENCE,
      now: 1,
    });
    expect(stale).toMatchObject({ ok: false });
    expect(stale.ok ? '' : stale.error).toContain('proves another binary');
    expect(existsSync(join(h.recordDir, 'manifest.json'))).toBe(false);
    expect(loadHarnessRecord(h.dataDir, 'claude').ok).toBe(false);

    const recorded = recordManifest({
      dataDir: h.dataDir,
      harness: 'claude',
      configPath: h.configPath,
      runtime: h.runtime,
      evidenceFile: h.evidenceFor(h.pin),
      fixtureRef: 'evidence.json',
      now: 1,
    });
    expect(recorded).toMatchObject({ ok: true });
    const loaded = loadHarnessRecord(h.dataDir, 'claude');
    if (!loaded.ok) throw new Error(loaded.error);
    const sandbox = hostSandbox();
    const check = {
      isolation: 'internal_required' as const,
      host_policy_hash: sandbox.policy_hash,
    };
    expect(harnessRecordProblem(loaded.value, check)).toBeNull();
    // A pin edited after the record, however small, is found before the next request and attempt.
    for (const changed of [{ max_turns: 100_000 }, { tools: ['WebFetch'] }])
      expect(
        harnessRecordProblem(
          {
            ...loaded.value,
            pin: { ...loaded.value.pin, ...changed },
          },
          check,
        ),
      ).toContain('environment changed');
    // Any change of what was proven stops the record from holding.
    expect(
      harnessRecordProblem(loaded.value, {
        ...check,
        host_policy_hash: `sha256:${'0'.repeat(64)}`,
      }),
    ).toContain('host sandbox policy');
    writeFileSync(h.pin.binary.realpath, '#!/bin/sh\n');
    expect(harnessRecordProblem(loaded.value, check)).toContain('digest');
  });

  it('refuses evidence that never proved this configuration, with the same binary', () => {
    const h = setup();
    const record = (evidenceFile: string) =>
      recordManifest({
        dataDir: h.dataDir,
        harness: 'claude',
        configPath: h.configPath,
        runtime: h.runtime,
        evidenceFile,
        fixtureRef: 'evidence.json',
        now: 1,
      });
    const proved = h.pin;
    const evidence = h.evidenceFor(proved);
    h.writePin(proved);
    expect(record(evidence)).toMatchObject({ ok: true });
    rmSync(join(h.recordDir, 'manifest.json'));

    // The permission rule goes, the binary and the evidence stay: `permission_enforced` was not shown.
    const settingsWithoutDeny = structuredClone(proved.settings) as {
      permissions: { deny?: unknown };
    };
    expect(settingsWithoutDeny.permissions.deny).toBeDefined();
    delete settingsWithoutDeny.permissions.deny;
    h.writePin({ ...proved, settings: settingsWithoutDeny });
    const settings = record(evidence);
    expect(settings.ok ? '' : settings.error).toContain('settings_hash');
    h.writePin({ ...proved, env: { ...proved.env, EXTRA: '1' } });
    const environment = record(evidence);
    expect(environment.ok ? '' : environment.error).toContain('environment_hash');
    // Handed straight to the binary's argv: a higher turn cap or a new tool was never shown either.
    for (const changed of [{ max_turns: 100_000 }, { tools: ['Bash', 'WebFetch'] }]) {
      h.writePin({ ...proved, ...changed });
      const r = record(evidence);
      expect(r.ok ? '' : r.error).toContain('environment_hash');
    }
    h.writePin({ ...proved, toolchain: ['/usr/lib'] });
    const layout = record(evidence);
    expect(layout.ok ? '' : layout.error).toContain('layout_shapes');
    expect(existsSync(join(h.recordDir, 'manifest.json'))).toBe(false);

    // Evidence that says nothing about its configuration, like the T007 fixture, proves none.
    const raw = JSON.parse(readFileSync(evidence, 'utf8')) as {
      vendors: { claude: { attested?: unknown } };
    };
    delete raw.vendors.claude.attested;
    writeFileSync(evidence, JSON.stringify(raw));
    h.writePin(proved);
    const silent = record(evidence);
    expect(silent.ok ? '' : silent.error).toContain('does not attest');
  });

  it('keeps a manifest valid when a credential file moves without promising outer isolation', () => {
    const h = setup();
    h.writePin(h.pin);
    const recorded = recordManifest({
      dataDir: h.dataDir,
      harness: 'claude',
      configPath: h.configPath,
      runtime: h.runtime,
      evidenceFile: h.evidenceFor(h.pin),
      fixtureRef: 'evidence.json',
      now: 1,
    });
    if (!recorded.ok) throw new Error(recorded.error);
    const after = hostSandbox();
    expect(
      harnessRecordProblem(
        { pin: h.pin, manifest: recorded.value },
        { isolation: 'internal_required', host_policy_hash: after.policy_hash },
      ),
    ).toBeNull();

    const store = openFileStoreForTest(join(h.dataDir, STORE_FILE));
    try {
      mkdirSync(join(h.dir, 'moved'));
      writeFileSync(join(h.dir, 'moved', '.git'), 'gitdir: /x\n');
      mkdirSync(join(h.dir, 'scratch-m'));
      const guarded = hostSandbox().provider.plan(
        {
          role: 'gate',
          worktree: join(h.dir, 'moved'),
          git_dirs: [],
          scratch: join(h.dir, 'scratch-m'),
          private_home: null,
          context: null,
          schema: null,
          toolchain: [],
          env: {},
          network: 'internet_outbound',
        },
        ['/bin/true'],
      );
      expect(guarded.ok).toBe(true);
      if (guarded.ok) expect(guarded.value.argv).toEqual(['/bin/true']);
    } finally {
      store.close();
    }
  });

  it('refuses a record others can write', () => {
    const h = setup();
    h.writePin(h.pin);
    chmodSync(join(h.recordDir, 'pin.json'), 0o664);
    const r = loadHarnessRecord(h.dataDir, 'claude');
    expect(r.ok ? '' : r.error).toContain('writable by group or others');
  });

  it('plans a direct host command with no outer launcher or mount proof', () => {
    const h = setup();
    const p = hostSandbox().provider.plan(
      {
        role: 'gate',
        worktree: h.dir,
        scratch: h.dir,
        git_dirs: [],
        private_home: null,
        context: null,
        schema: null,
        toolchain: [],
        env: {},
        network: 'internet_outbound',
      },
      ['/bin/true'],
    );
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value).toMatchObject({
      provider: 'host',
      isolation_mode: 'native',
      argv: ['/bin/true'],
      mount_sources: [],
      proof_refs: [],
    });
    expect(p.value.env).not.toHaveProperty('GH_TOKEN');
    expect(p.value.env).not.toHaveProperty('CUSR_TOKEN_FILE');
  });
});

type DoctorData = {
  checks?: { name: string; status: string; detail?: string }[];
};

describe('production task surface', () => {
  const doctor = async (
    h: ReturnType<typeof setup>,
    afterStart: () => void = () => undefined,
    body: Record<string, unknown> = { kind: 'doctor' },
  ) => {
    const store = openFileStoreForTest(join(h.dataDir, STORE_FILE));
    try {
      const control = await productionControl({
        configPath: h.configPath,
        dataDir: h.dataDir,
        clock: systemClock,
        redactor: new Redactor(),
        newId: () => crypto.randomUUID(),
      });
      const surface = control(store, {
        health: () => null,
        recoveryClaims: () => [],
        spoolProblems: () => [],
        abort: () => false,
        settled: () => Promise.resolve(),
        latch: () => undefined,
      });
      afterStart();
      const reply = await surface.queries['doctor']?.(
        {
          grant: {
            id: 'owner',
            actor: 'owner',
            roles: ['read', 'operate', 'admin'],
            projects: '*',
          },
        } as never,
        body,
      );
      const envelope = reply?.envelope as {
        data: unknown;
        error: { code: string; details: unknown } | null;
      };
      const data = (envelope.error?.details ?? envelope.data) as DoctorData;
      return {
        envelope,
        check: data.checks?.find((c) => c.name === 'manifest:claude'),
        mounts: data.checks?.find((c) => c.name === 'credential_mounts'),
        effects: Object.keys(surface.effects).sort(),
        rounds: surface.rounds.length,
      };
    } finally {
      store.close();
    }
  };

  it('has every effect but merge, and doctor says why a harness has no usable record', async () => {
    const h = setup();
    const missing = await doctor(h);
    expect(missing.effects).toEqual([
      'await_ci',
      'create_pr',
      'mark_ready',
      'post_review',
      'prepare',
      'publish',
      'reconcile',
      'rerun_ci',
      'run_gates',
      'start_agent',
      'stop_attempt',
    ]);
    expect(missing.rounds).toBe(6);
    expect(JSON.stringify(missing.check)).toContain('pin.json does not exist');
    expect(missing.check?.status).toBe('fail');

    // A record whose binary changed after the proof is not offered either.
    h.writePin(h.pin);
    const recorded = recordManifest({
      dataDir: h.dataDir,
      harness: 'claude',
      configPath: h.configPath,
      runtime: h.runtime,
      evidenceFile: h.evidenceFor(h.pin),
      fixtureRef: 'evidence.json',
      now: 1,
    });
    expect(recorded.ok).toBe(true);
    writeFileSync(h.pin.binary.realpath, '#!/bin/sh\n');
    expect(JSON.stringify((await doctor(h)).check)).toContain('digest');
  });

  it('holds new work when a credential reference changes under a running daemon', async () => {
    const h = setup();
    h.writePin(h.pin);
    recordManifest({
      dataDir: h.dataDir,
      harness: 'claude',
      configPath: h.configPath,
      runtime: h.runtime,
      evidenceFile: h.evidenceFor(h.pin),
      fixtureRef: 'evidence.json',
      now: 1,
    });
    const before = await doctor(h);
    expect(before.check?.status).toBe('ok');
    const text = readFileSync(h.configPath, 'utf8');
    const edited = await doctor(h, () =>
      writeFileSync(
        h.configPath,
        text.replace(`${h.dir}/claude-auth.json`, `${h.dir}/other-auth.json`),
      ),
    );
    expect(edited.check?.status).toBe('fail');
    expect(JSON.stringify(edited.check)).toContain('restart');
  });

  it('doctor on an unknown project lists the configured ones before any probe (issue #258)', async () => {
    const h = setup();
    const { envelope } = await doctor(h, undefined, { kind: 'doctor', project: 'nope' });
    expect(envelope.error).toMatchObject({ code: 'not_found', details: { projects: [] } });
  });

  it('doctor does not claim an outer credential or filesystem boundary', async () => {
    const h = setup();
    expect((await doctor(h)).mounts).toBeUndefined();
  });

  it('reads role prompts next to the user config and nothing outside it', () => {
    const h = setup();
    writeFileSync(join(h.dir, 'coder.md'), 'prompt\n');
    writeFileSync(join(base, 'outside.md'), 'secret\n');
    expect(
      readPrompts(h.configPath, [
        'coder.md',
        'missing.md',
        '../outside.md',
        join(base, 'outside.md'),
      ]),
    ).toEqual([{ name: 'coder.md', content: 'prompt\n' }]);
  });
});

const hostUsable = ['running', 'degraded'].includes(
  spawnSync('systemctl', ['--user', 'is-system-running'], {
    encoding: 'utf8',
  }).stdout.trim(),
);

/** A task frozen and started in the store, under `productionControl` and the real daemon loop. */
async function runSeeded(o: {
  readonly gateDir: string;
  readonly legacyIsolation?: boolean;
  readonly setup_commands?: string[];
  readonly extraRefs?: readonly { name: string; file: string }[];
}) {
  const h = setup();
  // The vendor stand-in is a node script; the sandbox must see that node.
  const pin = { ...h.pin, toolchain: [dirname(process.execPath)] };
  h.writePin(pin);
  const recorded = recordManifest({
    dataDir: h.dataDir,
    harness: 'claude',
    configPath: h.configPath,
    runtime: h.runtime,
    evidenceFile: h.evidenceFor(pin),
    fixtureRef: 'evidence.json',
    now: 1,
  });
  if (!recorded.ok) throw new Error(recorded.error);

  // The task runs on its frozen references: the files the daemon's config names go away after start.
  const frozenRefs = Object.entries(h.refs).map(([name, file]) => {
    cpSync(file, `${file}.frozen`);
    return { name, file: `${file}.frozen` };
  });

  const project = g.repo(`prod${n}`);
  const baseSha = g.sh(project, 'rev-parse', 'HEAD');
  const remote = `${project}.remote.git`;
  g.sh(g.base, 'clone', '-q', '--bare', project, remote);
  const github = new FakeGitHub();
  github.headOf = (branch) => {
    try {
      const sha = g.sh(remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
      if (!github.checks.has(sha)) github.checks.set(sha, { build: 'success', test: 'success' });
      return sha;
    } catch {
      return null;
    }
  };
  const seams: ProductionSeams = {
    github: () => github,
    remoteUrl: () => remote,
    gitProtocols: ['file'],
    gateToolchain: [dirname(process.execPath), o.gateDir],
  };

  const d = new StoreDriver(openFileStoreForTest(join(h.dataDir, STORE_FILE)));
  d.now = Date.now();
  const task = buildTask();
  d.must(task.id, { kind: 'create_task', task });
  const frozen = freezeOk(task, {
    base_sha: baseSha,
    gates: { build: 'true', unit: 'true', lint: 'true', format_fix: 'true' },
    required_checks: ['build', 'test'],
    limits: { max_wall_ms: 3_600_000 },
    mode: 'direct-pr',
  });
  proposeAndConfirm(d, task, selectionFor(task, 'direct-pr', frozen.value.policy));
  d.must(task.id, { kind: 'request_execution' });
  const granted = d.store.grantNext(d.now as never, [crypto.randomUUID()]);
  if (!granted.ok || granted.value.kind !== 'decided') throw new Error(JSON.stringify(granted));
  const runtime = confirmedRuntime(d, task, {
    ...(o.setup_commands === undefined ? {} : { setup_commands: o.setup_commands }),
    isolation: o.legacyIsolation
      ? { mode: 'isolated', provider: 'bwrap' }
      : { mode: 'native', provider: 'host' },
    base_sha: baseSha,
    project_path: project,
    target: {
      provider: 'github',
      repo: 'acme/app',
      immutable_repo_id: '4242',
      base_ref: 'main',
    },
    pr_template: null,
    capability_refs: { claude: recorded.value.manifest_hash },
    credential_refs: [...frozenRefs, ...(o.extraRefs ?? [])],
    limits: {
      ...DEFAULT_RUNTIME_LIMITS,
      poll_initial_ms: 500,
      poll_max_ms: 1_000,
    },
  });
  d.must(task.id, { kind: 'start', freeze: frozen, runtime });
  d.store.close();

  const log: string[] = [];
  const control = await productionControl({
    configPath: h.configPath,
    dataDir: h.dataDir,
    clock: systemClock,
    redactor: new Redactor(),
    newId: () => crypto.randomUUID(),
    seams,
  });
  for (const file of Object.values(h.refs)) rmSync(file);
  const started = await startDaemon({
    dataDir: h.dataDir,
    control,
    dispatchIntervalMs: 100,
    log: (m) => log.push(m),
  });
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  const { store } = started.value;
  const until = async (what: string, done: () => boolean, ms = 60_000): Promise<void> => {
    const end = Date.now() + ms;
    while (!done()) {
      if (Date.now() > end)
        throw new Error(
          `${what}: ${JSON.stringify(store.readTask(task.id)?.wait)}\n${log.join('\n')}`,
        );
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  return {
    h,
    github,
    store,
    task,
    remote,
    until,
    stop: () => started.value.stop(),
  };
}

describe.skipIf(!hostUsable)('productionControl on this host', () => {
  it('refuses to execute an old outer-isolated snapshot under the host contract', async () => {
    const { store, task, github, until, stop } = await runSeeded({
      gateDir: gateDir(),
      legacyIsolation: true,
    });
    try {
      await until('requires a native runtime', () => store.readTask(task.id)?.status === 'WAITING');
      expect(Object.keys(store.readTask(task.id)?.attempts ?? {})).toHaveLength(0);
      expect(github.prs).toHaveLength(0);
      expect(JSON.stringify(store.readEvents(task.id))).toContain(
        'task was frozen for outer bwrap',
      );
    } finally {
      await stop();
    }
  });

  const gateDir = (): string => {
    const dir = join(base, `gate-tools-${n++}`);
    mkdirSync(dir);
    return dir;
  };

  it('runs a confirmed task to a green PR and to DONE after the merge', async () => {
    const { h, github, store, task, remote, until, stop } = await runSeeded({
      gateDir: gateDir(),
      setup_commands: ['touch setup-ran'],
    });
    try {
      await until(
        'waiting for the merge',
        () => store.readTask(task.id)?.wait?.detail.code === 'merge',
      );
      expect(github.prs).toHaveLength(1);
      // Setup ran in the real sandbox, and its file is part of the tree the gates passed on.
      const head = store.readTask(task.id)?.head_sha ?? '';
      expect(() => g.sh(remote, 'cat-file', '-e', `${head}:setup-ran`)).not.toThrow();
      // The role's frozen stall limit and the snapshot's stop bounds reached the operation's unit.
      const task_ = store.readTask(task.id);
      const attempt = Object.values(task_?.attempts ?? {})[0];
      const spec = JSON.parse(
        readFileSync(join(h.dataDir, 'runs', attempt?.id ?? '', 'invocation.json'), 'utf8'),
      ) as { stall_ms: number | null; term_grace_ms: number };
      expect(spec.stall_ms).toBe(600_000);
      expect(spec.term_grace_ms).toBe(DEFAULT_RUNTIME_LIMITS.term_grace_ms);
      const pr = github.prs[0] as (typeof github.prs)[number];
      github.merge(pr.number, 'c'.repeat(40));
      await until('DONE', () => store.readTask(task.id)?.status === 'DONE');
      expect(existsSync(join(h.dataDir, 'git-credential-gh'))).toBe(true);
    } finally {
      await stop();
    }
  }, 180_000);

  it('runs host gates without an outer mount guard', async () => {
    const dir = gateDir();
    const old = join(dir, 'old-auth.json');
    writeFileSync(old, 'test-only-credential');
    const { github, store, task, until, stop } = await runSeeded({
      gateDir: dir,
      extraRefs: [{ name: 'old-account', file: old }],
    });
    try {
      await until(
        'waiting for merge',
        () => store.readTask(task.id)?.wait?.detail.code === 'merge',
      );
      expect(github.prs).toHaveLength(1);
    } finally {
      await stop();
    }
  }, 180_000);
});
