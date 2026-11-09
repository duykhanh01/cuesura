import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./crash-child.ts', import.meta.url));

export type ChildRun = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export function runChild(args: string[], env: Record<string, string> = {}): ChildRun {
  const r = spawnSync(process.execPath, [CHILD, ...args], {
    env: { ...process.env, CUSR_CRASH_AT: '', CUSR_CRASH_AFTER: '', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

export function holdStore(path: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [CHILD, 'hold', path], {
    env: { ...process.env, CUSR_CRASH_AT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString();
      if (out.includes('ready')) resolve(child);
      if (out.includes('open_failed')) reject(new Error(out));
    });
    child.on('exit', (code, signal) =>
      reject(new Error(`hold exited early: ${String(code)} ${String(signal)} ${out}`)),
    );
  });
}

export function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}
