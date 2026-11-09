/**
 * Run configuration at the application boundary (T135, task-execution-modes.md M01/M02). The
 * selection a user confirmed is checked against the effective, frozen configuration at start: the
 * profile, the worker binding of every coder/fixer step, the reviewer binding of `full-review` and the
 * allowed worker and reviewer fallbacks. The daemon never rebinds to make it fit; a mismatch waits for a new confirmation.
 * Also reads the PR and review templates of the frozen base (M05).
 */
import type { GitPort } from '../adapters/ports.ts';
import type { FrozenPolicy } from '../domain/policy.ts';
import { sameChoice, type PrTemplate, type RunSelection } from '../domain/run-config.ts';
import {
  defaultPrTemplate,
  defaultReviewTemplate,
  REVIEW_PLACEHOLDERS,
  REVIEW_TEMPLATE_MAX_BYTES,
  unknownPlaceholders,
} from '../domain/templates.ts';
import { markerCount } from '../adapters/publish-content.ts';
import { hashText } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';

export type SelectionProblem = {
  readonly check: string;
  readonly message: string;
};

const WORKER_ROLES = ['coder', 'fixer'];

export function checkSelection(policy: FrozenPolicy, sel: RunSelection): SelectionProblem[] {
  const out: SelectionProblem[] = [];
  if (sel.profile !== policy.profile)
    out.push({
      check: 'profile',
      message: `confirmed profile '${sel.profile}' but the task resolves to '${policy.profile}'`,
    });
  const steps = Object.entries(policy.steps).sort(([a], [b]) => (a < b ? -1 : 1));
  const ladders: { harness: string; model: string; effort: string }[] = [];
  const reviewLadders: { harness: string; model: string; effort: string }[] = [];
  for (const [name, sp] of steps) {
    if (WORKER_ROLES.includes(sp.role)) {
      ladders.push(...sp.ladder.map((r) => r.binding));
      if (!sameChoice(sel.worker, sp.binding))
        out.push({
          check: 'worker',
          message: `step '${name}' binds ${sp.binding.harness}/${sp.binding.model}/${sp.binding.effort}, not the confirmed worker`,
        });
    } else if (sp.role === 'reviewer') {
      reviewLadders.push(...sp.ladder.map((r) => r.binding));
      if (sel.reviewer === null)
        out.push({
          check: 'reviewer',
          message: `step '${name}' runs a reviewer but the selection has none`,
        });
      else if (!sameChoice(sel.reviewer, sp.binding))
        out.push({
          check: 'reviewer',
          message: `step '${name}' binds ${sp.binding.harness}/${sp.binding.model}/${sp.binding.effort}, not the confirmed reviewer`,
        });
    }
  }
  if (sel.mode === 'full-review' && !steps.some(([, sp]) => sp.role === 'reviewer'))
    out.push({
      check: 'reviewer',
      message: 'full-review but the graph has no review step',
    });
  for (const f of sel.fallbacks) {
    if (!ladders.some((b) => sameChoice(f, b)))
      out.push({
        check: 'fallback',
        message: `fallback ${f.harness}/${f.model}/${f.effort} is not a rung of the worker ladder`,
      });
  }
  for (const f of sel.reviewer_fallbacks ?? []) {
    if (!reviewLadders.some((b) => sameChoice(f, b)))
      out.push({
        check: 'reviewer_fallback',
        message: `reviewer fallback ${f.harness}/${f.model}/${f.effort} is not a rung of the reviewer ladder`,
      });
  }
  return out;
}

// ---- PR template of the frozen base ----

const TEMPLATE_BYTES = 64 * 1024;
export const TEMPLATE_RE =
  /^(?:\.github\/|docs\/)?pull_request_template\.md$|^(?:\.github\/|docs\/)?pull_request_template\/[^/]+\.md$/i;

export type TemplateError = {
  readonly check: 'pr_template' | 'review_template';
  readonly message: string;
  readonly candidates: readonly string[];
};

type GitError = { readonly check: 'git'; readonly message: string };

async function readBlob(
  git: GitPort,
  cwd: string,
  base: string,
  path: string,
  maxBytes: number,
  check: TemplateError['check'],
): Promise<Result<PrTemplate, TemplateError | GitError>> {
  const blob = await git.run({
    args: ['cat-file', 'blob', `${base}:${path}`],
    cwd,
    timeout_ms: 10_000,
    max_output_bytes: maxBytes,
    stdin: null,
  });
  if (blob.kind !== 'exited' || blob.code !== 0)
    return err({ check: 'git', message: `cannot read ${path}` });
  if (blob.truncated)
    return err({
      check,
      message: `${path} is larger than ${maxBytes} bytes`,
      candidates: [path],
    });
  return ok({
    path,
    content: blob.stdout,
    content_hash: hashText(blob.stdout),
  });
}

async function listBase(
  git: GitPort,
  cwd: string,
  base: string,
): Promise<Result<string[], GitError>> {
  const ls = await git.run({
    args: ['ls-tree', '-r', '--name-only', '-z', base],
    cwd,
    timeout_ms: 30_000,
    max_output_bytes: 8 * 1024 * 1024,
    stdin: null,
  });
  if (ls.kind !== 'exited' || ls.code !== 0 || ls.truncated)
    return err({ check: 'git', message: 'cannot list the base tree' });
  return ok(ls.stdout.split('\0').filter((f) => f !== ''));
}

/**
 * The PR template at `base`: the configured `pr_template` path, else the only template the repo has,
 * else the built-in default; several without a choice wait for one (no guessing). Read from Git
 * objects, never from the working tree.
 */
export async function readPrTemplate(
  git: GitPort,
  cwd: string,
  base: string,
  configured: string | null,
): Promise<Result<PrTemplate, TemplateError | GitError>> {
  const listed = await listBase(git, cwd, base);
  if (!listed.ok) return listed;
  const files = listed.value;
  const found = files.filter((f) => TEMPLATE_RE.test(f)).sort();
  let path: string;
  if (configured !== null) {
    if (!files.includes(configured))
      return err({
        check: 'pr_template',
        message: `pr_template '${configured}' is not in the base commit`,
        candidates: found,
      });
    path = configured;
  } else if (found.length === 0) {
    return ok(defaultPrTemplate());
  } else if (found.length > 1) {
    return err({
      check: 'pr_template',
      message: 'several PR templates; set pr_template in cusr.yaml',
      candidates: found,
    });
  } else {
    path = found[0] as string;
  }
  return readBlob(git, cwd, base, path, TEMPLATE_BYTES, 'pr_template');
}

/**
 * The review comment template at `base`: the configured `review_template` path, else the built-in
 * default. Unknown placeholders and control markers are refused here, before anything runs, rather than
 * when the first review is posted.
 */
export async function readReviewTemplate(
  git: GitPort,
  cwd: string,
  base: string,
  configured: string | null,
): Promise<Result<PrTemplate, TemplateError | GitError>> {
  if (configured === null) return ok(defaultReviewTemplate());
  const blob = await readBlob(
    git,
    cwd,
    base,
    configured,
    REVIEW_TEMPLATE_MAX_BYTES,
    'review_template',
  );
  if (!blob.ok)
    return blob.error.check === 'git'
      ? err({
          check: 'review_template',
          message: `review_template '${configured}' is not in the base commit`,
          candidates: [],
        })
      : blob;
  const unknown = unknownPlaceholders(blob.value.content);
  if (unknown.length > 0)
    return err({
      check: 'review_template',
      message: `${configured} uses unknown placeholders: ${unknown.join(', ')}; allowed: ${REVIEW_PLACEHOLDERS.join(', ')}`,
      candidates: [configured],
    });
  if (markerCount(blob.value.content) > 0)
    return err({
      check: 'review_template',
      message: `${configured} contains a <!-- cusr: control marker`,
      candidates: [configured],
    });
  return blob;
}
