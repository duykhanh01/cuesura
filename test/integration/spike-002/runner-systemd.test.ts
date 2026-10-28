import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { lockPath, stopUnit, systemdRunArgv, unitName, unitStatus, type RunSpec } from '../../../scripts/spike-002/runner.ts';

// Local-only: a transient user unit running the fake child. No model, network, sudo or host policy change.
const userManager = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' });
const available = userManager.error === undefined && ['running', 'degraded'].includes(userManager.stdout.trim());

const FAKE = fileURLToPath(new URL('../../fixtures/runtime/spike-0/bin/fake-harness.js', import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-runner-unit-')));
const opId = `spike-test-${process.pid}-${Date.now()}`;

afterAll(() => {
  stopUnit(opId);
  spawnSync('systemctl', ['--user', 'reset-failed', unitName(opId)]);
  rmSync(base, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

describe.skipIf(!available)('spike-002 runner under systemd --user (local fake child)', () => {
  it('outlives the process that launched it and stopping the unit stops every descendant', async () => {
    const pids = join(base, 'pids.json');
    const spec: RunSpec = {
      schema_version: 1,
      kind: 'operations',
      operation_id: opId,
      attempt_id: null,
      command: [process.execPath, FAKE, 'grandchild', pids],
      cwd: base,
      env: { PATH: '/usr/bin:/bin' },
      stdin_file: null,
      deadline_ms: 120_000,
      redact_files: [],
      binding: null,
      limits: {},
    };
    const specFile = join(base, 'spec.json');
    writeFileSync(specFile, JSON.stringify(spec));
    mkdirSync(join(base, 'locks'), { recursive: true });
    expect(lockPath(base, opId)).toBe(join(base, 'locks', `${opId}.lock`));

    // A short-lived parent stands in for a daemon that dies right after spawning the unit.
    const argv = systemdRunArgv(specFile, base, opId);
    const launcher = spawnSync('/bin/sh', ['-c', '"$@"; exit 0', 'sh', ...argv], { encoding: 'utf8', timeout: 30_000 });
    expect(launcher.status).toBe(0);

    expect(await until(() => existsSync(pids), 15_000)).toBe(true);
    const { in_group, escaped } = JSON.parse(readFileSync(pids, 'utf8')) as { in_group: number; escaped: number };
    expect(unitStatus(opId)['ActiveState']).toBe('active');
    expect(alive(in_group) && alive(escaped)).toBe(true);

    const dir = join(base, 'operations', opId);
    const pid = JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8')) as { invocation_id: string | null; cgroup: string | null };
    expect(pid.invocation_id).toMatch(/^[0-9a-f]{32}$/);
    expect(pid.cgroup?.endsWith(`/${unitName(opId)}`)).toBe(true);
    expect(unitStatus(opId)['InvocationID']).toBe(pid.invocation_id);

    expect(stopUnit(opId)).toBe(0);
    expect(await until(() => !alive(in_group) && !alive(escaped), 20_000)).toBe(true);
    // KillMode=control-group signals every process in the unit; the runner still finalises exit.json.
    expect(await until(() => existsSync(join(dir, 'exit.json')), 15_000)).toBe(true);
    const exit = JSON.parse(readFileSync(join(dir, 'exit.json'), 'utf8')) as { outcome: string; termination: { descendant_scope: string } };
    expect(exit.outcome).toBe('cancelled');
    expect(exit.termination.descendant_scope).toBe('unit_cgroup');
  }, 60_000);
});
