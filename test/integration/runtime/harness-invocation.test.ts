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
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../../src/adapters/harness/claude.ts';
import { codexAdapter } from '../../../src/adapters/harness/codex.ts';
import {
  wireRoleSchema,
  type Role,
} from '../../../src/adapters/harness/result-schema.ts';
import type { VendorPin } from '../../../src/adapters/harness/vendor.ts';
import type { HarnessInput } from '../../../src/adapters/ports.ts';
import { sessionFor } from '../../../src/daemon/handlers.ts';
import { RUN_FILES, RunDir } from '../../../src/runner/files.ts';
import {
  InvocationUnknown,
  RunnerHarness,
} from '../../../src/runner/invocation.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
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

function env(
  vendor: 'claude' | 'codex',
  attempt: string,
  mode = '',
  secret = CANARY,
): Env {
  const root = tempDir('cusr-invocation-', dirs);
  const data = join(root, 'data');
  const worktree = join(root, 'wt');
  const gitDir = join(root, 'git');
  mkdirSync(worktree);
  mkdirSync(join(gitDir, 'refs'), { recursive: true });
  writeFileSync(
    join(worktree, 'calc.py'),
    'def add(a, b):\n    return a + b\n',
  );
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
    writeFileSync(
      file,
      homeFileContent(h, JSON.stringify({ accessToken: `${secret}${i}` })),
    );
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

function runDirFiles(e: Env, attempt: string): string {
  const base = join(e.data, 'runs', attempt);
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((n) =>
      n.isDirectory()
        ? walk(join(d, n.name))
        : [readFileSync(join(d, n.name), 'utf8')],
    );
  return walk(base).join('\n');
}

describe('six role × vendor runs through the real runner lifecycle', () => {
  it.each(VALID_RUNS.map((r) => [r.attempt, r] as const))(
    '%s',
    async (attempt, r) => {
      const e = env(r.vendor, attempt);
      const inp = input(r.vendor, r.role);
      const out = await harness(e).run(inp, signal());
      if (out.kind !== 'result') throw new Error(JSON.stringify(out));
      expect(out.value).toEqual(acceptedValue(attempt));
      expect(out.usage.basis).toBe('reported');

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
        expect(
          (result.value as { provenance: Record<string, unknown> }).provenance,
        ).toMatchObject({
          operation_id: inp.operation_id,
          attempt_id: inp.attempt_id,
          role: r.role,
          manifest_hash: evidenceManifest(e.pin).manifest_hash,
          inner_mode: 'native',
          context_digest: inp.context.digest,
        });
      // The prompt went in on stdin from the read-only context file.
      expect(readFileSync(join(run.dir, 'context/prompt.md'), 'utf8')).toBe(
        inp.context.text,
      );
      // Only the selected auth was installed, and it is gone again.
      const layout = e.sandbox.plans[0];
      expect(layout?.role).toBe(r.role);
      expect(
        readdirSync(join(run.dir, 'private-home'), { recursive: true }).filter(
          (p) => String(p).endsWith('.json'),
        ),
      ).toEqual([]);
      expect(runDirFiles(e, inp.attempt_id)).not.toContain(CANARY);
    },
  );
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

  it('external_verified runs only with the owner allowance; never selected silently', async () => {
    const e = env('claude', attempt);
    const ext = evidenceManifest(e.pin, {
      selected_inner_mode: 'external_verified',
      native_result: 'failed',
    });
    const denied = await harness(e, { manifest: ext }).run(
      input('claude', 'coder'),
      signal(),
    );
    expect(denied).toMatchObject({
      kind: 'failure',
      failure: 'capability_missing',
    });
    const allowed = await harness(e, {
      manifest: ext,
      isolation: 'allow_external_verified',
    }).run(input('claude', 'coder'), signal());
    expect(allowed.kind).toBe('result');
    const settings = readFileSync(
      join(
        e.data,
        'runs',
        e.proc.launches[0]?.run_id ?? '',
        'context/claude-settings.json',
      ),
      'utf8',
    );
    expect(JSON.parse(settings)).toMatchObject({
      sandbox: { enabled: false, allowUnsandboxedCommands: false },
    });
  });

  it('a sandbox layout other than the pinned one for the role is capability_missing; nothing launches', async () => {
    const e = env('claude', attempt);
    const manifest = evidenceManifest(
      e.pin,
      {},
      {
        coder: hashText('another layout'),
      },
    );
    const out = await harness(e, { manifest }).run(
      input('claude', 'coder'),
      signal(),
    );
    expect(out).toMatchObject({
      kind: 'failure',
      failure: 'capability_missing',
      detail: 'sandbox layout for coder changed since the proof',
      invoked: false,
    });
    expect(e.proc.launches).toHaveLength(0);
    const reviewer = await harness(e, { manifest }).run(
      input('claude', 'reviewer'),
      signal(),
    );
    expect(reviewer).toMatchObject({
      failure: 'capability_missing',
      detail: 'no proven sandbox layout for reviewer',
    });
  });

  it('a manifest without proven structured output or permission enforcement is refused', async () => {
    const e = env('codex', 's0-codex-coder-1793178479');
    const m = evidenceManifest(e.pin, {
      capabilities: {
        structured_output: { status: 'unknown', evidence: null },
      },
    });
    const out = await harness(e, { manifest: m }).run(
      input('codex', 'coder'),
      signal(),
    );
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
    const out = await harness(e, { credentials: {} }).run(
      input('codex', 'coder'),
      signal(),
    );
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
    const result = readFileSync(
      join(e.data, 'runs', inp.attempt_id, 'out/result.json'),
      'utf8',
    );
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

  it('a reviewer that changed its read-only worktree is a boundary violation, never an approval', async () => {
    const e = env('claude', 's0-claude-reviewer-1793180331', 'write_worktree');
    const out = await harness(e).run(input('claude', 'reviewer'), signal());
    expect(out).toMatchObject({
      kind: 'failure',
      failure: 'boundary_violation',
      invoked: true,
    });
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
      join(
        e.data,
        'runs',
        inp.attempt_id,
        'private-home',
        '.claude',
        'settings.json',
      ),
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

  it('abort stops the run and reports cancelled', async () => {
    const e = env('claude', 's0-claude-coder-1793172185', 'hang');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const out = await harness(e).run(input('claude', 'coder'), ac.signal);
    expect(out).toMatchObject({
      kind: 'failure',
      failure: 'cancelled',
      invoked: true,
    });
  });

  it('an attempt that was already launched is recovered, never launched again', async () => {
    const e = env('claude', 's0-claude-coder-1793172185');
    const inp = input('claude', 'coder');
    const h = harness(e);
    await h.run(inp, signal());
    await expect(h.run(inp, signal())).rejects.toThrow(InvocationUnknown);
    expect(e.proc.launches).toHaveLength(1);
  });
});

describe('worker content and reviewer input (T076)', () => {
  it('the worker writes its content in its own scratch; only that fresh file is copied out', async () => {
    const e = env('claude', 's0-claude-coder-1793172185', 'publish');
    const h = harness(e);
    const name = 'publish-op.json';
    const host = join(e.root, 'content', name);
    const inp = input('claude', 'coder', {
      context: {
        text: `write as JSON {"commit_message", "pr_title", "pr_body"} to ${h.agent_paths.scratch}/${name}.\n`,
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

  it('a reviewer never resumes a session', async () => {
    const e = env('claude', 's0-claude-reviewer-1793180331');
    const out = await harness(e).run(
      input('claude', 'reviewer', { session: { ref: 's' } }),
      signal(),
    );
    expect(out).toMatchObject({
      kind: 'failure',
      failure: 'capability_missing',
      invoked: false,
    });
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

  it('codex has no pinned resume form even with a proven manifest', async () => {
    const e = env('codex', 's0-codex-fixer-1793173505');
    const proven = evidenceManifest(e.pin, {
      capabilities: {
        ...evidenceManifestEntry('codex').capabilities,
        session_resume: { status: 'proven', evidence: 'test-only' },
      },
    });
    const h = harness(e, { manifest: proven });
    // What the handler reads: no resume, so a repair falls back to a new session with this reason.
    expect(h.manifest.capabilities.resume).toBe('unsupported');
    expect(sessionFor({ resume: { session_ref: 't-1' } }, h)).toEqual({
      session: null,
      fallback: 'resume_unsupported',
      asked: true,
    });
    const out = await h.run(
      input('codex', 'fixer', { session: { ref: 't-1' } }),
      signal(),
    );
    expect(out).toMatchObject({
      kind: 'failure',
      failure: 'capability_missing',
    });
    expect(e.proc.launches).toHaveLength(0);
  });
});

function evidenceManifestEntry(vendor: 'claude' | 'codex'): {
  capabilities: Record<string, { status: string; evidence: string | null }>;
} {
  const all = JSON.parse(
    readFileSync(join(REAL, 'capability-manifest.json'), 'utf8'),
  ) as {
    vendors: Record<
      string,
      {
        capabilities: Record<
          string,
          { status: string; evidence: string | null }
        >;
      }
    >;
  };
  return all.vendors[vendor] as {
    capabilities: Record<string, { status: string; evidence: string | null }>;
  };
}
