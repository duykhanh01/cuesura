import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallerActor } from '../../src/application/authz.ts';
import { callDaemon, exitCodeFor } from '../../src/cli/client.ts';
import {
  startDaemon,
  STORE_FILE,
  type DaemonOptions,
  type RunningDaemon,
} from '../../src/daemon/main.ts';
import { queueCommands } from '../../src/daemon/queue-pause.ts';
import { taskControl, type TaskControlDeps } from '../../src/daemon/task-control.ts';
import type { Store } from '../../src/store/index.ts';
import { asEpochMs } from '../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../src/store/testing.ts';
import { PACKS } from './config-fixtures.ts';
import { fakeGit, fakeGitHub, fakeHost, MANIFESTS, userConfig } from './preflight-fakes.ts';
import { StoreDriver } from './store-driver.ts';

// A real daemon over the control socket on a store the test seeded first (T095/T096): the task is driven
// to the state under test with the StoreDriver, then commands go through admission, the ledger and the
// application services exactly as the CLI sends them.

export type Reply = {
  status: number;
  code: number;
  envelope: {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: Record<string, unknown>;
  };
};

/** Services a test adds to the task surface (recheck, logs, doctor, the scheduler). */
export type SeededExtra = (
  store: Store,
  runtime: { readonly health: () => string | null },
) => Partial<Omit<TaskControlDeps, 'store' | 'now'>> & {
  readonly schedule?: () => Promise<unknown>;
};

export class SeededDaemon {
  readonly base: string;
  readonly dataDir: string;
  daemon: RunningDaemon | null = null;
  readonly #opts: Partial<DaemonOptions>;
  readonly #extra: SeededExtra;
  #seq = 0;
  readonly clock = {
    now: () => asEpochMs(this.now),
    monotonic: () => this.now,
  };
  now = 1_800_000_000_000;

  constructor(opts: Partial<DaemonOptions> = {}, extra: SeededExtra = () => ({})) {
    this.#extra = extra;
    this.base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-seeded-')));
    this.dataDir = join(this.base, 'data');
    mkdirSync(this.dataDir, { mode: 0o700 });
    this.#opts = opts;
  }

  /** Seeds the daemon's own store file before the daemon opens it. */
  seed<T>(f: (d: StoreDriver) => T): T {
    const d = new StoreDriver(openFileStoreForTest(join(this.dataDir, STORE_FILE)));
    d.now = this.now;
    try {
      return f(d);
    } finally {
      this.now = d.now;
      d.store.close();
    }
  }

  newId = (): string => `0192aaaa-0000-7000-8000-${String(++this.#seq).padStart(12, '0')}`;

  async start(): Promise<RunningDaemon> {
    const started = await startDaemon({
      dataDir: this.dataDir,
      clock: this.clock,
      newId: this.newId,
      control: (store, runtime) => {
        const { schedule, ...more } = this.#extra(store, runtime);
        const control = taskControl({
          store,
          now: () => this.clock.now(),
          dataDir: this.dataDir,
          confirm: {
            store,
            ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
            configInputs: () =>
              Promise.resolve({
                user: userConfig(),
                packs: PACKS,
                manifests: MANIFESTS,
              }),
            now: () => this.clock.now(),
          },
          ...more,
        });
        return {
          ...control,
          // As production wires it: `cusr queue pause` works against a seeded daemon too.
          commands: {
            ...control.commands,
            ...queueCommands({ dataDir: this.dataDir, now: () => this.clock.now() }),
          },
          ...(schedule === undefined ? {} : { schedule }),
        };
      },
      ...this.#opts,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.error));
    this.daemon = started.value;
    return started.value;
  }

  async stop(): Promise<void> {
    await this.daemon?.stop();
    this.daemon = null;
  }

  async cleanup(): Promise<void> {
    await this.stop();
    rmSync(this.base, { recursive: true, force: true });
  }

  async call(path: '/v1/command' | '/v1/query', actor: CallerActor, body: unknown): Promise<Reply> {
    if (this.daemon === null) throw new Error('daemon not running');
    const r = await callDaemon({
      socketPath: this.daemon.socketPath,
      actor,
      method: 'POST',
      path,
      body,
    });
    if (!r.ok) throw new Error(r.error.message);
    return {
      status: r.value.status,
      code: exitCodeFor(r.value.envelope),
      envelope: r.value.envelope as unknown as Reply['envelope'],
    };
  }

  command(actor: CallerActor, body: unknown): Promise<Reply> {
    return this.call('/v1/command', actor, body);
  }

  query(actor: CallerActor, body: unknown): Promise<Reply> {
    return this.call('/v1/query', actor, body);
  }
}
