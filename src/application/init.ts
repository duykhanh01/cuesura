/**
 * `cusr init`, PR part: put cusr's PR template and the write-pr skill into a repo's working tree. It
 * never commits. cusr reads the template from the base commit, so it applies once committed there.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { INSTALLED_PR_TEMPLATE, WRITE_PR_SKILL_PATH } from '../domain/templates.ts';
import { TEMPLATE_RE } from './run-config.ts';

export const PR_TEMPLATE_TARGET = '.github/pull_request_template.md';
/** Codex reads skills from `.agents/skills`, Claude Code from `.claude/skills`. */
export const WRITE_PR_SKILL_PATHS = [
  WRITE_PR_SKILL_PATH,
  '.claude/skills/write-pr/SKILL.md',
] as const;

/** The skill shipped with cusr; `pnpm build` copies `src/assets` next to the compiled modules. */
export function writePrSkill(): string {
  return readFileSync(new URL('../assets/write-pr/SKILL.md', import.meta.url), 'utf8');
}

export type InitFileStatus = 'created' | 'unchanged' | 'updated' | 'kept' | 'skipped';

export type InitFile = {
  readonly path: string;
  readonly status: InitFileStatus;
  readonly reason?: string;
};

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function configuredTemplate(root: string): string | null {
  try {
    const raw: unknown = parse(readFileSync(join(root, 'cusr.yaml'), 'utf8'));
    const value =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)['pr_template']
        : undefined;
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}

/** PR templates in the working tree where cusr looks for them, plus the one `cusr.yaml` names. */
export function existingPrTemplates(root: string): string[] {
  const found = new Set<string>();
  for (const dir of ['', '.github', 'docs']) {
    for (const name of entries(join(root, dir))) {
      const rel = dir === '' ? name : `${dir}/${name}`;
      if (TEMPLATE_RE.test(rel)) found.add(rel);
      else if (/^pull_request_template$/i.test(name))
        for (const inner of entries(join(root, rel)))
          if (TEMPLATE_RE.test(`${rel}/${inner}`)) found.add(`${rel}/${inner}`);
    }
  }
  const configured = configuredTemplate(root);
  if (configured !== null) found.add(configured);
  return [...found].sort();
}

function place(root: string, path: string, content: string, force: boolean): InitFile {
  const full = join(root, path);
  if (!existsSync(full)) {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return { path, status: 'created' };
  }
  if (readFileSync(full, 'utf8') === content) return { path, status: 'unchanged' };
  if (!force) return { path, status: 'kept', reason: 'it differs from the copy shipped with cusr' };
  writeFileSync(full, content);
  return { path, status: 'updated' };
}

export type InitItemId = 'write-pr';
export const INIT_ITEM_IDS: readonly InitItemId[] = ['write-pr'];

export type InitItem = {
  readonly id: InitItemId;
  readonly label: string;
  readonly description: string;
  /** Why the item cannot be installed in this repo; null when it can. */
  readonly unavailable: string | null;
};

/** The repo's own PR template, which cusr keeps; null when there is none or it is the one cusr wrote. */
function ownTemplates(root: string): string | null {
  const templates = existingPrTemplates(root);
  if (templates.length === 0) return null;
  const ours =
    templates.length === 1 &&
    templates[0] === PR_TEMPLATE_TARGET &&
    readFileSync(join(root, PR_TEMPLATE_TARGET), 'utf8') === INSTALLED_PR_TEMPLATE;
  return ours ? null : templates.join(', ');
}

/**
 * What `cusr init` offers for this repo. The PR template points to the write-pr skill, so they come as
 * one item; a repo with its own template gets the skill alone, since a second template would leave cusr
 * unable to choose and the skill works with any template.
 */
export function initItems(root: string): InitItem[] {
  const own = ownTemplates(root);
  return [
    {
      id: 'write-pr',
      label: 'write-pr: PR template and skill',
      description:
        own === null
          ? 'PR template (Why, Changes, Evidence, Merge risk) and the skill that fills it'
          : `The skill for writing PR descriptions; keeps your ${own}`,
      unavailable: null,
    },
  ];
}

/** A file could not be written; `done` lists what was installed before it, which stays in place. */
export class InitWriteError extends Error {
  override name = 'InitWriteError';
  readonly path: string;
  readonly done: readonly InitFile[];

  constructor(path: string, done: readonly InitFile[], cause: unknown) {
    super(`cannot write ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.path = path;
    this.done = done;
  }
}

/** Installs the chosen items. `force` replaces skill files that differ, never a template the user wrote. */
export function installInitItems(
  root: string,
  ids: readonly InitItemId[],
  opts: { readonly force: boolean },
): InitFile[] {
  if (!ids.includes('write-pr')) return [];
  const own = ownTemplates(root);
  const done: InitFile[] = [];
  const write = (path: string, content: string, force: boolean) => {
    try {
      done.push(place(root, path, content, force));
    } catch (e) {
      throw new InitWriteError(path, [...done], e);
    }
  };
  const skill = writePrSkill();
  for (const p of WRITE_PR_SKILL_PATHS) write(p, skill, opts.force);
  // Last, so the template never points to a skill that failed to install.
  if (own === null) write(PR_TEMPLATE_TARGET, INSTALLED_PR_TEMPLATE, false);
  else
    done.push({
      path: PR_TEMPLATE_TARGET,
      status: 'skipped',
      reason: `the repo already has ${own}`,
    });
  return done;
}
