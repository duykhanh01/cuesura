/**
 * 007 T089 (FR-011, FR-013, FR-053, contracts/deputy-turn.md "Kết thúc lượt"): an interactive deputy turn
 * ends through the Stop hook Cuesura merges into the private home. The hook writes `turn-ended.json`, the
 * runner stops the session and concludes `turn_ended`; `recover` reads it back and never launches again.
 * A session that stalls without that signal resumes headless in the same session, within the same turn.
 * A stand-in binary plays the native session (no model, no terminal); the runner lifecycle is real.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../../src/adapters/harness/claude.ts';
import { codexAdapter } from '../../../src/adapters/harness/codex.ts';
import { FakeHarness } from '../../../src/adapters/harness/fake.ts';
import {
  ROLE_SCHEMA_DIGESTS,
  wireRoleSchema,
} from '../../../src/adapters/harness/result-schema.ts';
import type { HarnessInput } from '../../../src/adapters/ports.ts';
import { createDeputy } from '../../../src/daemon/deputy.ts';
import { RUN_FILES } from '../../../src/runner/files.ts';
import { RunnerExitSchema } from '../../../src/runner/lifecycle.ts';
import { RunnerHarness, TURN_ENDED_FILE } from '../../../src/runner/invocation.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { hashCanonical, hashText } from '../../../src/shared/hash.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { FAKE_DEPUTY, NO_WORKTREE } from '../../support/deputy.ts';
import { homeFileContent, REAL, spikePin } from '../../support/harness-fixtures.ts';
import {
  evidenceManifest,
  fakeVendorPin,
  HOST_POLICY_HASH,
  InlineProcessPort,
  PassThroughSandbox,
  tempDir,
} from '../../support/runner-harness.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const dirs: string[] = [];
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 50));
  const { rmSync } = await import('node:fs');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Vendor = 'claude' | 'codex';
const OWNER_HOOK = '/owner/hooks/stop.sh';
const CONTEXT = '# Role: deputy\nact on the incident\n';

function setup(
  vendor: Vendor,
  mode: string,
  o: { interactive?: boolean; stall_ms?: number; ownerSettings?: string } = {},
) {
  const root = tempDir('cusr-turn-end-', dirs);
  const data = join(root, 'data');
  const owner = join(root, 'owner');
  mkdirSync(join(owner, '.claude'), { recursive: true });
  // The owner's own Stop hook keeps running beside Cuesura's (FR-013).
  writeFileSync(
    join(owner, '.claude', 'settings.json'),
    o.ownerSettings ??
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: OWNER_HOOK }] }] } }),
  );
  const credDir = join(root, 'cred');
  mkdirSync(credDir);
  const pin = fakeVendorPin(vendor, root, {
    FAKE_VENDOR_REPLAY: join(
      REAL,
      vendor === 'claude' ? 's0-claude-coder-1793172185' : 's0-codex-coder-1793172285',
    ),
    FAKE_VENDOR_MODE: mode,
  });
  const credentials: Record<string, { name: string; file: string }> = {};
  pin.home_files.forEach((h, i) => {
    const file = join(credDir, `${h.credential}.json`);
    writeFileSync(file, homeFileContent(h, JSON.stringify({ accessToken: `tok${i}` })));
    credentials[h.credential] = { name: h.credential, file };
  });
  const proc = new InlineProcessPort(data);
  const manifest = evidenceManifest(pin, {
    role_schemas: {
      ...evidenceEntry(vendor).role_schemas,
      deputy: { digest: ROLE_SCHEMA_DIGESTS.deputy },
    },
    capabilities: {
      ...evidenceEntry(vendor).capabilities,
      schema_acceptance_deputy: { status: 'proven', evidence: 'test-only deputy proof' },
      session_resume: { status: 'proven', evidence: 'test-only' },
    },
  });
  const h = new RunnerHarness({
    harness: vendor,
    adapter: vendor === 'claude' ? claudeAdapter : codexAdapter,
    pin,
    manifest,
    isolation: 'internal_required',
    process: proc,
    sandbox: new PassThroughSandbox(),
    host_policy_hash: HOST_POLICY_HASH,
    data_dir: data,
    credentials,
    user_home: owner,
    redactor: new Redactor(),
    clock: { now: () => Date.now() as EpochMs, monotonic: () => performance.now() },
    limits: { term_grace_ms: 200, kill_verify_ms: 1_000, stall_ms: o.stall_ms ?? null },
    poll_ms: 20,
    interactive: o.interactive ?? true,
  });
  const s = spikePin(vendor);
  const id = randomUUID();
  const input: HarnessInput = {
    role: 'deputy',
    operation_id: id,
    attempt_id: `at-${id}`,
    revision: 1,
    binding: {
      harness: vendor,
      vendor,
      model: s.model,
      effort: s.effort,
      permission_policy_hash: hashCanonical('policy'),
    },
    context: { text: CONTEXT, digest: hashText(CONTEXT) },
    schema: wireRoleSchema('deputy', { omit_meta_schema: false }),
    wall_ms: 20_000,
    deadline_at: (Date.now() + 60_000) as EpochMs,
    session: null,
    workspace: { worktree: data, git_dirs: [] },
    limits: { term_grace_ms: 200, kill_verify_ms: 1_000, stall_ms: o.stall_ms ?? null },
    view: { project: 'metronome', title: 'deputy: Fix login' },
    deputy_turn: 'turn-1',
    interactive: true,
  };
  return { root, data, owner, proc, h, input };
}

function evidenceEntry(vendor: Vendor): {
  role_schemas: Record<string, { digest: string }>;
  capabilities: Record<string, unknown>;
} {
  const all = JSON.parse(readFileSync(join(REAL, 'capability-manifest.json'), 'utf8')) as {
    vendors: Record<
      string,
      { role_schemas: Record<string, { digest: string }>; capabilities: Record<string, unknown> }
    >;
  };
  const e = all.vendors[vendor];
  if (e === undefined) throw new Error(`no evidence for ${vendor}`);
  return e;
}

function runDir(data: string, attempt: string): string {
  return join(data, 'runs', attempt);
}

const signal = (): AbortSignal => new AbortController().signal;

describe('an interactive turn ends through the Stop hook (FR-013)', () => {
  it.each(['claude', 'codex'] as const)(
    '%s: turn-ended.json is written, the runner stops the session, recover does not spawn again',
    async (vendor) => {
      const e = setup(vendor, 'turn_end');
      expect(e.h.interactive).toBe(true);
      const out = await e.h.run(e.input, signal());
      expect(out).toMatchObject({
        kind: 'turn_ended',
        role: 'deputy',
        final_message: 'handed off by the fake',
      });
      expect(out.session_ref).toMatch(/^[0-9a-f-]{36}$/);

      // One native launch: no print mode, the prompt as the first message, no prompt on stdin.
      expect(e.proc.launches).toHaveLength(1);
      const launch = e.proc.launches[0];
      expect(launch?.interactive).toBe(true);
      expect(launch?.stdin ?? null).toBeNull();
      expect(launch?.argv.at(-1)).toBe(CONTEXT);
      expect(launch?.argv).not.toContain('-p');
      expect(launch?.argv).not.toContain('exec');
      expect(launch?.view?.title).toBe('deputy: Fix login');

      const dir = runDir(e.data, e.input.attempt_id);
      const ended = JSON.parse(readFileSync(join(dir, TURN_ENDED_FILE), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(ended).toMatchObject({ turn_id: 'turn-1', final_message: 'handed off by the fake' });
      // The runner stopped the session; it did not end on its own.
      const exit = RunnerExitSchema.parse(
        JSON.parse(readFileSync(join(dir, RUN_FILES.exit), 'utf8')),
      );
      expect(exit.outcome).toBe('cancelled');
      expect(exit.termination.term_sent).toBe(true);

      expect(e.h.recover(e.input)).toMatchObject({
        kind: 'turn_ended',
        final_message: 'handed off by the fake',
      });
      expect(await e.h.run(e.input, signal())).toMatchObject({ kind: 'turn_ended' });
      expect(e.proc.launches).toHaveLength(1);
    },
  );

  it('claude: the hook and the worktree rule are merged into the home settings, the owner hook kept', async () => {
    const e = setup('claude', 'turn_end');
    const out = await e.h.run(e.input, signal());
    expect(out.kind).toBe('turn_ended');
    const home = join(runDir(e.data, e.input.attempt_id), 'private-home', '.claude');
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as {
      hooks: { Stop: { hooks: { command: string }[] }[] };
      permissions: { deny: string[] };
    };
    const commands = settings.hooks.Stop.flatMap((g) => g.hooks.map((x) => x.command));
    expect(commands[0]).toBe(OWNER_HOOK);
    expect(commands[1]).toContain(TURN_ENDED_FILE);
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        `Edit(/${join(e.data, 'worktrees')}/**)`,
        `Write(/${join(e.data, 'worktrees')}/**)`,
      ]),
    );
    // The owner's file is the source of the copy, never written.
    expect(readFileSync(join(e.owner, '.claude', 'settings.json'), 'utf8')).not.toContain(
      TURN_ENDED_FILE,
    );
    // A fresh home would stop at the onboarding and trust dialogs.
    const global = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as {
      hasCompletedOnboarding: boolean;
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(global.hasCompletedOnboarding).toBe(true);
    expect(global.projects[e.data]?.hasTrustDialogAccepted).toBe(true);
    const launch = e.proc.launches[0];
    expect(launch?.argv).toContain('--session-id');
    expect(out.session_ref).toBe(launch?.argv[(launch?.argv.indexOf('--session-id') ?? 0) + 1]);
    // The native session must not update the owner's installation behind the pin.
    expect(launch?.env['DISABLE_AUTOUPDATER']).toBe('1');
  });

  it('codex: the hook is trusted for this run only and the shared background server is off', async () => {
    const e = setup('codex', 'turn_end');
    expect((await e.h.run(e.input, signal())).kind).toBe('turn_ended');
    const hooksFile = join(
      runDir(e.data, e.input.attempt_id),
      'private-home',
      '.codex',
      'hooks.json',
    );
    const hooks = JSON.parse(readFileSync(hooksFile, 'utf8')) as {
      hooks: { Stop: { hooks: { command: string; timeout: number }[] }[] };
    };
    const handler = hooks.hooks.Stop[0]?.hooks[0];
    expect(handler?.command).toContain(TURN_ENDED_FILE);
    const argv = e.proc.launches[0]?.argv ?? [];
    expect(argv).toContain('--no-daemon');
    const trust = argv.find((a) => a.startsWith('hooks.state='));
    // Codex 0.169 keys trust by `<file>:stop:<group>:<handler>` and hashes the normalized handler.
    const hash = hashCanonical({
      event_name: 'stop',
      hooks: [
        { async: false, command: handler?.command, timeout: handler?.timeout, type: 'command' },
      ],
    });
    expect(trust).toBe(
      `hooks.state={${JSON.stringify(`${hooksFile}:stop:0:0`)}={trusted_hash="${hash}"}}`,
    );
  });

  it.each(['claude', 'codex'] as const)(
    '%s: a session that never signals stalls and reports the session to resume',
    async (vendor) => {
      const e = setup(vendor, 'hang', { stall_ms: 400 });
      const out = await e.h.run(e.input, signal());
      expect(out).toMatchObject({ kind: 'failure', failure: 'timeout', invoked: true });
      expect(out.session_ref).toMatch(/^[0-9a-f-]{36}$/);
      expect(existsSync(join(runDir(e.data, e.input.attempt_id), TURN_ENDED_FILE))).toBe(false);
      expect(e.h.recover(e.input)).toMatchObject({ kind: 'failure', failure: 'timeout' });
      expect(e.proc.launches).toHaveLength(1);
    },
  );

  it('removes the installed auth when the home cannot be prepared, and launches nothing', async () => {
    const e = setup('claude', 'turn_end', { ownerSettings: '{not json' });
    const out = await e.h.run(e.input, signal());
    expect(out).toMatchObject({ kind: 'failure', failure: 'capability_missing', invoked: false });
    expect(e.proc.launches).toHaveLength(0);
    const home = join(runDir(e.data, e.input.attempt_id), 'private-home');
    const left = readdirSync(home, { recursive: true }).map(String);
    expect(left.filter((p) => p.endsWith('.credentials.json'))).toEqual([]);
  });

  // Execution contract §4: the CPU of the session's tools is progress, whenever they start; the
  // harness's own CPU (an idle TUI redraws) is not. Production classification, production timings.
  it.each([
    ['at once', 'tool_early'],
    ['later in the turn', 'tool_late'],
  ])('keeps a session whose tool, started %s, is still computing', async (_when, mode) => {
    const e = setup('claude', `turn_end,${mode}`, { stall_ms: 700 });
    const out = await e.h.run(e.input, signal());
    expect(out).toMatchObject({ kind: 'turn_ended', final_message: 'handed off by the fake' });
  });

  it('stalls a session whose only CPU is its own redraw', async () => {
    const e = setup('claude', 'redraw', { stall_ms: 700 });
    const out = await e.h.run(e.input, signal());
    expect(out).toMatchObject({
      kind: 'failure',
      failure: 'timeout',
      detail: 'interactive turn stalled',
    });
  });

  it('codex: a stalled root with a sub-agent thread resumes the root thread', async () => {
    const e = setup('codex', 'hang,spawn_agent', { stall_ms: 400 });
    const out = await e.h.run(e.input, signal());
    expect(out).toMatchObject({ kind: 'failure', failure: 'timeout' });
    expect(out.session_ref).toBe('0192cccc-0000-7000-8000-000000000001');
  });

  it('runs headless when the harness has no terminal to show the session in', async () => {
    const e = setup('claude', '', { interactive: false });
    expect(e.h.interactive).toBe(false);
    await e.h.run(e.input, signal());
    const launch = e.proc.launches[0];
    expect(launch?.interactive).toBeUndefined();
    expect(launch?.argv).toContain('-p');
  });
});

describe('a stalled interactive run goes on headless in the same session and turn (FR-011, SC-003)', () => {
  const tmp = useTempDir('cusr-turn-end-daemon-');
  let ids = 97_000;

  it('resumes at once, headless, without counting an infra failure', async () => {
    const dir = tmp();
    const d = new StoreDriver(openFileStoreForTest(dbPath(dir)));
    const t = buildTask({ id: uuidOf(97_901) });
    createGrantStart(d, t, 'direct-pr', { limits: { max_wall_ms: 48 * 3_600_000 } });
    const failed = { ...PREPARE_DATA, setup: { ran: true, passed: false } };
    for (let i = 0; i < 12 && d.task(t.id).wait?.detail.code !== 'backoff_exhausted'; i++) {
      d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', failed);
      d.now += 300_000;
      d.fire();
    }
    const harness = new FakeHarness(
      {
        deputy: [
          {
            kind: 'failure',
            failure: 'timeout',
            session_ref: 'sess-1',
            detail: 'interactive turn stalled',
          },
          { kind: 'turn_ended', final_message: 'done headless' },
        ],
      },
      'fake',
      { interactive: true },
    );
    const deputy = createDeputy({
      store: d.store,
      clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
      newId: () => uuidOf(ids++),
      harnesses: { fake: harness },
      setting: () => Promise.resolve(FAKE_DEPUTY),
      autonomous: () => Promise.resolve(false),
      cwd: '/cusr-data',
      worktreePath: (id) => `/cusr-data/worktrees/${id}`,
      worktree: NO_WORKTREE,
      recordsDir: join(dir, 'deputy'),
      dataDir: dir,
      redactor: new Redactor({ values: [] }),
    });
    await deputy.round();
    await deputy.idle();
    expect(harness.calls[0]?.interactive).toBe(true);
    const live = d.store.deputy.runningTurn(t.id);
    expect(live).toMatchObject({ state: 'retry_wait', mode: 'interactive', infra_failures: 0 });
    expect(live?.retry_at).toBeLessThanOrEqual(d.now);

    await deputy.round();
    await deputy.idle();
    expect(harness.calls).toHaveLength(2);
    const second = harness.calls[1];
    expect(second?.interactive).toBeFalsy();
    expect(second?.deputy_turn).toBe(harness.calls[0]?.deputy_turn);
    expect(second?.session).toEqual({
      ref: 'sess-1',
      from_attempt_id: harness.calls[0]?.attempt_id,
    });
    const turns = d.store.deputy.turnsOf({ task_id: t.id });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ final_message: 'done headless' });
  });
});
