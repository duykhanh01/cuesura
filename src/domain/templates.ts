/**
 * Built-in PR and review templates. A project replaces either one from its frozen base (`pr_template`,
 * `review_template` in cusr.yaml, or the repo's own PR template); these are used when it has none.
 */
import { hashText } from '../shared/hash.ts';
import type { PrTemplate } from './run-config.ts';

/** Shown as the template path when the built-in one is used; never a repo path. */
export const DEFAULT_PR_TEMPLATE_PATH = 'cusr:default/pull_request_template.md';
export const DEFAULT_REVIEW_TEMPLATE_PATH = 'cusr:default/review_template.md';

/** Where `cusr init` puts the PR skill; the template it installs points workers there. */
export const WRITE_PR_SKILL_PATH = '.agents/skills/write-pr/SKILL.md';

function prTemplate(sketch: string): string {
  return `## Why

<!--
The problem or need, in 1-3 sentences, in the project's own terms.
Delete these comments when writing.
-->

## Changes

<!--
Bullets by behaviour a user or the system can see, not a list of files.
When the PR changes structure (call flow, state transitions, module layout, flow between
components), ${sketch}
-->

## Evidence

<!--
Concrete before and after: a test that failed and now passes, command output, a screenshot.
Do not repeat the list of gates and CI checks; they are recorded already.
Say what was not verified.
-->

## Merge risk

**Door:** <!-- one-way | two-way -->

<!--
Two-way: a revert undoes it. One-way: a revert leaves something behind, e.g. data already written
in a new format, clients that already depend on new behaviour, deleted data. For a one-way door,
say where rollback stops and how to go through safely.
-->

**Blast radius:** <!-- a short phrase: what breaks if this PR is wrong -->
`;
}

/** Used when the repo has no template; it cannot point to a skill the repo may not have. */
export const DEFAULT_PR_TEMPLATE =
  prTemplate(`add the smallest sketch that makes it clear: pseudocode,
a call tree, a file tree, a Mermaid diagram, or a \`diff\` of one of these when only part changes.`);

/** Written to the repo by `cusr init`, next to the skill it points to. */
export const INSTALLED_PR_TEMPLATE = prTemplate(`add the smallest sketch that makes it clear;
read ${WRITE_PR_SKILL_PATH} for how.`);

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
