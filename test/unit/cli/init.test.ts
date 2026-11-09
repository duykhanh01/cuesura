import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ASSISTANT_SETTINGS_PATH } from '../../../src/application/init-assistant.ts';
import { PR_TEMPLATE_TARGET, type InitFile } from '../../../src/application/init.ts';
import { makeInitCommand, type InitDeps } from '../../../src/cli/init.ts';
import { runCli } from '../../../src/cli/program.ts';
import type { Choice } from '../../../src/cli/select.ts';
import { WRITE_PR_SKILL_PATH } from '../../../src/domain/templates.ts';

const base = mkdtempSync(join(tmpdir(), 'cusr-init-cli-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
function gitRepo(): string {
  const root = join(base, String(n++));
  execFileSync('git', ['init', '-q', root]);
  return root;
}

async function run(argv: string[], deps: InitDeps) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(
    { name: 'cusr', description: 'test', version: '0.0.0' },
    argv,
    { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) },
    [makeInitCommand(deps)],
  );
  return { code, stdout, stderr };
}

/** A person who picks `answer` from the checklist; what they were shown is kept. */
function picking(answer: readonly string[] | null, interactive = true) {
  const shown: (readonly Choice[])[] = [];
  const deps: InitDeps = {
    interactive: () => interactive,
    select: (_title, choices) => {
      shown.push(choices);
      return Promise.resolve(answer);
    },
  };
  return { deps, shown };
}

describe('cusr init', () => {
  it('shows the checklist and installs what was picked', async () => {
    const root = gitRepo();
    const { deps, shown } = picking(['write-pr']);
    const r = await run(['init', '--dir', root], deps);
    expect(r.code).toBe(0);
    expect(shown[0]?.map((c) => c.id)).toEqual(['write-pr', 'assistant']);
    expect(shown[0]?.every((c) => c.description !== '')).toBe(true);
    expect(r.stdout).toContain(`created   ${PR_TEMPLATE_TARGET}`);
    expect(r.stdout).toContain(`created   ${WRITE_PR_SKILL_PATH}`);
    expect(r.stdout).toContain('cusr reads the PR template from the base commit');
  });

  it('writes nothing when the person cancels or unchecks everything', async () => {
    for (const answer of [null, []]) {
      const root = gitRepo();
      const r = await run(['init', '--dir', root], picking(answer).deps);
      expect(r.stdout).toBe('Nothing installed.\n');
      expect(existsSync(join(root, '.github'))).toBe(false);
    }
  });

  it('never asks without a terminal or with --json: --yes decides', async () => {
    const root = gitRepo();
    const { deps, shown } = picking(['write-pr'], false);
    expect((await run(['init', '--dir', root], deps)).code).toBe(2);
    const asked = await run(['init', '--dir', root, '--json'], picking(['write-pr']).deps);
    expect(JSON.parse(asked.stdout)).toMatchObject({
      ok: false,
      error: { code: 'invalid_arguments' },
    });
    expect(shown).toHaveLength(0);
    expect(existsSync(join(root, '.github'))).toBe(false);

    const yes = await run(['init', '--dir', root, '--yes', '--json'], deps);
    const { ok, data } = JSON.parse(yes.stdout) as { ok: boolean; data: { files: InitFile[] } };
    expect(ok).toBe(true);
    expect(data.files).toContainEqual({ path: PR_TEMPLATE_TARGET, status: 'created' });
    expect(data.files).toContainEqual({ path: '.claude/skills/cusr/SKILL.md', status: 'created' });
    expect(data.files).toContainEqual({
      path: ASSISTANT_SETTINGS_PATH,
      status: 'created',
      reason: 'stays on this machine, do not commit',
      local: true,
    });
  });

  it('--yes installs the assistant with the data dir given, absolute, and says what not to commit', async () => {
    const root = gitRepo();
    const dataDir = join(base, 'data dir');
    const r = await run(['init', '--dir', root, '--yes', '--data-dir', dataDir], picking([]).deps);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`created   ${ASSISTANT_SETTINGS_PATH} (stays on this machine`);
    expect(r.stdout).toContain('Commit these files');
    expect(readFileSync(join(root, ASSISTANT_SETTINGS_PATH), 'utf8')).toContain(
      `CUSR_DATA_DIR='${dataDir}' `,
    );

    const again = await run(
      ['init', '--dir', root, '--yes', '--data-dir', dataDir],
      picking([]).deps,
    );
    expect(again.stdout).not.toContain('created');
    expect(again.stdout).not.toContain('updated');
    expect(again.stdout).not.toContain('Commit these files');
  });

  it('a change only to the local settings asks for no commit', async () => {
    const root = gitRepo();
    await run(['init', '--dir', root, '--yes', '--data-dir', '/one'], picking([]).deps);
    const r = await run(['init', '--dir', root, '--yes', '--data-dir', '/two'], picking([]).deps);
    expect(r.stdout).toContain(`updated   ${ASSISTANT_SETTINGS_PATH}`);
    expect(r.stdout).not.toContain('Commit these files');
  });

  it('--yes installs what it can when the settings file is blocked, and says how to unblock it (#269)', async () => {
    const root = gitRepo();
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, ASSISTANT_SETTINGS_PATH), '{oops');
    const r = await run(['init', '--dir', root, '--yes'], picking([]).deps);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`created   ${PR_TEMPLATE_TARGET}`);
    expect(r.stdout).toContain(
      `Not installed: assistant: cannot install ${ASSISTANT_SETTINGS_PATH}: it is not valid JSON`,
    );
    expect(r.stdout).toContain('fix or delete it; then run cusr init again');
    expect(readFileSync(join(root, ASSISTANT_SETTINGS_PATH), 'utf8')).toBe('{oops');
    expect(existsSync(join(root, '.claude/skills/cusr'))).toBe(false);

    const tracked = gitRepo();
    mkdirSync(join(tracked, '.claude'));
    writeFileSync(join(tracked, ASSISTANT_SETTINGS_PATH), '{}');
    execFileSync('git', ['-C', tracked, 'add', ASSISTANT_SETTINGS_PATH]);
    const j = await run(['init', '--dir', tracked, '--yes', '--json'], picking([]).deps);
    expect(j.code).toBe(0);
    const { data } = JSON.parse(j.stdout) as {
      data: { files: InitFile[]; unavailable: { id: string; reason: string }[]; next: string[] };
    };
    expect(data.files).toContainEqual({ path: WRITE_PR_SKILL_PATH, status: 'created' });
    expect(data.unavailable.map((u) => u.id)).toEqual(['assistant']);
    expect(data.unavailable[0]?.reason).toContain(`git rm --cached ${ASSISTANT_SETTINGS_PATH}`);
    expect(data.next).toContain('cusr doctor --project ID');
  });

  it('the checklist shows a blocked item as unavailable', async () => {
    const root = gitRepo();
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, ASSISTANT_SETTINGS_PATH), '{oops');
    const { deps, shown } = picking(['write-pr']);
    expect((await run(['init', '--dir', root], deps)).code).toBe(0);
    expect(shown[0]?.find((c) => c.id === 'assistant')?.unavailable).toContain('not valid JSON');
  });

  it('a blocked item asked for anyway is a usage error, exit 2, not a write failure', async () => {
    const root = gitRepo();
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, ASSISTANT_SETTINGS_PATH), '{oops');
    const r = await run(['init', '--dir', root], picking(['assistant']).deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      `cusr: cannot install ${ASSISTANT_SETTINGS_PATH}: it is not valid JSON`,
    );
  });

  it('prints the next steps', async () => {
    const root = gitRepo();
    const r = await run(['init', '--dir', root, '--yes'], picking([]).deps);
    expect(r.stdout).toContain('Next:\n');
    expect(r.stdout).toContain(`path: ${root}`);
    expect(r.stdout).toContain('  cusr doctor --project ID\n');
  });

  it('refuses a directory outside a Git repository', async () => {
    const r = await run(['init', '--dir', base, '--yes'], picking([]).deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('is not inside a Git repository');
    expect(r.stderr).toContain('--dir <repo>');
  });
});

describe('cusr init when a file cannot be written', () => {
  it('ends with one JSON error that lists what was installed, never a stack trace', async () => {
    const root = gitRepo();
    writeFileSync(join(root, '.claude'), 'not a directory');
    const r = await run(['init', '--dir', root, '--yes', '--json'], picking([]).deps);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: {
        code: 'write_failed',
        details: {
          root,
          failed: '.claude/skills/write-pr/SKILL.md',
          files: [{ path: WRITE_PR_SKILL_PATH, status: 'created' }],
        },
      },
    });
    expect(existsSync(join(root, PR_TEMPLATE_TARGET))).toBe(false);

    const human = await run(['init', '--dir', root, '--yes'], picking([]).deps);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain('cusr: cannot write .claude/skills/write-pr/SKILL.md');
    expect(human.stderr).not.toContain('    at ');
  });

  it('a checklist that fails ends the same way', async () => {
    const root = gitRepo();
    const deps: InitDeps = {
      interactive: () => true,
      select: () => Promise.reject(new Error('setRawMode EIO')),
    };
    const r = await run(['init', '--dir', root], deps);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('cusr: setRawMode EIO\n');
  });
});
