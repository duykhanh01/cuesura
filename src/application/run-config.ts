/**
 * Run configuration at the application boundary (T135, task-execution-modes.md M01/M02). The
 * selection a user confirmed is checked against the effective, frozen configuration at start: the
 * profile, the worker binding of every coder/fixer step, the reviewer binding of `full-review` and the
 * allowed fallbacks. The daemon never rebinds to make it fit; a mismatch waits for a new confirmation.
 * Also reads the PR template of the frozen base (M05).
 */
import type { GitPort } from '../adapters/ports.ts';
import type { FrozenPolicy } from '../domain/policy.ts';
import {
  sameChoice,
  type PrTemplate,
  type RunSelection,
} from '../domain/run-config.ts';
import { hashText } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';

export type SelectionProblem = {
  readonly check: string;
  readonly message: string;
};

const WORKER_ROLES = ['coder', 'fixer'];

export function checkSelection(
  policy: FrozenPolicy,
  sel: RunSelection,
): SelectionProblem[] {
  const out: SelectionProblem[] = [];
  if (sel.profile !== policy.profile)
    out.push({
      check: 'profile',
      message: `confirmed profile '${sel.profile}' but the task resolves to '${policy.profile}'`,
    });
  const steps = Object.entries(policy.steps).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );
  const ladders: { harness: string; model: string; effort: string }[] = [];
  for (const [name, sp] of steps) {
    if (WORKER_ROLES.includes(sp.role)) {
      ladders.push(...sp.ladder.map((r) => r.binding));
      if (!sameChoice(sel.worker, sp.binding))
        out.push({
          check: 'worker',
          message: `step '${name}' binds ${sp.binding.harness}/${sp.binding.model}/${sp.binding.effort}, not the confirmed worker`,
        });
    } else if (sp.role === 'reviewer') {
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
  if (
    sel.mode === 'full-review' &&
    !steps.some(([, sp]) => sp.role === 'reviewer')
  )
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
  return out;
}

// ---- PR template of the frozen base ----

const TEMPLATE_BYTES = 64 * 1024;
const TEMPLATE_RE =
  /^(?:\.github\/|docs\/)?pull_request_template\.md$|^(?:\.github\/|docs\/)?pull_request_template\/[^/]+\.md$/i;

export type TemplateError = {
  readonly check: 'pr_template';
  readonly message: string;
  readonly candidates: readonly string[];
};

/**
 * The PR template at `base`: the configured `pr_template` path, else the only template the repo has;
 * several without a choice wait for one (no guessing). `null` when the repo has none: the worker then
 * writes a plain description. Read from Git objects, never from the working tree.
 */
export async function readPrTemplate(
  git: GitPort,
  cwd: string,
  base: string,
  configured: string | null,
): Promise<
  Result<
    PrTemplate | null,
    TemplateError | { readonly check: 'git'; readonly message: string }
  >
> {
  const ls = await git.run({
    args: ['ls-tree', '-r', '--name-only', '-z', base],
    cwd,
    timeout_ms: 30_000,
    max_output_bytes: 8 * 1024 * 1024,
    stdin: null,
  });
  if (ls.kind !== 'exited' || ls.code !== 0 || ls.truncated)
    return err({ check: 'git', message: 'cannot list the base tree' });
  const files = ls.stdout.split('\0').filter((f) => f !== '');
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
    return ok(null);
  } else if (found.length > 1) {
    return err({
      check: 'pr_template',
      message: 'several PR templates; set pr_template in cusr.yaml',
      candidates: found,
    });
  } else {
    path = found[0] as string;
  }
  const blob = await git.run({
    args: ['cat-file', 'blob', `${base}:${path}`],
    cwd,
    timeout_ms: 10_000,
    max_output_bytes: TEMPLATE_BYTES,
    stdin: null,
  });
  if (blob.kind !== 'exited' || blob.code !== 0)
    return err({ check: 'git', message: `cannot read ${path}` });
  if (blob.truncated)
    return err({
      check: 'pr_template',
      message: `${path} is larger than ${TEMPLATE_BYTES} bytes`,
      candidates: [path],
    });
  return ok({
    path,
    content: blob.stdout,
    content_hash: hashText(blob.stdout),
  });
}
