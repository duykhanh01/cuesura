/**
 * Role context (T037, FR-005, contracts/execution.md "Harness contract"). Built from the frozen
 * execution context of the task revision, the frozen binding and the current step, plus what the step
 * needs: answers, the failures a fixer works on, the diff a reviewer reads. Every part is redacted and
 * stripped of terminal/channel control syntax before it is counted.
 *
 * Size is capped (context 128 KiB, reviewer diff 64 KiB by default). Required parts are never cut: when
 * acceptance, the fixer's failures or the reviewer's diff are missing, or the required parts alone do
 * not fit, the result is `needs_context` and no agent is called. Optional parts are cut from the end,
 * lowest priority first, and every cut says what was kept, of how much, and the digest of the whole.
 */
import type { FrozenExecutionContext } from '../domain/policy.ts';
import type { Redactor } from '../runner/redact.ts';
import { hashText } from '../shared/hash.ts';
import type { Hash } from '../shared/brand.ts';
import type { Role } from './harness/result-schema.ts';

export type RoleFailure = {
  readonly source: 'gate' | 'review' | 'ci';
  readonly name: string;
  readonly detail: string;
  /** Commit the failure was observed on, and the CI run generation when there is one. */
  readonly sha?: string | null;
  readonly generation?: number | null;
};

/**
 * Latest reconciled state handed to every repair, resumed or fresh (task-execution-modes.md M04): why the
 * worker is called again, on which base/checkpoint, what the worktree and the PR say now. Built anew for
 * each call; never a "continue" with the previous prompt.
 */
export type RepairState = {
  readonly cause: 'gate' | 'review' | 'ci';
  readonly base_sha: string;
  readonly checkpoint_sha: string | null;
  readonly published_sha: string | null;
  readonly pr_ref: string | null;
  /** `git status --porcelain` of the worktree and the diff base..worktree. */
  readonly worktree_status: string;
  readonly diff: string;
};

/** Worker-prepared commit message and PR title/body (M05). */
export type PublishContent = {
  readonly commit_message: string;
  readonly pr_title: string;
  readonly pr_body: string;
};

export type PublishBrief = {
  readonly template: { readonly path: string; readonly content: string } | null;
  readonly current: PublishContent | null;
  /** File, outside the worktree, where the worker writes `{commit_message, pr_title, pr_body}` as JSON. */
  readonly file: string;
};

export type ReviewDiff = {
  readonly text: string;
  /** Every changed path, kept in full even when the diff text is cut. */
  readonly paths: readonly string[];
  readonly from: string;
  readonly to: string;
};

export type ContextInput = {
  readonly role: Role;
  readonly step: string;
  readonly revision: number;
  readonly context: FrozenExecutionContext;
  readonly binding: {
    readonly harness: string;
    readonly model: string;
    readonly effort: string | null;
  };
  /** Name of the role prompt in `context.prompt_refs`, or null. */
  readonly prompt: string | null;
  readonly answers: readonly {
    readonly question_id: string;
    readonly question?: string;
    readonly answer: string;
  }[];
  readonly failures: readonly RoleFailure[];
  readonly diff: ReviewDiff | null;
  /** Required for a repair (fixer, or a coder step that fixes CI). */
  readonly repair?: RepairState | null;
  /** Worker roles of a mode task: template and where to put the commit/PR content. */
  readonly publish?: PublishBrief | null;
  /** Reviewer of a `full-review` task: the PR content it checks with the diff. */
  readonly pr_content?: PublishContent | null;
  readonly limits: {
    readonly context_bytes: number;
    readonly review_diff_bytes: number;
  };
  readonly redactor: Redactor;
};

export type Truncation = {
  readonly section: string;
  readonly kept_bytes: number;
  readonly original_bytes: number;
  readonly digest: Hash;
};

export type RoleContext = {
  readonly text: string;
  readonly digest: Hash;
  readonly bytes: number;
  readonly truncated: readonly Truncation[];
  readonly diff: {
    readonly digest: Hash;
    readonly paths: readonly string[];
    readonly bytes: number;
  } | null;
};

export type NeedsContext = {
  readonly kind: 'needs_context';
  readonly missing: readonly string[];
};

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

// ESC sequences (CSI/OSC), other C0/C1 controls except tab and newline, and bidi overrides.
const CONTROL =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
/** Lines a chat channel or the CLI would read as a command; quoted so they stay data. */
const CHANNEL_COMMAND =
  /^(\s*)(\/[A-Za-z_]+(?:@\S+)?\b|cusr\s+(?:task\s+)?(?:approve|answer|cancel|confirm|recheck|add)\b)/gim;

/** Redacts secrets, removes control characters and quotes channel command lines. */
export function sanitize(text: string, redactor: Redactor): string {
  return redactor
    .text(text)
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .replace(CHANNEL_COMMAND, '$1[quoted] $2');
}

/** Cuts `text` to at most `max` UTF-8 bytes on a character boundary, preferring a line end. */
function cut(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  let s = Buffer.from(text, 'utf8')
    .subarray(0, Math.max(0, max))
    .toString('utf8');
  if (s.endsWith('�')) s = s.slice(0, -1);
  const nl = s.lastIndexOf('\n');
  return nl > s.length / 2 ? s.slice(0, nl + 1) : s;
}

type Section = {
  readonly name: string;
  readonly body: string;
  readonly required: boolean;
};

function marker(t: Truncation): string {
  return `\n[truncated ${t.section}: kept ${t.kept_bytes} of ${t.original_bytes} bytes; full ${t.digest}]\n`;
}

const list = (xs: readonly string[]): string =>
  xs.map((x) => `- ${x}`).join('\n');

export function buildRoleContext(
  input: ContextInput,
): { ok: true; value: RoleContext } | { ok: false; error: NeedsContext } {
  const { context: c, redactor } = input;
  const clean = (s: string): string => sanitize(s, redactor);
  const missing: string[] = [];
  if (c.revision !== input.revision) missing.push('context_revision');
  if (c.acceptance.length === 0) missing.push('acceptance');
  const repairing =
    input.role === 'fixer' ||
    (input.repair !== undefined && input.repair !== null);
  if (repairing && input.failures.length === 0) missing.push('failures');
  if (repairing && input.repair === null) missing.push('repair_state');
  if (input.role === 'reviewer' && input.pr_content === null)
    missing.push('pr_content');
  if (
    input.role === 'reviewer' &&
    (input.diff === null || input.diff.paths.length === 0)
  )
    missing.push('diff');
  const prompt =
    input.prompt === null
      ? null
      : (c.prompt_refs.find((p) => p.name === input.prompt) ?? null);
  if (input.prompt !== null && prompt === null)
    missing.push(`prompt:${input.prompt}`);
  if (missing.length > 0)
    return { ok: false, error: { kind: 'needs_context', missing } };

  const truncated: Truncation[] = [];
  let diff: RoleContext['diff'] = null;
  let diffBody = '';
  if (input.diff !== null) {
    const full = clean(input.diff.text);
    const kept = cut(full, input.limits.review_diff_bytes);
    const paths = input.diff.paths.map(clean);
    diff = { digest: hashText(full), paths, bytes: bytes(full) };
    let tail = '';
    if (kept.length < full.length) {
      const t: Truncation = {
        section: 'diff',
        kept_bytes: bytes(kept),
        original_bytes: bytes(full),
        digest: hashText(full),
      };
      truncated.push(t);
      tail = marker(t);
    }
    diffBody = `Range: ${clean(input.diff.from)}..${clean(input.diff.to)}\nDigest: ${diff.digest}\nChanged paths (${paths.length}):\n${list(paths)}\n\n\`\`\`diff\n${kept}\n\`\`\`${tail}`;
  }

  const header = [
    `Role: ${input.role}`,
    `Step: ${clean(input.step)}`,
    `Task: ${c.task_id} revision ${c.revision} (base ${c.base_sha})`,
    `Binding: ${clean(input.binding.harness)} / ${clean(input.binding.model)}${input.binding.effort === null ? '' : ` / effort ${clean(input.binding.effort)}`}`,
  ].join('\n');
  const sections: Section[] = [
    { name: 'header', body: header, required: true },
    { name: 'title', body: clean(c.request.title), required: true },
    { name: 'acceptance', body: list(c.acceptance.map(clean)), required: true },
    ...(repairing
      ? [
          {
            name: 'failures',
            body: input.failures
              .map(
                (f) =>
                  `### ${f.source}: ${clean(f.name)}${f.sha == null ? '' : ` @ ${f.sha}`}${f.generation == null ? '' : ` (run ${f.generation})`}\n${clean(f.detail)}`,
              )
              .join('\n\n'),
            required: true,
          },
        ]
      : []),
    ...(input.repair == null
      ? []
      : [
          {
            name: 'repair_state',
            body: repairBody(input.repair, clean),
            required: true,
          },
        ]),
    ...(input.publish == null
      ? []
      : [
          {
            name: 'publish_content',
            body: publishBody(input.publish, clean),
            required: true,
          },
        ]),
    ...(input.pr_content == null
      ? []
      : [
          {
            name: 'pr_content',
            body: `Title: ${clean(input.pr_content.pr_title)}\n\n${clean(input.pr_content.pr_body)}\n\nCommit message:\n${clean(input.pr_content.commit_message)}`,
            required: true,
          },
        ]),
    ...(input.role === 'reviewer'
      ? [{ name: 'diff', body: diffBody, required: true }]
      : []),
    {
      name: 'answers',
      body: input.answers
        .map(
          (a) =>
            `- (${a.question_id}) ${a.question === undefined ? '' : clean(a.question) + '\n  '}${clean(a.answer)}`,
        )
        .join('\n'),
      required: true,
    },
    {
      name: 'requirements',
      body: list(c.request.requirements.map(clean)),
      required: false,
    },
    {
      name: 'constraints',
      body: list(c.request.constraints.map(clean)),
      required: false,
    },
    {
      name: 'out_of_scope',
      body: list(c.request.out_of_scope.map(clean)),
      required: false,
    },
    {
      name: 'description',
      body: clean(c.request.description),
      required: false,
    },
    ...(input.repair != null && input.repair.diff !== ''
      ? [
          {
            name: 'worktree_diff',
            body: `\`\`\`diff\n${clean(input.repair.diff)}\n\`\`\``,
            required: false,
          },
        ]
      : []),
    ...(input.role === 'fixer' && diffBody !== ''
      ? [{ name: 'diff', body: diffBody, required: false }]
      : []),
    ...(prompt === null
      ? []
      : [
          {
            name: `prompt:${prompt.name}`,
            body: clean(prompt.content),
            required: false,
          },
        ]),
    ...c.conventions.map((d) => ({
      name: `convention:${d.name}`,
      body: clean(d.content),
      required: false,
    })),
    ...c.attachments.map((a) => ({
      name: `attachment:${a.name}`,
      body: `(${a.media_type})\n${clean(a.content)}`,
      required: false,
    })),
  ].filter((s) => s.body !== '');

  const render = (name: string, body: string): string =>
    `## ${name}\n${body}\n\n`;
  const requiredBytes = sections
    .filter((s) => s.required)
    .reduce((n, s) => n + bytes(render(s.name, s.body)), 0);
  if (requiredBytes > input.limits.context_bytes)
    return {
      ok: false,
      error: { kind: 'needs_context', missing: ['context_budget'] },
    };

  // Optional sections keep their order and fill what is left; one that does not fit is cut with a marker
  // (or reduced to the marker alone), so every cut is visible and nothing is silently lost.
  let room = input.limits.context_bytes - requiredBytes;
  let out = '';
  for (const s of sections) {
    const full = render(s.name, s.body);
    if (s.required) {
      out += full;
      continue;
    }
    const fullSize = bytes(full);
    if (fullSize <= room) {
      out += full;
      room -= fullSize;
      continue;
    }
    const probe: Truncation = {
      section: s.name,
      kept_bytes: 0,
      original_bytes: bytes(s.body),
      digest: hashText(s.body),
    };
    const overhead =
      bytes(render(s.name, '')) +
      bytes(marker({ ...probe, kept_bytes: probe.original_bytes }));
    const kept = room > overhead ? cut(s.body, room - overhead) : '';
    const t: Truncation = { ...probe, kept_bytes: bytes(kept) };
    truncated.push(t);
    const piece = kept === '' ? marker(t) : render(s.name, kept + marker(t));
    if (bytes(piece) <= room) {
      out += piece;
      room -= bytes(piece);
    }
  }
  return {
    ok: true,
    value: {
      text: out,
      digest: hashText(out),
      bytes: bytes(out),
      truncated,
      diff,
    },
  };
}

function repairBody(r: RepairState, clean: (s: string) => string): string {
  return [
    `Cause: ${r.cause}`,
    `Base: ${r.base_sha}`,
    `Checkpoint: ${r.checkpoint_sha ?? 'none'}`,
    `Published head: ${r.published_sha ?? 'none'}`,
    `PR: ${r.pr_ref === null ? 'none' : clean(r.pr_ref)}`,
    'Worktree status:',
    clean(r.worktree_status) === '' ? '(clean)' : clean(r.worktree_status),
  ].join('\n');
}

function publishBody(p: PublishBrief, clean: (s: string) => string): string {
  const parts = [
    `Write the commit message, PR title and PR description for this change as JSON {"commit_message", "pr_title", "pr_body"} to ${p.file}. Do not add <!-- cusr: ... --> markers; Cuesura adds its own. Update them when your change makes them inaccurate.`,
    p.template === null
      ? 'The repo has no PR template: write a plain description.'
      : `PR template (${clean(p.template.path)}), follow it:\n${clean(p.template.content)}`,
  ];
  if (p.current !== null)
    parts.push(
      `Current content:\nTitle: ${clean(p.current.pr_title)}\n\n${clean(p.current.pr_body)}\n\nCommit message:\n${clean(p.current.commit_message)}`,
    );
  return parts.join('\n\n');
}
