/**
 * Who may do what over the control socket (T107, FR-028/032): the owner and a declared assistant with
 * read+operate, all through the real daemon. The caller's actor comes from `CUSR_ACTOR` only, never from
 * the request body, and what was accepted keeps the actor it was accepted under.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CUSR_COMMANDS } from '../../../src/cli/commands.ts';
import { callDaemon } from '../../../src/cli/client.ts';
import { ExitCode } from '../../../src/cli/output.ts';
import { runCli } from '../../../src/cli/program.ts';
import type { CallerActor } from '../../../src/application/authz.ts';
import { loadDaemonConfig } from '../../../src/daemon/main.ts';
import { userConfig } from '../../support/preflight-fakes.ts';

import { buildTask, uuidOf } from '../../support/builders.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import { toGreen } from '../../support/observation.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';

const live: SeededDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.cleanup();
});

function daemon(): SeededDaemon {
  const sd = new SeededDaemon();
  live.push(sd);
  return sd;
}

async function cli(sd: SeededDaemon, actor: string, argv: string[]) {
  const out: string[] = [];
  const saved = process.env['CUSR_ACTOR'];
  process.env['CUSR_ACTOR'] = actor;
  try {
    const code = await runCli(
      { name: 'cusr', description: 'test', version: '0' },
      [...argv, '--data-dir', sd.dataDir, '--json'],
      { stdout: (t) => out.push(t), stderr: () => undefined },
      CUSR_COMMANDS,
    );
    return {
      code,
      envelope: JSON.parse(out.join('')) as {
        ok: boolean;
        data: Record<string, unknown>;
        error: { code: string };
      },
    };
  } finally {
    if (saved === undefined) delete process.env['CUSR_ACTOR'];
    else process.env['CUSR_ACTOR'] = saved;
  }
}

const command = (
  t: { id: string; project: string },
  kind: string,
  expected: number,
  payload: unknown,
  extra: Record<string, unknown> = {},
) => ({
  request_id: uuidOf(6_000 + Math.floor(Math.random() * 1_000)),
  kind,
  project: t.project,
  task_id: t.id,
  expected_version: expected,
  payload,
  ...extra,
});

describe('roles (US6.3, FR-028)', () => {
  it('the assistant operates its own project but cannot approve adopting a PR, even claiming to be the owner', async () => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => toGreen(d, t));
    const running = await sd.start();
    const v = running.store.readTask(t.id)?.version as number;
    const before = running.store.readEvents(t.id).length;
    const denied = await cli(sd, 'assistant', [
      'task',
      'approve',
      t.id,
      '--kind',
      'adopt',
      '--head-sha',
      'a'.repeat(40),
      '--expected-version',
      String(v),
    ]);
    expect(denied.code).toBe(ExitCode.forbidden);
    for (const claim of [
      { actor: 'owner' },
      { roles: ['admin'] },
      { authz: { actor: 'owner', roles: ['admin'] } },
    ]) {
      const r = await sd.command(
        'assistant',
        command(t, 'approve_adopt', v, { head_sha: 'a'.repeat(40) }, claim),
      );
      expect(r.code, JSON.stringify(claim)).toBe(ExitCode.forbidden);
    }
    // A claimed actor in the payload of something it may do changes nothing: the closed schema refuses it.
    const spoof = await sd.command(
      'assistant',
      command(t, 'task_cancel', v, { reason: 'x', actor: 'owner' }),
    );
    expect(spoof.code).toBe(ExitCode.usage);
    expect(running.store.readEvents(t.id)).toHaveLength(before);

    // What it does is recorded under its own actor.
    const req = uuidOf(7_001);
    const cancel = await sd.command('assistant', {
      ...command(t, 'task_cancel', v, { reason: 'stop' }),
      request_id: req,
    });
    expect(cancel.code).toBe(ExitCode.ok);
    expect(running.store.readCommand(req)?.actor).toBe('assistant');
  });

  it('the approve command explain prints works for the assistant too (#205)', async () => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => {
      createGrantStart(d, t, 'direct-pr', {
        roles: {
          coder: {
            model: 'sonnet',
            effort: 'medium',
            ladder: [{ model: 'opus', effort: 'high' }],
          },
        },
      } as never);
      d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
      for (let i = 0; i < 2; i++) {
        if (d.task(t.id).wait?.detail.code === 'execution_slot')
          d.store.grantNext(d.now as EpochMs);
        d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
          failure_class: 'quality',
          signature: 'C1',
          invoked: true,
          usage: { basis: 'unavailable' },
        });
      }
    });
    const running = await sd.start();
    const why = await cli(sd, 'assistant', ['task', 'explain', t.id, '--full']);
    const action = (
      why.envelope.data['allowed_actions'] as {
        action: string;
        command: string;
      }[]
    ).find((a) => a.action === 'approve');
    const argv = action?.command.split(' ').slice(1) as string[];
    expect(argv).toContain('--rung');
    expect((await cli(sd, 'assistant', argv)).code).toBe(ExitCode.ok);
    expect(
      running.store
        .readEvents(t.id)
        .flatMap((e) => (e.type === 'ApprovalGranted' ? [e.payload.by] : [])),
    ).toEqual(['assistant']);
  });

  it('an assistant confirms a run selection; admin reaches approve and finds no such request', async () => {
    const sd = daemon();
    await sd.start();
    const add = await cli(sd, 'assistant', [
      'task',
      'add',
      '--project',
      'acme',
      '--title',
      'T',
      '--base',
      'main',
      '--acceptance',
      'a',
      '--profile',
      'standard',
      '--mode',
      'direct-pr',
      '--worker',
      'claude/sonnet/medium',
    ]);
    expect(add.code).toBe(ExitCode.ok);
    const result = add.envelope.data['result'] as {
      task_id: string;
      version: number;
      run_config: { digest: string } | null;
    };
    expect(result.run_config).not.toBeNull();
    const r = await cli(sd, 'assistant', [
      'task',
      'confirm',
      result.task_id,
      '--expected-version',
      String(result.version),
      '--run-config',
      result.run_config?.digest as string,
    ]);
    expect(r.code).toBe(ExitCode.ok);
    const confirmed = r.envelope.data['result'] as { version: number };
    const none = await cli(sd, 'owner', [
      'task',
      'approve',
      result.task_id,
      '--kind',
      'escalation',
      '--step',
      'code',
      '--rung',
      '1',
      '--expected-version',
      String(confirmed.version),
    ]);
    // Admin passes authz; there is simply no such request to approve.
    expect(none.code).toBe(ExitCode.missing);
  });
});

describe('declared actor (FR-028/032)', () => {
  it('an unknown actor is refused locally by the CLI and by the daemon', async () => {
    const sd = daemon();
    const running = await sd.start();
    const local = await cli(sd, 'viewer', ['task', 'list']);
    expect(local.code).toBe(ExitCode.usage);
    expect(local.envelope.error.code).toBe('actor_invalid');
    const r = await callDaemon({
      socketPath: running.socketPath,
      actor: 'viewer' as CallerActor,
      method: 'POST',
      path: '/v1/query',
      body: { kind: 'task_list' },
    });
    expect(r.ok && r.value.status).toBe(401);
    expect(r.ok && !r.value.envelope.ok && r.value.envelope.error.code).toBe('unauthenticated');
  });

  it('an unset actor is the owner', async () => {
    const sd = daemon();
    await sd.start();
    const saved = process.env['CUSR_ACTOR'];
    delete process.env['CUSR_ACTOR'];
    try {
      const out: string[] = [];
      const code = await runCli(
        { name: 'cusr', description: 'test', version: '0' },
        ['project', 'list', '--data-dir', sd.dataDir, '--json'],
        { stdout: (t) => out.push(t), stderr: () => undefined },
        CUSR_COMMANDS,
      );
      expect(code).toBe(ExitCode.ok);
      const data = (JSON.parse(out.join('')) as { data: { caller: { actor: string } } }).data;
      expect(data.caller.actor).toBe('owner');
    } finally {
      if (saved !== undefined) process.env['CUSR_ACTOR'] = saved;
    }
  });

  it('an old config with access_tokens still starts, with a warning that they are ignored', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-old-config-')));
    try {
      const file = join(dir, 'config.yaml');
      const { text } = userConfig({
        runtime: `runtime:\n  data_dir: ${dir}/data\n  access_tokens:\n    - { id: a, actor: assistant, roles: [read, operate], projects: [acme], token_file: /srv/a.token }`,
      });
      writeFileSync(file, text);
      const cfg = await loadDaemonConfig({ config: file, dataDir: undefined });
      expect(cfg.ok && cfg.value.warnings).toEqual([
        expect.stringContaining('runtime.access_tokens is ignored') as string,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
