import { describe, expect, it } from 'vitest';
import type { GitHubPort, GitHubRequest } from '../../../src/adapters/ports.ts';
import {
  admitCommand,
  type Admitted,
  type CommandInput,
} from '../../../src/application/commands.ts';
import { callerFor, type Caller } from '../../../src/application/authz.ts';
import { taskMerge, type ManualMergeDeps } from '../../../src/daemon/manual-merge.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { MANUAL_APPROVER } from '../../../src/engine/external-completion.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';
import { err, ok } from '../../../src/shared/result.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { A, toGreen } from '../../support/observation.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { CONTENT_DIGEST } from '../../support/store-flows.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// The owner's explicit merge (`task_merge`): what is checked again on the daemon side, whatever the dialog
// showed, and that no outcome of it is ever DONE.

const tempDir = useTempDir('cusr-manual-merge-');
const setup = () => new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
let ids = 70_000;
const newId = () => uuidOf(ids++);

const REQUIRED = ['build', 'test'];
const RUNTIME = {
  target: {
    provider: 'github' as const,
    repo: 'acme/app',
    immutable_repo_id: '1',
    base_ref: 'main',
  },
};
const MESSAGE = 'feat: thêm tìm kiếm\n\nGiải thích thay đổi.\n';

type Remote = {
  pull?: Record<string, unknown>;
  secondPull?: Record<string, unknown>;
  checks?: Record<string, string>;
  mergeStatus?: number | 'lost';
  /** The target tip the last confirmation reports; `null` reports none. */
  confirmTip?: string | null;
};

function github(r: Remote = {}) {
  const sent: GitHubRequest[] = [];
  let pullReads = 0;
  const conclusions = r.checks ?? { build: 'success', test: 'success' };
  const reply = (body: unknown) =>
    Promise.resolve(
      ok({ status: 200, headers: {}, body, evidence_digest: hashCanonical('evidence') }),
    );
  const port: GitHubPort = {
    request: (req) => {
      sent.push(req);
      if (req.method === 'PUT') {
        if (r.mergeStatus === 'lost')
          return Promise.resolve(
            err({
              reason: 'unknown' as const,
              status: null,
              detail: 'timeout',
              retry_after_ms: null,
            }),
          );
        if (r.mergeStatus !== undefined)
          return Promise.resolve(
            err({
              reason: 'http_error' as const,
              status: r.mergeStatus,
              detail: 'refused',
              retry_after_ms: null,
            }),
          );
        return reply({ merged: true });
      }
      if (req.path.includes('/compare/')) return reply({ ahead_by: 0, behind_by: 1 });
      if (req.path.includes('/rules/branches/')) return reply([]);
      if (req.path.endsWith('/protection'))
        return reply({
          url: `https://api.github.com/${req.path}`,
          required_status_checks: {
            strict: true,
            contexts: REQUIRED,
            checks: REQUIRED.map((context) => ({ context, app_id: 15368 })),
          },
          enforce_admins: { enabled: true },
        });
      if (req.path.includes('/branches/'))
        return reply({ protected: true, commit: { sha: 'b'.repeat(40) } });
      if (req.path.endsWith('/check-runs'))
        return reply({
          check_runs: Object.entries(conclusions).map(([name, c], i) => ({
            id: i + 1,
            name,
            head_sha: A,
            status: c === 'pending' ? 'in_progress' : 'completed',
            conclusion: c === 'pending' ? null : c,
            app: { id: 15368 },
          })),
        });
      if (req.path.endsWith('/statuses')) return reply([]);
      if (req.path.endsWith('/events')) return reply([]);
      const pull = {
        id: 700,
        number: 7,
        state: 'open',
        draft: false,
        merged: false,
        mergeable_state: 'clean',
        head: { sha: A, ref: 'cusr/t' },
        base: { ref: 'main', sha: 'b'.repeat(40), repo: { id: 1 } },
        ...r.pull,
      } as Record<string, unknown> & { head: { sha: string }; base: { ref: string } };
      if (req.method === 'POST' && req.path === 'graphql')
        return reply({
          data: {
            repository: {
              pullRequest: {
                state: pull['state'] === 'open' ? 'OPEN' : 'CLOSED',
                isDraft: pull['draft'],
                headRefOid: pull.head.sha,
                baseRefName: pull.base.ref,
                baseRef: {
                  target: { oid: r.confirmTip === undefined ? 'b'.repeat(40) : r.confirmTip },
                },
              },
            },
          },
        });
      return reply(++pullReads === 2 ? { ...pull, ...r.secondPull } : pull);
    },
  };
  return { port, sent };
}

const puts = (sent: readonly GitHubRequest[]) => sent.filter((r) => r.method === 'PUT');

function deps(d: StoreDriver, port: GitHubPort, content = true): ManualMergeDeps {
  return {
    store: d.store,
    now: () => d.now,
    github: () => port,
    content: () =>
      content ? { commit_message: MESSAGE, pr_title: 'title', pr_body: 'body' } : null,
  };
}

function green(d: StoreDriver, t: CanonicalTask): void {
  toGreen(d, t, 'full-review', { required_checks: REQUIRED }, RUNTIME, {
    content: { digest: CONTENT_DIGEST, ref: '/content/a.json' },
  });
}

const owner = callerFor('owner') as Caller;

/** What the dialog sends when it saw the task as it is. */
function body(d: StoreDriver, t: CanonicalTask, over: Record<string, unknown> = {}): CommandInput {
  return {
    request_id: uuidOf(ids++),
    kind: 'task_merge',
    project: d.task(t.id).project,
    task_id: t.id,
    expected_version: d.task(t.id).version,
    payload: {
      pr_ref: 'acme#7',
      target: 'main',
      head_sha: A,
      merge_method: 'squash',
      content_digest: CONTENT_DIGEST,
      ...over,
    },
  };
}

const run = (
  d: StoreDriver,
  port: GitHubPort,
  input: CommandInput,
  caller: Caller = owner,
  content = true,
) =>
  taskMerge(
    deps(d, port, content),
    {
      record: { request_id: input.request_id, assigned_ids: Array.from({ length: 8 }, newId) },
    } as unknown as Admitted,
    input,
    caller,
  );

const approvals = (d: StoreDriver, t: CanonicalTask) =>
  Object.values(d.task(t.id).approvals).filter((a) => a.kind === 'merge');

describe('task_merge', () => {
  it('merges the shown head with the owner approval, and the task is not DONE', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github();
    const r = await run(d, port, body(d, t));
    expect(r).toMatchObject({ ok: true, value: { outcome: 'sent', done: false } });
    const [put] = puts(sent);
    expect(put).toMatchObject({
      path: 'repos/acme/app/pulls/7/merge',
      body: { sha: A, merge_method: 'squash', commit_title: 'feat: thêm tìm kiếm' },
    });
    expect(approvals(d, t)).toMatchObject([{ status: 'granted', granted_by: MANUAL_APPROVER }]);
    expect(d.task(t.id)).toMatchObject({ status: 'WAITING', completion: null });
  });

  it('refuses what the dialog showed once the task is not as shown, before reading GitHub', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github();
    const cases: [Record<string, unknown>, string][] = [
      [{ head_sha: 'c'.repeat(40) }, 'head_sha'],
      [{ target: 'release' }, 'target'],
      [{ pr_ref: 'acme#8' }, 'pr_ref'],
      [{ merge_method: 'rebase' }, 'merge_method'],
      [{ content_digest: hashCanonical('other') }, 'content_digest'],
    ];
    for (const [over, field] of cases) {
      const r = await run(d, port, body(d, t, over));
      expect(r, field).toMatchObject({
        ok: false,
        error: { code: 'conflict', details: { reason: 'merge_changed', field } },
      });
    }
    expect(sent).toEqual([]);
    expect(approvals(d, t)).toEqual([]);
  });

  it('refuses a stale version without touching GitHub', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github();
    const input = body(d, t);
    const r = await run(d, port, { ...input, expected_version: (input.expected_version ?? 0) - 1 });
    expect(r).toMatchObject({ ok: false, error: { code: 'conflict', message: 'stale_version' } });
    expect(sent).toEqual([]);
  });

  it('refuses when GitHub shows another head, and sends nothing', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github({ pull: { head: { sha: 'c'.repeat(40), ref: 'cusr/t' } } });
    const r = await run(d, port, body(d, t));
    expect(r).toMatchObject({
      ok: false,
      error: { details: { reason: 'not_ready', detail: 'head does not match' } },
    });
    expect(puts(sent)).toEqual([]);
    expect(approvals(d, t)).toEqual([]);
  });

  it('refuses a draft or closed PR, or one whose checks are not green', async () => {
    for (const [remote, reason] of [
      [{ pull: { draft: true } }, 'not_ready'],
      [{ pull: { state: 'closed' } }, 'pr_closed_unmerged'],
      [{ pull: { mergeable_state: 'blocked' } }, 'not_ready'],
      [{ checks: { build: 'success', test: 'failure' } }, 'checks_not_ready'],
      [{ checks: { build: 'success', test: 'pending' } }, 'checks_not_ready'],
    ] as [Remote, string][]) {
      const d = setup();
      const t = buildTask();
      green(d, t);
      const { port, sent } = github(remote);
      const r = await run(d, port, body(d, t));
      expect(r, JSON.stringify(remote)).toMatchObject({
        ok: false,
        error: { code: 'conflict', details: { reason } },
      });
      expect(puts(sent)).toEqual([]);
      expect(approvals(d, t)).toEqual([]);
    }
  });

  it('reports a GitHub refusal as not merged, never DONE; the approval stands for the head', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port } = github({ mergeStatus: 405 });
    const r = await run(d, port, body(d, t));
    expect(r).toMatchObject({
      ok: false,
      error: { details: { reason: 'github_refused' } },
    });
    expect(d.task(t.id)).toMatchObject({ status: 'WAITING', completion: null });
  });

  it('fails closed when the final target tip is missing or moved after the head was compared', async () => {
    for (const confirmTip of [null, 'c'.repeat(40)]) {
      const d = setup();
      const t = buildTask();
      green(d, t);
      const { port, sent } = github({ confirmTip });
      const r = await run(d, port, body(d, t));
      expect(r, String(confirmTip)).toMatchObject({
        ok: false,
        error: { details: { reason: 'not_ready' } },
      });
      expect(puts(sent)).toEqual([]);
      expect(approvals(d, t)).toEqual([]);
    }
  });

  it('answers a lost GitHub reply as unknown, then reads the PR: open is sent again, merged is not', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const lost = await run(d, github({ mergeStatus: 'lost' }).port, body(d, t));
    expect(lost).toMatchObject({ ok: true, value: { outcome: 'unknown', done: false } });
    // Still open: the same head-bound merge is sent again, once.
    const open = github();
    expect(await run(d, open.port, body(d, t))).toMatchObject({
      ok: true,
      value: { outcome: 'sent' },
    });
    expect(puts(open.sent)).toHaveLength(1);
    // GitHub shows it merged: nothing is sent, and the task is still not DONE.
    const merged = github({ pull: { state: 'closed', merged: true } });
    expect(await run(d, merged.port, body(d, t))).toMatchObject({
      ok: true,
      value: { outcome: 'already_merged', done: false },
    });
    expect(puts(merged.sent)).toEqual([]);
    expect(d.task(t.id).status).toBe('WAITING');
  });

  it.each([{ state: 'open', merged: false }, { merged: undefined }, { merged: 'false' }])(
    'waits when a second pull read is inconclusive (%j)',
    async (secondPull) => {
      const d = setup();
      const t = buildTask({ id: newId() });
      green(d, t);
      const remote = github({ pull: { state: 'closed' }, secondPull });
      expect(await run(d, remote.port, body(d, t))).toMatchObject({
        ok: false,
        error: { details: { reason: 'not_ready' } },
      });
      expect(puts(remote.sent)).toEqual([]);
    },
  );

  it('does not take a closed PR for a merge after a refused or unsent request', async () => {
    for (const first of ['refused', 'content'] as const) {
      const d = setup();
      const t = buildTask();
      green(d, t);
      const r = await run(
        d,
        github(first === 'refused' ? { mergeStatus: 405 } : {}).port,
        body(d, t),
        owner,
        first !== 'content',
      );
      expect(r, first).toMatchObject({ ok: false });
      // The approval stands, yet the PR closed without a merge is neither sent nor reported as one.
      expect(approvals(d, t)).toHaveLength(1);
      const closed = github({ pull: { state: 'closed', merged: false } });
      expect(await run(d, closed.port, body(d, t)), first).toMatchObject({
        ok: false,
        error: { details: { reason: 'pr_closed_unmerged' } },
      });
      expect(puts(closed.sent)).toEqual([]);
      expect(d.task(t.id)).toMatchObject({ status: 'WAITING', completion: null });
    }
  });

  it('is not offered, and refused, for a task not waiting for its merge', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    d.must(t.id, { kind: 'cancel', reason: 'no' } as never);
    const { port, sent } = github();
    const r = await run(d, port, body(d, t));
    expect(r).toMatchObject({ ok: false, error: { details: { reason: 'not_waiting_for_merge' } } });
    expect(sent).toEqual([]);
  });

  it('admits only the owner: assistant and deputy are forbidden before anything runs', () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const cmd = { store: d.store, now: () => d.now, newId };
    expect(admitCommand(cmd, callerFor('owner'), body(d, t)).ok).toBe(true);
    for (const actor of ['assistant', 'deputy']) {
      expect(admitCommand(cmd, callerFor(actor), body(d, t))).toMatchObject({
        ok: false,
        error: { code: 'forbidden', required: 'admin' },
      });
    }
  });
});
