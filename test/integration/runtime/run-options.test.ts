import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../../src/cli/output.ts';
import { buildTask } from '../../support/builders.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import {
  fakeGit,
  fakeGitHub,
  fakeHost,
  MANIFESTS,
  userConfig,
  type GitOpts,
} from '../../support/preflight-fakes.ts';
import { createGrantStart } from '../../support/runtime.ts';
import type { ConfigSource } from '../../../src/config/yaml-loader.ts';

const running: SeededDaemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.cleanup();
});

type Env = {
  git?: GitOpts & { baseMissing?: boolean; gitCalls?: string[][] };
  user?: ConfigSource;
};

function daemon(env: Env = {}): SeededDaemon {
  const sd: SeededDaemon = new SeededDaemon({}, (store) => {
    const git = fakeGit(env.git);
    return {
      confirm: {
        store,
        ports: {
          git: {
            run: (c) => {
              env.git?.gitCalls?.push([...c.args]);
              return env.git?.baseMissing === true && c.args[0] === 'rev-parse'
                ? Promise.resolve({
                    kind: 'exited',
                    code: 1,
                    stdout: '',
                    stderr: '',
                    truncated: false,
                  })
                : git.run(c);
            },
          },
          github: fakeGitHub(),
          host: fakeHost(),
        },
        configInputs: () =>
          Promise.resolve({
            user: env.user ?? userConfig(),
            packs: PACKS,
            manifests: MANIFESTS,
          }),
        now: () => 0,
      },
    };
  });
  running.push(sd);
  return sd;
}

type Options = {
  task_id: string;
  revision: number;
  version: number;
  profile: { id: string; source: string };
  modes: {
    mode: string;
    when_to_use: string | null;
    reviewers: { harness: string; model: string; effort: string }[];
    workers: {
      choice: { harness: string; model: string; effort: string };
      fallbacks: { harness: string; model: string; effort: string }[];
    }[];
  }[];
};

async function options(sd: SeededDaemon, task_id: string) {
  return sd.query('owner', { kind: 'run_options', task_id });
}

describe('run_options', () => {
  it('offers the bindings that start would accept, by mode', async () => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    const r = await options(sd, t.id);
    expect(r.code).toBe(ExitCode.ok);
    const data = r.envelope.data as unknown as Options;
    expect(data).toMatchObject({
      task_id: t.id,
      revision: 1,
      profile: { id: 'standard', source: 'project' },
    });
    expect(data.modes.map((m) => m.mode).sort()).toEqual(['direct-pr', 'full-review']);
    const full = data.modes.find((m) => m.mode === 'full-review');
    expect(full?.reviewers.map((c) => c.model)).toEqual(['sol']);
    expect(full?.workers.map((w) => w.choice.model)).toEqual(['sonnet']);
    const direct = data.modes.find((m) => m.mode === 'direct-pr');
    expect(direct?.reviewers).toEqual([]);
    expect(direct?.workers.map((w) => w.choice.model)).toEqual(['sonnet']);
    // `opus` is on the ladder but the `standard` profile does not allow that model.
    expect(full?.workers[0]?.fallbacks.map((f) => `${f.model}/${f.effort}`)).toEqual([
      expect.stringMatching(/^sonnet\/high$/),
    ]);
  });

  it('the profile of the task wins, and is reported as coming from the task', async () => {
    const sd = daemon();
    const t = buildTask({ profile: 'heavy' });
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    const data = (await options(sd, t.id)).envelope.data as unknown as Options;
    expect(data.profile).toEqual({ id: 'heavy', source: 'task' });
  });

  describe('binding `when` follows the task', () => {
    const models = async (size: 'L' | 'M', user?: ConfigSource) => {
      const sd = daemon(user === undefined ? {} : { user });
      const t = buildTask({ size, profile: 'heavy' });
      sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
      await sd.start();
      const data = (await options(sd, t.id)).envelope.data as unknown as Options;
      return data.modes.find((m) => m.mode === 'direct-pr')?.workers.map((w) => w.choice.model);
    };

    it('a coder binding the fixer does not share is not offered', async () => {
      // A large task's coder may take `opus`, but its fixer declares only `sonnet`.
      expect(await models('L')).toEqual(['sonnet']);
    });

    it('offers a binding only to the tasks its rule applies to', async () => {
      const base = userConfig();
      const user = {
        ...base,
        text: base.text.replace(
          'binding: [{ model: sonnet }]',
          'binding: [{ when: { size: [L, XL] }, model: opus }, { model: sonnet }]',
        ),
      };
      expect((await models('L', user))?.sort()).toEqual(['opus', 'sonnet']);
      expect(await models('M', user)).toEqual(['sonnet']);
    });
  });

  it('shows the declared guidance of a mode and leaves out a mode that is not allowed', async () => {
    const sd = daemon({
      user: userConfig({
        runtime: 'runtime:\n  modes:\n    direct-pr: { when_to_use: "small, low risk" }',
      }),
    });
    const t = buildTask();
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    const data = (await options(sd, t.id)).envelope.data as unknown as Options;
    expect(data.modes).toMatchObject([{ mode: 'direct-pr', when_to_use: 'small, low risk' }]);
  });

  it('reads the base from the local ref and never fetches', async () => {
    const gitCalls: string[][] = [];
    const sd = daemon({ git: { gitCalls } });
    const t = buildTask();
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    expect((await options(sd, t.id)).code).toBe(ExitCode.ok);
    expect(gitCalls.length).toBeGreaterThan(0);
    expect(gitCalls.some((c) => c[0] === 'fetch')).toBe(false);
    expect(gitCalls[0]?.join(' ')).toContain('refs/remotes/origin/main');
  });

  it('a base that cannot be read is options_unavailable, exit 1, with no guessed list', async () => {
    const sd = daemon({ git: { baseMissing: true } });
    const t = buildTask();
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    const r = await options(sd, t.id);
    expect(r.code).toBe(ExitCode.failure);
    expect(r.envelope.error).toMatchObject({ code: 'options_unavailable' });
    expect(r.envelope.data).toBeFalsy();
  });

  it('an invalid config is config_invalid, exit 1', async () => {
    const sd = daemon({ user: { file: 'config.yaml', text: 'version: 99\n' } });
    const t = buildTask();
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    const r = await options(sd, t.id);
    expect(r.code).toBe(ExitCode.failure);
    expect(r.envelope.error).toMatchObject({ code: 'config_invalid' });
  });

  it('no profile anywhere is config_invalid with how to set one', async () => {
    const sd = daemon({
      git: { cusr: 'version: 1\ngates: { build: "b", unit: "u" }\n' },
    });
    const t = buildTask();
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    const r = await options(sd, t.id);
    expect(r.envelope.error).toMatchObject({
      code: 'config_invalid',
      message: expect.stringContaining('profile') as string,
    });
  });

  it('a task that already started is a conflict, exit 6', async () => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => createGrantStart(d, t));
    await sd.start();
    const r = await options(sd, t.id);
    expect(r.code).toBe(ExitCode.conflict);
    expect(r.envelope.error).toMatchObject({ code: 'conflict' });
  });

  it('an unknown task is task_not_found, exit 4', async () => {
    const sd = daemon();
    await sd.start();
    const r = await options(sd, buildTask().id);
    expect(r.code).toBe(ExitCode.missing);
    expect(r.envelope.error).toMatchObject({ code: 'task_not_found' });
  });

  it('never returns credential references or tool paths', async () => {
    const sd = daemon({
      user: userConfig({
        runtime:
          'runtime:\n  credential_refs: { gh: /secret/credential-file }\n  tool_paths: { git: /secret/tool/git }',
      }),
    });
    const t = buildTask();
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    expect(JSON.stringify((await options(sd, t.id)).envelope)).not.toContain('/secret/');
  });

  it('changes nothing', async () => {
    const sd = daemon();
    const t = buildTask();
    const version = sd.seed((d) => {
      d.must(t.id, { kind: 'create_task', task: t });
      return d.task(t.id).version;
    });
    const running = await sd.start();
    await options(sd, t.id);
    expect(running.store.readTask(t.id as never)?.version).toBe(version);
  });
});
