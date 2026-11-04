import { afterEach, describe, expect, it } from 'vitest';
import { SeededDaemon, type TokenSpec } from '../../support/daemon-task.ts';
import { userConfig } from '../../support/preflight-fakes.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import { fakeGit, fakeGitHub, fakeHost } from '../../support/preflight-fakes.ts';

const TOKENS: TokenSpec[] = [
  { id: 'reader', actor: 'viewer', roles: ['read'], projects: ['acme'] },
  { id: 'none', actor: 'viewer', roles: ['read'], projects: ['elsewhere'] },
];

const running: SeededDaemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.cleanup();
});

async function daemon(
  extra?: ConstructorParameters<typeof SeededDaemon>[2],
): Promise<SeededDaemon> {
  const sd = new SeededDaemon(TOKENS, {}, extra);
  running.push(sd);
  await sd.start();
  return sd;
}

describe('project_list', () => {
  it('returns the caller, the projects and the profile names for the owner', async () => {
    const sd = await daemon();
    const r = await sd.query('owner', { kind: 'project_list' });
    expect(r.envelope.data).toEqual({
      caller: {
        actor: 'owner',
        roles: ['read', 'operate', 'admin'],
        scope: 'all',
        trusted_confirmer: true,
      },
      projects: [{ id: 'acme', repo: 'acme/app' }],
      profiles: expect.arrayContaining(['standard', 'heavy']) as string[],
    });
  });

  it('a limited token sees its projects, is marked limited and cannot confirm a run config', async () => {
    const sd = await daemon();
    const r = await sd.query('reader', { kind: 'project_list' });
    expect(r.envelope.data).toMatchObject({
      caller: {
        actor: 'viewer',
        roles: ['read'],
        scope: 'limited',
        trusted_confirmer: false,
      },
      projects: [{ id: 'acme', repo: 'acme/app' }],
    });
    const none = await sd.query('none', { kind: 'project_list' });
    expect(none.envelope.data).toMatchObject({ projects: [] });
  });

  it('never returns a token, a token path, credential references or tool paths', async () => {
    const user = userConfig({
      runtime:
        'runtime:\n  credential_refs: { gh: /secret/credential-file }\n  tool_paths: { git: /secret/tool/git }',
    });
    const sd = await daemon((store) => ({
      confirm: {
        store,
        ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
        configInputs: () => Promise.resolve({ user, packs: PACKS, manifests: {} }),
        now: () => 0,
      },
    }));
    const text = JSON.stringify((await sd.query('owner', { kind: 'project_list' })).envelope);
    expect(text).not.toContain('/secret/');
    expect(text).not.toContain(sd.tokens['owner']);
    expect(text).not.toContain('.token');
    expect(text).not.toContain('credential_refs');
  });

  it('an invalid user config is config_invalid, not an empty list', async () => {
    const sd = await daemon((store) => ({
      confirm: {
        store,
        ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
        configInputs: () =>
          Promise.resolve({
            user: { file: 'config.yaml', text: 'version: 99\n' },
            packs: PACKS,
            manifests: {},
          }),
        now: () => 0,
      },
    }));
    const r = await sd.query('owner', { kind: 'project_list' });
    expect(r.envelope.error).toMatchObject({ code: 'config_invalid' });
  });

  it('rejects an unknown field', async () => {
    const sd = await daemon();
    const r = await sd.query('owner', { kind: 'project_list', x: 1 });
    expect(r.envelope.error).toMatchObject({ code: 'invalid_request' });
  });
});
