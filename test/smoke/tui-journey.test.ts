/**
 * T079 / SC-004 with the real harnesses: the journey of `test/contract/tui/journey.test.ts`, typed into the
 * built `cusr` on a PTY against the built daemon, a real vendor and a private sandbox repo. The node
 * direction's worker is Claude and the python direction's Codex, the other vendor reviewing; each runs both
 * modes, whatever `run.mode` its direction names. The test never merges: once the daemon waits for a merge on
 * a head GitHub reports green, it prints the PR and head, an operator merges by hand, and the TUI is watched
 * to DONE. Without both opt-ins only the fixture checks run, reading no user config and starting no daemon.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { STORE_FILE } from '../../src/daemon/main.ts';
import { KEY, PtySession } from '../support/pty.ts';
import {
  configProblem,
  loadRealSmoke,
  matrixProblem,
  notGreen,
  notVerifiedDone,
  prNumber,
  REAL_KINDS,
  RealRun,
  requiredChecks,
  sandboxProblem,
  unfinishedTasks,
  type Attempt,
  type CheckRun,
} from '../support/smoke-real.ts';
import { waitCode, type ProjectKind } from '../support/smoke.ts';
import { flat, pressAction, ROOMY, selectedLine, selectTaskId } from '../support/tui-fixtures.ts';

const CUSR = fileURLToPath(new URL('../../dist/cli/cusr.js', import.meta.url));
const LEDGER = fileURLToPath(
  new URL('../../specs/004-terminal-tui/evidence/t079-smoke-ledger.jsonl', import.meta.url),
);
const AGENT_MS = 40 * 60_000;
const MERGE_MS = 60 * 60_000;
const MODES = ['direct-pr', 'full-review'] as const;
type Mode = (typeof MODES)[number];

/** A small change whose one open choice only the owner can make, so the coder has to ask. */
const TASKS: Record<
  ProjectKind,
  Record<Mode, { title: string; description: string; acceptance: string }>
> = {
  node: {
    'direct-pr': {
      title: 'Add truncate to the strings module',
      description:
        'Add a named export truncate(text, max) to src/strings.js: text longer than max is cut and ends with a marker, cover it in test/strings.test.js. The marker is the owner choice and is not written here: before changing any file, return needs_input and ask which marker to use. Do not pick one yourself.',
      acceptance: 'truncate uses the marker the owner gave; build, unit and lint gates pass',
    },
    'full-review': {
      title: 'Add initials to the strings module',
      description:
        'Add a named export initials(name) to src/strings.js that joins the first letter of each word, cover it in test/strings.test.js. The separator between letters is the owner choice and is not written here: before changing any file, return needs_input and ask which separator to use. Do not pick one yourself.',
      acceptance: 'initials uses the separator the owner gave; build, unit and lint gates pass',
    },
  },
  python: {
    'direct-pr': {
      title: 'Add truncate to the strings module',
      description:
        'Add truncate(text, max) to src/slugs/strings.py: text longer than max is cut and ends with a marker, cover it in tests/test_strings.py. The marker is the owner choice and is not written here: before changing any file, return needs_input and ask which marker to use. Do not pick one yourself.',
      acceptance: 'truncate uses the marker the owner gave; build, unit and lint gates pass',
    },
    'full-review': {
      title: 'Add initials to the strings module',
      description:
        'Add initials(name) to src/slugs/strings.py that joins the first letter of each word, cover it in tests/test_strings.py. The separator between letters is the owner choice and is not written here: before changing any file, return needs_input and ask which separator to use. Do not pick one yourself.',
      acceptance: 'initials uses the separator the owner gave; build, unit and lint gates pass',
    },
  },
};
const ANSWER: Record<Mode, string> = {
  'direct-pr': 'Use three dots: ...',
  'full-review': 'Use a dot after each letter, like J.R.',
};

type Selection = Parameters<typeof matrixProblem>[2];
type LedgerLine = {
  scenario: string;
  kind: ProjectKind;
  mode: Mode;
  task_id: string;
  pr_ref: string;
  head_sha: string;
  completion: Record<string, unknown>;
  selection: Selection;
};
const ledgerLines = (file: string): LedgerLine[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as LedgerLine)
    .filter((l) => l.scenario === 'T079');

const said = (s: PtySession, text: string, ms = 30_000): Promise<void> =>
  s.waitFor(() => flat(s.screenText()).includes(text), ms);

function tui(r: RealRun): PtySession {
  return new PtySession({
    entry: CUSR,
    cols: ROOMY.cols,
    rows: ROOMY.rows,
    cwd: r.direction.data_dir,
    env: { CUSR_DATA_DIR: r.direction.data_dir, CUSR_ACTOR: undefined },
  });
}

/** The TUI's own word on the task with this ID: its Home row says it finished. */
async function seenFinished(s: PtySession, id: string): Promise<void> {
  await selectTaskId(s, id);
  await s.waitFor(() => /Finished/.test(selectedLine(s.screenText())), 60_000);
}

/** Time at the keys, every PTY step counted, kept apart from each wait for the agent, CI or the operator. */
class Clock {
  pty = 0;
  readonly waits: Record<string, number> = {};

  async user(step: () => Promise<void>): Promise<void> {
    const at = performance.now();
    await step();
    this.pty += performance.now() - at;
  }

  async wait<T>(name: string, step: () => Promise<T>): Promise<T> {
    const at = performance.now();
    const value = await step();
    this.waits[name] = Math.round((performance.now() - at) / 1000);
    return value;
  }
}

describe('T079 guards on fixtures', () => {
  it('reads and acts on a PR only on the declared repo', () => {
    expect(prNumber('acme/node-sandbox#7', 'acme/node-sandbox')).toBe(7);
    expect(() => prNumber('acme/app#7', 'acme/node-sandbox')).toThrow();
    expect(() => prNumber('acme/node-sandbox#7x', 'acme/node-sandbox')).toThrow();
    expect(() => prNumber('7', 'acme/node-sandbox')).toThrow();
  });

  it('writes only to a private repo named as a sandbox, under the name declared', () => {
    const repo = { full_name: 'acme/node-sandbox', private: true, name: 'node-sandbox' };
    expect(sandboxProblem('acme/node-sandbox', repo)).toBeNull();
    expect(sandboxProblem('acme/node-sandbox', { ...repo, private: false })).toMatch(/public/);
    expect(sandboxProblem('acme/app', { ...repo, full_name: 'acme/app', name: 'app' })).toMatch(
      /sandbox/,
    );
    expect(sandboxProblem('acme/old-name', repo)).toMatch(/is acme\/node-sandbox/);
  });

  it('starts a daemon only on a config with yolo off and only the sandbox project and data dir', () => {
    const direction = { repo: 'acme/node-sandbox', data_dir: '/srv/t079/data' };
    const config = (extra = ''): string =>
      `projects:\n  node-sandbox: { repo: acme/node-sandbox }\n${extra}runtime:\n  data_dir: /srv/t079/data\n`;
    expect(configProblem(config(), 'node', direction)).toBeNull();
    expect(configProblem(`yolo: false\n${config()}`, 'node', direction)).toBeNull();
    expect(configProblem(`yolo: true\n${config()}`, 'node', direction)).toMatch(/yolo/);
    expect(configProblem(config('  app: { repo: acme/app }\n'), 'node', direction)).toMatch(
      /only node-sandbox/,
    );
    expect(configProblem(config(), 'python', direction)).toMatch(/only python-sandbox/);
    expect(configProblem(config(), 'node', { ...direction, repo: 'acme/app' })).toMatch(/only/);
    expect(configProblem(config(), 'node', { ...direction, data_dir: '/srv/other' })).toMatch(
      /keeps its data/,
    );
  });

  it('finds the tasks a daemon would resume, offline', () => {
    const dir = mkdtempSync(join(tmpdir(), 't079-store-'));
    try {
      expect(unfinishedTasks(dir)).toEqual([]);
      const db = new Database(join(dir, STORE_FILE));
      db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
      const add = db.prepare('INSERT INTO tasks (id, status) VALUES (?, ?)');
      for (const [id, status] of [
        ['done', 'DONE'],
        ['failed', 'FAILED'],
        ['cancelled', 'CANCELLED'],
      ])
        add.run(id, status);
      expect(unfinishedTasks(dir)).toEqual([]);
      for (const status of ['PENDING', 'READY', 'RUNNING', 'WAITING']) add.run(status, status);
      db.close();
      expect(unfinishedTasks(dir).sort()).toEqual(['PENDING', 'READY', 'RUNNING', 'WAITING']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('calls a head green only when every required check succeeded on that very head', () => {
    const head = 'a'.repeat(40);
    const run = (name: string, conclusion: string | null, sha = head): CheckRun => ({
      name,
      head_sha: sha,
      status: conclusion === null ? 'in_progress' : 'completed',
      conclusion,
    });
    const required = requiredChecks('node');
    expect(required).toEqual(['build', 'test']);
    expect(notGreen([run('build', 'success'), run('test', 'success')], head, required)).toBeNull();
    expect(notGreen([], head, required)).toMatch(/no build/);
    expect(notGreen([run('GitGuardian', 'success')], head, required)).toMatch(/no build/);
    expect(notGreen([run('build', 'success')], head, required)).toMatch(/no test/);
    expect(
      notGreen([run('build', 'success'), run('test', 'success', 'b'.repeat(40))], head, required),
    ).toMatch(/no test/);
    expect(notGreen([run('build', 'success'), run('test', null)], head, required)).toMatch(
      /in_progress/,
    );
    expect(
      notGreen(
        [run('build', 'success'), run('test', 'success'), run('test', 'failure')],
        head,
        required,
      ),
    ).toMatch(/failure/);
    expect(notGreen([run('build', 'success')], head, [])).toMatch(/no required/);
  });

  it('counts DONE only on a verified merge of the checked head', () => {
    const head = 'a'.repeat(40);
    const done = {
      status: 'DONE',
      completion: {
        checked_head_sha: head,
        merged_head_sha: head,
        merge_commit_sha: 'c'.repeat(40),
        unverified: null,
      },
    };
    expect(notVerifiedDone(done, head)).toBeNull();
    expect(notVerifiedDone({ ...done, status: 'WAITING' }, head)).toMatch(/status/);
    expect(notVerifiedDone({ ...done, completion: null }, head)).toMatch(/no completion/);
    expect(
      notVerifiedDone(
        { ...done, completion: { ...done.completion, unverified: 'head_drift' } },
        head,
      ),
    ).toMatch(/unverified/);
    expect(
      notVerifiedDone(
        { ...done, completion: { ...done.completion, merged_head_sha: 'b'.repeat(40) } },
        head,
      ),
    ).toMatch(/merged/);
  });

  describe('the matrix cell of each recorded journey', () => {
    const lines = ledgerLines(LEDGER);
    const attempts = (l: LedgerLine): Attempt[] => {
      const bound = (b: { model: string; effort: string }): string => `${b.model}/${b.effort}`;
      return [
        { step: 'code', binding: bound(l.selection.worker) },
        { step: 'code', binding: bound(l.selection.worker) },
        ...(l.selection.reviewer === null
          ? []
          : [{ step: 'review', binding: bound(l.selection.reviewer) }]),
      ];
    };

    it('holds all four cells, each verified DONE on its own sandbox PR', () => {
      expect(lines.map((l) => `${l.kind} ${l.mode}`).sort()).toEqual([
        'node direct-pr',
        'node full-review',
        'python direct-pr',
        'python full-review',
      ]);
      for (const l of lines) {
        expect(
          notVerifiedDone({ status: 'DONE', completion: l.completion }, l.head_sha),
        ).toBeNull();
        expect(matrixProblem(l.kind, l.mode, l.selection, attempts(l)), l.task_id).toBeNull();
        expect(l.pr_ref).toMatch(new RegExp(`^[^/]+/cuesura-sandbox-${l.kind}#\\d+$`));
      }
      expect(new Set(lines.map((l) => l.pr_ref)).size).toBe(4);
    });

    it('rejects a cell whose vendor, reviewer or attempts do not match it', () => {
      const node = lines.find((l) => l.kind === 'node' && l.mode === 'full-review') as LedgerLine;
      const sel = node.selection;
      const codex = { harness: 'codex', model: 'codex-worker', effort: 'low' };
      expect(matrixProblem('node', 'full-review', { ...sel, worker: codex }, [])).toMatch(/worker/);
      expect(matrixProblem('node', 'full-review', { ...sel, reviewer: sel.worker }, [])).toMatch(
        /reviewer/,
      );
      expect(matrixProblem('node', 'direct-pr', { ...sel, mode: 'direct-pr' }, [])).toMatch(
        /reviewer/,
      );
      expect(
        matrixProblem('node', 'full-review', sel, [
          { step: 'code', binding: 'claude-worker/low' },
          { step: 'code', binding: 'codex-worker/low' },
          { step: 'review', binding: 'codex-worker/low' },
        ]),
      ).toMatch(/code ran on codex-worker/);
      expect(
        matrixProblem('node', 'full-review', sel, [{ step: 'code', binding: 'claude-worker/low' }]),
      ).toMatch(/no review/);
      expect(matrixProblem('node', 'full-review', sel, [])).toMatch(/no worker/);
    });
  });
});

const real = loadRealSmoke();

// Needs CUSR_SMOKE_REAL, CUSR_SMOKE_T079_JOURNEY=1 and a build. Spends model usage and opens one PR per
// journey, which an operator merges by hand; the keys are pressed by this script, not by a person.
describe.skipIf(real === null || process.env['CUSR_SMOKE_T079_JOURNEY'] !== '1').each(REAL_KINDS)(
  'SC-004 with the real harness of %s',
  (kind) => {
    it.each(MODES)(
      '%s: from the TUI alone to DONE after a manual merge',
      async (mode) => {
        const r = new RealRun(real as NonNullable<typeof real>, kind);
        r.assertSafeStart();
        const task = TASKS[kind][mode];
        // Titles repeat across runs; the row is told apart by its ID once the task exists.
        const title = `${task.title} (${Date.now().toString(36)})`;
        const clock = new Clock();
        await r.startDaemon();
        const s = tui(r);
        try {
          await s.waitFor(
            () =>
              /Press n to create|Finished \(\d+\)|Add (truncate|initials)/.test(
                flat(s.screenText()),
              ),
            30_000,
          );

          await clock.user(async () => {
            s.send('n');
            await said(s, `‹ ${kind}-sandbox ›`);
            for (const text of ['', title, 'main', task.description, task.acceptance]) {
              if (text !== '') {
                s.send(text);
                await said(s, text.slice(0, 40));
              }
              s.send(KEY.tab);
            }
            s.send(KEY.ctrlS);
            await s.waitFor(() => !s.screenText().includes('Base branch'), 30_000);
            await said(s, title);
          });
          const list = await r.must('task', 'list');
          const id = (list['items'] as { task_id: string; title: string }[]).find(
            (t) => t.title === title,
          )?.task_id as string;
          expect(id).toBeDefined();

          await clock.user(async () => {
            await selectTaskId(s, id);
            s.send('a');
            await pressAction(s, 'Propose run');
            await said(s, 'Profile: smoke');
            if (mode === 'full-review') {
              s.send(KEY.down);
              await said(s, 'also need a reviewer');
            }
            s.send(KEY.ctrlS);
            await s.waitFor(() => !s.screenText().includes('Run config'), 30_000);

            await pressAction(s, 'Confirm');
            await said(s, 'Confirming: the run config.');
            await said(s, mode);
            s.send('confirm');
            await s.waitFor(() => /Enter: confirm_/.test(s.screenText()));
            s.send(KEY.enter);
            await said(s, 'Done (request');
            s.send(KEY.esc);
          });

          // The question must come before any merge wait.
          const asked = await clock.wait('agent_to_question', () =>
            r.until(
              id,
              'agent question',
              (t) => ['agent_question', 'merge'].includes(waitCode(t) ?? ''),
              AGENT_MS,
            ),
          );
          expect(waitCode(asked)).toBe('agent_question');

          await clock.user(async () => {
            await said(s, 'Needs you', 60_000);
            await selectTaskId(s, id);
            s.send('a');
            await pressAction(s, 'Answer the question');
            s.send(ANSWER[mode]);
            s.send(KEY.ctrlS);
            await said(s, 'Done (request');
            s.send(KEY.esc);
          });

          const waiting = await clock.wait('agent_to_merge_wait', () =>
            r.untilMergeWait(id, AGENT_MS),
          );
          const prRef = waiting['pr_ref'] as string;
          const head = waiting['head_sha'] as string;
          const number = prNumber(prRef, r.direction.repo);
          expect(r.pull(prRef)).toMatchObject({ state: 'open', merged: false, head_sha: head });
          expect(notGreen(r.checkRuns(head), head, requiredChecks(kind))).toBeNull();

          await clock.user(async () => {
            await selectTaskId(s, id);
            s.send('a');
            await said(s, 'Merge on GitHub', 60_000);
            s.send(KEY.esc);
          });

          console.log(
            `T079 ${kind} ${mode}: merge https://github.com/${r.direction.repo}/pull/${number} at head ${head} by hand`,
          );
          const done = await clock.wait('operator_merge_to_done', () => r.untilDone(id, MERGE_MS));
          expect(notVerifiedDone(done, head)).toBeNull();
          const pull = r.pull(prRef);
          expect(pull).toMatchObject({ merged: true, head_sha: head });
          expect(pull.merge_commit_sha).toBe(
            (done['completion'] as { merge_commit_sha: string }).merge_commit_sha,
          );

          await clock.user(() => seenFinished(s, id));
          const selection = (done['run_config'] as { selection: Selection }).selection;
          expect(matrixProblem(kind, mode, selection, await r.attempts(id))).toBeNull();
          expect(clock.pty).toBeLessThan(180_000);
          s.send('q');
          expect((await s.waitForExit()).status).toBe(0);

          const seconds = Number((clock.pty / 1000).toFixed(1));
          console.log(`SC-004 real ${kind} ${mode}: ${seconds} s at the keys`);
          r.record('T079', {
            mode,
            task_id: id,
            pr_ref: prRef,
            head_sha: head,
            completion: done['completion'],
            selection,
            pty_s: seconds,
            waits_s: clock.waits,
            operator: 'keys: script on a PTY; merge: an operator by hand',
            cusr_version: spawnSync('git', ['rev-parse', 'HEAD'], {
              encoding: 'utf8',
            }).stdout.trim(),
          });
        } finally {
          s.dispose();
          await r.stopDaemon('SIGTERM');
        }
      },
      2 * AGENT_MS + MERGE_MS + 10 * 60_000,
    );
  },
);
