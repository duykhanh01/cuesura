import { describe, expect, it } from 'vitest';
import type { Mutation } from '../../../src/tui/client/mutations.ts';
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
import { flat, openMenuOf, pressAction, seedGreenPr, useTui } from '../../support/tui-fixtures.ts';

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
  result: { ok: true, value: { request_id: 'r1', replayed: false, result: value } },
  checks: 0,
  resends: 0,
});

describe('Cancel dialog below the PTY', () => {
  it('Enter on a written reason goes to the one question; it never adds a line', () => {
    const open = run(menu(OWNER, explainOf({}, ['cancel'])), key('enter')).state;
    expect(open.dialog?.kind).toBe('cancel');
    expect(flat(text(open))).toContain('Then: press Enter, and Y to cancel the task.');

    const empty = run(open, key('enter'));
    expect(empty.state.dialog?.focus).toBe('text');
    expect(text(empty.state)).toContain('A reason is required');

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
    ).toContain('Force cancel (PR unread) ends it without that read');
    expect(
      line({ status: 'CANCELLED', force_ignored: null, warning: 'the PR may be unread' }),
    ).toContain('Cancelled: the daemon reports the task CANCELLED');
    expect(line({ status: 'WAITING', force_ignored: 'merge_seen' })).toContain('Not cancelled');
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
    s.send('Y');
    await s.waitFor(
      () => flat(s.screenText()).includes('Cancelled: the daemon reports the task CANCELLED'),
      15_000,
    );
    const e = await sd.query('owner', { kind: 'task_explain', task_id: t.id });
    expect(e.envelope.data?.['status']).toBe('CANCELLED');
    const h = await sd.query('owner', { kind: 'task_history', task_id: t.id });
    const types = (h.envelope.data?.['events'] as { type: string }[]).map((x) => x.type);
    expect(types).toContain('CancelForced');
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  }, 60_000);
});
