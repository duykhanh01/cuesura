import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  InboxSchema,
  QuestionShowSchema,
  type CallerInfo,
} from '../../../src/tui/client/schemas.ts';
import type { TuiState } from '../../../src/tui/model/state.ts';
import type { Message } from '../../../src/tui/model/messages.ts';
import { dialogDue, openDialog, questionView } from '../../../src/tui/model/dialog.ts';
import { exitNotice } from '../../../src/tui/main.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import { sanitize } from '../../../src/tui/terminal/safe-text.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import type { SeededDaemon } from '../../support/daemon-task.ts';
import { KEY } from '../../support/pty.ts';
import {
  ASSISTANT,
  OWNER,
  QUESTION,
  TASK,
  VIEWER,
  chars,
  explainOf,
  inboxMessage,
  key,
  menu,
  run,
  sentCommand,
  submits,
  text,
} from '../../support/tui-dialogs.ts';
import {
  cliJson,
  flat,
  openMenuOf,
  pressAction,
  seedEscalation,
  seedQuestion,
  seedRunning,
  seedWorktreeChanged,
  seedWorktreesChanged,
  useTui,
} from '../../support/tui-fixtures.ts';

// T054: the four dialogs of US4. The first block drives them on a PTY against a real daemon and compares
// what the daemon recorded with the same operation through the CLI (SC-007); the second checks, below the
// PTY, what the dialogs send and refuse, which a real daemon cannot be made to do on demand.
const tui = useTui();

async function outcome(sd: SeededDaemon, id: string) {
  const h = await sd.query('owner', { kind: 'task_history', task_id: id });
  const e = await sd.query('owner', { kind: 'task_explain', task_id: id });
  const events = (h.envelope.data?.['events'] as { type: string; actor: string }[]).map(
    (x) => `${x.type}:${x.actor}`,
  );
  // Every effect the task ever had, from the daemon's own store: pending ones alone would not show one
  // that was created and already ran or ended on one side only.
  const effects = Object.values(sd.daemon?.store.readTask(id as Uuid)?.effects ?? {})
    .map((x) => `${x.kind}:${x.status}:r${x.revision}:${x.step ?? '-'}`)
    .sort();
  return {
    events,
    effects,
    pending: (e.envelope.data?.['pending_effects'] as unknown[]).length,
    status: e.envelope.data?.['status'],
    version: e.envelope.data?.['version'] as number,
  };
}

describe('US4 on a PTY: the same effect as the CLI', () => {
  it('Answer: Ctrl-S sends once and leaves what the CLI leaves (US4 scenario 1, SC-007)', async () => {
    const sd = tui.daemon();
    const dir = mkdtempSync(join(tmpdir(), 'us4-answer-'));
    try {
      const a = buildTask({ id: uuidOf(1), title: 'Question A' });
      const b = buildTask({ id: uuidOf(2), title: 'Question B' });
      sd.seed((d) => {
        seedQuestion(d, a);
        seedQuestion(d, b);
      });
      await sd.start();
      const s = tui.cusr(sd.dataDir);
      await openMenuOf(s, 'Question A');
      await pressAction(s, 'Answer the question');
      await s.waitForText('Which database?');
      // Enter is a new line in the field and never sends.
      s.send('Postgres');
      s.send(KEY.enter);
      s.send('please');
      await s.waitForText('please');
      // Nothing is recorded before Ctrl-S.
      expect((await outcome(sd, a.id)).events).toEqual((await outcome(sd, b.id)).events);
      s.send(KEY.ctrlS);
      await s.waitFor(() => /Done \(request /.test(s.screenText()), 15_000);

      const inbox = await cliJson(sd, 'inbox', '--task', b.id);
      const items = inbox.envelope.data?.['items'] as {
        question_id: string;
        task_version: number;
      }[];
      const file = join(dir, 'answer.txt');
      writeFileSync(file, 'Postgres\nplease');
      const viaCli = await cliJson(
        sd,
        'answer',
        items[0]?.question_id ?? '',
        '--file',
        file,
        '--expected-version',
        String(items[0]?.task_version),
      );
      expect(viaCli.code).toBe(0);
      const tuiOut = await outcome(sd, a.id);
      const cliOut = await outcome(sd, b.id);
      expect(tuiOut.events).toEqual(cliOut.events);
      expect(tuiOut.effects).toEqual(cliOut.effects);
      expect(tuiOut.pending).toBe(cliOut.pending);
      expect(tuiOut.status).toBe(cliOut.status);
      s.send('q');
      expect((await s.waitForExit()).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('Answer: a question answered elsewhere shows that answer and keeps the typed one (US4 scenario 2, EC-006)', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Question A' });
    sd.seed((d) => seedQuestion(d, t));
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await openMenuOf(s, 'Question A');
    await pressAction(s, 'Answer the question');
    await s.waitForText('Which database?');
    s.send('My own answer');
    await s.waitForText('My own answer');

    // Someone else answers through the CLI while the dialog is open.
    const inbox = await cliJson(sd, 'inbox', '--task', t.id);
    const item = (
      inbox.envelope.data?.['items'] as { question_id: string; task_version: number }[]
    )[0];
    const dir = mkdtempSync(join(tmpdir(), 'us4-elsewhere-'));
    try {
      const file = join(dir, 'a.txt');
      writeFileSync(file, 'MySQL, by the other session');
      const other = await cliJson(
        sd,
        'answer',
        item?.question_id ?? '',
        '--file',
        file,
        '--expected-version',
        String(item?.task_version),
      );
      expect(other.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    s.send(KEY.ctrlS);
    await s.waitFor(() => flat(s.screenText()).includes('MySQL, by the other session'), 20_000);
    const text = flat(s.screenText());
    expect(text).toContain('Answered elsewhere');
    expect(text).toContain('My own answer');
    expect(text).toContain('nothing of it was sent');
    // Only the other answer was ever recorded.
    const events = (await outcome(sd, t.id)).events.filter((e) => e.startsWith('QuestionAnswered'));
    expect(events).toHaveLength(1);
    s.send(KEY.esc);
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  }, 60_000);

  it('Cancel: nothing goes out until the word is exact; then it matches the CLI (US4 scenario 3, SC-007)', async () => {
    const sd = tui.daemon();
    sd.seed((d) => {
      seedRunning(d, 2);
    });
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await openMenuOf(s, 'Task 001');
    const first = await outcome(sd, uuidOf(1));
    await pressAction(s, 'Cancel task');
    await s.waitForText('What cancelling does');
    expect(flat(s.screenText())).toContain('it is not CANCELLED before');

    // No reason: the word alone does not send.
    s.send(KEY.tab);
    await s.waitForText('Type cancel, then press Enter');
    s.send('cancel');
    s.send(KEY.enter);
    await s.waitForText('A reason is required');
    for (let i = 0; i < 6; i++) s.send('\x7f');
    // Wrong word, empty box, pasted word and Ctrl-S: each answered in place, none sent.
    s.send(KEY.tab);
    s.send('stop it');
    s.send(KEY.tab);
    s.send('cancl');
    s.send(KEY.enter);
    await s.waitForText('type cancel exactly');
    s.send(KEY.ctrlS);
    for (let i = 0; i < 5; i++) s.send('\x7f');
    s.send('\x1b[200~cancel\x1b[201~');
    await s.waitForText('Paste is not accepted here');
    s.send(KEY.enter);
    await s.waitForText('type cancel exactly');
    expect(await outcome(sd, uuidOf(1))).toEqual(first);

    s.send('cancel');
    s.send(KEY.enter);
    await s.waitFor(
      () => /Cancel accepted by the daemon \(request /.test(flat(s.screenText())),
      15_000,
    );
    expect(flat(s.screenText())).toContain('not CANCELLED until the daemon reports it');

    const viaCli = await cliJson(
      sd,
      'task',
      'cancel',
      uuidOf(2),
      '--project',
      'acme',
      '--expected-version',
      String((await outcome(sd, uuidOf(2))).version),
      '--reason',
      'stop it',
    );
    expect(viaCli.code).toBe(0);
    const tuiOut = await outcome(sd, uuidOf(1));
    const cliOut = await outcome(sd, uuidOf(2));
    expect(tuiOut.events).toEqual(cliOut.events);
    expect(tuiOut.effects).toEqual(cliOut.effects);
    expect(tuiOut.pending).toBe(cliOut.pending);
    expect(tuiOut.status).toBe(cliOut.status);
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  }, 60_000);

  it('Approve: shows step, rung, reason and limits, and approves like the CLI (US4 scenario 5, SC-007)', async () => {
    const sd = tui.daemon();
    const a = buildTask({ id: uuidOf(1), title: 'Escalation A' });
    const b = buildTask({ id: uuidOf(2), title: 'Escalation B' });
    sd.seed((d) => {
      seedEscalation(d, a);
      seedEscalation(d, b);
    });
    await sd.start();
    const frozen = await outcome(sd, a.id);

    const s = tui.cusr(sd.dataDir);
    await openMenuOf(s, 'Escalation A');
    await pressAction(s, 'Approve');
    await s.waitForText('Approve escalation');
    const shown = flat(s.screenText());
    expect(shown).toMatch(/Step: \S+ · rung \d+/);
    expect(shown).toContain('Why:');
    expect(shown).toContain('Left:');
    expect(shown).toContain('Needs the operate role');
    expect(shown).toContain('runs already used stay used');
    s.send(KEY.ctrlS);
    s.send('approv');
    s.send(KEY.enter);
    await s.waitForText('type approve exactly');
    expect(await outcome(sd, a.id)).toEqual(frozen);
    s.send('e');
    s.send(KEY.enter);
    await s.waitFor(() => /Done \(request /.test(s.screenText()), 15_000);

    const explained = await sd.query('owner', { kind: 'task_explain', task_id: b.id });
    const wait = (explained.envelope.data?.['wait'] as { detail: { step: string; rung: number } })
      .detail;
    const viaCli = await cliJson(
      sd,
      'task',
      'approve',
      b.id,
      '--kind',
      'escalation',
      '--step',
      wait.step,
      '--rung',
      String(wait.rung),
      '--expected-version',
      String(explained.envelope.data?.['version']),
    );
    expect(viaCli.code).toBe(0);
    const tuiOut = await outcome(sd, a.id);
    const cliOut = await outcome(sd, b.id);
    expect(tuiOut.events).toEqual(cliOut.events);
    expect(tuiOut.effects).toEqual(cliOut.effects);
    expect(tuiOut.pending).toBe(cliOut.pending);
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  }, 60_000);

  it('Recheck of worktree_changed names the worktree, warns, and goes only after accept (US4 scenario 4)', async () => {
    const sd = tui.daemon({ recheck: { observed: () => undefined } });
    const id = seedWorktreeChanged(sd, 1, 'Changed tree');
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await openMenuOf(s, 'Changed tree');
    await pressAction(s, 'Recheck');
    await s.waitForText('The worktree changed since the agent last left it');
    // The place of the worktree is read before anything can be accepted.
    await s.waitForText('Worktree: wt-1');
    const shown = flat(s.screenText());
    expect(shown).toContain('cannot show you what changed');
    expect(shown).toContain('Type accept, then press Enter');
    const before = await outcome(sd, id);
    s.send(KEY.ctrlS);
    s.send('accep');
    s.send(KEY.enter);
    await s.waitForText('type accept exactly');
    s.send('\x1b[200~t\x1b[201~');
    s.send(KEY.enter);
    await s.waitForText('type accept exactly');
    expect(await outcome(sd, id)).toEqual(before);
    s.send('t');
    s.send(KEY.enter);
    await s.waitFor(() => /\(request [0-9a-f-]{36}\)/.test(flat(s.screenText())), 15_000);
    const after = await outcome(sd, id);
    expect(after.events.some((e) => e.startsWith('WorktreeChangeAccepted'))).toBe(true);
    s.send('q');
    await s.waitForExit();
  }, 60_000);
});

/** The CLI as a declared actor, as the TUI's own actor is declared by CUSR_ACTOR. */
async function cliAs(actor: string, sd: SeededDaemon, ...argv: string[]) {
  const was = process.env['CUSR_ACTOR'];
  process.env['CUSR_ACTOR'] = actor;
  try {
    return await cliJson(sd, ...argv);
  } finally {
    if (was === undefined) delete process.env['CUSR_ACTOR'];
    else process.env['CUSR_ACTOR'] = was;
  }
}

type Operation = {
  readonly name: string;
  /** The role the daemon asks of the caller. */
  readonly role: 'operate' | 'admin';
  /** Two tasks alike: the TUI acts on the first, titled `title`, the CLI on the second. */
  seed(sd: SeededDaemon): readonly [string, string];
  readonly title: string;
  readonly label: string;
  /** The TUI, with the dialog's confirmation, to the point where its result is on screen. */
  drive(s: ReturnType<typeof tui.cusr>, permitted: boolean): Promise<void>;
  /** The same operation through the CLI, for the task B. */
  cli(sd: SeededDaemon, actor: string, id: string): Promise<{ code: number }>;
  /** A sign that the write was accepted and its effect shows. */
  effect(events: readonly string[]): boolean;
};

const OPERATIONS: readonly Operation[] = [
  {
    name: 'Answer',
    role: 'operate',
    title: 'Question A',
    label: 'Answer the question',
    seed: (sd) => {
      const a = buildTask({ id: uuidOf(1), title: 'Question A' });
      const b = buildTask({ id: uuidOf(2), title: 'Question B' });
      sd.seed((d) => {
        seedQuestion(d, a);
        seedQuestion(d, b);
      });
      return [a.id, b.id];
    },
    drive: async (s) => {
      await s.waitForText('Which database?');
      s.send('Postgres');
      s.send(KEY.ctrlS);
      await s.waitFor(() => /Done \(request /.test(s.screenText()), 15_000);
    },
    cli: async (sd, actor, id) => {
      // Reading is the owner's, so that what is compared is the write.
      const inbox = await cliAs('owner', sd, 'inbox', '--task', id);
      const item = (
        inbox.envelope.data?.['items'] as { question_id: string; task_version: number }[]
      )[0];
      const dir = mkdtempSync(join(tmpdir(), 'us4-matrix-'));
      try {
        const file = join(dir, 'a.txt');
        writeFileSync(file, 'Postgres');
        return await cliAs(
          actor,
          sd,
          'answer',
          item?.question_id ?? '',
          '--file',
          file,
          '--expected-version',
          String(item?.task_version),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    effect: (events) => events.some((e) => e.startsWith('QuestionAnswered')),
  },
  {
    name: 'Cancel',
    role: 'operate',
    title: 'Task 001',
    label: 'Cancel task',
    seed: (sd) => {
      sd.seed((d) => void seedRunning(d, 2));
      return [uuidOf(1), uuidOf(2)];
    },
    drive: async (s) => {
      await s.waitForText('What cancelling does');
      s.send('stop it');
      s.send(KEY.tab);
      s.send('cancel');
      s.send(KEY.enter);
      await s.waitFor(() => /Cancel accepted by the daemon/.test(flat(s.screenText())), 15_000);
    },
    cli: async (sd, actor, id) =>
      cliAs(
        actor,
        sd,
        'task',
        'cancel',
        id,
        '--project',
        'acme',
        '--expected-version',
        String((await outcome(sd, id)).version),
        '--reason',
        'stop it',
      ),
    effect: (events) => events.some((e) => e.startsWith('CancelRequested')),
  },
  {
    name: 'Recheck (worktree_changed)',
    role: 'operate',
    title: 'Changed A',
    label: 'Recheck',
    seed: (sd) => {
      const [a, b] = seedWorktreesChanged(sd, [
        [1, 'Changed A'],
        [2, 'Changed B'],
      ]);
      return [a as string, b as string];
    },
    drive: async (s) => {
      await s.waitForText('Worktree: wt-1');
      s.send('accept');
      s.send(KEY.enter);
      await s.waitFor(() => /\(request [0-9a-f-]{36}\)/.test(flat(s.screenText())), 15_000);
    },
    cli: async (sd, actor, id) =>
      cliAs(
        actor,
        sd,
        'task',
        'recheck',
        id,
        '--project',
        'acme',
        '--expected-version',
        String((await outcome(sd, id)).version),
      ),
    effect: (events) => events.some((e) => e.startsWith('WorktreeChangeAccepted')),
  },
  {
    name: 'Approve',
    // An escalation needs operate only (#205); adopting a pull request needs admin.
    role: 'operate',
    title: 'Escalation A',
    label: 'Approve',
    seed: (sd) => {
      const a = buildTask({ id: uuidOf(1), title: 'Escalation A' });
      const b = buildTask({ id: uuidOf(2), title: 'Escalation B' });
      sd.seed((d) => {
        seedEscalation(d, a);
        seedEscalation(d, b);
      });
      return [a.id, b.id];
    },
    drive: async (s, permitted) => {
      if (!permitted) {
        await s.waitForText('Nothing was sent: Approve needs the');
        return;
      }
      await s.waitForText('Needs the operate role');
      s.send('approve');
      s.send(KEY.enter);
      await s.waitFor(() => /Done \(request /.test(s.screenText()), 15_000);
    },
    cli: async (sd, actor, id) => {
      const explained = await sd.query('owner', { kind: 'task_explain', task_id: id });
      const wait = (explained.envelope.data?.['wait'] as { detail: { step: string; rung: number } })
        .detail;
      return cliAs(
        actor,
        sd,
        'task',
        'approve',
        id,
        '--kind',
        'escalation',
        '--step',
        wait.step,
        '--rung',
        String(wait.rung),
        '--expected-version',
        String(explained.envelope.data?.['version']),
      );
    },
    effect: (events) => events.some((e) => e.startsWith('ApprovalGranted')),
  },
];

// SC-007: each operation at each level of permission, once through the TUI and once through the CLI on a
// task like it, with the same actor. The permission result, the events and the effects must be the same.
// The levels the daemon knows are admin (owner) and operate (assistant), plus no permission at all (an actor
// the daemon does not know). The daemon has no read-only actor yet, so the read level is compared with the CLI
// only once one exists (upstream issue 207); until then it is checked below the
// PTY, in 'opens only what the caller may take, at each of three levels'.
describe('US4 on a PTY: the same result as the CLI, operation by operation, at each level (SC-007)', () => {
  for (const actor of ['owner', 'assistant'] as const)
    for (const op of OPERATIONS)
      it(`${actor}: ${op.name}`, async () => {
        const permitted = actor === 'owner' || op.role === 'operate';
        const sd = tui.daemon({ recheck: { observed: () => undefined } });
        const [a, b] = op.seed(sd);
        await sd.start();
        const before = await outcome(sd, a);
        const s = tui.cusr(sd.dataDir, { env: { CUSR_ACTOR: actor } });
        await openMenuOf(s, op.title);
        await pressAction(s, op.label);
        await op.drive(s, permitted);
        const viaCli = await op.cli(sd, actor, b);

        // The permission result: either side allowed, or both refused with nothing changed.
        expect(viaCli.code === 0, 'CLI allowed').toBe(permitted);
        const tuiOut = await outcome(sd, a);
        const cliOut = await outcome(sd, b);
        expect(tuiOut.events).toEqual(cliOut.events);
        expect(tuiOut.effects).toEqual(cliOut.effects);
        expect(tuiOut.pending).toBe(cliOut.pending);
        expect(tuiOut.status).toBe(cliOut.status);
        if (permitted) {
          expect(op.effect(tuiOut.events), 'the effect is on the task').toBe(true);
          expect(tuiOut.events.length).toBeGreaterThan(before.events.length);
          expect(tuiOut.events.at(-1)).toContain(actor);
        } else {
          expect(tuiOut).toEqual(before);
        }
        s.send(KEY.esc);
        s.send(KEY.esc);
        s.send('q');
        await s.waitForExit();
      }, 60_000);

  it('no permission (an actor the daemon does not know): the TUI sends nothing and the CLI is refused', async () => {
    for (const op of OPERATIONS) {
      const sd = tui.daemon({ recheck: { observed: () => undefined } });
      const [a, b] = op.seed(sd);
      await sd.start();
      const before = await outcome(sd, a);
      const s = tui.cusr(sd.dataDir, { env: { CUSR_ACTOR: 'nobody' } });
      await s.waitForText('Stopped');
      const viaCli = await op.cli(sd, 'nobody', b);
      expect(viaCli.code, op.name).not.toBe(0);
      expect(await outcome(sd, a), op.name).toEqual(before);
      expect((await outcome(sd, b)).events, op.name).toEqual(before.events);
      s.send('q');
      await s.waitForExit();
    }
  }, 120_000);
});

// Below the PTY: what a dialog sends, from state alone.

describe('US4 below the PTY: what a dialog sends', () => {
  it('Answer sends on Ctrl-S only, once, with the version it opened on (scenarios 1, 7)', () => {
    const m = menu(OWNER, explainOf());
    const open = run(m, key('enter'));
    expect(open.state.screens.at(-1)).toBe('dialog');
    const reading = run(
      open.state,
      ...chars('Postgres'),
      key('enter'),
      ...chars('please'),
      key('ctrl_s'),
    );
    // The question is not read yet: nothing can name it.
    expect(submits(reading.effects)).toHaveLength(0);
    expect(text(reading.state)).toContain('still being read');

    const loaded = run(open.state, inboxMessage(open.state));
    const sent = run(
      loaded.state,
      ...chars('Postgres'),
      key('enter'),
      ...chars('please'),
      key('ctrl_s'),
    );
    expect(sent.effects).toEqual([
      {
        type: 'submit',
        command: {
          kind: 'answer',
          project: 'acme',
          task_id: TASK,
          expected_version: 3,
          payload: { question_id: QUESTION, answer: 'Postgres\nplease' },
        },
      },
    ]);
    // A second Ctrl-S while the first is on its way does nothing.
    expect(submits(run(sent.state, key('ctrl_s')).effects)).toHaveLength(0);

    // The task moved while the dialog was open: nothing is sent, and the text stays.
    const moved = run(loaded.state, ...chars('x'), {
      type: 'actions_read',
      taskId: TASK,
      session: loaded.state.actions?.session ?? 0,
      askedAt: 30,
      at: 31,
      watermark: 8,
      result: { ok: true, value: explainOf({ version: 4 }) },
    });
    const refused = run(moved.state, key('ctrl_s'));
    expect(submits(refused.effects)).toHaveLength(0);
    expect(text(refused.state)).toContain('the task changed since this dialog opened');
    expect(refused.state.dialog?.field?.text).toBe('x');
  });

  it('Answer keeps the typed text and shows the other answer after a conflict (scenario 2, EC-006)', () => {
    const m = menu(OWNER, explainOf());
    const opened = run(m, key('enter')).state;
    const loaded = run(opened, inboxMessage(opened));
    const sent = run(loaded.state, ...chars('mine'), key('ctrl_s'));
    const command = sentCommand(sent.effects);
    const refused = run(sent.state, {
      type: 'mutation_changed',
      mutation: {
        requestId: '019a0000-0000-7000-8000-0000000000bb',
        command,
        state: 'rejected',
        result: { ok: false, code: 'conflict', message: 'already_answered' },
        checks: 0,
        resends: 0,
      },
    });
    expect(refused.effects).toContainEqual({ type: 'read_screen' });
    expect(refused.state.dialog?.field?.text).toBe('mine');
    expect(refused.state.dialog?.sending).toBe(false);
    expect(text(refused.state)).toContain('already answered or withdrawn');

    const shown = run(refused.state, {
      type: 'dialog_read',
      taskId: TASK,
      session: refused.state.dialog?.session ?? 0,
      askedAt: 40,
      at: 41,
      watermark: 8,
      part: 'question',
      result: {
        ok: true,
        value: QuestionShowSchema.parse({
          question_id: QUESTION,
          task_id: TASK,
          project: 'acme',
          status: 'answered',
          revision: 1,
          task_version: 4,
          body: 'Which database?',
          answer: 'MySQL',
          answered_by: 'owner',
        }),
      },
    });
    const screen = flat(text(shown.state));
    expect(screen).toContain('Answered elsewhere by owner');
    expect(screen).toContain('MySQL');
    expect(screen).toContain('mine');
    // Sending again goes nowhere: the question is closed.
    expect(submits(run(shown.state, key('ctrl_s')).effects)).toHaveLength(0);
  });

  it('Answer stays on its question when the task opens another before the inbox is read again (EC-006)', () => {
    const m = menu(OWNER, explainOf());
    const opened = run(m, key('enter')).state;
    const typed = run(opened, inboxMessage(opened), ...chars('mine')).state;
    const NEXT = '019a0000-0000-7000-8000-0000000000ac';
    // The question was answered elsewhere and the task already asks the next one.
    const moved = run(typed, {
      type: 'dialog_read',
      taskId: TASK,
      session: typed.dialog?.session ?? 0,
      askedAt: 30,
      at: 31,
      watermark: 8,
      part: 'inbox',
      result: {
        ok: true,
        value: InboxSchema.parse({
          items: [
            {
              question_id: NEXT,
              task_id: TASK,
              revision: 1,
              step: 'code',
              body: 'Which cache?',
              blocking: true,
              task_version: 5,
            },
          ],
          truncated: false,
        }),
      },
    }).state;
    const d = moved.dialog;
    if (d === null) throw new Error('the dialog closed');
    const explain = moved.actions?.explain.data ?? null;
    expect(questionView(d, explain).id).toBe(QUESTION);
    expect(questionView(d, explain).open).toBe(false);
    expect(dialogDue(d, explain, 8, 1_000_000)).toContain('question');
    expect(flat(text(moved))).not.toContain('Which cache?');

    const shown = run(moved, {
      type: 'dialog_read',
      taskId: TASK,
      session: d.session,
      askedAt: 40,
      at: 41,
      watermark: 8,
      part: 'question',
      result: {
        ok: true,
        value: QuestionShowSchema.parse({
          question_id: QUESTION,
          task_id: TASK,
          project: 'acme',
          status: 'answered',
          revision: 1,
          task_version: 5,
          body: 'Which database?',
          answer: 'MySQL',
          answered_by: 'owner',
        }),
      },
    });
    const screen = flat(text(shown.state));
    expect(screen).toContain('Which database?');
    expect(screen).toContain('Answered elsewhere by owner');
    expect(screen).toContain('MySQL');
    expect(screen).toContain('mine');
    expect(submits(run(shown.state, key('ctrl_s')).effects)).toHaveLength(0);
  });

  it('Answer stays on the question the task waited on when the inbox first shows another (EC-006)', () => {
    const waiting = explainOf({
      status: 'WAITING',
      wait: { reason: sanitize('question'), detail: { code: 'question', question_id: QUESTION } },
    });
    const opened = run(menu(OWNER, waiting), key('enter')).state;
    // The user types while the first inbox read is still on its way.
    const typed = run(opened, ...chars('mine')).state;
    const NEXT = '019a0000-0000-7000-8000-0000000000ad';
    // Meanwhile the question was answered elsewhere and the task asked the next one: the first read shows only it.
    const first = run(typed, {
      type: 'dialog_read',
      taskId: TASK,
      session: typed.dialog?.session ?? 0,
      askedAt: 20,
      at: 21,
      watermark: 8,
      part: 'inbox',
      result: {
        ok: true,
        value: InboxSchema.parse({
          items: [
            {
              question_id: NEXT,
              task_id: TASK,
              revision: 1,
              step: 'code',
              body: 'Which cache?',
              blocking: true,
              task_version: 5,
            },
          ],
          truncated: false,
        }),
      },
    }).state;
    const d = first.dialog;
    if (d === null) throw new Error('the dialog closed');
    const explain = first.actions?.explain.data ?? null;
    expect(questionView(d, explain).id).toBe(QUESTION);
    expect(questionView(d, explain).open).toBe(false);
    expect(dialogDue(d, explain, 8, 1_000_000)).toContain('question');
    expect(flat(text(first))).not.toContain('Which cache?');
    expect(submits(run(first, key('ctrl_s')).effects)).toHaveLength(0);

    const shown = run(first, {
      type: 'dialog_read',
      taskId: TASK,
      session: d.session,
      askedAt: 40,
      at: 41,
      watermark: 8,
      part: 'question',
      result: {
        ok: true,
        value: QuestionShowSchema.parse({
          question_id: QUESTION,
          task_id: TASK,
          project: 'acme',
          status: 'answered',
          revision: 1,
          task_version: 5,
          body: 'Which database?',
          answer: 'MySQL',
          answered_by: 'owner',
        }),
      },
    });
    const screen = flat(text(shown.state));
    expect(screen).toContain('Which database?');
    expect(screen).toContain('Answered elsewhere by owner');
    expect(screen).toContain('MySQL');
    expect(screen).toContain('mine');
    expect(screen).not.toContain('Which cache?');
  });

  it('a question with control characters does not change the screen (EC-001)', () => {
    const m = menu(OWNER, explainOf());
    const open = run(m, key('enter')).state;
    const hostile = InboxSchema.parse({
      items: [
        {
          question_id: QUESTION,
          task_id: TASK,
          revision: 1,
          step: null,
          body: 'Which?\x1b[2J\x1b]0;pwned\x07 ‮evil',
          blocking: true,
          task_version: 3,
        },
      ],
      truncated: false,
    });
    const shown = run(open, {
      type: 'dialog_read',
      taskId: TASK,
      session: open.dialog?.session ?? 0,
      askedAt: 1,
      at: 2,
      watermark: 7,
      part: 'inbox',
      result: { ok: true, value: hostile },
    }).state;
    const screen = text(shown);
    expect(screen).not.toContain('\x1b');
    expect(screen).not.toContain('\x07');
    expect(screen).not.toContain('‮');
    expect(screen).toContain('␛');
  });

  it('Cancel needs a reason, the exact word and Enter; nothing else sends (scenario 3)', () => {
    const m = menu(
      OWNER,
      explainOf(
        {
          pr: {
            ref: sanitize('acme#7'),
            head_sha: null,
            base_sha: null,
            observed: null,
            observation_expired: false,
          },
        },
        ['cancel'],
      ),
    );
    const open = run(m, key('enter')).state;
    expect(open.dialog?.kind).toBe('cancel');
    expect(open.dialog?.typed).toBe('');
    const screen = flat(text(open));
    expect(screen).toContain('acme#7');
    expect(screen).toContain('recorded as too late');
    expect(screen).toContain('not CANCELLED before');

    // Word first, reason empty.
    const noReason = run(open, key('tab'), ...chars('cancel'), key('enter'));
    expect(submits(noReason.effects)).toHaveLength(0);
    expect(text(noReason.state)).toContain('A reason is required');

    const typed = run(open, ...chars('stop'), key('tab'));
    // Ctrl-S, a wrong word, an empty box and a pasted word each leave the dialog as it was.
    for (const attempt of [
      [key('ctrl_s')],
      [key('enter')],
      [...chars('cance'), key('enter')],
      [{ type: 'key', key: { kind: 'paste', text: 'cancel' } } as Message, key('enter')],
      [...chars('CANCEL'), key('enter')],
    ]) {
      const r = run(typed.state, ...attempt);
      expect(submits(r.effects), JSON.stringify(attempt)).toHaveLength(0);
      expect(r.state.dialog?.field?.text).toBe('stop');
    }
    expect(text(run(typed.state, key('enter')).state)).toContain('type cancel exactly');

    const sent = run(typed.state, ...chars('cancel'), key('enter'));
    expect(sent.effects).toEqual([
      {
        type: 'submit',
        command: {
          kind: 'task_cancel',
          project: 'acme',
          task_id: TASK,
          expected_version: 3,
          payload: { reason: 'stop' },
        },
      },
    ]);
    // Esc leaves without sending.
    expect(run(typed.state, key('esc')).state.screens.at(-1)).toBe('actions');
  });

  it('shows stopping as the daemon reports it and DONE with "cancel arrived too late" after a merge (scenario 3)', () => {
    const stopping = menu(
      OWNER,
      explainOf({ cancellation: { requested_at: 5, late: false } }, ['cancel']),
    );
    expect(flat(text(stopping))).toContain('stopping and reconciling');
    expect(text(stopping)).not.toMatch(
      /Cancellation requested at [\d:]+; the daemon reports CANCELLED/,
    );
    const merged = menu(
      OWNER,
      explainOf({ status: 'DONE', cancellation: { requested_at: 5, late: true } }, ['task_add']),
    );
    const screen = flat(text(merged));
    expect(screen).toContain('DONE — cancel arrived too late');
    expect(screen).toContain('This task has ended');
    expect(screen).not.toContain('Cancelled');
  });

  it('Recheck: Ctrl-S for a plain one; worktree_changed shows the path and goes after accept (scenario 4)', () => {
    const plain = run(menu(OWNER, explainOf({}, ['recheck'])), key('enter'));
    expect(plain.state.dialog?.worktree).toBe(false);
    expect(plain.state.dialog?.focus).toBe('none');
    expect(submits(run(plain.state, key('enter')).effects)).toHaveLength(0);
    expect(run(plain.state, key('ctrl_s')).effects).toEqual([
      {
        type: 'submit',
        command: {
          kind: 'task_recheck',
          project: 'acme',
          task_id: TASK,
          expected_version: 3,
          payload: {},
        },
      },
    ]);

    const wt = explainOf(
      { wait: { reason: sanitize('policy'), detail: { code: 'worktree_changed' } } },
      ['recheck'],
    );
    const open = run(menu(OWNER, wt), key('enter')).state;
    expect(open.dialog?.worktree).toBe(true);
    const withPath = run(open, {
      type: 'dialog_read',
      taskId: TASK,
      session: open.dialog?.session ?? 0,
      askedAt: 1,
      at: 2,
      watermark: 7,
      part: 'progress',
      result: { ok: true, value: { worktree_path: sanitize('/srv/acme.wt/t1') } as never },
    }).state;
    const screen = flat(text(withPath));
    expect(screen).toContain('Worktree: /srv/acme.wt/t1');
    expect(screen).toContain('cannot show you what changed');
    expect(submits(run(withPath, key('ctrl_s'), key('enter')).effects)).toHaveLength(0);
    expect(submits(run(withPath, ...chars('accep'), key('enter')).effects)).toHaveLength(0);
    expect(submits(run(withPath, ...chars('accept'), key('enter')).effects)).toHaveLength(1);
  });

  it('Recheck of worktree_changed is not sent while the worktree location is unread or unknown (scenario 4)', () => {
    const wt = explainOf(
      { wait: { reason: sanitize('policy'), detail: { code: 'worktree_changed' } } },
      ['recheck'],
    );
    const open = run(menu(OWNER, wt), key('enter')).state;
    const accept = [...chars('accept'), key('enter')];
    const reading = run(open, ...accept);
    expect(submits(reading.effects)).toHaveLength(0);
    expect(text(reading.state)).toContain('worktree location has not been read yet');
    const progress = (value: unknown): Message => ({
      type: 'dialog_read',
      taskId: TASK,
      session: open.dialog?.session ?? 0,
      askedAt: 1,
      at: 2,
      watermark: 7,
      part: 'progress',
      result: { ok: true, value: value as never },
    });
    const unknown = run(open, progress({ worktree_path: null }));
    expect(submits(run(unknown.state, ...accept).effects)).toHaveLength(0);
    expect(text(run(unknown.state, ...accept).state)).toContain('gave no worktree location');
    const failed = run(open, {
      type: 'dialog_read',
      taskId: TASK,
      session: open.dialog?.session ?? 0,
      askedAt: 1,
      at: 2,
      watermark: 7,
      part: 'progress',
      result: { ok: false, error: { kind: 'connection', message: sanitize('gone') } },
    });
    expect(submits(run(failed.state, ...accept).effects)).toHaveLength(0);
    const known = run(open, progress({ worktree_path: sanitize('/srv/wt') }));
    expect(submits(run(known.state, ...accept).effects)).toHaveLength(1);
  });

  it('a version conflict on Answer is not taken for a closed question, and an open question clears the doubt (scenario 7)', () => {
    const opened = run(menu(OWNER, explainOf()), key('enter')).state;
    const loaded = run(opened, inboxMessage(opened)).state;
    const sent = run(loaded, ...chars('mine'), key('ctrl_s'));
    const command = sentCommand(sent.effects);
    const rejected = (message: string): Message => ({
      type: 'mutation_changed',
      mutation: {
        requestId: '019a0000-0000-7000-8000-0000000000ee',
        command,
        state: 'rejected',
        result: { ok: false, code: 'conflict', message },
        checks: 0,
        resends: 0,
      },
    });
    const stale = run(sent.state, rejected('stale_version'));
    expect(stale.state.dialog?.elsewhere).toBe(false);
    expect(stale.effects).toEqual([]);
    expect(text(stale.state)).toContain('the task changed since this dialog opened');
    expect(text(stale.state)).not.toContain('already answered or withdrawn');
    expect(stale.state.dialog?.field?.text).toBe('mine');

    // The question closed elsewhere and the daemon says it is still open: the doubt goes.
    const doubt = run(sent.state, rejected('already_answered'));
    expect(doubt.state.dialog?.elsewhere).toBe(true);
    const open = run(doubt.state, {
      type: 'dialog_read',
      taskId: TASK,
      session: doubt.state.dialog?.session ?? 0,
      askedAt: 5,
      at: 6,
      watermark: 8,
      part: 'question',
      result: {
        ok: true,
        value: QuestionShowSchema.parse({
          question_id: QUESTION,
          task_id: TASK,
          project: 'acme',
          status: 'open',
          revision: 1,
          task_version: 4,
        }),
      },
    });
    expect(open.state.dialog?.elsewhere).toBe(false);
  });

  it('Approve names step, rung, reason and limits, and goes after the word (scenario 5)', () => {
    const e = explainOf(
      {
        wait: {
          reason: sanitize('escalation needs approval'),
          detail: { code: 'escalation', step: 'code', rung: 1 },
        },
      },
      ['approve'],
    );
    const open = run(menu(OWNER, e), key('enter')).state;
    expect(open.dialog?.kind).toBe('approve');
    const screen = flat(text(open));
    expect(screen).toContain('Step: code · rung 1');
    expect(screen).toContain('Why: escalation needs approval');
    expect(screen).toContain('Left: 1 escalation(s), 4 agent run(s)');
    expect(screen).toContain('Needs the operate role. You have: read, operate, admin');
    expect(screen).toContain('opens no run beyond the limits');
    expect(
      submits(run(open, key('ctrl_s'), ...chars('approv'), key('enter')).effects),
    ).toHaveLength(0);
    expect(run(open, ...chars('approve'), key('enter')).effects).toEqual([
      {
        type: 'submit',
        command: {
          kind: 'approve_escalation',
          project: 'acme',
          task_id: TASK,
          expected_version: 3,
          payload: { step: 'code', rung: 1 },
        },
      },
    ]);
  });

  it('Approve of an adoption names the pull request and its head, and sends approve_adopt after the word', () => {
    const SHA = 'a'.repeat(40);
    const adopt = (detail: Record<string, unknown>) =>
      explainOf(
        {
          wait: { reason: sanitize('adopt the PR'), detail: { code: 'adopt_approval', ...detail } },
        },
        ['approve'],
      );
    const open = run(
      menu(OWNER, adopt({ pr_ref: 'acme/repo#7', head_sha: SHA })),
      key('enter'),
    ).state;
    const screen = flat(text(open));
    expect(screen).toContain('Approve adopting the pull request');
    expect(screen).toContain('Pull request: acme/repo#7');
    expect(screen).toContain(`Head: ${SHA}`);
    expect(screen).toContain('Needs the admin role');
    expect(submits(run(open, key('ctrl_s'), key('enter')).effects)).toHaveLength(0);
    expect(run(open, ...chars('approve'), key('enter')).effects).toEqual([
      {
        type: 'submit',
        command: {
          kind: 'approve_adopt',
          project: 'acme',
          task_id: TASK,
          expected_version: 3,
          payload: { head_sha: SHA },
        },
      },
    ]);

    // No head read yet: nothing to approve here, and the screen says where to go.
    const unread = run(menu(OWNER, adopt({ pr_ref: 'acme/repo#7' })), key('enter')).state;
    expect(flat(text(unread))).toContain('Head: not read by the daemon yet');
    const tried = run(unread, ...chars('approve'), key('enter'));
    expect(submits(tried.effects)).toHaveLength(0);
    expect(flat(text(tried.state))).toContain('has not read the pull request head yet');

    // Adopting needs admin: an operate token sees the entry dimmed and Enter opens nothing.
    const refused = run(
      menu(ASSISTANT, adopt({ pr_ref: 'acme/repo#7', head_sha: SHA })),
      key('enter'),
    );
    expect(refused.state.dialog).toBeNull();
    expect(refused.state.actions?.notice).toContain('needs the admin role');
  });

  it('keeps the dialog while the write is on its way: Esc does nothing until the daemon answers', () => {
    const open = run(menu(OWNER, explainOf({}, ['cancel'])), key('enter')).state;
    const sent = run(open, ...chars('why'), key('tab'), ...chars('cancel'), key('enter'));
    const command = sentCommand(sent.effects);
    const pressed = run(sent.state, key('esc'), key('esc'), ...chars('x'));
    expect(pressed.state.screens.at(-1)).toBe('dialog');
    expect(pressed.state.dialog?.field?.text).toBe('why');
    expect(submits(pressed.effects)).toHaveLength(0);
    const refused = run(pressed.state, {
      type: 'mutation_changed',
      mutation: {
        requestId: '019a0000-0000-7000-8000-0000000000dd',
        command,
        state: 'rejected',
        result: { ok: false, code: 'invalid_trigger', message: 'nope' },
        checks: 0,
        resends: 0,
      },
    }).state;
    expect(refused.dialog?.field?.text).toBe('why');
    expect(flat(text(refused))).toContain('The daemon refused it (invalid_trigger: nope)');
    expect(run(refused, key('esc')).state.screens.at(-1)).toBe('actions');
  });

  it('Ctrl-C while a write is on its way still quits, and stderr keeps the draft with the request ID', () => {
    const open = run(menu(OWNER, explainOf({}, ['cancel'])), key('enter')).state;
    const sent = run(
      open,
      ...chars('line one'),
      key('enter'),
      ...chars('two'),
      key('tab'),
      ...chars('cancel'),
      key('enter'),
    );
    const command = sentCommand(sent.effects);
    const quit = run(sent.state, key('ctrl_c'));
    expect(quit.effects).toContainEqual({ type: 'quit', code: 0 });
    const mutation = {
      requestId: '019a0000-0000-7000-8000-0000000000ee',
      command,
      state: 'sending' as const,
      result: null,
      checks: 0,
      resends: 0,
    };
    const notice = exitNotice(quit.state, [mutation]) ?? '';
    expect(notice).toContain('request ID: 019a0000-0000-7000-8000-0000000000ee');
    expect(notice).toContain(`what you typed in task_cancel on task ${TASK}`);
    expect(notice).toContain('  line one\n  two\n');
    // Nothing typed, or nothing on its way: no draft to keep.
    expect(exitNotice(open, [])).toBeNull();
  });

  it('opens only what the caller may take, at each of three levels (scenario 6, SC-007)', () => {
    const actions = ['answer', 'cancel', 'recheck', 'approve'];
    const opens = (caller: CallerInfo, action: string): string => {
      const m = menu(caller, explainOf({}, [action]));
      const r = run(m, key('enter'));
      return r.state.screens.at(-1) === 'dialog' ? 'dialog' : (r.state.actions?.notice ?? '');
    };
    for (const a of actions) expect(opens(OWNER, a), `owner ${a}`).toBe('dialog');
    for (const a of actions) expect(opens(ASSISTANT, a), `assistant ${a}`).toBe('dialog');
    // The read level end to end through the daemon waits for a read-only actor (issue #207).
    for (const a of actions) expect(opens(VIEWER, a), `viewer ${a}`).toContain('needs the');
  });

  it('a daemon conflict for a stale version is shown as one and nothing is sent again (scenario 7)', () => {
    const open = run(menu(OWNER, explainOf({}, ['cancel'])), key('enter')).state;
    const sent = run(open, ...chars('why'), key('tab'), ...chars('cancel'), key('enter'));
    const command = sentCommand(sent.effects);
    const refused = run(sent.state, {
      type: 'mutation_changed',
      mutation: {
        requestId: '019a0000-0000-7000-8000-0000000000cc',
        command,
        state: 'rejected',
        result: { ok: false, code: 'conflict', message: 'stale_version' },
        checks: 0,
        resends: 0,
      },
    });
    expect(submits(refused.effects)).toHaveLength(0);
    expect(refused.state.dialog?.error).not.toBeNull();
    expect(flat(text(refused.state))).toContain('the task changed since this dialog opened');
    // Leaving shows the menu with the conflict, as the daemon gave it.
    const back = run(refused.state, key('esc')).state;
    expect(flat(text(back))).toContain('Conflict: the daemon refused it');
  });

  it('keeps what was typed when the data goes stale, and sends nothing (scenario 10)', () => {
    const opened = run(menu(OWNER, explainOf()), key('enter')).state;
    const open = run(opened, inboxMessage(opened)).state;
    const typed = run(open, ...chars('draft'));
    const stale = run(typed.state, {
      type: 'read_failed',
      failure: { ok: false, permanent: null },
    });
    const tried = run(stale.state, key('ctrl_s'));
    expect(submits(tried.effects)).toHaveLength(0);
    expect(text(tried.state)).toContain('may be out of date');
    expect(tried.state.dialog?.field?.text).toBe('draft');
  });
});

describe('a dialog on a small terminal (FR-035)', () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a long text`).join('\n');
  const small = (s: TuiState): TuiState => ({ ...s, size: { cols: 80, rows: 24 } });

  it('keeps the field, the confirmation box and the error in view, and scrolls the text above', () => {
    const open0 = run(small(menu(OWNER, explainOf({}, ['answer']))), key('enter')).state;
    const open = run(open0, inboxMessage(open0, long), ...chars('my text')).state;
    const first = text(open);
    expect(first).toContain('line 1 of');
    expect(first).toContain('my text');
    expect(first).toContain('PgUp/PgDn scroll');
    expect(first.split('\n').length).toBe(24);
    const end = run(open, ...Array.from({ length: 30 }, () => key('pagedown'))).state;
    const last = text(end);
    expect(last).toContain('line 40 of');
    expect(last).toContain('my text');
    // Scrolling never touches what was typed.
    expect(end.dialog?.field?.text).toBe('my text');

    const cancelState = small(menu(OWNER, explainOf({}, ['cancel'])));
    const cancel = run(cancelState, key('enter'), key('tab'), key('enter')).state;
    const screen = text(cancel);
    expect(screen).toContain('Type cancel, then press Enter');
    expect(screen).toContain('type cancel exactly');
  });

  it('shows the whole of an answer given elsewhere, by scrolling', () => {
    const open0 = run(small(menu(OWNER, explainOf({}, ['answer']))), key('enter')).state;
    const open = run(open0, inboxMessage(open0)).state;
    const shown = run(open, {
      type: 'dialog_read',
      taskId: TASK,
      session: open.dialog?.session ?? 0,
      askedAt: 40,
      at: 41,
      watermark: 8,
      part: 'question',
      result: {
        ok: true,
        value: QuestionShowSchema.parse({
          question_id: QUESTION,
          task_id: TASK,
          project: 'acme',
          status: 'answered',
          revision: 1,
          task_version: 4,
          body: 'Which database?',
          answer: long,
          answered_by: 'owner',
        }),
      },
    }).state;
    expect(text(shown)).not.toContain('line 40 of');
    const end = run(shown, ...Array.from({ length: 30 }, () => key('pagedown'))).state;
    expect(text(end)).toContain('line 40 of');
    expect(text(end)).not.toContain('more rows');
  });
});

describe('the dialog is a screen of the stack', () => {
  it('opens over the menu and Esc comes back to it', () => {
    const open = run(menu(OWNER, explainOf()), key('enter')).state;
    expect(open.screens).toEqual(['home', 'actions', 'dialog']);
    expect(openDialog).toBeTypeOf('function');
    const back = run(open, key('esc')).state;
    expect(back.screens).toEqual(['home', 'actions']);
    expect(back.dialog).toBeNull();
  });
});
