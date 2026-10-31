/**
 * Crash-test child: apply <db> <ops.json> replays operations with crash injection; hold <db>
 * prints ready and holds the writer lock until killed.
 */
import { readFileSync } from 'node:fs';
import { openStore } from '../../src/store/index.ts';
import { applyOp, type StoreOp } from './store-driver.ts';

const [mode, db, opsFile] = process.argv.slice(2);
if (db === undefined) throw new Error('Database path is required');

const opened = openStore(db, { busyTimeoutMs: 200 });
if (!opened.ok) {
  process.stdout.write(`open_failed ${opened.error.code}\n`);
  process.exit(3);
}
const store = opened.value;

if (mode === 'hold') {
  process.stdout.write('ready\n');
  // Keep a strong reference: otherwise V8 can collect the connection and release the writer lock.
  setInterval(() => void store, 1_000);
} else if (mode === 'apply') {
  if (opsFile === undefined) throw new Error('Operations file is required');
  const ops = JSON.parse(readFileSync(opsFile, 'utf8')) as StoreOp[];
  for (const op of ops) applyOp(store, op);
  store.close();
  process.stdout.write('done\n');
} else {
  throw new Error(`Invalid mode: ${String(mode)}`);
}
