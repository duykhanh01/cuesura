/**
 * Shared by `test/smoke/`: the T121 fixture projects, and a local rehearsal of the path a real smoke walks.
 * The rehearsal runs the real CLI, daemon wiring, preflight, transient units, host launches and Git. The vendor
 * binary replays T007 runs and GitHub is a fake, so it finds wiring faults before a paid run and proves
 * nothing about a real vendor or GitHub: no SC is certified from it.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostInnerMode, type VendorPin } from '../../src/adapters/harness/vendor.ts';
import { CUSR_COMMANDS } from '../../src/cli/commands.ts';
import { runCli } from '../../src/cli/program.ts';
import { validateConfig } from '../../src/config/validate.ts';
import { harnessIdentity, recordManifest } from '../../src/runner/harness-records.ts';
import type { FakeGitHubState } from './fake-github.ts';
import { GIT_BIN } from './git-repo.ts';
import { homeFileContent, REAL } from './harness-fixtures.ts';
import { fakeVendorPin } from './runner-harness.ts';
import type { SmokeDaemonArgs } from './smoke-daemon-child.ts';

export const PROJECTS_DIR = fileURLToPath(
  new URL('../fixtures/runtime/projects/', import.meta.url),
);
export const PROJECT_KINDS = ['node', 'python'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];
export const SANDBOX_PROJECT: Record<ProjectKind, string> = {
  node: 'node-sandbox',
  python: 'python-sandbox',
};
export const repoDir = (kind: ProjectKind): string => join(PROJECTS_DIR, kind, 'repo');
export const variantDir = (kind: ProjectKind, v: 'pass' | 'fail'): string =>
  join(PROJECTS_DIR, kind, 'variants', v);
export const taskFile = (kind: ProjectKind): string => join(PROJECTS_DIR, kind, 'task.json');
/** A task whose verbatim code fails its verbatim test, so the required unit gate goes red (T129). */
export const redGateTaskFile = (kind: ProjectKind): string =>
  join(PROJECTS_DIR, kind, 'task-red-gate.json');

/** Real Claude sandbox probes in the smoke fixture still need native bwrap support. */
export const hostUsable = (): boolean =>
  spawnSync('/usr/bin/bwrap', ['--unshare-user', '--ro-bind', '/', '/', '/usr/bin/true']).status ===
    0 &&
  ['running', 'degraded'].includes(
    spawnSync('systemctl', ['--user', 'is-system-running'], {
      encoding: 'utf8',
    }).stdout.trim(),
  );

/** All regular files under a directory, relative to it. */
export function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? filesUnder(join(dir, e.name), `${prefix}${e.name}/`)
      : e.isFile()
        ? [`${prefix}${e.name}`]
        : [],
  );
}

const SMOKE_EFFORT = 'low';
/** The auth a rehearsal's vendor finds in its private home; it must surface nowhere. */
export const SMOKE_CANARY = 'smoke-canary-0123456789abcdef';

/** A user config for the given projects, as an owner would write it; credentials are references only. */
export function smokeUserConfig(o: {
  readonly dataDir: string;
  readonly projects: Readonly<Record<string, { readonly path: string; readonly repo: string }>>;
  readonly credentialRefs: Readonly<Record<string, string>>;
  readonly toolPaths?: Readonly<Record<string, string>>;
  readonly limits?: Readonly<Record<string, number>>;
  readonly models?: { readonly claude: string; readonly codex: string };
  /** Vendor the coder and fixer run on; the other one reviews. Bindings are global to a config. */
  readonly worker: 'claude' | 'codex';
}): string {
  const models = o.models ?? {
    claude: 'claude-haiku-5-5',
    codex: 'gpt-6-luna',
  };
  const yaml = (v: unknown): string => JSON.stringify(v);
  const reviewer = o.worker === 'claude' ? 'codex' : 'claude';
  const role = (name: string, vendor: string, extra = ''): string[] => [
    `  ${name}:`,
    `    prompt: ${name}.md`,
    `    binding: [{ model: ${vendor}-worker, effort: ${SMOKE_EFFORT} }]`,
    ...(extra === '' ? [] : [`    ${extra}`]),
  ];
  return [
    'version: 1',
    'harnesses:',
    '  claude: { cmd: claude, auth: subscription, pool: claude }',
    '  codex: { cmd: codex, auth: subscription, pool: codex }',
    'pools: { claude: 1, codex: 1 }',
    'models:',
    `  claude-worker: { harness: claude, id: ${yaml(models.claude)}, tier: 1 }`,
    `  codex-worker: { harness: codex, id: ${yaml(models.codex)}, tier: 1 }`,
    'roles:',
    ...role('coder', o.worker),
    ...role('fixer', o.worker),
    ...role('reviewer', reviewer, 'permissions: read_only'),
    ...role('scout', reviewer, 'permissions: read_only'),
    'workflows:',
    '  smoke-flow: { base: software_dev@1 }',
    'projects:',
    ...Object.entries(o.projects).map(
      ([id, p]) => `  ${id}: { base_branch: main, path: ${yaml(p.path)}, repo: ${yaml(p.repo)} }`,
    ),
    'profiles:',
    '  smoke:',
    '    workflow: smoke-flow',
    '    allow_roles: [scout, coder, fixer, reviewer]',
    '    allow_models: [claude-worker, codex-worker]',
    'runtime:',
    `  data_dir: ${yaml(o.dataDir)}`,
    '  modes:',
    '    direct-pr: { when_to_use: "small changes the gates and CI cover" }',
    '    full-review: { when_to_use: "changes that also need a reviewer" }',
    ...(o.toolPaths === undefined
      ? []
      : ['  tool_paths:', ...Object.entries(o.toolPaths).map(([k, v]) => `    ${k}: ${yaml(v)}`)]),
    ...(o.limits === undefined
      ? []
      : ['  limits:', ...Object.entries(o.limits).map(([k, v]) => `    ${k}: ${v}`)]),
    '  credential_refs:',
    ...Object.entries(o.credentialRefs).map(([k, v]) => `    ${k}: ${yaml(v)}`),
    '',
  ].join('\n');
}

export function copyPrompts(next: string): void {
  cpSync(join(PROJECTS_DIR, 'prompts'), dirname(next), { recursive: true });
}

const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@x',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@x',
};
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export type Envelope = {
  ok: boolean;
  data: Record<string, unknown>;
  error: { code: string; message: string; details: unknown } | null;
};

export type HistoryEvent = {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
};

export const waitCode = (task: Record<string, unknown>): string | undefined =>
  (task['wait'] as { detail?: { code?: string } } | null)?.detail?.code;

export type RunChoice = {
  readonly profile: string;
  readonly mode: 'direct-pr' | 'full-review';
  readonly worker: string;
  readonly reviewer: string | null;
};

/** What every smoke does through the CLI, on a rehearsal or a real daemon. */
export abstract class SmokeDriver {
  abstract cli(...argv: string[]): Promise<{ code: number; env: Envelope }>;
  protected logTail(): string {
    return '';
  }

  async must(...argv: string[]): Promise<Record<string, unknown>> {
    const { code, env } = await this.cli(...argv);
    if (code !== 0) throw new Error(`cusr ${argv.join(' ')}: ${JSON.stringify(env.error)}`);
    return env.data;
  }

  /** `task add` from a task file, then the owner's confirmation of the selection; returns the task ID. */
  async addAndConfirm(file: string, run: RunChoice): Promise<string> {
    const added = await this.must(
      'task',
      'add',
      '--file',
      file,
      '--profile',
      run.profile,
      '--mode',
      run.mode,
      '--worker',
      run.worker,
      ...(run.reviewer === null ? [] : ['--reviewer', run.reviewer]),
      '--reason',
      'smoke',
    );
    const id = (added['result'] as { task_id: string }).task_id;
    const shown = await this.show(id);
    await this.must(
      'task',
      'confirm',
      id,
      '--expected-version',
      String(shown['version']),
      '--run-config',
      (shown['run_config'] as { digest: string }).digest,
    );
    return id;
  }

  show(id: string): Promise<Record<string, unknown>> {
    return this.must('task', 'show', id, '--full');
  }

  /** Every accepted event of a task, across pages. */
  async history(id: string): Promise<HistoryEvent[]> {
    const all: HistoryEvent[] = [];
    for (;;) {
      const page = await this.must(
        'task',
        'history',
        id,
        '--full',
        ...(all.length === 0 ? [] : ['--after', String(all.at(-1)?.seq)]),
      );
      all.push(...(page['events'] as HistoryEvent[]));
      if (page['more'] !== true) return all;
    }
  }

  async until(
    id: string,
    what: string,
    done: (task: Record<string, unknown>) => boolean,
    ms = 120_000,
  ): Promise<Record<string, unknown>> {
    const end = Date.now() + ms;
    for (;;) {
      const task = await this.show(id);
      if (done(task)) return task;
      const stuck =
        ['needs_info', 'human_input'].includes(
          (task['wait'] as { reason?: string } | null)?.reason ?? '',
        ) || ['FAILED', 'CANCELLED'].includes(task['status'] as string);
      if (stuck || Date.now() > end)
        throw new Error(`${what}: ${JSON.stringify(task)}\n${this.logTail()}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  untilMergeWait(id: string, ms?: number): Promise<Record<string, unknown>> {
    return this.until(id, 'merge wait', (t) => waitCode(t) === 'merge', ms);
  }

  untilDone(id: string, ms?: number): Promise<Record<string, unknown>> {
    return this.until(id, 'DONE', (t) => t['status'] === 'DONE', ms);
  }
}

export type RehearsalOptions = {
  readonly kind: ProjectKind;
  /** Vendor of the worker; the other vendor reviews a full-review task. */
  readonly worker: 'claude' | 'codex';
  readonly mode: 'direct-pr' | 'full-review';
  /** What the coder writes; `fail` makes the gates red until the fixer applies `pass`. */
  readonly coder: 'pass' | 'fail';
  /** The vendor waits for `release()` before answering, so a test can stop the daemon around it. */
  readonly hold?: boolean;
  /** The vendor prints the files of its private home, as a confused or hostile agent might. */
  readonly leakHome?: boolean;
  readonly ci?: readonly ('success' | 'failure')[];
};

const replayOf = (vendor: 'claude' | 'codex', role: string): string =>
  (
    {
      'claude:coder': 's0-claude-coder-1793172185',
      'claude:fixer': 's0-claude-fixer-1793173414',
      'claude:reviewer': 's0-claude-reviewer-1793180331',
      'codex:coder': 's0-codex-coder-1793178479',
      'codex:fixer': 's0-codex-fixer-1793173505',
      'codex:reviewer': 's0-codex-reviewer-1793180367',
    } as Record<string, string>
  )[`${vendor}:${role}`] as string;

const REPO_SLUG = (kind: ProjectKind): string => `acme/${kind}-sandbox`;
const VENDORS = ['claude', 'codex'] as const;

/** A project, a data dir with proven-looking harness records and a daemon child; the test drives the CLI. */
export class Rehearsal extends SmokeDriver {
  readonly base: string;
  readonly dataDir: string;
  readonly project: string;
  readonly remote: string;
  readonly configPath: string;
  readonly stateFile: string;
  readonly o: RehearsalOptions;
  #args: string;
  #child: ChildProcess | null = null;
  #stderr = '';

  constructor(o: RehearsalOptions) {
    super();
    this.o = o;
    this.base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-smoke-')));
    this.dataDir = join(this.base, 'data');
    mkdirSync(this.dataDir, { mode: 0o700 });
    this.project = join(this.base, 'project');
    this.remote = join(this.base, 'remote.git');
    this.configPath = join(this.base, 'config.yaml');
    this.stateFile = join(this.base, 'github.json');
    this.#args = join(this.base, 'daemon-args.json');
    this.#prepareRepo();
    this.#prepareHarnesses();
    const args: SmokeDaemonArgs = {
      configPath: this.configPath,
      dataDir: this.dataDir,
      state: this.stateFile,
      repo: REPO_SLUG(o.kind),
      remote: this.remote,
      ci: o.ci ?? ['success'],
    };
    writeFileSync(this.#args, JSON.stringify(args));
  }

  #prepareRepo(): void {
    const { kind } = this.o;
    cpSync(repoDir(kind), this.project, { recursive: true });
    git(this.project, 'init', '-q', '-b', 'main');
    git(this.project, 'add', '-A');
    git(this.project, 'commit', '-qm', 'initial');
    git(this.base, 'clone', '-q', '--bare', this.project, this.remote);
    git(this.project, 'remote', 'add', 'origin', `https://github.com/${REPO_SLUG(kind)}.git`);
  }

  #prepareHarnesses(): void {
    const { kind, worker, coder, hold } = this.o;
    const bin = join(this.base, 'bin');
    mkdirSync(join(bin, 'replays'), { recursive: true });
    // The stand-in uses bwrap for its own native write probes, matching the current host contract.
    writeFileSync(join(bin, 'socat'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const replay = (vendor: 'claude' | 'codex', role: string): string => {
      const to = join(bin, 'replays', `${vendor}-${role}`);
      cpSync(join(REAL, replayOf(vendor, role)), to, { recursive: true });
      return to;
    };
    const apply = (name: 'pass' | 'fail'): string => {
      const to = join(bin, 'apply', name);
      cpSync(variantDir(kind, name), to, { recursive: true });
      return to;
    };
    const credentialRefs: Record<string, string> = {};
    const pins: Partial<Record<'claude' | 'codex', VendorPin>> = {};
    for (const vendor of VENDORS) {
      const isWorker = vendor === worker;
      const dir = join(bin, vendor);
      mkdirSync(dir);
      const pin = fakeVendorPin(vendor, dir, {
        FAKE_VENDOR_ECHO_MODEL: '1',
        FAKE_VENDOR_MODE: this.o.leakHome === true ? 'publish,print_home' : 'publish',
        FAKE_VENDOR_REVIEWER_PROBE: '1',
        FAKE_VENDOR_INNER_SANDBOX: '1',
        FAKE_VENDOR_REPLAY: replay(vendor, 'coder'),
        FAKE_VENDOR_FIXER_REPLAY: replay(vendor, 'fixer'),
        FAKE_VENDOR_REVIEWER_REPLAY: replay(vendor, 'reviewer'),
        ...(isWorker
          ? {
              FAKE_VENDOR_APPLY_CODER: apply(coder),
              FAKE_VENDOR_APPLY_FIXER: apply('pass'),
            }
          : {}),
        ...(hold === true ? { FAKE_VENDOR_HOLD: '1' } : {}),
      });
      const withTools = { ...pin, toolchain: [dirname(process.execPath), bin] };
      pins[vendor] = withTools;
      for (const h of withTools.home_files) {
        const file = join(this.base, `${vendor}.${h.credential}`);
        writeFileSync(file, homeFileContent(h, JSON.stringify({ accessToken: SMOKE_CANARY })));
        credentialRefs[h.credential] = file;
      }
    }
    // origin stays the GitHub URL preflight checks; only this git, which the repo config cannot, redirects it.
    const wrapper = join(this.base, 'git-to-local-remote');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec '${GIT_BIN}' -c 'url.file://${this.remote}.insteadOf=https://github.com/${REPO_SLUG(kind)}.git' "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      this.configPath,
      smokeUserConfig({
        dataDir: this.dataDir,
        projects: {
          [SANDBOX_PROJECT[kind]]: {
            path: this.project,
            repo: REPO_SLUG(kind),
          },
        },
        credentialRefs,
        worker,
        toolPaths: { git: wrapper },
        limits: { poll_initial_ms: 500, poll_max_ms: 1_000 },
      }),
    );
    copyPrompts(this.configPath);
    const validated = validateConfig({
      user: {
        file: this.configPath,
        text: readFileSync(this.configPath, 'utf8'),
      },
      packs: {},
    });
    if (!validated.ok) throw new Error(JSON.stringify(validated.error));
    const runtime = validated.value.runtime;
    if (runtime === null) throw new Error('no runtime');
    for (const vendor of VENDORS) {
      const pin = pins[vendor] as VendorPin;
      const recordDir = join(this.dataDir, 'harnesses', vendor);
      mkdirSync(recordDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(recordDir, 'pin.json'), JSON.stringify(pin), {
        mode: 0o600,
      });
      const attested = harnessIdentity({
        pin,
        dataDir: this.dataDir,
        configPath: this.configPath,
        runtime,
      });
      if (!attested.ok) throw new Error(attested.error);
      const raw = JSON.parse(readFileSync(join(REAL, 'capability-manifest.json'), 'utf8')) as {
        vendors: Record<string, Record<string, unknown>>;
      };
      const inner = hostInnerMode(pin);
      raw.vendors[vendor] = {
        ...raw.vendors[vendor],
        isolation_mode: 'native',
        selected_inner_mode: inner === 'native' ? 'internal_required' : inner,
        outer_proof_hash: null,
        binary: { sha256: pin.binary.sha256 },
        attested: attested.value,
      };
      const evidence = join(this.base, `evidence-${vendor}.json`);
      writeFileSync(evidence, JSON.stringify(raw));
      const recorded = recordManifest({
        dataDir: this.dataDir,
        harness: vendor,
        configPath: this.configPath,
        runtime,
        evidenceFile: evidence,
        fixtureRef: 'smoke-rehearsal',
        now: Date.now(),
      });
      if (!recorded.ok) throw new Error(recorded.error);
    }
  }

  async startDaemon(): Promise<void> {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./smoke-daemon-child.ts', import.meta.url)), this.#args],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.#child = child;
    child.stderr?.on('data', (d: Buffer) => (this.#stderr += d.toString()));
    await new Promise<void>((resolve, reject) => {
      child.stdout?.on('data', (d: Buffer) => {
        if (d.toString().includes('ready')) resolve();
      });
      child.once('exit', (code) => reject(new Error(`daemon exited ${code}: ${this.#stderr}`)));
    });
  }

  async stopDaemon(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    this.#child = null;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.removeAllListeners('exit');
    const gone = new Promise((r) => child.once('exit', r));
    child.kill(signal);
    await gone;
  }

  async cleanup(): Promise<void> {
    this.release();
    await this.stopDaemon('SIGTERM');
    // A held vendor sees the release within 100 ms and ends its unit; the scratch must outlive that.
    if (this.held().length > 0) await new Promise((r) => setTimeout(r, 500));
    rmSync(this.base, { recursive: true, force: true });
  }

  /** The real CLI, over the real socket, as the owner. */
  override async cli(...argv: string[]): Promise<{ code: number; env: Envelope }> {
    const out: string[] = [];
    const code = await runCli(
      { name: 'cusr', description: 'smoke', version: '0' },
      [...argv, '--data-dir', this.dataDir, '--json'],
      { stdout: (t) => out.push(t), stderr: () => undefined },
      CUSR_COMMANDS,
    );
    return { code, env: JSON.parse(out.join('')) as Envelope };
  }

  protected override logTail(): string {
    return this.#stderr.slice(-2000);
  }

  /** The fixture's task, with the bindings this rehearsal's config declares. */
  addTask(): Promise<string> {
    const { kind, worker, mode } = this.o;
    const reviewer = worker === 'claude' ? 'codex' : 'claude';
    return this.addAndConfirm(taskFile(kind), {
      profile: 'smoke',
      mode,
      worker: `${worker}/${worker}-worker/${SMOKE_EFFORT}`,
      reviewer: mode === 'full-review' ? `${reviewer}/${reviewer}-worker/${SMOKE_EFFORT}` : null,
    });
  }

  github(): FakeGitHubState {
    return existsSync(this.stateFile)
      ? (JSON.parse(readFileSync(this.stateFile, 'utf8')) as FakeGitHubState)
      : { prs: [], calls: [], checks: {}, next: 0 };
  }

  /** The person merging on GitHub. */
  merge(number: number, mergeCommit: string): void {
    const tmp = `${this.stateFile}.merge.tmp`;
    writeFileSync(tmp, JSON.stringify({ number, merge_commit: mergeCommit }));
    renameSync(tmp, `${this.stateFile}.merge`);
  }

  /** Scratch files of vendor processes that reached the hold, however many lives of the daemon ago. */
  held(): string[] {
    const runs = join(this.dataDir, 'runs');
    if (!existsSync(runs)) return [];
    return filesUnder(runs)
      .filter((f) => basename(f).startsWith('running-'))
      .map((f) => join(runs, f));
  }

  release(): void {
    for (const f of this.held()) writeFileSync(join(dirname(f), 'release'), '');
  }
}
