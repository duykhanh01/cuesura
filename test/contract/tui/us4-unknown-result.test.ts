import { describe, expect, it } from 'vitest';
import { callDaemon } from '../../../src/cli/client.ts';
import { createDaemonPort } from '../../../src/tui/client/daemon-port.ts';
import {
  COMMAND_TIMEOUT_MS,
  MAX_CHECKS,
  MutationTracker,
  type MutationCommand,
} from '../../../src/tui/client/mutations.ts';
import type { SeededDaemon } from '../../support/daemon-task.ts';
import type { PtySession } from '../../support/pty.ts';
import {
  cliJson,
  daemonSocket,
  flat,
  recheckScene,
  sendRecheck,
  seedRunning,
  useTui,
} from '../../support/tui-fixtures.ts';

// T055: a write whose answer is lost has one logical effect however often it is sent again (US4 scenario 8,
// FR-018, FR-019). The first block drives the real Actions screen on a PTY: Recheck goes through the tracker
// to `/v1/command`, and a proxy plays the lost answers. The second runs the tracker alone against a real
// daemon, which is the only way to spend the ceiling of 60 checks without waiting a minute.
const tui = useTui();

const recheckSetup = (): ReturnType<typeof recheckScene> => recheckScene(tui);

const ids = (sent: { id: string }[]): string[] => [...new Set(sent.map((x) => x.id))];

const checking = (s: PtySession): Promise<void> =>
  s.waitFor(
    () => flat(s.screenText()).includes('Result unknown - checking'),
    COMMAND_TIMEOUT_MS + 5_000,
  );

describe('US4 scenario 8: Recheck on the Actions screen with a lost answer', () => {
  it('finds the stored result and sends nothing again', async () => {
    const { proxy, s, sent, observed } = await recheckSetup();
    proxy.mode = 'drop_response';
    await sendRecheck(s);
    await s.waitFor(() => flat(s.screenText()).includes('Result unknown - checking'));
    proxy.mode = 'forward';
    await s.waitFor(() => /Done \(request /.test(s.screenText()), 8_000);
    expect(sent).toHaveLength(1);
    expect(observed()).toBe(1);
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('sends again 3 times with the same request ID and the task is rechecked once', async () => {
    const { s, sent, control, observed } = await recheckSetup();
    // The daemon never admits the first 3 sends: the ledger has no row, so each check asks for a resend.
    control.refuseCommands = 3;
    await sendRecheck(s);
    await s.waitFor(() => flat(s.screenText()).includes('Result unknown - checking'));
    await s.waitFor(() => /Done \(request /.test(s.screenText()), 15_000);
    expect(sent).toHaveLength(4);
    expect(ids(sent)).toHaveLength(1);
    expect(new Set(sent.map((x) => x.body)).size).toBe(1);
    expect(observed()).toBe(1);
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('delivers the same request ID to the daemon 4 more times after the effect and it stays one effect', async () => {
    const { sd, s, sent, control, observed } = await recheckSetup();
    control.replays = 4;
    await sendRecheck(s);
    await s.waitFor(() => /Done \(request /.test(s.screenText()), 8_000);
    await s.waitFor(() => control.replies.length === 4, 15_000);
    // The daemon answered every duplicate with the stored result of the same request, not with a new effect.
    for (const reply of control.replies) expect(reply).toMatch(/200 OK|"ok":\s*true/);
    expect(sent).toHaveLength(1);
    expect(observed()).toBe(1);
    const id = sent[0]?.id ?? '';
    const found = await cliJson(sd, 'request', 'show', id);
    expect(found.envelope.data?.['state']).toBe('completed');
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('stops after 5 resends, offers Check again, and C starts a new round with the same request ID', async () => {
    const { s, sent, control, observed } = await recheckSetup();
    control.refuseCommands = Infinity;
    await sendRecheck(s);
    await s.waitFor(() => flat(s.screenText()).includes('Check again (C)'), 20_000);
    expect(sent).toHaveLength(6);
    expect(ids(sent)).toHaveLength(1);
    expect(observed()).toBe(0);
    expect(flat(s.screenText())).toContain('C check again');

    control.refuseCommands = 0;
    s.send('C');
    await s.waitFor(() => /Done \(request /.test(s.screenText()), 8_000);
    expect(ids(sent)).toHaveLength(1);
    expect(observed()).toBe(1);
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('stops at 60 checks, shows Check again, and C starts a new round', async () => {
    const { s, sent, holdDaemon, release, observed, shows } = await recheckSetup();
    // The daemon keeps the request in progress: the command times out, and every check is answered `in_progress`.
    holdDaemon();
    try {
      await sendRecheck(s);
      await checking(s);
      // The proxy count and the PTY update arrive independently. Check the count at the UI transition.
      await s.waitFor(() => flat(s.screenText()).includes('Check again (C)'), 130_000);
      expect(shows()).toBe(60);
      expect(ids(sent)).toHaveLength(1);
    } finally {
      release();
    }
    s.send('C');
    await s.waitFor(() => /Done \(request /.test(s.screenText()), 15_000);
    expect(ids(sent)).toHaveLength(1);
    expect(observed()).toBe(1);
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  }, 150_000);

  it('blocks a new write on the task while the result is unknown, with the reason', async () => {
    const { s, sent, control } = await recheckSetup();
    control.refuseCommands = Infinity;
    control.refuseShows = true;
    await sendRecheck(s);
    await s.waitFor(() => flat(s.screenText()).includes('Result unknown - checking'));
    const before = sent.length;
    await sendRecheck(s);
    await s.waitFor(() =>
      flat(s.screenText()).includes('result of an earlier change to this task is not known yet'),
    );
    expect(sent.length).toBe(before);
    s.send('q');
    expect((await s.waitForExit()).status).toBe(3);
  });

  it.each(['SIGTERM', 'SIGHUP'] as const)(
    'exits 3 with the request ID on stderr when %s ends it with a result unknown',
    async (signal) => {
      const { s, sent, holdDaemon, release } = await recheckSetup();
      const pid = await s.programPid();
      holdDaemon();
      try {
        await sendRecheck(s);
        await checking(s);
        s.signal(signal, pid);
        expect((await s.waitForExit()).status).toBe(3);
        expect(s.screenText()).toContain(`request ID: ${sent[0]?.id ?? ''}`);
      } finally {
        release();
      }
    },
  );

  it('on exit prints the request ID and the lookup command after the terminal is back, and exits 3', async () => {
    const { sd, proxy, s, sent } = await recheckSetup();
    proxy.mode = 'drop_response';
    await sendRecheck(s);
    await s.waitFor(() => flat(s.screenText()).includes('Result unknown - checking'));
    s.send('q');
    const exit = await s.waitForExit();
    expect(exit.status).toBe(3);
    expect(exit.sttyAfter).toBe(exit.sttyBefore);
    const id = sent[0]?.id ?? '';
    expect(s.screenText()).toContain(`request ID: ${id}`);
    const command = s.screenText().match(/look it up with: (cusr request show \S+)/)?.[1];
    expect(command).toBe(`cusr request show ${id}`);
    const output = s.rawOutput();
    const restored = output.lastIndexOf('\x1b[?1049l');
    expect(restored).toBeGreaterThanOrEqual(0);
    expect(output.indexOf(`request ID: ${id}`, restored)).toBeGreaterThan(restored);
    const found = await cliJson(sd, ...command!.split(' ').slice(1));
    expect(found.code).toBe(0);
    expect(found.envelope.data?.['state']).toBe('completed');
  });
});

describe('US4 scenario 8: the tracker against a real daemon', () => {
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
    // A lost link no longer spends a check, so the ceiling is reached with answered `in_progress` looks.
    let busy = false;
    const counted: typeof port = {
      ...port,
      requestShow: (id, t) =>
        busy
          ? Promise.resolve({ ok: true, value: { state: 'in_progress' } as never })
          : port.requestShow(id, t),
    };
    const tracker = new MutationTracker({ port: counted, connected: () => true });
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
    return {
      sd,
      proxy,
      tracker,
      command,
      cancelled,
      calls: () => calls,
      hold: (v: boolean) => (busy = v),
    };
  }

  it('stops at 60 checks, and Check again starts a new round', async () => {
    const { proxy, tracker, command, cancelled, sd, calls, hold } = await setup();
    const real = daemonSocket(sd);
    proxy.retarget(`${proxy.dataDir}/nowhere.sock`);
    const r = await tracker.submit(await command());
    const id = r.started ? r.mutation.requestId : '';
    hold(true);
    for (let i = 0; i < MAX_CHECKS; i++) await tracker.poll(id);
    expect(tracker.get(id)?.state).toBe('unresolved');
    const before = calls();
    await tracker.poll(id);
    expect(calls()).toBe(before);
    expect((await tracker.submit(await command())).started).toBe(false);

    hold(false);
    proxy.retarget(real);
    expect(tracker.checkAgain(id)).toMatchObject({ state: 'unknown', checks: 0, resends: 0 });
    expect((await tracker.poll(id))?.state).toBe('accepted');
    expect(await cancelled()).toBe(1);
  });
});
