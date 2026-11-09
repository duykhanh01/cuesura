/**
 * One life of the daemon of a local smoke rehearsal, run as `node test/support/smoke-daemon-child.ts
 * <args.json>`: the wiring `cusrd` runs with, in a process of its own so a test can kill it. Only GitHub
 * and the remote are stand-ins. The fake GitHub keeps its state in a file this process alone writes; the
 * test asks for a merge or check result by dropping a file next to it.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import type { GitHubPort, GitHubRequest } from '../../src/adapters/ports.ts';
import { startDaemon, systemClock } from '../../src/daemon/main.ts';
import { productionControl } from '../../src/daemon/production.ts';
import { Redactor } from '../../src/runner/redact.ts';
import { FakeGitHub, type FakeGitHubState } from './fake-github.ts';

export type SmokeDaemonArgs = {
  readonly configPath: string;
  readonly dataDir: string;
  readonly state: string;
  readonly repo: string;
  readonly remote: string;
  /** Conclusions of the required checks at each new head, oldest first; the last repeats. */
  readonly ci: readonly ('success' | 'failure')[];
};

const args = JSON.parse(readFileSync(process.argv[2] as string, 'utf8')) as SmokeDaemonArgs;

const github = new FakeGitHub(args.repo);
if (existsSync(args.state))
  github.restore(JSON.parse(readFileSync(args.state, 'utf8')) as FakeGitHubState);
github.headOf = (branch) => {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: args.remote,
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  const sha = r.stdout.trim();
  if (!github.checks.has(sha)) {
    const conclusion = args.ci[Math.min(github.checks.size, args.ci.length - 1)] ?? 'success';
    github.checks.set(sha, { build: 'success', test: conclusion });
  }
  return sha;
};
const save = (): void => {
  const tmp = `${args.state}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(github.snapshot()));
  renameSync(tmp, args.state);
};
const mergeRequest = `${args.state}.merge`;
const port: GitHubPort = {
  request: async (req: GitHubRequest) => {
    if (existsSync(mergeRequest)) {
      const m = JSON.parse(readFileSync(mergeRequest, 'utf8')) as {
        number: number;
        merge_commit: string;
      };
      github.merge(m.number, m.merge_commit);
      rmSync(mergeRequest);
    }
    // Pushes happen outside this port: a PR's head and checks follow the remote on every read.
    for (const p of github.prs) github.headOf(p.head.ref);
    const r = await github.request(req);
    save();
    return r;
  },
};

const control = await productionControl({
  configPath: args.configPath,
  dataDir: args.dataDir,
  clock: systemClock,
  redactor: new Redactor({ env: process.env }),
  newId: () => crypto.randomUUID(),
  seams: {
    github: () => port,
    remoteUrl: () => args.remote,
    gitProtocols: ['file'],
    gateToolchain: [dirname(process.execPath)],
  },
});
const started = await startDaemon({
  dataDir: args.dataDir,

  control,
  dispatchIntervalMs: 100,
  log: (m) => process.stderr.write(`${m}\n`),
});
if (!started.ok) {
  process.stderr.write(`${JSON.stringify(started.error)}\n`);
  process.exit(1);
}
process.stdout.write('ready\n');
process.on('SIGTERM', () => {
  void started.value.stop().then(() => process.exit(0));
});
