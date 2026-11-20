import { describe, expect, it } from 'vitest';
import { uuidOf } from '../../support/builders.ts';
import type { ControlProxy } from '../../support/control-proxy.ts';
import type { SeededDaemon } from '../../support/daemon-task.ts';
import { KEY, type PtySession } from '../../support/pty.ts';
import { daemonSocket, flat, openMenuOf, pressAction, useTui } from '../../support/tui-fixtures.ts';
import { join } from 'node:path';
import { startTask } from '../../../src/application/start.ts';
import { MAX_CONCURRENCY } from '../../../src/config/schema-user.ts';
import { STORE_FILE } from '../../../src/daemon/main.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import {
  fakeGit,
  fakeGitHub,
  fakeHost,
  MANIFESTS,
  userConfig,
} from '../../support/preflight-fakes.ts';
import { StoreDriver } from '../../support/store-driver.ts';

const subsets = <T>(xs: readonly T[]): T[][] =>
  xs.reduce<T[][]>((all, x) => [...all, ...all.map((a) => [...a, x])], [[]]);

// T067: the Review screen on a PTY against a real daemon (US5 scenarios 3–8 and 11, FR-026–FR-028). What is
// confirmed is the scope of data-model.md "Phạm vi xác nhận", sent with the version and digest on screen.
const tui = useTui();

const RUNTIME =
  'runtime:\n  modes:\n    direct-pr: { when_to_use: "small, low risk" }\n    full-review: { when_to_use: "needs a second pair of eyes" }';
const WORKER = { harness: 'claude', model: 'sonnet', effort: 'medium' };

const said = (s: PtySession, text: string, ms = 10_000): Promise<void> =>
  s.waitFor(() => flat(s.screenText()).includes(text), ms);

type Actor = 'owner' | 'assistant';
type Body = { kind: string; expected_version: number | null; payload: Record<string, unknown> };

let seq = 0;

async function addTask(
  sd: SeededDaemon,
  actor: Actor,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const r = await sd.command(actor, {
    request_id: uuidOf(5_100 + seq++),
    kind: 'task_add',
    project: 'acme',
    task_id: null,
    expected_version: null,
    payload: { task: { title, base_branch: 'main', acceptance: ['a'], ...extra } },
  });
  expect(r.envelope.ok, JSON.stringify(r.envelope)).toBe(true);
  const board = await sd.query('owner', { kind: 'task_board', scope: 'all', limit: 100 });
  const items = (board.envelope.data as unknown as { items: { task_id: string; title: string }[] })
    .items;
  return items.find((i) => i.title === title)?.task_id ?? '';
}

async function show(sd: SeededDaemon, id: string): Promise<Record<string, unknown>> {
  return (await sd.query('owner', { kind: 'task_show', task_id: id })).envelope.data ?? {};
}

async function content(sd: SeededDaemon, id: string): Promise<Record<string, unknown>> {
  return (await sd.query('owner', { kind: 'task_content', task_id: id })).envelope.data ?? {};
}

async function propose(
  sd: SeededDaemon,
  actor: Actor,
  id: string,
  mode: 'direct-pr' | 'full-review' = 'direct-pr',
  reason = 'Proposed by the assistant',
  withFallbacks = false,
): Promise<string> {
  const r = await sd.command(actor, {
    request_id: uuidOf(5_200 + seq++),
    kind: 'task_propose_run',
    project: 'acme',
    task_id: id,
    expected_version: (await show(sd, id))['version'],
    payload: {
      run_config: {
        mode,
        profile: 'standard',
        worker: WORKER,
        reviewer:
          mode === 'full-review' ? { harness: 'codex', model: 'sol', effort: 'medium' } : null,
        reason,
        fallbacks: withFallbacks ? [{ ...WORKER, effort: 'high' }] : [],
        ...(withFallbacks && mode === 'full-review'
          ? { reviewer_fallbacks: [{ harness: 'codex', model: 'sol', effort: 'high' }] }
          : {}),
      },
    },
  });
  expect(r.envelope.ok, JSON.stringify(r.envelope)).toBe(true);
  return ((await show(sd, id))['run_config'] as { digest: string }).digest;
}

/** Every write the TUI sends, by body, and whether reads of the content are let through. */
function trace(proxy: ControlProxy) {
  const t = { writes: [] as Body[], refuseContent: false };
  proxy.refuse = (request) => {
    const body = request.slice(request.indexOf('\r\n\r\n') + 4);
    if (request.startsWith('POST /v1/command ')) t.writes.push(JSON.parse(body) as Body);
    return t.refuseContent && body.includes('"kind":"task_content"');
  };
  return t;
}

async function scene(o: { untrusted?: boolean; rows?: number; cols?: number } = {}) {
  const sd = tui.daemon({ runnable: {}, runtime: RUNTIME });
  await sd.start();
  const proxy = await tui.proxy(daemonSocket(sd));
  const t = trace(proxy);
  if (o.untrusted === true)
    proxy.rewrite = (body) => body.replace('"trusted_confirmer":true', '"trusted_confirmer":false');
  const open = (): PtySession =>
    tui.cusr(proxy.dataDir, {
      ...(o.cols === undefined ? {} : { cols: o.cols }),
      ...(o.rows === undefined ? {} : { rows: o.rows }),
    });
  return { sd, proxy, t, open };
}

async function openReview(s: PtySession, title: string): Promise<void> {
  await openMenuOf(s, title);
  await pressAction(s, 'Confirm');
  await said(s, 'Review — ');
  await said(s, 'Type confirm, then press Enter:');
}

async function confirmWord(s: PtySession): Promise<void> {
  s.send('confirm');
  await s.waitFor(() => /Enter: confirm_/.test(s.screenText()));
  s.send(KEY.enter);
}

describe('US5 scenarios 3, 4 and 6: what Review shows and confirms', () => {
  it('row 1: an assistant task with no run config confirms the intake only, without a digest', async () => {
    const { sd, t, open } = await scene();
    const id = await addTask(sd, 'assistant', 'Intake only');
    const s = open();
    await openReview(s, 'Intake only');
    await said(s, 'Confirming: the task request.');
    await said(s, 'None proposed yet');
    // Neither a wait nor Enter on an empty box confirms anything (scenario 4).
    await new Promise((r) => setTimeout(r, 1_500));
    s.send(KEY.enter);
    await said(s, 'type confirm exactly');
    expect(t.writes).toEqual([]);
    await confirmWord(s);
    await said(s, 'Done (request', 15_000);
    const confirms = t.writes.filter((w) => w.kind === 'task_confirm');
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.payload).toEqual({});
    expect((await content(sd, id))['intake_pending']).toBe(false);
  });

  it('row 2: an assistant proposal shows where it came from and confirms both, with the shown digest', async () => {
    const { sd, t, open } = await scene();
    const id = await addTask(sd, 'assistant', 'Both scopes');
    const digest = await propose(sd, 'assistant', id, 'full-review', 'Needs a reviewer');
    const version = (await content(sd, id))['version'];
    const s = open();
    await openReview(s, 'Both scopes');
    await said(s, 'Confirming: the task request and the run config.');
    for (const text of [
      'Proposed by',
      'assistant',
      'Needs a reviewer',
      'full-review',
      'codex/sol/medium',
    ])
      await said(s, text);
    await confirmWord(s);
    await said(s, 'Done (request', 15_000);
    const sent = t.writes.find((w) => w.kind === 'task_confirm');
    expect(sent?.payload).toEqual({ run_config_digest: digest });
    expect(sent?.expected_version).toBe(version);
    expect(await content(sd, id)).toMatchObject({
      intake_pending: false,
      run_config: { status: 'confirmed', confirmed_by: 'owner' },
    });
  });

  it('rows 4 and 6: an owner task confirms the run config; confirmed elsewhere, nothing is left to confirm', async () => {
    const { sd, t, open } = await scene();
    const id = await addTask(sd, 'owner', 'Run only');
    const digest = await propose(sd, 'owner', id);
    const s = open();
    await openReview(s, 'Run only');
    await said(s, 'Confirming: the run config.');
    s.send('confirm');
    await s.waitFor(() => /Enter: confirm_/.test(s.screenText()));
    // Confirmed by another client while the word sits typed: the screen changes and the box empties.
    const other = await sd.command('owner', {
      request_id: uuidOf(5_300),
      kind: 'task_confirm',
      project: 'acme',
      task_id: id,
      expected_version: (await show(sd, id))['version'],
      payload: { run_config_digest: digest },
    });
    expect(other.envelope.ok).toBe(true);
    await said(s, 'Nothing to confirm');
    await said(s, 'Changed since it was shown');
    expect(s.screenText()).toMatch(/Enter: _/);
    s.send(`confirm${KEY.enter}`);
    await said(s, 'Nothing was sent. Nothing to confirm');
    expect(t.writes).toEqual([]);
  });
});

describe('US5 scenario 7 and rows 3 and 5: a connection that may not confirm a run config', () => {
  it('row 3: confirms the intake only and says the run config needs a trusted connection', async () => {
    const { sd, t, open } = await scene({ untrusted: true });
    const id = await addTask(sd, 'assistant', 'Untrusted both');
    await propose(sd, 'assistant', id);
    const s = open();
    await openReview(s, 'Untrusted both');
    await said(s, 'Confirming: the task request only.');
    await said(s, 'needs a trusted connection');
    await confirmWord(s);
    await said(s, 'Done (request', 15_000);
    expect(t.writes.find((w) => w.kind === 'task_confirm')?.payload).toEqual({});
    expect(await content(sd, id)).toMatchObject({
      intake_pending: false,
      run_config: { status: 'proposed' },
    });
  });

  it('row 5: offers nothing to confirm, sends nothing and never says it was confirmed', async () => {
    const { sd, t, open } = await scene({ untrusted: true });
    const id = await addTask(sd, 'owner', 'Untrusted run');
    await propose(sd, 'owner', id);
    const s = open();
    await openReview(s, 'Untrusted run');
    await said(s, 'Nothing can be confirmed from this connection');
    await confirmWord(s);
    await said(s, 'Nothing was sent. Nothing can be confirmed');
    expect(flat(s.screenText())).not.toContain('Confirmed.');
    expect(t.writes).toEqual([]);
    expect((await content(sd, id))['run_config']).toMatchObject({ status: 'proposed' });
  });
});

describe('US5 scenarios 5 and 11: what changed or could not be read is never confirmed', () => {
  it('a selection changed after it was shown: shows the change, empties the box, sends the new digest only after a new word', async () => {
    const { sd, t, open } = await scene();
    const id = await addTask(sd, 'owner', 'Moving target');
    const first = await propose(sd, 'owner', id, 'direct-pr', 'First reason');
    const s = open();
    await openReview(s, 'Moving target');
    await said(s, 'First reason');
    s.send('confirm');
    await s.waitFor(() => /Enter: confirm_/.test(s.screenText()));
    const second = await propose(sd, 'assistant', id, 'full-review', 'Second reason');
    expect(second).not.toBe(first);
    await said(s, 'Mode: direct-pr → full-review');
    await said(s, 'Reason: First reason → Second reason');
    expect(s.screenText()).toMatch(/Enter: _/);
    s.send(KEY.enter);
    await said(s, 'type confirm exactly');
    expect(t.writes).toEqual([]);
    await confirmWord(s);
    await said(s, 'Done (request', 15_000);
    expect(t.writes.map((w) => w.payload)).toEqual([{ run_config_digest: second }]);
  });

  it('content that cannot be read: says why and confirms nothing, even with a run config', async () => {
    const { sd, t, open } = await scene();
    const id = await addTask(sd, 'assistant', 'Unreadable');
    await propose(sd, 'assistant', id);
    t.refuseContent = true;
    const s = open();
    await openMenuOf(s, 'Unreadable');
    await pressAction(s, 'Confirm');
    await said(s, 'Could not read the task content');
    // Nothing typed is kept while nothing could be read, so the word and Enter send nothing.
    s.send(`confirm${KEY.enter}`);
    await said(s, 'type confirm exactly');
    expect(s.screenText()).toMatch(/Enter: _/);
    expect(t.writes).toEqual([]);
    expect((await content(sd, id))['intake_pending']).toBe(true);
    // Once it reads, the same screen confirms what it shows.
    t.refuseContent = false;
    await said(s, 'Confirming: the task request and the run config.', 15_000);
  });

  it('a task that changed between the last read and the confirmation: refused, then nothing goes until it is read again', async () => {
    const { sd, proxy, t, open } = await scene();
    const id = await addTask(sd, 'owner', 'Race');
    await propose(sd, 'owner', id, 'direct-pr', 'Before race');
    const s = open();
    await openReview(s, 'Race');
    await said(s, 'Before race');
    // The next proposal lands between the screen's last read and the confirmation; the read after the
    // refusal is held until the test lets it through.
    let raced = false;
    const held = Promise.withResolvers<void>();
    proxy.beforeForward = (request) => {
      if (raced && request.includes('"kind":"task_content"')) return held.promise;
      if (raced || !request.includes('"task_confirm"')) return undefined;
      raced = true;
      return propose(sd, 'assistant', id, 'direct-pr', 'After race').then(() => undefined);
    };
    await confirmWord(s);
    await said(s, 'Not confirmed: the task changed since it was shown', 15_000);
    await said(s, 'Reading the task again');
    // The old snapshot is still on screen but cannot be confirmed: no new request before the reply.
    s.send(`confirm${KEY.enter}`);
    await said(s, 'type confirm exactly');
    expect(s.screenText()).toMatch(/Enter: _/);
    expect(t.writes.filter((w) => w.kind === 'task_confirm')).toHaveLength(1);
    held.resolve();
    await said(s, 'Reason: Before race → After race', 15_000);
    expect(s.screenText()).toMatch(/Enter: _/);
    expect((await content(sd, id))['run_config']).toMatchObject({ status: 'proposed' });
    await confirmWord(s);
    await said(s, 'Done (request', 15_000);
    expect(t.writes.filter((w) => w.kind === 'task_confirm')).toHaveLength(2);
  });

  it('a digest that differs from the daemon’s at the same version: the intake is recorded, the run config refused, and the screen says both', async () => {
    const { sd, proxy, t, open } = await scene();
    const id = await addTask(sd, 'assistant', 'Wrong digest');
    const digest = await propose(sd, 'assistant', id);
    const fake = `sha256:${'0'.repeat(64)}`;
    // The screen is shown a digest the daemon does not hold, at the version it does.
    // Only until the confirm is sent: a read answered after it, also one on a connection opened before,
    // must carry the daemon's digest, or the next confirm is refused again.
    proxy.rewrite = (body) => (t.writes.length > 0 ? body : body.replaceAll(digest, fake));
    const s = open();
    await openReview(s, 'Wrong digest');
    await said(s, 'Confirming: the task request and the run config.');
    await confirmWord(s);
    await s.waitFor(() => t.writes.length > 0);
    proxy.rewrite = null;
    await said(s, 'Partly confirmed. This request confirmed the intake of revision 1', 15_000);
    await said(s, 'run_config_digest_mismatch');
    expect(t.writes[0]?.payload).toEqual({ run_config_digest: fake });
    // The intake was recorded first; the run config was not.
    expect(await content(sd, id)).toMatchObject({
      intake_pending: false,
      run_config: { status: 'proposed' },
    });
    // Read again, what is left to confirm is the run config, with the digest the daemon holds.
    await said(s, 'Confirming: the run config.', 15_000);
    await confirmWord(s);
    await said(s, 'Done (request', 15_000);
    expect(t.writes[1]?.payload).toEqual({ run_config_digest: digest });
  });

  it('a read asked before the refusal and answered after it does not unlock the screen (R03)', async () => {
    const { sd, proxy, t, open } = await scene();
    const id = await addTask(sd, 'owner', 'Old read');
    await propose(sd, 'owner', id, 'direct-pr', 'First');
    const s = open();
    await openReview(s, 'Old read');
    await said(s, 'First');
    // From here the next content read (asked before the refusal) and every task_show are held, so the
    // screen still holds the old version when it confirms.
    const early = Promise.withResolvers<void>();
    const later = Promise.withResolvers<void>();
    let reads = 0;
    let holdShow = true;
    proxy.beforeForward = (request) => {
      if (holdShow && request.includes('"kind":"task_show"')) return later.promise;
      if (!request.includes('"kind":"task_content"')) return undefined;
      reads += 1;
      return reads === 1 ? early.promise : later.promise;
    };
    await propose(sd, 'assistant', id, 'direct-pr', 'Second');
    await s.waitFor(() => reads === 1);
    await confirmWord(s);
    await said(s, 'Not confirmed: the task changed since it was shown', 15_000);
    // The read asked before the refusal now answers: it is not the read the refusal asked for.
    early.resolve();
    await s.waitFor(() => reads >= 2, 10_000);
    s.send(`confirm${KEY.enter}`);
    await said(s, 'Reading the task again');
    expect(s.screenText()).toMatch(/Enter: _/);
    expect(t.writes.filter((w) => w.kind === 'task_confirm')).toHaveLength(1);
    holdShow = false;
    later.resolve();
    await said(s, 'Reason: First → Second', 15_000);
    await confirmWord(s);
    await said(s, 'Done (request', 15_000);
    expect(t.writes.filter((w) => w.kind === 'task_confirm')).toHaveLength(2);
  });

  it('a new revision with no visible field changed empties the box; the word then confirms that revision', async () => {
    const { sd, t, open } = await scene();
    const id = await addTask(sd, 'assistant', 'New revision');
    const s = open();
    await openReview(s, 'New revision');
    await said(s, 'revision 1');
    s.send('confirm');
    await s.waitFor(() => /Enter: confirm_/.test(s.screenText()));
    // The source is updated outside: only the priority moves, which Review does not show. The store is
    // the daemon's, so it is written while the daemon is down; the session reconnects by itself.
    await sd.stop();
    sd.seed((d) => {
      const task = d.task(id).task;
      d.must(id, { kind: 'source_updated', task: { ...task, priority: task.priority + 1 } });
    });
    await sd.start();
    await said(s, 'Revision: 1 → 2', 15_000);
    expect(s.screenText()).toMatch(/Enter: _/);
    s.send(KEY.enter);
    await said(s, 'type confirm exactly');
    expect(t.writes).toEqual([]);
    await confirmWord(s);
    await said(s, 'Done (request', 15_000);
    const c = await content(sd, id);
    expect(c).toMatchObject({ revision: 2, intake_pending: false });
    expect(t.writes[0]?.expected_version).toBeGreaterThan(1);
  });
});

describe('US5 scenario 8: PENDING after confirming shows why and offers Recheck', () => {
  it('says the task waits on its config and lists Recheck', async () => {
    // No cusr.yaml on the base: the check after the confirmation fails and the task waits for a fix.
    const runnable: { cusr?: string | null } = { cusr: null };
    const sd = tui.daemon({ runnable, runtime: RUNTIME, recheck: { observed: () => undefined } });
    await sd.start();
    const id = await addTask(sd, 'assistant', 'Will be pending');
    const s = tui.cusr(sd.dataDir);
    await openReview(s, 'Will be pending');
    await confirmWord(s);
    await said(s, 'PENDING', 15_000);
    await said(s, 'Fix outside Cuesura');
    await said(s, 'Recheck');
    // Task detail under the menu says what to fix.
    s.send(KEY.esc);
    await said(s, 'Configuration is invalid', 15_000);
    await said(s, 'Fix the config, then confirm again');
    expect(await show(sd, id)).toMatchObject({ status: 'PENDING' });
    // The fix: cusr.yaml is merged into the base. Recheck goes from here, with no command typed.
    delete runnable.cusr;
    s.send('a');
    await pressAction(s, 'Recheck');
    await said(s, 'Ctrl-S sends');
    s.send(KEY.ctrlS);
    await said(s, 'Done (request', 15_000);
    expect(await show(sd, id)).toMatchObject({ status: 'READY' });
  });
});

describe('SC-016: the whole request at 80×24', () => {
  it('every field of FR-026 can be read in full by scrolling, and the box stays in view', async () => {
    const { sd, open } = await scene({ cols: 80, rows: 24 });
    const long = (word: string, n: number): string =>
      Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');
    const id = await addTask(sd, 'assistant', 'Long request', {
      description: long('describe', 60),
      requirements: [long('require', 25), 'second requirement'],
      acceptance: [long('accept', 25)],
      constraints: [long('constrain', 20)],
      out_of_scope: [],
    });
    await propose(sd, 'assistant', id, 'full-review', long('because', 20), true);
    const s = open();
    await openReview(s, 'Long request');
    // The rows of the content, in order: the top row each time it moves by one, then what is left.
    const head = (): string[] => {
      const lines = s.screenText().split('\n');
      const box = lines.findIndex((l) => l.includes('Type confirm, then press Enter:'));
      expect(box, 'the box stays in view').toBeGreaterThan(0);
      return lines.slice(1, box).map((l) => l.trim());
    };
    const rows: string[] = [];
    for (let i = 0; i < 120; i++) {
      // The bar's clock ticks by itself; only the content moving counts.
      const before = head();
      s.send(KEY.down);
      const moved = await s
        .waitFor(() => head().join('\n') !== before.join('\n'), 1_000)
        .then(() => true)
        .catch(() => false);
      if (!moved) break;
      rows.push(before[0] ?? '');
    }
    rows.push(...head());
    const text = rows.filter((r) => r !== '').join(' ');
    const c = await content(sd, id);
    const sel = (c['run_config'] as { selection: Record<string, unknown> }).selection;
    const expected = [
      'Project',
      'acme',
      'Base branch',
      'main',
      'Title',
      'Long request',
      'Description',
      String(c['description']),
      'Requirements',
      ...(c['requirements'] as string[]).map((r) => `• ${r}`),
      'Acceptance',
      ...(c['acceptance'] as string[]).map((r) => `• ${r}`),
      'Constraints',
      ...(c['constraints'] as string[]).map((r) => `• ${r}`),
      // An empty list reads None, not the same as one that could not be read.
      'Out of scope',
      'None',
      'Proposed by',
      'assistant · proposed',
      'Profile',
      String(sel['profile']),
      'Mode',
      'full-review',
      'Reason',
      String(sel['reason']),
      'Worker',
      'claude/sonnet/medium',
      'Reviewer',
      'codex/sol/medium',
      'Worker fallbacks',
      '• claude/sonnet/high',
      'Reviewer fallbacks',
      '• codex/sol/high',
    ];
    // Each in full and in this order; wrapped lines join with a space.
    let at = 0;
    for (const part of expected) {
      const found = text.indexOf(part, at);
      expect(found, `${part} after position ${at}`).toBeGreaterThanOrEqual(0);
      at = found + part.length;
    }
    expect(text).not.toContain('Could not read');
  }, 120_000);
});

describe('T067: every pairing Run config offers reaches the start with the simulated harness', () => {
  it('proposes, confirms and starts each offered mode, worker, reviewer and fallback', async () => {
    const { sd } = await scene();
    type Choice = { harness: string; model: string; effort: string };
    type Options = {
      profile: { id: string };
      modes: {
        mode: 'direct-pr' | 'full-review';
        reviewers: Choice[];
        workers: { choice: Choice; fallbacks: Choice[] }[];
        reviewer_fallbacks: { choice: Choice; fallbacks: Choice[] }[];
      }[];
    };
    const probe = await addTask(sd, 'owner', 'Pairings');
    const options = (await sd.query('owner', { kind: 'run_options', task_id: probe })).envelope
      .data as unknown as Options;
    const pairings = options.modes.flatMap((m) =>
      m.workers.flatMap((w) =>
        (m.mode === 'direct-pr' ? [null] : m.reviewers).flatMap((reviewer) => {
          const offered =
            m.reviewer_fallbacks.find((r) => JSON.stringify(r.choice) === JSON.stringify(reviewer))
              ?.fallbacks ?? [];
          // Each fallback list as the user may leave it: empty, or with what is offered.
          return subsets(w.fallbacks).flatMap((fallbacks) =>
            subsets(offered).map((reviewer_fallbacks) => ({
              mode: m.mode,
              worker: w.choice,
              fallbacks,
              reviewer,
              reviewer_fallbacks,
            })),
          );
        }),
      ),
    );
    expect(new Set(pairings.map((p) => p.mode))).toEqual(new Set(['direct-pr', 'full-review']));
    expect(pairings.some((p) => p.fallbacks.length > 0 && p.reviewer_fallbacks.length > 0)).toBe(
      true,
    );
    const ids: string[] = [];
    for (const [i, p] of pairings.entries()) {
      const id = await addTask(sd, 'owner', `Pairing ${i}`);
      ids.push(id);
      const proposed = await sd.command('owner', {
        request_id: uuidOf(5_500 + i),
        kind: 'task_propose_run',
        project: 'acme',
        task_id: id,
        expected_version: (await show(sd, id))['version'],
        payload: {
          run_config: {
            profile: options.profile.id,
            reason: 'every pairing',
            mode: p.mode,
            worker: p.worker,
            reviewer: p.reviewer,
            fallbacks: p.fallbacks,
            ...(p.mode === 'full-review' ? { reviewer_fallbacks: p.reviewer_fallbacks } : {}),
          },
        },
      });
      expect(proposed.envelope.ok, JSON.stringify(proposed.envelope)).toBe(true);
      const digest = ((await show(sd, id))['run_config'] as { digest: string }).digest;
      const confirmed = await sd.command('owner', {
        request_id: uuidOf(5_600 + i),
        kind: 'task_confirm',
        project: 'acme',
        task_id: id,
        expected_version: (await show(sd, id))['version'],
        payload: { run_config_digest: digest },
      });
      expect(confirmed.envelope.ok, JSON.stringify(confirmed.envelope)).toBe(true);
      expect(confirmed.envelope.data?.['result']).toMatchObject({
        config_check: 'checked',
        run_config: { status: 'confirmed' },
      });
    }
    // The start seam: the scheduler's real start with the fake adapters, which freezes the snapshot from
    // the confirmed selection after reading the base and running preflight again.
    await sd.stop();
    const d = new StoreDriver(openFileStoreForTest(join(sd.dataDir, STORE_FILE)));
    d.now = sd.now;
    try {
      for (const [i, id] of ids.entries()) {
        const p = pairings[i];
        if (p === undefined) continue;
        d.must(id, { kind: 'request_execution' });
        // Each started task keeps its slot reserved; room for all of them, as with a large concurrency.
        const g = d.store.grantNext(d.now as never, [], { capacity: MAX_CONCURRENCY });
        expect(g.ok && g.value.kind, `grant ${i}`).toBe('decided');
        const r = await startTask(
          {
            store: d.store,
            ports: { git: fakeGit({}), github: fakeGitHub(), host: fakeHost() },
            configInputs: () =>
              Promise.resolve({
                user: userConfig({ runtime: RUNTIME }),
                packs: PACKS,
                manifests: MANIFESTS,
              }),
            docs: {
              prompts: (names) =>
                Promise.resolve(names.map((name) => ({ name, content: `# ${name}\n` }))),
              attachments: () => Promise.resolve([]),
            },
            now: () => d.now,
            newId: () => uuidOf(7_000 + i * 20 + d.task(id).version),
          },
          id,
        );
        expect(r, `pairing ${i}`).toMatchObject({ kind: 'submitted', frozen: true });
        const s = d.task(id);
        expect(s.status, `pairing ${i}`).toBe('RUNNING');
        const frozen = d.store.readRuntimeContext(id as never, s.revision)?.run_config;
        expect(frozen, `pairing ${i}`).toMatchObject({
          mode: p.mode,
          selection: {
            worker: p.worker,
            reviewer: p.reviewer,
            fallbacks: p.fallbacks,
            ...(p.mode === 'full-review' ? { reviewer_fallbacks: p.reviewer_fallbacks } : {}),
          },
        });
      }
    } finally {
      d.store.close();
    }
  });
});
