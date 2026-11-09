import type { GhExec, GhExecResult } from '../../src/adapters/github/gh-port.ts';

// Emulates `gh api --include` from a script for the production GitHub port; never touches the network.

export type FixtureResponse = {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly transport?: 'timeout' | 'overflow' | 'exit_no_output';
};

/** Keyed by `METHOD path?query`; each key holds a sequence whose last item repeats. */
export type FixtureScript = Readonly<Record<string, readonly FixtureResponse[]>>;

const REASON: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  403: 'Forbidden',
  404: 'Not Found',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
};

export type FixtureCall = {
  readonly method: string;
  readonly target: string;
  readonly args: readonly string[];
  readonly stdin: string | null;
};

export function fixtureExec(script: FixtureScript): GhExec & { readonly calls: FixtureCall[] } {
  const seen = new Map<string, number>();
  const calls: FixtureCall[] = [];
  const exec: GhExec = (args, opts) => {
    const target = args.at(-1) as string;
    const method = args[args.indexOf('--method') + 1] ?? '?';
    calls.push({ method, target, args: [...args], stdin: opts.stdin });
    const key = `${method} ${target}`;
    const seq = script[key];
    const done = (r: GhExecResult): Promise<GhExecResult> => Promise.resolve(r);
    if (seq === undefined || seq.length === 0) {
      return done({
        code: 1,
        stdout: Buffer.from(
          `HTTP/2.0 404 Not Found\r\n\r\n{"message":"fixture: no response for ${key}"}`,
        ),
        stderr: 'gh: Not Found (HTTP 404)',
        timedOut: false,
        overflow: false,
      });
    }
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const r = seq[Math.min(n, seq.length - 1)] as FixtureResponse;
    if (r.transport === 'timeout')
      return done({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: '',
        timedOut: true,
        overflow: false,
      });
    if (r.transport === 'exit_no_output')
      return done({
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: 'error connecting to api.github.com',
        timedOut: false,
        overflow: false,
      });
    const head = [
      `HTTP/2.0 ${r.status} ${REASON[r.status] ?? ''}`,
      ...Object.entries(r.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    ].join('\r\n');
    const out = Buffer.from(`${head}\r\n\r\n${r.body === undefined ? '' : JSON.stringify(r.body)}`);
    if (r.transport === 'overflow' || out.length > opts.maxBytes)
      return done({
        code: null,
        stdout: out.subarray(0, opts.maxBytes),
        stderr: '',
        timedOut: false,
        overflow: true,
      });
    return done({
      code: r.status >= 200 && r.status < 300 ? 0 : 1,
      stdout: out,
      stderr: '',
      timedOut: false,
      overflow: false,
    });
  };
  return Object.assign(exec, { calls });
}
