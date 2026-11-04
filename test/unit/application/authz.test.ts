import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ensureOwnerToken,
  loadTokenMap,
  readTokenFile,
} from '../../../src/application/access-tokens.ts';
import {
  authenticate,
  authorize,
  authzContext,
  visibleProjects,
} from '../../../src/application/authz.ts';
import { useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-authz-');

function tokenFile(dir: string, name: string, mode = 0o600): { path: string; token: string } {
  const token = randomBytes(32).toString('base64url');
  const path = join(dir, name);
  writeFileSync(path, `${token}\n`, { mode });
  chmodSync(path, mode);
  return { path, token };
}

function setup() {
  const dir = tempDir();
  const owner = ensureOwnerToken(dir);
  if (!owner.ok) throw new Error('owner token');
  const assistant = tokenFile(dir, 'assistant.token');
  const map = loadTokenMap(owner.value.path, [
    {
      id: 'assistant-work',
      actor: 'assistant',
      roles: ['read', 'operate'],
      projects: ['node-sandbox'],
      token_file: assistant.path,
    },
  ]);
  if (!map.ok) throw new Error(JSON.stringify(map.error));
  return {
    dir,
    owner: readFileSync(owner.value.path, 'utf8').trim(),
    assistant: assistant.token,
    map: map.value,
  };
}

describe('access tokens', () => {
  it('creates the owner token once with mode 0600 and keeps it on restart', () => {
    const dir = tempDir();
    const a = ensureOwnerToken(dir);
    expect(a).toMatchObject({ ok: true, value: { created: true } });
    if (!a.ok) return;
    expect(statSync(a.value.path).mode & 0o777).toBe(0o600);
    const first = readFileSync(a.value.path, 'utf8');
    expect(ensureOwnerToken(dir)).toMatchObject({
      ok: true,
      value: { created: false },
    });
    expect(readFileSync(a.value.path, 'utf8')).toBe(first);
  });

  it('refuses token files that are group-readable, symlinked or malformed', () => {
    const dir = tempDir();
    expect(readTokenFile(tokenFile(dir, 'open', 0o644).path, 'x')).toMatchObject({
      ok: false,
      error: { reason: 'mode_too_open' },
    });
    const good = tokenFile(dir, 'good');
    symlinkSync(good.path, join(dir, 'link'));
    expect(readTokenFile(join(dir, 'link'), 'x')).toMatchObject({
      ok: false,
      error: { reason: 'symlink' },
    });
    writeFileSync(join(dir, 'short'), 'abc\n', { mode: 0o600 });
    expect(readTokenFile(join(dir, 'short'), 'x')).toMatchObject({
      ok: false,
      error: { reason: 'malformed' },
    });
  });

  it('refuses two grants sharing one secret', () => {
    const dir = tempDir();
    const owner = ensureOwnerToken(dir);
    if (!owner.ok) throw new Error('owner');
    const r = loadTokenMap(owner.value.path, [
      {
        id: 'dup',
        actor: 'a',
        roles: ['read'],
        projects: ['p'],
        token_file: owner.value.path,
      },
    ]);
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'token_duplicate', ids: ['owner', 'dup'] },
    });
  });

  it('audit lists scopes and fingerprints but never a secret', () => {
    const { map, owner, assistant } = setup();
    const text = JSON.stringify(map.audit);
    expect(text).not.toContain(owner);
    expect(text).not.toContain(assistant);
    expect(map.audit.map((a) => a.id)).toEqual(['owner', 'assistant-work']);
  });
});

describe('server-side authorization', () => {
  it('identity comes from the token only', () => {
    const { map, assistant } = setup();
    expect(authenticate(map, 'not-a-token')).toBeNull();
    expect(authenticate(map, undefined)).toBeNull();
    const caller = authenticate(map, assistant);
    expect(caller?.grant).toMatchObject({
      id: 'assistant-work',
      actor: 'assistant',
    });
    expect(authzContext(caller as NonNullable<typeof caller>, 5)).toEqual({
      actor: 'assistant',
      roles: ['read', 'operate'],
      issued_by: 'token:assistant-work',
      issued_at: 5,
    });
  });

  it('assistant may operate in its projects but never admin or other projects', () => {
    const { map, assistant, owner } = setup();
    const a = authenticate(map, assistant);
    expect(authorize(a, { role: 'operate', project: 'node-sandbox' })).toEqual({
      ok: true,
    });
    expect(authorize(a, { role: 'admin', project: 'node-sandbox' })).toMatchObject({
      ok: false,
      error: { code: 'forbidden', reason: 'role' },
    });
    expect(authorize(a, { role: 'read', project: 'other' })).toMatchObject({
      ok: false,
      error: { code: 'forbidden', reason: 'project' },
    });
    expect(visibleProjects(a as NonNullable<typeof a>, ['other', 'node-sandbox'])).toEqual([
      'node-sandbox',
    ]);
    expect(authorize(authenticate(map, owner), { role: 'admin', project: 'other' })).toEqual({
      ok: true,
    });
    expect(authorize(null, { role: 'read' })).toMatchObject({
      ok: false,
      error: { code: 'unauthenticated' },
    });
  });
});
