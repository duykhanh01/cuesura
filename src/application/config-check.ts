/**
 * Every problem in the config a task of a project would start with, reported at once (#311, #315):
 * `task add` warns with it, `task options` refuses with it, and doctor may report it. It reads the base
 * this machine already has, without a fetch, so it is a forecast; start fetches and checks again.
 */
import { parseDocument, stringify } from 'yaml';
import type { GitPort } from '../adapters/ports.ts';
import { validateConfig, type Validated } from '../config/validate.ts';
import { loadYaml, type ConfigSource } from '../config/yaml-loader.ts';
import type { Diagnostic } from '../domain/config.ts';
import { resolveRunProfile } from '../domain/run-config.ts';
import { err, ok, type Result } from '../shared/result.ts';
import { readLocalBaseConfig } from './preflight.ts';
import { profileRecoveryCommand } from './run-config.ts';
import { MINIMAL_PROJECT_CONFIG_LINE } from '../config/minimal-project.ts';

const MINIMAL_HINT = `minimal cusr.yaml (profile from the user config): ${MINIMAL_PROJECT_CONFIG_LINE}`;

export type ConfigProblem = {
  /** Which part of the config, e.g. `profile`, `gates` or a diagnostic code. */
  readonly check: string;
  readonly message: string;
  /** The edit the user makes; nothing here makes it. */
  readonly fix: string | null;
};

export type ConfigCheckSubject = {
  readonly project: string;
  readonly base_branch: string;
  /** The task's own profile, which wins over the project's. */
  readonly profile: string | null;
  readonly proposed_profile?: string | null;
};

export type ConfigCheckInputs = {
  readonly user: ConfigSource;
  readonly packs: Readonly<Record<string, ConfigSource>>;
};

export type ConfigCheck = {
  /** The resolved base of the project config; null when the check could not resolve it. */
  readonly base: { readonly ref: string; readonly sha: string } | null;
  readonly problems: readonly ConfigProblem[];
  /** Present only when there are no problems. */
  readonly ready: {
    readonly validated: Validated;
    readonly profile: { readonly id: string; readonly source: 'project' | 'task' };
  } | null;
};

/** Git could not resolve the base or read its files. */
export type ConfigCheckUnavailable = {
  readonly detail: string;
  readonly base: ConfigCheck['base'];
};

const where = (d: Diagnostic): string => `${d.file}:${String(d.line)}:${String(d.col)}`;

function diagnosticFix(d: Diagnostic, profiles: readonly string[]): string {
  switch (d.code) {
    case 'required_gate_missing':
      return `declare that gate under \`gates:\` in cusr.yaml, or change the workflow's \`gates.required\` in the user config`;
    case 'unknown_profile':
      return `set \`profile:\` to one of: ${profiles.join(', ') || '(none declared in the user config)'}`;
    default:
      return `edit ${where(d)} (${d.path.join('.') || 'top level'})`;
  }
}

/** `located: false` for a diagnostic of a pruned copy, whose lines are not the file's. */
const fromDiagnostics = (
  ds: readonly Diagnostic[],
  profiles: readonly string[],
  located = true,
): ConfigProblem[] =>
  ds.map((d) => ({
    check: d.code,
    message: `${located ? where(d) : `${d.file} (${d.path.join('.') || 'top level'})`}: ${d.message}`,
    fix: diagnosticFix(d, profiles),
  }));

const diagnosticKey = (d: Diagnostic): string => `${d.code}|${d.path.join('.')}|${d.message}`;

/** A key the schema does not know, or one only another layer may set: dropping it hides nothing else. */
const droppable = (d: Diagnostic, file: string): boolean =>
  d.file === file &&
  d.path.length > 0 &&
  (d.code === 'forbidden_key' ||
    d.code === 'unknown_pack' ||
    (d.code === 'schema_invalid' && /^Key '.*' is not supported$/.test(d.message)));

/** Removes the value at `path`, if there; a list item is spliced out. */
function deletePath(root: unknown, path: readonly (string | number)[]): void {
  let node = root;
  for (const k of path.slice(0, -1)) {
    if (typeof node !== 'object' || node === null) return;
    node = (node as Record<string | number, unknown>)[k];
  }
  const last = path.at(-1);
  if (Array.isArray(node) && typeof last === 'number') node.splice(last, 1);
  else if (typeof node === 'object' && node !== null && last !== undefined)
    delete (node as Record<string | number, unknown>)[last];
}

/**
 * The project config without the keys those diagnostics name, or null when none can be dropped. Aliases
 * are resolved into separate copies first, so dropping a key never leaves an alias without its anchor
 * and dropping one reached through an alias leaves the other uses alone.
 */
function pruned(project: ConfigSource, ds: readonly Diagnostic[]): ConfigSource | null {
  const paths = ds.filter((d) => droppable(d, project.file)).map((d) => d.path);
  if (paths.length === 0) return null;
  const doc = parseDocument(project.text);
  if (doc.errors.length > 0) return null;
  const value: unknown = JSON.parse(JSON.stringify(doc.toJS()));
  // Deepest and last first, so an earlier list index still points at its item.
  const ordered = [...paths].sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    const x = a.at(-1);
    const y = b.at(-1);
    return typeof x === 'number' && typeof y === 'number' ? y - x : 0;
  });
  for (const path of ordered) deletePath(value, path);
  return { file: project.file, text: stringify(value, { aliasDuplicateObjects: false }) };
}

function rawDoc(project: ConfigSource): Record<string, unknown> | null {
  const loaded = loadYaml(project);
  const v = loaded.ok ? loaded.value.value : null;
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

const nonEmpty = (v: unknown): boolean =>
  Array.isArray(v)
    ? v.length > 0
    : typeof v === 'object' && v !== null && Object.keys(v).length > 0;

/**
 * What a failed validation leaves unsaid: it never looks at the profile or `ci.required_checks`. Read from the raw document, so a pack's gates are not seen.
 */
function rawProblems(
  project: ConfigSource,
  subject: ConfigCheckSubject,
  userProfiles: Validated['config']['profiles'],
  reported: readonly Diagnostic[],
): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  // The task's profile does not depend on the file, so it is checked even when the file does not parse.
  const profiles = Object.keys(userProfiles);
  const missing = (id: string) =>
    !profiles.includes(id) &&
    !reported.some((d) => d.code === 'unknown_profile' && d.message.includes(`'${id}'`));
  if (subject.profile !== null && missing(subject.profile))
    out.push(unknownProfile(subject.profile, profiles));
  const doc = rawDoc(project);
  // Otherwise a document that does not parse has only its parse errors to report.
  if (doc === null) return out;
  const named = typeof doc['profile'] === 'string' ? doc['profile'] : null;
  const id = resolveRunProfile(subject.profile, named, subject.proposed_profile);
  if (id === null) out.push(noProfile(profiles));
  else if (subject.profile === null && named === null && missing(id))
    out.push(unknownProfile(id, profiles));
  const ci = doc['ci'];
  const checks =
    typeof ci === 'object' && ci !== null
      ? (ci as Record<string, unknown>)['required_checks']
      : undefined;
  if (!nonEmpty(checks)) out.push(noRequiredChecks());
  return out;
}

/**
 * Pure: every problem of the user config and the project config at a base, for one subject. The project
 * config is `null` when the base has no `cusr.yaml`.
 */
export function projectConfigProblems(
  inputs: ConfigCheckInputs,
  subject: ConfigCheckSubject,
  project: ConfigSource | null,
  baseLabel: string,
): Pick<ConfigCheck, 'problems' | 'ready'> {
  const userOnly = validateConfig({ user: inputs.user, packs: {} });
  if (!userOnly.ok) return { problems: fromDiagnostics(userOnly.error, []), ready: null };
  const profiles = Object.keys(userOnly.value.config.profiles);
  const problems: ConfigProblem[] = [];
  if (userOnly.value.runtime === null)
    problems.push({
      check: 'runtime',
      message: 'the `runtime:` section is required by cusrd',
      fix: 'add `runtime:` to the user config',
    });
  if (project === null)
    problems.push({
      check: 'project_config',
      message: `${baseLabel} has no cusr.yaml`,
      fix: `commit cusr.yaml to the base branch; ${MINIMAL_HINT}`,
    });

  const full = validateConfig({
    user: inputs.user,
    ...(project === null ? {} : { project }),
    packs: { ...inputs.packs },
  });
  if (full.ok) return ready(full.value, subject, profiles, problems);
  problems.push(...fromDiagnostics(full.error, profiles));
  if (project === null) return { problems, ready: null };

  // An unsupported key stops validation before the checks that need the whole config (profile, gates):
  // drop such keys from a copy and validate again, so independent problems show in the same report.
  const seen = new Set(full.error.map(diagnosticKey));
  let current = project;
  let last = full.error;
  for (let round = 0; round < 3; round++) {
    let next: ConfigSource | null;
    let again: ReturnType<typeof validateConfig>;
    // Pruning only adds detail; a copy it cannot make or validate leaves the report as it is.
    try {
      next = pruned(current, last);
      if (next === null) break;
      again = validateConfig({ user: inputs.user, project: next, packs: { ...inputs.packs } });
    } catch {
      break;
    }
    if (again.ok) {
      const rest = ready(again.value, subject, profiles, []).problems;
      return { problems: [...problems, ...rest], ready: null };
    }
    const fresh = again.error.filter((d) => !seen.has(diagnosticKey(d)));
    for (const d of fresh) seen.add(diagnosticKey(d));
    problems.push(...fromDiagnostics(fresh, profiles, false));
    current = next;
    last = again.error;
  }
  problems.push(
    ...rawProblems(current, subject, userOnly.value.config.profiles, [...full.error, ...last]),
  );
  return { problems, ready: null };
}

/** The checks validation leaves to the task: a profile, the gates it needs, and required CI checks. */
function ready(
  validated: Validated,
  subject: ConfigCheckSubject,
  profiles: readonly string[],
  problems: ConfigProblem[],
): Pick<ConfigCheck, 'problems' | 'ready'> {
  const config = validated.config;
  const projectProfile = config.project?.profile ?? null;
  const id = resolveRunProfile(subject.profile, projectProfile, subject.proposed_profile);
  if (id === null) problems.push(noProfile(profiles));
  else if (!profiles.includes(id)) problems.push(unknownProfile(id, profiles));
  if ((config.project?.required_checks ?? []).length === 0) problems.push(noRequiredChecks());

  return problems.length > 0 || id === null
    ? { problems, ready: null }
    : {
        problems,
        ready: {
          validated,
          profile: {
            id,
            source: subject.profile === null && projectProfile !== null ? 'project' : 'task',
          },
        },
      };
}

function unknownProfile(id: string, profiles: readonly string[]): ConfigProblem {
  return {
    check: 'unknown_profile',
    message: `profile '${id}' does not exist in the user config`,
    fix: `use one of: ${profiles.join(', ') || '(none declared in the user config)'}`,
  };
}

function noProfile(profiles: readonly string[]): ConfigProblem {
  return {
    check: 'profile',
    message: 'neither the task nor the project selects a profile',
    fix:
      profiles.length === 0
        ? `declare a profile in the user config, then run ${profileRecoveryCommand()}`
        : `run ${profileRecoveryCommand()} with one of these profiles: ${profiles.join(', ')}`,
  };
}

function noRequiredChecks(): ConfigProblem {
  return {
    check: 'required_checks',
    message: 'cusr.yaml must declare a non-empty ci.required_checks',
    fix: 'add `ci: { required_checks: [<CI check name>] }` to cusr.yaml on the base branch',
  };
}

/**
 * Reads the project config at `origin/<base_branch>` as this machine has it and returns every problem at
 * once. The user config is checked first: without the project's path the base cannot be read.
 */
export async function checkProjectConfig(
  git: GitPort,
  inputs: ConfigCheckInputs,
  subject: ConfigCheckSubject,
): Promise<Result<ConfigCheck, ConfigCheckUnavailable>> {
  const userOnly = validateConfig({ user: inputs.user, packs: {} });
  if (!userOnly.ok)
    return ok({ base: null, problems: fromDiagnostics(userOnly.error, []), ready: null });
  const location = userOnly.value.locations[subject.project];
  const locationProblems: ConfigProblem[] = [];
  if (location === undefined)
    locationProblems.push({
      check: 'project',
      message: `project '${subject.project}' is not in the allowlist`,
      fix: `add projects.${subject.project} with path and repo to the user config`,
    });
  else {
    if (location.path === null)
      locationProblems.push({
        check: 'project_path',
        message: `projects.${subject.project}.path is not set in the user config`,
        fix: `add projects.${subject.project}.path (the clone cusrd owns) to the user config`,
      });
    if (location.repo === null)
      locationProblems.push({
        check: 'project_repo',
        message: `projects.${subject.project}.repo is required by cusrd`,
        fix: `add projects.${subject.project}.repo (owner/name on GitHub) to the user config`,
      });
  }
  const path = location?.path ?? null;
  if (path === null) return ok({ base: null, problems: locationProblems, ready: null });
  const ref = `origin/${subject.base_branch}`;
  const read = await readLocalBaseConfig(git, path, subject.base_branch);
  if (!read.ok) {
    if (read.error.kind === 'unavailable') {
      const sha = read.error.base_sha;
      if (sha === null)
        return err({
          base: null,
          detail: `${read.error.detail}. Run git fetch origin in the project clone at ${path}, then verify ${ref} exists`,
        });
      return err({
        base: { ref, sha },
        detail: `could not read cusr.yaml at ${ref} (${sha}): ${read.error.detail}. Check the project clone at ${path} and retry`,
      });
    }
    return ok({
      base: { ref, sha: read.error.base_sha },
      problems: [
        {
          check: 'project_config',
          message: read.error.detail,
          fix: `fix cusr.yaml on ${subject.base_branch}; ${MINIMAL_HINT}`,
        },
      ],
      ready: null,
    });
  }
  const base = { ref, sha: read.value.base_sha };
  const found = projectConfigProblems(inputs, subject, read.value.config, `${ref} (${base.sha})`);
  return ok(
    locationProblems.length === 0
      ? { base, ...found }
      : { base, problems: [...locationProblems, ...found.problems], ready: null },
  );
}

/** At most this many problems of one kind are listed; the rest are counted. */
export const PROBLEMS_PER_KIND = 5;

/**
 * The problems to show: every kind keeps its first few and its fix, so many problems of one kind (say
 * unsupported keys) never push the fix of another kind out of the report.
 */
export function cappedProblems(problems: readonly ConfigProblem[]): ConfigProblem[] {
  const byKind = new Map<string, ConfigProblem[]>();
  for (const p of problems) byKind.set(p.check, [...(byKind.get(p.check) ?? []), p]);
  return [...byKind.values()].flatMap((group) => {
    const shown = group.slice(0, PROBLEMS_PER_KIND);
    const more = group.length - shown.length;
    const last = group.at(-1) as ConfigProblem;
    return more === 0
      ? shown
      : [...shown, { check: last.check, message: `+${String(more)} more`, fix: last.fix }];
  });
}

/** One line per problem, with its fix, as the CLI prints `checks`. */
export function problemChecks(
  problems: readonly ConfigProblem[],
): { name: string; status: 'fail'; detail: string; fix: string | null }[] {
  return cappedProblems(problems).map((p) => ({
    name: p.check,
    status: 'fail',
    detail: p.message,
    fix: p.fix,
  }));
}
