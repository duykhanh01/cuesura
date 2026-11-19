import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexAdapter } from '../adapters/harness/codex.ts';
import { binaryPath, hostInnerMode, type VendorPin } from '../adapters/harness/vendor.ts';
import type { Role } from '../adapters/harness/result-schema.ts';
import { environmentHash } from '../application/capabilities.ts';
import type { CapabilityManifest } from '../domain/runtime.ts';
import type { Hash } from '../shared/brand.ts';
import { hostExecutionPath } from './sandbox.ts';

/** The sandbox profile a launch of `role` uses that the vendor can check without a model, or null. */
export function checkedProfile(
  pin: VendorPin,
  role: Exclude<Role, 'decider' | 'deputy'>,
): 'coder' | 'reviewer' | null {
  if (pin.vendor !== 'codex') return null;
  if (role === 'reviewer') return 'reviewer';
  return hostInnerMode(pin) === 'native' ? 'coder' : null;
}

/** Every profile setup checks: what workers use, and the read-only reviewer even under full access. */
export function checkedProfiles(pin: VendorPin): ('coder' | 'reviewer')[] {
  return [checkedProfile(pin, 'coder'), checkedProfile(pin, 'reviewer')].filter(
    (p): p is 'coder' | 'reviewer' => p !== null,
  );
}

/**
 * Runs the vendor's native sandbox on this host with no model: a harmless command must pass and a write
 * outside the worktree must be refused by the OS.
 */
export function nativeWriteRefused(
  pin: VendorPin,
  profile: 'coder' | 'reviewer',
  dataDir: string,
): boolean {
  // Under the data dir, not /tmp: a workspace sandbox may leave the system temp directory writable.
  const dir = join(dataDir, 'worktrees', `sandbox-check-${randomUUID()}`);
  const worktree = join(dir, 'worktree');
  const home = join(dir, 'home');
  const marker = join(dir, 'native-write-probe');
  try {
    mkdirSync(worktree, { recursive: true, mode: 0o700 });
    mkdirSync(home, { mode: 0o700 });
    // Positive control: this UID can write there outside the sandbox.
    writeFileSync(marker, '');
    rmSync(marker);
    return codexAdapter.nativeWriteDenied({
      role: profile,
      worktree,
      marker,
      stdout: [],
      runPinned: (argv) => {
        const r = spawnSync(binaryPath(pin), argv, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
          env: {
            ...pin.env,
            PATH: hostExecutionPath(pin.toolchain).join(':'),
            HOME: home,
            CODEX_HOME: home,
          },
        });
        return { status: r.status, output: `${r.stdout}${r.stderr}` };
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const verdicts = new Map<string, boolean>();

/**
 * The check for the bytes about to run: a verdict is reused only for the same binary digest, profile and
 * environment, so an upgraded CLI is checked again before its first launch.
 */
export function nativeCheck(
  pin: VendorPin,
  profile: 'coder' | 'reviewer',
  digest: Hash,
  dataDir: string,
): boolean {
  const key = `${binaryPath(pin)}|${digest}|${profile}|${environmentHash(pin)}`;
  const hit = verdicts.get(key);
  if (hit !== undefined) return hit;
  const refused = nativeWriteRefused(pin, profile, dataDir);
  // A failure may be passing (a timeout, a full disk): it is checked again on the next launch.
  if (refused) verdicts.set(key, refused);
  return refused;
}

/**
 * Why `profile` of the binary now at `digest` may not run, or null. Setup's verdict counts only for the
 * bytes it checked; an upgraded CLI is checked again before it runs.
 */
export function sandboxProblem(
  pin: VendorPin,
  manifest: Pick<CapabilityManifest, 'binary' | 'native_result'>,
  profile: 'coder' | 'reviewer',
  digest: Hash,
  dataDir: string,
  check: typeof nativeCheck = nativeCheck,
): string | null {
  const checkedAtSetup =
    profile === 'coder' && manifest.binary.digest === digest && manifest.native_result === 'passed';
  return checkedAtSetup || check(pin, profile, digest, dataDir)
    ? null
    : `${pin.vendor} ${profile === 'reviewer' ? 'read-only' : 'workspace'} sandbox of ${binaryPath(pin)} did not refuse a write outside the worktree; fix the sandbox (cusr doctor) or set up a working CLI with cusr-runner setup-harness --force`;
}
