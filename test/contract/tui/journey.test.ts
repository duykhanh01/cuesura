import { describe, expect, it } from 'vitest';
import type { SeededDaemon } from '../../support/daemon-task.ts';
import { A, ci, merge } from '../../support/observation.ts';
import { KEY, type PtySession } from '../../support/pty.ts';
import { startConfirmed } from '../../support/runtime.ts';
import { agentData, PREPARE_DATA, publishData } from '../../support/scenario.ts';
import type { StoreDriver } from '../../support/store-driver.ts';
import { checkpointGates, reviewToCi } from '../../support/store-flows.ts';
import { flat, pressAction, useTui } from '../../support/tui-fixtures.ts';

// T069 / SC-004 with the simulated harness: one TUI session, no `cusr` subcommand, from an empty Home to
// DONE after a merge by hand, in both modes. The agent's work is played into the store while the daemon is
// down, as the runner would record it; the session stays open and reconnects by itself. Only the time the
// user spends at the keys is counted.
const tui = useTui();

const RUNTIME =
  'runtime:\n  modes:\n    direct-pr: { when_to_use: "small, low risk" }\n    full-review: { when_to_use: "needs a second pair of eyes" }';

const said = (s: PtySession, text: string, ms = 15_000): Promise<void> =>
  s.waitFor(() => flat(s.screenText()).includes(text), ms);

/** Plays the agent's part with the daemon down; the open session sees it once it reconnects. */
async function agent(sd: SeededDaemon, s: PtySession, play: (d: StoreDriver) => void) {
  await sd.stop();
  await said(s, 'Reconnecting');
  sd.seed(play);
  await sd.start();
  await s.waitFor(() => !s.screenText().includes('Reconnecting'), 30_000);
}

describe('SC-004: the whole journey from the TUI alone, simulated harness', () => {
  it.each(['direct-pr', 'full-review'] as const)(
    '%s: create, propose, confirm, answer, follow to a green PR and see DONE after the merge',
    async (mode) => {
      const sd = tui.daemon({ runnable: {}, runtime: RUNTIME });
      await sd.start();
      const s = tui.cusr(sd.dataDir);
      let keys = 0;
      const user = async (step: () => Promise<void>): Promise<void> => {
        const at = performance.now();
        await step();
        keys += performance.now() - at;
      };
      const title = `Journey ${mode}`;

      await user(async () => {
        await said(s, 'Press n to create the first one');
        s.send('n');
        await said(s, '‹ acme ›');
        for (const text of ['', title, 'main', 'Export the report', 'The report downloads']) {
          if (text !== '') {
            s.send(text);
            await said(s, text);
          }
          s.send(KEY.tab);
        }
        s.send(KEY.ctrlS);
        await s.waitFor(() => !s.screenText().includes('Base branch'));
        await said(s, title);

        s.send('a');
        await pressAction(s, 'Propose run');
        await said(s, 'Profile: standard');
        if (mode === 'full-review') {
          s.send(KEY.down);
          await said(s, 'needs a second pair of eyes');
        }
        s.send(KEY.ctrlS);
        await s.waitFor(() => !s.screenText().includes('Run config'));

        await pressAction(s, 'Confirm');
        await said(s, 'Confirming: the run config.');
        await said(s, mode);
        s.send('confirm');
        await s.waitFor(() => /Enter: confirm_/.test(s.screenText()));
        s.send(KEY.enter);
        await said(s, 'Done (request');
        s.send(KEY.esc);
      });
      const board = await sd.query('owner', { kind: 'task_board', scope: 'all', limit: 10 });
      const id = (board.envelope.data as unknown as { items: { task_id: string }[] }).items[0]
        ?.task_id as never;

      await agent(sd, s, (d) => {
        startConfirmed(d, d.task(id).task, mode);
        d.complete(id, d.pendingOne(id, 'prepare').id, 'succeeded', PREPARE_DATA);
        d.complete(
          id,
          d.pendingOne(id, 'start_agent').id,
          'succeeded',
          agentData('needs_input', { questions: ['Which format?'] }),
        );
      });

      await user(async () => {
        await said(s, 'Needs you');
        s.send('a');
        await pressAction(s, 'Answer the question');
        await said(s, 'Which format?');
        s.send('CSV');
        s.send(KEY.ctrlS);
        await said(s, 'Done (request');
        s.send(KEY.esc);
      });

      await agent(sd, s, (d) => {
        d.complete(id, d.pendingOne(id, 'start_agent').id, 'succeeded', agentData('done'));
        d.complete(id, d.pendingOne(id, 'run_gates').id, 'succeeded', checkpointGates(A));
        d.complete(id, d.pendingOne(id, 'publish').id, 'succeeded', publishData(A));
        d.complete(id, d.pendingOne(id, 'create_pr').id, 'succeeded', {
          pr_ref: 'acme#7',
          head_sha: A,
        });
        reviewToCi(d, id);
        d.complete(
          id,
          d.pendingOne(id, 'await_ci').id,
          'succeeded',
          ci(A, { build: 'success', test: 'success' }),
        );
        expect(d.task(id)).toMatchObject({
          status: 'WAITING',
          wait: { detail: { code: 'merge' } },
        });
      });

      await user(async () => {
        await s.waitFor(() => s.screenText().includes(title));
        s.send('a');
        await said(s, 'Merge on GitHub');
        s.send(KEY.esc);
      });

      // The user merges on GitHub; the daemon's next look sees it.
      await agent(sd, s, (d) => {
        merge(d, d.task(id).task, A);
        for (let i = 0; i < 3 && d.task(id).status !== 'DONE'; i++)
          d.must(id, { kind: 'drain_result', pending_operations: [] });
        expect(d.task(id).status).toBe('DONE');
      });

      await user(async () => {
        await said(s, 'Finished (1)', 30_000);
      });
      const shown = await sd.query('owner', { kind: 'task_show', task_id: id });
      expect(shown.envelope.data).toMatchObject({
        status: 'DONE',
        run_config: { status: 'confirmed', selection: { mode } },
      });
      console.log(`SC-004 simulated ${mode}: ${(keys / 1000).toFixed(1)} s at the keys`);
      expect(keys).toBeLessThan(180_000);
      s.send('q');
      expect((await s.waitForExit()).status).toBe(0);
    },
    180_000,
  );
});
