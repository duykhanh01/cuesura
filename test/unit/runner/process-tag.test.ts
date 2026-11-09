/**
 * Processes spawned for an in-process operation carry its id (FR-034.01, constitution II): a restart
 * finds the ones that outlived the daemon by scanning the real /proc, descendants included.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findTagged,
  operationEnv,
  OPERATION_ENV,
  readOperationMark,
  runInOperation,
  stopTagged,
  writeOperationMark,
  type OperationMark,
} from '../../../src/runner/process-tag.ts';
import { bootId } from '../../../src/runner/identity.ts';
import { SpawnExecutor } from '../../../src/runner/commands.ts';
import { uuidOf } from '../../support/builders.ts';

const linux = existsSync('/proc/self/environ');
const python = ['/usr/bin/python3', '/bin/python3'].find((p) => existsSync(p)) ?? null;

/** A mark taken now, on the boot clock the scanner compares start times with. */
function markNow(): OperationMark {
  const up = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
  return { boot_id: bootId(), ticks: Math.floor(up * 100) };
}

/** Polls `f` until it returns a value, for at most two seconds. */
async function until<T>(f: () => T | null): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = f();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not reached');
}

describe('operation process tag', () => {
  it('is set only inside an operation, across awaits', async () => {
    expect(operationEnv()).toEqual({});
    const id = uuidOf(7001);
    const seen = await runInOperation(id, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return operationEnv();
    });
    expect(seen).toEqual({ [OPERATION_ENV]: id });
    expect(operationEnv()).toEqual({});
  });

  it('reaches the commands the daemon spawns', async () => {
    const id = uuidOf(7002);
    const out = await runInOperation(id, () =>
      new SpawnExecutor().run(
        {
          isolation_mode: 'isolated',
          provider: 'bwrap',
          role: 'gate',
          argv: ['/bin/sh', '-c', `printf %s "$${OPERATION_ENV}"`],
          cwd: '/',
          env: { PATH: '/usr/bin:/bin' },
          network: 'none',
          mount_sources: [],
          layout_digest: `sha256:${'0'.repeat(64)}`,
          layout_shape: `sha256:${'0'.repeat(64)}`,
          proof_refs: [],
        } as never,
        { timeout_ms: 10_000, max_output_bytes: 1024 },
      ),
    );
    expect(out).toMatchObject({ kind: 'exited', code: 0, output: id });
  });

  it.runIf(linux)(
    'finds a live tagged process and its descendants in /proc, and none once they are gone',
    async () => {
      const id = uuidOf(7003);
      const since = markNow();
      // A detached group, as git and gh run: the shell's child inherits the tag.
      const child = spawn('/bin/sh', ['-c', 'sleep 30 & wait'], {
        env: { PATH: '/usr/bin:/bin', ...runInOperation(id, operationEnv) },
        detached: true,
        stdio: 'ignore',
      });
      try {
        const found = await until(() => {
          const scan = findTagged(id, since);
          if (!scan.ok) throw new Error(scan.detail);
          return scan.processes.length === 2 ? scan.processes : null;
        });
        expect(found.map((p) => p.pid)).toContain(child.pid);
        expect(found.every((p) => p.pgid === child.pid)).toBe(true);
        expect(findTagged(uuidOf(7004), since)).toEqual({
          ok: true,
          processes: [],
        });
        // A dead daemon's survivors are stopped, the whole group at once.
        stopTagged(found);
        await once(child, 'exit');
        await until(() => {
          const scan = findTagged(id, since);
          return scan.ok && scan.processes.length === 0 ? true : null;
        });
      } finally {
        try {
          process.kill(-(child.pid as number), 'SIGKILL');
        } catch {
          // stopped above
        }
      }
    },
  );

  it.runIf(linux)(
    'a process with a different start time under the same pid is never signalled',
    async () => {
      const child = spawn('/bin/sleep', ['30'], { detached: true });
      try {
        await once(child, 'spawn');
        stopTagged([
          {
            boot_id: 'b',
            pid: child.pid as number,
            pgid: child.pid as number,
            start_ticks: 1,
          },
        ]);
        await new Promise((r) => setTimeout(r, 100));
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
      } finally {
        child.kill('SIGKILL');
      }
    },
  );

  it.runIf(linux && python !== null)(
    "a process of this user it cannot read, started since the operation, proves nothing; an older one is not the operation's",
    async () => {
      const id = uuidOf(7007);
      const since = markNow();
      // prctl(PR_SET_DUMPABLE, 0): its environ becomes unreadable, as ssh makes itself.
      const child = spawn(
        python as string,
        [
          '-c',
          'import ctypes,time; ctypes.CDLL(None).prctl(4,0,0,0,0); print("ready",flush=True); time.sleep(30)',
        ],
        {
          env: { PATH: '/usr/bin:/bin', ...runInOperation(id, operationEnv) },
          detached: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      try {
        await once(child.stdout, 'data');
        expect(findTagged(id, since)).toMatchObject({
          ok: false,
          detail: `pid ${child.pid}: environment unreadable`,
        });
        // Started well before the operation's mark: it cannot be one of its processes.
        expect(findTagged(id, { ...markNow(), ticks: markNow().ticks + 6_000 })).toMatchObject({
          ok: true,
        });
      } finally {
        process.kill(-(child.pid as number), 'SIGKILL');
      }
    },
  );

  it('a /proc it cannot list proves nothing', () => {
    expect(findTagged(uuidOf(7005), null, '/nonexistent-proc')).toMatchObject({
      ok: false,
    });
  });

  it.runIf(linux)('a mark is durable, read back, and absent before it is written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cusr-mark-'));
    const id = uuidOf(7010);
    expect(readOperationMark(dir, id)).toEqual({ ok: true, mark: null });
    writeOperationMark(dir, id);
    const r = readOperationMark(dir, id);
    expect(r.ok && r.mark?.boot_id).toBe(bootId());
    writeFileSync(join(dir, 'process-marks', `${id}.json`), '{');
    expect(readOperationMark(dir, id)).toMatchObject({ ok: false });
  });

  it.runIf(linux && process.getuid?.() !== 0)(
    'dates an unreadable process by boot ticks against the mark; the wall clock and btime play no part',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'cusr-proc-'));
      const uid = process.getuid?.() ?? 0;
      const pid = (ticks: number, btime: number, flags = 0): void => {
        writeFileSync(join(root, 'stat'), `cpu 0\nbtime ${btime}\n`);
        const d = join(root, '4242');
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'status'), `Name:\tssh\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
        const fields = Array.from({ length: 50 }, () => '0');
        fields[2] = '4242';
        fields[6] = String(flags);
        fields[19] = String(ticks);
        writeFileSync(join(d, 'stat'), `4242 (ssh) ${fields.join(' ')}`);
        if (!existsSync(join(d, 'environ'))) {
          writeFileSync(join(d, 'environ'), '');
          chmodSync(join(d, 'environ'), 0o000);
        }
      };
      const mark: OperationMark = { boot_id: bootId(), ticks: 100_000 };
      const id = uuidOf(7011);
      // Started after the mark: it may be the operation's, whatever btime says (UTC set back 60 s).
      for (const btime of [1_800_000_000, 1_799_999_940]) {
        pid(100_500, btime);
        expect(findTagged(id, mark, root)).toMatchObject({ ok: false });
      }
      // Exiting (PF_EXITING): its environ is refused the same way, but it can no longer run anything.
      pid(100_500, 1_800_000_000, 0x4);
      expect(findTagged(id, mark, root)).toEqual({ ok: true, processes: [] });
      // Started before the mark, no mark (nothing was spawned), or a mark of another boot: not it.
      pid(50_000, 1_799_999_940);
      expect(findTagged(id, mark, root)).toEqual({ ok: true, processes: [] });
      pid(100_500, 1_800_000_000);
      expect(findTagged(id, null, root)).toEqual({ ok: true, processes: [] });
      expect(findTagged(id, { ...mark, boot_id: 'other-boot' }, root)).toEqual({
        ok: true,
        processes: [],
      });
    },
  );
});
