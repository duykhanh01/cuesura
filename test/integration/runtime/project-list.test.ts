import { afterEach, describe, expect, it } from 'vitest';
import { SeededDaemon } from '../../support/daemon-task.ts';
import { userConfig } from '../../support/preflight-fakes.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import { fakeGit, fakeGitHub, fakeHost } from '../../support/preflight-fakes.ts';

const running: SeededDaemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.cleanup();
});

async function daemon(
  extra?: ConstructorParameters<typeof SeededDaemon>[1],
): Promise<SeededDaemon> {
  const sd = new SeededDaemon({}, extra);
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
        trusted_confirmer: true,
      },
      projects: [{ id: 'acme', repo: 'acme/app' }],
      profiles: expect.arrayContaining(['standard', 'heavy']) as string[],
    });
  });

  it('an assistant sees every project and may confirm a run config, but holds no admin', async () => {
    const sd = await daemon();
    const r = await sd.query('assistant', { kind: 'project_list' });
    expect(r.envelope.data).toMatchObject({
      caller: {
        actor: 'assistant',
        roles: ['read', 'operate'],
        trusted_confirmer: true,
      },
      projects: [{ id: 'acme', repo: 'acme/app' }],
    });
  });

  it('never returns credential references or tool paths', async () => {
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
