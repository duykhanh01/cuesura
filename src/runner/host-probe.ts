import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type { HostExecResult, HostProbePort } from '../adapters/ports.ts';

const OUTPUT_BYTES = 64 * 1024;

/**
 * Read-only host probes for preflight. `exec` runs a fixed argv without a shell and with an empty
 * environment apart from PATH/HOME/XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS (the user bus needs them).
 */
export class NodeHostProbe implements HostProbePort {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  async findExecutable(name: string, extraDirs: readonly string[] = []): Promise<string | null> {
    for (const dir of [...(this.env.PATH ?? '').split(delimiter), ...extraDirs]) {
      if (!isAbsolute(dir)) continue;
      const candidate = join(dir, name);
      try {
        await access(candidate, constants.X_OK);
        const real = await realpath(candidate);
        if ((await stat(real)).isFile()) return real;
      } catch {
        // not here; keep looking
      }
    }
    return null;
  }

  async realpath(path: string): Promise<string | null> {
    try {
      return await realpath(path);
    } catch {
      return null;
    }
  }

  async readText(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  }

  exec(argv: readonly string[], opts: { readonly timeout_ms: number }): Promise<HostExecResult> {
    const [file, ...args] = argv;
    if (file === undefined) return Promise.resolve({ kind: 'spawn_failed', message: 'empty argv' });
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
      if (this.env[k] !== undefined) env[k] = this.env[k];
    }
    return new Promise((resolve) => {
      execFile(
        file,
        args,
        {
          env,
          timeout: opts.timeout_ms,
          maxBuffer: OUTPUT_BYTES,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          if (error === null) return resolve({ kind: 'exited', code: 0, stdout, stderr });
          const e = error as NodeJS.ErrnoException & {
            killed?: boolean;
            code?: number | string;
          };
          if (e.killed === true) return resolve({ kind: 'timeout' });
          if (typeof e.code === 'number')
            return resolve({ kind: 'exited', code: e.code, stdout, stderr });
          resolve({ kind: 'spawn_failed', message: e.message });
        },
      );
    });
  }
}
