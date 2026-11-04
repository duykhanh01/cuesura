import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { validateConfig } from '../../src/config/validate.ts';
import { freeze } from '../../src/config/freeze.ts';
import type { ConfigSource, LoaderLimits } from '../../src/config/yaml-loader.ts';
import type { AuthzRole } from '../../src/domain/policy.ts';
import type { ValidatedConfig } from '../../src/domain/config.ts';
import type { DocContent } from '../../src/policy/finalize.ts';
import { authz, buildTask } from './builders.ts';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
export const CONFIGS = join(FIXTURES, 'configs');

export function source(path: string, file = basename(path)): ConfigSource {
  return { file, text: readFileSync(join(FIXTURES, path), 'utf8') };
}

export const PACKS = { node: source('packs/node.yaml') };

/**
 * Invalid-fixture headers: expect lists code/line/column triples separated by semicolons; role
 * defaults to user; with-project supplies project YAML; limits/overrides are JSON; caller selects
 * freeze permissions.
 */
export type FixtureHeader = {
  expect: { code: string; line: number; col: number }[];
  role: 'user' | 'project' | 'pack';
  withProject: string | null;
  limits: Partial<LoaderLimits>;
  overrides: Record<string, unknown> | null;
  caller: AuthzRole[];
};

export function parseHeader(text: string): FixtureHeader {
  const meta: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^# ([a-z-]+): (.*)$/.exec(line);
    if (!m) break;
    meta[m[1] as string] = m[2] as string;
  }
  const expect = (meta.expect ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => {
      const [code, line, col] = s.split(/\s+/);
      return { code: code as string, line: Number(line), col: Number(col) };
    });
  return {
    expect,
    role: (meta.role as FixtureHeader['role'] | undefined) ?? 'user',
    withProject: meta['with-project'] ?? null,
    limits: meta.limits ? (JSON.parse(meta.limits) as Partial<LoaderLimits>) : {},
    overrides: meta.overrides ? (JSON.parse(meta.overrides) as Record<string, unknown>) : null,
    caller: meta.caller ? (meta.caller.split(',') as AuthzRole[]) : ['operate'],
  };
}

const PACK_PROBE_PROJECT: ConfigSource = {
  file: 'cusr.yaml',
  text: 'version: 1\nextends: [probe]\ngates: { build: make, unit: make test }\nprofile: standard\n',
};

export function runInvalidFixture(name: string): {
  header: FixtureHeader;
  actual: { code: string; line: number; col: number }[];
} {
  const path = join('configs', 'invalid', name);
  const fixture = source(path);
  const header = parseHeader(fixture.text);
  const user = header.role === 'user' ? fixture : source('configs/valid/user.yaml');
  const project =
    header.role === 'project'
      ? fixture
      : header.role === 'pack'
        ? PACK_PROBE_PROJECT
        : header.withProject !== null
          ? source(join('configs', header.withProject), 'cusr.yaml')
          : undefined;
  const packs = header.role === 'pack' ? { ...PACKS, probe: fixture } : PACKS;

  const r = validateConfig({
    user,
    ...(project ? { project } : {}),
    packs,
    limits: header.limits,
  });
  if (!r.ok)
    return {
      header,
      actual: r.error.map((d) => ({ code: d.code, line: d.line, col: d.col })),
    };
  if (header.overrides === null) return { header, actual: [] };

  const fr = freeze({
    config: r.value.config,
    task: buildTask({ profile: 'standard' }),
    overrides: header.overrides,
    caller: authz(header.caller),
    base_sha: 'base0000',
    attachments: [],
    ...docsFor(r.value.config),
  });
  if (fr.ok) return { header, actual: [] };
  if (fr.error.code === 'config_invalid') {
    return {
      header,
      actual: fr.error.diagnostics.map((d) => ({
        code: d.code,
        line: d.line,
        col: d.col,
      })),
    };
  }
  return { header, actual: [{ code: fr.error.code, line: 1, col: 1 }] };
}

export function invalidFixtureNames(): string[] {
  return readdirSync(join(CONFIGS, 'invalid'))
    .filter((f) => f.endsWith('.yaml'))
    .sort();
}

export const MIN_PARTS = {
  head: `version: 1
harnesses: { claude: { cmd: claude, auth: subscription, pool: claude } }
pools: { claude: 1 }
models: { sonnet: { harness: claude, id: sonnet, tier: 2 }, opus: { harness: claude, id: opus, tier: 3 } }
`,
  roles: `roles:
  coder: { binding: [{ model: sonnet }] }
  fixer: { binding: [{ model: sonnet }] }
  reviewer: { permissions: read_only, binding: [{ model: sonnet }] }
  scout: { permissions: read_only, binding: [{ model: sonnet }] }
`,
  workflows: `workflows:
  impl: { base: software_dev@1 }
`,
  profiles: `profiles:
  standard: { workflow: impl }
`,
};

export function minUser(parts: Partial<typeof MIN_PARTS> = {}, extra = ''): ConfigSource {
  const p = { ...MIN_PARTS, ...parts };
  return {
    file: 'config.yaml',
    text: p.head + p.roles + p.workflows + p.profiles + extra,
  };
}

export const MIN_PROJECT: ConfigSource = {
  file: 'cusr.yaml',
  text: 'version: 1\ngates: { build: make, unit: make test, lint: make lint }\nprofile: standard\n',
};

export function docsFor(config: ValidatedConfig): {
  prompts: DocContent[];
  conventions: DocContent[];
} {
  const doc = (name: string): DocContent => ({ name, content: `# ${name}\n` });
  const prompts = Object.values(config.user.roles).flatMap((r) =>
    r.prompt === null ? [] : [doc(r.prompt)],
  );
  return { prompts, conventions: (config.project?.conventions ?? []).map(doc) };
}
