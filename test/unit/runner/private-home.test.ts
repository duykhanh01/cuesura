import {
  mkdirSync,
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
  copySession,
  installAuth,
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
      writeFileSync(
        auth,
        JSON.stringify({ accessToken: 'actual-secret-value-123456' }),
      );
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
      expect(homeSecretValues(readInstalledAuth(run))).toEqual(
        homeSecretValues(installed),
      );
      const redactor = new Redactor({ values: homeSecretValues(installed) });
      expect(redactor.text(`${ordinary} ${session}`)).toBe(
        `${ordinary} ${session}`,
      );
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
    copySession(previous, next, id);
    expect(readFileSync(next.resolve(`${prefix}/${id}.jsonl`), 'utf8')).toBe(
      'conversation\n',
    );
    expect(
      readFileSync(
        next.resolve(`${prefix}/${id}/tool-results/one.txt`),
        'utf8',
      ),
    ).toBe('result');
    for (const rel of [
      `${prefix}/other.jsonl`,
      'private-home/.claude/.credentials.json',
      'private-home/.claude/settings.json',
    ])
      expect(() => statSync(next.resolve(rel))).toThrow();
    expect(() => copySession(previous, run('bad'), '../escape')).toThrow(
      /session ID/,
    );
    const missing = '0192aaaa-0000-7000-8000-000000000002';
    expect(() => copySession(previous, run('missing'), missing)).toThrow(
      /missing/,
    );
    symlinkSync(
      join(base, 'outside'),
      previous.resolve(`${prefix}/${id}/link`),
    );
    expect(() => copySession(previous, run('symlink'), id)).toThrow(
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
    expect(() =>
      statSync(join(installed.home, '.claude/.credentials.json')),
    ).toThrow();
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
      installAuth(run, [
        { ref: { name: 'a', file: real }, to: '../escape.json' },
      ]),
    ).toThrow(/inside the private home/);
    expect(() => statSync(join(run.dir, 'private-home', 'ok.json'))).toThrow();
  });
});
