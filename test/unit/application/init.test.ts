import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  InitWriteError,
  PR_TEMPLATE_TARGET,
  WRITE_PR_SKILL_PATHS,
  existingPrTemplates,
  initItems,
  installInitItems,
  writePrSkill,
} from '../../../src/application/init.ts';
import { INSTALLED_PR_TEMPLATE, WRITE_PR_SKILL_PATH } from '../../../src/domain/templates.ts';

const base = mkdtempSync(join(tmpdir(), 'cusr-init-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
function repo(files: Record<string, string> = {}): string {
  const root = join(base, String(n++));
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');

describe('cusr init: write-pr (PR template and skill)', () => {
  it('installs the template with the skill it points to; running again changes nothing', () => {
    const root = repo();
    expect(initItems(root)).toMatchObject([
      { id: 'write-pr', unavailable: null },
      { id: 'assistant', unavailable: null },
    ]);
    expect(initItems(root)[0]?.description).toContain('PR template');
    expect(
      installInitItems(root, ['write-pr'], { force: false, dataDir: '/data' }).map((f) => [
        f.path,
        f.status,
      ]),
    ).toEqual([
      ...WRITE_PR_SKILL_PATHS.map((p) => [p, 'created']),
      [PR_TEMPLATE_TARGET, 'created'],
    ]);
    expect(read(root, PR_TEMPLATE_TARGET)).toBe(INSTALLED_PR_TEMPLATE);
    expect(INSTALLED_PR_TEMPLATE).toContain(WRITE_PR_SKILL_PATH);
    for (const p of WRITE_PR_SKILL_PATHS) expect(read(root, p)).toBe(writePrSkill());
    expect(writePrSkill()).toMatch(/^---\nname: write-pr\ndescription: /);

    expect(
      installInitItems(root, ['write-pr'], { force: false, dataDir: '/data' }).map((f) => f.status),
    ).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(installInitItems(root, [], { force: false, dataDir: '/data' })).toEqual([]);
  });

  it('keeps the repo’s own template, wherever it is or whichever cusr.yaml names, and adds the skill alone', () => {
    for (const files of [
      { 'PULL_REQUEST_TEMPLATE.md': 'own' },
      { 'docs/pull_request_template.md': 'own' },
      { '.github/pull_request_template/feature.md': 'own' },
      { [PR_TEMPLATE_TARGET]: 'own' },
      { 'cusr.yaml': 'version: 1\npr_template: templates/pr.md\n' },
    ]) {
      const root = repo(files);
      const own = existingPrTemplates(root).join(', ');
      expect(initItems(root)[0]?.description).toContain(`keeps your ${own}`);
      const [a, b, template] = installInitItems(root, ['write-pr'], {
        force: true,
        dataDir: '/data',
      });
      expect(template).toEqual({
        path: PR_TEMPLATE_TARGET,
        status: 'skipped',
        reason: `the repo already has ${own}`,
      });
      expect([a?.status, b?.status]).toEqual(['created', 'created']);
      expect(existingPrTemplates(root)).toHaveLength(1);
    }
  });

  it('keeps an edited skill file unless forced', () => {
    const root = repo({ [WRITE_PR_SKILL_PATH]: 'edited' });
    expect(
      installInitItems(root, ['write-pr'], { force: false, dataDir: '/data' })[0],
    ).toMatchObject({
      path: WRITE_PR_SKILL_PATH,
      status: 'kept',
    });
    expect(read(root, WRITE_PR_SKILL_PATH)).toBe('edited');
    expect(
      installInitItems(root, ['write-pr'], { force: true, dataDir: '/data' })[0],
    ).toMatchObject({
      status: 'updated',
    });
    expect(read(root, WRITE_PR_SKILL_PATH)).toBe(writePrSkill());
  });

  it('a file it cannot write stops the install with what was done before, and no template is left pointing to a missing skill', () => {
    // A file where a directory must go fails for any user, root included.
    const root = repo({ '.claude/skills': 'not a directory' });
    try {
      installInitItems(root, ['write-pr'], { force: false, dataDir: '/data' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InitWriteError);
      const err = e as InitWriteError;
      expect(err.path).toBe(WRITE_PR_SKILL_PATHS[1]);
      expect(err.done).toEqual([{ path: WRITE_PR_SKILL_PATH, status: 'created' }]);
    }
    expect(existsSync(join(root, PR_TEMPLATE_TARGET))).toBe(false);
  });
});
