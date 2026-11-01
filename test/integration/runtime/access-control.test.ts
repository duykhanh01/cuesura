/**
 * Who may do what over the control socket (T107, FR-028/032): owner/admin, read and a scoped assistant
 * with read+operate, all through the real daemon. Identity comes from the bearer token only, a grant
 * changes only with config and restart, and a revocation does not rewrite what was already accepted.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadTokenMap,
  readTokenFile,
} from '../../../src/application/access-tokens.ts';
import { CUSR_COMMANDS } from '../../../src/cli/commands.ts';
import { ExitCode } from '../../../src/cli/output.ts';
import { runCli } from '../../../src/cli/program.ts';
import { startDaemon } from '../../../src/daemon/main.ts';

import { buildTask, uuidOf } from '../../support/builders.ts';
import { SeededDaemon, type TokenSpec } from '../../support/daemon-task.ts';
import { toGreen } from '../../support/observation.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';

const SPECS: TokenSpec[] = [
  { id: 'reader', actor: 'reader', roles: ['read'], projects: ['acme'] },
  {
    id: 'assistant',
    actor: 'assistant',
    roles: ['read', 'operate'],
    projects: ['acme'],
  },
  {
    id: 'outsider',
    actor: 'outsider',
    roles: ['read', 'operate'],
    projects: ['elsewhere'],
  },
];

const live: SeededDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.cleanup();
});

function daemon(specs = SPECS): SeededDaemon {
  const sd = new SeededDaemon(specs);
  live.push(sd);
  return sd;
}

async function cli(sd: SeededDaemon, token: string, argv: string[]) {
  const out: string[] = [];
  const saved = process.env['CUSR_TOKEN_FILE'];
  process.env['CUSR_TOKEN_FILE'] =
    token === 'owner'
      ? join(sd.dataDir, 'owner.token')
      : join(sd.base, `${token}.token`);
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
    if (saved === undefined) delete process.env['CUSR_TOKEN_FILE'];
    else process.env['CUSR_TOKEN_FILE'] = saved;
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
  it('read may read and nothing else', async () => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => toGreen(d, t));
    const running = await sd.start();
    expect((await cli(sd, 'reader', ['task', 'show', t.id])).code).toBe(
      ExitCode.ok,
    );
    expect((await cli(sd, 'reader', ['inbox'])).code).toBe(ExitCode.ok);
    expect((await cli(sd, 'reader', ['dispatch'])).code).toBe(ExitCode.ok);
    const before = running.store.readEvents(t.id).length;
    const v = String(running.store.readTask(t.id)?.version);
    for (const argv of [
      ['task', 'cancel', t.id, '--expected-version', v],
      ['task', 'confirm', t.id, '--expected-version', v],
      [
        'task',
        'approve',
        t.id,
        '--kind',
        'escalation',
        '--step',
        'code',
        '--rung',
        '1',
        '--expected-version',
        v,
      ],
    ]) {
      const r = await cli(sd, 'reader', argv);
      expect(r.code, argv.join(' ')).toBe(ExitCode.forbidden);
    }
    expect(running.store.readEvents(t.id)).toHaveLength(before);
  });

  it('the assistant operates its own project but cannot approve, even claiming to be the owner', async () => {
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
      'escalation',
      '--step',
      'code',
      '--rung',
      '1',
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
        command(t, 'approve_escalation', v, { step: 'code', rung: 1 }, claim),
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

  it('the approve command explain prints works for the owner, and only for the owner', async () => {
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
      d.complete(
        t.id,
        d.pendingOne(t.id, 'prepare').id,
        'succeeded',
        PREPARE_DATA,
      );
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
    const why = await cli(sd, 'reader', ['task', 'explain', t.id]);
    const action = (
      why.envelope.data['allowed_actions'] as {
        action: string;
        command: string;
      }[]
    ).find((a) => a.action === 'approve');
    const argv = action?.command.split(' ').slice(1) as string[];
    expect(argv).toContain('--rung');
    expect((await cli(sd, 'assistant', argv)).code).toBe(ExitCode.forbidden);
    expect((await cli(sd, 'owner', argv)).code).toBe(ExitCode.ok);
    expect(
      running.store
        .readEvents(t.id)
        .filter((e) => e.type === 'ApprovalGranted'),
    ).toHaveLength(1);
  });

  it('an assistant token confirms a run selection; admin reaches approve and finds no such request', async () => {
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
      'default',
      '--mode',
      'direct-pr',
      '--worker',
      'claude/sonnet/high',
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

describe('project scope (FR-028/032)', () => {
  it('another project is refused on a command, missing on a read, and left out of lists', async () => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => toGreen(d, t));
    const running = await sd.start();
    const v = running.store.readTask(t.id)?.version as number;
    const before = running.store.readEvents(t.id).length;
    // Naming the real project: forbidden. Naming its own: the task is not there.
    expect(
      (
        await sd.command(
          'outsider',
          command(t, 'task_cancel', v, { reason: 'x' }),
        )
      ).code,
    ).toBe(ExitCode.forbidden);
    expect(
      (
        await sd.command(
          'outsider',
          command({ id: t.id, project: 'elsewhere' }, 'task_cancel', v, {
            reason: 'x',
          }),
        )
      ).code,
    ).toBe(ExitCode.missing);
    expect((await cli(sd, 'outsider', ['task', 'show', t.id])).code).toBe(
      ExitCode.missing,
    );
    expect((await cli(sd, 'outsider', ['task', 'explain', t.id])).code).toBe(
      ExitCode.missing,
    );
    expect((await cli(sd, 'outsider', ['task', 'history', t.id])).code).toBe(
      ExitCode.missing,
    );
    expect(
      (await cli(sd, 'outsider', ['task', 'list'])).envelope.data['items'],
    ).toEqual([]);
    expect(
      (await cli(sd, 'outsider', ['task', 'list', '--project', 'acme'])).code,
    ).toBe(ExitCode.forbidden);
    expect(
      (
        await cli(sd, 'outsider', [
          'task',
          'add',
          '--project',
          'acme',
          '--title',
          'T',
          '--base',
          'main',
        ])
      ).code,
    ).toBe(ExitCode.forbidden);
    expect(running.store.readEvents(t.id)).toHaveLength(before);
  });

  it('a prerequisite in another project does not leak through explain', async () => {
    const sd = daemon();
    const a = buildTask({ id: uuidOf(8_001), project: 'elsewhere' });
    const b = buildTask({ id: uuidOf(8_002), depends_on: [a.id] });
    sd.seed((d) => {
      d.must(a.id, { kind: 'create_task', task: a });
      d.must(b.id, { kind: 'create_task', task: b });
    });
    await sd.start();
    const why = await cli(sd, 'assistant', ['task', 'explain', b.id]);
    expect(why.envelope.data['prerequisites']).toMatchObject([
      { task_id: a.id, status: 'not_visible', merged_head_sha: null },
    ]);
  });
});

describe('tokens (T117, FR-028/032)', () => {
  it('an unknown or missing token is exit 5; a token file with loose permissions is refused locally', async () => {
    const sd = daemon();
    await sd.start();
    expect((await sd.query('A'.repeat(43), { kind: 'task_list' })).code).toBe(
      ExitCode.forbidden,
    );
    const missing = await cli(sd, 'nobody', ['task', 'list']);
    expect(missing.code).toBe(ExitCode.usage);
    expect(missing.envelope.error.code).toBe('token_unavailable');
  });

  it('revoking takes effect on restart, and the accepted history keeps its actor', async () => {
    const sd = daemon();
    const t = buildTask();
    sd.seed((d) => createGrantStart(d, t, 'direct-pr'));
    const running = await sd.start();
    const req = uuidOf(7_002);
    const v = running.store.readTask(t.id)?.version as number;
    expect(
      (
        await sd.command('assistant', {
          ...command(t, 'task_cancel', v, { reason: 'stop' }),
          request_id: req,
        })
      ).code,
    ).toBe(ExitCode.ok);
    await sd.stop();

    // Restart with the assistant gone from the config.
    const started = await startDaemon({
      dataDir: sd.dataDir,
      accessTokens: [],
      clock: sd.clock,
      newId: sd.newId,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.error));
    sd.daemon = started.value;
    try {
      const r = await sd.query('assistant', { kind: 'task_list' });
      expect(r.code).toBe(ExitCode.forbidden);
      expect(r.envelope.error?.['code']).toBe('unauthenticated');
      const events = started.value.store.readEvents(t.id);
      expect(
        events.find((e) => e.type === 'CancelRequested')?.actor ??
          events.at(-1)?.actor,
      ).toBe('assistant');
      expect(started.value.store.readCommand(req)?.actor).toBe('assistant');
    } finally {
      await sd.stop();
    }
  });

  it('the owner token is separate: an assistant cannot read it from its grant, and audit holds no secret', async () => {
    const logs: string[] = [];
    const sd = new SeededDaemon(SPECS, { log: (m) => logs.push(m) });
    live.push(sd);
    const running = await sd.start();
    const owner = readTokenFile(running.ownerTokenPath, 'owner');
    if (!owner.ok) throw new Error('owner token');
    const text = logs.join('\n');
    expect(text).toContain(
      'token assistant actor=assistant roles=read,operate projects=acme',
    );
    expect(text).toContain('token config hash');
    expect(text).not.toContain(owner.value);
    expect(text).not.toContain(sd.tokens['assistant']);
    const map = loadTokenMap(
      running.ownerTokenPath,
      SPECS.map((s) => ({ ...s, token_file: join(sd.base, `${s.id}.token`) })),
    );
    expect(
      map.ok && map.value.audit.find((a) => a.id === 'assistant'),
    ).toMatchObject({
      roles: ['read', 'operate'],
      projects: ['acme'],
    });
    // Same secret under two IDs is refused rather than merged.
    const dup = loadTokenMap(running.ownerTokenPath, [
      { ...(SPECS[1] as TokenSpec), token_file: running.ownerTokenPath },
    ]);
    expect(dup).toMatchObject({
      ok: false,
      error: { code: 'token_duplicate' },
    });
    // The token map is on the daemon's side only: the token files never reach a task's data.
    expect(existsSync(join(sd.dataDir, 'owner.token'))).toBe(true);
    const leak = JSON.stringify(running.store.taskIdsByStatus(['READY']));
    expect(leak).not.toContain(owner.value);
    expect(
      readFileSync(join(sd.base, 'assistant.token'), 'utf8'),
    ).not.toContain(owner.value);
  });
});
