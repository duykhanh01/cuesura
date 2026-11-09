import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { asEpochMs } from '../../../src/shared/brand.ts';
import { unitName } from '../../../src/runner/identity.ts';
import { lockFilePath, probeOperationLock } from '../../../src/runner/operation-lock.ts';
import { SystemdSupervisor } from '../../../src/runner/supervisor.ts';

// Local only: a transient user unit running a shell stand-in for the runner. No model, network or host change.
const manager = spawnSync('systemctl', ['--user', 'is-system-running'], {
  encoding: 'utf8',
});
const available =
  manager.error === undefined && ['running', 'degraded'].includes(manager.stdout.trim());

const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-supervisor-unit-')));
const opId = `t018-${process.pid}-${Date.now()}`;

afterAll(() => {
  spawnSync('systemctl', ['--user', 'stop', unitName(opId)]);
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
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

describe.skipIf(!available)('SystemdSupervisor under systemd --user (T018)', () => {
  it('launches one unit per operation under the kernel lock, refuses a second launch and stops the cgroup', async () => {
    const pidFile = join(base, 'child.pid');
    const sup = new SystemdSupervisor({
      dataDir: base,
      runnerCommand: ['/bin/sh', '-c', 'echo $$ > "$0"; exec /bin/sleep 300', pidFile],
    });
    const spec = {
      operation_id: opId,
      kind: 'gate' as const,
      run_dir_kind: 'operations' as const,
      run_id: opId,
      argv: ['/usr/bin/true'],
      cwd: base,
      env: { PATH: '/usr/bin:/bin' },
      wall_ms: 60_000,
      deadline_at: asEpochMs(Date.now() + 60_000),
      term_grace_ms: 2_000,
      kill_verify_ms: 2_000,
      launch_nonce: 'n-1',
    };

    const launched = await sup.launch(spec);
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    expect(await until(() => existsSync(pidFile), 15_000)).toBe(true);
    const child = Number(readFileSync(pidFile, 'utf8'));
    const seen = await sup.inspect(opId);
    expect(seen.state).toBe('active');
    expect(seen.invocation_id).toMatch(/^[0-9a-f]{32}$/);
    expect(seen.cgroup?.endsWith(`/${unitName(opId)}`)).toBe(true);
    expect(probeOperationLock(lockFilePath(base, opId))).toBe('held');

    expect(await sup.launch({ ...spec, launch_nonce: 'n-2' })).toMatchObject({
      ok: false,
      error: { code: 'marker_exists' },
    });

    expect(await sup.stop(opId, { term_grace_ms: 2_000, kill_verify_ms: 2_000 })).toBe('stopped');
    expect(await until(() => !alive(child), 10_000)).toBe(true);
    expect(probeOperationLock(lockFilePath(base, opId))).toBe('free');
    expect(['exited', 'failed', 'not_found']).toContain((await sup.inspect(opId)).state);
    expect(await sup.stop(opId, { term_grace_ms: 2_000, kill_verify_ms: 2_000 })).toBe(
      'not_running',
    );
  }, 60_000);
});
