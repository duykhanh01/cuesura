import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeAdapter } from '../../../src/adapters/harness/claude.ts';
import { codexAdapter } from '../../../src/adapters/harness/codex.ts';
import { wireRoleSchema } from '../../../src/adapters/harness/result-schema.ts';
import {
  hostInnerMode,
  type VendorPlanInput,
} from '../../../src/adapters/harness/vendor.ts';
import { HostExecutionProvider } from '../../../src/runner/sandbox.ts';
import { SpawnExecutor } from '../../../src/runner/commands.ts';
import { harnessSandboxTools } from '../../../src/runner/harness-records.ts';
import { vendorPin } from '../../support/harness-fixtures.ts';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
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
  it('uses native Claude sandbox when enabled, with host scratch paths', () => {
    const { plan, settings } = claude('auto', 'coder', true);
    expect(settings.permissions.defaultMode).toBe('auto');
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: expect.arrayContaining([
          '/host/scratch',
          '/host/home',
        ]) as string[],
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
      expect(on.settings.permissions.defaultMode).toBe(
        off.settings.permissions.defaultMode,
      );
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

  it('uses Codex automatic approval review with workspace-write and real host output paths', () => {
    const p = codexAdapter.plan(vendorPin('codex'), input('codex'));
    if (!p.ok) throw new Error(p.error.message);
    expect(p.value.argv.join(' ')).toContain('approval_policy="on-request"');
    expect(p.value.argv.join(' ')).toContain(
      'approvals_reviewer="auto_review"',
    );
    expect(p.value.argv.join(' ')).toContain(
      '--sandbox workspace-write --add-dir /host/scratch',
    );
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
        role === 'coder'
          ? '--sandbox danger-full-access'
          : '--sandbox read-only',
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

  it.each([
    'NPM_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'SSH_AUTH_SOCK',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'CUSR_TOKEN_FILE',
    'CUSR_ADMIN_TOKEN',
    'CUSR_OPERATE_TOKEN',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
    'invalid-name',
  ])('rejects pin environment variable %s for workers and reviewers', (key) => {
    for (const role of ['coder', 'reviewer'] as const) {
      const p = new HostExecutionProvider().plan(
        {
          role,
          worktree: tmpdir(),
          git_dirs: [],
          scratch: tmpdir(),
          private_home: tmpdir(),
          context: null,
          schema: null,
          toolchain: [],
          env: { [key]: 'must-not-pass' },
          network: 'internet_outbound',
        },
        ['/bin/true'],
      );
      expect(p).toMatchObject({
        ok: false,
        error: { code: 'policy_violation' },
      });
    }
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
    expect(plan.value.env).not.toHaveProperty('GH_TOKEN');
    expect(plan.value.env).not.toHaveProperty('CUSR_TOKEN_FILE');
    const r = await new SpawnExecutor().run(plan.value, {
      timeout_ms: 5_000,
      max_output_bytes: 4096,
    });
    expect(r).toMatchObject({ kind: 'exited', code: 0 });
  });
});
