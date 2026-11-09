import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../../src/cli/output.ts';
import { runCli } from '../../../src/cli/program.ts';
import { addCommand, confirmCommand, proposeCommand, showCommand } from '../../../src/cli/tasks.ts';
import { startDaemon, type RunningDaemon } from '../../../src/daemon/main.ts';
import { taskControl } from '../../../src/daemon/task-control.ts';
import { asEpochMs } from '../../../src/shared/brand.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import {
  fakeGit,
  fakeGitHub,
  fakeHost,
  MANIFESTS,
  userConfig,
} from '../../support/preflight-fakes.ts';

const dirs: string[] = [];
const daemons: RunningDaemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const clock = { now: () => asEpochMs(1_800_000_000_000), monotonic: () => 0 };
let seq = 0;
const newId = (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

async function daemon() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-task-cli-')));
  dirs.push(base);
  const dataDir = join(base, 'data');
  const started = await startDaemon({
    dataDir,
    clock,
    newId,
    control: (store) =>
      taskControl({
        store,
        now: () => clock.now(),
        confirm: {
          store,
          ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
          configInputs: () =>
            Promise.resolve({
              user: userConfig(),
              packs: PACKS,
              manifests: MANIFESTS,
            }),
          now: () => clock.now(),
        },
      }),
  });
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  daemons.push(started.value);
  return { dataDir, base };
}

async function cli(
  argv: string[],
  env: Record<string, string> = {},
): Promise<{
  code: number;
  data: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}> {
  const out: string[] = [];
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const code = await runCli(
      { name: 'cusr', description: 'test', version: '0' },
      [...argv, '--json'],
      { stdout: (t) => out.push(t), stderr: () => undefined },
      [addCommand, showCommand, confirmCommand, proposeCommand],
    );
    const env1 = JSON.parse(out.join('')) as {
      ok: boolean;
      data?: Record<string, unknown>;
      error?: Record<string, unknown>;
    };
    // Commands answer `{ request_id, replayed, result }`; queries answer the data itself.
    const data = env1.ok ? (env1.data ?? null) : null;
    const body =
      data !== null && 'result' in data && 'request_id' in data
        ? (data['result'] as Record<string, unknown>)
        : data;
    return { code, data: body, error: env1.ok ? null : (env1.error ?? null) };
  } finally {
    process.env = saved;
  }
}

describe('cusr task add/show/confirm over the control socket (T048)', () => {
  it('adds a task, shows it and replays the same request instead of adding twice', async () => {
    const { dataDir } = await daemon();
    const req = '0190e9a0-0000-7000-8000-000000000001';
    const add = await cli([
      'task',
      'add',
      '--data-dir',
      dataDir,
      '--request-id',
      req,
      '--project',
      'acme',
      '--title',
      'Add search',
      '--base',
      'main',
      '--acceptance',
      'search by name works',
    ]);
    expect(add).toMatchObject({
      code: ExitCode.ok,
      data: {
        status: 'READY',
        project: 'acme',
        version: expect.any(Number) as unknown,
      },
    });
    const id = add.data?.['task_id'] as string;

    const again = await cli([
      'task',
      'add',
      '--data-dir',
      dataDir,
      '--request-id',
      req,
      '--project',
      'acme',
      '--title',
      'Add search',
      '--base',
      'main',
      '--acceptance',
      'search by name works',
    ]);
    expect(again.data?.['task_id']).toBe(id);
    const changed = await cli([
      'task',
      'add',
      '--data-dir',
      dataDir,
      '--request-id',
      req,
      '--project',
      'acme',
      '--title',
      'Something else',
      '--base',
      'main',
    ]);
    expect(changed.code).toBe(ExitCode.conflict);

    expect(await cli(['task', 'show', '--data-dir', dataDir, id])).toMatchObject({
      code: ExitCode.ok,
      data: { task_id: id, status: 'READY' },
    });
    expect(
      await cli(['task', 'show', '--data-dir', dataDir, '0190e9a0-0000-7000-8000-00000000ffff']),
    ).toMatchObject({ code: ExitCode.missing });
  });

  it('--pr holds the task for an adopt approval, whose command names the full head', async () => {
    const { dataDir } = await daemon();
    const add = (pr: string) =>
      cli([
        'task',
        'add',
        '--data-dir',
        dataDir,
        '--project',
        'acme',
        '--title',
        `Continue ${pr}`,
        '--base',
        'main',
        '--acceptance',
        'done',
        '--pr',
        pr,
      ]);
    const added = await add('acme/app#7');
    expect(added).toMatchObject({
      code: ExitCode.ok,
      data: {
        status: 'PENDING',
        wait: { detail: { code: 'adopt_approval', pr_ref: 'acme/app#7' } },
      },
    });
    expect((await add('not a ref')).code).toBe(ExitCode.usage);
    const id = (added.data as { task_id: string }).task_id;
    expect(
      (await cli(['task', 'approve', '--data-dir', dataDir, id, '--kind', 'adopt'])).code,
    ).toBe(ExitCode.usage);
  });

  it('a task without acceptance is refused; confirm checks the config of a READY task once', async () => {
    const { dataDir } = await daemon();
    // Nothing could supply acceptance later, so such a task would wait forever (#263).
    const refused = await cli([
      'task',
      'add',
      '--data-dir',
      dataDir,
      '--project',
      'acme',
      '--title',
      'No acceptance',
      '--base',
      'main',
    ]);
    expect(refused.code).toBe(ExitCode.usage);
    expect(refused.error).toMatchObject({ code: 'invalid_arguments' });

    const ready = await cli([
      'task',
      'add',
      '--data-dir',
      dataDir,
      '--project',
      'acme',
      '--title',
      'Add search',
      '--base',
      'main',
      '--acceptance',
      'works',
    ]);
    const id = ready.data?.['task_id'] as string;
    const version = String(ready.data?.['version']);
    const confirmed = await cli([
      'task',
      'confirm',
      '--data-dir',
      dataDir,
      '--project',
      'acme',
      id,
      '--expected-version',
      version,
    ]);
    expect(confirmed).toMatchObject({
      code: ExitCode.ok,
      data: { status: 'READY', config_check: 'checked' },
    });
    expect(
      await cli([
        'task',
        'confirm',
        '--data-dir',
        dataDir,
        '--project',
        'acme',
        id,
        '--expected-version',
        version,
      ]),
    ).toMatchObject({
      // The first confirm changed nothing material, so its version still holds (#262).
      code: ExitCode.ok,
      data: { status: 'READY', config_check: 'checked' },
    });
  });

  it('refuses incomplete arguments locally with usage exit', async () => {
    expect((await cli(['task', 'add', '--project', 'acme'])).code).toBe(ExitCode.usage);
    expect((await cli(['task', 'confirm', 'x'])).code).toBe(ExitCode.usage);
  });

  it('add carries a run selection; the assistant confirms its digest (T048, M01/M02)', async () => {
    const { dataDir } = await daemon();
    const run = [
      '--profile',
      'standard',
      '--mode',
      'direct-pr',
      '--worker',
      'claude/sonnet/medium',
      '--reason',
      'small, low-risk change',
    ];
    // The assistant creates the task and proposes how it runs; intake still needs confirmation.
    const added = await cli(
      [
        'task',
        'add',
        '--data-dir',
        dataDir,
        '--project',
        'acme',
        '--title',
        'Add search',
        '--base',
        'main',
        '--acceptance',
        'works',
        ...run,
      ],
      {
        CUSR_ACTOR: 'assistant',
      },
    );
    expect(added).toMatchObject({
      code: ExitCode.ok,
      data: {
        status: 'PENDING',
        run_config: {
          status: 'proposed',
          mode: 'direct-pr',
          selection: {
            worker: { harness: 'claude', model: 'sonnet', effort: 'medium' },
            reviewer: null,
          },
          proposed_by: 'assistant',
        },
      },
    });
    const id = added.data?.['task_id'] as string;
    const digest = (added.data?.['run_config'] as { digest: string }).digest;
    const version = () =>
      cli(['task', 'show', '--data-dir', dataDir, id]).then((r) => String(r.data?.['version']));

    // The assistant confirms intake and the selection in one interaction; a wrong digest is refused.
    const wrong = await cli([
      'task',
      'confirm',
      '--data-dir',
      dataDir,
      '--project',
      'acme',
      id,
      '--expected-version',
      await version(),
      '--run-config',
      `sha256:${'0'.repeat(64)}`,
    ]);
    expect(wrong.error).toMatchObject({
      details: {
        detail: { reason: 'run_config_digest_mismatch', current: digest },
      },
    });
    const byBot = await cli(
      [
        'task',
        'confirm',
        '--data-dir',
        dataDir,
        '--project',
        'acme',
        id,
        '--expected-version',
        await version(),
        '--run-config',
        digest,
      ],
      { CUSR_ACTOR: 'assistant' },
    );
    expect(byBot).toMatchObject({
      code: ExitCode.ok,
      data: {
        status: 'READY',
        run_config_confirmation: 'confirmed',
        run_config: { status: 'confirmed', confirmed_by: 'assistant' },
      },
    });

    // A new proposal makes the old confirmation stale until it is confirmed again.
    const proposed = await cli([
      'task',
      'propose',
      '--data-dir',
      dataDir,
      '--project',
      'acme',
      id,
      '--expected-version',
      await version(),
      '--profile',
      'standard',
      '--mode',
      'full-review',
      '--worker',
      'claude/sonnet/medium',
      '--reviewer',
      'codex/sol/medium',
    ]);
    expect(proposed).toMatchObject({
      code: ExitCode.ok,
      data: { run_config: { status: 'stale', mode: 'full-review' } },
    });
  });

  it('propose without --fallback takes the worker and reviewer ladder rungs from task options (#170, #276)', async () => {
    const { dataDir } = await daemon();
    const added = await cli([
      'task',
      'add',
      '--data-dir',
      dataDir,
      '--project',
      'acme',
      '--title',
      'Add search',
      '--base',
      'main',
      '--acceptance',
      'works',
    ]);
    const id = added.data?.['task_id'] as string;
    const version = () =>
      cli(['task', 'show', '--data-dir', dataDir, id]).then((r) => String(r.data?.['version']));
    const propose = async (extra: string[]) =>
      cli([
        'task',
        'propose',
        '--data-dir',
        dataDir,
        id,
        '--expected-version',
        await version(),
        '--profile',
        'standard',
        '--mode',
        'full-review',
        '--worker',
        'claude/sonnet/medium',
        '--reviewer',
        'codex/sol/medium',
        ...extra,
      ]);

    // `standard` denies opus, so the only rung above the worker is sonnet/high.
    expect(await propose([])).toMatchObject({
      code: ExitCode.ok,
      data: {
        run_config: {
          selection: {
            fallbacks: [{ harness: 'claude', model: 'sonnet', effort: 'high' }],
            reviewer_fallbacks: [{ harness: 'codex', model: 'sol', effort: 'high' }],
          },
        },
      },
    });
    // An explicit empty list still means no fallbacks.
    expect(await propose(['--fallback', '', '--reviewer-fallback', ''])).toMatchObject({
      code: ExitCode.ok,
      data: { run_config: { selection: { fallbacks: [], reviewer_fallbacks: [] } } },
    });
  });

  it('refuses an incomplete run selection locally', async () => {
    expect(
      (
        await cli([
          'task',
          'add',
          '--project',
          'acme',
          '--title',
          'T',
          '--base',
          'main',
          '--mode',
          'full-review',
          '--worker',
          'claude/sonnet',
        ])
      ).code,
    ).toBe(ExitCode.usage);
  });
});
