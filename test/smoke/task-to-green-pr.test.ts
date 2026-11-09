/**
 * T121/T127 (SC-001/002): the fixture projects, a local rehearsal of the whole path through the CLI, and
 * the opt-in run on real sandbox repos. Only the last one is evidence for SC-001.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { validateConfig } from '../../src/config/validate.ts';
import { loadRealSmoke, REAL_KINDS, RealRun, RealSmokeSchema } from '../support/smoke-real.ts';
import {
  filesUnder,
  git,
  hostUsable,
  PROJECT_KINDS,
  PROJECTS_DIR,
  Rehearsal,
  repoDir,
  SANDBOX_PROJECT,
  smokeUserConfig,
  taskFile,
  waitCode,
} from '../support/smoke.ts';

const BUILT_CUSRD = fileURLToPath(new URL('../../dist/cli/cusrd.js', import.meta.url));
const live: Rehearsal[] = [];
afterEach(async () => {
  for (const r of live.splice(0)) await r.cleanup();
});

const userConfig = (kind: (typeof PROJECT_KINDS)[number]) =>
  smokeUserConfig({
    dataDir: '/tmp/cusr-smoke-config-check',
    projects: {
      [SANDBOX_PROJECT[kind]]: { path: '/srv/repo', repo: 'owner/repo' },
    },
    credentialRefs: { claude: '/srv/credentials/claude.json' },
    worker: 'claude',
  });

describe.each(PROJECT_KINDS)('%s fixture project', (kind) => {
  const cusr = readFileSync(join(repoDir(kind), 'cusr.yaml'), 'utf8');

  it('validates with the smoke user config and selects its profile', () => {
    const r = validateConfig({
      user: { file: 'config.yaml', text: userConfig(kind) },
      project: { file: 'cusr.yaml', text: cusr },
      packs: {},
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.config.project?.profile).toBe('smoke');
  });

  it('requires a nonempty set of checks, each a job of its CI workflow', () => {
    const required = (parse(cusr) as { ci: { required_checks: string[] } }).ci.required_checks;
    const workflow = parse(
      readFileSync(join(repoDir(kind), '.github/workflows/ci.yml'), 'utf8'),
    ) as { on: unknown; jobs: Record<string, unknown> };
    expect(required.length).toBeGreaterThan(0);
    expect(Object.keys(workflow.jobs)).toEqual(expect.arrayContaining(required));
    expect(workflow.on).toHaveProperty('pull_request');
  });

  it('has a task for its sandbox project with concrete acceptance', () => {
    const task = JSON.parse(readFileSync(taskFile(kind), 'utf8')) as {
      project: string;
      base_branch: string;
      acceptance: string[];
    };
    expect(task.project).toBe(SANDBOX_PROJECT[kind]);
    expect(task.base_branch).toBe('main');
    expect(task.acceptance.length).toBeGreaterThan(0);
  });
});

it('keeps secrets out of the fixtures and credentials as references in the config', () => {
  const secretLike =
    /(sk-ant-|gh[opsu]_[A-Za-z0-9]{8}|github_pat_|"?(accessToken|refresh_token|api_key)"?\s*[:=])/;
  for (const f of filesUnder(PROJECTS_DIR))
    expect(readFileSync(join(PROJECTS_DIR, f), 'utf8'), f).not.toMatch(secretLike);
  const refs = (
    parse(userConfig('node')) as {
      runtime: { credential_refs: Record<string, string> };
    }
  ).runtime.credential_refs;
  for (const v of Object.values(refs)) expect(v).toMatch(/^\//);
});

describe('the real run configuration', () => {
  it('is off unless asked for, and a bad file is an error rather than a skip', () => {
    expect(loadRealSmoke({})).toBeNull();
    expect(() => loadRealSmoke({ CUSR_SMOKE_REAL: '/nonexistent' })).toThrow();
    expect(RealSmokeSchema.safeParse({ approval: '' }).success).toBe(false);
  });
});

describe.skipIf(!hostUsable())('local rehearsal through the CLI', () => {
  it.each([
    ['node', 'claude'],
    ['python', 'codex'],
  ] as const)(
    '%s, %s coder and the other vendor reviewing: one green PR, then DONE after a merge',
    async (kind, worker) => {
      const r = new Rehearsal({
        kind,
        worker,
        mode: 'full-review',
        coder: 'pass',
      });
      live.push(r);
      await r.startDaemon();
      const doctor = await r.cli('doctor');
      const manifests = (doctor.env.data['checks'] ??
        (doctor.env.error?.details as { checks: unknown[] }).checks) as {
        name: string;
        status: string;
      }[];
      expect(manifests.filter((c) => c.name.startsWith('manifest:')).map((c) => c.status)).toEqual([
        'ok',
        'ok',
      ]);

      const id = await r.addTask();
      const waiting = await r.untilMergeWait(id);
      expect(waiting['status']).toBe('WAITING');
      expect(waiting['completion']).toBeNull();

      const gh = r.github();
      expect(gh.prs).toHaveLength(1);
      const pr = gh.prs[0] as (typeof gh.prs)[number];
      expect(pr.head.sha).toBe(waiting['head_sha']);
      expect(waiting['pr_ref']).toBe(`acme/${kind}-sandbox#${pr.number}`);
      // The rule sources were read and said "none": no protection is an answer, not a missing one.
      expect(gh.calls.some((c) => c.includes('/rules/branches/'))).toBe(true);
      expect(gh.calls.some((c) => /\/branches\/main$/.test(c))).toBe(true);
      expect(gh.calls.filter((c) => !c.startsWith('GET '))).toEqual([
        expect.stringMatching(/^POST repos\/.*\/pulls$/),
      ]);
      // The pushed head holds the agent's work, on the remote, with nothing typed by hand.
      expect(git(r.remote, 'rev-parse', `refs/heads/${pr.head.ref}`)).toBe(pr.head.sha);
      expect(git(r.remote, 'log', '--format=%an', '-1', pr.head.sha)).toBe('Cuesura');

      const explain = await r.must('task', 'explain', id);
      expect(explain['allowed_actions']).toContainEqual(
        expect.objectContaining({ action: 'merge_manually' }),
      );
      const logs = await r.cli('task', 'logs', id, '--after', '0');
      expect(logs.code).toBe(0);

      r.merge(pr.number, 'c'.repeat(40));
      const done = await r.untilDone(id);
      expect(done['completion']).toMatchObject({
        merged_head_sha: pr.head.sha,
        checked_head_sha: pr.head.sha,
        merge_commit_sha: 'c'.repeat(40),
      });
    },
    180_000,
  );
});

describe.skipIf(!hostUsable() || !existsSync(BUILT_CUSRD))(
  'the real driver on the built binaries, no task and no model',
  () => {
    it('starts cusrd, answers doctor through cusr and stops', async () => {
      const r = new Rehearsal({
        kind: 'node',
        worker: 'claude',
        mode: 'direct-pr',
        coder: 'pass',
      });
      live.push(r);
      const direction = {
        config: r.configPath,
        data_dir: r.dataDir,
        repo: 'acme/node-sandbox',
        run: {
          profile: 'smoke',
          mode: 'direct-pr' as const,
          worker: 'claude/claude-worker/low',
          reviewer: null,
        },
      };
      const built = new RealRun(
        {
          approval: 'no model is called',
          ledger: join(r.base, 'ledger.jsonl'),
          node: direction,
          python: direction,
        },
        'node',
      );
      await built.startDaemon();
      try {
        const doctor = await built.cli('doctor');
        expect(JSON.stringify(doctor.env)).toContain('manifest:claude');
      } finally {
        await built.stopDaemon('SIGTERM');
      }
    }, 120_000);
  },
);

// T127. Needs CUSR_SMOKE_REAL and a build; spends model usage and opens one PR on each sandbox.
const real = loadRealSmoke();
describe.skipIf(real === null).each(REAL_KINDS)('real run on the %s sandbox', (kind) => {
  it('reaches one green PR through the CLI and stays unmerged until a person merges', async () => {
    const r = new RealRun(real as NonNullable<typeof real>, kind);
    await r.startDaemon();
    try {
      const id = await r.addTask();
      const waiting = await r.untilMergeWait(id, 3_600_000);
      expect(waiting['completion']).toBeNull();
      const prRef = waiting['pr_ref'] as string;
      const pull = r.pull(prRef);
      expect(pull).toMatchObject({
        state: 'open',
        merged: false,
        head_sha: waiting['head_sha'],
      });
      expect(waitCode(waiting)).toBe('merge');
      r.record('T127', {
        task_id: id,
        pr_ref: prRef,
        head_sha: waiting['head_sha'],
        provenance: waiting['provenance'],
        cusr_version: spawnSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).stdout.trim(),
      });
    } finally {
      await r.stopDaemon('SIGTERM');
    }
  }, 3_700_000);
});
