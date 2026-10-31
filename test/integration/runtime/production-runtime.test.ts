/**
 * T140: the wiring `cusrd` runs with, end to end on this host. `productionControl` under the real daemon
 * loop drives a seeded task through a transient systemd unit, real bwrap and real Git to a green PR on a
 * bare remote, then to DONE after a merge, with nothing else calling the dispatcher, timers, observation or
 * drain. Only the vendor binary (a replay of the T007 runs, no model) and GitHub are stand-ins, and no
 * network is used. Harness records are the files an owner writes, loaded the way the daemon loads them.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
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
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_LIMITS } from '../../../src/domain/runtime.ts';
import type { VendorPin } from '../../../src/adapters/harness/vendor.ts';
import {
  startDaemon,
  STORE_FILE,
  systemClock,
} from '../../../src/daemon/main.ts';
import {
  knownCredentialFiles,
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
import { BWRAP } from '../../../src/runner/sandbox.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, freezeOk } from '../../support/builders.ts';
import { FakeGitHub } from '../../support/fake-github.ts';
import { gitSandbox } from '../../support/git-repo.ts';
import { homeFileContent, REAL } from '../../support/harness-fixtures.ts';
import { fakeVendorPin } from '../../support/runner-harness.ts';
import {
  confirmedRuntime,
  proposeAndConfirm,
  selectionFor,
} from '../../support/runtime.ts';
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
      homeFileContent(
        h,
        JSON.stringify({ accessToken: 'sk-ant-canary-0123456789' }),
      ),
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
      inner: 'native',
      dataDir,
      configPath,
      runtime,
    });
    if (!attested.ok) throw new Error(attested.error);
    raw.vendors['claude'] = {
      ...raw.vendors['claude'],
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
    const sandbox = hostSandbox(h);
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
    expect(environment.ok ? '' : environment.error).toContain(
      'environment_hash',
    );
    // Handed straight to the binary's argv: a higher turn cap or a new tool was never shown either.
    for (const changed of [
      { max_turns: 100_000 },
      { tools: ['Bash', 'WebFetch'] },
    ]) {
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

  it('keeps a manifest valid when a credential file moves, and still guards the new path', () => {
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
    const moved = {
      ...h.runtime,
      credential_refs: h.runtime.credential_refs.map((r) => ({
        ...r,
        file: join(h.dir, 'moved', r.name),
      })),
    };
    const after = hostSandbox({ ...h, runtime: moved });
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
      const guarded = hostSandbox({
        ...h,
        runtime: moved,
        forbiddenNow: () => knownCredentialFiles(store, moved),
      }).provider.plan(
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
      expect(guarded.ok ? '' : guarded.error.message).toContain(
        `overlaps forbidden ${join(h.dir, 'moved')}`,
      );
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

  it('refuses a mount over a credential the policy was not built with, system mounts too', () => {
    const h = setup();
    const secret = join(h.dir, 'old', 'auth.json');
    mkdirSync(dirname(secret));
    const plan = (forbidden: string, toolchain: string[]) =>
      hostSandbox({ ...h, forbiddenNow: () => [forbidden] }).provider.plan(
        {
          role: 'gate',
          worktree: join(h.dir, 'worktree-g'),
          git_dirs: [],
          scratch: join(h.dir, 'scratch-g'),
          private_home: null,
          context: null,
          schema: null,
          toolchain,
          env: {},
          network: 'internet_outbound',
        },
        ['/bin/true'],
      );
    mkdirSync(join(h.dir, 'worktree-g'));
    writeFileSync(join(h.dir, 'worktree-g', '.git'), 'gitdir: /x\n');
    mkdirSync(join(h.dir, 'scratch-g'));
    expect(plan(join(h.dir, 'elsewhere'), [dirname(secret)]).ok).toBe(true);
    const over = plan(secret, [dirname(secret)]);
    expect(over.ok ? '' : over.error.message).toContain('overlaps forbidden');
    expect(plan('/usr/share/secret', []).ok).toBe(false);
  });

  it('keeps run sandboxes away from the records and the helper', () => {
    const h = setup();
    const sandbox = hostSandbox(h);
    const plan = sandbox.provider.plan(
      {
        role: 'gate',
        worktree: join(h.dataDir, 'harnesses'),
        git_dirs: [],
        scratch: join(h.dir, 'scratch'),
        private_home: null,
        context: null,
        schema: null,
        toolchain: [],
        env: {},
        network: 'internet_outbound',
      },
      ['/bin/true'],
    );
    expect(plan.ok).toBe(false);
  });
});

type DoctorData = {
  checks: { name: string; status: string; detail?: string }[];
};

describe('production task surface', () => {
  const doctor = async (
    h: ReturnType<typeof setup>,
    afterStart: () => void = () => undefined,
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
        { kind: 'doctor' },
      );
      const envelope = reply?.envelope as {
        data: unknown;
        error: { details: unknown } | null;
      };
      const data = (envelope.error?.details ?? envelope.data) as DoctorData;
      return {
        check: data.checks.find((c) => c.name === 'manifest:claude'),
        mounts: data.checks.find((c) => c.name === 'credential_mounts'),
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
      'prepare',
      'publish',
      'reconcile',
      'rerun_ci',
      'run_gates',
      'start_agent',
      'stop_attempt',
    ]);
    expect(missing.rounds).toBe(3);
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

  it('doctor warns about a credential in a sandbox mount before a run is refused', async () => {
    const h = setup();
    const clear = await doctor(h);
    expect(clear.mounts?.status).toBe('ok');

    // A reference only a task froze, inside a directory every worker and gate mounts.
    const scratch = join(h.dataDir, 'scratch', 'old-auth.json');
    const db = openFileStoreForTest(join(h.dataDir, STORE_FILE));
    db.close();
    const raw = new Database(join(h.dataDir, STORE_FILE));
    raw
      .prepare(
        'INSERT INTO runtime_contexts (task_id, revision, runtime_hash, runtime_json) VALUES (?, ?, ?, ?)',
      )
      .run(
        't',
        1,
        'h',
        JSON.stringify({ credential_refs: [{ name: 'a', file: scratch }] }),
      );
    raw.close();
    const clash = await doctor(h);
    expect(clash.mounts?.status).toBe('fail');
    expect(clash.mounts?.detail).toContain(scratch);
  });

  describe('Git directories of a linked-worktree project', () => {
    const freeze = (h: ReturnType<typeof setup>, frozen: object): void => {
      openFileStoreForTest(join(h.dataDir, STORE_FILE)).close();
      const raw = new Database(join(h.dataDir, STORE_FILE));
      raw
        .prepare(
          'INSERT INTO runtime_contexts (task_id, revision, runtime_hash, runtime_json) VALUES (?, ?, ?, ?)',
        )
        .run('t', 1, 'h', JSON.stringify(frozen));
      raw.close();
    };
    const linkedWorktree = () => {
      const main = g.repo(`linked${n++}`);
      const linked = `${main}.linked`;
      g.sh(main, 'worktree', 'add', '-q', '-b', 'side', linked);
      return { main, linked, inCommon: join(main, '.git', 'old-auth.json') };
    };
    const addProject = (h: ReturnType<typeof setup>, path: string): void =>
      appendFileSync(
        h.configPath,
        `projects:\n  app: { path: ${path}, base_branch: main }\n`,
      );

    it('warns about a credential in the common directory of a configured project', async () => {
      const h = setup();
      const { linked, inCommon } = linkedWorktree();
      addProject(h, linked);
      expect((await doctor(h)).mounts?.status).toBe('ok');

      freeze(h, { credential_refs: [{ name: 'a', file: inCommon }] });
      const clash = await doctor(h);
      expect(clash.mounts?.status).toBe('fail');
      expect(clash.mounts?.detail).toContain(`${inCommon} in`);
    });

    it('warns for a project only a task froze, as execution mounts it', async () => {
      const h = setup();
      const { linked, inCommon } = linkedWorktree();
      freeze(h, {
        project_path: linked,
        credential_refs: [{ name: 'a', file: inCommon }],
      });
      expect((await doctor(h)).mounts?.status).toBe('fail');
    });

    it('does not count a path no run can start from, but never reports ok on a project Git refused', async () => {
      const h = setup();
      const gone = join(h.dir, 'gone');
      const plain = join(h.dir, 'plain');
      mkdirSync(plain);
      addProject(h, gone);
      freeze(h, { project_path: plain, credential_refs: [] });
      expect((await doctor(h)).mounts?.status).toBe('ok');

      const refused = setup();
      const repo = g.repo(`refused${n++}`);
      g.sh(repo, 'config', 'core.gitProxy', 'evil');
      addProject(refused, repo);
      const report = await doctor(refused);
      expect(report.mounts?.status).toBe('fail');
      expect(report.mounts?.detail).toContain(`${repo}: refused`);
    });
  });

  it('reads every reference any snapshot froze, across tasks and revisions', () => {
    const h = setup();
    const path = join(h.dataDir, STORE_FILE);
    openFileStoreForTest(path).close();
    const raw = new Database(path);
    const insert = raw.prepare(
      'INSERT INTO runtime_contexts (task_id, revision, runtime_hash, runtime_json) VALUES (?, ?, ?, ?)',
    );
    const refs = (...files: string[]) =>
      JSON.stringify({
        credential_refs: files.map((file, i) => ({ name: `r${i}`, file })),
      });
    insert.run('t1', 1, 'h', refs('/a', '/shared'));
    insert.run('t1', 2, 'h', refs('/b'));
    insert.run('t2', 1, 'h', refs('/shared'));
    insert.run('t3', 1, 'h', refs());
    raw.close();
    const store = openFileStoreForTest(path);
    try {
      expect(store.frozenCredentialFiles()).toEqual(['/a', '/b', '/shared']);
      expect(
        knownCredentialFiles(store, { ...h.runtime, credential_refs: [] }),
      ).toEqual(['/a', '/b', '/shared']);
    } finally {
      store.close();
    }
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

const hostUsable =
  existsSync(BWRAP) &&
  spawnSync(BWRAP, ['--unshare-user', '--ro-bind', '/', '/', '/usr/bin/true'])
    .status === 0 &&
  ['running', 'degraded'].includes(
    spawnSync('systemctl', ['--user', 'is-system-running'], {
      encoding: 'utf8',
    }).stdout.trim(),
  );

/** A task frozen and started in the store, under `productionControl` and the real daemon loop. */
async function runSeeded(o: {
  readonly gateDir: string;
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
      const sha = g.sh(
        remote,
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      );
      if (!github.checks.has(sha))
        github.checks.set(sha, { build: 'success', test: 'success' });
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
  proposeAndConfirm(
    d,
    task,
    selectionFor(task, 'direct-pr', frozen.value.policy),
  );
  d.must(task.id, { kind: 'request_execution' });
  const granted = d.store.grantNext(d.now as never, [crypto.randomUUID()]);
  if (!granted.ok || granted.value.kind !== 'decided')
    throw new Error(JSON.stringify(granted));
  const runtime = confirmedRuntime(d, task, {
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
    accessTokens: [],
    control,
    dispatchIntervalMs: 100,
    log: (m) => log.push(m),
  });
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  const { store } = started.value;
  const until = async (
    what: string,
    done: () => boolean,
    ms = 60_000,
  ): Promise<void> => {
    const end = Date.now() + ms;
    while (!done()) {
      if (Date.now() > end)
        throw new Error(
          `${what}: ${JSON.stringify(store.readTask(task.id)?.wait)}\n${log.join('\n')}`,
        );
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  return { h, github, store, task, until, stop: () => started.value.stop() };
}

describe.skipIf(!hostUsable)('productionControl on this host', () => {
  const gateDir = (): string => {
    const dir = join(base, `gate-tools-${n++}`);
    mkdirSync(dir);
    return dir;
  };

  it('runs a confirmed task to a green PR and to DONE after the merge', async () => {
    const { h, github, store, task, until, stop } = await runSeeded({
      gateDir: gateDir(),
    });
    try {
      await until(
        'waiting for the merge',
        () => store.readTask(task.id)?.wait?.detail.code === 'merge',
      );
      expect(github.prs).toHaveLength(1);
      // The role's frozen stall limit and the snapshot's stop bounds reached the operation's unit.
      const task_ = store.readTask(task.id);
      const attempt = Object.values(task_?.attempts ?? {})[0];
      const spec = JSON.parse(
        readFileSync(
          join(h.dataDir, 'runs', attempt?.id ?? '', 'invocation.json'),
          'utf8',
        ),
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

  it('never lets a gate mount a credential only a frozen task still names', async () => {
    // A → B then a restart: the config no longer names A, a task still does, and A sits under a
    // directory gates mount. The same directory without the reference is the test above.
    const dir = gateDir();
    const old = join(dir, 'old-auth.json');
    writeFileSync(old, 'sk-ant-canary-0123456789');
    const { github, store, task, until, stop } = await runSeeded({
      gateDir: dir,
      extraRefs: [{ name: 'old-account', file: old }],
    });
    try {
      const gatesEnded = () =>
        Object.values(store.readTask(task.id)?.effects ?? {}).some(
          (e) =>
            e.kind === 'run_gates' &&
            e.status !== 'pending' &&
            e.status !== 'started',
        );
      await until('gates refused', gatesEnded);
      const results = store
        .readEvents(task.id)
        .filter((e) => e.type === 'EffectCompleted')
        .map((e) => JSON.stringify(e.payload));
      expect(results.join('\n')).toContain('not_launched');
      expect(github.prs).toEqual([]);
    } finally {
      await stop();
    }
  }, 180_000);
});
