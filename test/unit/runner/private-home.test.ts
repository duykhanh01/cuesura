import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunDir } from '../../../src/runner/files.ts';
import {
  USER_CONFIG_LINKS,
  copySession,
  installAuth,
  linkUserConfig,
  homeSecretValues,
  readInstalledAuth,
  removeAuth,
} from '../../../src/runner/private-home.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import { tempDir } from '../../support/runner-harness.ts';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fixture = () => ({ base: tempDir('cusr-home-', dirs) });

describe('refreshed login goes back to its source (#97)', () => {
  const login = (refresh: string) =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `access-${refresh}`,
        refreshToken: refresh,
        expiresAt: 1,
        scopes: ['user:inference'],
      },
    });
  const setup = (o: { pinned?: boolean } = {}) => {
    const { base } = fixture();
    const run = RunDir.open({
      dataDir: base,
      kind: 'runs',
      id: 'refresh',
      redactor: new Redactor(),
    });
    const source = join(base, 'credentials.json');
    writeFileSync(source, login('refresh-token-one-123456'), { mode: 0o600 });
    const pin =
      o.pinned === true
        ? {
            sha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
          }
        : {};
    const installed = installAuth(run, [
      {
        ref: { name: 'claude', file: source },
        to: '.claude/.credentials.json',
        ...pin,
      },
    ]);
    const copy = join(installed.home, '.claude/.credentials.json');
    return { base, source, installed, copy };
  };

  it('writes the refreshed copy back atomically, keeping the mode', () => {
    const { base, source, installed, copy } = setup();
    writeFileSync(copy, login('refresh-token-two-654321'));
    removeAuth(installed);
    expect(readFileSync(source, 'utf8')).toBe(login('refresh-token-two-654321'));
    expect(statSync(source).mode & 0o777).toBe(0o600);
    expect(readdirSync(base).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('leaves a source that changed since the copy: a new login wins', () => {
    const { source, installed, copy } = setup();
    writeFileSync(copy, login('refresh-token-two-654321'));
    writeFileSync(source, login('signed-in-again-000000'));
    removeAuth(installed);
    expect(readFileSync(source, 'utf8')).toBe(login('signed-in-again-000000'));
  });

  it.each([
    ['not JSON', 'garbage'],
    ['another shape', JSON.stringify({ apiKey: 'x' })],
  ])('never writes back a copy that is %s', (_name, content) => {
    const { source, installed, copy } = setup();
    writeFileSync(copy, content);
    removeAuth(installed);
    expect(readFileSync(source, 'utf8')).toBe(login('refresh-token-one-123456'));
  });

  it('never writes back a pinned file or through a symlinked copy', () => {
    const pinned = setup({ pinned: true });
    writeFileSync(pinned.copy, login('refresh-token-two-654321'));
    removeAuth(pinned.installed);
    expect(readFileSync(pinned.source, 'utf8')).toBe(login('refresh-token-one-123456'));

    const linked = setup();
    const elsewhere = join(linked.base, 'elsewhere.json');
    writeFileSync(elsewhere, login('refresh-token-two-654321'));
    rmSync(linked.copy);
    symlinkSync(elsewhere, linked.copy);
    removeAuth(linked.installed);
    expect(readFileSync(linked.source, 'utf8')).toBe(login('refresh-token-one-123456'));
  });
});

describe('private home auth', () => {
  it.each([0, 1024 * 1024 + 1])(
    'redacts only installed files, regardless of transcript size %i',
    (padding) => {
      const { base } = fixture();
      const run = RunDir.open({
        dataDir: base,
        kind: 'runs',
        id: 'selected-auth',
        redactor: new Redactor(),
      });
      const auth = join(base, 'auth.json');
      writeFileSync(auth, JSON.stringify({ accessToken: 'actual-secret-value-123456' }));
      const installed = installAuth(run, [
        {
          ref: { name: 'claude', file: auth },
          to: '.claude/.credentials.json',
        },
      ]);
      const ordinary = 'Ordinary summary and commit message';
      const session = '0192aaaa-0000-7000-8000-000000000001';
      run.ensureDir('private-home/.claude/projects/-worktree');
      writeFileSync(
        run.resolve('private-home/.claude/projects/-worktree/session.jsonl'),
        JSON.stringify({
          summary: ordinary,
          session_id: session,
          padding: 'x'.repeat(padding),
        }),
      );
      run.writeJson('launch-state.json', { auth: installed });
      expect(homeSecretValues(readInstalledAuth(run))).toEqual(homeSecretValues(installed));
      const redactor = new Redactor({ values: homeSecretValues(installed) });
      expect(redactor.text(`${ordinary} ${session}`)).toBe(`${ordinary} ${session}`);
      expect(redactor.text('actual-secret-value-123456')).toBe('[REDACTED]');
    },
  );

  it('carries only one session and its tool data; never auth, settings, or another session', () => {
    const { base } = fixture();
    const run = (id: string) =>
      RunDir.open({
        dataDir: base,
        kind: 'runs',
        id,
        redactor: new Redactor(),
      });
    const previous = run('first');
    const next = run('next');
    const id = '0192aaaa-0000-7000-8000-000000000001';
    const prefix = 'private-home/.claude/projects/-worktree';
    previous.writeText(`${prefix}/${id}.jsonl`, 'conversation\n');
    previous.writeText(`${prefix}/${id}/tool-results/one.txt`, 'result');
    previous.writeText(`${prefix}/other.jsonl`, 'another session');
    previous.writeText('private-home/.claude/.credentials.json', 'secret');
    previous.writeText('private-home/.claude/settings.json', 'settings');
    copySession(previous, next, id, 'claude');
    expect(readFileSync(next.resolve(`${prefix}/${id}.jsonl`), 'utf8')).toBe('conversation\n');
    expect(readFileSync(next.resolve(`${prefix}/${id}/tool-results/one.txt`), 'utf8')).toBe(
      'result',
    );
    for (const rel of [
      `${prefix}/other.jsonl`,
      'private-home/.claude/.credentials.json',
      'private-home/.claude/settings.json',
    ])
      expect(() => statSync(next.resolve(rel))).toThrow();
    expect(() => copySession(previous, run('bad'), '../escape', 'claude')).toThrow(/session ID/);
    const missing = '0192aaaa-0000-7000-8000-000000000002';
    expect(() => copySession(previous, run('missing'), missing, 'claude')).toThrow(/missing/);
    symlinkSync(join(base, 'outside'), previous.resolve(`${prefix}/${id}/link`));
    expect(() => copySession(previous, run('symlink'), id, 'claude')).toThrow(/non-regular/);
  });

  it('carries only the selected Codex rollout at its dated path; never auth or another thread', () => {
    const { base } = fixture();
    const run = (id: string) =>
      RunDir.open({
        dataDir: base,
        kind: 'runs',
        id,
        redactor: new Redactor(),
      });
    const previous = run('codex-first');
    const next = run('codex-next');
    const id = '01a1b7dd-6b52-7760-9e52-1f0d49d39970';
    const day = 'private-home/.codex/sessions/2026/11/08';
    const rollout = `${day}/rollout-2026-11-08T04-15-03-${id}.jsonl`;
    previous.writeText(rollout, 'thread\n');
    previous.writeText(
      `${day}/rollout-2026-11-08T04-16-00-01a1b7dd-0000-7000-8000-000000000009.jsonl`,
      'other',
    );
    previous.writeText('private-home/.codex/auth.json', 'secret');
    previous.writeText('private-home/.codex/state_5.sqlite', 'state');
    copySession(previous, next, id, 'codex');
    expect(readFileSync(next.resolve(rollout), 'utf8')).toBe('thread\n');
    expect(readdirSync(next.resolve(day))).toEqual([rollout.slice(day.length + 1)]);
    for (const rel of ['private-home/.codex/auth.json', 'private-home/.codex/state_5.sqlite'])
      expect(() => statSync(next.resolve(rel))).toThrow();
    expect(() => copySession(previous, run('codex-bad'), '-c', 'codex')).toThrow(/session ID/);
    expect(() =>
      copySession(previous, run('codex-missing'), '01a1b7dd-0000-7000-8000-000000000002', 'codex'),
    ).toThrow(/missing/);
    // A symlinked directory elsewhere in the tree is skipped, never followed.
    symlinkSync(join(base, 'outside'), previous.resolve('private-home/.codex/sessions/link'));
    copySession(previous, run('codex-again'), id, 'codex');
    const linked = '01a1b7dd-0000-7000-8000-000000000003';
    symlinkSync(join(base, 'outside'), previous.resolve(`${day}/rollout-x-${linked}.jsonl`));
    expect(() => copySession(previous, run('codex-symlink'), linked, 'codex')).toThrow(
      /non-regular/,
    );
  });

  it('copies only the selected credential files 0600 and removes them after archive', () => {
    const fx = fixture();
    const cred = join(fx.base, 'claude-credentials.json');
    writeFileSync(cred, '{"token":"secret-value"}');
    const run = RunDir.open({
      dataDir: join(fx.base, 'data'),
      kind: 'runs',
      id: 'at-1',
      redactor: new Redactor(),
    });
    const installed = installAuth(run, [
      { ref: { name: 'claude', file: cred }, to: '.claude/.credentials.json' },
    ]);
    const target = join(installed.home, '.claude/.credentials.json');
    expect(readFileSync(target, 'utf8')).toBe('{"token":"secret-value"}');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    removeAuth(installed);
    expect(() => statSync(target)).toThrow();
  });

  it('never follows a symlink the agent put in the home when removing auth', () => {
    const fx = fixture();
    const cred = join(fx.base, 'codex-auth.json');
    writeFileSync(cred, '{"token":"secret-value"}');
    const other = join(fx.base, 'claude-credentials.json');
    writeFileSync(other, '{"token":"other"}');
    const host = join(fx.base, 'host-codex');
    mkdirSync(host);
    const canary = join(host, 'auth.json');
    writeFileSync(canary, 'host credential');
    const run = RunDir.open({
      dataDir: join(fx.base, 'data'),
      kind: 'runs',
      id: 'at-3',
      redactor: new Redactor(),
    });
    const installed = installAuth(run, [
      { ref: { name: 'codex', file: cred }, to: '.codex/auth.json' },
      { ref: { name: 'claude', file: other }, to: '.claude/.credentials.json' },
    ]);
    // The agent swaps .codex/ for a symlink to a host directory.
    rmSync(join(installed.home, '.codex'), { recursive: true });
    symlinkSync(host, join(installed.home, '.codex'));
    expect(() => removeAuth(installed)).toThrow(/leave the private home/);
    expect(readFileSync(canary, 'utf8')).toBe('host credential');
    expect(() => statSync(join(installed.home, '.claude/.credentials.json'))).toThrow();
    // A leaf symlink is unlinked, its target kept.
    const leaf = installAuth(
      RunDir.open({
        dataDir: join(fx.base, 'data'),
        kind: 'runs',
        id: 'at-4',
        redactor: new Redactor(),
      }),
      [{ ref: { name: 'codex', file: cred }, to: 'auth.json' }],
    );
    rmSync(join(leaf.home, 'auth.json'));
    symlinkSync(canary, join(leaf.home, 'auth.json'));
    removeAuth(leaf);
    expect(readFileSync(canary, 'utf8')).toBe('host credential');
  });

  it('refuses symlinked credentials and targets outside the home before copying anything', () => {
    const fx = fixture();
    const real = join(fx.base, 'real.json');
    writeFileSync(real, '{}');
    const link = join(fx.base, 'link.json');
    symlinkSync(real, link);
    const run = RunDir.open({
      dataDir: join(fx.base, 'data'),
      kind: 'runs',
      id: 'at-2',
      redactor: new Redactor(),
    });
    expect(() =>
      installAuth(run, [
        { ref: { name: 'a', file: real }, to: 'ok.json' },
        { ref: { name: 'b', file: link }, to: 'b.json' },
      ]),
    ).toThrow(/symlinks refused/);
    expect(() =>
      installAuth(run, [{ ref: { name: 'a', file: real }, to: '../escape.json' }]),
    ).toThrow(/inside the private home/);
    expect(() => statSync(join(run.dir, 'private-home', 'ok.json'))).toThrow();
  });
});

describe('owner configuration in the private home', () => {
  it('links the owner harness config next to the auth, never over it, and keeps state private', () => {
    const { base } = fixture();
    const owner = join(base, 'owner');
    for (const rel of [
      '.claude/skills/write-pr',
      '.claude/projects',
      '.codex/skills',
      '.config/gh',
    ])
      mkdirSync(join(owner, rel), { recursive: true });
    for (const rel of ['.claude/settings.json', '.codex/config.toml', '.codex/auth.json'])
      writeFileSync(join(owner, rel), 'owner');
    writeFileSync(
      join(owner, '.claude.json'),
      JSON.stringify({
        oauthAccount: { id: 'owner' },
        mcpServers: { docs: { command: 'docs-mcp' } },
      }),
    );
    const run = RunDir.open({ dataDir: base, kind: 'runs', id: 'links', redactor: new Redactor() });
    const source = join(base, 'auth.json');
    writeFileSync(source, '{}', { mode: 0o600 });
    const installed = installAuth(run, [
      { ref: { name: 'codex', file: source }, to: '.codex/config.toml' },
    ]);

    const linked = linkUserConfig(installed.home, owner);
    expect(linked).toEqual([
      '.claude/settings.json',
      '.claude/skills',
      '.codex/skills',
      '.claude/.claude.json',
    ]);
    for (const rel of linked.filter((r) => (USER_CONFIG_LINKS as readonly string[]).includes(r)))
      expect(readlinkSync(join(installed.home, rel))).toBe(join(owner, rel));
    // Only the MCP servers come over; the owner's account and session state stay out.
    expect(JSON.parse(readFileSync(join(installed.home, '.claude/.claude.json'), 'utf8'))).toEqual({
      mcpServers: { docs: { command: 'docs-mcp' } },
    });
    // What cusr installed wins; the rest of the owner's home is reached through the real HOME.
    expect(lstatSync(join(installed.home, '.codex/config.toml')).isSymbolicLink()).toBe(false);
    expect(readdirSync(installed.home).sort()).toEqual(['.claude', '.codex']);
    expect(readdirSync(join(installed.home, '.codex')).sort()).toEqual(['config.toml', 'skills']);

    removeAuth(installed);
    expect(readFileSync(join(owner, '.claude/settings.json'), 'utf8')).toBe('owner');
  });
});
