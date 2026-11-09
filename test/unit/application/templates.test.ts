import { describe, expect, it } from 'vitest';
import type { GitCommand, GitPort, GitResult } from '../../../src/adapters/ports.ts';
import { readPrTemplate, readReviewTemplate } from '../../../src/application/run-config.ts';
import {
  DEFAULT_PR_TEMPLATE,
  DEFAULT_PR_TEMPLATE_PATH,
  DEFAULT_REVIEW_TEMPLATE,
  DEFAULT_REVIEW_TEMPLATE_PATH,
} from '../../../src/domain/templates.ts';

/** A base commit holding `files`, read the way the templates are: `ls-tree` and `cat-file blob`. */
function base(files: Record<string, string>): GitPort {
  return {
    run(c: GitCommand): Promise<GitResult> {
      const exited = (stdout: string, code = 0): Promise<GitResult> =>
        Promise.resolve({
          kind: 'exited',
          code,
          stdout,
          stderr: '',
          truncated: false,
        });
      if (c.args[0] === 'ls-tree') return exited(Object.keys(files).join('\0'));
      const path = (c.args[2] ?? '').split(':')[1] ?? '';
      const content = files[path];
      return content === undefined ? exited('', 128) : exited(content);
    },
  };
}

describe('PR template at the frozen base', () => {
  it('uses the built-in one when the repo has none, and the repo’s own otherwise', async () => {
    expect(await readPrTemplate(base({}), '/p', 'b', null)).toMatchObject({
      ok: true,
      value: { path: DEFAULT_PR_TEMPLATE_PATH, content: DEFAULT_PR_TEMPLATE },
    });
    const own = { '.github/pull_request_template.md': '## Why\n' };
    expect(await readPrTemplate(base(own), '/p', 'b', null)).toMatchObject({
      ok: true,
      value: { path: '.github/pull_request_template.md', content: '## Why\n' },
    });
  });
});

describe('review template at the frozen base', () => {
  it('uses the built-in one unless cusr.yaml names a file', async () => {
    expect(await readReviewTemplate(base({}), '/p', 'b', null)).toMatchObject({
      ok: true,
      value: {
        path: DEFAULT_REVIEW_TEMPLATE_PATH,
        content: DEFAULT_REVIEW_TEMPLATE,
      },
    });
    const t = '## {{verdict}} ({{round}})\n{{summary}}\n{{findings}}\n';
    expect(
      await readReviewTemplate(base({ '.cusr/review.md': t }), '/p', 'b', '.cusr/review.md'),
    ).toMatchObject({
      ok: true,
      value: { path: '.cusr/review.md', content: t },
    });
  });

  it('refuses a missing file, unknown placeholders and control markers before anything runs', async () => {
    const read = (content: string | undefined) =>
      readReviewTemplate(base(content === undefined ? {} : { 'r.md': content }), '/p', 'b', 'r.md');
    const missing = await read(undefined);
    expect(!missing.ok && missing.error.check).toBe('review_template');
    expect(!missing.ok && missing.error.message).toContain('not in the base commit');
    const unknown = await read('{{verdict}} by {{author}}');
    expect(!unknown.ok && unknown.error.message).toContain('unknown placeholders: author');
    expect(await read('{{verdict}} <!-- cusr:review -->')).toMatchObject({
      ok: false,
      error: { check: 'review_template' },
    });
  });
});
