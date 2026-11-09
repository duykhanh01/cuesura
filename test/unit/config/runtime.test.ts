import { describe, expect, it } from 'vitest';
import {
  freeze,
  freezeRuntimeContext,
  type RuntimeFreezeInput,
} from '../../../src/config/freeze.ts';
import type { RuntimeConfig } from '../../../src/config/normalize.ts';
import { validateConfig, type Validated } from '../../../src/config/validate.ts';
import type { ConfigSource } from '../../../src/config/yaml-loader.ts';
import {
  DEFAULT_RUNTIME_LIMITS,
  FrozenRuntimeContextSchema,
  verifyRuntimeHash,
} from '../../../src/domain/runtime.ts';
import { resolveMergeMethod } from '../../../src/domain/merge-method.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';
import { authz, buildTask } from '../../support/builders.ts';
import { docsFor, MIN_PROJECT, minUser, PACKS, source } from '../../support/config-fixtures.ts';

const PROJECTS = `projects:
  acme: { base_branch: main, path: /srv/acme, repo: acme/app }
`;

function validate(extra: string, project: ConfigSource = MIN_PROJECT) {
  return validateConfig({
    user: minUser({}, PROJECTS + extra),
    project,
    packs: PACKS,
  });
}

function valid(extra: string): Validated {
  const r = validate(extra);
  if (!r.ok) throw new Error(JSON.stringify(r.error, null, 2));
  return r.value;
}

function errors(
  extra: string,
  project?: ConfigSource,
): { code: string; path: string; message: string }[] {
  const r = validate(extra, project);
  if (r.ok) return [];
  return r.error.map((d) => ({
    code: d.code,
    path: d.path.join('.'),
    message: d.message,
  }));
}

function paths(extra: string): string[] {
  return errors(extra).map((e) => e.path);
}

describe('intake.auto_confirm (T135, #248)', () => {
  it('lists the requesters outside the hashed user config; absent means none', () => {
    const on = valid('intake: { auto_confirm: [assistant] }\n');
    const off = valid('');
    expect(on.intakeAutoConfirm).toEqual(['assistant']);
    expect(off.intakeAutoConfirm).toEqual([]);
    expect(on.config.hashes).toEqual(off.config.hashes);
  });

  it('rejects an unknown key or an empty name', () => {
    expect(paths('intake: { auto_confirm: [assistant], max_per_day: 3 }\n')).toEqual([
      'intake.max_per_day',
    ]);
    expect(paths("intake: { auto_confirm: [''] }\n")).toEqual(['intake.auto_confirm.0']);
  });
});

describe('projects.<id>.path / repo', () => {
  it('exposes path and repo as locations, outside the hashed user config', () => {
    const v = valid('');
    expect(v.locations).toEqual({
      acme: { path: '/srv/acme', repo: 'acme/app', base_branch: 'main' },
    });
    expect(v.config.user.projects?.acme).toEqual({
      base_branch: 'main',
      protected_branches: ['main'],
    });
  });

  it('lists every declared project with null for unset fields', () => {
    const r = validateConfig({
      user: minUser(
        {},
        'projects: { acme: { base_branch: main }, beta: { base_branch: dev, repo: beta/app } }\n',
      ),
      project: MIN_PROJECT,
      packs: PACKS,
    });
    expect(r.ok && r.value.locations).toEqual({
      acme: { path: null, repo: null, base_branch: 'main' },
      beta: { path: null, repo: 'beta/app', base_branch: 'dev' },
    });
  });

  it('has no locations when projects is not declared', () => {
    const r = validateConfig({
      user: minUser(),
      project: MIN_PROJECT,
      packs: PACKS,
    });
    expect(r.ok && r.value.locations).toEqual({});
  });

  it.each(['srv/acme', '/srv/../etc', '/srv/./acme', '/srv//acme', '/srv/acme/', '/'])(
    'rejects non-canonical path %s',
    (p) => {
      const r = validateConfig({
        user: minUser({}, `projects: { acme: { base_branch: main, path: "${p}" } }\n`),
        project: MIN_PROJECT,
        packs: PACKS,
      });
      expect(r.ok ? [] : r.error.map((d) => d.path.join('.'))).toEqual(['projects.acme.path']);
    },
  );

  it.each(['acme', 'acme/app/x', 'https://github.com/acme/app', 'acme/..', '-acme/app'])(
    'rejects repo slug %s',
    (repo) => {
      const r = validateConfig({
        user: minUser({}, `projects: { acme: { base_branch: main, repo: "${repo}" } }\n`),
        project: MIN_PROJECT,
        packs: PACKS,
      });
      expect(r.ok ? [] : r.error.map((d) => d.path.join('.'))).toEqual(['projects.acme.repo']);
    },
  );
});

describe('runtime config', () => {
  it('defaults to unlimited command execution and accepts an explicit null', () => {
    expect(valid('runtime: {}\n').runtime?.limits.command_wall_ms).toBeNull();
    expect(
      valid('runtime: { limits: { command_wall_ms: null } }\n').runtime?.limits.command_wall_ms,
    ).toBeNull();
    expect(
      valid('runtime: { limits: { command_wall_ms: 1000 } }\n').runtime?.limits.command_wall_ms,
    ).toBe(1000);
  });

  it('is null when runtime is not declared', () => {
    expect(valid('').runtime).toBeNull();
  });

  it('normalizes with defaults', () => {
    const v = valid('runtime: {}\n');
    expect(v.runtime).toEqual({
      data_dir: null,
      concurrency: 1,
      slot_reservation_hours: 24,
      limits: DEFAULT_RUNTIME_LIMITS,
      tool_paths: {},
      credential_refs: [],
      access_tokens_ignored: false,
      harness_isolation: { claude: 'internal_required' },
      modes: {
        'direct-pr': { when_to_use: null },
        'full-review': { when_to_use: null },
      },
      terminal: { backend: 'background' },
    } satisfies RuntimeConfig);
  });

  it('normalizes a full runtime section', () => {
    const v = valid(`runtime:
  data_dir: /var/lib/cusr
  concurrency: 3
  slot_reservation_hours: 6
  limits: { poll_initial_ms: 30000, spool_bytes: 134217728 }
  tool_paths: { git: /usr/bin/git, bwrap: /usr/bin/bwrap }
  credential_refs: { harness_claude: /srv/cred/claude.json, github: /srv/cred/gh.token }
  access_tokens:
    - { id: assistant-work, actor: assistant, roles: [operate, read], projects: [acme], token_file: /srv/access/a.token }
  harness_isolation: { claude: allow_external_verified }
  modes: { full-review: { when_to_use: "changes touching auth or data" } }
  terminal: { backend: herdr, session: cusr }
`);
    expect(v.runtime).toEqual({
      data_dir: '/var/lib/cusr',
      concurrency: 3,
      slot_reservation_hours: 6,
      terminal: { backend: 'herdr', session: 'cusr' },
      limits: {
        ...DEFAULT_RUNTIME_LIMITS,
        poll_initial_ms: 30_000,
        spool_bytes: 134_217_728,
      },
      tool_paths: { bwrap: '/usr/bin/bwrap', git: '/usr/bin/git' },
      credential_refs: [
        { name: 'github', file: '/srv/cred/gh.token' },
        { name: 'harness_claude', file: '/srv/cred/claude.json' },
      ],
      access_tokens_ignored: true,
      harness_isolation: { claude: 'allow_external_verified' },
      // Declared modes are the allowlist: direct-pr is not allowed here.
      modes: {
        'full-review': { when_to_use: 'changes touching auth or data' },
      },
    });
  });

  it('rejects unknown runtime keys', () => {
    expect(errors('runtime: { backend: container }\n')).toEqual([
      {
        code: 'schema_invalid',
        path: 'runtime.backend',
        message: "Key 'backend' is not supported",
      },
    ]);
    expect(paths('runtime: { limits: { poll_ms: 1 } }\n')).toEqual(['runtime.limits.poll_ms']);
    expect(paths('runtime: { tool_paths: { curl: /usr/bin/curl } }\n')).toEqual([
      'runtime.tool_paths.curl',
    ]);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['infinite', '.inf'],
    ['overflowing', '1e400'],
    ['unsafe integer', '9007199254740993'],
    ['string', '"60s"'],
  ])('rejects a %s limit', (_label, value) => {
    expect(paths(`runtime: { limits: { poll_initial_ms: ${value} } }\n`)).toEqual([
      'runtime.limits.poll_initial_ms',
    ]);
  });

  it('reports cross-field limit violations after merging defaults', () => {
    expect(paths('runtime: { limits: { poll_initial_ms: 7200000 } }\n')).toEqual([
      'runtime.limits.poll_initial_ms',
    ]);
    expect(paths('runtime: { limits: { log_segment_bytes: 134217728 } }\n')).toEqual([
      'runtime.limits.log_segment_bytes',
    ]);
    expect(
      errors('runtime: { limits: { term_grace_ms: 290000, kill_verify_ms: 20000 } }\n'),
    ).toEqual([
      {
        code: 'schema_invalid',
        path: 'runtime.limits.term_grace_ms',
        message: 'term_grace_ms + kill_verify_ms must be <= drain_max_ms',
      },
      {
        code: 'schema_invalid',
        path: 'runtime.limits.term_grace_ms',
        message: 'term_grace_ms + kill_verify_ms must be <= recheck_max_ms',
      },
    ]);
  });

  it('accepts limits that stay within cross-field bounds', () => {
    expect(
      errors(
        'runtime: { limits: { poll_initial_ms: 3600000, term_grace_ms: 50000, kill_verify_ms: 10000 } }\n',
      ),
    ).toEqual([]);
  });

  it.each([
    ['data_dir', 'runtime: { data_dir: var/lib/cusr }\n', 'runtime.data_dir'],
    ['tool path', 'runtime: { tool_paths: { gh: bin/gh } }\n', 'runtime.tool_paths.gh'],
    [
      'credential ref',
      'runtime: { credential_refs: { github: ../gh.token } }\n',
      'runtime.credential_refs.github',
    ],
  ])('rejects a relative %s', (_label, extra, path) => {
    expect(paths(extra)).toEqual([path]);
  });

  it('rejects isolation modes for undeclared harnesses and unknown modes', () => {
    expect(paths('runtime: { harness_isolation: { codex: internal_required } }\n')).toEqual([
      'runtime.harness_isolation.codex',
    ]);
    expect(paths('runtime: { harness_isolation: { claude: none } }\n')).toEqual([
      'runtime.harness_isolation.claude',
    ]);
  });
});

describe('project file authority', () => {
  const project = (extra: string): ConfigSource => ({
    file: 'cusr.yaml',
    text: MIN_PROJECT.text + extra,
  });

  it('cannot declare runtime', () => {
    expect(errors('', project('runtime: { data_dir: /srv/x }\n'))).toEqual([
      {
        code: 'forbidden_key',
        path: 'runtime',
        message: "Key 'runtime' is only allowed in the user configuration",
      },
    ]);
  });

  it.each([
    'path: /srv/acme',
    'credential_refs: { github: /srv/gh }',
    'harness_isolation: { claude: allow_external_verified }',
    'completion_mode: merge',
    'auto_merge: true',
    'merge: true',
  ])('cannot declare %s', (line) => {
    const key = line.split(':')[0] as string;
    expect(errors('', project(`${line}\n`)).map((e) => [e.code, e.path])).toEqual([
      ['schema_invalid', key],
    ]);
  });

  it('cannot enable autonomous', () => {
    expect(errors('', project('autonomous: true\n')).map((e) => [e.code, e.path])).toEqual([
      ['forbidden_key', 'autonomous'],
    ]);
  });

  it('cannot auto-confirm intake (#248)', () => {
    expect(
      errors('', project('intake: { auto_confirm: [assistant] }\n')).map((e) => [e.code, e.path]),
    ).toEqual([['forbidden_key', 'intake']]);
  });

  it('cannot enable yolo', () => {
    expect(errors('', project('yolo: true\n')).map((e) => [e.code, e.path])).toEqual([
      ['forbidden_key', 'yolo'],
    ]);
  });

  it('cannot add app_id to required checks', () => {
    const p = project('ci: { required_checks: [build], app_id: 15368 }\n');
    expect(errors('', p).map((e) => [e.code, e.path])).toEqual([['schema_invalid', 'ci.app_id']]);
  });
});

describe('project merge.method (SPEC §14.2)', () => {
  const project = (extra: string): ConfigSource => ({
    file: 'cusr.yaml',
    text: MIN_PROJECT.text + extra,
  });
  const resolved = (extra: string) => {
    const r = validate('', project(extra));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return {
      declared: r.value.config.project?.merge_method,
      method: resolveMergeMethod(r.value.config.project),
    };
  };

  it('defaults to squash when the object or the key is absent; an override is kept as declared', () => {
    expect(resolved('')).toEqual({ declared: undefined, method: 'squash' });
    expect(resolved('merge: {}\n')).toEqual({
      declared: undefined,
      method: 'squash',
    });
    expect(resolved('merge: { method: squash }\n')).toEqual({
      declared: 'squash',
      method: 'squash',
    });
    expect(resolved('merge: { method: merge }\n')).toEqual({
      declared: 'merge',
      method: 'merge',
    });
    expect(resolved('merge: { method: rebase }\n')).toEqual({
      declared: 'rebase',
      method: 'rebase',
    });
  });

  it.each([
    ['merge: squash', 'merge'],
    ['merge: { method: fast_forward }', 'merge.method'],
    ['merge: { method: [squash] }', 'merge.method'],
    ['merge: { method: squash, auto: true }', 'merge.auto'],
  ])('%s is invalid config, never a silent default', (line, path) => {
    expect(errors('', project(`${line}\n`)).map((e) => [e.code, e.path])).toEqual([
      ['schema_invalid', path],
    ]);
  });

  it('belongs to cusr.yaml only, never to the user config', () => {
    expect(errors('merge: { method: rebase }\n').map((e) => [e.code, e.path])).toEqual([
      ['forbidden_key', 'merge'],
    ]);
  });

  it('not declaring it leaves the project hash as it was', () => {
    const base = validate('', project(''));
    const empty = validate('', project('merge: {}\n'));
    expect(
      base.ok && empty.ok && base.value.config.hashes.project === empty.value.config.hashes.project,
    ).toBe(true);
  });
});

describe('freezeRuntimeContext', () => {
  const RUNTIME = valid(`runtime:
  credential_refs: { github: /srv/cred/gh.token }
`).runtime as RuntimeConfig;
  const INPUT: RuntimeFreezeInput = {
    runtime: RUNTIME,
    task_id: 'task-1',
    revision: 1,
    base_sha: 'a'.repeat(40),
    project_path: '/srv/acme',
    target: {
      repo: 'acme/app',
      immutable_repo_id: 'R_kgDO123',
      base_ref: 'main',
    },
    capability_refs: { claude: `sha256:${'b'.repeat(64)}` },
  };

  it('builds a schema-valid context whose hash covers every other field', () => {
    const r = freezeRuntimeContext(INPUT);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const ctx = r.value;
    expect(FrozenRuntimeContextSchema.safeParse(ctx).success).toBe(true);
    expect(ctx.completion_mode).toBe('external_confirmation');
    expect(ctx.credential_refs).toEqual([{ name: 'github', file: '/srv/cred/gh.token' }]);
    const { runtime_hash, ...rest } = ctx;
    expect(runtime_hash).toBe(hashCanonical(rest));
    expect(verifyRuntimeHash(ctx)).toBe(true);
    // Any field change must change the hash.
    for (const key of Object.keys(rest) as (keyof typeof rest)[]) {
      expect(verifyRuntimeHash({ ...ctx, [key]: key === 'revision' ? 2 : 'x' })).toBe(false);
    }
  });

  it('is stable for equal inputs regardless of key order', () => {
    const a = freezeRuntimeContext(INPUT);
    const b = freezeRuntimeContext({
      ...INPUT,
      capability_refs: { ...INPUT.capability_refs },
      target: {
        base_ref: 'main',
        immutable_repo_id: 'R_kgDO123',
        repo: 'acme/app',
      },
    });
    expect(a.ok && b.ok && a.value.runtime_hash === b.value.runtime_hash).toBe(true);
    const c = freezeRuntimeContext({
      ...INPUT,
      runtime: {
        ...RUNTIME,
        limits: { ...RUNTIME.limits, poll_max_ms: 1_800_000 },
      },
    });
    expect(a.ok && c.ok && a.value.runtime_hash !== c.value.runtime_hash).toBe(true);
  });

  it('does not capture tokens, tool paths or data dir', () => {
    const r = freezeRuntimeContext({
      ...INPUT,
      runtime: {
        ...RUNTIME,
        data_dir: '/var/lib/cusr',
        tool_paths: { git: '/usr/bin/git' },
      },
    });
    const s = freezeRuntimeContext(INPUT);
    expect(r.ok && s.ok && r.value.runtime_hash === s.value.runtime_hash).toBe(true);
  });

  it('freezes the merge method only when given; a snapshot without it keeps its hash', () => {
    const plain = freezeRuntimeContext(INPUT);
    const squash = freezeRuntimeContext({ ...INPUT, merge_method: 'squash' });
    const rebase = freezeRuntimeContext({ ...INPUT, merge_method: 'rebase' });
    if (!plain.ok || !squash.ok || !rebase.ok) throw new Error('freeze failed');
    expect('merge_method' in plain.value).toBe(false);
    expect(squash.value.merge_method).toBe('squash');
    expect(
      new Set([plain.value.runtime_hash, squash.value.runtime_hash, rebase.value.runtime_hash])
        .size,
    ).toBe(3);
    expect(verifyRuntimeHash(squash.value)).toBe(true);
    expect(
      FrozenRuntimeContextSchema.safeParse({
        ...squash.value,
        merge_method: 'ff',
      }).success,
    ).toBe(false);
  });

  it('returns runtime_invalid for malformed inputs', () => {
    const r = freezeRuntimeContext({
      ...INPUT,
      revision: 0,
      target: { ...INPUT.target, repo: 'acme' },
    });
    expect(r.ok ? [] : r.error.issues.map((i) => i.path.join('.'))).toEqual([
      'revision',
      'target.repo',
    ]);
  });
});

describe('historical hashes', () => {
  const original = source('configs/valid/user.yaml');
  // Make the former defaults explicit: old finite policies must retain their original hashes.
  const USER_YAML = {
    ...original,
    text: original.text.replace(
      '    overridable:',
      `    limits:
      classes: { infra_retries: 3, quality_tries_per_rung: 3 }
      backoff:
        infra: { base: 5s, factor: 2, max: 5m, max_attempts: 3 }
        rate_limit: { base: 1m, factor: 2, max: 30m, max_attempts: 5 }
    overridable:`,
    ),
  };
  const PROJECT_LINE = '  acme: { base_branch: main }\n';

  function frozenHashes(user: ConfigSource) {
    const r = validateConfig({
      user,
      project: source('configs/valid/cusr.yaml', 'cusr.yaml'),
      packs: PACKS,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const f = freeze({
      config: r.value.config,
      // Preserve the original Unicode input behind the historical context hash.
      task: buildTask({
        title: 'Thêm tìm kiếm khách hàng',
        description: 'Cho phép tìm khách hàng theo tên.',
        acceptance: ['Tìm theo tên trả kết quả đúng'],
      }),
      caller: authz(),
      base_sha: 'cafe1234',
      attachments: [],
      ...docsFor(r.value.config),
    });
    if (!f.ok) throw new Error(JSON.stringify(f.error));
    return {
      config: r.value.config.hashes,
      effective: f.value.policy.config_hashes.effective,
      policy: f.value.policy.policy_hash,
      context: f.value.context.context_hash,
      locations: r.value.locations,
    };
  }

  // Recaptured when decision modes left the workflow and when user.yaml dropped `uses`; must never move otherwise.
  const GOLDEN = {
    config: {
      user: 'sha256:ad2bd8f7dfebc4e4670a600f8ee72eee13d348baf032d9ca955796122eaa7da4',
      project: 'sha256:20aed651e16b81216ae85b13a4b78eae960183761c88f2fbb1dffd6059f2949f',
      packs: {
        node: 'sha256:dc2a20df419481471b5e3cbb2efc284701c47f5395e127910c07a0ffe091e003',
      },
    },
    policy: 'sha256:bffd04158f0a9056bb674ea4655644a33f98ae26044aaa9aeba330031116383b',
    context: 'sha256:452fab522cb5cdb63dbf6ddf2887ca014076ed9b97c7aad73b4eea7eebeb3731',
  };

  it('keeps historical hashes when the former finite defaults are explicit', () => {
    const h = frozenHashes(USER_YAML);
    expect(h.config).toEqual(GOLDEN.config);
    expect(h.policy).toBe(GOLDEN.policy);
    expect(h.context).toBe(GOLDEN.context);
  });

  it('declaring repo and path does not change user, effective or policy hashes', () => {
    expect(USER_YAML.text).toContain(PROJECT_LINE);
    const located = {
      ...USER_YAML,
      text: USER_YAML.text.replace(
        PROJECT_LINE,
        '  acme: { base_branch: main, path: /srv/acme, repo: acme/app }\n',
      ),
    };
    const base = frozenHashes(USER_YAML);
    const h = frozenHashes(located);
    expect(h.locations).toEqual({
      acme: { path: '/srv/acme', repo: 'acme/app', base_branch: 'main' },
    });
    expect(h.config).toEqual(GOLDEN.config);
    expect(h.effective).toBe(base.effective);
    expect(h.policy).toBe(GOLDEN.policy);
    expect(h.context).toBe(GOLDEN.context);
  });

  it('adding a runtime section does not change config or policy hashes', () => {
    const base = valid('');
    const withRuntime = valid(
      'runtime: { data_dir: /var/lib/cusr, limits: { poll_max_ms: 1800000 } }\n',
    );
    expect(withRuntime.config.hashes).toEqual(base.config.hashes);
  });
});
