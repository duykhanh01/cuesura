import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PR_TEMPLATE_TARGET } from '../../../src/application/init.ts';
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
    expect(shown[0]?.map((c) => c.id)).toEqual(['write-pr']);
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
    expect(JSON.parse(yes.stdout)).toMatchObject({
      ok: true,
      data: { files: [{}, {}, { path: PR_TEMPLATE_TARGET, status: 'created' }] },
    });
  });

  it('refuses a directory outside a Git repository', async () => {
    const r = await run(['init', '--dir', base, '--yes'], picking([]).deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('is not inside a Git repository');
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
