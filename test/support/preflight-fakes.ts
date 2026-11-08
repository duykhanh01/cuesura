import { fakeCapabilityManifest } from '../../src/adapters/harness/fake.ts';
import type {
  GitCommand,
  GitHubRequest,
  GitResult,
  HostExecResult,
  HostProbePort,
} from '../../src/adapters/ports.ts';
import type { PreflightPorts } from '../../src/application/preflight.ts';
import { CapabilityManifestSchema, type CapabilityManifest } from '../../src/domain/runtime.ts';
import type { ConfigSource } from '../../src/config/yaml-loader.ts';
import { hashCanonical } from '../../src/shared/hash.ts';
import { err, ok } from '../../src/shared/result.ts';
import { preflight, TOOL_PROBE_SCRIPT } from '../../src/application/preflight.ts';
import { freeze } from '../../src/config/freeze.ts';
import type { ExecutionMode, RunSelection } from '../../src/domain/run-config.ts';
import type { CanonicalTask } from '../../src/domain/task.ts';
import { PACKS, source } from './config-fixtures.ts';
import { selectionFor } from './runtime.ts';

// Fake ports and config for preflight (T030) and the flows built on it (T031/T032).

export const REPO = '/srv/repos/acme';
export const SHA = 'a'.repeat(40);
export const BASE_USER = source('configs/valid/user.yaml');
export const CUSR = source('configs/valid/cusr.yaml', 'cusr.yaml').text;

export function userConfig(
  opts: { project?: string; runtime?: string | null; extra?: string } = {},
): ConfigSource {
  const project = opts.project ?? `acme: { base_branch: main, path: ${REPO}, repo: acme/app }`;
  const runtime =
    opts.runtime === undefined ? 'runtime: {}\n' : opts.runtime === null ? '' : `${opts.runtime}\n`;
  const text =
    BASE_USER.text.replace('  acme: { base_branch: main }', `  ${project}`) +
    runtime +
    (opts.extra ?? '');
  return { file: 'config.yaml', text };
}

export type HostOpts = {
  bwrap?: boolean;
  bwrapExit?: { code: number; stderr: string };
  sysctl?: Record<string, string>;
  systemd?: boolean;
  userBus?: boolean;
};

export function fakeHost(o: HostOpts = {}): HostProbePort & { execs: string[][] } {
  const execs: string[][] = [];
  const bins: Record<string, string | null> = {
    bwrap: o.bwrap === false ? null : '/usr/bin/bwrap',
    true: '/usr/bin/true',
    'systemd-run': o.systemd === false ? null : '/usr/bin/systemd-run',
    systemctl: o.systemd === false ? null : '/usr/bin/systemctl',
  };
  return {
    execs,
    findExecutable: (name) => Promise.resolve(bins[name] ?? null),
    realpath: (p) =>
      Promise.resolve(p === REPO || p === `${REPO}/.git` || p.startsWith('/usr/bin/') ? p : null),
    readText: (p) => Promise.resolve(o.sysctl?.[p] ?? null),
    exec: (argv): Promise<HostExecResult> => {
      execs.push([...argv]);
      // The tools probe, as the fake's file system answers it: only /usr/bin holds anything.
      const script = argv.indexOf(TOOL_PROBE_SCRIPT);
      if (script >= 0) {
        const held = (argv[script + 2] ?? '').split(':').includes('/usr/bin');
        return Promise.resolve({
          kind: 'exited',
          code: 0,
          stdout: held ? '' : argv.slice(script + 3).join('\n'),
          stderr: '',
        });
      }
      if (argv[0] === '/usr/bin/bwrap') {
        const e = o.bwrapExit ?? { code: 0, stderr: '' };
        return Promise.resolve({
          kind: 'exited',
          code: e.code,
          stdout: '',
          stderr: e.stderr,
        });
      }
      const up = o.userBus !== false;
      return Promise.resolve({
        kind: 'exited',
        code: up ? 0 : 1,
        stdout: up ? 'Version=255\n' : '',
        stderr: up ? '' : 'Failed to connect to bus: No medium found',
      });
    },
  };
}

/** `templates`: PR template files in the base tree (path → content) for the start's template read. */
export type GitOpts = {
  remote?: string;
  fetch?: { code: number; stderr: string };
  cusr?: string | null;
  mode?: string;
  toplevel?: string;
  templates?: Record<string, string>;
};

export function fakeGit(o: GitOpts = {}): PreflightPorts['git'] & { calls: string[][] } {
  const calls: string[][] = [];
  const exited = (stdout: string, code = 0, stderr = ''): GitResult => ({
    kind: 'exited',
    code,
    stdout,
    stderr,
    truncated: false,
  });
  return {
    calls,
    run: (c: GitCommand): Promise<GitResult> => {
      calls.push([...c.args]);
      if (c.cwd !== REPO) throw new Error(`unexpected cwd ${c.cwd}`);
      const cusr = o.cusr === undefined ? CUSR : o.cusr;
      switch (c.args[0]) {
        case 'rev-parse':
          return Promise.resolve(
            c.args.includes('--show-toplevel')
              ? exited(`${o.toplevel ?? REPO}\n${REPO}/.git\n`)
              : exited(`${SHA}\n`),
          );
        case 'config':
          return Promise.resolve(exited(`${o.remote ?? 'git@github.com:acme/app.git'}\n`));
        case 'check-ref-format':
          return Promise.resolve(exited(''));
        case 'fetch':
          return Promise.resolve(
            o.fetch === undefined ? exited('') : exited('', o.fetch.code, o.fetch.stderr),
          );
        case 'ls-tree':
          // `ls-tree -r --name-only -z <base>` lists the tree for the PR template lookup.
          if (c.args.includes('--name-only'))
            return Promise.resolve(
              exited(
                [...(cusr === null ? [] : ['cusr.yaml']), ...Object.keys(o.templates ?? {})]
                  .map((f) => `${f}\0`)
                  .join(''),
              ),
            );
          return Promise.resolve(
            exited(
              cusr === null ? '' : `${o.mode ?? '100644'} blob ${'b'.repeat(40)}\tcusr.yaml\n`,
            ),
          );
        case 'cat-file': {
          const path = (c.args.at(-1) ?? '').split(':').slice(1).join(':');
          if (o.templates?.[path] !== undefined) return Promise.resolve(exited(o.templates[path]));
          return Promise.resolve(exited(cusr ?? ''));
        }
        case 'merge-base':
          return Promise.resolve(exited(SHA));
        default:
          throw new Error(`unexpected git ${c.args.join(' ')}`);
      }
    },
  };
}

/** A repo that reports its default branch, and the open PRs a `pulls?head=` read returns. */
export type RepoWithPulls = {
  readonly default_branch: string;
  readonly pulls?: readonly { number: number; base: { ref: string } }[];
};

export function fakeGitHub(
  reply: 'ok' | 'renamed' | 404 | 403 | 'unknown' | RepoWithPulls = 'ok',
): PreflightPorts['github'] & { requests: GitHubRequest[] } {
  const requests: GitHubRequest[] = [];
  return {
    requests,
    request: (req) => {
      requests.push(req);
      if (typeof reply === 'object')
        return Promise.resolve(
          ok({
            status: 200,
            headers: {},
            body: req.path.endsWith('/pulls')
              ? (reply.pulls ?? [])
              : { id: 4242, full_name: 'Acme/App', default_branch: reply.default_branch },
            evidence_digest: hashCanonical('repo'),
          }),
        );
      if (reply === 'unknown')
        return Promise.resolve(
          err({
            reason: 'unknown',
            status: null,
            detail: 'connection reset',
            retry_after_ms: null,
          }),
        );
      if (typeof reply === 'number')
        return Promise.resolve(
          err({
            reason: 'http_error',
            status: reply,
            detail: `HTTP ${reply}`,
            retry_after_ms: null,
          }),
        );
      const full_name = reply === 'renamed' ? 'acme/app-new' : 'Acme/App';
      return Promise.resolve(
        ok({
          status: 200,
          headers: {},
          body: { id: 4242, full_name },
          evidence_digest: hashCanonical('repo'),
        }),
      );
    },
  };
}

export function manifest(
  over: {
    capabilities?: Partial<CapabilityManifest['capabilities']>;
    selected_inner_mode?: CapabilityManifest['selected_inner_mode'];
    role_schemas?: Record<string, string>;
  } = {},
): CapabilityManifest {
  const { manifest_hash: _h, ...base } = fakeCapabilityManifest();
  const body = {
    ...base,
    capabilities: { ...base.capabilities, ...over.capabilities },
    role_schemas: over.role_schemas ?? base.role_schemas,
    ...(over.selected_inner_mode === 'external_verified'
      ? {
          selected_inner_mode: 'external_verified' as const,
          native_result: 'failed' as const,
          outer_proof_hash: hashCanonical('outer'),
          permission_policy_hash: hashCanonical('perm'),
        }
      : {}),
  };
  return CapabilityManifestSchema.parse({
    ...body,
    manifest_hash: hashCanonical(body),
  });
}

export const MANIFESTS = { claude: manifest(), codex: manifest() };

/**
 * The run selection that matches what start will freeze for `task` from the fake config and base:
 * runs preflight and the policy freeze for `mode` and reads the bindings back (see selectionFor).
 */
export async function configuredSelection(
  task: CanonicalTask,
  mode: ExecutionMode,
  user: ConfigSource = userConfig(),
): Promise<RunSelection> {
  const pre = await preflight(
    { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
    { task, user, packs: PACKS, manifests: MANIFESTS, mode },
  );
  if (!pre.ok) throw new Error(`preflight failed: ${JSON.stringify(pre.error)}`);
  const config = pre.value.validated.config;
  const prompts = Object.values(config.user.roles).flatMap((r) =>
    r.prompt === null ? [] : [{ name: r.prompt, content: `# ${r.prompt}\n` }],
  );
  const frozen = freeze({
    config,
    task,
    caller: {
      actor: 'cusrd',
      roles: ['operate'],
      issued_by: 'cusrd',
      issued_at: 0,
    },
    base_sha: SHA,
    attachments: [],
    prompts,
    conventions: (config.project?.conventions ?? []).map((name) => ({
      name,
      content: CUSR,
    })),
    mode,
  });
  if (!frozen.ok) throw new Error(`freeze failed: ${JSON.stringify(frozen.error)}`);
  return selectionFor(task, mode, frozen.value.policy);
}
