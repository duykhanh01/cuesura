import { afterEach, describe, expect, it } from 'vitest';
import { startTask } from '../../../src/application/start.ts';
import { CUSR_COMMANDS } from '../../../src/cli/commands.ts';
import { runCli } from '../../../src/cli/program.ts';
import type { ConfigSource } from '../../../src/config/yaml-loader.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import {
  configuredSelection,
  fakeGit,
  fakeGitHub,
  fakeHost,
  MANIFESTS,
  userConfig,
} from '../../support/preflight-fakes.ts';
import { proposeAndConfirm } from '../../support/runtime.ts';

// #319: a workflow edit reaches every task whose policy is not frozen yet; `task show` tells the operator
// which review cap a started task froze, and `cusr doctor` says so after a workflow edit.

const live: SeededDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.cleanup();
});

/** The fixture workflow `impl`, with an explicit review cap when `cap` is given. */
function configWith(cap: number | null): ConfigSource {
  const base = userConfig();
  const text =
    cap === null
      ? base.text
      : base.text.replace(
          '    base: software_dev@1\n',
          `    base: software_dev@1\n    steps:\n      review: { max_visits: ${cap} }\n`,
        );
  if (cap !== null && text === base.text) throw new Error('fixture workflow not found');
  return { ...base, text };
}

async function cli(sd: SeededDaemon, ...argv: string[]) {
  let out = '';
  let err = '';
  const code = await runCli(
    { name: 'cusr', description: '', version: '0' },
    [...argv, '--data-dir', sd.dataDir],
    { stdout: (t) => (out += t), stderr: (t) => (err += t) },
    CUSR_COMMANDS,
  );
  return { code, out, err };
}

type Envelope = {
  data: { review_policy: unknown };
  error: { details: { checks: { name: string; status: string; detail: string; note?: string }[] } };
};
const envelope = (out: string): Envelope => JSON.parse(out) as Envelope;

describe('review cap through start, the CLI and doctor', () => {
  it('a started task keeps cap 6 after the YAML says 3, while an unstarted one picks up 3', async () => {
    const sd = new SeededDaemon();
    live.push(sd);
    const running1 = buildTask({ id: uuidOf(1) });
    const queued = buildTask({ id: uuidOf(2) });
    const selections = new Map(
      await Promise.all(
        [running1, queued].map(
          async (t) => [t.id, await configuredSelection(t, 'full-review', configWith(6))] as const,
        ),
      ),
    );
    sd.seed((d) => {
      for (const t of [running1, queued]) {
        d.must(t.id, { kind: 'create_task', task: t });
        proposeAndConfirm(d, t, selections.get(t.id)!);
        d.must(t.id, { kind: 'request_execution' });
        const g = d.store.grantNext(d.now as EpochMs, [], { capacity: 2 });
        if (!g.ok || g.value.kind !== 'decided') throw new Error('grant failed');
      }
    });
    const daemon = await sd.start();
    let yaml = configWith(6);
    const deps = () => ({
      store: daemon.store,
      configInputs: () => Promise.resolve({ user: yaml, packs: PACKS, manifests: MANIFESTS }),
      now: () => sd.clock.now(),
      ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
      docs: {
        prompts: (names: readonly string[]) =>
          Promise.resolve(names.map((name) => ({ name, content: `# ${name}\n` }))),
        attachments: () => Promise.resolve([]),
      },
      newId: sd.newId,
    });
    expect(await startTask(deps(), running1.id)).toMatchObject({ kind: 'submitted', frozen: true });

    yaml = configWith(3);
    expect(await startTask(deps(), queued.id)).toMatchObject({ kind: 'submitted', frozen: true });

    const show = async (id: string) => {
      const r = await cli(sd, 'task', 'show', id, '--json');
      expect(r.code).toBe(0);
      return (JSON.parse(r.out) as { data: Record<string, unknown> }).data;
    };
    for (const full of [false, true]) {
      const argv = full ? ['--full'] : [];
      const a = envelope((await cli(sd, 'task', 'show', running1.id, '--json', ...argv)).out);
      const b = envelope((await cli(sd, 'task', 'show', queued.id, '--json', ...argv)).out);
      expect(a.data.review_policy).toEqual({ status: 'frozen', max_review_rounds: 6, used: 0 });
      expect(b.data.review_policy).toMatchObject({ max_review_rounds: 3 });
    }
    expect((await show(running1.id))['status']).toBe('RUNNING');
    const human = await cli(sd, 'task', 'show', running1.id);
    expect(human.out).toContain('max_review_rounds');
    expect(human.out).toContain('6');
  });

  it('doctor prints the note in plain output even when another check fails, and without an override', async () => {
    for (const cap of [3, null]) {
      const sd: SeededDaemon = new SeededDaemon({}, (store, runtime) => ({
        doctor: {
          dataDir: sd.dataDir,
          host: fakeHost(),
          configInputs: () =>
            Promise.resolve({ user: configWith(cap), packs: PACKS, manifests: MANIFESTS }),
          health: () => runtime.health() ?? 'forced unhealthy',
          now: () => sd.clock.now(),
        },
      }));
      live.push(sd);
      await sd.start();
      const plain = await cli(sd, 'doctor');
      expect(plain.code).toBe(1);
      expect(plain.err).toContain('note: config: workflow max_visits');
      expect(plain.err).toContain('not frozen yet');
      const json = envelope((await cli(sd, 'doctor', '--json')).out);
      const config = json.error.details.checks.find((c) => c.name === 'config');
      expect(config).toMatchObject({ status: 'ok', detail: 'user config is valid' });
      expect(config?.note).toContain('RUNNING');
    }
  });
});
