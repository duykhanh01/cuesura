import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeAdapter } from '../../../src/adapters/harness/claude.ts';
import { codexAdapter } from '../../../src/adapters/harness/codex.ts';
import { wireRoleSchema } from '../../../src/adapters/harness/result-schema.ts';
import { hostInnerMode, type VendorPlanInput } from '../../../src/adapters/harness/vendor.ts';
import { HostExecutionProvider } from '../../../src/runner/sandbox.ts';
import { SpawnExecutor } from '../../../src/runner/commands.ts';
import { harnessSandboxTools } from '../../../src/runner/harness-records.ts';
import { attemptLayoutInputs } from '../../../src/runner/invocation.ts';
import { vendorPin } from '../../support/harness-fixtures.ts';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function input(
  vendor: 'claude' | 'codex',
  role: VendorPlanInput['role'] = 'coder',
): VendorPlanInput {
  return {
    role,
    model: 'configured-model',
    effort: null,
    cwd: '/host/worktree',
    paths: {
      home: '/host/home',
      scratch: '/host/scratch',
      context: '/host/context',
      schema: '/host/schema',
    },
    inner_mode: 'native',
    host_execution: true,
    session: null,
    schema: wireRoleSchema(role, { omit_meta_schema: vendor === 'claude' }),
  };
}

function claude(
  mode: 'auto' | 'full-access',
  role: VendorPlanInput['role'] = 'coder',
  sandbox: boolean | undefined = undefined,
) {
  const original = vendorPin('claude');
  const pin = {
    ...original,
    permission_mode: mode,
    settings: {
      ...original.settings,
      sandbox: { ...(sandbox === undefined ? {} : { enabled: sandbox }) },
    },
  };
  const p = claudeAdapter.plan(pin, {
    ...input('claude', role),
    inner_mode: hostInnerMode(pin),
  });
  if (!p.ok) throw new Error(p.error.message);
  return {
    plan: p.value,
    settings: JSON.parse(p.value.context_files[0]!.content) as {
      permissions: { defaultMode: string };
      sandbox: {
        enabled: boolean;
        failIfUnavailable: boolean;
        allowUnsandboxedCommands: boolean;
        filesystem?: { allowWrite: string[]; denyWrite?: string[] };
      };
    },
  };
}

describe('host execution with harness-owned permissions', () => {
  it.each([
    ['claude', undefined, 'cuesura'],
    ['claude', 'sdk-cli', 'cuesura'],
    ['codex', undefined, undefined],
    ['codex', 'custom', 'custom'],
  ] as const)(
    'passes the expected entrypoint to a %s process with pin value %s',
    async (vendor, entrypoint, expected) => {
      vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'sdk-cli');
      const dir = mkdtempSync(join(tmpdir(), 'cusr-entrypoint-'));
      dirs.push(dir);
      const pin = {
        ...vendorPin(vendor),
        env: entrypoint === undefined ? {} : { CLAUDE_CODE_ENTRYPOINT: entrypoint },
      };
      const plan = new HostExecutionProvider().plan(
        {
          role: 'coder',
          worktree: dir,
          git_dirs: [],
          scratch: dir,
          private_home: dir,
          context: null,
          schema: null,
          ...attemptLayoutInputs(pin, 'entrypoint-test'),
          network: 'internet_outbound',
        },
        [
          process.execPath,
          '-e',
          'process.stdout.write(JSON.stringify({entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT, attempt: process.env.CUSR_ATTEMPT_ID}))',
        ],
      );
      if (!plan.ok) throw new Error(plan.error.message);
      const result = await new SpawnExecutor().run(plan.value, {
        timeout_ms: 5_000,
        max_output_bytes: 4096,
      });
      expect(result).toMatchObject({
        kind: 'exited',
        code: 0,
        output: JSON.stringify({
          entrypoint: expected,
          attempt: 'entrypoint-test',
        }),
      });
    },
  );

  it.each([
    [null, 7, 7],
    [20, 7, 7],
    [3, 7, 3],
    [null, null, null],
  ] as const)('uses the stricter pin %s and role %s turn cap', (pinCap, roleCap, expected) => {
    const pin = { ...vendorPin('claude'), max_turns: pinCap };
    const p = claudeAdapter.plan(pin, {
      ...input('claude'),
      max_turns: roleCap,
    });
    if (!p.ok) throw new Error(p.error.message);
    const at = p.value.argv.indexOf('--max-turns');
    expect(at === -1 ? null : Number(p.value.argv[at + 1])).toBe(expected);
  });

  it.each(['coder', 'fixer', 'reviewer'] as const)('keeps %s session persistence on', (role) => {
    const p = claudeAdapter.plan(vendorPin('claude'), input('claude', role));
    if (!p.ok) throw new Error(p.error.message);
    expect(p.value.argv).not.toContain('--no-session-persistence');
  });

  it('uses native Claude sandbox when enabled, with host scratch paths', () => {
    const { plan, settings } = claude('auto', 'coder', true);
    expect(settings.permissions.defaultMode).toBe('auto');
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: expect.arrayContaining(['/host/scratch', '/host/home']) as string[],
      },
    });
    expect(plan.argv).toContain('/host/context/claude-settings.json');
    const original = vendorPin('claude');
    const changed = claudeAdapter.plan(
      {
        ...original,
        settings: { ...original.settings, sandbox: { enabled: true } },
      },
      {
        ...input('claude'),
        cwd: '/other/worktree',
        paths: { ...input('claude').paths, scratch: '/other/scratch' },
      },
    );
    expect(changed.ok && changed.value.settings_hash).toBe(plan.settings_hash);
  });

  it.each(['auto', 'full-access'] as const)(
    'keeps %s permissions independent from the Claude sandbox toggle',
    (mode) => {
      const off = claude(mode);
      const on = claude(mode, 'coder', true);
      expect(off.settings.permissions.defaultMode).toBe(
        mode === 'auto' ? 'auto' : 'bypassPermissions',
      );
      expect(on.settings.permissions.defaultMode).toBe(off.settings.permissions.defaultMode);
      expect(off.settings.sandbox.enabled).toBe(false);
      expect(off.settings.sandbox.failIfUnavailable).toBe(false);
      expect(on.settings.sandbox.enabled).toBe(true);
      expect(on.settings.sandbox.failIfUnavailable).toBe(true);
      expect(off.plan.settings_hash).not.toBe(on.plan.settings_hash);
      expect(claude(mode, 'reviewer').settings.sandbox.enabled).toBe(true);
    },
  );

  it('preserves owner-configured native filesystem rules when adding scratch access', () => {
    const pin = vendorPin('claude');
    const base = pin.settings as Record<string, unknown>;
    const p = claudeAdapter.plan(
      {
        ...pin,
        settings: {
          ...base,
          sandbox: {
            ...(base['sandbox'] as Record<string, unknown>),
            filesystem: {
              allowWrite: ['/shared/cache'],
              denyWrite: ['/protected'],
            },
          },
        },
      },
      input('claude', 'reviewer'),
    );
    if (!p.ok) throw new Error(p.error.message);
    expect(JSON.parse(p.value.context_files[0]!.content)).toMatchObject({
      sandbox: {
        filesystem: {
          allowWrite: ['/shared/cache', '/host/home', '/host/scratch'],
          denyWrite: ['/protected', '/host/worktree'],
        },
      },
    });
  });

  it('lets native Claude workers create Unix sockets unless the settings turn it off', () => {
    const pin = vendorPin('claude');
    const base = pin.settings as Record<string, unknown>;
    const sandboxOf = (network?: Record<string, unknown>) => {
      const p = claudeAdapter.plan(
        {
          ...pin,
          settings: {
            ...base,
            sandbox: {
              ...(base['sandbox'] as Record<string, unknown>),
              ...(network === undefined ? {} : { network }),
            },
          },
        },
        input('claude', 'coder'),
      );
      if (!p.ok) throw new Error(p.error.message);
      return (
        JSON.parse(p.value.context_files[0]!.content) as {
          sandbox: { network?: Record<string, unknown> };
        }
      ).sandbox;
    };
    expect(sandboxOf().network).toEqual({ allowAllUnixSockets: true });
    expect(
      sandboxOf({ allowedDomains: ['example.com'], allowAllUnixSockets: false }).network,
    ).toEqual({ allowedDomains: ['example.com'], allowAllUnixSockets: false });
  });

  it('uses Codex automatic approval review with workspace-write and real host output paths', () => {
    const p = codexAdapter.plan(vendorPin('codex'), input('codex'));
    if (!p.ok) throw new Error(p.error.message);
    expect(p.value.argv.join(' ')).toContain('approval_policy="on-request"');
    expect(p.value.argv.join(' ')).toContain('approvals_reviewer="auto_review"');
    expect(p.value.argv.join(' ')).toContain('--sandbox workspace-write --add-dir /host/scratch');
    expect(p.value.argv).toContain('/host/scratch/final-response.json');
  });

  it('keeps full-access permission selection explicit and reviewers read-only', () => {
    expect(
      harnessSandboxTools({
        ...vendorPin('claude'),
        permission_mode: 'full-access',
      }).requires,
    ).toEqual(['bwrap', 'socat']);
    const { settings } = claude('full-access');
    expect(settings.permissions.defaultMode).toBe('bypassPermissions');
    expect(settings.sandbox.enabled).toBe(false);
    expect(claude('full-access', 'reviewer').settings.sandbox).toMatchObject({
      enabled: true,
      filesystem: { denyWrite: ['/host/worktree'] },
    });
    for (const role of ['coder', 'reviewer'] as const) {
      const p = codexAdapter.plan(
        { ...vendorPin('codex'), permission_mode: 'full-access' },
        { ...input('codex', role), inner_mode: 'full_access' },
      );
      if (!p.ok) throw new Error(p.error.message);
      expect(p.value.argv.join(' ')).toContain(
        role === 'coder' ? '--sandbox danger-full-access' : '--sandbox read-only',
      );
    }
  });

  it('never accepts the former external_verified fallback on host', () => {
    for (const vendor of ['claude', 'codex'] as const) {
      const adapter = vendor === 'claude' ? claudeAdapter : codexAdapter;
      expect(
        adapter.plan(vendorPin(vendor), {
          ...input(vendor),
          inner_mode: 'external_verified',
        }).ok,
      ).toBe(false);
    }
  });

  const plan = (env: Record<string, string>) =>
    new HostExecutionProvider().plan(
      {
        role: 'coder',
        worktree: tmpdir(),
        git_dirs: [],
        scratch: tmpdir(),
        private_home: join(tmpdir(), 'home'),
        context: null,
        schema: null,
        toolchain: [],
        env,
        network: 'internet_outbound',
      },
      ['/bin/true'],
    );

  it.each(['CUSR_TOKEN_FILE', 'CUSR_ADMIN_TOKEN', 'CUSR_OPERATE_TOKEN', 'invalid-name'])(
    'rejects pin environment variable %s',
    (key) => {
      expect(plan({ [key]: 'must-not-pass' })).toMatchObject({
        ok: false,
        error: { code: 'policy_violation' },
      });
    },
  );

  it('passes what a pin sets, secrets included, as a shell the owner opened would have it', () => {
    const env = {
      GH_TOKEN: 'gh',
      GITHUB_TOKEN: 'gh',
      NPM_TOKEN: 'npm',
      OPENAI_API_KEY: 'key',
      SSH_AUTH_SOCK: '/run/ssh.sock',
      GH_HOST: 'github.com',
    };
    const p = plan(env);
    expect(p.ok && p.value.env).toMatchObject(env);
  });

  it('keeps the real HOME and points only the harness config dirs into the private home', () => {
    vi.stubEnv('CUSR_ACTOR', 'assistant');
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('SOME_TOOL_HOME', '/opt/tool');
    const p = plan({});
    if (!p.ok) throw new Error(p.error.message);
    expect(p.value.env).toMatchObject({
      HOME: homedir(),
      CLAUDE_CONFIG_DIR: join(tmpdir(), 'home', '.claude'),
      CODEX_HOME: join(tmpdir(), 'home', '.codex'),
      SOME_TOOL_HOME: '/opt/tool',
    });
    expect(p.value.env).not.toHaveProperty('CUSR_ACTOR');
    expect(p.value.env).not.toHaveProperty('CLAUDECODE');
  });

  it('runs host commands and Unix sockets without an outer bwrap launcher', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cusr-native-'));
    dirs.push(dir);
    const home = join(dir, 'home');
    mkdirSync(home);
    const socket = join(dir, 'daemon.sock');
    vi.stubEnv('GH_TOKEN', 'redact-me');
    vi.stubEnv('CUSR_TOKEN_FILE', '/secret');
    const plan = new HostExecutionProvider().plan(
      {
        role: 'gate',
        worktree: dir,
        git_dirs: [],
        scratch: dir,
        private_home: home,
        context: null,
        schema: null,
        toolchain: [],
        env: {},
        network: 'internet_outbound',
      },
      [
        process.execPath,
        '-e',
        'const s=require("node:net").createServer();s.listen(process.argv[1],()=>s.close())',
        socket,
      ],
    );
    if (!plan.ok) throw new Error(plan.error.message);
    expect(plan.value.argv[0]).toBe(process.execPath);
    expect(plan.value).toMatchObject({
      provider: 'host',
      isolation_mode: 'native',
      mount_sources: [],
      proof_refs: [],
    });
    expect(plan.value.env).toHaveProperty('GH_TOKEN', 'redact-me');
    expect(plan.value.env).not.toHaveProperty('CUSR_TOKEN_FILE');
    const r = await new SpawnExecutor().run(plan.value, {
      timeout_ms: 5_000,
      max_output_bytes: 4096,
    });
    expect(r).toMatchObject({ kind: 'exited', code: 0 });
  });
});
