import { connect, createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTROL_SOCKET } from '../../src/cli/output.ts';

/**
 * A control socket in front of a real daemon, for failures a real daemon does not produce on demand. It
 * keeps tests honest without a hook in running code: a client sees exactly what a stuck or vanishing
 * daemon looks like over the socket.
 * - `forward`: passes bytes both ways.
 * - `hold`: accepts the connection and never answers.
 * - `drop_response`: delivers the request, lets the daemon finish, then closes without the response.
 */
export type ProxyMode = 'forward' | 'hold' | 'drop_response';

export class ControlProxy {
  /** Data dir a client points `CUSR_DATA_DIR` at; holds only the socket. */
  readonly dataDir: string;
  /** Connections accepted so far, whatever the mode. */
  connections = 0;
  mode: ProxyMode;
  /** Sees what passes in `forward`, for a test that must know what the daemon answered. */
  tap: ((direction: 'request' | 'response', data: Buffer) => void) | null =
    null;
  #target: string;
  readonly #server: Server;
  readonly #open = new Set<Socket>();

  private constructor(target: string, mode: ProxyMode) {
    this.dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-proxy-')));
    this.#target = target;
    this.mode = mode;
    this.#server = createServer((client) => this.#accept(client));
  }

  static async start(
    target: string,
    mode: ProxyMode = 'forward',
  ): Promise<ControlProxy> {
    const proxy = new ControlProxy(target, mode);
    await new Promise<void>((resolve, reject) => {
      proxy.#server.once('error', reject);
      proxy.#server.listen(join(proxy.dataDir, CONTROL_SOCKET), resolve);
    });
    return proxy;
  }

  /** Later connections go to this daemon socket. */
  retarget(target: string): void {
    this.#target = target;
  }

  /** Closes the connections being held or forwarded; the listener stays. */
  dropConnections(): void {
    for (const s of this.#open) s.destroy();
  }

  #track(s: Socket): void {
    this.#open.add(s);
    s.on('close', () => this.#open.delete(s));
    s.on('error', () => s.destroy());
  }

  #accept(client: Socket): void {
    this.connections += 1;
    this.#track(client);
    if (this.mode === 'hold') return;
    const upstream = connect(this.#target);
    this.#track(upstream);
    client.on('close', () => {
      // A client that gave up must not cut off a request being dropped on purpose.
      if (this.mode !== 'drop_response') upstream.destroy();
    });
    client.pipe(upstream);
    if (this.mode === 'forward') {
      client.on('data', (b: Buffer) => this.tap?.('request', b));
      upstream.on('data', (b: Buffer) => this.tap?.('response', b));
      upstream.pipe(client);
      upstream.on('close', () => client.destroy());
      return;
    }
    // Reads the whole response and throws it away; the client sees a connection that died.
    upstream.resume();
    upstream.on('close', () => client.destroy());
  }

  async stop(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    rmSync(this.dataDir, { recursive: true, force: true });
  }
}
