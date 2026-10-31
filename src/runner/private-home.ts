/**
 * Private harness home (contracts/execution.md, S0.2 `private_home_auth`).
 * Each agent attempt gets its own home under the run directory, mounted read-write at
 * `/cusr/home` inside the sandbox. Only the selected vendor's auth files are copied in, 0600, from
 * trusted credential references; the owner's real home and other vendors' auth never enter. Auth is
 * removed again once the attempt's artifacts are archived. Setup/gate/autofix never get a home.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { RelativePathSchema, type CredentialRef } from '../domain/runtime.ts';
import type { RunDir } from './files.ts';
import { secretValuesFromText } from './redact.ts';
import { SandboxPolicyError } from './sandbox.ts';

export const PRIVATE_HOME_DIR = 'private-home';

/**
 * One credential reference copied to a path relative to the private home, e.g. `.claude/.credentials.json`.
 * `sha256`, when set, is the content the pin was confirmed with; a copy with other content is refused.
 */
export type AuthFile = {
  readonly ref: CredentialRef;
  readonly to: string;
  readonly sha256?: string;
};

export type InstalledAuth = {
  readonly home: string;
  readonly files: readonly string[];
};

export function privateHome(run: RunDir): string {
  return run.ensureDir(PRIVATE_HOME_DIR);
}

/**
 * Copies the selected auth files into the private home. A source must be a regular file (no symlink)
 * and a target must stay inside the home. Fails closed before copying anything on a bad entry.
 */
export function installAuth(
  run: RunDir,
  files: readonly AuthFile[],
): InstalledAuth {
  for (const f of files) {
    if (!RelativePathSchema.safeParse(f.to).success)
      throw new SandboxPolicyError(
        'policy_violation',
        `auth target ${f.to} must stay inside the private home`,
      );
    const st = lstatSync(f.ref.file, { throwIfNoEntry: false });
    if (st === undefined)
      throw new SandboxPolicyError(
        'source_missing',
        `credential ${f.ref.name} is missing`,
      );
    if (!st.isFile())
      throw new SandboxPolicyError(
        'policy_violation',
        `credential ${f.ref.name} must be a regular file (symlinks refused)`,
      );
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
    // Checked on the copy the binary will read, so a source edited after confirmation never runs.
    if (
      f.sha256 !== undefined &&
      createHash('sha256').update(readFileSync(target)).digest('hex') !==
        f.sha256
    ) {
      removeAuth({ home, files: installed });
      throw new SandboxPolicyError(
        'policy_violation',
        `${f.to} differs from its pinned sha256`,
      );
    }
  }
  return { home, files: installed };
}

/**
 * Removes every installed auth file; called after the attempt's artifacts are archived. The agent had
 * the home read-write, so every component is re-checked with lstat: a directory swapped for a symlink
 * is refused (and nothing is followed out of the home), and a leaf symlink is unlinked, never its target.
 */
export function removeAuth(installed: InstalledAuth): void {
  const home = lstatSync(installed.home, { throwIfNoEntry: false });
  if (home === undefined) return;
  if (!home.isDirectory())
    throw new SandboxPolicyError(
      'policy_violation',
      `private home ${installed.home} is no longer a directory`,
    );
  const escaped: string[] = [];
  next: for (const rel of installed.files) {
    const parts = rel.split('/');
    let dir = installed.home;
    for (const part of parts.slice(0, -1)) {
      dir = join(dir, part);
      const st = lstatSync(dir, { throwIfNoEntry: false });
      if (st === undefined) continue next;
      if (!st.isDirectory()) {
        escaped.push(rel);
        continue next;
      }
    }
    const target = join(dir, parts[parts.length - 1] as string);
    // rmSync unlinks a symlink itself, never its target, and refuses a directory without `recursive`.
    if (lstatSync(target, { throwIfNoEntry: false }) !== undefined)
      rmSync(target, { force: true });
  }
  // The other files are already removed; the swapped paths were left untouched on purpose.
  if (escaped.length > 0)
    throw new SandboxPolicyError(
      'policy_violation',
      `auth paths leave the private home through a symlink: ${escaped.join(', ')}`,
    );
}

/**
 * A private home must start empty: anything already there (a previous attempt's auth, a planted
 * config, hooks or plugins) would run with this attempt. Refuses a non-empty or non-directory home.
 */
export function assertFreshHome(run: RunDir): string {
  const home = privateHome(run);
  const st = lstatSync(home);
  if (!st.isDirectory() || st.isSymbolicLink())
    throw new SandboxPolicyError(
      'policy_violation',
      `private home ${home} is not a plain directory`,
    );
  const entries = readdirSync(home);
  if (entries.length > 0)
    throw new SandboxPolicyError(
      'policy_violation',
      `private home is not empty: ${entries.slice(0, 5).join(', ')}`,
    );
  return home;
}

/**
 * Literal secret values of every file in the private home (the installed auth), so the runner's
 * redactor masks them in output even when a vendor prints them. Symlinks are not followed.
 */
export function homeSecretValues(home: string, depth = 0): string[] {
  if (depth > 4) return [];
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const p = join(home, n);
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (st === undefined || st.isSymbolicLink()) return [];
    if (st.isDirectory()) return homeSecretValues(p, depth + 1);
    if (!st.isFile() || st.size > 1024 * 1024) return [];
    return secretValuesFromText(readFileSync(p, 'utf8'));
  });
}
