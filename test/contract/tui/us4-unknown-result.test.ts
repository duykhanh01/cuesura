import { describe, expect, it } from 'vitest';
import { callDaemon } from '../../../src/cli/client.ts';
import { createDaemonPort } from '../../../src/tui/client/daemon-port.ts';
import {
  MAX_CHECKS,
  MutationTracker,
  type MutationCommand,
} from '../../../src/tui/client/mutations.ts';
import type { SeededDaemon } from '../../support/daemon-task.ts';
import { cliJson, daemonSocket, seedRunning, useTui } from '../../support/tui-fixtures.ts';

// T055: a write whose answer is lost has one logical effect however often it is sent again (US4 scenario 8,
// FR-018, FR-019). The real port and tracker run against a real daemon; a proxy plays the lost answer. The
// terminal dialogs that show these states come later, so the screen is not on this path.
const tui = useTui();

async function setup() {
  const sd: SeededDaemon = tui.daemon();
  const [task] = sd.seed((d) => seedRunning(d, 1));
  await sd.start();
  const proxy = await tui.proxy(daemonSocket(sd));
  let calls = 0;
  const port = createDaemonPort({
    dataDir: proxy.dataDir,
    env: {},
    call: (o) => {
      calls += 1;
      return callDaemon(o);
    },
  });
  const tracker = new MutationTracker({ port, connected: () => true });
  const command = async (): Promise<MutationCommand> => {
    const shown = await sd.query('owner', { kind: 'task_show', task_id: task!.id });
    return {
      kind: 'task_cancel',
      project: 'acme',
      task_id: task!.id,
      expected_version: shown.envelope.data?.['version'] as number,
      payload: { reason: 'stop' },
    };
  };
  const cancelled = async (): Promise<number> => {
    const r = await cliJson(sd, 'task', 'history', task!.id);
    const events = r.envelope.data?.['events'] as { type: string }[];
    return events.filter((e) => e.type === 'TaskCancelled').length;
  };
  return { sd, proxy, tracker, command, cancelled, calls: () => calls };
}

describe('US4 scenario 8: a lost answer', () => {
  it('finds the stored result and does not send again', async () => {
    const { proxy, tracker, command, cancelled } = await setup();
    proxy.mode = 'drop_response';
    const r = await tracker.submit(await command());
    expect(r.started && r.mutation.state).toBe('unknown');
    const id = r.started ? r.mutation.requestId : '';
    proxy.mode = 'forward';
    // The daemon finished the request while the answer was lost; poll until the ledger has it.
    let m = await tracker.poll(id);
    for (let i = 0; i < 20 && m?.state === 'unknown'; i++) {
      await new Promise((res) => setTimeout(res, 100));
      m = await tracker.poll(id);
    }
    expect(m?.state).toBe('accepted');
    expect(m?.resends).toBe(0);
    expect(await cancelled()).toBe(1);
  });

  it('sends again with the same request ID when the daemon never admitted it', async () => {
    const { proxy, tracker, command, cancelled, sd } = await setup();
    const real = daemonSocket(sd);
    // The request never reaches the daemon: the connection goes to nowhere.
    proxy.retarget(`${proxy.dataDir}/nowhere.sock`);
    const r = await tracker.submit(await command());
    expect(r.started && r.mutation.state).toBe('unknown');
    const id = r.started ? r.mutation.requestId : '';
    proxy.retarget(real);
    const m = await tracker.poll(id);
    expect(m?.state).toBe('accepted');
    expect(m?.resends).toBe(1);
    expect(m?.requestId).toBe(id);
    expect(await cancelled()).toBe(1);
  });

  it('stops at the ceiling, and Check again starts a new round', async () => {
    const { proxy, tracker, command, cancelled, sd, calls } = await setup();
    const real = daemonSocket(sd);
    proxy.retarget(`${proxy.dataDir}/nowhere.sock`);
    const r = await tracker.submit(await command());
    const id = r.started ? r.mutation.requestId : '';
    for (let i = 0; i < MAX_CHECKS; i++) await tracker.poll(id);
    expect((await tracker.poll(id))?.state).toBe('unresolved');
    const before = calls();
    await tracker.poll(id);
    expect(calls()).toBe(before);
    expect((await tracker.submit(await command())).started).toBe(false);

    proxy.retarget(real);
    expect(tracker.checkAgain(id)).toMatchObject({ state: 'unknown', checks: 0, resends: 0 });
    const m = await tracker.poll(id);
    expect(m?.state).toBe('accepted');
    expect(await cancelled()).toBe(1);
  });
});
