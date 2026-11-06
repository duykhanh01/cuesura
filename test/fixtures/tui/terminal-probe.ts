/**
 * A minimal program on top of the terminal core, driven by keys, so every exit path can be exercised
 * through a real PTY before any screen exists (feature 004 slice 0).
 */
import { openTerminal } from '../../../src/tui/terminal/terminal.ts';

let draws = 0;

const terminal = openTerminal({
  onInput(data) {
    const key = data.toString('utf8');
    if (key === 'q') terminal.exit(0);
    else if (key === '\x03') terminal.exit(0);
    else if (key === 'x') throw new Error('probe: internal error');
    else if (key === 'r') void Promise.reject(new Error('probe: rejected'));
    else if (key === 'w') failStdoutWrites();
    else if (key === 'W') terminal.write('after the failure');
  },
  onResize: draw,
  onRedraw: draw,
  // A pending notice, as a write whose result is unknown would leave (EC-012).
  ...(process.env['PROBE_NOTICE'] === undefined
    ? {}
    : { exitNotice: () => process.env['PROBE_NOTICE'] ?? null, exitNoticeCode: 3 }),
});

/** Writes now fail the way libuv reports it, while fd 1 stays open so the restore can be observed. */
function failStdoutWrites(): void {
  (
    process.stdout as unknown as {
      _write: (c: unknown, e: unknown, cb: (e: Error) => void) => void;
    }
  )._write = (_c, _e, cb) =>
    cb(Object.assign(new Error('write EIO'), { code: 'EIO' }));
}

function draw(): void {
  draws += 1;
  const { cols, rows } = terminal.size();
  terminal.write(`\x1b[2J\x1b[H probe ready draws=${draws} ${cols}x${rows}`);
}

draw();
