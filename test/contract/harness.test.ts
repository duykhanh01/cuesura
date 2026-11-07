/**
 * T066 shared harness contract (FR-011/012/016): the same expectations for the fake harness and the
 * Claude/Codex adapters over the T007 fixtures — argv/model/effort/schema/auth/session as pinned,
 * structured final, invalid/truncated/semantic/stale/fallback provenance, usage missing, refusal, auth
 * and rate limit. No model is called: the real runs are replayed from their archived records.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../src/adapters/harness/claude.ts';
import { codexAdapter } from '../../src/adapters/harness/codex.ts';
import { FakeHarness } from '../../src/adapters/harness/fake.ts';
import { wireRoleSchema, type Role } from '../../src/adapters/harness/result-schema.ts';
import {
  ProvenanceError,
  validateResult,
  type ExitFacts,
  type Expected,
  type FileRead,
} from '../../src/adapters/harness/validate-result.ts';
import {
  classifyFailure,
  type VendorAdapter,
  type VendorPlanInput,
  type VendorRead,
} from '../../src/adapters/harness/vendor.ts';
import { IN_SANDBOX } from '../../src/runner/sandbox.ts';
import type { EpochMs } from '../../src/shared/brand.ts';
import { hashCanonical, hashText } from '../../src/shared/hash.ts';
import {
  acceptedValue,
  codexLastMessage,
  readReal,
  recordedHarnessArgv,
  recordedRead,
  spikePin,
  VALID_RUNS,
  vendorPin,
} from '../support/harness-fixtures.ts';

const ADAPTERS: Record<'claude' | 'codex', VendorAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};
const WORKTREE = '/tmp/cusr-spike-002-real-dTgXz2/fixture/worktree';

function planInput(
  vendor: 'claude' | 'codex',
  role: Role,
  over: Partial<VendorPlanInput> = {},
): VendorPlanInput {
  const s = spikePin(vendor);
  return {
    role,
    model: s.model,
    effort: s.effort,
    schema: wireRoleSchema(role, { omit_meta_schema: vendor === 'claude' }),
    cwd: WORKTREE,
    paths: IN_SANDBOX,
    inner_mode: 'native',
    session: null,
    ...over,
  };
}

function expected(vendor: 'claude' | 'codex', role: Role, attempt = 'a-1'): Expected {
  const s = spikePin(vendor);
  return {
    operation_id: `op-${attempt}`,
    attempt_id: attempt,
    revision: 1,
    role,
    binding: {
      harness: vendor,
      vendor,
      model: s.model,
      effort: s.effort,
      permission_policy_hash: hashCanonical('policy'),
    },
    context_digest: hashText('context'),
    schema: wireRoleSchema(role, { omit_meta_schema: vendor === 'claude' }),
    launch_nonce: 'nonce-1',
    binary_digest: `sha256:${s.binary.sha256}`,
  };
}

function exitOf(e: Expected, over: Partial<ExitFacts> = {}): ExitFacts {
  return {
    operation_id: e.operation_id,
    launch_nonce: e.launch_nonce,
    outcome: 'exited',
    exit_code: 0,
    spawned: true,
    started_at: 1_000 as EpochMs,
    ...over,
  };
}

/** Replays one vendor run: adapter facts, the declared source, then orchestrator validation. */
function replay(
  vendor: 'claude' | 'codex',
  role: Role,
  read: VendorRead,
  o: {
    file?: FileRead | null;
    exit?: Partial<ExitFacts>;
    expected?: Partial<Expected>;
  } = {},
): ReturnType<typeof validateResult> {
  const adapter = ADAPTERS[vendor];
  const plan = adapter.plan(vendorPin(vendor), planInput(vendor, role));
  if (!plan.ok) throw new Error(plan.error.message);
  const e = { ...expected(vendor, role), ...o.expected };
  return validateResult({
    expected: e,
    exit: exitOf(e, o.exit),
    facts: adapter.read(read),
    source: plan.value.result,
    file: plan.value.result.kind === 'file' ? (o.file ?? null) : null,
  });
}

function fileOf(raw: string): FileRead {
  return { kind: 'read', raw, bytes: Buffer.byteLength(raw) };
}

function realFile(attempt: string, vendor: 'claude' | 'codex'): FileRead | null {
  return vendor === 'codex' ? fileOf(codexLastMessage(attempt)) : null;
}

describe('harness argv and settings follow the pinned T007 shape (T068/T069)', () => {
  it('reports max-turn exhaustion independently of infrastructure errors', () => {
    const read = claudeAdapter.read({
      stdout: [
        {
          type: 'result',
          subtype: 'error_max_turns',
          is_error: true,
          session_id: 'continued-session',
        },
      ],
      stderr: '',
      truncated_records: 0,
    });
    expect(read.failure?.kind).toBe('turn_limit');
    expect(read.session_ref).toBe('continued-session');
    const e = expected('claude', 'coder');
    expect(
      validateResult({
        expected: e,
        exit: exitOf(e),
        facts: read,
        source: { kind: 'stdout_json', pointer: ['structured_output'] },
        file: null,
      }).outcome,
    ).toMatchObject({ kind: 'failure', failure: 'turn_limit' });
  });

  it.each([false, true])('runs Claude without a turn cap (host_execution=%s)', (host_execution) => {
    const p = claudeAdapter.plan(
      { ...vendorPin('claude'), max_turns: null },
      planInput('claude', 'coder', { host_execution }),
    );
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value.argv).not.toContain('--max-turns');
  });

  it.each(VALID_RUNS.map((r) => [r.attempt, r] as const))('%s', (attempt, r) => {
    const plan = ADAPTERS[r.vendor].plan(vendorPin(r.vendor), planInput(r.vendor, r.role));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // The archived runs predate dropping --no-session-persistence and --ephemeral, the Claude
    // isolation flags and tool list, and the Codex user-config and feature switches.
    const dropped = new Set([
      '--no-session-persistence',
      '--ephemeral',
      '--safe-mode',
      '--strict-mcp-config',
      '--ignore-user-config',
    ]);
    const withValue = new Set(['--setting-sources', '--mcp-config', '--disable', '--tools']);
    const recorded = recordedHarnessArgv(attempt).filter(
      (a, i, all) => !dropped.has(a) && !withValue.has(a) && !withValue.has(all[i - 1] ?? ''),
    );
    // The archived runs predate the default Claude tool set (no --tools); see below.
    const ours = [...plan.value.argv];
    if (r.vendor === 'claude') {
      const i = ours.indexOf('--json-schema');
      expect(JSON.parse(ours[i + 1] as string)).toEqual(JSON.parse(recorded[i + 1] as string));
      ours[i + 1] = recorded[i + 1] as string;
      // The archived runs also predate denying ScheduleWakeup.
      const d = ours.indexOf('--disallowedTools');
      ours[d + 1] = (ours[d + 1] as string).replace(',ScheduleWakeup', '');
    }
    expect(ours.slice(0, recorded.length)).toEqual(recorded);
    for (const flag of [...dropped, ...withValue]) expect(plan.value.argv).not.toContain(flag);
    if (r.vendor === 'claude') {
      expect(plan.value.context_files).toHaveLength(1);
      expect(JSON.parse(plan.value.context_files[0]?.content ?? '')).toEqual(
        JSON.parse(readReal(`${attempt}/context/claude-settings.json`)),
      );
      expect(plan.value.result).toEqual({
        kind: 'stdout_json',
        pointer: ['structured_output'],
      });
    } else {
      expect(plan.value.schema_files[0]?.content).toBe(
        readReal(`${attempt}/schema/${plan.value.schema_files[0]?.name ?? ''}`),
      );
      expect(plan.value.result).toEqual({
        kind: 'file',
        scratch_name: 'final-response.json',
      });
    }
  });

  it('the claude reviewer never gets Edit/Write and the worker roles keep them', () => {
    const argv = (role: Role): readonly string[] => {
      const p = claudeAdapter.plan(vendorPin('claude'), planInput('claude', role));
      return p.ok ? p.value.argv : [];
    };
    expect(argv('reviewer').join(' ')).toContain('--disallowedTools Edit,Write');
    expect(argv('coder').join(' ')).not.toMatch(/Edit|Write/);
    expect(argv('fixer').join(' ')).not.toMatch(/Edit|Write/);
  });

  it('no claude role can schedule a wakeup after its answer', () => {
    for (const role of ['coder', 'fixer', 'reviewer'] as const) {
      const p = claudeAdapter.plan(vendorPin('claude'), planInput('claude', role));
      const argv = p.ok ? p.value.argv : [];
      expect(argv[argv.indexOf('--disallowedTools') + 1]).toContain('ScheduleWakeup');
    }
  });

  it('claude runs every role with the default tool set of an interactive session', () => {
    for (const role of ['coder', 'fixer', 'reviewer'] as const) {
      const p = claudeAdapter.plan(vendorPin('claude'), planInput('claude', role));
      expect(p.ok && p.value.argv).not.toContain('--tools');
    }
    expect(
      claudeAdapter.plan({ ...vendorPin('claude'), tools: null }, planInput('claude', 'coder')).ok,
    ).toBe(true);
  });

  it('codex loads the owner config with every feature on, as in an interactive session', () => {
    for (const role of ['coder', 'fixer', 'reviewer'] as const) {
      const p = ADAPTERS.codex.plan(vendorPin('codex'), planInput('codex', role));
      expect(p.ok).toBe(true);
      if (!p.ok) continue;
      expect(p.value.argv).not.toContain('--ignore-user-config');
      expect(p.value.argv).not.toContain('--disable');
    }
  });

  it('keeps the codex session recorded so the reviewer can spawn sub-agents', () => {
    for (const role of ['coder', 'fixer', 'reviewer'] as const) {
      const p = ADAPTERS.codex.plan(vendorPin('codex'), planInput('codex', role));
      expect(p.ok).toBe(true);
      if (!p.ok) continue;
      expect(p.value.argv).not.toContain('--ephemeral');
    }
    const reviewer = ADAPTERS.codex.plan(vendorPin('codex'), planInput('codex', 'reviewer'));
    expect(reviewer.ok && reviewer.value.argv.join(' ')).toContain('--sandbox read-only');
  });

  it('takes model and effort from the binding only, never a default', () => {
    for (const vendor of ['claude', 'codex'] as const) {
      const p = ADAPTERS[vendor].plan(
        vendorPin(vendor),
        planInput(vendor, 'coder', { model: 'model-x', effort: null }),
      );
      expect(p.ok).toBe(true);
      if (!p.ok) continue;
      expect(p.value.argv).toContain('model-x');
      expect(p.value.argv.join(' ')).not.toMatch(/effort/);
      expect(p.value.argv).not.toContain(spikePin(vendor).model);
      const empty = ADAPTERS[vendor].plan(
        vendorPin(vendor),
        planInput(vendor, 'coder', { model: '' }),
      );
      expect(empty.ok).toBe(false);
    }
  });

  it('refuses bypass tokens, approving permission modes and unsandboxed commands', () => {
    const pin = vendorPin('claude');
    const settings = pin.settings as Record<string, Record<string, unknown>>;
    const cases = [
      { ...pin, env: { ...pin.env, X: '--dangerously-skip-permissions' } },
      {
        ...pin,
        settings: {
          ...settings,
          permissions: {
            ...settings['permissions'],
            defaultMode: 'bypassPermissions',
          },
        },
      },
      {
        ...pin,
        settings: {
          ...settings,
          permissions: {
            ...settings['permissions'],
            defaultMode: 'acceptEdits',
          },
        },
      },
      {
        ...pin,
        settings: {
          ...settings,
          sandbox: { ...settings['sandbox'], allowUnsandboxedCommands: true },
        },
      },
      { ...pin, settings: null },
    ];
    for (const c of cases)
      expect(claudeAdapter.plan(c, planInput('claude', 'coder')).ok).toBe(false);
    const cx = vendorPin('codex');
    expect(codexAdapter.plan({ ...cx, env: { A: 'yolo' } }, planInput('codex', 'coder')).ok).toBe(
      false,
    );
  });

  it('passes a session in each vendor resume form, with the permissions of a new session', () => {
    const c = claudeAdapter.plan(
      vendorPin('claude'),
      planInput('claude', 'fixer', { session: { ref: 'sess-1' } }),
    );
    expect(c.ok && c.value.argv.join(' ')).toContain('--resume sess-1');
    expect(c.ok && c.value.argv).not.toContain('--no-session-persistence');
    const thread = '01a1b7dd-6b52-7760-9e52-1f0d49d39970';
    for (const role of ['fixer', 'reviewer'] as const) {
      const fresh = codexAdapter.plan(vendorPin('codex'), planInput('codex', role));
      const resumed = codexAdapter.plan(
        vendorPin('codex'),
        planInput('codex', role, { session: { ref: thread } }),
      );
      if (!fresh.ok || !resumed.ok) throw new Error('codex plan refused');
      // `resume` has no -C/--sandbox of its own: the exec options before it carry over (0.167.0).
      expect(resumed.value.argv).toEqual([...fresh.value.argv.slice(0, -1), 'resume', thread, '-']);
      expect(resumed.value.settings_hash).toBe(fresh.value.settings_hash);
    }
    for (const ref of ['thread-1', '--dangerously-bypass-approvals-and-sandbox', '--last'])
      expect(
        codexAdapter.plan(vendorPin('codex'), planInput('codex', 'fixer', { session: { ref } })),
      ).toMatchObject({ ok: false, error: { code: 'policy_violation' } });
    expect(claudeAdapter.resume_supported).toBe(true);
    expect(codexAdapter.resume_supported).toBe(true);
  });
});

describe('six role × vendor fixtures normalise to the accepted result (T066)', () => {
  it.each(VALID_RUNS.map((r) => [r.attempt, r] as const))('%s', (attempt, r) => {
    const v = replay(r.vendor, r.role, recordedRead(attempt, r.vendor), {
      file: realFile(attempt, r.vendor),
    });
    expect(v.outcome.kind).toBe('result');
    if (v.outcome.kind !== 'result' || v.record === null) return;
    expect(v.outcome.value).toEqual(acceptedValue(attempt));
    expect(v.outcome.usage.basis).toBe('reported');
    expect(v.outcome.usage.tokens).toBeGreaterThan(0);
    if (r.vendor === 'claude') expect(v.outcome.usage.cost).toBeGreaterThan(0);
    else expect(v.outcome.usage.cost).toBeUndefined();
    expect(v.outcome.session_ref).not.toBeNull();
    // Provenance is the orchestrator's launch, never something the model wrote.
    expect(v.record.provenance).toMatchObject({
      operation_id: 'op-a-1',
      attempt_id: 'a-1',
      revision: 1,
      role: r.role,
      launch_nonce: 'nonce-1',
      source: r.vendor === 'claude' ? 'stdout_json' : 'file',
      raw_digest: v.outcome.raw_digest,
    });
  });

  it('keeps permission denials from the vendor record, not from the model text', () => {
    const c = replay('claude', 'coder', recordedRead('s0-claude-coder-1793172185', 'claude'));
    expect(c.outcome.permission_denials).toEqual([
      {
        tool: 'Bash',
        command: '/usr/bin/touch /cusr/scratch/permission-denied-by-rule',
        message:
          'Permission to use Bash with command /usr/bin/touch /cusr/scratch/permission-denied-by-rule has been denied.',
        source: 'claude_event',
      },
    ]);
    const x = replay('codex', 'fixer', recordedRead('s0-codex-fixer-1793173505', 'codex'), {
      file: realFile('s0-codex-fixer-1793173505', 'codex'),
    });
    expect(x.outcome.permission_denials.length).toBeGreaterThan(0);
    expect(x.outcome.permission_denials.every((d) => d.source === 'codex_stderr')).toBe(true);
    // Without stderr there is no denial, whatever the model claimed in its summary.
    const silent = replay(
      'codex',
      'fixer',
      { ...recordedRead('s0-codex-fixer-1793173505', 'codex'), stderr: '' },
      { file: realFile('s0-codex-fixer-1793173505', 'codex') },
    );
    expect(silent.outcome.permission_denials).toEqual([]);
  });

  it('the fake harness meets the same result contract for the same answers', async () => {
    for (const r of VALID_RUNS) {
      const fake = new FakeHarness({
        [r.role]: [{ kind: 'result', value: acceptedValue(r.attempt) }],
      });
      const e = expected(r.vendor, r.role);
      const out = await fake.run(
        {
          role: r.role,
          operation_id: e.operation_id,
          attempt_id: e.attempt_id,
          revision: 1,
          binding: e.binding,
          context: { text: 'ctx', digest: e.context_digest },
          schema: wireRoleSchema(r.role, { omit_meta_schema: false }),
          wall_ms: 1000,
          deadline_at: 2000 as EpochMs,
          session: null,
        },
        new AbortController().signal,
      );
      expect(out.kind).toBe('result');
      if (out.kind === 'result') {
        expect(out.value).toEqual(acceptedValue(r.attempt));
        // A fake run proves nothing about usage: it is unavailable, never zero.
        expect(out.usage).toEqual({ basis: 'unavailable' });
      }
    }
  });
});

describe('a final answer is accepted only when every layer holds (T075)', () => {
  const claudeRun = 's0-claude-coder-1793172185';
  const codexRun = 's0-codex-coder-1793178479';
  const claudeRead = (): VendorRead => recordedRead(claudeRun, 'claude');
  const withLast = (
    read: VendorRead,
    f: (last: Record<string, unknown>) => unknown,
  ): VendorRead => {
    const last = read.stdout.at(-1) as Record<string, unknown>;
    return { ...read, stdout: [...read.stdout.slice(0, -1), f(last)] };
  };

  it('a schema-invalid final is invalid_output, not done', () => {
    const v = replay(
      'claude',
      'coder',
      withLast(claudeRead(), (l) => ({
        ...l,
        structured_output: {
          schema_version: 1,
          status: 'finished',
          summary: 'x',
          questions: [],
          blocker: null,
        },
      })),
    );
    expect(v.outcome.kind).toBe('invalid_output');
    expect(v.record).toBeNull();
  });

  it('a semantically wrong final is invalid_output (request_changes without a finding)', () => {
    const raw = JSON.stringify({
      schema_version: 1,
      verdict: 'request_changes',
      summary: 'no',
      findings: [],
    });
    const v = replay('codex', 'reviewer', recordedRead('s0-codex-reviewer-1793180367', 'codex'), {
      file: fileOf(raw),
    });
    expect(v.outcome).toMatchObject({
      kind: 'invalid_output',
      raw_digest: hashText(raw),
    });
  });

  it('a truncated stream without its final record is invalid, not missing or done', () => {
    const r = claudeRead();
    const v = replay('claude', 'coder', {
      ...r,
      stdout: r.stdout.slice(0, -1),
      truncated_records: 1,
    });
    expect(v.outcome.kind).toBe('invalid_output');
    const cut = replay('claude', 'coder', {
      ...r,
      stdout: r.stdout.slice(0, -1),
    });
    expect(cut.outcome).toMatchObject({
      kind: 'failure',
      failure: 'missing_output',
    });
  });

  describe('a session re-entered after the answer (issue #158)', () => {
    const answer = (summary: string) => ({
      schema_version: 1,
      status: 'done',
      summary,
      questions: [],
      blocker: null,
    });
    const after = (read: VendorRead) => {
      const head = read.stdout.slice(0, -1);
      const result = read.stdout.at(-1) as Record<string, unknown>;
      const lifecycle = { type: 'command_lifecycle', state: 'started' };
      const init = { type: 'system', subtype: 'init' };
      const turn = (input: number, cost: number, rest: Record<string, unknown> = {}) => ({
        ...result,
        structured_output: undefined,
        result: 'Nothing left to do.',
        stop_reason: 'end_turn',
        usage: { input_tokens: input, output_tokens: 0 },
        total_cost_usd: cost,
        ...rest,
      });
      return { head, init, lifecycle, turn };
    };

    it('keeps the last structured_output and counts every turn of the stream', () => {
      const read = claudeRead();
      const { head, init, lifecycle, turn } = after(read);
      const stream = [
        ...head,
        turn(100, 1, { structured_output: answer('first') }),
        init,
        turn(0, 1),
        init,
        turn(20, 2, { structured_output: answer('second') }),
        lifecycle,
        init,
        turn(3, 3),
        lifecycle,
      ];
      const v = replay('claude', 'coder', { ...read, stdout: stream });
      expect(v.outcome).toMatchObject({
        kind: 'result',
        value: { summary: 'second' },
        usage: { basis: 'reported', tokens: 123, cost: 3 },
      });
    });

    it('a later answer that fails validation is what gets rejected', () => {
      const read = claudeRead();
      const { head, init, lifecycle, turn } = after(read);
      const stream = [
        ...head,
        turn(1, 1, { structured_output: answer('good') }),
        init,
        turn(1, 2, { structured_output: { ...answer('bad'), blocker: 'stuck' } }),
        lifecycle,
      ];
      const v = replay('claude', 'coder', { ...read, stdout: stream });
      expect(v.outcome.kind).toBe('invalid_output');
    });

    it('says which result was rejected when none of them carries an answer', () => {
      const read = claudeRead();
      const { head, lifecycle, turn } = after(read);
      const v = replay('claude', 'coder', {
        ...read,
        stdout: [...head, turn(1, 1), lifecycle],
      });
      expect(v.outcome).toMatchObject({
        kind: 'failure',
        failure: 'missing_output',
        detail:
          'no structured_output in 1 result record(s); last: subtype success, stop_reason end_turn',
      });
    });

    it('does not trust an answer when a later record was lost', () => {
      const read = claudeRead();
      const { head, lifecycle, turn } = after(read);
      const v = replay('claude', 'coder', {
        ...read,
        stdout: [...head, turn(1, 1, { structured_output: answer('a') }), lifecycle],
        truncated_records: 1,
      });
      expect(v.outcome.kind).toBe('invalid_output');
    });

    it('a turn without usage makes the total unavailable, not partial', () => {
      const facts = ADAPTERS.claude.read({
        stdout: [
          { type: 'result', usage: { input_tokens: 5, output_tokens: 2 } },
          { type: 'result' },
        ],
        stderr: '',
        truncated_records: 0,
      });
      expect(facts.usage).toEqual({ basis: 'unavailable' });
      expect(facts.usage_source).toBeNull();
    });
  });

  it('a stale or reused output file and a non-JSON file are invalid', () => {
    for (const file of [
      {
        kind: 'invalid',
        reason: 'output path existed before launch (stale result)',
      } as const,
      { kind: 'invalid', reason: 'output older than launch' } as const,
      fileOf('{"schema_version":1,'),
    ]) {
      const v = replay('codex', 'coder', recordedRead(codexRun, 'codex'), {
        file,
      });
      expect(v.outcome.kind).toBe('invalid_output');
    }
  });

  it('never falls back to another source: a missing codex file stays missing even with an agent message', () => {
    const v = replay('codex', 'coder', recordedRead(codexRun, 'codex'), {
      file: { kind: 'missing' },
    });
    expect(v.outcome).toMatchObject({
      kind: 'failure',
      failure: 'missing_output',
      invoked: true,
    });
  });

  it('exit 0 is not enough and a valid answer from a failed process is not accepted', () => {
    const failed = replay('claude', 'coder', claudeRead(), {
      exit: { exit_code: 1 },
    });
    expect(failed.outcome).toMatchObject({
      kind: 'failure',
      failure: 'process_failed',
    });
    for (const outcome of [
      'timeout',
      'stalled',
      'cancelled',
      'artifact_backpressure',
      'signaled',
    ] as const) {
      const v = replay('claude', 'coder', claudeRead(), { exit: { outcome } });
      expect(v.outcome.kind).toBe('failure');
      expect(v.record).toBeNull();
    }
    const never = replay(
      'claude',
      'coder',
      { stdout: [], stderr: '', truncated_records: 0 },
      {
        exit: { outcome: 'spawn_failed', exit_code: null, spawned: false },
      },
    );
    expect(never.outcome).toMatchObject({ kind: 'failure', invoked: false });
  });

  it('a result over 1 MiB is invalid', () => {
    const big = JSON.stringify({
      schema_version: 1,
      status: 'done',
      summary: 'x'.repeat(1024 * 1024),
      questions: [],
      blocker: null,
    });
    const v = replay('codex', 'coder', recordedRead(codexRun, 'codex'), {
      file: fileOf(big),
    });
    expect(v.outcome.kind).toBe('invalid_output');
  });

  it('a model other than the binding is rejected', () => {
    const v = replay('claude', 'coder', claudeRead(), {
      expected: {
        binding: {
          ...expected('claude', 'coder').binding,
          model: 'claude-other',
        },
      },
    });
    expect(v.outcome.kind).toBe('invalid_output');
  });

  it('missing usage is unavailable, never zero', () => {
    const v = replay(
      'claude',
      'coder',
      withLast(claudeRead(), (l) => {
        const { usage: _u, total_cost_usd: _c, ...rest } = l;
        return rest;
      }),
    );
    expect(v.outcome.kind).toBe('result');
    expect(v.outcome.usage).toEqual({ basis: 'unavailable' });
    const codex = replay(
      'codex',
      'coder',
      {
        ...recordedRead(codexRun, 'codex'),
        stdout: recordedRead(codexRun, 'codex').stdout.filter(
          (d) => (d as { type?: string }).type !== 'turn.completed',
        ),
      },
      { file: realFile(codexRun, 'codex') },
    );
    expect(codex.outcome.usage).toEqual({ basis: 'unavailable' });
  });

  it('an exit record of another launch is an orchestrator error, not a result', () => {
    expect(() =>
      replay('claude', 'coder', claudeRead(), {
        exit: { launch_nonce: 'other' },
      }),
    ).toThrow(ProvenanceError);
    expect(() =>
      replay('claude', 'coder', claudeRead(), {
        expected: {
          schema: wireRoleSchema('reviewer', { omit_meta_schema: true }),
        },
      }),
    ).toThrow(ProvenanceError);
  });
});

type SyntheticCase = {
  name: string;
  vendor: 'claude' | 'codex' | 'fixture';
  events: unknown[];
  stderr: string;
  expect: { failure: string | null; usage: string; denials: number };
};

describe('refusal, auth and rate limit map to failures with usage kept (synthetic shapes)', () => {
  const read = (name: string): SyntheticCase[] =>
    (
      JSON.parse(
        readFileSync(
          fileURLToPath(
            new URL(`../fixtures/runtime/spike-0/harness-stream/${name}`, import.meta.url),
          ),
          'utf8',
        ),
      ) as { cases: SyntheticCase[] }
    ).cases;
  const cases = [...read('cases.synthetic.json'), ...read('cases.capacity.synthetic.json')].filter(
    (c): c is SyntheticCase & { vendor: 'claude' | 'codex' } => c.vendor !== 'fixture',
  );
  const FAILURE: Record<string, string> = {
    rate_limited: 'rate_limited',
    overloaded: 'overloaded',
    auth: 'auth',
    refusal: 'refusal',
    vendor_error: 'vendor_error',
  };
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const facts = ADAPTERS[c.vendor].read({
      stdout: c.events,
      stderr: c.stderr,
      truncated_records: 0,
    });
    expect(facts.failure?.kind ?? null).toBe(c.expect.failure);
    expect(facts.usage.basis).toBe(c.expect.usage === 'reported' ? 'reported' : 'unavailable');
    expect(facts.permission_denials).toHaveLength(c.expect.denials);
    if (c.expect.failure !== null) {
      const v = replay(
        c.vendor,
        'coder',
        { stdout: c.events, stderr: c.stderr, truncated_records: 0 },
        {
          file: { kind: 'missing' },
        },
      );
      expect(v.outcome).toMatchObject({
        kind: 'failure',
        failure: FAILURE[c.expect.failure],
        invoked: true,
      });
    }
  });

  it('an HTTP status decides before the wording; overload wording alone is enough', () => {
    expect(classifyFailure('Overloaded', 401)).toBe('auth');
    expect(classifyFailure('API Error: 429 rate_limit_error', 529)).toBe('overloaded');
    expect(classifyFailure('rate limited while overloaded', null)).toBe('rate_limited');
    expect(classifyFailure('502 Bad Gateway', null)).toBe('overloaded');
    expect(classifyFailure('Gateway Timeout', null)).toBe('overloaded');
    expect(classifyFailure('connection reset', null)).toBe('vendor_error');
    expect(classifyFailure('connection reset', 400)).toBe('vendor_error');
  });

  it('an expired or revoked login is auth, not a vendor error to retry (#97)', () => {
    // The record Claude printed when its OAuth refresh failed, without an HTTP status.
    const read = claudeAdapter.read({
      stdout: [
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        },
      ],
      stderr: '',
      truncated_records: 0,
    });
    expect(read.failure?.kind).toBe('auth');
    for (const detail of [
      'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
      'authentication_error: invalid x-api-key',
      'Token has expired',
      'invalid_grant',
      'Please run /login',
    ])
      expect(classifyFailure(detail, null)).toBe('auth');
    expect(classifyFailure('connection reset by peer', null)).toBe('vendor_error');
  });

  it('codex keeps a recovered reconnect as a warning, not a failure', () => {
    const facts = codexAdapter.read({
      stdout: [
        { type: 'turn.started' },
        { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected)' },
        {
          type: 'turn.completed',
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      ],
      stderr: '',
      truncated_records: 0,
    });
    expect(facts.failure).toBeNull();
    expect(facts.final).toEqual({ kind: 'file' });
    expect(facts.warnings).toEqual(['recovered: Reconnecting... 1/5 (stream disconnected)']);
  });

  it('a rate limit keeps the vendor reset time', () => {
    const facts = claudeAdapter.read({
      stdout: [
        {
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'rejected',
            resetsAt: 1793190000,
            rateLimitType: 'five_hour',
          },
        },
      ],
      stderr: '',
      truncated_records: 0,
    });
    expect(facts.failure).toMatchObject({
      kind: 'rate_limited',
      reset_at: 1793190000000,
    });
  });
});

// Regression cases retained from the retired stream-summary prototype, against live adapters.
describe('vendor usage and denial edge cases', () => {
  it.each(['claude', 'codex'] as const)(
    '%s distinguishes missing counters from reported zero',
    (vendor) => {
      const type = vendor === 'claude' ? 'result' : 'turn.completed';
      const read = (usage: unknown) =>
        ADAPTERS[vendor].read({
          stdout: [{ type, usage }],
          stderr: '',
          truncated_records: 0,
        });
      for (const usage of [
        {},
        { input_tokens: 1 },
        { input_tokens: '0', output_tokens: 0 },
        { input_tokens: -1, output_tokens: 0 },
        { input_tokens: 0, output_tokens: null },
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: '0',
          cached_input_tokens: '0',
        },
      ]) {
        expect(read(usage).usage).toEqual({ basis: 'unavailable' });
      }
      expect(read({ input_tokens: 0, output_tokens: 0 }).usage).toMatchObject({
        basis: 'reported',
        tokens: 0,
      });
    },
  );
  it('Codex incomplete turn usage does not become a reported partial total', () => {
    const facts = codexAdapter.read({
      stdout: [
        {
          type: 'turn.completed',
          usage: { input_tokens: 5, output_tokens: 2 },
        },
        { type: 'turn.completed', usage: {} },
      ],
      stderr: '',
      truncated_records: 0,
    });
    expect(facts.usage).toEqual({ basis: 'unavailable' });
  });
  it('Codex preserves backticks in a command denied in stderr', () => {
    const read = recordedRead('s0-codex-fixer-1793173505', 'codex');
    const command = '/usr/bin/touch `echo /cusr/scratch/permission-denied-by-rule`';
    const stderr = read.stderr.replace(
      '/usr/bin/touch /cusr/scratch/permission-denied-by-rule',
      command,
    );
    expect(stderr).not.toBe(read.stderr);
    expect(codexAdapter.read({ ...read, stderr }).permission_denials).toContainEqual(
      expect.objectContaining({
        tool: 'exec_command',
        command,
        source: 'codex_stderr',
      }),
    );
  });

  it.each([
    ['the login shell', `/usr/bin/zsh -lc 'touch x'`, 'touch x'],
    ['another shell', `/bin/bash -c 'touch x'`, 'touch x'],
    ['a bare shell name', `sh -c 'touch x'`, 'touch x'],
    ['a command logged as it is', 'touch x', 'touch x'],
    [
      'a command with its own quotes, which stays as logged',
      `/bin/zsh -lc 'echo '"'"'a'"'"''`,
      `/bin/zsh -lc 'echo '"'"'a'"'"''`,
    ],
    ['something before the shell', `sudo sh -c 'touch x'`, `sudo sh -c 'touch x'`],
    ['a program that is not a shell', `/usr/bin/env -c 'touch x'`, `/usr/bin/env -c 'touch x'`],
  ])('Codex reports the command itself for %s', (_name, logged, command) => {
    const facts = codexAdapter.read({
      stdout: [],
      stderr: `codex_core::tools::router: error=Rejected("\`${logged}\` rejected: policy forbids it")`,
      truncated_records: 0,
    });
    expect(facts.permission_denials).toEqual([
      {
        tool: 'exec_command',
        command,
        message: 'policy forbids it',
        source: 'codex_stderr',
      },
    ]);
  });

  it('Claude leaves the command unknown when a refusal names no tool call it saw', () => {
    const facts = claudeAdapter.read({
      stdout: [
        {
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Bash',
          tool_use_id: 'unseen',
          message: 'Permission to use Bash with command x has been denied.',
        },
      ],
      stderr: '',
      truncated_records: 0,
    });
    expect(facts.permission_denials).toEqual([
      {
        tool: 'Bash',
        command: null,
        message: 'Permission to use Bash with command x has been denied.',
        source: 'claude_event',
      },
    ]);
  });
});
