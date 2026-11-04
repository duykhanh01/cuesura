/**
 * Built-in PR and review templates. A project replaces either one from its frozen base (`pr_template`,
 * `review_template` in cusr.yaml, or the repo's own PR template); these are used when it has none.
 */
import { hashText } from '../shared/hash.ts';
import type { PrTemplate } from './run-config.ts';

/** Shown as the template path when the built-in one is used; never a repo path. */
export const DEFAULT_PR_TEMPLATE_PATH = 'cusr:default/pull_request_template.md';
export const DEFAULT_REVIEW_TEMPLATE_PATH = 'cusr:default/review_template.md';

export const DEFAULT_PR_TEMPLATE = `## Summary

<!-- What this PR changes and why, in a few sentences. -->

## Changes

-

## Testing

<!-- Gates run, tests added or updated, manual checks. -->

## Risks and notes

<!-- What a reader should look at closely; "None" when nothing. -->
`;

export const DEFAULT_REVIEW_TEMPLATE = `### Review round {{round}}: {{verdict}}

{{summary}}

{{findings}}
`;

export const REVIEW_PLACEHOLDERS = [
  'round',
  'verdict',
  'summary',
  'findings',
  'inline_count',
  'head_sha',
] as const;
export type ReviewPlaceholder = (typeof REVIEW_PLACEHOLDERS)[number];

export const REVIEW_TEMPLATE_MAX_BYTES = 16 * 1024;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export function defaultPrTemplate(): PrTemplate {
  return builtIn(DEFAULT_PR_TEMPLATE_PATH, DEFAULT_PR_TEMPLATE);
}

export function defaultReviewTemplate(): PrTemplate {
  return builtIn(DEFAULT_REVIEW_TEMPLATE_PATH, DEFAULT_REVIEW_TEMPLATE);
}

function builtIn(path: string, content: string): PrTemplate {
  return { path, content, content_hash: hashText(content) };
}

/** Placeholder names a review template uses that the renderer does not know, sorted and unique. */
export function unknownPlaceholders(content: string): string[] {
  const known: ReadonlySet<string> = new Set(REVIEW_PLACEHOLDERS);
  const bad = new Set<string>();
  for (const m of content.matchAll(PLACEHOLDER)) {
    const name = m[1] as string;
    if (!known.has(name)) bad.add(name);
  }
  return [...bad].sort();
}

/** Plain substitution in one pass: a value that itself looks like a placeholder is not expanded. */
export function renderReviewTemplate(
  content: string,
  values: Readonly<Record<ReviewPlaceholder, string>>,
): string {
  return content.replace(PLACEHOLDER, (all, name: string) =>
    Object.hasOwn(values, name) ? values[name as ReviewPlaceholder] : all,
  );
}
