import { afterEach, describe, expect, it } from 'vitest';
import { CUSR_COMMANDS } from '../../../src/cli/commands.ts';
import { ExitCode } from '../../../src/cli/output.ts';
import { runCli } from '../../../src/cli/program.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import { SeededDaemon, type SeededExtra } from '../../support/daemon-task.ts';
import {
  fakeGit,
  fakeGitHub,
  fakeHost,
  MANIFESTS,
  userConfig,
} from '../../support/preflight-fakes.ts';
import { createGrantStart } from '../../support/runtime.ts';

// The new reads through the real CLI and a real daemon; the services have their own tests beside them.

const running: SeededDaemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.cleanup();
});

function daemon(extra?: SeededExtra): SeededDaemon {
  const sd = new SeededDaemon({}, extra);
  running.push(sd);
  return sd;
}

type Run = { code: number; out: string; err: string };
async function cli(sd: SeededDaemon, ...argv: string[]): Promise<Run> {
  let out = '';
  let errors = '';
  const code = await runCli(
    { name: 'cusr', description: '', version: '0' },
    [...argv, '--data-dir', sd.dataDir],
    { stdout: (t) => (out += t), stderr: (t) => (errors += t) },
    CUSR_COMMANDS,
  );
  return { code, out, err: errors };
}
const json = async (sd: SeededDaemon, ...argv: string[]) => {
  const r = await cli(sd, ...argv, '--json');
  expect(r.out.trimEnd().split('\n')).toHaveLength(1);
  return {
    code: r.code,
    envelope: JSON.parse(r.out) as Record<string, unknown>,
  };
};

describe('cusr task board', () => {
  it('reads the board, with filters', async () => {
    const sd = daemon();
    const a = buildTask({ id: uuidOf(1) });
    const b = buildTask({ id: uuidOf(2) });
    sd.seed((d) => {
      d.must(a.id, { kind: 'create_task', task: a });
      d.must(b.id, { kind: 'create_task', task: b });
      d.must(b.id, { kind: 'cancel', reason: 'stop' });
    });
    await sd.start();
    expect(await json(sd, 'task', 'board')).toMatchObject({
      code: ExitCode.ok,
      envelope: {
        ok: true,
        data: {
          unchanged: false,
          items: [{ task_id: a.id }],
          counts: { by_status: { READY: 1, CANCELLED: 1 } },
          queue: { length: 0 },
        },
      },
    });
    expect(await json(sd, 'task', 'board', '--scope', 'terminal')).toMatchObject({
      envelope: { data: { items: [{ task_id: b.id }] } },
    });
    expect(await json(sd, 'task', 'board', '--status', 'READY', '--limit', '1')).toMatchObject({
      envelope: { data: { items: [{ task_id: a.id }] } },
    });
    expect(await json(sd, 'task', 'board', '--cursor', a.id, '--scope', 'all')).toMatchObject({
      envelope: { data: { items: [{ task_id: b.id }] } },
    });
    expect(await json(sd, 'task', 'board', '--project', 'nope')).toMatchObject({
      envelope: { data: { items: [] } },
    });
  });

  it('rejects bad flags with exit 2 before calling the daemon', async () => {
    const sd = daemon();
    await sd.start();
    await sd.stop();
    expect((await json(sd, 'task', 'board', '--limit', 'many')).code).toBe(ExitCode.usage);
    expect((await json(sd, 'task', 'board', '--scope', 'some')).code).toBe(ExitCode.usage);
  });

  it('exits 3 without a daemon', async () => {
    const sd = daemon();
    await sd.start();
    await sd.stop();
    expect((await json(sd, 'task', 'board')).code).toBe(ExitCode.connection);
  });

  it('says how to fix a bad flag, in text and in JSON', async () => {
    const sd = daemon();
    const r = await cli(sd, 'task', 'board', '--status', 'running');
    expect(r.code).toBe(ExitCode.usage);
    expect(r.err).toBe(
      'cusr: invalid --status "running".\nValid values: PENDING, READY, RUNNING, WAITING, DONE, FAILED, CANCELLED.\n',
    );
    for (const limit of ['0', '101', '1.5', 'many', '-1']) {
      const bad = await cli(sd, 'task', 'board', `--limit=${limit}`);
      expect(bad.code).toBe(ExitCode.usage);
      expect(bad.err).toBe('cusr: --limit must be an integer between 1 and 100.\n');
    }
    expect((await cli(sd, 'task', 'board', '--scope', 'x')).err).toContain(
      'Valid values: active, terminal, all.',
    );
    expect((await cli(sd, 'task', 'board', '--cursor', 'x')).err).toContain('must be a task ID');
    expect(await json(sd, 'task', 'board', '--status', 'running')).toMatchObject({
      code: ExitCode.usage,
      envelope: {
        error: {
          code: 'invalid_arguments',
          details: {
            valid_values: expect.arrayContaining(['RUNNING']) as unknown,
          },
        },
      },
    });
  });

  it('prints a short table for people, once per task, and keeps JSON whole', async () => {
    const sd = daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Fix \x1b[2Jthe bug' });
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    const r = await cli(sd, 'task', 'board');
    expect(r.code).toBe(ExitCode.ok);
    expect(r.out.split(t.id)).toHaveLength(2);
    expect(r.out).toContain('Needs you (1)');
    expect(r.out).toContain('STATUS');
    expect(r.out).toContain('Counts: READY 1. Queue: 0.');
    expect(r.out).not.toContain('watermark');
    expect(r.out).not.toContain('\x1b');
    expect(r.out).toContain('␛[2J');
    const board = (await json(sd, 'task', 'board')).envelope as {
      data: { watermark: unknown; attention: { items: unknown[] }; items: { task_id: string }[] };
    };
    expect(board.data.watermark).toEqual(expect.any(Number));
    expect(board.data.items.map((i) => i.task_id)).toEqual([t.id]);
    // Listed once: attention only names the task that `items` already describes (no wait code here).
    expect(board.data.attention.items).toEqual([{ task_id: t.id }]);
    const full = (await json(sd, 'task', 'board', '--full')).envelope as typeof board;
    expect(full.data.attention.items).toEqual(full.data.items);
  });

  it('JSON keeps the row of a task that needs a person but is not on this page', async () => {
    const sd = daemon();
    const tasks = [1, 2].map((n) => buildTask({ id: uuidOf(n) }));
    sd.seed((d) => {
      for (const t of tasks) d.must(t.id, { kind: 'create_task', task: t });
    });
    await sd.start();
    const board = (await json(sd, 'task', 'board', '--limit', '1')).envelope as {
      data: { attention: { items: Record<string, unknown>[] }; items: { task_id: string }[] };
    };
    const [onPage] = board.data.items;
    const off = board.data.attention.items.find((i) => i['task_id'] !== onPage?.task_id);
    expect(board.data.attention.items).toHaveLength(2);
    expect(board.data.attention.items).toContainEqual({ task_id: onPage?.task_id });
    expect(off).toHaveProperty('title');
  });

  it('the suggested next page shows the same list, and can be run as it is', async () => {
    const sd = daemon();
    const tasks = [1, 2, 3].map((n) => buildTask({ id: uuidOf(n) }));
    sd.seed((d) => {
      for (const t of tasks) {
        d.must(t.id, { kind: 'create_task', task: t });
        d.must(t.id, { kind: 'cancel', reason: 'stop' });
      }
    });
    await sd.start();
    const first = await cli(sd, 'task', 'board', '--scope', 'terminal', '--limit', '1');
    const more = first.out.split('\n').find((l) => l.startsWith('More: '));
    expect(more).toBe(
      `More: cusr task board --scope terminal --limit 1 --data-dir ${sd.dataDir} --cursor ${uuidOf(1)}`,
    );
    const next = await cli(sd, ...(more ?? '').split(' ').slice(2));
    expect(next.code).toBe(ExitCode.ok);
    expect(next.out).toContain(uuidOf(2));
    expect(next.out).not.toContain(uuidOf(1));
    expect(next.out).toContain(`--cursor ${uuidOf(2)}`);
  });

  it('help lists the statuses, the case rule and an example', async () => {
    const sd = daemon();
    const r = await cli(sd, 'task', 'board', '--help');
    expect(r.out.replaceAll(/\s+/g, ' ')).toContain(
      'in uppercase: PENDING, READY, RUNNING, WAITING, DONE, FAILED, CANCELLED',
    );
    expect(r.out).toContain('cusr task board --project acme --status WAITING');
    expect(r.out).toContain('List tasks and highlight those that need your attention.');
  });
});

describe.each([
  ['task', 'content', { intake_pending: false, run_config: null }],
  ['task', 'progress', { steps: null, reason: 'not_frozen' }],
] as const)('cusr %s %s', (group, name, expected) => {
  it('reads one task', async () => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    expect(await json(sd, group, name, t.id)).toMatchObject({
      code: ExitCode.ok,
      envelope: { data: { task_id: t.id, ...expected } },
    });
  });

  it('exits 4 for an unknown task and 2 for a malformed ID', async () => {
    const sd = daemon();
    await sd.start();
    expect(await json(sd, group, name, uuidOf(9))).toMatchObject({
      code: ExitCode.missing,
      envelope: { error: { code: 'task_not_found' } },
    });
    expect((await json(sd, group, name, 'bad')).code).toBe(ExitCode.usage);
  });
});

describe('cusr task progress, for people', () => {
  it('prints a labelled summary', async () => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    const r = await cli(sd, 'task', 'progress', t.id);
    expect(r.code).toBe(ExitCode.ok);
    expect(r.out).toContain(`Task: ${t.id}`);
    expect(r.out).toContain('Needs you: yes');
    expect(r.out).toContain('Steps are not available yet (not_frozen).');
  });
});

describe('cusr task options', () => {
  const withGit =
    (opts: { user?: string; missingBase?: boolean } = {}): SeededExtra =>
    (store) => {
      const git = fakeGit();
      return {
        confirm: {
          store,
          ports: {
            git: {
              run: (c) =>
                opts.missingBase === true && c.args[0] === 'rev-parse'
                  ? Promise.resolve({
                      kind: 'exited' as const,
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
            Promise.resolve({
              user:
                opts.user === undefined ? userConfig() : { file: 'config.yaml', text: opts.user },
              packs: PACKS,
              manifests: MANIFESTS,
            }),
          now: () => 0,
        },
      };
    };

  async function seeded(extra: SeededExtra, started = false) {
    const sd = daemon(extra);
    const t = buildTask();
    sd.seed((d) => {
      if (started) createGrantStart(d, t);
      else d.must(t.id, { kind: 'create_task', task: t });
    });
    await sd.start();
    return { sd, t };
  }

  it('prints the options with exit 0', async () => {
    const { sd, t } = await seeded(withGit());
    expect(await json(sd, 'task', 'options', t.id)).toMatchObject({
      code: ExitCode.ok,
      envelope: { data: { profile: { id: 'standard' } } },
    });
  });

  it.each([
    ['config_invalid', { user: 'version: 99\n' }, false, ExitCode.failure],
    ['options_unavailable', { missingBase: true }, false, ExitCode.failure],
    ['conflict', {}, true, ExitCode.conflict],
  ] as const)('%s has its exit code', async (code, opts, started, exit) => {
    const { sd, t } = await seeded(withGit(opts), started);
    expect(await json(sd, 'task', 'options', t.id)).toMatchObject({
      code: exit,
      envelope: { error: { code } },
    });
  });

  it('task_not_found exits 4', async () => {
    const { sd } = await seeded(withGit());
    expect(await json(sd, 'task', 'options', uuidOf(9))).toMatchObject({
      code: ExitCode.missing,
      envelope: { error: { code: 'task_not_found' } },
    });
  });
});
