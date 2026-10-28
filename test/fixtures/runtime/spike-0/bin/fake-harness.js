#!/usr/bin/env node
// Local fake child for spike-002 runner/harness tests. Never calls a model or the network.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [mode, ...args] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

switch (mode) {
  case 'echo': {
    const n = Number(args[0] ?? 3);
    for (let i = 0; i < n; i++) process.stdout.write(`${JSON.stringify({ type: 'progress', i })}\n`);
    process.stderr.write('fake stderr line\n');
    break;
  }
  case 'secret':
    process.stdout.write(`token=${args[0]} also ghp_${'a'.repeat(36)}\n`);
    process.stderr.write(`Authorization: Bearer ${args[0]}\n`);
    break;
  case 'big':
    process.stdout.write(`${'x'.repeat(Number(args[0]))}\nafter\n`);
    break;
  case 'partial':
    process.stdout.write('{"type":"complete"}\n{"type":"cut');
    break;
  case 'flood': {
    const line = `${'y'.repeat(1023)}\n`;
    for (let sent = 0; sent < Number(args[0]); sent += 1024) {
      if (!process.stdout.write(line)) await new Promise((r) => process.stdout.once('drain', r));
    }
    await sleep(60_000);
    break;
  }
  case 'ignore-term':
    process.on('SIGTERM', () => process.stdout.write('{"type":"term-ignored"}\n'));
    process.stdout.write('{"type":"ready"}\n');
    await sleep(Number(args[0] ?? 60_000));
    break;
  case 'grandchild': {
    // One grandchild stays in our process group; one escapes it with setsid (detached).
    const inGroup = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 600000)'], { stdio: 'ignore' });
    const escaped = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 600000)'], { stdio: 'ignore', detached: true });
    escaped.unref();
    writeFileSync(args[0], JSON.stringify({ in_group: inGroup.pid, escaped: escaped.pid }));
    process.stdout.write('{"type":"spawned"}\n');
    if (args[1] === 'exit') process.exit(0);
    await sleep(600_000);
    break;
  }
  case 'sleep':
    await sleep(Number(args[0] ?? 1000));
    break;
  case 'result':
    writeFileSync(args[0], args[1]);
    process.stdout.write('{"type":"result-written"}\n');
    break;
  case 'result-exit':
    writeFileSync(args[0], args[1]);
    process.exit(Number(args[2]));
    break;
  case 'stdout-result':
    process.stdout.write(`${args[0]}\n`);
    break;
  case 'exit':
    process.exit(Number(args[0] ?? 1));
    break;
  default:
    process.stderr.write(`unknown mode ${mode}\n`);
    process.exit(64);
}
