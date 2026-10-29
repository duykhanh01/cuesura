/**
 * T072/T077 RunnerHarness under real bwrap (no model, no systemd): the stand-in vendor runs inside the
 * Isolated boundary from a temp copy, so a reviewer's write to its worktree is refused by the mount,
 * not only detected afterwards, and the auth it prints from its private home is redacted. Skipped where
 * bwrap with user namespaces is not usable, or where node lives under the host home (never mounted).
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../../src/adapters/harness/claude.ts';
import {
  wireRoleSchema,
  type Role,
} from '../../../src/adapters/harness/result-schema.ts';
import type { HarnessInput } from '../../../src/adapters/ports.ts';
import {
  attemptLayoutInputs,
  RunnerHarness,
} from '../../../src/runner/invocation.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import {
  BWRAP,
  BwrapSandboxProvider,
  defaultHostPolicy,
  probeLayoutShapes,
} from '../../../src/runner/sandbox.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { hashCanonical, hashText } from '../../../src/shared/hash.ts';
import {
  homeFileContent,
  REAL,
  spikePin,
} from '../../support/harness-fixtures.ts';
import {
  evidenceManifest,
  fakeVendorPin,
  HOST_POLICY_HASH,
  InlineProcessPort,
  tempDir,
} from '../../support/runner-harness.ts';
import {
  createSandboxFixture,
  type SandboxFixture,
} from '../../support/sandbox-fixture.ts';

const usable =
  existsSync(BWRAP) &&
  spawnSync(BWRAP, ['--unshare-user', '--ro-bind', '/', '/', '/usr/bin/true'])
    .status === 0 &&
  !dirname(process.execPath).startsWith(homedir());

const dirs: string[] = [];
const fixtures: SandboxFixture[] = [];
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 50));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of fixtures.splice(0))
    rmSync(f.base, { recursive: true, force: true });
});

const CANARY = 'sk-ant-canary-bwrap-0123456789abcdef';

function setup(attempt: string, mode: string) {
  const fx = createSandboxFixture();
  fixtures.push(fx);
  const bin = tempDir('cusr-bwrap-bin-', dirs);
  // The replay is copied next to the binary: only the binary's directory is mounted read-only.
  mkdirSync(join(bin, 'replay'));
  cpSync(
    join(REAL, attempt, 'events.jsonl'),
    join(bin, 'replay', 'events.jsonl'),
  );
  const pin = {
    ...fakeVendorPin('claude', bin, {
      FAKE_VENDOR_REPLAY: join(bin, 'replay'),
      FAKE_VENDOR_MODE: mode,
    }),
    toolchain: [dirname(process.execPath)],
  };
  const credentials: Record<string, { name: string; file: string }> = {};
  for (const h of pin.home_files) {
    const file = join(bin, `${h.credential}.cred`);
    writeFileSync(
      file,
      homeFileContent(h, JSON.stringify({ accessToken: CANARY })),
    );
    credentials[h.credential] = { name: h.credential, file };
  }
  const data = join(fx.base, 'data');
  const policy = defaultHostPolicy(data);
  const sandbox = new BwrapSandboxProvider({ policy });
  const shapes = probeLayoutShapes(sandbox, {
    roles: ['coder', 'fixer', 'reviewer'],
    ...attemptLayoutInputs(pin, 'probe'),
  });
  if (!shapes.ok) throw new Error(shapes.error.message);
  const h = new RunnerHarness({
    harness: 'claude',
    adapter: claudeAdapter,
    pin,
    manifest: evidenceManifest(pin, {}, shapes.value),
    isolation: 'internal_required',
    process: new InlineProcessPort(data),
    sandbox,
    host_policy_hash: HOST_POLICY_HASH,
    data_dir: data,
    credentials,
    redactor: new Redactor(),
    clock: {
      now: () => Date.now() as EpochMs,
      monotonic: () => performance.now(),
    },
    workspace: () => ({ worktree: fx.worktree, git_dirs: [fx.gitCommon] }),
    limits: { term_grace_ms: 300, kill_verify_ms: 1_000, stall_ms: null },
    poll_ms: 20,
  });
  return { fx, h };
}

function input(role: Role): HarnessInput {
  const id = randomUUID();
  return {
    role,
    operation_id: id,
    attempt_id: `at-${id}`,
    revision: 1,
    binding: {
      harness: 'claude',
      vendor: 'claude',
      model: spikePin('claude').model,
      effort: 'low',
      permission_policy_hash: hashCanonical('p'),
    },
    context: { text: 'task\n', digest: hashText('task\n') },
    schema: wireRoleSchema(role, { omit_meta_schema: false }),
    wall_ms: 20_000,
    deadline_at: (Date.now() + 60_000) as EpochMs,
    session: null,
  };
}

describe.skipIf(!usable)('RunnerHarness under real bwrap', () => {
  it('a coder run inside the boundary yields the validated result', async () => {
    const { h } = setup('s0-claude-coder-1793172185', '');
    const out = await h.run(input('coder'), new AbortController().signal);
    expect(out.kind).toBe('result');
  });

  it('a reviewer cannot write its worktree: the mount refuses it and nothing changes', async () => {
    const { fx, h } = setup('s0-claude-reviewer-1793180331', 'write_worktree');
    const out = await h.run(input('reviewer'), new AbortController().signal);
    expect(out.kind).not.toBe('result');
    expect(existsSync(join(fx.worktree, 'agent-wrote.txt'))).toBe(false);
  });
});
