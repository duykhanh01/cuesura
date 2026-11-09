/**
 * T071/T072/T138 RunnerHarness over the real runner lifecycle (no systemd, no bwrap, no model): a
 * stand-in binary replays the T007 runs. Checks what the harness does around the boundary: pinned
 * binary and manifest verified before every attempt, read-only context/schema/settings, a fresh private
 * home with only the selected auth removed afterwards, canary secrets never persisted, provenance in
 * out/result.json, reviewer write canary, abort, recovery instead of a second launch, and sessions
 * passed only where resume is proven.
 */
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundaryRole } from '../../../src/adapters/harness/vendor.ts';
import { claudeAdapter } from '../../../src/adapters/harness/claude.ts';
import { codexAdapter } from '../../../src/adapters/harness/codex.ts';
import {
  ROLE_SCHEMA_DIGESTS,
  wireRoleSchema,
  type Role,
} from '../../../src/adapters/harness/result-schema.ts';
import type { VendorPin } from '../../../src/adapters/harness/vendor.ts';
import {
  DaemonStopping,
  type HarnessInput,
  type ProcessPort,
} from '../../../src/adapters/ports.ts';
import { sessionFor } from '../../../src/daemon/handlers.ts';
import { RUN_FILES, RunDir } from '../../../src/runner/files.ts';
import { InvocationUnknown, OUTCOME_FILE, RunnerHarness } from '../../../src/runner/invocation.ts';
import { homeSecretValues, readInstalledAuth } from '../../../src/runner/private-home.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { err, ok } from '../../../src/shared/result.ts';
import { hashCanonical, hashText } from '../../../src/shared/hash.ts';
import {
  acceptedValue,
  homeFileContent,
  REAL,
  spikePin,
  VALID_RUNS,
} from '../../support/harness-fixtures.ts';
import {
  evidenceManifest,
  fakeVendorPin,
  HOST_POLICY_HASH,
  InlineProcessPort,
  PassThroughSandbox,
  tempDir,
} from '../../support/runner-harness.ts';

const dirs: string[] = [];
afterEach(async () => {
  // Let inline runs finish their exit records before their directories go.
  await new Promise((r) => setTimeout(r, 50));
  const { rmSync } = await import('node:fs');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CANARY = 'sk-ant-canary0123456789abcdefghij';

type Env = {
  root: string;
  data: string;
  worktree: string;
  gitDir: string;
  pin: VendorPin;
  proc: InlineProcessPort;
  sandbox: PassThroughSandbox;
  credentials: Record<string, { name: string; file: string }>;
};

/** The archived evidence predates the decider; these tests need its schema proven too. */
function withDecider(
  e: Env,
  shapes?: Parameters<typeof evidenceManifest>[2],
): ReturnType<typeof evidenceManifest> {
  const all = JSON.parse(readFileSync(join(REAL, 'capability-manifest.json'), 'utf8')) as {
    vendors: Record<
      string,
      { role_schemas: Record<string, { digest: string }>; capabilities: Record<string, unknown> }
    >;
  };
  const entry = all.vendors[e.pin.vendor];
  return evidenceManifest(
    e.pin,
    {
      role_schemas: { ...entry?.role_schemas, decider: { digest: ROLE_SCHEMA_DIGESTS.decider } },
      capabilities: {
        ...entry?.capabilities,
        schema_acceptance_decider: { status: 'proven', evidence: 'test-only decider proof' },
      },
    },
    shapes,
  );
}

function env(vendor: 'claude' | 'codex', attempt: string, mode = '', secret = CANARY): Env {
  const root = tempDir('cusr-invocation-', dirs);
  const data = join(root, 'data');
  const worktree = join(root, 'wt');
  const gitDir = join(root, 'git');
  mkdirSync(worktree);
  mkdirSync(join(gitDir, 'refs'), { recursive: true });
  writeFileSync(join(worktree, 'calc.py'), 'def add(a, b):\n    return a + b\n');
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(gitDir, 'config'), '[core]\n');
  const credDir = join(root, 'cred');
  mkdirSync(credDir);
  const pin = fakeVendorPin(vendor, root, {
    FAKE_VENDOR_REPLAY: join(REAL, attempt),
    FAKE_VENDOR_MODE: mode,
  });
  const credentials: Env['credentials'] = {};
  pin.home_files.forEach((h, i) => {
    const file = join(credDir, `${h.credential}.json`);
    writeFileSync(file, homeFileContent(h, JSON.stringify({ accessToken: `${secret}${i}` })));
    credentials[h.credential] = { name: h.credential, file };
  });
  return {
    root,
    data,
    worktree,
    gitDir,
    pin,
    proc: new InlineProcessPort(data),
    sandbox: new PassThroughSandbox(),
    credentials,
  };
}

function harness(
  e: Env,
  over: Partial<ConstructorParameters<typeof RunnerHarness>[0]> = {},
): RunnerHarness {
  return new RunnerHarness({
    harness: e.pin.vendor,
    adapter: e.pin.vendor === 'claude' ? claudeAdapter : codexAdapter,
    pin: e.pin,
    manifest: evidenceManifest(e.pin),
    isolation: 'internal_required',
    process: e.proc,
    sandbox: e.sandbox,
    host_policy_hash: HOST_POLICY_HASH,
    data_dir: e.data,
    credentials: e.credentials,
    redactor: new Redactor(),
    clock: {
      now: () => Date.now() as EpochMs,
      monotonic: () => performance.now(),
    },
    workspace: () => ({ worktree: e.worktree, git_dirs: [e.gitDir] }),
    limits: { term_grace_ms: 300, kill_verify_ms: 1_000, stall_ms: null },
    poll_ms: 20,
    ...over,
  });
}

function input(
  vendor: 'claude' | 'codex',
  role: Role,
  over: Partial<HarnessInput> = {},
): HarnessInput {
  const s = spikePin(vendor);
  const id = randomUUID();
  return {
    role,
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
    context: {
      text: '# task\nfix add()\n',
      digest: hashText('# task\nfix add()\n'),
    },
    schema: wireRoleSchema(role, { omit_meta_schema: false }),
    wall_ms: 20_000,
    deadline_at: (Date.now() + 60_000) as EpochMs,
    session: null,
    ...over,
  };
}

const signal = (): AbortSignal => new AbortController().signal;

it.each(['run', 'transcript'])(
  'a missing previous %s falls back to a fresh session and remains recoverable',
  async (missing) => {
    const e = env('claude', 's0-claude-fixer-1793173414');
    const from = 'previous-attempt';
    if (missing === 'transcript')
      RunDir.open({
        dataDir: e.data,
        kind: 'runs',
        id: from,
        redactor: new Redactor(),
      });
    const inp = input('claude', 'fixer', {
      session: {
        ref: '0192aaaa-0000-7000-8000-000000000001',
        from_attempt_id: from,
      },
    });
    const h = harness(e, {
      manifest: evidenceManifest(e.pin, {
        capabilities: {
          ...evidenceManifestEntry('claude').capabilities,
          session_resume: { status: 'proven', evidence: 'test-only' },
        },
      }),
    });
    const out = await h.run(inp, signal());
    expect(out).toMatchObject({
      kind: 'result',
      resumed: false,
      resume_fallback: 'session_missing',
    });
    expect(e.proc.launches[0]?.argv).not.toContain('--resume');
    expect(h.recover(inp)).toMatchObject({
      kind: 'result',
      resumed: false,
      resume_fallback: 'session_missing',
    });
  },
);

function runDirFiles(e: Env, attempt: string): string {
  const base = join(e.data, 'runs', attempt);
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((n) =>
      n.isDirectory() ? walk(join(d, n.name)) : [readFileSync(join(d, n.name), 'utf8')],
    );
  return walk(base).join('\n');
}

describe('six role × vendor runs through the real runner lifecycle', () => {
  it.each(VALID_RUNS.map((r) => [r.attempt, r] as const))('%s', async (attempt, r) => {
    const e = env(r.vendor, attempt);
    const inp = input(r.vendor, r.role);
    const out = await harness(e).run(inp, signal());
    if (out.kind !== 'result') throw new Error(JSON.stringify(out));
    expect(out.value).toEqual(acceptedValue(attempt));
    expect(out.usage.basis).toBe('reported');
    expect(e.proc.launches[0]?.env['CLAUDE_CODE_ENTRYPOINT']).toBe(
      r.vendor === 'claude' ? 'cuesura' : undefined,
    );

    const run = RunDir.open({
      dataDir: e.data,
      kind: 'runs',
      id: inp.attempt_id,
      redactor: new Redactor(),
      create: false,
    });
    const result = run.readFinal(RUN_FILES.result);
    expect(result.state).toBe('valid');
    if (result.state === 'valid')
      expect((result.value as { provenance: Record<string, unknown> }).provenance).toMatchObject({
        operation_id: inp.operation_id,
        attempt_id: inp.attempt_id,
        role: r.role,
        manifest_hash: evidenceManifest(e.pin).manifest_hash,
        inner_mode: 'native',
        context_digest: inp.context.digest,
      });
    // The prompt went in on stdin from the read-only context file.
    expect(readFileSync(join(run.dir, 'context/prompt.md'), 'utf8')).toBe(inp.context.text);
    // Only the selected auth was installed, and it is gone again.
    const layout = e.sandbox.plans[0];
    expect(layout?.role).toBe(boundaryRole(r.role));
    expect(
      readdirSync(join(run.dir, 'private-home'), { recursive: true }).filter((p) =>
        String(p).endsWith('.json'),
      ),
    ).toEqual([]);
    expect(runDirFiles(e, inp.attempt_id)).not.toContain(CANARY);
  });
});

describe('admission before every attempt (T070)', () => {
  const attempt = 's0-claude-coder-1793172185';

  it('a binary changed on disk since the proof is capability_missing and nothing launches', async () => {
    const e = env('claude', attempt);
    const h = harness(e);
    appendFileSync(e.pin.binary.realpath, '\n// changed\n');
    const out = await h.run(input('claude', 'coder'), signal());
    expect(out).toMatchObject({
      kind: 'failure',
      failure: 'capability_missing',
      invoked: false,
    });
    expect(e.proc.launches).toHaveLength(0);
  });

  it('changed settings, environment or host policy block the next attempt', async () => {
    const e = env('claude', attempt);
    const manifest = evidenceManifest(e.pin);
    const settings = e.pin.settings as Record<string, Record<string, unknown>>;
    const changed: VendorPin[] = [
      {
        ...e.pin,
        settings: {
          ...settings,
          permissions: { ...settings['permissions'], allow: ['Bash'] },
        },
      },
      { ...e.pin, env: { ...e.pin.env, EXTRA: '1' } },
    ];
    for (const pin of changed) {
      const out = await harness({ ...e, pin }, { manifest }).run(
        input('claude', 'coder'),
        signal(),
      );
      expect(out).toMatchObject({
        kind: 'failure',
        failure: 'capability_missing',
      });
    }
    const host = await harness(e, {
      manifest,
      host_policy_hash: hashCanonical('other'),
    }).run(input('claude', 'coder'), signal());
    expect(host).toMatchObject({
      kind: 'failure',
      failure: 'capability_missing',
    });
    expect(e.proc.launches).toHaveLength(0);
  });

  it('a sandbox layout other than the one recorded at proof time does not block the attempt', async () => {
    const e = env('claude', attempt);
    const manifest = evidenceManifest(
      e.pin,
      {},
      {
        coder: hashText('another layout'),
      },
    );
    const out = await harness(e, { manifest }).run(input('claude', 'coder'), signal());
    expect(out).not.toMatchObject({ failure: 'capability_missing' });
    expect(e.proc.launches).toHaveLength(1);
  });

  it('knows whether an attempt ever got as far as a launch', async () => {
    const e = env('claude', attempt);
    const h = harness(e);
    const i = input('claude', 'coder');
    expect(h.started(i.attempt_id)).toBe(false);
    await h.run(i, signal());
    expect(h.started(i.attempt_id)).toBe(true);
  });

  it('a manifest proven before the decider refuses it without launching, and keeps its worker role', async () => {
    const e = env('claude', 's0-claude-coder-1793172185');
    const decider = await harness(e).run(input('claude', 'decider'), signal());
    expect(decider).toMatchObject({
      kind: 'failure',
      failure: 'capability_missing',
      invoked: false,
    });
    expect(decider.kind === 'failure' && decider.detail).toContain(
      'no proof for the current decider result schema',
    );
    expect(e.proc.launches).toHaveLength(0);
    const coder = await harness(e).run(input('claude', 'coder'), signal());
    expect(coder.kind).not.toBe('failure');
  });

  it('a manifest without proven structured output or permission enforcement is refused', async () => {
    const e = env('codex', 's0-codex-coder-1793178479');
    const m = evidenceManifest(e.pin, {
      capabilities: {
        structured_output: { status: 'unknown', evidence: null },
      },
    });
    const out = await harness(e, { manifest: m }).run(input('codex', 'coder'), signal());
    expect(out).toMatchObject({
      kind: 'failure',
      failure: 'capability_missing',
      invoked: false,
    });
  });

  it('a sandbox that cannot be planned stops the attempt; there is no unsandboxed fallback', async () => {
    const e = env('claude', attempt);
    e.sandbox.fail = {
      code: 'policy_violation',
      message: 'worktree overlaps forbidden /root',
    };
    const out = await harness(e).run(input('claude', 'coder'), signal());
    expect(out).toMatchObject({
      kind: 'failure',
      failure: 'capability_missing',
      invoked: false,
    });
    expect(e.proc.launches).toHaveLength(0);
  });

  it('a missing credential reference is capability_missing', async () => {
    const e = env('codex', 's0-codex-coder-1793178479');
    const out = await harness(e, { credentials: {} }).run(input('codex', 'coder'), signal());
    expect(out).toMatchObject({
      kind: 'failure',
      failure: 'capability_missing',
    });
  });
});

describe('boundary and secrets (T072)', () => {
  it('a canary secret printed by the vendor is redacted in every run file', async () => {
    const e = env('claude', 's0-claude-coder-1793172185', 'print_home');
    const inp = input('claude', 'coder');
    await harness(e).run(inp, signal());
    const text = runDirFiles(e, inp.attempt_id);
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(CANARY);
  });

  it('an auth value the codex answer repeats is redacted in out/result.json and the outcome', async () => {
    // No well-known token shape: only the value read from the installed auth can catch it.
    const secret = 'plain-auth-value-0123456789';
    const e = env('codex', 's0-codex-coder-1793178479', 'leak_summary', secret);
    const inp = input('codex', 'coder');
    const out = await harness(e).run(inp, signal());
    if (out.kind !== 'result') throw new Error(JSON.stringify(out));
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(JSON.stringify(out)).toContain('[REDACTED]');
    const result = readFileSync(join(e.data, 'runs', inp.attempt_id, 'out/result.json'), 'utf8');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain(secret);
  });

  it('a rule file edited after the pin was confirmed is refused before launch', async () => {
    const e = env('codex', 's0-codex-coder-1793178479');
    const rule = e.pin.home_files.find((h) => h.sha256 !== undefined);
    if (rule === undefined) throw new Error('codex pin has no rule file');
    const file = e.credentials[rule.credential]?.file as string;
    writeFileSync(file, 'prefix_rule(pattern=["rm"], decision="allow")\n');
    const out = await harness(e).run(input('codex', 'coder'), signal());
    expect(out).toMatchObject({
      kind: 'failure',
      failure: 'capability_missing',
    });
    expect(e.proc.launches).toHaveLength(0);
  });

  it('a decider that changed its read-only worktree is a boundary violation; a reviewer may write', async () => {
    const e = env('claude', 's0-claude-reviewer-1793180331', 'write_worktree');
    const out = await harness(e, { manifest: withDecider(e) }).run(
      input('claude', 'decider'),
      signal(),
    );
    expect(out).toMatchObject({
      kind: 'failure',
      failure: 'boundary_violation',
      invoked: true,
    });
    const r = env('claude', 's0-claude-reviewer-1793180331', 'write_worktree');
    const reviewer = await harness(r).run(input('claude', 'reviewer'), signal());
    expect(reviewer.kind === 'failure' && reviewer.failure).not.toBe('boundary_violation');
  });

  it('a coder may write its worktree', async () => {
    const e = env('claude', 's0-claude-coder-1793172185', 'write_worktree');
    const out = await harness(e).run(input('claude', 'coder'), signal());
    expect(out.kind).toBe('result');
    expect(existsSync(join(e.worktree, 'agent-wrote.txt'))).toBe(true);
  });

  it('a private home that is not empty is refused before launch', async () => {
    const e = env('claude', 's0-claude-coder-1793172185');
    const inp = input('claude', 'coder');
    mkdirSync(join(e.data, 'runs', inp.attempt_id, 'private-home', '.claude'), {
      recursive: true,
    });
    writeFileSync(
      join(e.data, 'runs', inp.attempt_id, 'private-home', '.claude', 'settings.json'),
      '{"hooks":{}}',
    );
    const out = await harness(e).run(inp, signal());
    expect(out).toMatchObject({
      kind: 'failure',
      failure: 'capability_missing',
    });
    expect(e.proc.launches).toHaveLength(0);
  });
});

describe('run outcomes', () => {
  it('bounds the stop wait even when an unlimited run never writes its exit record', async () => {
    const e = env('claude', 's0-claude-coder-1793172185');
    const ac = new AbortController();
    let mono = 0;
    const stop = vi.fn<ProcessPort['stop']>(() => Promise.resolve('stopped'));
    const process: ProcessPort = {
      launch: () => Promise.resolve(ok({ unit: 'test-unit', invocation_id: null })),
      inspect: () =>
        Promise.resolve({
          unit: 'test-unit',
          state: 'active',
          invocation_id: null,
          cgroup: null,
        }),
      stop,
    };
    const h = harness(e, {
      process,
      clock: { now: () => 1000 as EpochMs, monotonic: () => mono },
      sleep: () => {
        mono += 10_000;
        ac.abort();
        return Promise.resolve();
      },
    });
    await expect(
      h.run({ ...input('claude', 'coder'), wall_ms: null, deadline_at: null }, ac.signal),
    ).rejects.toThrow('stop grace');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(mono).toBeLessThanOrEqual(50_000);
  });

  it('a non-zero exit with a valid answer is process_failed', async () => {
    const e = env('claude', 's0-claude-coder-1793172185', 'exit1');
    const out = await harness(e).run(input('claude', 'coder'), signal());
    expect(out).toMatchObject({
      kind: 'failure',
      failure: 'process_failed',
      invoked: true,
    });
  });

  it('codex without its output file is missing_output, not the agent message', async () => {
    const e = env('codex', 's0-codex-coder-1793178479', 'no_output');
    const out = await harness(e).run(input('codex', 'coder'), signal());
    expect(out).toMatchObject({ kind: 'failure', failure: 'missing_output' });
  });

  it('abort stops an unlimited run and reports cancelled', async () => {
    const e = env('claude', 's0-claude-coder-1793172185', 'hang');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const out = await harness(e).run(
      { ...input('claude', 'coder'), wall_ms: null, deadline_at: null },
      ac.signal,
    );
    expect(out).toMatchObject({
      kind: 'failure',
      failure: 'cancelled',
      invoked: true,
    });
  });

  it('a daemon stop leaves the run to its unit and the auth in its home; nothing is concluded', async () => {
    const e = env('claude', 's0-claude-coder-1793172185', 'hang');
    const inp = input('claude', 'coder');
    const stops: string[] = [];
    const stop = e.proc.stop.bind(e.proc);
    e.proc.stop = (id: string) => {
      stops.push(id);
      return stop(id);
    };
    const ac = new AbortController();
    setTimeout(() => ac.abort(new DaemonStopping()), 300);
    await expect(harness(e).run(inp, ac.signal)).rejects.toBeInstanceOf(DaemonStopping);
    expect(stops).toEqual([]);
    expect(e.proc.launches).toHaveLength(1);
    expect((await e.proc.inspect(inp.operation_id)).state).toBe('active');
    await stop(inp.operation_id);
  });

  it('hands the terminal view to the launch', async () => {
    const e = env('claude', 's0-claude-reviewer-1793180331');
    const view = { project: 'p', title: 'reviewer: t' };
    await harness(e).run({ ...input('claude', 'reviewer'), view }, signal());
    expect(e.proc.launches[0]?.view).toEqual(view);
  });

  it('an attempt that was already launched is recovered, never launched again', async () => {
    const e = env('claude', 's0-claude-coder-1793172185');
    const inp = input('claude', 'coder');
    const h = harness(e);
    const first = await h.run(inp, signal());
    // The repeated call concludes the finished run from disk, as recovery does.
    expect(await h.run(inp, signal())).toEqual(first);
    expect(e.proc.launches).toHaveLength(1);
  });
});

describe('worker content and reviewer input (T076)', () => {
  it('the worker writes its content in its own scratch; only that fresh file is copied out', async () => {
    const e = env('claude', 's0-claude-coder-1793172185', 'publish');
    const h = harness(e);
    const name = 'publish-op.json';
    const host = join(e.root, 'content', name);
    const scratch = h.agent_paths.scratch;
    if (typeof scratch !== 'string') throw new Error('expected legacy fixture paths');
    const inp = input('claude', 'coder', {
      context: {
        text: `write as JSON {"commit_message", "pr_title", "pr_body"} to ${scratch}/${name}.\n`,
        digest: hashText('x'),
      },
      collect: [{ scratch_name: name, host_path: host }],
    });
    const out = await h.run(inp, signal());
    expect(out.kind).toBe('result');
    expect(JSON.parse(readFileSync(host, 'utf8'))).toMatchObject({
      pr_title: 'Fix add',
    });
  });

  it('a collected file that is missing stays missing; nothing is invented', async () => {
    const e = env('claude', 's0-claude-coder-1793172185');
    const host = join(e.root, 'content', 'publish-none.json');
    await harness(e).run(
      input('claude', 'coder', {
        collect: [{ scratch_name: 'publish-none.json', host_path: host }],
      }),
      signal(),
    );
    expect(existsSync(host)).toBe(false);
  });

  it('a reviewer resumes its own session once resume is proven (#213)', async () => {
    const e = env('claude', 's0-claude-reviewer-1793180331');
    const proven = evidenceManifest(e.pin, {
      capabilities: {
        ...evidenceManifestEntry('claude').capabilities,
        session_resume: { status: 'proven', evidence: 'test-only resume proof' },
      },
    });
    const out = await harness(e, { manifest: proven }).run(
      input('claude', 'reviewer', { session: { ref: 'review-1' } }),
      signal(),
    );
    expect(out.kind).toBe('result');
    expect(e.proc.launches.at(-1)?.argv.join(' ')).toContain('--resume review-1');
  });
});

describe('sessions (T138)', () => {
  it('a session is passed only when resume is proven; otherwise the attempt is refused before launch', async () => {
    const e = env('claude', 's0-claude-fixer-1793173414');
    const unproven = await harness(e).run(
      input('claude', 'fixer', { session: { ref: 'sess-1' } }),
      signal(),
    );
    expect(unproven).toMatchObject({
      kind: 'failure',
      failure: 'capability_missing',
      invoked: false,
    });
    const proven = evidenceManifest(e.pin, {
      capabilities: {
        ...evidenceManifestEntry('claude').capabilities,
        session_resume: {
          status: 'proven',
          evidence: 'test-only resume proof',
        },
      },
    });
    const out = await harness(e, { manifest: proven }).run(
      input('claude', 'fixer', { session: { ref: 'sess-1' } }),
      signal(),
    );
    expect(out.kind).toBe('result');
    expect(e.proc.launches.at(-1)?.argv.join(' ')).toContain('--resume sess-1');
  });

  it('codex resumes a proven session with its rollout carried into the fresh home (#218)', async () => {
    const e = env('codex', 's0-codex-fixer-1793173505');
    const thread = '01a1b7dd-6b52-7760-9e52-1f0d49d39970';
    const h = harness(e);
    // Unproven: the handler asks for no session, and a session passed anyway is refused before launch.
    expect(sessionFor({ resume: { session_ref: thread } }, h).session).toBeNull();
    const unproven = await h.run(input('codex', 'fixer', { session: { ref: thread } }), signal());
    expect(unproven).toMatchObject({ kind: 'failure', failure: 'capability_missing' });
    expect(e.proc.launches).toHaveLength(0);

    const from = 'codex-previous';
    const rollout = `private-home/.codex/sessions/2026/11/08/rollout-2026-11-08T04-15-03-${thread}.jsonl`;
    RunDir.open({ dataDir: e.data, kind: 'runs', id: from, redactor: new Redactor() }).writeText(
      rollout,
      'thread\n',
    );
    const proven = harness(e, {
      manifest: evidenceManifest(e.pin, {
        capabilities: {
          ...evidenceManifestEntry('codex').capabilities,
          session_resume: { status: 'proven', evidence: 'test-only' },
        },
      }),
    });
    expect(proven.manifest.capabilities.resume).toBe('proven');
    const inp = input('codex', 'fixer', { session: { ref: thread, from_attempt_id: from } });
    const out = await proven.run(inp, signal());
    expect(out).toMatchObject({ kind: 'result', resumed: true });
    expect(e.proc.launches.at(-1)?.argv.slice(-3)).toEqual(['resume', thread, '-']);
    expect(readFileSync(join(e.data, 'runs', inp.attempt_id, rollout), 'utf8')).toBe('thread\n');

    const missing = input('codex', 'fixer', {
      session: { ref: '01a1b7dd-0000-7000-8000-000000000002', from_attempt_id: from },
    });
    expect(await proven.run(missing, signal())).toMatchObject({
      kind: 'result',
      resumed: false,
      resume_fallback: 'session_missing',
    });
    expect(e.proc.launches.at(-1)?.argv).not.toContain('resume');
  });
});

function evidenceManifestEntry(vendor: 'claude' | 'codex'): {
  capabilities: Record<string, { status: string; evidence: string | null }>;
} {
  const all = JSON.parse(readFileSync(join(REAL, 'capability-manifest.json'), 'utf8')) as {
    vendors: Record<
      string,
      {
        capabilities: Record<string, { status: string; evidence: string | null }>;
      }
    >;
  };
  return all.vendors[vendor] as {
    capabilities: Record<string, { status: string; evidence: string | null }>;
  };
}

/** The daemon dies right after the launch: the run goes on to its exit alone and nobody concludes it. */
async function orphaned(
  e: Env,
  inp: HarnessInput,
  over: Parameters<typeof harness>[1] = {},
): Promise<RunDir> {
  const dying: ProcessPort = {
    launch: async (spec) => {
      await e.proc.launch(spec);
      return err({ code: 'unknown', message: 'daemon killed' });
    },
    inspect: (id) => e.proc.inspect(id),
    stop: (id) => e.proc.stop(id),
  };
  await expect(harness(e, { ...over, process: dying }).run(inp, signal())).rejects.toThrow(
    InvocationUnknown,
  );
  const run = RunDir.open({
    dataDir: e.data,
    kind: 'runs',
    id: inp.attempt_id,
    redactor: new Redactor(),
    create: false,
  });
  for (let i = 0; i < 250 && run.readFinal(RUN_FILES.exit).state !== 'valid'; i++)
    await new Promise((r) => setTimeout(r, 20));
  return run;
}

describe('T139 M07 finalized reviewer recovery', () => {
  it('a fresh harness instance reads its finalized review and usage without launching again', async () => {
    const e = env('claude', 's0-claude-reviewer-1793180331');
    const inp = input('claude', 'reviewer');
    const first = await harness(e).run(inp, signal());
    expect(first.kind).toBe('result');
    const stopped = new AbortController();
    stopped.abort();
    const recovered = await harness(e, { credentials: {} }).run(inp, stopped.signal);
    expect(recovered).toEqual(first);
    expect(e.proc.launches).toHaveLength(1);
  });

  it('recover() after a restart reads the same finalized review and never launches; anything else is unknown', async () => {
    const e = env('claude', 's0-claude-reviewer-1793180331');
    const inp = input('claude', 'reviewer');
    const first = await harness(e).run(inp, signal());
    const fresh = harness(e, { credentials: {} });
    expect(fresh.recover(inp)).toEqual(first);
    // The terminal view came later and is display only: a run launched without it still recovers.
    expect(fresh.recover({ ...inp, view: { project: 'p', title: 'coder: t' } })).toEqual(first);
    expect(() =>
      fresh.recover({
        ...inp,
        context: { text: 'changed', digest: hashText('changed') },
      }),
    ).toThrow(InvocationUnknown);
    // No run directory at all: nothing to read, and still nothing launched.
    expect(() => fresh.recover({ ...inp, attempt_id: randomUUID() })).toThrow(InvocationUnknown);
    expect(e.proc.launches).toHaveLength(1);
  });

  it.each([
    ['coder', 's0-claude-coder-1793172185'],
    ['reviewer', 's0-claude-reviewer-1793180331'],
  ] as const)(
    'a %s run that ended while no daemon concluded it is concluded from disk by recover(); nothing launched',
    async (role, scenario) => {
      const e = env('claude', scenario);
      const inp = input('claude', role);
      const run = await orphaned(e, inp);
      expect(run.readFinal(RUN_FILES.result).state).toBe('missing');
      const recovered = harness(e, { credentials: {} }).recover(inp);
      expect(recovered.kind).toBe('result');
      expect(run.readFinal(RUN_FILES.result).state).toBe('valid');
      expect(run.readFinal(OUTCOME_FILE).state).toBe('valid');
      // Concluded: the auth leaves the home, and the stored outcome answers from now on.
      expect(homeSecretValues(readInstalledAuth(run))).toEqual([]);
      expect(harness(e, { credentials: {} }).recover(inp)).toEqual(recovered);
      expect(e.proc.launches).toHaveLength(1);
    },
  );

  it.each(
    (['coder', 'reviewer'] as const).flatMap((role) =>
      (['before', 'after'] as const).map((at) => ({ role, at })),
    ),
  )(
    'an outcome write failure $at persistence preserves $role auth for a redacted retry without another launch',
    async ({ role, at }) => {
      const secret = 'plain-auth-value-0123456789';
      const scenario =
        role === 'coder' ? 's0-codex-coder-1793178479' : 's0-codex-reviewer-1793180367';
      const e = env('codex', scenario, 'leak_summary', secret);
      const inp = input('codex', role);
      const run = await orphaned(e, inp);
      const home = join(run.dir, 'private-home');
      const auth = homeSecretValues(readInstalledAuth(run));
      expect(auth.length).toBeGreaterThan(0);
      const writeJson = run.writeJson.bind(run);
      const write = vi
        .spyOn(RunDir.prototype, 'writeJson')
        .mockImplementation((rel, value, maxBytes) => {
          if (rel === OUTCOME_FILE && at === 'before')
            throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
          const written = writeJson(rel, value, maxBytes);
          if (rel === OUTCOME_FILE) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
          return written;
        });
      try {
        expect(() => harness(e, { credentials: {} }).recover(inp)).toThrow(
          new InvocationUnknown('outcome not stored: ENOSPC'),
        );
        expect(run.readFinal(OUTCOME_FILE).state).toBe(at === 'before' ? 'missing' : 'valid');
        expect(homeSecretValues(readInstalledAuth(run))).toEqual(auth);
        expect(e.pin.home_files.every((f) => existsSync(join(home, f.to)))).toBe(true);
      } finally {
        write.mockRestore();
      }
      const recovered = harness(e, { credentials: {} }).recover(inp);
      expect(recovered.kind).toBe('result');
      expect(JSON.stringify(recovered)).toContain('[REDACTED]');
      expect(JSON.stringify(recovered)).not.toContain(secret);
      expect(run.readFinal(OUTCOME_FILE).state).toBe(
        role === 'reviewer' && at === 'before' ? 'missing' : 'valid',
      );
      expect(homeSecretValues(readInstalledAuth(run))).toEqual([]);
      expect(harness(e, { credentials: {} }).recover(inp)).toEqual(recovered);
      for (const file of [RUN_FILES.result, OUTCOME_FILE]) {
        if (run.readFinal(file).state === 'missing') continue;
        const stored = readFileSync(run.resolve(file), 'utf8');
        expect(stored).toContain('[REDACTED]');
        expect(stored).not.toContain(secret);
      }
      expect(e.proc.launches).toHaveLength(1);
    },
  );

  it('recovery after the auth left returns the stored, redacted outcome; without it, unknown', async () => {
    const secret = 'plain-auth-value-0123456789';
    const e = env('codex', 's0-codex-coder-1793178479', 'leak_summary', secret);
    const inp = input('codex', 'coder');
    const first = await harness(e).run(inp, signal());
    expect(JSON.stringify(first)).not.toContain(secret);
    const recovered = harness(e, { credentials: {} }).recover(inp);
    expect(recovered).toEqual(first);
    expect(JSON.stringify(recovered)).not.toContain(secret);
    // No stored outcome and no auth to redact the raw output with: never returned raw.
    const run = RunDir.open({
      dataDir: e.data,
      kind: 'runs',
      id: inp.attempt_id,
      redactor: new Redactor(),
      create: false,
    });
    rmSync(run.resolve(OUTCOME_FILE));
    expect(() => harness(e, { credentials: {} }).recover(inp)).toThrow(InvocationUnknown);
    expect(e.proc.launches).toHaveLength(1);
  });

  it('a write zone changed between the exit and recovery cannot be pinned on the run: unknown', async () => {
    const e = env('claude', 's0-claude-reviewer-1793180331');
    const inp = input('claude', 'decider');
    const proven = { manifest: withDecider(e) };
    await orphaned(e, inp, proven);
    writeFileSync(join(e.worktree, 'later.txt'), 'edited by someone\n');
    expect(() => harness(e, { ...proven, credentials: {} }).recover(inp)).toThrow(
      InvocationUnknown,
    );
    expect(e.proc.launches).toHaveLength(1);
  });

  it.each(['input', 'result', 'exit', 'proof', 'marker', 'manifest'])(
    'a mismatched or missing %s remains unknown; no second reviewer starts',
    async (change) => {
      const e = env('claude', 's0-claude-reviewer-1793180331');
      const inp = input('claude', 'reviewer');
      await harness(e).run(inp, signal());
      const run = RunDir.open({
        dataDir: e.data,
        kind: 'runs',
        id: inp.attempt_id,
        redactor: new Redactor(),
        create: false,
      });
      if (change === 'proof') {
        const saved = run.readFinal(RUN_FILES.result);
        if (saved.state !== 'valid') throw new Error('no result');
        const record = saved.value as { provenance: Record<string, unknown> };
        delete record.provenance['recovery'];
        run.writeJson(RUN_FILES.result, record);
      }
      if (change === 'result') {
        const saved = run.readFinal(RUN_FILES.result);
        if (saved.state !== 'valid') throw new Error('no result');
        const record = saved.value as { value: { summary: string } };
        record.value.summary = 'edited after finalization';
        run.writeJson(RUN_FILES.result, record);
      }
      if (change === 'exit') {
        const exit = run.readFinal(RUN_FILES.exit);
        if (exit.state !== 'valid') throw new Error('no exit');
        run.writeJson(RUN_FILES.exit, {
          ...(exit.value as object),
          launch_nonce: 'other',
        });
      }
      if (change === 'marker') {
        const saved = run.readFinal(RUN_FILES.launch);
        if (saved.state !== 'valid') throw new Error('no marker');
        run.writeJson(RUN_FILES.launch, {
          ...(saved.value as object),
          launch_nonce: 'other-launch',
        });
      }
      const next =
        change === 'input'
          ? {
              ...inp,
              context: { text: 'changed', digest: hashText('changed') },
            }
          : inp;
      await expect(
        harness(
          e,
          change === 'manifest'
            ? {
                manifest: {
                  ...evidenceManifest(e.pin),
                  manifest_hash: hashCanonical('other manifest'),
                },
              }
            : {},
        ).run(next, signal()),
      ).rejects.toThrow(InvocationUnknown);
      expect(e.proc.launches).toHaveLength(1);
    },
  );

  it('a boundary violation leaves no reusable result', async () => {
    const e = env('claude', 's0-claude-reviewer-1793180331', 'write_worktree');
    const inp = input('claude', 'decider');
    const proven = { manifest: withDecider(e) };
    expect(await harness(e, proven).run(inp, signal())).toMatchObject({
      kind: 'failure',
      failure: 'boundary_violation',
    });
    const run = RunDir.open({
      dataDir: e.data,
      kind: 'runs',
      id: inp.attempt_id,
      redactor: new Redactor(),
      create: false,
    });
    expect(run.readFinal(RUN_FILES.result).state).toBe('missing');
    // A repeated call gets the same stored failure back, never an approval and never a launch.
    expect(await harness(e, proven).run(inp, signal())).toMatchObject({
      kind: 'failure',
      failure: 'boundary_violation',
    });
    expect(e.proc.launches).toHaveLength(1);
  });
});

it('T139 M04: a resumed real adapter receives a fresh repair packet including Q&A and checkpoint', async () => {
  const e = env('claude', 's0-claude-coder-1793172185');
  const manifest = evidenceManifest(e.pin, {
    capabilities: {
      ...evidenceManifestEntry('claude').capabilities,
      session_resume: {
        status: 'proven',
        evidence: 'test-only protocol fixture',
      },
    },
  });
  const h = harness(e, { manifest });
  const first = input('claude', 'coder');
  const out = await h.run(first, signal());
  expect(out.kind).toBe('result');
  expect(out.session_ref).not.toBeNull();
  const text =
    'Role: fixer\nCause: CI generation 2\nCheckpoint: ' +
    'a'.repeat(40) +
    '\nQ: encoding?\nA: UTF-8\n';
  const second = input('claude', 'fixer', {
    session: { ref: out.session_ref ?? '' },
    context: { text, digest: hashText(text) },
  });
  expect((await h.run(second, signal())).kind).toBe('result');
  expect(e.proc.launches.at(-1)?.argv).toContain('--resume');
  expect(e.proc.launches.at(-1)?.argv).toContain(out.session_ref);
  const run = RunDir.open({
    dataDir: e.data,
    kind: 'runs',
    id: second.attempt_id,
    redactor: new Redactor(),
    create: false,
  });
  expect(readFileSync(run.resolve('context/prompt.md'), 'utf8')).toBe(text);
  const record = run.readFinal(RUN_FILES.result);
  expect(record.state === 'valid' && record.value).toMatchObject({
    provenance: { context_digest: hashText(text) },
  });
  expect(second.context.digest).not.toBe(first.context.digest);
  expect(e.proc.launches).toHaveLength(2);
});
