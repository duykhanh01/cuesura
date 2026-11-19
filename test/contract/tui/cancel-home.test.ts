import { describe, expect, it } from 'vitest';
import { initialDetail } from '../../../src/tui/model/detail.ts';
import { initialLogs } from '../../../src/tui/model/logs.ts';
import { uiText } from '../../../src/tui/terminal/safe-text.ts';
import type { Mutation } from '../../../src/tui/client/mutations.ts';
import type { TuiState } from '../../../src/tui/model/state.ts';
import {
  OWNER,
  TASK,
  chars,
  explainOf,
  key,
  menu,
  run,
  sentCommand,
  text,
} from '../../support/tui-dialogs.ts';

// A cancel that took effect leaves the task for Home; one that needs the menu, or was refused, stays.
function sentCancel(): { state: TuiState; command: Mutation['command'] } {
  const open = run(menu(OWNER, explainOf({}, ['cancel'])), key('enter')).state;
  const sent = run(open, ...chars('why'), key('tab'), ...chars('Y'));
  const withTask: TuiState = {
    ...sent.state,
    screens: ['home', 'logs', 'actions', 'dialog'],
    detail: initialDetail(TASK, uiText('T'), 1),
    logs: initialLogs(TASK, uiText('T'), 2),
  };
  return { state: withTask, command: sentCommand(sent.effects) };
}

const answer = (state: TuiState, command: Mutation['command'], over: Partial<Mutation>): TuiState =>
  run(state, {
    type: 'mutation_changed',
    mutation: {
      requestId: '019a0000-0000-7000-8000-0000000000dd',
      command,
      state: 'accepted',
      result: { ok: true, value: { status: 'CANCELLED' } },
      checks: 0,
      resends: 0,
      ...over,
    },
  }).state;

describe('after a cancel', () => {
  it.each([
    ['the daemon says CANCELLED', { status: 'CANCELLED' }],
    ['it is accepted and stopping', { status: 'RUNNING' }],
    ['a force cancel is recorded', { status: 'WAITING', force_ignored: null }],
  ])('goes Home when %s', (_, value) => {
    const { state, command } = sentCancel();
    const after = answer(state, command, { result: { ok: true, value } });
    expect(after.screens).toEqual(['home']);
    expect(after.dialog).toBeNull();
    expect(after.actions).toBeNull();
    expect(after.logs).toBeNull();
    expect(after.detail).toBeNull();
  });

  it.each([
    ['the PR was already merged', { status: 'DONE' }],
    ['a merge was seen', { status: 'WAITING', force_ignored: 'merge_seen' }],
    ['it was already requested', { status: 'WAITING', ignored: 'already_cancelling' }],
    ['the PR could not be read', { status: 'WAITING', pr_read: { unavailable: 'down' } }],
  ])('stays on the menu, which says why, when %s', (_, value) => {
    const { state, command } = sentCancel();
    const after = answer(state, command, { result: { ok: true, value } });
    expect(after.screens).toEqual(['home', 'logs', 'actions']);
    expect(after.actions).not.toBeNull();
  });

  it('stays in the dialog when the daemon refuses, and Esc goes back one step, not Home', () => {
    const { state, command } = sentCancel();
    const refused = answer(state, command, {
      state: 'rejected',
      result: { ok: false, code: 'invalid_trigger', message: 'nope' },
    });
    expect(refused.screens.at(-1)).toBe('dialog');
    expect(run(refused, key('esc')).state.screens).toEqual(['home', 'logs', 'actions']);
  });

  it('stays where it is while the result is unknown', () => {
    const { state, command } = sentCancel();
    const after = answer(state, command, { state: 'unknown', result: null });
    expect(after.screens).toEqual(['home', 'logs', 'actions']);
  });
});

describe('Progress sidebar', () => {
  it('shows the key that opens the attempt chooser', () => {
    const base = menu(OWNER, explainOf({}, ['cancel']));
    const logs: TuiState = {
      ...base,
      screens: ['home', 'logs'],
      actions: null,
      detail: initialDetail(TASK, uiText('T'), 1),
      logs: initialLogs(TASK, uiText('T'), 2),
    };
    expect(text(logs)).toMatch(/^.*\bt attempts\b/m);
  });
});
