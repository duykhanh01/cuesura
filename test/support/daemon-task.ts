import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTokenFile } from '../../src/application/access-tokens.ts';
import type { AuthzRole } from '../../src/domain/policy.ts';
import { callDaemon, exitCodeFor } from '../../src/cli/client.ts';
import {
  startDaemon,
  STORE_FILE,
  type DaemonOptions,
  type RunningDaemon,
} from '../../src/daemon/main.ts';
import { taskControl } from '../../src/daemon/task-control.ts';
import { asEpochMs } from '../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../src/store/testing.ts';
import { PACKS } from './config-fixtures.ts';
import {
  fakeGit,
  fakeGitHub,
  fakeHost,
  MANIFESTS,
  userConfig,
} from './preflight-fakes.ts';
import { StoreDriver } from './store-driver.ts';

// A real daemon over the control socket on a store the test seeded first (T095/T096): the task is driven
// to the state under test with the StoreDriver, then commands go through admission, the ledger and the
// application services exactly as the CLI sends them.

export type TokenSpec = {
  id: string;
  actor: string;
  roles: AuthzRole[];
  projects: string[];
};

export type Reply = {
  status: number;
  code: number;
  envelope: {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: Record<string, unknown>;
  };
};

export class SeededDaemon {
  readonly base: string;
  readonly dataDir: string;
  readonly tokens: Record<string, string> = {};
  daemon: RunningDaemon | null = null;
  readonly #specs: TokenSpec[];
  readonly #opts: Partial<DaemonOptions>;
  #seq = 0;
  readonly clock = {
    now: () => asEpochMs(this.now),
    monotonic: () => this.now,
  };
  now = 1_800_000_000_000;

  constructor(specs: TokenSpec[] = [], opts: Partial<DaemonOptions> = {}) {
    this.base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-seeded-')));
    this.dataDir = join(this.base, 'data');
    mkdirSync(this.dataDir, { mode: 0o700 });
    this.#specs = specs;
    this.#opts = opts;
    for (const s of specs) {
      const token = randomBytes(32).toString('base64url');
      writeFileSync(join(this.base, `${s.id}.token`), `${token}\n`, {
        mode: 0o600,
      });
      this.tokens[s.id] = token;
    }
  }

  /** Seeds the daemon's own store file before the daemon opens it. */
  seed<T>(f: (d: StoreDriver) => T): T {
    const d = new StoreDriver(
      openFileStoreForTest(join(this.dataDir, STORE_FILE)),
    );
    d.now = this.now;
    try {
      return f(d);
    } finally {
      this.now = d.now;
      d.store.close();
    }
  }

  newId = (): string =>
    `0192aaaa-0000-7000-8000-${String(++this.#seq).padStart(12, '0')}`;

  async start(): Promise<RunningDaemon> {
    const started = await startDaemon({
      dataDir: this.dataDir,
      accessTokens: this.#specs.map((s) => ({
        ...s,
        token_file: join(this.base, `${s.id}.token`),
      })),
      clock: this.clock,
      newId: this.newId,
      control: (store) =>
        taskControl({
          store,
          now: () => this.clock.now(),
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
        }),
      ...this.#opts,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.error));
    this.daemon = started.value;
    const owner = readTokenFile(started.value.ownerTokenPath, 'owner');
    if (!owner.ok) throw new Error('owner token');
    this.tokens['owner'] = owner.value;
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

  async call(
    path: '/v1/command' | '/v1/query',
    token: string,
    body: unknown,
  ): Promise<Reply> {
    if (this.daemon === null) throw new Error('daemon not running');
    const r = await callDaemon({
      socketPath: this.daemon.socketPath,
      token: this.tokens[token] ?? token,
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

  command(token: string, body: unknown): Promise<Reply> {
    return this.call('/v1/command', token, body);
  }

  query(token: string, body: unknown): Promise<Reply> {
    return this.call('/v1/query', token, body);
  }
}
