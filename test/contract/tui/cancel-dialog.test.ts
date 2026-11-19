import { describe, expect, it } from 'vitest';
import type { Mutation } from '../../../src/tui/client/mutations.ts';
import { todo } from '../../../src/tui/model/activity.ts';
import { mutationLine } from '../../../src/tui/views/actions.ts';
import { sanitize } from '../../../src/tui/terminal/safe-text.ts';
import { authz, buildTask, uuidOf } from '../../support/builders.ts';
import { KEY } from '../../support/pty.ts';
import {
  OWNER,
  TASK,
  chars,
  explainOf,
  key,
  menu,
  run,
  sentCommand,
  submits,
  text,
} from '../../support/tui-dialogs.ts';
import {
  cliJson,
  daemonSocket,
  flat,
  openMenuOf,
  pressAction,
  seedGreenPr,
  useTui,
} from '../../support/tui-fixtures.ts';
import { COMMAND_TIMEOUT_MS } from '../../../src/tui/client/mutations.ts';
import { storeDb } from '../../../src/store/testing.ts';

// Cancel from the TUI: the reason goes on with Enter, one plain question asks for Y, and a cancel stuck on
// a PR that cannot be read (`cancel_reconcile`) is ended with `force` instead of a cancel that is ignored.
const tui = useTui();

const READS = 446;
const RECONCILING = {
  pr: {
    ref: sanitize('acme#7'),
    head_sha: null,
    base_sha: null,
    observed: null,
    observation_expired: false,
  },
  cancellation: { requested_at: 5, late: false },
  wait: {
    reason: sanitize('policy'),
    detail: { code: 'cancel_reconcile', cancel_reads: READS },
    resume_when: [],
    exit_paths: [],
  },
};

const accepted = (value: unknown): Mutation => ({
  requestId: 'r1',
  command: {
    kind: 'task_cancel',
    project: 'acme',
    task_id: TASK,
    expected_version: 3,
    payload: { reason: 'x' },
  },
  state: 'accepted',
  // The handler's value, as the tracker keeps it from a direct reply and from `request_show` alike.
  result: { ok: true, value },
  checks: 0,
  resends: 0,
});

describe('Cancel dialog below the PTY', () => {
  it('Enter on a written reason goes to the one question; it never adds a line', () => {
    const open = run(menu(OWNER, explainOf({}, ['cancel'])), key('enter')).state;
    expect(open.dialog?.kind).toBe('cancel');
    expect(flat(text(open))).toContain('Then: press Enter, and Y to cancel the task.');

    // With no reason neither Enter nor Tab goes on to the question.
    for (const k of ['enter', 'tab', 'shift_tab'] as const) {
      const empty = run(open, key(k));
      expect(empty.state.dialog?.focus, k).toBe('text');
      expect(text(empty.state), k).toContain('A reason is required');
      expect(flat(text(empty.state)), k).not.toContain('Cancel this task now?');
    }

    const typed = run(open, ...chars('no longer needed'), key('enter'));
    expect(typed.state.dialog?.field?.text).toBe('no longer needed');
    expect(typed.state.dialog?.focus).toBe('confirm');
    expect(submits(typed.effects)).toHaveLength(0);
    const screen = flat(text(typed.state));
    expect(screen).toContain('Cancel this task now?');
    expect(screen).toContain('Y = yes, cancel it');
    expect(screen).toContain('N or Esc = no, go back (nothing is sent)');

    // Enter again does not send: only Y does.
    const again = run(typed.state, key('enter'));
    expect(submits(again.effects)).toHaveLength(0);
    expect(flat(text(again.state))).toContain(
      'Nothing was sent: press Y to cancel the task, or N to go back.',
    );
    expect(sentCommand(run(typed.state, ...chars('y')).effects).payload).toEqual({
      reason: 'no longer needed',
    });
  });

  it('a cancel waiting on an unreadable PR is offered as Force cancel, warns, and sends force', () => {
    const m = menu(OWNER, explainOf(RECONCILING, ['recheck', 'cancel']));
    expect(text(m)).toContain('Force cancel (PR unread)');
    const open = run(m, key('down'), key('enter')).state;
    expect(open.dialog?.force).toBe(true);
    const screen = flat(text(open));
    expect(screen).toContain('Force cancel task');
    expect(screen).toContain(`(${READS} read(s) failed)`);
    expect(screen).toContain('Cancelling again does not change that');
    expect(screen).toContain('ends CANCELLED without that read');
    expect(screen).toContain('Nothing on GitHub is changed');

    const typed = run(open, ...chars('repo is gone'), key('enter')).state;
    expect(flat(text(typed))).toContain(
      'Force-cancel this task now, even if the pull request cannot be read?',
    );
    expect(sentCommand(run(typed, ...chars('Y')).effects)).toEqual({
      kind: 'task_cancel',
      project: 'acme',
      task_id: TASK,
      expected_version: 3,
      payload: { reason: 'repo is gone', force: true },
    });
  });

  it('says what the accepted cancel did, from the daemon reply', () => {
    const line = (v: unknown): string => mutationLine(accepted(v))?.text ?? '';
    expect(line({ status: 'WAITING', ignored: 'already_cancelling', pr_read: null })).toContain(
      'Nothing changed: a cancel was already requested and is still waiting',
    );
    expect(
      line({ status: 'WAITING', ignored: null, pr_read: { unavailable: 'HTTP 404' } }),
    ).toContain('the PR could not be read: HTTP 404');
    expect(
      line({
        status: 'WAITING',
        ignored: null,
        pr_read: { unavailable: null, facts: [{ kind: 'cancel_read_failed', accepted: true }] },
      }),
    ).toContain('The task waits until a read shows it open or closed');
    expect(
      line({ status: 'CANCELLED', force_ignored: null, warning: 'the PR may be unread' }),
    ).toContain('Cancelled: the daemon reports the task CANCELLED');
    expect(line({ status: 'WAITING', force_ignored: 'merge_seen' })).toContain('Not cancelled');
  });

  it('a plain cancel that met a merge says it is not cancelled, and DONE once the merge is confirmed', () => {
    const line = (v: unknown): string => mutationLine(accepted(v))?.text ?? '';
    const waiting = { status: 'WAITING', ignored: null, completion: null, blockers: [] };
    const seen = line({ ...waiting, cancellation: { merge_seen: 'obs-1' } });
    expect(seen).toContain('Not cancelled: a merge of the PR was seen and decides');
    expect(seen).not.toContain('Cancel accepted');
    expect(
      line({ ...waiting, cancellation: {}, blockers: [{ code: 'merge_evidence_incomplete' }] }),
    ).toContain('Not cancelled: a merge of the PR was seen and decides');
    expect(line({ ...waiting, completion: { proof: {} } })).toContain(
      'Not cancelled: the PR merge is confirmed, so the task ends DONE',
    );
    expect(line({ ...waiting, status: 'DONE' })).toContain('DONE: the PR was already merged');
  });

  it('Needs you of a cancel waiting on its PR read promises no Force cancel, which a merge seen withdraws', () => {
    const words = todo({
      status: 'WAITING',
      wait_code: 'cancel_reconcile',
      step: null,
      mode: null,
      needs_user: true,
    });
    expect(words).toBe('Open Actions: recheck, or force cancel when it is offered');
  });

  it('shows what the daemon says the cancel does, such as dependents it cancels, before Y', () => {
    const cascade =
      'Only if the user asks: reads the PR once more. Ending CANCELLED also cancels 2 dependent tasks listed under dependents; check them with the user first.';
    const explain = explainOf(
      {
        ...RECONCILING,
        allowed_actions: [
          { action: 'cancel', command: sanitize('cusr x'), note: sanitize(cascade) },
        ],
      },
      [],
    );
    const open = run(menu(OWNER, explain), key('enter')).state;
    const asked = run(open, ...chars('why'), key('enter')).state;
    const screen = flat(text(asked));
    expect(screen).toContain('also cancels 2 dependent tasks');
    expect(screen).toContain('Force-cancel this task now');
    expect(screen).toContain('The reason below is recorded with the force');
  });
});

describe('Cancel on a PTY against a real daemon', () => {
  it('a paused task stuck cancelling on an unreadable PR ends CANCELLED by Force cancel from the TUI', async () => {
    // The read the cancel makes gives no observation, as a PR GitHub answers 404 for.
    const sd = tui.daemon({ recheck: { observed: () => {} } });
    const t = buildTask({ id: uuidOf(1), title: 'Stuck cancel' });
    sd.seed((d) => {
      seedGreenPr(d, sd, t, 'full-review', { title: 'T', message: 'M' });
      d.must(t.id, { kind: 'pause', reason: 'look later' }, { authz: authz(['operate'], 'owner') });
      d.must(t.id, { kind: 'cancel', reason: 'first try' });
      expect(d.task(t.id).wait?.detail.code).toBe('cancel_reconcile');
    });
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await openMenuOf(s, 'Stuck cancel');
    await s.waitForText('Force cancel (PR unread)');
    expect(flat(s.screenText())).not.toContain('› Cancel task');

    await pressAction(s, 'Force cancel (PR unread)');
    await s.waitForText('What force cancelling does');
    s.send('repo is gone');
    s.send(KEY.enter);
    await s.waitForText('Force-cancel this task now');
    expect(flat(s.screenText())).toContain('Y N confirm / go back');
    expect(flat(s.screenText())).not.toContain('cancel / leave');
    s.send('Y');
    // The force took effect: Home, not the menu.
    await s.waitForText('n new task');
    const e = await sd.query('owner', { kind: 'task_explain', task_id: t.id });
    expect(e.envelope.data?.['status']).toBe('CANCELLED');
    const h = await sd.query('owner', { kind: 'task_history', task_id: t.id });
    const events = h.envelope.data?.['events'] as { type: string; payload: unknown }[];
    // The force keeps its own reason; the cancel ends with the reason it was requested with.
    expect(events.find((x) => x.type === 'CancelForced')?.payload).toMatchObject({
      reason: 'repo is gone',
    });
    expect(e.envelope.data?.['terminal']).toMatchObject({ reason: 'first try' });
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  }, 60_000);

  it('a Force cancel whose reply is lost shows the CANCELLED the daemon stored, found by request_show', async () => {
    const sd = tui.daemon({ recheck: { observed: () => {} } });
    const t = buildTask({ id: uuidOf(1), title: 'Stuck cancel' });
    sd.seed((d) => {
      seedGreenPr(d, sd, t, 'full-review', { title: 'T', message: 'M' });
      d.must(t.id, { kind: 'cancel', reason: 'first try' });
    });
    await sd.start();
    const proxy = await tui.proxy(daemonSocket(sd));
    const s = tui.cusr(proxy.dataDir);
    await openMenuOf(s, 'Stuck cancel');
    await pressAction(s, 'Force cancel (PR unread)');
    await s.waitForText('What force cancelling does');
    s.send('repo is gone');
    s.send(KEY.enter);
    await s.waitForText('Force-cancel this task now');
    proxy.mode = 'drop_response';
    s.send('Y');
    await s.waitFor(
      () => flat(s.screenText()).includes('Result unknown - checking'),
      COMMAND_TIMEOUT_MS + 5_000,
    );
    proxy.mode = 'forward';
    // Found accepted while the menu is still on top: Home, as for a reply that was not lost.
    await s.waitForText('n new task');
    expect(flat(s.screenText())).not.toContain('Cancel accepted by the daemon');
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  }, 60_000);

  it('a reason that carries a secret is stored and shown masked, for the cancel and for its force', async () => {
    const sd = tui.daemon({ recheck: { observed: () => {} } });
    const t = buildTask({ id: uuidOf(1), title: 'Stuck cancel' });
    sd.seed((d) => seedGreenPr(d, sd, t, 'full-review', { title: 'T', message: 'M' }));
    await sd.start();
    const first = `pasted ghp_${'a'.repeat(36)} by mistake`;
    const forced = `the repo is gone, token ghp_${'b'.repeat(36)}`;
    const version = (): string => String(sd.daemon?.store.readTask(t.id)?.version ?? 0);
    const cancel = await cliJson(
      sd,
      'task',
      'cancel',
      t.id,
      '--project',
      'acme',
      '--expected-version',
      version(),
      '--reason',
      first,
    );
    expect(cancel.code).toBe(0);
    expect(sd.daemon?.store.readTask(t.id)?.wait?.detail.code).toBe('cancel_reconcile');
    const force = await cliJson(
      sd,
      'task',
      'cancel',
      t.id,
      '--project',
      'acme',
      '--force',
      '--expected-version',
      version(),
      '--reason',
      forced,
    );
    expect(force.code).toBe(0);
    expect(sd.daemon?.store.readTask(t.id)?.status).toBe('CANCELLED');

    const db = storeDb(sd.daemon?.store as NonNullable<typeof sd.daemon>['store']);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const table of tables) {
      const rows = JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all());
      expect(rows, table).not.toContain('ghp_');
    }
    const h = await sd.query('owner', { kind: 'task_history', task_id: t.id });
    const history = JSON.stringify(h.envelope.data);
    expect(history).not.toContain('ghp_');
    const events = h.envelope.data?.['events'] as { type: string; payload: unknown }[];
    expect(events.find((e) => e.type === 'CancelRequested')?.payload).toMatchObject({
      reason: 'pasted [REDACTED] by mistake',
    });
    expect(events.find((e) => e.type === 'CancelForced')?.payload).toMatchObject({
      reason: 'the repo is gone, token [REDACTED]',
    });
  }, 60_000);

  it('at 80×24, unscrolled, the dependents a cancel also cancels are in view next to the Y question', async () => {
    const sd = tui.daemon({ recheck: { observed: () => {} } });
    const t = buildTask({ id: uuidOf(1), title: 'Stuck cancel' });
    const child = buildTask({ id: uuidOf(2), title: 'Dependent', depends_on: [t.id] });
    sd.seed((d) => {
      seedGreenPr(d, sd, t, 'full-review', { title: 'T', message: 'M' });
      d.must(child.id, { kind: 'create_task', task: child });
      d.must(t.id, { kind: 'cancel', reason: 'first try' });
    });
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 80, rows: 24 });
    await openMenuOf(s, 'Stuck cancel');
    await pressAction(s, 'Force cancel (PR unread)');
    await s.waitForText('Force cancel task');
    s.send('repo is gone');
    s.send(KEY.enter);
    await s.waitForText('Force-cancel this task now');
    const screen = flat(s.screenText());
    expect(screen).toContain('also cancels 1 dependent task');
    // The text above overflows and is not scrolled: its first page is on screen.
    expect(screen).toContain('A cancel was requested');
    expect(screen).toContain('PgUp/PgDn scroll (1/');
    expect(screen).toContain('Y = yes, force-cancel it');
    s.send('n');
    await s.waitForText('Actions — ');
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  }, 60_000);
});
