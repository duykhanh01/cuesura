import { setTimeout as sleep } from 'node:timers/promises';
import { v7 as uuidv7 } from 'uuid';
import { okEnvelope } from './output.ts';
import type { CliCommand } from './program.ts';
import { DATA_DIR, badFlag, call, print } from './tasks.ts';

const POLL_MS = 2_000;
/** A session that died without killing this process must not keep the lease looking alive for ever. */
const DEFAULT_TIMEOUT_S = 3_600;

type Attention = { readonly lease: string; readonly items: readonly unknown[] };

export const assistantWaitCommand: CliCommand = {
  name: 'assistant wait',
  description:
    'Hold the assistant lease and wait until a task needs a person; prints it and exits. Uses no agent turns',
  help: `Run it in the background and run it again with the printed lease after each return.

Examples:
  cusr assistant wait --json
  cusr assistant wait --lease 0190e9a0-0000-7000-8000-00000000abd0.1 --json
  cusr assistant wait --take --json`,
  options: [
    DATA_DIR,
    { flags: '--lease <id>', description: 'The lease a previous wait printed' },
    { flags: '--take', description: 'Take the lease from another session' },
    {
      flags: '--timeout <seconds>',
      description: `Return with no items after this long (default: ${DEFAULT_TIMEOUT_S})`,
    },
  ],
  async run(values, json, io) {
    const seconds = Number(values['timeout'] ?? DEFAULT_TIMEOUT_S);
    if (!Number.isInteger(seconds) || seconds < 1)
      return badFlag('--timeout must be a positive whole number of seconds.', {}, json, io);
    const deadline = Date.now() + seconds * 1_000;
    // Named here, not by the daemon: a retry after a lost first reply must count as this same session.
    let lease = values['lease'] ?? uuidv7();
    const first = values['take'] === 'true' ? 'take' : 'attach';
    let mode = values['lease'] === undefined || first === 'take' ? first : 'resume';
    for (;;) {
      const r = await call(values, '/v1/query', { kind: 'attention', lease, mode }, null);
      if (r.ok) {
        const data = r.data as Attention;
        lease = data.lease;
        mode = 'resume';
        if (data.items.length > 0) return print(r, json, io);
        // An unreachable daemon is not news: the lease resumes on the first poll after its restart.
      } else if (r.error.code !== 'daemon_unreachable') return print(r, json, io);
      const left = deadline - Date.now();
      if (left <= 0)
        return print(
          r.ok ? okEnvelope({ ...(r.data as Attention), timed_out: true }) : r,
          json,
          io,
        );
      await sleep(Math.min(POLL_MS, left));
    }
  },
};
