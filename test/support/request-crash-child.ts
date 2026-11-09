/**
 * A daemon with the task surface over fake ports, run as
 * `node test/support/request-crash-child.ts <data-dir>`. With `CUSR_CRASH_AT` it dies mid-command, so a
 * test can look at what the ledger holds afterwards from a fresh daemon on the same store.
 */
import { startDaemon } from '../../src/daemon/main.ts';
import { taskControl } from '../../src/daemon/task-control.ts';
import { PACKS } from './config-fixtures.ts';
import { fakeGit, fakeGitHub, fakeHost, MANIFESTS, userConfig } from './preflight-fakes.ts';

const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error('missing data dir');
const started = await startDaemon({
  dataDir,

  control: (store) =>
    taskControl({
      store,
      now: () => Date.now(),
      confirm: {
        store,
        ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
        configInputs: () =>
          Promise.resolve({
            user: userConfig(),
            packs: PACKS,
            manifests: MANIFESTS,
          }),
        now: () => Date.now(),
      },
    }),
});
if (!started.ok) throw new Error(JSON.stringify(started.error));
process.stdout.write('ready\n');
