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
  tap: ((direction: 'request' | 'response', data: Buffer) => void) | null = null;
  /**
   * Asked about every request; in `forward`, one for which it answers true never reaches the daemon: the connection ends, as if
   * the link dropped before the request was written. Each request is one chunk, so the test sees it whole.
   */
  refuse: ((request: string) => boolean) | null = null;
  #target: string;
  readonly #server: Server;
  readonly #open = new Set<Socket>();

  private constructor(target: string, mode: ProxyMode) {
    this.dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-proxy-')));
    this.#target = target;
    this.mode = mode;
    this.#server = createServer((client) => this.#accept(client));
  }

  static async start(target: string, mode: ProxyMode = 'forward'): Promise<ControlProxy> {
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
    if (this.refuse !== null) {
      client.once('data', (first: Buffer) => {
        const refused = this.refuse?.(first.toString('utf8')) === true;
        if (refused && this.mode === 'forward') {
          client.destroy();
          upstream.destroy();
          return;
        }
        if (this.mode === 'forward') {
          this.tap?.('request', first);
          client.on('data', (b: Buffer) => this.tap?.('request', b));
        }
        upstream.write(first);
        client.pipe(upstream);
      });
    } else {
      client.pipe(upstream);
      if (this.mode === 'forward') client.on('data', (b: Buffer) => this.tap?.('request', b));
    }
    if (this.mode === 'forward') {
      upstream.on('data', (b: Buffer) => this.tap?.('response', b));
      upstream.pipe(client);
      upstream.on('close', () => client.destroy());
      return;
    }
    // Reads the whole response and throws it away; the client sees a connection that died.
    upstream.resume();
    upstream.on('close', () => client.destroy());
  }

  /**
   * Writes `request` to the daemon again on a connection of its own, as a client sending it once more would,
   * and resolves with what the daemon answered.
   */
  replay(request: string): Promise<string> {
    return new Promise((resolve) => {
      const upstream = connect(this.#target);
      this.#track(upstream);
      const chunks: Buffer[] = [];
      upstream.on('connect', () => upstream.write(request));
      upstream.on('data', (b: Buffer) => chunks.push(b));
      upstream.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  async stop(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    rmSync(this.dataDir, { recursive: true, force: true });
  }
}
