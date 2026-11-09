/**
 * The real-smoke driver on a stand-in daemon: no build, no model and no sandbox repo, so it runs wherever
 * `pnpm test:smoke` does. A restart must wait for its own daemon, which logs before it listens.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RealRun, RealSmokeSchema } from '../support/smoke-real.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Logs at once, listens 300 ms later; `ready` exists from just before it says so. */
const STAND_IN = `
import { writeFileSync } from 'node:fs';
const ready = process.env.STAND_IN_READY;
process.stderr.write('starting\\n');
setTimeout(() => {
  writeFileSync(ready, '');
  process.stderr.write('listening on /run/x.sock\\n');
}, 300);
setInterval(() => {}, 1000);
`;

class StandInRun extends RealRun {
  entry = '';
  protected override daemonEntry(): string {
    return this.entry;
  }
}

describe('RealRun.startDaemon', () => {
  it('a restart waits for the new daemon, not the line of the old one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cusr-real-driver-'));
    dirs.push(dir);
    const ready = join(dir, 'ready');
    const direction = {
      config: join(dir, 'config.yaml'),
      data_dir: dir,
      repo: 'acme/sandbox',
      run: { profile: 'p', mode: 'direct-pr', worker: 'w', reviewer: null },
    };
    const run = new StandInRun(
      RealSmokeSchema.parse({
        approval: 'test',
        ledger: join(dir, 'ledger'),
        node: direction,
        python: direction,
      }),
      'node',
    );
    run.entry = join(dir, 'stand-in.mjs');
    writeFileSync(run.entry, STAND_IN);
    process.env['STAND_IN_READY'] = ready;
    try {
      await run.startDaemon();
      await run.stopDaemon('SIGKILL');
      rmSync(ready);
      await run.startDaemon();
      expect(existsSync(ready)).toBe(true);
    } finally {
      await run.stopDaemon('SIGKILL');
      delete process.env['STAND_IN_READY'];
    }
  });
});
