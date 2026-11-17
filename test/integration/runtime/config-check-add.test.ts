import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../../src/cli/output.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import {
  fakeGit,
  fakeGitHub,
  fakeHost,
  MANIFESTS,
  SHA,
  userConfig,
} from '../../support/preflight-fakes.ts';
import type { ConfigSource } from '../../../src/config/yaml-loader.ts';

// #311: `task add` checks what `task options` checks; #315: every problem in one report, with fixes.

const live: SeededDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.cleanup();
});

type Env = { user?: ConfigSource; baseMissing?: boolean; inputsFail?: boolean };

async function daemon(cusr?: string | null, env: Env = {}): Promise<SeededDaemon> {
  const sd = new SeededDaemon({}, (store) => {
    const git = fakeGit(cusr === undefined ? {} : { cusr });
    return {
      confirm: {
        store,
        ports: {
          git: {
            run: (c) =>
              env.baseMissing === true && c.args[0] === 'rev-parse'
                ? Promise.resolve({
                    kind: 'exited',
                    code: 1,
                    stdout: '',
                    stderr: '',
                    truncated: false,
                  })
                : git.run(c),
          },
          github: fakeGitHub(),
          host: fakeHost(),
        },
        configInputs: () =>
          env.inputsFail === true
            ? Promise.reject(new Error('config file unreadable'))
            : Promise.resolve({
                user: env.user ?? userConfig(),
                packs: PACKS,
                manifests: MANIFESTS,
              }),
        now: () => 0,
      },
    };
  });
  live.push(sd);
  await sd.start();
  return sd;
}

let request = 0;
const requestId = () => `0192cccc-0000-7000-8000-${String(++request).padStart(12, '0')}`;

function add(sd: SeededDaemon, runConfig?: unknown) {
  return sd.command('assistant', {
    request_id: requestId(),
    kind: 'task_add',
    project: 'acme',
    task_id: null,
    expected_version: null,
    payload: {
      task: { title: 'T', base_branch: 'main', acceptance: ['works'] },
      ...(runConfig === undefined ? {} : { run_config: runConfig }),
    },
  });
}

type Check = { name: string; status: string; detail: string; fix: string | null };
type Warning = { code: string; message: string; checks: Check[]; base: unknown };
const result = (r: Awaited<ReturnType<typeof add>>) =>
  r.envelope.data?.['result'] as { task_id: string; config_warning?: Warning };
const checksOf = (r: Awaited<ReturnType<typeof add>>) =>
  (r.envelope.error?.details as { checks: Check[] }).checks;
const names = (checks: Check[]) => checks.map((c) => c.name).sort();

const NO_PROFILE_NO_GATES = 'version: 1\n';
const PROFILE_NO_GATES = 'version: 1\nprofile: standard\nci: { required_checks: [build] }\n';

describe('task add checks the project config (#311, #315)', () => {
  it('a project without profile and gates is added with every problem and its fix', async () => {
    const sd = await daemon(NO_PROFILE_NO_GATES);
    const r = await add(sd);
    expect(r.code).toBe(ExitCode.ok);
    const w = result(r).config_warning;
    expect(w).toMatchObject({
      code: 'config_invalid',
      base: { ref: 'origin/main', sha: SHA },
    });
    expect(names(w?.checks ?? [])).toEqual(['no_gates_not_allowed', 'profile', 'required_checks']);
    for (const c of w?.checks ?? []) expect(c.fix).toEqual(expect.any(String));
  });

  it('a project with a profile but no gate is warned about the gate', async () => {
    const sd = await daemon(PROFILE_NO_GATES);
    const w = result(await add(sd)).config_warning;
    expect(w?.checks).toEqual([
      expect.objectContaining({
        name: 'no_gates_not_allowed',
        fix: expect.stringContaining('gates:') as string,
      }),
    ]);
  });

  it('task options refuses with the same list', async () => {
    const sd = await daemon(NO_PROFILE_NO_GATES);
    const added = result(await add(sd));
    const r = await sd.query('owner', { kind: 'run_options', task_id: added.task_id });
    expect(r.code).toBe(ExitCode.failure);
    expect(r.envelope.error?.code).toBe('config_invalid');
    expect(names(checksOf(r))).toEqual(names(added.config_warning?.checks ?? []));
  });

  it('a run config on such a project refuses the add with every problem', async () => {
    const sd = await daemon(PROFILE_NO_GATES);
    const r = await add(sd, {
      profile: 'standard',
      mode: 'direct-pr',
      reason: '',
      worker: { harness: 'claude', model: 'sonnet', effort: 'medium' },
      reviewer: null,
    });
    expect(r.code).toBe(ExitCode.failure);
    expect(r.envelope.error).toMatchObject({
      code: 'config_invalid',
      details: { base: { ref: 'origin/main', sha: SHA } },
    });
    expect(names(checksOf(r))).toEqual(['no_gates_not_allowed']);
  });

  it('a base without cusr.yaml says so', async () => {
    const sd = await daemon(null);
    const w = result(await add(sd)).config_warning;
    expect(names(w?.checks ?? [])).toContain('project_config');
  });

  it('a ready config adds no warning', async () => {
    const sd = await daemon();
    const r = await add(sd);
    expect(r.code).toBe(ExitCode.ok);
    expect(result(r).task_id).toEqual(expect.any(String));
    expect(result(r)).not.toHaveProperty('config_warning');
  });

  it('a profile no selection can freeze with warns as task options refuses (review of #326)', async () => {
    const base = userConfig();
    const user = {
      ...base,
      text: base.text.replace(
        'allow_roles: [scout, coder, reviewer, fixer]',
        'allow_roles: [reviewer]',
      ),
    };
    const sd = await daemon(undefined, { user });
    const added = result(await add(sd));
    expect(added.config_warning).toMatchObject({
      code: 'config_invalid',
      message: expect.stringContaining('cannot freeze') as string,
    });
    expect(added.config_warning?.checks.length).toBeGreaterThan(0);
    for (const c of added.config_warning?.checks ?? []) expect(c.fix).toEqual(expect.any(String));
    const r = await sd.query('owner', { kind: 'run_options', task_id: added.task_id });
    expect(r.envelope.error).toMatchObject({
      code: 'config_invalid',
      message: added.config_warning?.message,
    });
  });

  it('a project without repo in the user config is warned about', async () => {
    const sd = await daemon(undefined, {
      user: userConfig({ project: 'acme: { base_branch: main, path: /srv/repos/acme }' }),
    });
    const w = result(await add(sd)).config_warning;
    expect(names(w?.checks ?? [])).toEqual(['project_repo']);
  });

  it('a base that cannot be read adds the task and says the config was not checked', async () => {
    const sd = await daemon(undefined, { baseMissing: true });
    const r = await add(sd);
    expect(r.code).toBe(ExitCode.ok);
    expect(result(r).config_warning).toMatchObject({
      code: 'config_unchecked',
      message: expect.stringContaining('origin/main') as string,
    });
  });

  it('a check that throws adds the task and says the config was not checked', async () => {
    const sd = await daemon(undefined, { inputsFail: true });
    const r = await add(sd);
    expect(r.code).toBe(ExitCode.ok);
    expect(result(r).config_warning).toMatchObject({
      code: 'config_unchecked',
      message: expect.stringContaining('config file unreadable') as string,
    });
  });

  it('a cusr.yaml with aliases is checked, by add and by task options (re-check of #326)', async () => {
    const sd = await daemon(
      'version: 1\nprofile: standard\nextra: &g { unit: u }\ngates: *g\nci: { required_checks: [u] }\n',
    );
    const added = result(await add(sd));
    expect(added.config_warning?.code).toBe('config_invalid');
    expect(names(added.config_warning?.checks ?? [])).toEqual([
      'required_gate_missing',
      'schema_invalid',
    ]);
    const r = await sd.query('owner', { kind: 'run_options', task_id: added.task_id });
    expect(r.envelope.error?.code).toBe('config_invalid');
    expect(names(checksOf(r))).toEqual(['required_gate_missing', 'schema_invalid']);
  });
});
