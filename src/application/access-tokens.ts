import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthzRole } from '../domain/policy.ts';
import type { AccessTokenSpec } from '../config/schema-user.ts';
import { hashCanonical } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';

// Capability tokens (contracts/cli-daemon.md). Secrets stay in their files;
// the daemon keeps only a SHA-256 → grant map and never logs or snapshots a token.

export const OWNER_TOKEN_FILE = 'owner.token';
/** 32 random bytes, base64url without padding. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_TOKEN_FILE_BYTES = 256;

export type Grant = {
  id: string;
  actor: string;
  roles: AuthzRole[];
  /** `'*'` only for the owner bootstrap token. */
  projects: string[] | '*';
};

export type TokenMap = {
  byDigest: ReadonlyMap<string, Grant>;
  /** Startup audit: IDs, scopes and a short fingerprint, never the secret. */
  audit: {
    id: string;
    actor: string;
    roles: AuthzRole[];
    projects: string[] | '*';
    fingerprint: string;
  }[];
  config_hash: string;
};

export type TokenError =
  | { code: 'token_file_invalid'; id: string; reason: string }
  | { code: 'token_duplicate'; ids: [string, string] };

export function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Reads one token file: a regular file (no symlink), owned by this UID, not readable by group/other,
 * holding exactly one well-formed token.
 */
export function readTokenFile(path: string, id: string): Result<string, TokenError> {
  const bad = (reason: string): Result<string, TokenError> =>
    err({ code: 'token_file_invalid', id, reason });
  let fd: number;
  try {
    if (lstatSync(path).isSymbolicLink()) return bad('symlink');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    return bad((e as NodeJS.ErrnoException).code ?? 'unreadable');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return bad('not_regular_file');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid())
      return bad('foreign_owner');
    if ((st.mode & 0o077) !== 0) return bad('mode_too_open');
    if (st.size > MAX_TOKEN_FILE_BYTES) return bad('too_large');
    const buf = Buffer.alloc(MAX_TOKEN_FILE_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const token = buf.subarray(0, n).toString('utf8').trim();
    if (!TOKEN_RE.test(token)) return bad('malformed');
    return ok(token);
  } finally {
    closeSync(fd);
  }
}

/** Creates the owner bootstrap token once (O_EXCL, 0600). An existing file is kept as is. */
export function ensureOwnerToken(
  dataDir: string,
): Result<{ path: string; created: boolean }, TokenError> {
  const path = join(dataDir, OWNER_TOKEN_FILE);
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return ok({ path, created: false });
    return err({
      code: 'token_file_invalid',
      id: 'owner',
      reason: (e as NodeJS.ErrnoException).code ?? 'create_failed',
    });
  }
  try {
    writeSync(fd, `${randomBytes(32).toString('base64url')}\n`);
  } finally {
    closeSync(fd);
  }
  return ok({ path, created: true });
}

/**
 * Builds the in-memory token map from trusted user config plus the owner token. Grants change only via
 * config edit and daemon restart; two entries resolving to the same secret are refused.
 */
export function loadTokenMap(
  ownerTokenPath: string,
  specs: readonly AccessTokenSpec[],
): Result<TokenMap, TokenError> {
  const entries: { grant: Grant; token: string }[] = [];
  const owner = readTokenFile(ownerTokenPath, 'owner');
  if (!owner.ok) return owner;
  entries.push({
    grant: {
      id: 'owner',
      actor: 'owner',
      roles: ['read', 'operate', 'admin'],
      projects: '*',
    },
    token: owner.value,
  });
  for (const s of specs) {
    const t = readTokenFile(s.token_file, s.id);
    if (!t.ok) return t;
    entries.push({
      grant: {
        id: s.id,
        actor: s.actor,
        roles: [...s.roles],
        projects: [...s.projects],
      },
      token: t.value,
    });
  }
  const byDigest = new Map<string, Grant>();
  for (const { grant, token } of entries) {
    const d = tokenDigest(token);
    const prior = byDigest.get(d);
    if (prior !== undefined) return err({ code: 'token_duplicate', ids: [prior.id, grant.id] });
    byDigest.set(d, grant);
  }
  const audit = entries.map(({ grant, token }) => ({
    ...grant,
    fingerprint: tokenDigest(token).slice(0, 12),
  }));
  return ok({
    byDigest,
    audit,
    config_hash: hashCanonical(
      specs.map(({ id, actor, roles, projects, token_file }) => ({
        id,
        actor,
        roles,
        projects,
        token_file,
      })),
    ),
  });
}
