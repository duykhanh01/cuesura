import { describe, expect, it } from 'vitest';
import { GhPort } from '../../../src/adapters/github/gh-port.ts';
import type {
  Clock,
  GitHubPort,
  GitHubRequest,
} from '../../../src/adapters/ports.ts';
import { yoloMerge, type YoloDeps } from '../../../src/daemon/yolo.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';
import { err, ok } from '../../../src/shared/result.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { fixtureExec } from '../../support/gh-fixture.ts';
import { A, merge, toGreen } from '../../support/observation.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { CONTENT_DIGEST } from '../../support/store-flows.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// The daemon's merge under yolo (SPEC §14.2): what must hold before anything is sent, and what is sent.

const tempDir = useTempDir('cusr-yolo-');
const setup = () => new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
let ids = 90_000;
const newId = () => uuidOf(ids++);

type Remote = {
  pull?: Record<string, unknown>;
  protection?: Record<string, unknown>;
  protectionStatus?: number;
  mergeStatus?: number | 'lost';
  /** Conclusions of the head's current check runs. */
  checks?: Record<string, string>;
};

const REQUIRED = ['build', 'test'];
const MESSAGE = 'feat: thêm tìm kiếm\n\nGiải thích thay đổi.\n';

function github(r: Remote = {}) {
  const sent: GitHubRequest[] = [];
  const conclusions = r.checks ?? { build: 'success', test: 'success' };
  const port: GitHubPort = {
    request: (req) => {
      sent.push(req);
      const reply = (body: unknown) =>
        Promise.resolve(
          ok({
            status: 200,
            headers: {},
            body,
            evidence_digest: hashCanonical('evidence'),
          }),
        );
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
      if (req.path.endsWith('/protection')) {
        if (r.protectionStatus !== undefined)
          return Promise.resolve(
            err({
              reason: 'http_error' as const,
              status: r.protectionStatus,
              detail: 'Branch not protected',
              retry_after_ms: null,
            }),
          );
        return reply({
          url: `https://api.github.com/${req.path}`,
          required_status_checks: { strict: true, contexts: REQUIRED },
          enforce_admins: { enabled: true },
          ...r.protection,
        });
      }
      if (req.path.includes('/rules/branches/')) return reply([]);
      if (req.path.includes('/branches/')) return reply({ protected: true });
      if (req.path.endsWith('/check-runs'))
        return reply({
          check_runs: Object.entries(conclusions).map(([name, c], i) => ({
            id: i + 1,
            name,
            head_sha: A,
            status: 'completed',
            conclusion: c,
            app: { id: 1 },
          })),
        });
      if (req.path.endsWith('/statuses')) return reply([]);
      return reply({
        state: 'open',
        merged: false,
        mergeable_state: 'clean',
        head: { sha: A },
        base: { ref: 'main' },
        ...r.pull,
      });
    },
  };
  return { port, sent };
}

function deps(d: StoreDriver, port: GitHubPort, enabled = true): YoloDeps {
  const clock: Clock = { now: () => d.now as EpochMs, monotonic: () => d.now };
  return {
    store: d.store,
    clock,
    newId,
    github: () => port,
    enabled: () => Promise.resolve(enabled),
    content: () => ({
      commit_message: MESSAGE,
      pr_title: 'title',
      pr_body: 'body',
    }),
  };
}

/** A task waiting for its merge, its policy requiring the checks the fake GitHub requires. */
function green(
  d: StoreDriver,
  t: CanonicalTask,
  mode: 'full-review' | 'direct-pr' = 'full-review',
): void {
  toGreen(
    d,
    t,
    mode,
    { required_checks: REQUIRED },
    {},
    { content: { digest: CONTENT_DIGEST, ref: '/content/a.json' } },
  );
}

const puts = (sent: readonly GitHubRequest[]) =>
  sent.filter((r) => r.method === 'PUT');

const approvals = (d: StoreDriver, t: CanonicalTask) =>
  Object.values(d.task(t.id).approvals).filter((a) => a.kind === 'merge');

describe('yolo merge', () => {
  it.each(['full-review', 'direct-pr'] as const)(
    '%s: records the approval first, merges the checked head, and leaves completion to the observation',
    async (mode) => {
      const d = setup();
      const t = buildTask();
      green(d, t, mode);
      const { port, sent } = github();

      expect(await yoloMerge(deps(d, port), t.id)).toBe('merged');

      const merges = puts(sent);
      expect(merges).toHaveLength(1);
      expect(merges[0]?.path).toMatch(/\/pulls\/7\/merge$/);
      expect(merges[0]?.body).toEqual({
        sha: A,
        merge_method: 'squash',
        commit_title: 'feat: thêm tìm kiếm',
        commit_message: 'Giải thích thay đổi.',
      });
      expect(approvals(d, t)).toMatchObject([
        {
          status: 'granted',
          granted_by: 'policy:yolo',
          head_sha: A,
          content_digest: d.task(t.id).run.content?.digest,
        },
      ]);
      expect(d.task(t.id).status).toBe('WAITING');
      merge(d, t, A);
      expect(d.task(t.id).completion).toMatchObject({
        proof: { merged_head_sha: A },
      });
    },
  );

  it('a merge whose answer was lost, or that GitHub refused, can be sent again without a second approval', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    expect(
      await yoloMerge(deps(d, github({ mergeStatus: 'lost' }).port), t.id),
    ).toBe('unknown');
    expect(
      await yoloMerge(deps(d, github({ mergeStatus: 405 }).port), t.id),
    ).toBe('refused');
    expect(await yoloMerge(deps(d, github().port), t.id)).toBe('merged');
    expect(approvals(d, t)).toHaveLength(1);
  });

  it('yolo off reads nothing from GitHub and sends nothing', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github();
    expect(await yoloMerge(deps(d, port, false), t.id)).toBe('off');
    expect(sent).toEqual([]);
    expect(approvals(d, t)).toEqual([]);
  });

  it('yolo turned off during the reads stops the merge', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github();
    let reads = 0;
    const r = await yoloMerge(
      { ...deps(d, port), enabled: () => Promise.resolve(reads++ === 0) },
      t.id,
    );
    expect(r).toBe('off');
    expect(puts(sent)).toEqual([]);
  });

  it.each<[string, Remote]>([
    ['behind its base', { pull: { mergeable_state: 'behind' } }],
    ['mergeability not computed yet', { pull: { mergeable_state: null } }],
    ['another head', { pull: { head: { sha: 'b'.repeat(40) } } }],
    ['another target', { pull: { base: { ref: 'dev' } } }],
    ['closed', { pull: { state: 'closed' } }],
    ['no protection', { protectionStatus: 404 }],
    [
      'protection that allows a stale branch',
      { protection: { required_status_checks: { strict: false } } },
    ],
    [
      'protection that admins bypass',
      { protection: { enforce_admins: { enabled: false } } },
    ],
  ])('%s: no approval and no merge', async (_name, remote) => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github(remote);
    expect(await yoloMerge(deps(d, port), t.id)).toBe('not_ready');
    expect(puts(sent)).toEqual([]);
    expect(approvals(d, t)).toEqual([]);
    expect(d.task(t.id).wait?.detail.code).toBe('merge');
  });

  it.each(['neutral', 'skipped', 'stale'])(
    'a check that became %s after the observation stops the merge, though GitHub says clean',
    async (conclusion) => {
      const d = setup();
      const t = buildTask();
      green(d, t);
      const { port, sent } = github({
        checks: { build: 'success', test: conclusion },
      });
      expect(await yoloMerge(deps(d, port), t.id)).toBe('not_ready');
      expect(puts(sent)).toEqual([]);
      expect(approvals(d, t)).toEqual([]);
    },
  );

  it('a required check with no current run stops the merge', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github({ checks: { build: 'success' } });
    expect(await yoloMerge(deps(d, port), t.id)).toBe('not_ready');
    expect(puts(sent)).toEqual([]);
  });

  it('a cancel recorded while the config is read for the last time stops the merge', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github();
    let reads = 0;
    const r = await yoloMerge(
      {
        ...deps(d, port),
        enabled: () => {
          if (++reads === 2) d.must(t.id, { kind: 'cancel', reason: 'stop' });
          return Promise.resolve(true);
        },
      },
      t.id,
    );
    expect(d.task(t.id).cancellation).not.toBeNull();
    expect(r).toBe('not_approved');
    expect(puts(sent)).toEqual([]);
  });

  it('a resend uses the same message; content that cannot be read back sends nothing', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const asked: string[] = [];
    const lost = github({ mergeStatus: 'lost' });
    await yoloMerge(
      {
        ...deps(d, lost.port),
        content: (ref, digest) => {
          asked.push(digest);
          return deps(d, lost.port).content(ref, digest);
        },
      },
      t.id,
    );
    const again = github();
    await yoloMerge(deps(d, again.port), t.id);
    expect(puts(again.sent)[0]?.body).toEqual(puts(lost.sent)[0]?.body);
    expect(asked).toEqual([approvals(d, t)[0]?.content_digest]);

    const unread = github();
    expect(
      await yoloMerge({ ...deps(d, unread.port), content: () => null }, t.id),
    ).toBe('not_ready');
    expect(puts(unread.sent)).toEqual([]);
  });

  it('a cancelled task is not merged', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    const { port, sent } = github();
    expect(await yoloMerge(deps(d, port), t.id)).toBe('not_waiting');
    expect(sent).toEqual([]);
  });

  it('the engine refuses a head it does not vouch for', () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    d.must(t.id, { kind: 'yolo_merge_approve', head_sha: 'b'.repeat(40) });
    expect(approvals(d, t)).toEqual([]);
    expect(d.store.readEvents(t.id).at(-1)).toMatchObject({
      type: 'SignalIgnored',
      payload: { reason: 'yolo_head_unverified' },
    });
  });

  it('the gh port sends only a merge that names the head and, for a squash, its message', async () => {
    let t = 0;
    const exec = fixtureExec({
      'PUT repos/o/r/pulls/1/merge': [{ status: 200, body: { merged: true } }],
    });
    const p = new GhPort({
      exec,
      clock: { now: () => t as EpochMs, monotonic: () => t++ },
      redactor: new Redactor({ values: [] }),
    });
    const put = (path: string, body: unknown) =>
      p.request({ method: 'PUT', path, query: {}, body });
    const good = {
      sha: A,
      merge_method: 'squash',
      commit_title: 'title',
      commit_message: '',
    };
    expect(await put('repos/o/r/pulls/1/merge', good)).toMatchObject({
      ok: true,
    });
    for (const [path, body] of [
      ['repos/o/r/pulls/1/merge', { merge_method: 'squash' }],
      ['repos/o/r/pulls/1/merge', { sha: A, merge_method: 'squash' }],
      ['repos/o/r/pulls/1/merge', { ...good, delete_branch: true }],
      ['repos/o/r/pulls/1/merge', { ...good, merge_method: 'rebase' }],
      ['repos/o/r/pulls/1', good],
      ['repos/o/r/contents/a', good],
    ] as const)
      expect(await put(path, body)).toMatchObject({
        ok: false,
        error: { reason: 'not_allowed' },
      });
  });
});
