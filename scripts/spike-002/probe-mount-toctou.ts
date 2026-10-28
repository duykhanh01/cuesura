/**
 * Local-only T006 evidence: host-side mount-source TOCTOU. buildSandbox() validates sources with
 * realpath and device/inode at plan time; the launcher verifies and pins FDs at exec. Records:
 *   1. plan time: a source that is already a symlink is refused;
 *   2. reachability: from inside every role, renaming or replacing a mount source path (where the
 *      host path is visible) fails and the host source keeps its inode; writes to recreated
 *      parents stay in the sandbox root unless the parent is itself a granted rw mount;
 *   3. race: a host process (same uid, outside any sandbox) swapping a source after planning
 *      must fail closed before bwrap can mount the replacement.
 * No model, network, sudo or host policy change.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSandbox, createProbeFixture, probeLayout, sandboxCommand, SandboxPolicyError, SANDBOX_ROLES, type SandboxPlan } from './sandbox.ts';

const BWRAP = '/usr/bin/bwrap';

// Inside the sandbox: try to swap visible mount sources, write probes into parents, stat targets.
const CHILD = String.raw`
import json, os, sys
d = json.loads(sys.argv[1])
out = {'source_swaps': {}, 'parent_writes': {}, 'targets': {}}
for p in d['sources']:
    if not os.path.lexists(p):
        out['source_swaps'][p] = 'not_visible'
        continue
    try:
        os.rename(p, p + '.swapped')
        os.symlink('/etc', p)
        out['source_swaps'][p] = 'swapped'
    except OSError as e:
        out['source_swaps'][p] = 'denied:' + str(e.errno)
for p in d['parents']:
    f = os.path.join(p, '.cusr-toctou-probe')
    try:
        os.makedirs(p, exist_ok=True)
        with open(f, 'w') as h: h.write('x')
        out['parent_writes'][p] = 'written_inside_sandbox'
    except OSError as e:
        out['parent_writes'][p] = 'denied:' + str(e.errno)
for t in d['targets']:
    try:
        st = os.stat(t)
        out['targets'][t] = {'dev': st.st_dev, 'ino': st.st_ino, 'entries': sorted(os.listdir(t))[:20] if os.path.isdir(t) else None}
    except OSError as e:
        out['targets'][t] = {'error': e.errno}
print(json.dumps(out))
`;

type Ident = { dev: number; ino: number };
const ident = (p: string): Ident => {
  const st = statSync(p);
  return { dev: st.dev, ino: st.ino };
};

function runChild(plan: SandboxPlan, data: unknown): { exit: number | null; stderr: string; output: Record<string, unknown> | null } {
  const [exe, ...args] = sandboxCommand(plan, ['/usr/bin/python3', '-I', '-c', CHILD, JSON.stringify(data)], BWRAP);
  const r = spawnSync(exe as string, args, { encoding: 'utf8', timeout: 30_000, env: {} });
  let output: Record<string, unknown> | null;
  try {
    output = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    output = null;
  }
  return { exit: r.status, stderr: r.stderr.trim(), output };
}

// Mount targets inside the sandbox may differ from host sources (scratch/home/context map to /cusr/*).
function sourceTargets(plan: SandboxPlan): { source: string; target: string; kind: string; purpose: string }[] {
  return plan.mounts.filter((m) => m.purpose !== 'system').map((m) => ({ source: m.source, target: m.target, kind: m.kind, purpose: m.purpose }));
}

export function runMountToctouProbe(): Record<string, unknown> {
  const fx = createProbeFixture();
  try {
    // 1. Plan-time refusal of an already-symlinked source.
    const linked = join(fx.base, 'scratch-link');
    symlinkSync(fx.outside, linked);
    let planRefusal: string | null = null;
    try {
      buildSandbox({ ...probeLayout('coder', fx), scratch: linked });
    } catch (e) {
      planRefusal = e instanceof SandboxPolicyError ? e.message : `unexpected: ${String(e)}`;
    }
    rmSync(linked);

    // 2. No role can swap a mount source; parent writes reach the host only through granted rw mounts.
    const reach = SANDBOX_ROLES.map((role) => {
      const plan = buildSandbox(probeLayout(role, fx));
      const sources = sourceTargets(plan);
      const before = Object.fromEntries(sources.map((s) => [s.source, ident(s.source)]));
      const parents = [...new Set(sources.map((s) => dirname(s.source)))].sort();
      const run = runChild(plan, { sources: sources.map((s) => s.source), parents, targets: [] });
      const swaps = (run.output?.['source_swaps'] ?? {}) as Record<string, string>;
      const sourcesIntact = sources.every((s) => { const now = ident(s.source); return now.ino === before[s.source]?.ino && !existsSync(`${s.source}.swapped`); });
      const rwMounts = sources.filter((s) => s.kind === 'rw').map((s) => s.source);
      const hostParentWrites = parents.filter((p) => existsSync(join(p, '.cusr-toctou-probe')));
      for (const p of hostParentWrites) rmSync(join(p, '.cusr-toctou-probe'));
      const unexpected = hostParentWrites.filter((p) => !rwMounts.includes(p));
      return {
        role, layout_digest: plan.layout_digest, exit: run.exit, source_swaps: swaps, sources_intact: sourcesIntact,
        parent_writes_inside: run.output?.['parent_writes'] ?? null, host_parent_writes_via_rw_mount: hostParentWrites.filter((p) => rwMounts.includes(p)), unexpected_host_parent_writes: unexpected,
        passed: run.exit === 0 && sourcesIntact && !Object.values(swaps).includes('swapped') && unexpected.length === 0,
      };
    });

    // 3. Same-uid host swap after planning: scratch and worktree replaced by a symlink to the canary dir.
    const races = (['scratch', 'worktree'] as const).map((which) => {
      const plan = buildSandbox(probeLayout('coder', fx));
      const m = sourceTargets(plan).find((s) => s.purpose === which);
      if (m === undefined) throw new Error(`no ${which} mount`);
      const planned = ident(m.source);
      const aside = `${m.source}.aside`;
      renameSync(m.source, aside);
      symlinkSync(fx.outside, m.source);
      try {
        const run = runChild(plan, { sources: [], parents: [], targets: [m.target] });
        const seen = ((run.output?.['targets'] as Record<string, { dev?: number; ino?: number; entries?: string[] | null }> | undefined) ?? {})[m.target];
        return {
          mount: which,
          host_source: m.source,
          sandbox_target: m.target,
          planned_inode: planned,
          observed_inside: seen ?? null,
          exit: run.exit,
          stderr: run.stderr.slice(0, 300),
          bwrap_failed_closed: run.exit !== 0 && seen === undefined,
          redirected_to_canary: seen?.entries?.includes('canary') === true,
          inode_check_detects: seen?.ino !== undefined && (seen.ino !== planned.ino || seen.dev !== planned.dev),
        };
      } finally {
        rmSync(m.source);
        renameSync(aside, m.source);
      }
    });

    const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
    const canaryUnchanged = readFileSync(join(fx.outside, 'canary'), 'utf8') === 'outside-canary\n' && readdirSync(fx.outside).length === 1;
    const sandboxReachable = reach.every((r) => r.passed);
    return {
      schema_version: 1,
      kind: 'spike-0-mount-source-toctou',
      checked_at: new Date().toISOString(),
      scope: 'Host-side mount-source TOCTOU between buildSandbox() realpath checks and bwrap exec. Local fixture only; no model, network, sudo or policy change.',
      node: process.version,
      kernel: spawnSync('uname', ['-r'], { encoding: 'utf8' }).stdout.trim(),
      bwrap: spawnSync(BWRAP, ['--version'], { encoding: 'utf8' }).stdout.trim(),
      hashes: { probe: digest(fileURLToPath(import.meta.url)), sandbox: digest(fileURLToPath(new URL('./sandbox.ts', import.meta.url))), bwrap: digest(BWRAP) },
      plan_time_symlink_refused: planRefusal,
      sandbox_cannot_reach_source_parents: reach,
      host_swap_race: races,
      canary_unchanged: canaryUnchanged,
      conclusion: {
        attacker_inside_sandbox_can_swap: !sandboxReachable,
        same_uid_host_swap_redirects_bwrap: races.some((r) => r.redirected_to_canary),
        inode_check_detects_every_redirect: races.filter((r) => !r.bwrap_failed_closed).every((r) => r.inode_check_detects),
        prototype_runs_inode_check: true,
      },
      passed: planRefusal !== null && sandboxReachable && canaryUnchanged && races.every((r) => r.bwrap_failed_closed && !r.redirected_to_canary),
    };
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = runMountToctouProbe();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report['passed'] === true ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
