import { describe, expect, it } from 'vitest';
import { buildTask, uuidOf } from '../../support/builders.ts';
import type { SeededDaemon } from '../../support/daemon-task.ts';
import { KEY, type PtySession } from '../../support/pty.ts';
import {
  daemonSocket,
  flat,
  openMenuOf,
  pressAction,
  seedEscalation,
  seedQuestion,
  seedRunning,
  seedWorktreeChanged,
  useTui,
} from '../../support/tui-fixtures.ts';

// T057 / SC-008: random keys on each confirmation screen of US4 on a real PTY against a real daemon, from a
// seed that reproduces the run (CUSR_SEED). The checks are the trace of what reached the daemon, that the
// screen is still the dialog and still answers, that a dialog opens with an empty confirmation box, and that
// quitting still works. The letter that would complete the confirmation word is never in the keys, and
// pastes of the word are: nothing may confirm, whatever the sequence. T068 adds the Review screen here.
const tui = useTui();
const SEED = Number(process.env['CUSR_SEED'] ?? 20261106);
// SC-008 asks for at least 10,000; a shorter run is for looking at a failure only.
const KEYS_PER_SCREEN = Number(process.env['CUSR_FUZZ_KEYS'] ?? 10_000);
/** Keys written at once; bytes of many keys reach the program in one read, as a fast typist's paste would. */
const CHUNK = 40;
/** How often the run stops to check that the screen is still the dialog. */
const CHECK_EVERY = 500;

/** mulberry32: the same numbers for the same seed everywhere. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Scene = {
  readonly name: string;
  readonly title: string;
  /** The entry of the Actions menu that opens the dialog. */
  readonly action: string;
  /** What the dialog shows while it is open. */
  readonly marker: string;
  /** The word the dialog asks for; `null` for Answer, which is sent with Ctrl-S. */
  readonly word: string | null;
  /** The command the daemon must never receive during the run. */
  readonly kind: string;
  /** A letter of the word, left out of the keys so that no sequence can type it. */
  readonly without: string;
  setup(sd: SeededDaemon): void;
};

const SCENES: readonly Scene[] = [
  {
    name: 'Answer',
    title: 'Fuzz target',
    action: 'Answer the question',
    marker: 'Answer the question —',
    word: null,
    kind: 'answer',
    without: '',
    setup: (sd) =>
      sd.seed((d) => seedQuestion(d, buildTask({ id: uuidOf(1), title: 'Fuzz target' }))),
  },
  {
    name: 'Cancel',
    title: 'Task 001',
    action: 'Cancel task',
    marker: 'Cancel task —',
    word: 'cancel',
    kind: 'task_cancel',
    without: 'c',
    setup: (sd) => sd.seed((d) => void seedRunning(d, 1)),
  },
  {
    name: 'Recheck (worktree_changed)',
    title: 'Fuzz target',
    action: 'Recheck',
    marker: 'Recheck: accept the worktree as it is —',
    word: 'accept',
    kind: 'task_recheck',
    without: 'c',
    setup: (sd) => void seedWorktreeChanged(sd, 1, 'Fuzz target'),
  },
  {
    name: 'Approve',
    title: 'Fuzz target',
    action: 'Approve',
    marker: 'Approve escalation —',
    word: 'approve',
    kind: 'approve_escalation',
    without: 'p',
    setup: (sd) =>
      sd.seed((d) => seedEscalation(d, buildTask({ id: uuidOf(1), title: 'Fuzz target' }))),
  },
];

const PRINTABLE = [
  ...'abdefghijklmnoqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789?!@#$%^&*()-_=+[]{};:,.<>/\\|`~界👍é',
];
const PASTES = ['cancel', 'accept', 'approve', 'a\nb', 'x', 'line one\r\nline two', ''];

type Step = { readonly bytes: string; readonly esc: boolean };

function keyStream(scene: Scene, next: () => number): Step {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  const printable = PRINTABLE.filter(
    (c) => c !== scene.without && c !== scene.without.toUpperCase(),
  );
  const r = next();
  if (r < 0.003) return { bytes: KEY.esc, esc: true };
  if (r < 0.56) return { bytes: pick(printable), esc: false };
  if (r < 0.6) return { bytes: `\x1b[200~${pick(PASTES)}\x1b[201~`, esc: false };
  const keys = [
    KEY.enter,
    KEY.enter,
    KEY.tab,
    KEY.shiftTab,
    '\x7f',
    '\x7f',
    '\x1b[3~',
    KEY.up,
    KEY.down,
    KEY.left,
    KEY.right,
    '\x1b[H',
    '\x1b[F',
    KEY.pageUp,
    KEY.pageDown,
    '\x0f',
    '\x0c',
    // Ctrl-S sends an answer, so Answer's keys leave it out until the end.
    ...(scene.word === null ? [] : [KEY.ctrlS, KEY.ctrlS]),
  ];
  return { bytes: pick(keys), esc: false };
}

/** The dialog is on screen, drawn and answering: a key that changes the screen shows. */
async function shows(s: PtySession, scene: Scene): Promise<void> {
  await s.waitFor(() => flat(s.screenText()).includes(scene.marker), 15_000);
}

describe('SC-008: random keys on each confirmation screen', () => {
  for (const scene of SCENES)
    it(`${scene.name}: ${KEYS_PER_SCREEN} keys, nothing confirms by accident (seed ${SEED})`, async () => {
      // A daemon that serves task_recheck, so that a confirmed recheck has an answer.
      const sd = tui.daemon({ recheck: { observed: () => undefined } });
      scene.setup(sd);
      await sd.start();
      const proxy = await tui.proxy(daemonSocket(sd));
      /** Every write that reached the daemon, in order. */
      const trace: string[] = [];
      const ids = new Set<string>();
      proxy.refuse = (request) => {
        if (request.startsWith('POST /v1/command')) {
          trace.push(/"kind":"([^"]+)"/.exec(request)?.[1] ?? '?');
          ids.add(/"request_id":"([^"]+)"/.exec(request)?.[1] ?? '?');
        }
        return false;
      };
      const s = tui.cusr(proxy.dataDir);
      await openMenuOf(s, scene.title);
      const version = async (): Promise<unknown> =>
        (await sd.query('owner', { kind: 'task_show', task_id: uuidOf(1) })).envelope.data?.[
          'version'
        ];
      const before = await version();
      await pressAction(s, scene.action);
      await shows(s, scene);

      const next = random(SEED + scene.name.length);
      let reopened = 0;
      let sent = 0;
      while (sent < KEYS_PER_SCREEN) {
        let chunk = '';
        let leave = false;
        for (let i = 0; i < CHUNK && sent < KEYS_PER_SCREEN; i++, sent++) {
          const step = keyStream(scene, next);
          if (step.esc) {
            leave = true;
            sent++;
            break;
          }
          chunk += step.bytes;
        }
        s.send(chunk);
        if (leave) {
          // Esc leaves the dialog without sending; opening it again must start from nothing.
          s.send(KEY.esc);
          await s.waitFor(() => s.screenText().includes('Actions — '), 15_000);
          await pressAction(s, scene.action);
          await shows(s, scene);
          reopened++;
          if (scene.word !== null) {
            const line = s
              .screenText()
              .split('\n')
              .find((l) => l.includes(`Type ${scene.word}, then press Enter:`));
            expect(
              // The cursor of a focused box is an underscore.
              line
                ?.replace(/^.*Enter:\s*/, '')
                .replace(/_$/, '')
                .trim(),
              `box after reopening ${reopened}`,
            ).toBe('');
          }
        }
        if (sent % CHECK_EVERY < CHUNK || leave) {
          // A redraw and a look: the program is alive, in the dialog, and nothing raw leaked to the screen.
          s.send('\x0c');
          await shows(s, scene);
          expect(s.screenText()).not.toContain('\x1b');
        }
      }

      // Nothing that confirms was ever sent, and the task is as it was.
      if (scene.word !== null) {
        expect(trace, 'writes during the random keys').toEqual([]);
        expect(await version()).toEqual(before);
        // Now the sequences that can confirm, from a dialog opened afresh, each checked against the trace.
        s.send(KEY.esc);
        await s.waitFor(() => s.screenText().includes('Actions — '), 15_000);
        await pressAction(s, scene.action);
        await shows(s, scene);
        // The review comes first: what the dialog warns of is on screen before any word is typed.
        // For a recheck of the worktree, its place is on screen first: without it the daemon is not asked.
        if (scene.word === 'accept') await s.waitForText('Worktree: wt-1');
        const review = flat(s.screenText());
        expect(review).toContain(scene.word === 'accept' ? 'cannot show you what changed' : 'Type');
        const wipe = '\x7f'.repeat(24);
        const word = scene.word;
        /** What the confirmation box holds, with the cursor of a focused box left out. */
        const box = (): string | undefined =>
          s
            .screenText()
            .split('\n')
            .find((l) => l.includes(`Type ${word}, then press Enter:`))
            ?.replace(/^.*Enter:\s*/, '')
            .replace(/_$/, '')
            .trim();
        const says = (text: string): boolean => flat(s.screenText()).includes(text);
        // Out of order or incomplete, from the confirmation box: Ctrl-S, an empty Enter, a pasted word, a word
        // one letter short; for Cancel also the whole word with no reason given. Each is refused on screen,
        // which a write would have replaced with `Sending…`.
        const cancel = scene.name === 'Cancel';
        if (cancel) {
          s.send(KEY.tab);
          await s.waitFor(() => box() !== undefined && says(`› Type ${word}`), 10_000);
        }
        const wrong: readonly (readonly [string, () => boolean])[] = [
          [KEY.ctrlS, () => says('Ctrl-S does not send this')],
          [KEY.enter, () => says(`type ${word} exactly`)],
          [`\x1b[200~${word}\x1b[201~`, () => says('Paste is not accepted here')],
          [KEY.enter, () => says(`type ${word} exactly`) && box() === ''],
          [
            `${wipe}${word.slice(0, -1)}${KEY.enter}`,
            () => says(`type ${word} exactly`) && box() === word.slice(0, -1),
          ],
          ...(cancel
            ? [
                [
                  `${wipe}${word}${KEY.enter}`,
                  () => says('A reason is required') && box() === word,
                ] as const,
              ]
            : []),
        ];
        for (const [keys, refused] of wrong) {
          s.send(keys);
          await s.waitFor(refused, 10_000, () => `refusal of ${JSON.stringify(keys)}`);
          expect(trace, `after ${JSON.stringify(keys)}`).toEqual([]);
        }
        // In order: (a reason,) the exact word, Enter. Exactly that command reaches the daemon, once.
        s.send(`${cancel ? `${KEY.tab}fuzz reason${KEY.tab}` : ''}${wipe}${word}`);
        await s.waitFor(() => box() === word, 10_000);
        expect(trace, 'the word typed, Enter not yet pressed').toEqual([]);
        s.send(KEY.enter);
        // The daemon's answer, whichever it is: done, or refused with the dialog kept.
        await s.waitFor(
          () => /\(request [0-9a-f-]{36}\)|The daemon refused it/.test(flat(s.screenText())),
          20_000,
        );
        // One logical write: a lost answer may be sent again, always as the same request.
        expect(new Set(trace)).toEqual(new Set([scene.kind]));
        expect(ids.size).toBe(1);
        if (scene.kind !== 'task_recheck') expect(await version()).not.toEqual(before);
      } else {
        expect(trace, 'writes before Ctrl-S').toEqual([]);
        // The same screen, with a thing to send, sends once and only on Ctrl-S.
        s.send('final answer');
        s.send(KEY.ctrlS);
        await s.waitFor(() => /Done \(request /.test(flat(s.screenText())), 20_000);
        expect(trace.filter((k) => k === 'answer')).toHaveLength(1);
        expect(trace).toHaveLength(1);
      }

      // Still alive for the way out: Esc out of a dialog kept open, then q from the menu.
      if (flat(s.screenText()).includes(scene.marker)) {
        s.send(KEY.esc);
        await s.waitFor(() => !flat(s.screenText()).includes(scene.marker), 10_000);
      }
      s.send('q');
      expect((await s.waitForExit(20_000)).status).toBe(0);
    }, 900_000);
});
