import { describe, expect, it } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FileContentStore } from '../../../src/adapters/publish-content.ts';
import { productionControl } from '../../../src/daemon/production.ts';
import type { DomainEventDraft } from '../../../src/domain/event.ts';
import { replay } from '../../../src/engine/evolve.ts';
import { approvalCovering, reviewOf } from '../../../src/engine/head-evidence.ts';
import { ci, observation } from '../../support/observation.ts';
import { observeTaskPr } from '../../../src/daemon/handlers.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { agentData, publishData } from '../../support/scenario.ts';
import { toPublish, checkpointGates, reviewToCi } from '../../support/store-flows.ts';
import { confirmPull, readMergeReadiness } from '../../../src/adapters/github/merge.ts';
import { GhPort } from '../../../src/adapters/github/gh-port.ts';
import type { Clock, GitHubPort, GitHubRequest } from '../../../src/adapters/ports.ts';
import { advanceTaskPr, type YoloDeps } from '../../../src/daemon/yolo.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';
import { err, ok } from '../../../src/shared/result.ts';
import { injectEvents, openFileStoreForTest } from '../../../src/store/testing.ts';
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
  protected?: boolean;
  targetSha?: string;
  targetStatus?: number;
  targetBody?: unknown;
  compare?: Record<string, unknown>;
  compareStatus?: number;
  rulesStatus?: number;
  checkRuns?: unknown;
  checkAppId?: number | null;
  statuses?: unknown;
  mergeStatus?: number | 'lost';
  /** Conclusions of the head's current check runs. */
  checks?: Record<string, string>;
  /** The PR's issue events; none by default. */
  events?: unknown[];
  /** What successive reads of the PR add to `pull`, the last one repeating. */
  pullReads?: Record<string, unknown>[];
  /** When each workflow run was made, by id. */
  workflows?: Record<number, string>;
  /** The answer to reads of the check runs, when not the listing. */
  checkRunsStatus?: { status: number; retry_after_ms: number | null };
};

const REQUIRED = ['build', 'test'];
const PINNED = {
  strict: true,
  contexts: REQUIRED,
  checks: [
    { context: 'build', app_id: 15368 },
    { context: 'test', app_id: 15368 },
  ],
};
const OBS_RUNTIME = {
  target: {
    provider: 'github' as const,
    repo: 'acme/app',
    immutable_repo_id: '1',
    base_ref: 'main',
  },
};
const MESSAGE = 'feat: thêm tìm kiếm\n\nGiải thích thay đổi.\n';

function github(r: Remote = {}) {
  const sent: GitHubRequest[] = [];
  let pullReads = 0;
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
      const failure = (status: number) =>
        Promise.resolve(
          err({
            reason: 'http_error' as const,
            status,
            detail: 'unreadable',
            retry_after_ms: null,
          }),
        );
      if (req.path.includes('/compare/'))
        return r.compareStatus === undefined
          ? reply(r.compare ?? { ahead_by: 0, behind_by: 1 })
          : failure(r.compareStatus);
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
      if (req.path.includes('/rules/branches/'))
        return r.rulesStatus === undefined ? reply([]) : failure(r.rulesStatus);
      if (req.path.includes('/branches/'))
        return r.targetStatus === undefined
          ? reply(
              r.targetBody ?? {
                protected: r.protected ?? true,
                commit: { sha: r.targetSha ?? 'b'.repeat(40) },
              },
            )
          : failure(r.targetStatus);
      const wf = /\/actions\/runs\/(\d+)$/.exec(req.path);
      if (wf !== null) {
        const made = r.workflows?.[Number(wf[1])];
        return made === undefined
          ? failure(404)
          : reply({ id: Number(wf[1]), head_sha: A, created_at: made });
      }
      if (req.path.endsWith('/check-runs') && r.checkRunsStatus !== undefined)
        return Promise.resolve(
          err({
            reason: 'http_error' as const,
            status: r.checkRunsStatus.status,
            detail: `HTTP ${r.checkRunsStatus.status}`,
            retry_after_ms: r.checkRunsStatus.retry_after_ms,
          }),
        );
      if (req.path.endsWith('/check-runs'))
        return reply(
          r.checkRuns ?? {
            check_runs: Object.entries(conclusions).map(([name, c], i) => ({
              id: i + 1,
              name,
              head_sha: A,
              status: c === 'pending' ? 'in_progress' : 'completed',
              conclusion: c === 'pending' ? null : c,
              app: { id: r.checkAppId === undefined ? 15368 : r.checkAppId },
            })),
          },
        );
      if (req.path.endsWith('/statuses')) return reply(r.statuses ?? []);
      if (req.path.endsWith('/events')) return reply(r.events ?? []);
      const read = r.pullReads?.[Math.min(pullReads++, r.pullReads.length - 1)];
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
        ...read,
      } as Record<string, unknown> & { head: { sha: string }; base: { ref: string } };
      // The last check before an approval: the same PR, in one GraphQL answer with its target's tip.
      if (req.method === 'POST' && req.path === 'graphql')
        return reply({
          data: {
            repository: {
              pullRequest: {
                state:
                  pull['merged'] === true ? 'MERGED' : pull['state'] === 'open' ? 'OPEN' : 'CLOSED',
                isDraft: pull['draft'],
                headRefOid: pull.head.sha,
                baseRefName: pull.base.ref,
                baseRef: { target: { oid: r.targetSha ?? 'b'.repeat(40) } },
              },
            },
          },
        });
      return reply(pull);
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
  required: string[] = REQUIRED,
): void {
  toGreen(
    d,
    t,
    mode,
    { required_checks: required },
    {},
    { content: { digest: CONTENT_DIGEST, ref: '/content/a.json' } },
  );
}

const puts = (sent: readonly GitHubRequest[]) => sent.filter((r) => r.method === 'PUT');

const approvals = (d: StoreDriver, t: CanonicalTask) =>
  Object.values(d.task(t.id).approvals).filter((a) => a.kind === 'merge');

describe('yolo merge', () => {
  it('classic checks pinned to app_id 15368 merge when the checks pass', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github({
      protection: { required_status_checks: PINNED },
    });
    const log: string[] = [];
    expect(
      await advanceTaskPr({ ...deps(d, port), log: (line) => log.push(line) }, t.id),
      log.join('\n'),
    ).toBe('merged');
    expect(puts(sent)).toHaveLength(1);
  });

  it.each([
    ['ci', false],
    ['observation', false],
    ['ci', true],
    ['observation', true],
  ] as const)('app_id requirements on the %s path, yolo=%s', async (path, enabled) => {
    const d = setup();
    const t = buildTask();
    const runtime = OBS_RUNTIME;
    if (path === 'observation') {
      toGreen(d, t, 'direct-pr', { required_checks: REQUIRED }, runtime, {
        content: { digest: CONTENT_DIGEST, ref: '/content/a.json' },
      });
    } else {
      createGrantStart(d, t, 'direct-pr', { required_checks: REQUIRED }, runtime);
      toPublish(d, t, A, {
        content: { digest: CONTENT_DIGEST, ref: '/content/a.json' },
      });
      d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
      d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
        pr_ref: 'acme#7',
        head_sha: A,
      });
      reviewToCi(d, t.id);
    }
    const { port, sent } = github({
      protection: { required_status_checks: PINNED },
    });
    const read = await observeTaskPr(deps(d, port), t.id, 'app-id-repro', 'timer');
    expect(read.failure).toBeNull();
    expect(read.ci?.required).toMatchObject({
      kind: 'covered',
      github: REQUIRED,
      app_pinned: [
        { name: 'build', app: 15368 },
        { name: 'test', app: 15368 },
      ],
    });
    if (path === 'observation') {
      for (const fact of read.facts) d.must(t.id, fact);
    } else {
      d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', read.ci);
    }
    expect(d.task(t.id).wait?.detail.code).toBe('merge');
    expect(d.task(t.id).evidence.ci.at(-1)?.required).toMatchObject({
      app_pinned: [
        { name: 'build', app: 15368 },
        { name: 'test', app: 15368 },
      ],
    });
    expect(await advanceTaskPr(deps(d, port, enabled), t.id)).toBe(enabled ? 'merged' : 'off');
    expect(puts(sent)).toHaveLength(enabled ? 1 : 0);
    expect(d.store.readPolicy(t.id, 1, 1)?.ci.required_checks).toEqual(REQUIRED);
  });

  it.each(['ci', 'observation'] as const)(
    'the %s path waits for GitHub checks outside policy without changing the snapshot',
    async (path) => {
      const d = setup();
      const t = buildTask();
      const policy = { required_checks: ['build'] };
      if (path === 'ci') {
        createGrantStart(d, t, 'direct-pr', policy, OBS_RUNTIME);
        toPublish(d, t, A);
        d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
        d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
          pr_ref: 'acme#7',
          head_sha: A,
        });
        reviewToCi(d, t.id);
      } else toGreen(d, t, 'direct-pr', policy, OBS_RUNTIME);
      const { port } = github({
        checks: {
          build: 'success',
          security: 'success',
          'codecov/patch': 'failure',
        },
        protection: {
          required_status_checks: {
            checks: [{ context: 'security', app_id: 15368 }],
          },
        },
      });
      const read = await observeTaskPr(deps(d, port), t.id, 'extra-required', 'timer');
      expect(read.ci?.required_set).toEqual({
        names: ['security'],
        source: 'branch_protection',
        complete: true,
      });
      if (path === 'ci') d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', read.ci);
      else for (const fact of read.facts) d.must(t.id, fact);
      expect(d.task(t.id).wait?.detail.code).toBe('merge');
      expect(d.task(t.id).evidence.ci.at(-1)?.required).toMatchObject({
        kind: 'covered',
        github: ['security'],
        app_pinned: [{ name: 'security', app: 15368 }],
      });
      expect(d.store.readPolicy(t.id, 1, 1)?.ci.required_checks).toEqual(['build']);
      expect(d.pending(t.id, 'start_agent')).toEqual([]);
    },
  );

  it.each([
    {},
    { 'codecov/patch': 'failure' },
    { test: 'pending' },
    { test: 'skipped' },
    { GitGuardian: 'success' },
  ])('empty policy leaves engine CI unchanged when yolo toggles, checks=%j', async (checks) => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t, 'direct-pr', { required_checks: [] }, OBS_RUNTIME);
    const { port, sent } = github({ protected: false, checks });
    for (const enabled of [false, true, false, true]) {
      const read = await observeTaskPr(deps(d, port), t.id, 'no-fallback', 'recheck');
      expect(read.ci?.required_set).toEqual({
        names: [],
        source: 'branch_protection',
        complete: true,
      });
      for (const fact of read.facts) d.must(t.id, fact);
      expect(d.task(t.id).wait?.detail.code).toBe('merge');
      expect(d.pending(t.id, 'start_agent')).toEqual([]);
      expect(d.pending(t.id, 'await_ci')).toEqual([]);
      expect(await advanceTaskPr(deps(d, port, enabled), t.id)).toBe(enabled ? 'not_ready' : 'off');
    }
    expect(puts(sent)).toEqual([]);
  });

  it.each([15369, null])(
    'a successful check from app %s cannot satisfy app_id 15368 when admin bypass is allowed',
    async (checkAppId) => {
      const d = setup();
      const t = buildTask();
      green(d, t);
      const { port, sent } = github({
        checkAppId,
        protection: {
          required_status_checks: PINNED,
          enforce_admins: { enabled: false },
        },
      });
      const log: string[] = [];
      expect(await advanceTaskPr({ ...deps(d, port), log: (line) => log.push(line) }, t.id)).toBe(
        'not_ready',
      );
      expect(log.join('\n')).toContain('app 15368');
      expect(puts(sent)).toEqual([]);
      expect(approvals(d, t)).toEqual([]);
    },
  );

  it('a commit status with the same name cannot satisfy an app-pinned check', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github({
      protection: {
        required_status_checks: PINNED,
        enforce_admins: { enabled: false },
      },
      checks: {},
      statuses: REQUIRED.map((context) => ({ context, state: 'success' })),
    });
    expect(await advanceTaskPr(deps(d, port), t.id)).toBe('not_ready');
    expect(puts(sent)).toEqual([]);
  });

  it.each([false, true])(
    'a historical required_checks_mismatch resumes on observation (CI window spent=%s), and replays',
    async (spent) => {
      const d = setup();
      const t = buildTask();
      toGreen(
        d,
        t,
        'direct-pr',
        { required_checks: REQUIRED, limits: { max_wall_ms: 6 * 3_600_000 } },
        OBS_RUNTIME,
      );
      d.must(
        t.id,
        observation(d, t, 'open', A, {
          ci: ci(
            A,
            { build: 'success', test: 'success' },
            {
              kind: 'required_checks_mismatch',
              missing_from_snapshot: [],
              app_pinned: [
                {
                  name: 'build',
                  app: 15368,
                  source: 'classic',
                  ruleset_id: null,
                },
              ],
              snapshot_only: [],
            },
          ),
        }),
      );
      expect(d.task(t.id).wait?.detail.code).toBe('required_checks_mismatch');
      expect(replay(d.store.readEvents(t.id))).toEqual(d.task(t.id));
      const historical = d.store.readEvents(t.id).map((event) => structuredClone(event));
      for (const event of historical)
        if (event.type === 'CiResultRecorded') delete event.payload.required;
      const old = replay(historical);
      expect(old?.wait?.detail.code).toBe('required_checks_mismatch');
      expect(old?.evidence.ci.every((entry) => !Object.hasOwn(entry, 'required'))).toBe(true);
      if (spent) d.now += 3_600_001;
      const { port } = github({
        protection: { required_status_checks: PINNED },
      });
      const read = await observeTaskPr(deps(d, port), t.id, 'legacy-mismatch', 'timer');
      for (const fact of read.facts) d.must(t.id, fact);
      // A covered pass on the head returns to the merge wait even after its CI window (#246).
      expect(d.task(t.id).wait?.detail.code).toBe('merge');
      expect(replay(d.store.readEvents(t.id))).toEqual(d.task(t.id));
    },
  );

  it('invalid or unreadable config logs an error and stops merge without changing observation evidence', async () => {
    const d = setup();
    const t = buildTask();
    const dataDir = tempDir();
    const content = new FileContentStore(join(dataDir, 'content')).put({
      commit_message: MESSAGE,
      pr_title: 'title',
      pr_body: 'body',
    });
    toGreen(d, t, 'direct-pr', { required_checks: REQUIRED }, OBS_RUNTIME, {
      content,
    });
    const { port, sent } = github({
      protection: { required_status_checks: PINNED },
    });
    const first = await observeTaskPr(deps(d, port), t.id, 'initial', 'timer');
    for (const fact of first.facts) d.must(t.id, fact);
    const configPath = join(dataDir, 'config.yaml');
    const valid = 'version: 1\nyolo: true\n';
    writeFileSync(configPath, valid);
    const log: string[] = [];
    const control = await productionControl({
      configPath,
      dataDir,
      clock: deps(d, port).clock,
      redactor: new Redactor(),
      newId,
      log: (line) => log.push(line),
      seams: { github: () => port },
    });
    const surface = control(d.store, {
      health: () => null,
      recoveryClaims: () => [],
      spoolProblems: () => [],
      abort: () => false,
      settled: () => Promise.resolve(),
      latch: () => undefined,
    });
    for (const config of [
      valid,
      'version: 1\nyolo: [',
      'version: 1\nyolo: "true"\n',
      null,
      valid,
    ]) {
      if (config === null) rmSync(configPath);
      else writeFileSync(configPath, config);
      d.now = d.task(t.id).observation?.budget.next_due_at ?? d.now;
      const before = puts(sent).length;
      await surface.rounds[1]?.();
      expect(puts(sent), log.join('\n')).toHaveLength(before + (config === valid ? 1 : 0));
      expect(d.task(t.id).wait?.detail.code).toBe('merge');
      expect(d.task(t.id).evidence.ci.at(-1)?.required).toEqual(first.ci?.required);
    }
    expect(log.filter((line) => line.includes('yolo disabled: config invalid'))).toHaveLength(2);
    expect(log.some((line) => line.includes('yolo disabled: config unreadable'))).toBe(true);
  });

  it.each(['full-review', 'direct-pr'] as const)(
    '%s: records the approval first, merges the checked head, and leaves completion to the observation',
    async (mode) => {
      const d = setup();
      const t = buildTask();
      green(d, t, mode);
      const { port, sent } = github();

      expect(await advanceTaskPr(deps(d, port), t.id)).toBe('merged');

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
    expect(await advanceTaskPr(deps(d, github({ mergeStatus: 'lost' }).port), t.id)).toBe(
      'unknown',
    );
    expect(await advanceTaskPr(deps(d, github({ mergeStatus: 405 }).port), t.id)).toBe('refused');
    expect(await advanceTaskPr(deps(d, github().port), t.id)).toBe('merged');
    expect(approvals(d, t)).toHaveLength(1);
  });

  it('yolo off still checks base freshness but sends no merge', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github();
    expect(await advanceTaskPr(deps(d, port, false), t.id)).toBe('off');
    expect(sent.map((request) => request.method)).toEqual(['GET', 'GET', 'GET']);
    expect(puts(sent)).toEqual([]);
    expect(approvals(d, t)).toEqual([]);
  });

  it('yolo turned off during the reads stops the merge', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github();
    let reads = 0;
    const r = await advanceTaskPr(
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
    ['blocked', { pull: { mergeable_state: 'blocked' } }],
    ['dirty', { pull: { mergeable_state: 'dirty' } }],
    ['target tip missing', { targetBody: {}, compare: { ahead_by: 1 } }],
    ['target tip unreadable', { targetStatus: 403 }],
    ['target tip invalid', { targetBody: { commit: { sha: 'invalid' } } }],
    ['unreadable compare', { compareStatus: 403 }],
    ['missing ahead_by', { compare: { behind_by: 0 } }],
    ['non-numeric ahead_by', { compare: { ahead_by: '0' } }],
    ['protected but protection unreadable', { protectionStatus: 403 }],
    ['protected but rules unreadable', { rulesStatus: 403 }],
    ['unprotected but rules unreadable', { protected: false, rulesStatus: 403 }],
    ['incomplete check data', { checkRuns: {} }],
    ['check name collision', { statuses: [{ context: 'build', state: 'success' }] }],
  ])('%s: no approval and no merge', async (_name, remote) => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github(remote);
    expect(await advanceTaskPr(deps(d, port), t.id)).toBe('not_ready');
    expect(puts(sent)).toEqual([]);
    expect(approvals(d, t)).toEqual([]);
    expect(d.task(t.id).wait?.detail.code).toBe('merge');
  });

  it.each<[string, Remote, string[]]>([
    ['no protection, declared checks', { protected: false }, REQUIRED],
    [
      'protection allows stale branches',
      {
        protection: {
          required_status_checks: { strict: false, contexts: REQUIRED },
        },
      },
      REQUIRED,
    ],
    [
      'protection allows admin bypass',
      { protection: { enforce_admins: { enabled: false } } },
      REQUIRED,
    ],
    [
      'GitHub check absent from policy',
      {
        checks: { build: 'success', test: 'success', security: 'success' },
        protection: {
          required_status_checks: { contexts: [...REQUIRED, 'security'] },
        },
      },
      REQUIRED,
    ],
  ])(
    '%s: merges when current checks pass and head contains the target',
    async (_name, remote, required) => {
      const d = setup();
      const t = buildTask();
      green(d, t, 'direct-pr', required);
      const { port, sent } = github(remote);
      expect(await advanceTaskPr(deps(d, port), t.id)).toBe('merged');
      expect(puts(sent)).toHaveLength(1);
      expect(sent).toContainEqual({
        method: 'GET',
        path: `repos/acme/app/compare/${A}...${'b'.repeat(40)}`,
        query: { per_page: '1', page: '2' },
        body: null,
      });
      if (remote.protected === false)
        expect(sent.some((req) => req.path.endsWith('/protection'))).toBe(false);
    },
  );

  it('#246: an unstable PR merges when every required check is green and only another check fails', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github({
      pull: { mergeable_state: 'unstable' },
      checks: { build: 'success', test: 'success', lint: 'failure' },
    });
    expect(await advanceTaskPr(deps(d, port), t.id)).toBe('merged');
    expect(puts(sent)).toHaveLength(1);
  });

  it.each<[string, Remote, string[]]>([
    [
      'a required check failing',
      { pull: { mergeable_state: 'unstable' }, checks: { build: 'success', test: 'failure' } },
      REQUIRED,
    ],
    [
      'no required checks',
      {
        protected: false,
        pull: { mergeable_state: 'unstable' },
        checks: { build: 'success', lint: 'failure' },
      },
      [],
    ],
  ])('#246: an unstable PR with %s is not merged', async (_name, remote, required) => {
    const d = setup();
    const t = buildTask();
    green(d, t, 'direct-pr', required);
    const { port, sent } = github(remote);
    expect(await advanceTaskPr(deps(d, port), t.id)).toBe('not_ready');
    expect(puts(sent)).toEqual([]);
    expect(approvals(d, t)).toEqual([]);
    expect(d.task(t.id).wait?.detail.code).toBe('merge');
  });

  it.each([
    {},
    { test: 'pending' },
    { test: 'skipped' },
    { test: 'failure' },
    { test: 'neutral' },
    { build: 'success', test: 'success' },
    { GitGuardian: 'success' },
  ])('no protection and empty policy cannot merge with checks %j', async (checks) => {
    const d = setup();
    const t = buildTask();
    green(d, t, 'direct-pr', []);
    const { port, sent } = github({ protected: false, checks });
    const log: string[] = [];
    expect(await advanceTaskPr({ ...deps(d, port), log: (line) => log.push(line) }, t.id)).toBe(
      'not_ready',
    );
    expect(puts(sent)).toEqual([]);
    expect(approvals(d, t)).toEqual([]);
    expect(log.join('\n')).toContain('ci.required_checks in cusr.yaml');
    expect(d.task(t.id).wait?.detail.code).toBe('merge');
  });

  it('an empty required list logs the configuration hint only once per task and stays at merge wait', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t, 'direct-pr', []);
    const { port, sent } = github({
      protected: false,
      checks: { GitGuardian: 'success' },
    });
    const log: string[] = [];
    const options = { ...deps(d, port), log: (line: string) => log.push(line) };
    for (let i = 0; i < 3; i++) expect(await advanceTaskPr(options, t.id)).toBe('not_ready');
    expect(log).toHaveLength(1);
    expect(log[0]).toContain('ci.required_checks in cusr.yaml');
    expect(d.task(t.id).wait?.detail.code).toBe('merge');
    expect(puts(sent)).toEqual([]);
  });

  it('reads an encoded target branch and compares to its immutable SHA', async () => {
    const { port, sent } = github({
      pull: { base: { ref: 'release/v1', sha: A } },
      targetSha: 'b'.repeat(40),
      compare: { ahead_by: 1 },
    });
    expect(
      await readMergeReadiness(port, {
        repo: 'acme/app',
        pr_number: 7,
        target: 'release/v1',
        head_sha: A,
      }),
    ).toMatchObject({ ready: false, base_sha: 'b'.repeat(40) });
    expect(sent.map((r) => r.path)).toEqual([
      'repos/acme/app/pulls/7',
      'repos/acme/app/branches/release%2Fv1',
      `repos/acme/app/compare/${A}...${'b'.repeat(40)}`,
    ]);
  });

  it('updates to the freshly read target tip when pull.base.sha is an old ancestor', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github({
      pull: { base: { ref: 'main', sha: A } },
      targetSha: 'b'.repeat(40),
      compare: { ahead_by: 1 },
    });
    expect(await advanceTaskPr(deps(d, port, false), t.id)).toBe('updating_base');
    expect(d.task(t.id).run.base_update?.base_sha).toBe('b'.repeat(40));
    expect(sent.some((request) => request.path.endsWith(`/compare/${A}...${'b'.repeat(40)}`))).toBe(
      true,
    );
    expect(puts(sent)).toEqual([]);
  });

  it.each(['clean', 'behind', 'dirty'])(
    'a stale checked head (%s) queues base integration and fresh gates',
    async (mergeable_state) => {
      const d = setup();
      const t = buildTask();
      green(d, t);
      const { port, sent } = github({
        pull: { mergeable_state },
        compare: { ahead_by: 1 },
      });
      expect(await advanceTaskPr(deps(d, port), t.id)).toBe('updating_base');
      expect(puts(sent)).toEqual([]);
      expect(approvals(d, t)).toEqual([]);
      expect(d.task(t.id).head_sha).toBe(A);
      // The gates run at once on the slot the task kept reserved while it waited (FR-044.02).
      expect(d.task(t.id).status).toBe('RUNNING');
      expect(d.pendingOne(t.id, 'run_gates').request).toMatchObject({
        base_update: { head_sha: A, base_sha: 'b'.repeat(40) },
      });
      expect(await advanceTaskPr(deps(d, port), t.id)).toBe('not_waiting');
    },
  );

  it.each(['direct-pr', 'full-review'] as const)(
    '%s: a clean base update reruns gates and CI, without another reviewer',
    async (mode) => {
      const d = setup();
      const t = buildTask();
      green(d, t, mode);
      const oldReviews = d.task(t.id).run.reviews.length;
      const stale = github({ compare: { ahead_by: 1 } });
      expect(await advanceTaskPr(deps(d, stale.port), t.id)).toBe('updating_base');
      // No grant needed: the task kept its slot reserved while it waited for the merge (FR-044.02).
      const fresh = 'c'.repeat(40);
      d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(fresh));
      expect(d.pending(t.id, 'start_agent')).toEqual([]);
      expect(d.task(t.id).run.reviews).toHaveLength(oldReviews);
      expect(d.task(t.id).run.base_update?.certificate?.head_sha).toBe(fresh);
      expect(d.pendingOne(t.id, 'publish').request).toMatchObject({
        sha: fresh,
      });
      expect(await advanceTaskPr(deps(d, github().port), t.id)).toBe('not_waiting');
      d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(fresh));
      if (mode === 'full-review') {
        // The certified update needs no new review: the approval already on the PR is not posted again,
        // and the PR stays ready.
        expect(d.pending(t.id, 'post_review')).toEqual([]);
        d.complete(t.id, d.pendingOne(t.id, 'mark_ready').id, 'succeeded', {
          pr_ref: d.task(t.id).pr_ref,
          ready_at: null,
        });
      }
      expect(d.pendingOne(t.id, 'await_ci').request).toMatchObject({
        head_sha: fresh,
      });
      expect(await advanceTaskPr(deps(d, github().port), t.id)).toBe('not_waiting');
      d.complete(
        t.id,
        d.pendingOne(t.id, 'await_ci').id,
        'succeeded',
        ci(fresh, { build: 'success', test: 'success' }),
      );
      expect(d.task(t.id).wait?.detail.code).toBe('merge');
      // A current read now agrees with the newly certified head and reports successful current checks.
      const remote = github({
        pull: { head: { sha: fresh } },
        checkRuns: {
          check_runs: REQUIRED.map((name, i) => ({
            id: i + 1,
            name,
            head_sha: fresh,
            status: 'completed',
            conclusion: 'success',
            app: { id: 15368 },
          })),
        },
      });
      expect(await advanceTaskPr(deps(d, remote.port), t.id)).toBe('merged');
      expect(puts(remote.sent)[0]?.body).toMatchObject({ sha: fresh });
      expect(replay(d.store.readEvents(t.id))).toEqual(d.task(t.id));
    },
  );

  it('a CI repair after a certified clean base update carries the approval of the head it integrated', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const approval = d.task(t.id).run.reviews[0]!.attempt_id;
    expect(await advanceTaskPr(deps(d, github({ compare: { ahead_by: 1 } }).port), t.id)).toBe(
      'updating_base',
    );
    const integrated = 'c'.repeat(40);
    const repaired = 'd'.repeat(40);
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(integrated));
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(integrated));
    d.complete(t.id, d.pendingOne(t.id, 'mark_ready').id, 'succeeded', {
      pr_ref: d.task(t.id).pr_ref,
      ready_at: null,
    });
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ci(integrated, { build: 'success', test: 'failure' }),
    );
    if (d.task(t.id).wait?.detail['code'] === 'execution_slot') d.grantNext();
    const fixer = d.pendingOne(t.id, 'start_agent');
    expect(d.task(t.id).effects[fixer.id]?.step).toBe('ci_fix');
    expect(d.task(t.id).run.ci_repair).toMatchObject({
      review_attempt_id: approval,
      from_sha: integrated,
    });
    d.complete(t.id, fixer.id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(repaired));
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(repaired));
    // No reviewer for the repair: the approval of A carries through the certified integration.
    expect(d.pending(t.id, 'start_agent')).toEqual([]);
    expect(d.task(t.id).run.ci_fix_carry).toMatchObject({
      review_attempt_id: approval,
      approved_sha: A,
      from_sha: integrated,
      sha: repaired,
    });
    expect(d.task(t.id).run.reviews.map((r) => r.sha)).toEqual([A]);
    d.complete(t.id, d.pendingOne(t.id, 'mark_ready').id, 'succeeded', {
      pr_ref: d.task(t.id).pr_ref,
      ready_at: null,
    });
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ci(repaired, { build: 'success', test: 'success' }),
    );
    expect(d.task(t.id).wait?.detail.code).toBe('merge');
    expect(replay(d.store.readEvents(t.id))).toEqual(d.task(t.id));
  });

  /** Publishes `head` after its gates, turns the PR ready and reads CI on it. */
  const publishAndCi = (
    d: StoreDriver,
    t: CanonicalTask,
    head: string,
    test: 'success' | 'failure',
  ) => {
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(head));
    const pr = d.pending(t.id, 'create_pr');
    if (pr.length === 1)
      d.complete(t.id, pr[0]!.id, 'succeeded', { pr_ref: 'acme#7', head_sha: head });
    d.complete(t.id, d.pendingOne(t.id, 'mark_ready').id, 'succeeded', {
      pr_ref: d.task(t.id).pr_ref,
      ready_at: null,
    });
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ci(head, { build: 'success', test }),
    );
    if (d.task(t.id).wait?.detail['code'] === 'execution_slot') d.grantNext();
  };
  const ciFixTo = (d: StoreDriver, t: CanonicalTask, head: string) => {
    const fixer = d.pendingOne(t.id, 'start_agent');
    expect(d.task(t.id).effects[fixer.id]?.step).toBe('ci_fix');
    d.complete(t.id, fixer.id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(head));
  };
  const carries = (d: StoreDriver, t: CanonicalTask) =>
    d.store
      .readEvents(t.id)
      .flatMap((e) =>
        e.type === 'CiFixApprovalCarried' ? [[e.payload.carry.from_sha, e.payload.carry.sha]] : [],
      );
  const reviewerRuns = (d: StoreDriver, t: CanonicalTask) =>
    Object.values(d.task(t.id).effects).filter(
      (e) => e.kind === 'start_agent' && e.step === 'review',
    ).length;
  /** A full-review task approved on A whose CI failed and whose CI fix B was carried and went green. */
  const repairedGreen = (d: StoreDriver, t: CanonicalTask, b: string) => {
    createGrantStart(d, t, 'full-review', { required_checks: REQUIRED });
    toPublish(d, t, A, { content: { digest: CONTENT_DIGEST, ref: '/content/a.json' } });
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
    d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
      pr_ref: 'acme#7',
      head_sha: A,
    });
    reviewToCi(d, t.id);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ci(A, { build: 'success', test: 'failure' }),
    );
    if (d.task(t.id).wait?.detail['code'] === 'execution_slot') d.grantNext();
    ciFixTo(d, t, b);
    publishAndCi(d, t, b, 'success');
    expect(carries(d, t)).toEqual([[A, b]]);
    expect(d.task(t.id).wait?.detail.code).toBe('merge');
  };

  it('a base conflict fixed with outside files after an earlier CI repair is reviewed, not carried', async () => {
    const d = setup();
    const t = buildTask();
    const b = 'c'.repeat(40);
    const merged = 'd'.repeat(40);
    const conflictTree = 'f'.repeat(40);
    repairedGreen(d, t, b);
    const stale = github({ pull: { head: { sha: b } }, compare: { ahead_by: 1 } });
    expect(await advanceTaskPr(deps(d, stale.port), t.id)).toBe('updating_base');
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', {
      results: [],
      tree: conflictTree,
      stable: true,
      base_conflict: { tree: conflictTree, files: ['src/y.ts'] },
    });
    if (d.task(t.id).wait?.detail['code'] === 'execution_slot') d.grantNext();
    const fixer = d.pendingOne(t.id, 'start_agent');
    expect(d.task(t.id).effects[fixer.id]?.step).toBe('fix_gates');
    // The last worker before the gate fixer is still the earlier ci_fix; this round is the base update's.
    d.complete(
      t.id,
      fixer.id,
      'succeeded',
      agentData('done', {
        worktree_tree: 'e'.repeat(40),
        base_repair: { tree: 'e'.repeat(40), outside_files: ['src/x.ts'], unresolved: false },
      }),
    );
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(merged));
    const s = d.task(t.id);
    expect(s.run.ci_repair).toBeUndefined();
    expect(carries(d, t)).toEqual([[A, b]]);
    expect(s.run.base_update?.scope?.outside_files).toEqual(['src/x.ts']);
    expect(reviewOf(s, merged)).toBe('missing');
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(merged));
    if (d.task(t.id).wait?.detail['code'] === 'execution_slot') d.grantNext();
    expect(reviewerRuns(d, t)).toBe(2);
  });

  it('two clean certified base updates in a row keep the approval of A for the next CI repair', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const approval = d.task(t.id).run.reviews[0]!.attempt_id;
    const first = 'c'.repeat(40);
    const second = 'd'.repeat(40);
    const repaired = 'e'.repeat(40);
    expect(await advanceTaskPr(deps(d, github({ compare: { ahead_by: 1 } }).port), t.id)).toBe(
      'updating_base',
    );
    expect(d.task(t.id).run.base_update?.approved_via).toBe(approval);
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(first));
    publishAndCi(d, t, first, 'success');
    expect(d.task(t.id).wait?.detail.code).toBe('merge');
    const moved = github({
      pull: { head: { sha: first } },
      targetSha: 'f'.repeat(40),
      compare: { ahead_by: 1 },
    });
    expect(await advanceTaskPr(deps(d, moved.port), t.id)).toBe('updating_base');
    // The second update replaced the first one's record, yet keeps the approval that covered its head.
    expect(d.task(t.id).run.base_update).toMatchObject({ head_sha: first, approved_via: approval });
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(second));
    publishAndCi(d, t, second, 'failure');
    ciFixTo(d, t, repaired);
    expect(d.task(t.id).run.ci_fix_carry).toMatchObject({
      review_attempt_id: approval,
      approved_sha: A,
      from_sha: second,
      sha: repaired,
    });
    publishAndCi(d, t, repaired, 'success');
    expect(reviewerRuns(d, t)).toBe(1);
    expect(d.task(t.id).wait?.detail.code).toBe('merge');
    expect(replay(d.store.readEvents(t.id))).toEqual(d.task(t.id));
    // A newer verdict of the revision breaks the link: the certified head is no longer covered.
    const later = structuredClone(d.task(t.id));
    later.run.reviews.push({
      ...later.run.reviews[0]!,
      attempt_id: 'later',
      verdict: 'request_changes',
    });
    expect(approvalCovering(later, second)).toBeUndefined();
  });

  it('an old log of two certified base updates without approved_via keeps the approval of A on replay', async () => {
    const d0 = setup();
    const t = buildTask();
    green(d0, t);
    const approval = d0.task(t.id).run.reviews[0]!.attempt_id;
    const first = 'c'.repeat(40);
    const second = 'd'.repeat(40);
    const repaired = 'e'.repeat(40);
    expect(await advanceTaskPr(deps(d0, github({ compare: { ahead_by: 1 } }).port), t.id)).toBe(
      'updating_base',
    );
    d0.complete(t.id, d0.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(first));
    publishAndCi(d0, t, first, 'success');
    const moved = github({
      pull: { head: { sha: first } },
      targetSha: 'f'.repeat(40),
      compare: { ahead_by: 1 },
    });
    expect(await advanceTaskPr(deps(d0, moved.port), t.id)).toBe('updating_base');
    d0.complete(t.id, d0.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(second));
    publishAndCi(d0, t, second, 'failure');
    // Both certificates already exist when the old release is replaced.
    // The same log as a release before `approved_via` wrote it, loaded into a fresh SQLite store.
    const events = d0.store.readEvents(t.id);
    const old = events.map(({ type, revision, actor, payload }): DomainEventDraft => {
      if (type !== 'BaseUpdateRecorded')
        return { type, revision, actor, payload } as DomainEventDraft;
      const { approved_via: _via, ...update } = payload.update;
      return { type, revision, actor, payload: { update } };
    });
    expect(JSON.stringify(old)).not.toContain('approved_via');
    expect(
      old.filter(
        (e) => e.type === 'BaseUpdateRecorded' && e.payload.update.certificate !== undefined,
      ),
    ).toHaveLength(2);
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())), 7);
    injectEvents(d.store, t.id, old);
    d.now = d0.now;
    expect(d.task(t.id).run.base_update).toMatchObject({ head_sha: first, approved_via: approval });
    ciFixTo(d, t, repaired);
    expect(d.task(t.id).run.ci_fix_carry).toMatchObject({
      review_attempt_id: approval,
      approved_sha: A,
      from_sha: second,
      sha: repaired,
    });
    publishAndCi(d, t, repaired, 'success');
    expect(reviewerRuns(d, t)).toBe(1);
    expect(replay(d.store.readEvents(t.id))).toEqual(d.task(t.id));
    // A newer verdict of the revision breaks the derived link as it does a recorded one.
    const later = structuredClone(d.task(t.id));
    later.run.reviews.push({
      ...later.run.reviews[0]!,
      attempt_id: 'later',
      verdict: 'request_changes',
    });
    expect(approvalCovering(later, second)).toBeUndefined();
  });

  it('a base-update retry retains its durable head/base intent and remains subject to cancellation', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    expect(await advanceTaskPr(deps(d, github({ compare: { ahead_by: 1 } }).port), t.id)).toBe(
      'updating_base',
    );
    const gate = d.pendingOne(t.id, 'run_gates');
    d.complete(t.id, gate.id, 'failed', {
      failure_class: 'infra',
      message: 'temporary fetch failure',
    });
    const timer = Object.values(d.task(t.id).timers).find(
      (entry) => entry.kind === 'backoff' && entry.status === 'armed',
    );
    expect(timer?.payload.resume).toMatchObject({
      base_update: { head_sha: A, base_sha: 'b'.repeat(40) },
    });
    expect(replay(d.store.readEvents(t.id))).toEqual(d.task(t.id));
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    if (timer !== undefined) {
      d.now = timer.due_at;
      d.fire();
    }
    expect(d.pending(t.id, 'run_gates')).toEqual([]);
  });

  it.each(['clean', 'behind', 'dirty'])(
    'yolo off still integrates a stale/conflicted PR (%s), without approving a merge',
    async (mergeable_state) => {
      const d = setup();
      const t = buildTask();
      green(d, t);
      const { port, sent } = github({
        pull: { mergeable_state },
        compare: { ahead_by: 1 },
      });
      const enabled = () => {
        throw new Error('base maintenance must not read yolo config');
      };
      expect(await advanceTaskPr({ ...deps(d, port, false), enabled }, t.id)).toBe('updating_base');
      expect(d.pendingOne(t.id, 'run_gates').request).toMatchObject({
        base_update: { head_sha: A },
      });
      expect(approvals(d, t)).toEqual([]);
      expect(puts(sent)).toEqual([]);
    },
  );

  it('cancellation while reading the base prevents maintenance', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const remote = github({ compare: { ahead_by: 1 } });
    const port: GitHubPort = {
      request: async (request) => {
        const result = await remote.port.request(request);
        if (request.path.includes('/compare/')) d.must(t.id, { kind: 'cancel', reason: 'stop' });
        return result;
      },
    };
    expect(await advanceTaskPr(deps(d, port, false), t.id)).toBe('not_approved');
    expect(d.pending(t.id, 'run_gates')).toEqual([]);
    expect(puts(remote.sent)).toEqual([]);
  });

  it('an additional GitHub requirement still has to pass', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github({
      protection: {
        required_status_checks: { contexts: [...REQUIRED, 'security'] },
      },
    });
    expect(await advanceTaskPr(deps(d, port), t.id)).toBe('not_ready');
    expect(puts(sent)).toEqual([]);
  });

  // Through the production port: the last check is one GraphQL answer its allowlist lets through.
  it('the last check reads PR and target tip from one GraphQL answer, and fails closed on a partial one', async () => {
    const TIP = 'c'.repeat(40);
    const answer = (pr: Record<string, unknown> | null) => ({
      data: { repository: { pullRequest: pr } },
    });
    const pr = {
      state: 'OPEN',
      isDraft: false,
      headRefOid: A,
      baseRefName: 'goal/x',
      baseRef: { target: { oid: TIP } },
    };
    const check = async (body: unknown) => {
      const exec = fixtureExec({ 'POST graphql': [{ status: 200, body }] });
      const port = new GhPort({
        exec,
        clock: { now: () => 0 as EpochMs, monotonic: () => 0 },
        redactor: new Redactor({ values: [] }),
      });
      const r = await confirmPull(port, {
        repo: 'acme/app',
        pr_number: 7,
        target: 'goal/x',
        head_sha: A,
      });
      return { r, exec };
    };
    const ok = await check(answer(pr));
    expect(ok.r).toEqual({ ok: true, tip: TIP });
    expect(ok.exec.calls).toHaveLength(1);
    expect(JSON.parse(ok.exec.calls[0]?.stdin ?? '{}')).toMatchObject({
      variables: { owner: 'acme', name: 'app', number: 7 },
    });
    // Moved to main in the same answer: not this target, and its tip is no goal branch tip.
    expect((await check(answer({ ...pr, baseRefName: 'main' }))).r).toEqual({
      ok: false,
      reason: 'target does not match',
      tip: null,
    });
    expect((await check(answer({ ...pr, isDraft: true }))).r).toMatchObject({
      ok: false,
      tip: TIP,
    });
    expect((await check(answer({ ...pr, baseRef: null }))).r).toEqual({ ok: true, tip: null });
    for (const partial of [
      answer(null),
      answer({ ...pr, isDraft: undefined }),
      { errors: [{ message: 'Resource not accessible by integration' }] },
      // Full data next to errors is not trusted either.
      { ...answer(pr), errors: [{ message: 'Something went wrong' }] },
    ])
      expect((await check(partial)).r).toMatchObject({ ok: false, tip: null });
  });

  it('the compare allowlist accepts only a full head SHA and an encoded target branch', async () => {
    let tick = 0;
    const valid = [`repos/o/r/compare/${A}...main`, `repos/o/r/compare/${A}...release%2Fv1.0`];
    const calls: string[] = [];
    const exec = fixtureExec(
      Object.fromEntries(
        valid.map((path) => [`GET ${path}`, [{ status: 200, body: { ahead_by: 0 } }]]),
      ),
    );
    const port = new GhPort({
      exec: (args, opts) => {
        calls.push(args.join(' '));
        return exec(args, opts);
      },
      clock: { now: () => tick as EpochMs, monotonic: () => tick++ },
      redactor: new Redactor({ values: [] }),
    });
    for (const path of valid)
      expect(await port.request({ method: 'GET', path, query: {}, body: null })).toMatchObject({
        ok: true,
      });
    for (const path of [
      `repos/o/r/compare/${A}..main`,
      `repos/o/r/compare/${A}....main`,
      `repos/o/r/compare/${A.slice(1)}...main`,
      'repos/o/r/compare/branch...main',
      `repos/o/r/compare/${A}...release/v1`,
      `repos/o/r/compare/${A}...main/files`,
      `repos/o/r/compare/${A}...main?page=1`,
      `repos/o/r/compare/${A}...main#x`,
      `repos/o/r/compare/${A}...main%2`,
      `repos/o/r/compare/${A}...`,
      `repos/o/r/compare/${A.toUpperCase()}...main`,
      `repos/o/r/compare/main...${A}`,
    ])
      expect(await port.request({ method: 'GET', path, query: {}, body: null })).toMatchObject({
        ok: false,
        error: { reason: 'not_allowed' },
      });
    expect(calls).toHaveLength(valid.length);
  });

  it.each(['neutral', 'skipped'])(
    'a required check that became %s still merges, as GitHub accepts it (#208)',
    async (conclusion) => {
      const d = setup();
      const t = buildTask();
      green(d, t);
      const { port, sent } = github({
        checks: { build: 'success', test: conclusion },
      });
      expect(await advanceTaskPr(deps(d, port), t.id)).toBe('merged');
      expect(puts(sent)).toHaveLength(1);
    },
  );

  it.each(['failure', 'cancelled', 'timed_out', 'stale'])(
    'skipped required checks do not merge while an optional check is %s (#208)',
    async (conclusion) => {
      const d = setup();
      const t = buildTask();
      green(d, t);
      const { port, sent } = github({
        checks: { changes: conclusion, build: 'skipped', test: 'skipped' },
      });
      expect(await advanceTaskPr(deps(d, port), t.id)).toBe('not_ready');
      expect(puts(sent)).toEqual([]);
      expect(approvals(d, t)).toEqual([]);
    },
  );

  it('docs-only PR: changes succeeded and the required build/test were skipped, so it merges (#208)', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github({
      checks: { changes: 'success', build: 'skipped', test: 'skipped' },
    });
    expect(await advanceTaskPr(deps(d, port), t.id)).toBe('merged');
    expect(puts(sent)).toHaveLength(1);
  });

  it('a draft PR is not merged and no approval is recorded, though GitHub says clean', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github({ pull: { draft: true } });
    expect(await advanceTaskPr(deps(d, port), t.id)).toBe('not_ready');
    expect(puts(sent)).toEqual([]);
    expect(approvals(d, t)).toEqual([]);
  });

  it.each([
    ['back to a draft', { draft: true }],
    ['with no draft state', { draft: undefined }],
  ] as const)('green checks of a PR %s are recorded, but never as a CI pass', async (_, pull) => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr', { required_checks: REQUIRED }, OBS_RUNTIME);
    toPublish(d, t, A, { content: { digest: CONTENT_DIGEST, ref: '/content/a.json' } });
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
    d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
      pr_ref: 'acme#7',
      head_sha: A,
    });
    reviewToCi(d, t.id);
    const { port } = github({ pull });
    const read = await observeTaskPr(deps(d, port), t.id, 'draft-again', 'timer');
    expect(read.ci).toMatchObject({
      pr_draft: true,
      required_set: { complete: false },
      checks: [
        { name: 'build', state: 'success' },
        { name: 'test', state: 'success' },
      ],
    });
    d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', read.ci);
    expect(d.task(t.id)).toMatchObject({
      current_step: 'ci',
      wait: { detail: { code: 'checks_incomplete', complete: false } },
    });
    for (const fact of read.facts) d.must(t.id, fact);
    expect(d.task(t.id).wait?.detail.code).not.toBe('merge');
  });

  it('a PR that went back to a draft while its checks were read gets no approval', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github({ pullReads: [{}, { draft: true }] });
    expect(await advanceTaskPr(deps(d, port), t.id)).toBe('not_ready');
    expect(puts(sent)).toEqual([]);
    expect(approvals(d, t)).toEqual([]);
    // The PR is read once more after the checks, right before the approval.
    const pulls = sent.filter((q) => q.path === 'repos/acme/app/pulls/7' || q.path === 'graphql');
    expect(pulls).toHaveLength(2);
  });

  it('a head drift is recorded although GitHub rate-limits the checks; a limit alone schedules the retry', async () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr', { required_checks: REQUIRED }, OBS_RUNTIME);
    toPublish(d, t, A, { content: { digest: CONTENT_DIGEST, ref: '/content/a.json' } });
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
    d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
      pr_ref: 'acme#7',
      head_sha: A,
    });
    reviewToCi(d, t.id);
    const B = 'b'.repeat(40);
    const limit = { status: 429, retry_after_ms: null };
    const moved = github({
      pull: { head: { sha: B, ref: 'cusr/t' } },
      checkRunsStatus: limit,
    });
    const drift = await observeTaskPr(deps(d, moved.port), t.id, 'drift-429', 'timer');
    expect(drift.facts).toContainEqual(
      expect.objectContaining({ kind: 'head_drift', expected: A, observed: B }),
    );
    expect(drift.retry_after_ms).toBeUndefined();
    const same = github({ checkRunsStatus: limit });
    const limited = await observeTaskPr(deps(d, same.port), t.id, 'limit-429', 'timer');
    expect(limited).toMatchObject({ ci: null, retry_after_ms: 60_000 });
    expect(limited.facts.some((f) => f.kind === 'head_drift')).toBe(false);
  });

  it('a PR retargeted while readiness was read gets no approval: the PR is read last', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    // The second readiness read still sees main; the PR read after it sees the new target.
    const { port, sent } = github({
      pullReads: [{}, {}, { base: { ref: 'release', sha: 'b'.repeat(40), repo: { id: 1 } } }],
    });
    expect(await advanceTaskPr(deps(d, port), t.id)).toBe('not_ready');
    expect(approvals(d, t)).toEqual([]);
    expect(puts(sent)).toEqual([]);
    // The last read is the one GraphQL check of the PR and its target's tip.
    expect(sent.at(-1)).toMatchObject({ method: 'POST', path: 'graphql' });
  });

  it.each([
    ['with Retry-After', 120_000, 120_000],
    ['without Retry-After', null, 60_000],
  ] as const)(
    'GitHub’s rate limit on the checks holds the next merge passes until it ends (%s)',
    async (_, retryAfter, wait) => {
      const d = setup();
      const t = buildTask();
      green(d, t);
      const limited = github({ checkRunsStatus: { status: 429, retry_after_ms: retryAfter } });
      const ds = deps(d, limited.port);
      expect(await advanceTaskPr(ds, t.id)).toBe('not_ready');
      const before = limited.sent.length;
      const fresh = github();
      const again = { ...ds, github: () => fresh.port };
      expect(await advanceTaskPr(again, t.id)).toBe('not_ready');
      expect(fresh.sent).toEqual([]);
      expect(limited.sent).toHaveLength(before);
      d.now += wait;
      expect(await advanceTaskPr(again, t.id)).toBe('merged');
    },
  );

  /** A check run made by workflow run `id + 1000`, itself made at `made` (see `workflowsOf`). */
  const run = (id: number, name: string, conclusion: string, made: string, wf = id + 1000) => ({
    id,
    name,
    head_sha: A,
    status: 'completed',
    conclusion,
    started_at: made,
    completed_at: made,
    details_url: `https://github.com/acme/app/actions/runs/${wf}/job/${id}`,
    app: { id: 15368 },
  });
  const workflowsOf = (runs: ReturnType<typeof run>[]) =>
    Object.fromEntries(
      runs.map((r) => [Number(/runs\/(\d+)\//.exec(r.details_url)?.[1]), r.started_at]),
    );

  // PR #36 of a dogfood repo: turned ready by a person, so the task held no ready time, while the
  // skipped runs of the draft were the only ones on the head.
  it('skipped runs started before the PR’s ready event are no pass, though the task holds no ready time', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const events = [{ event: 'ready_for_review', created_at: '2026-11-18T01:17:20Z' }];
    const draftRuns = [
      run(1, 'build', 'skipped', '2026-11-17T23:19:24Z'),
      run(2, 'test', 'skipped', '2026-11-17T23:19:24Z'),
    ];
    const draftOnly = github({
      checkRuns: { check_runs: draftRuns },
      events,
      workflows: workflowsOf(draftRuns),
    });
    expect(await advanceTaskPr(deps(d, draftOnly.port), t.id)).toBe('not_ready');
    expect(puts(draftOnly.sent)).toEqual([]);
    expect(approvals(d, t)).toEqual([]);
    const readyRuns = [
      ...draftRuns,
      run(3, 'build', 'success', '2026-11-18T01:30:00Z'),
      run(4, 'test', 'success', '2026-11-18T01:30:00Z'),
    ];
    const ready = github({
      checkRuns: { check_runs: readyRuns },
      events,
      workflows: workflowsOf(readyRuns),
    });
    expect(await advanceTaskPr(deps(d, ready.port), t.id)).toBe('merged');
  });

  // Issue #362: the draft's skipped workflow run is dated after the ready event; the ready run has not
  // produced its checks yet. Nothing may be sent until they pass.
  it('a required skip after a draft stops the merge, however its run looks, until the required checks succeed', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const events = [{ event: 'ready_for_review', created_at: '2026-11-18T01:17:20Z' }];
    const late = '2026-11-18T01:17:21Z';
    const lateSkips = [run(1, 'build', 'skipped', late), run(2, 'test', 'skipped', late)];
    const stages = [
      lateSkips,
      [
        ...lateSkips,
        { ...run(3, 'changes', 'success', '2026-11-18T01:17:24Z'), status: 'in_progress' },
      ],
      // A succeeded sibling of the same workflow run attributes nothing.
      [
        run(1, 'build', 'skipped', late, 77),
        run(2, 'test', 'skipped', late, 77),
        run(3, 'changes', 'success', late, 77),
      ],
      // A success beside an unfinished older run of the check, in both orders.
      [
        run(5, 'build', 'success', late),
        { ...run(4, 'build', 'success', late), status: 'in_progress' },
        run(6, 'test', 'success', late),
      ],
      [
        run(4, 'build', 'success', late),
        { ...run(5, 'build', 'success', late), status: 'in_progress' },
        run(6, 'test', 'success', late),
      ],
    ];
    for (const runs of stages) {
      const waiting = github({
        checkRuns: { check_runs: runs },
        events,
        workflows: workflowsOf(runs),
      });
      expect(await advanceTaskPr(deps(d, waiting.port), t.id)).toBe('not_ready');
      expect(puts(waiting.sent)).toEqual([]);
      expect(approvals(d, t)).toEqual([]);
    }
    const readyRuns = [
      ...lateSkips,
      run(4, 'build', 'success', '2026-11-18T01:30:00Z'),
      run(5, 'test', 'success', '2026-11-18T01:30:00Z'),
    ];
    const done = github({
      checkRuns: { check_runs: readyRuns },
      events,
      workflows: workflowsOf(readyRuns),
    });
    expect(await advanceTaskPr(deps(d, done.port), t.id)).toBe('merged');
  });

  it('turned ready a second time: no skip after the second draft passes, whichever run made it', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const events = [
      { event: 'ready_for_review', created_at: '2026-11-17T10:00:00Z' },
      { event: 'convert_to_draft', created_at: '2026-11-17T20:00:00Z' },
      { event: 'ready_for_review', created_at: '2026-11-18T01:17:20Z' },
    ];
    const secondDraft = [
      run(1, 'build', 'skipped', '2026-11-17T23:19:24Z'),
      run(2, 'test', 'skipped', '2026-11-17T23:19:24Z'),
    ];
    const stale = github({
      checkRuns: { check_runs: secondDraft },
      events,
      workflows: workflowsOf(secondDraft),
    });
    expect(await advanceTaskPr(deps(d, stale.port), t.id)).toBe('not_ready');
    expect(approvals(d, t)).toEqual([]);
    const docsRuns = [
      ...secondDraft,
      run(3, 'build', 'skipped', '2026-11-18T01:17:30Z', 77),
      run(4, 'test', 'skipped', '2026-11-18T01:17:30Z', 77),
      run(5, 'changes', 'success', '2026-11-18T01:17:30Z', 77),
    ];
    const docsOnly = github({
      checkRuns: { check_runs: docsRuns },
      events,
      workflows: workflowsOf(docsRuns),
    });
    expect(await advanceTaskPr(deps(d, docsOnly.port), t.id)).toBe('not_ready');
    expect(approvals(d, t)).toEqual([]);
  });

  it.each(['stale', 'cancelled', 'timed_out', 'action_required', 'startup_failure'])(
    'a check that became %s after the observation stops the merge, though GitHub says clean',
    async (conclusion) => {
      const d = setup();
      const t = buildTask();
      green(d, t);
      const { port, sent } = github({
        checks: { build: 'success', test: conclusion },
      });
      expect(await advanceTaskPr(deps(d, port), t.id)).toBe('not_ready');
      expect(puts(sent)).toEqual([]);
      expect(approvals(d, t)).toEqual([]);
    },
  );

  it('a required check with no current run stops the merge', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github({ checks: { build: 'success' } });
    expect(await advanceTaskPr(deps(d, port), t.id)).toBe('not_ready');
    expect(puts(sent)).toEqual([]);
  });

  it('a cancel recorded while the config is read for the last time stops the merge', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    const { port, sent } = github();
    let reads = 0;
    const r = await advanceTaskPr(
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
    await advanceTaskPr(
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
    await advanceTaskPr(deps(d, again.port), t.id);
    expect(puts(again.sent)[0]?.body).toEqual(puts(lost.sent)[0]?.body);
    expect(asked).toEqual([approvals(d, t)[0]?.content_digest]);

    const unread = github();
    expect(await advanceTaskPr({ ...deps(d, unread.port), content: () => null }, t.id)).toBe(
      'not_ready',
    );
    expect(puts(unread.sent)).toEqual([]);
  });

  it('a cancelled task is not merged', async () => {
    const d = setup();
    const t = buildTask();
    green(d, t);
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    const { port, sent } = github();
    expect(await advanceTaskPr(deps(d, port), t.id)).toBe('not_waiting');
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

describe('a PR head a worker pushed from the task worktree (no drift)', () => {
  const B = 'c'.repeat(40);
  /** Local Git that knows `line` as ancestry pairs `a>b` (a is an ancestor of b). */
  const localGit = (line: readonly string[]) => ({
    git: {
      run: (cmd: { args: readonly string[] }) => {
        const [, , a, b] = cmd.args;
        return Promise.resolve({
          kind: 'exited' as const,
          code: line.includes(`${a}>${b}`) ? 0 : 1,
          stdout: '',
          stderr: '',
          truncated: false,
        });
      },
    },
    worktrees: '/worktrees',
  });

  it.each([
    ['without a local check', undefined, true],
    [
      'on the line from the pushed head to the worktree HEAD',
      localGit([`${A}>${B}`, `${B}>HEAD`]),
      false,
    ],
    ['not in the worktree history', localGit([`${A}>${B}`]), true],
    ['not after the pushed head', localGit([`${B}>HEAD`]), true],
  ] as const)('%s', async (_name, local, drift) => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t, 'direct-pr', { required_checks: REQUIRED }, OBS_RUNTIME, {
      content: { digest: CONTENT_DIGEST, ref: '/content/a.json' },
    });
    const { port } = github({ pull: { head: { sha: B, ref: 'cusr/t' } } });
    const read = await observeTaskPr(
      { ...deps(d, port), ...(local === undefined ? {} : { local }) },
      t.id,
      'worker-push',
      'timer',
    );
    expect(read.facts.some((f) => f.kind === 'head_drift')).toBe(drift);
  });
});
