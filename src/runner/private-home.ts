/**
 * Private harness home (contracts/execution.md "Sandbox và Git boundary", S0.2 `private_home_auth`).
 * Each agent attempt gets its own home under the run directory, mounted read-write at
 * `/cusr/home` inside the sandbox. Only the selected vendor's auth files are copied in, 0600, from
 * trusted credential references; the owner's real home and other vendors' auth never enter. Auth is
 * removed again once the attempt's artifacts are archived. Setup/gate/autofix never get a home.
 */
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RelativePathSchema, type CredentialRef } from '../domain/runtime.ts';
import type { RunDir } from './files.ts';
import { SandboxPolicyError } from './sandbox.ts';

export const PRIVATE_HOME_DIR = 'private-home';

/** One credential reference copied to a path relative to the private home, e.g. `.claude/.credentials.json`. */
export type AuthFile = { readonly ref: CredentialRef; readonly to: string };

export type InstalledAuth = { readonly home: string; readonly files: readonly string[] };

export function privateHome(run: RunDir): string {
  return run.ensureDir(PRIVATE_HOME_DIR);
}

/**
 * Copies the selected auth files into the private home. A source must be a regular file (no symlink)
 * and a target must stay inside the home. Fails closed before copying anything on a bad entry.
 */
export function installAuth(run: RunDir, files: readonly AuthFile[]): InstalledAuth {
  for (const f of files) {
    if (!RelativePathSchema.safeParse(f.to).success) throw new SandboxPolicyError('policy_violation', `auth target ${f.to} must stay inside the private home`);
    const st = lstatSync(f.ref.file, { throwIfNoEntry: false });
    if (st === undefined) throw new SandboxPolicyError('source_missing', `credential ${f.ref.name} is missing`);
    if (!st.isFile()) throw new SandboxPolicyError('policy_violation', `credential ${f.ref.name} must be a regular file (symlinks refused)`);
  }
  const home = privateHome(run);
  const installed: string[] = [];
  for (const f of files) {
    // RunDir.resolve refuses symlinked components below the run directory.
    const target = run.resolve(`${PRIVATE_HOME_DIR}/${f.to}`);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(f.ref.file, target, constants.COPYFILE_EXCL);
    chmodSync(target, 0o600);
    installed.push(f.to);
  }
  return { home, files: installed };
}

/** Removes every installed auth file; called after the attempt's artifacts are archived. */
export function removeAuth(installed: InstalledAuth): void {
  for (const rel of installed.files) rmSync(join(installed.home, rel), { force: true });
}
