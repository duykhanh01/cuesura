import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  cappedProblems,
  PROBLEMS_PER_KIND,
  projectConfigProblems,
} from '../../../src/application/config-check.ts';
import {
  MINIMAL_PROJECT_CONFIG,
  MINIMAL_PROJECT_CONFIG_LINE,
} from '../../../src/config/minimal-project.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import { CUSR, userConfig } from '../../support/preflight-fakes.ts';

// #311, #315: one check lists every config problem a task would meet, each with a fix.

const inputs = { user: userConfig(), packs: PACKS };
const subject = { project: 'acme', base_branch: 'main', profile: null };
const cusr = (text: string) => ({ file: 'cusr.yaml', text });
const check = (text: string | null, profile: string | null = null) =>
  projectConfigProblems(
    inputs,
    { ...subject, profile },
    text === null ? null : cusr(text),
    'origin/main (abc)',
  );
const names = (r: ReturnType<typeof check>) => r.problems.map((p) => p.check).sort();

describe('projectConfigProblems', () => {
  it('a cusr.yaml with only `version: 1` reports profile and required checks at once', () => {
    const r = check('version: 1\n');
    expect(names(r)).toEqual(['profile', 'required_checks']);
    expect(r.ready).toBeNull();
    for (const p of r.problems) expect(p.fix).toEqual(expect.any(String));
    expect(r.problems.find((p) => p.check === 'profile')?.fix).toContain('standard');
  });

  it('a project without gates has no gate problem', () => {
    const r = check('version: 1\nprofile: standard\nci: { required_checks: [test] }\n');
    expect(r.problems).toEqual([]);
    expect(r.ready).not.toBeNull();
    expect(check('version: 1\nprofile: standard\n').problems.map((p) => p.check)).toEqual([
      'required_checks',
    ]);
  });

  it('the minimal sample, with its gates commented out, is ready', () => {
    const r = check(MINIMAL_PROJECT_CONFIG.replace('profile: default', 'profile: standard'));
    expect(r.problems).toEqual([]);
    expect(r.ready).not.toBeNull();
  });

  it('no cusr.yaml at the base says so and lists the rest, with the minimal config as the fix', () => {
    const r = check(null);
    expect(names(r)).toEqual(['profile', 'project_config', 'required_checks']);
    expect(r.problems.find((p) => p.check === 'project_config')?.message).toContain(
      'origin/main (abc)',
    );
    expect(r.problems.find((p) => p.check === 'project_config')?.fix).toContain(
      MINIMAL_PROJECT_CONFIG_LINE,
    );
  });

  it('an unknown profile names the profiles to choose from', () => {
    const r = check(
      'version: 1\nprofile: nope\ngates: { build: b, unit: u }\nci: { required_checks: [b] }\n',
    );
    expect(names(r)).toEqual(['unknown_profile']);
    expect(r.problems[0]?.fix).toContain('standard');
  });

  it('the minimal config of the help is ready to run a task with the example user config', () => {
    const user = {
      file: 'config.yaml',
      text: readFileSync(new URL('../../../deploy/config.example.yaml', import.meta.url), 'utf8'),
    };
    const r = projectConfigProblems(
      { user, packs: {} },
      { ...subject, project: 'my-app' },
      cusr(MINIMAL_PROJECT_CONFIG),
      'origin/main',
    );
    expect(r.problems).toEqual([]);
    expect(r.ready?.profile).toEqual({ id: 'default', source: 'project' });
  });

  it('the one-line minimal config is the same config', () => {
    expect(parse(MINIMAL_PROJECT_CONFIG_LINE)).toEqual(parse(MINIMAL_PROJECT_CONFIG));
  });

  it('a gate the workflow requires but cusr.yaml lacks is named with a fix', () => {
    const r = check(
      'version: 1\nprofile: standard\ngates: { unit: u }\nci: { required_checks: [u] }\n',
    );
    expect(r.problems).toEqual([
      expect.objectContaining({
        check: 'required_gate_missing',
        message: expect.stringContaining("'build'") as string,
        fix: expect.stringContaining('gates:') as string,
      }),
    ]);
  });

  it('a cusr.yaml that does not parse reports its parse error alone', () => {
    const r = check('version: 1\nprofile: [\n');
    expect(r.problems.length).toBeGreaterThan(0);
    expect(names(r)).not.toContain('required_checks');
  });

  it('a complete config is ready', () => {
    expect(check(CUSR).problems).toEqual([]);
  });

  it('a user config without runtime is reported with the project problems', () => {
    const r = projectConfigProblems(
      { user: userConfig({ runtime: null }), packs: PACKS },
      subject,
      cusr('version: 1\n'),
      'origin/main',
    );
    expect(names(r)).toEqual(['profile', 'required_checks', 'runtime']);
  });

  it('an unsupported key does not hide a missing required gate (review of #326)', () => {
    const r = check(
      'version: 1\nprofile: standard\ngates: { unit: u }\nci: { required_checks: [u] }\nextra: 1\n',
    );
    expect(names(r)).toEqual(['required_gate_missing', 'schema_invalid']);
    expect(r.problems.find((p) => p.check === 'required_gate_missing')?.message).toContain(
      "'build'",
    );
  });

  it('an unknown task profile is reported next to another validation failure', () => {
    const r = check('version: 1\nprofile: [\n', 'nope');
    expect(names(r)).toContain('unknown_profile');
  });

  it('an unknown task profile is reported next to an unsupported key', () => {
    const r = check(`${CUSR}extra: 1\n`, 'nope');
    expect(names(r)).toEqual(['schema_invalid', 'unknown_profile']);
  });
});

describe('aliases and profiles (re-check of #326)', () => {
  it('dropping an unsupported anchored key keeps the alias that uses it', () => {
    const r = check(
      'version: 1\nprofile: standard\nextra: &g { unit: u }\ngates: *g\nci: { required_checks: [u] }\n',
    );
    expect(names(r)).toEqual(['required_gate_missing', 'schema_invalid']);
  });

  it('dropping an unsupported key reached through an alias does not throw', () => {
    const r = check(
      'version: 1\nprofile: standard\nx-base: &g { unit: u }\nautofix: *g\ngates: { unit: u, extra: { bad: 1 } }\nci: { required_checks: [u] }\n',
    );
    expect(r.problems.length).toBeGreaterThan(0);
    expect(names(r)).toContain('schema_invalid');
  });

  it('an unknown task profile and an unknown project profile are both reported', () => {
    const r = check(
      'version: 1\nprofile: missingproject\ngates: { build: b, unit: u }\nci: { required_checks: [b] }\n',
      'missingtask',
    );
    const unknown = r.problems.filter((p) => p.check === 'unknown_profile').map((p) => p.message);
    expect(unknown).toHaveLength(2);
    expect(unknown.join(' ')).toContain("'missingproject'");
    expect(unknown.join(' ')).toContain("'missingtask'");
  });
});

describe('unknown packs', () => {
  it('several unknown packs are dropped by index from the last, keeping the known one', () => {
    const packs = Array.from({ length: 11 }, (_, i) => `p${String(i)}`).join(', ');
    const r = check(CUSR.replace('extends: [node]', `extends: [${packs}, node]`));
    expect(names(r).every((n) => n === 'unknown_pack')).toBe(true);
    expect(r.problems).toHaveLength(11);
  });
});

describe('cappedProblems', () => {
  it('keeps every kind and its fix when one kind has many problems', () => {
    const keys = Array.from({ length: 21 }, (_, i) => `k${String(i)}: 1`).join('\n');
    const r = check(`version: 1\n${keys}\n`);
    expect(r.problems.length).toBe(23);
    const shown = cappedProblems(r.problems);
    expect([...new Set(shown.map((p) => p.check))].sort()).toEqual([
      'profile',
      'required_checks',
      'schema_invalid',
    ]);
    const schema = shown.filter((p) => p.check === 'schema_invalid');
    expect(schema).toHaveLength(PROBLEMS_PER_KIND + 1);
    expect(schema.at(-1)?.message).toBe(`+${String(21 - PROBLEMS_PER_KIND)} more`);
    for (const p of shown) expect(p.fix).toEqual(expect.any(String));
  });
});
