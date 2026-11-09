/** The extension `cusr init` writes for pi, which has no hook file: it is the hook. */
export const PI_EXTENSION_MARKER = '// Written by cusr init; holds a path of this machine.';

export function piExtensionSource(dataDir: string): string {
  return `${PI_EXTENSION_MARKER}
import { spawn, type ChildProcess } from 'node:child_process';

function cusr(args: string[], payload: string): ChildProcess {
  const env = { ...process.env, CUSR_DATA_DIR: ${JSON.stringify(dataDir)}, CUSR_ACTOR: 'assistant' };
  const child = spawn('cusr', ['assistant', ...args], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  child.on('error', () => undefined);
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(payload);
  return child;
}

function finished(child: ChildProcess): Promise<{ code: number | null; text: string }> {
  return new Promise((done) => {
    let text = '';
    child.stdout?.on('data', (chunk) => (text += String(chunk)));
    child.on('close', (code) => done({ code, text }));
  });
}

const RETRY_MS = 2_000;
/** Each offer can start a turn, so a note that never shows up must not offer for ever. */
const MAX_OFFERS = 3;

function textOf(message: any): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: any) => part.text ?? '').join('');
}

export default function (pi: any): void {
  let payload: string | null = null;
  let reminder: Promise<string> = Promise.resolve('');
  let parked: ChildProcess | null = null;
  let closing = false;
  let session: any = null;
  /** Received from the hook, not yet seen in the session. */
  let pending: { note: string; lease: string } | null = null;
  let confirm: string | null = null;
  let retry: ReturnType<typeof setInterval> | null = null;
  let offers = 0;

  const stopRetry = (): void => {
    if (retry !== null) clearInterval(retry);
    retry = null;
  };

  // sendUserMessage returns nothing and pi refuses it during compaction, so only an idle session is
  // asked, and asked again until the note shows up.
  const offer = (): void => {
    if (pending === null || closing || !session.isIdle() || session.hasPendingMessages()) return;
    // Left unconfirmed, the daemon keeps it and the hook of the next turn gets it again.
    if (offers >= MAX_OFFERS) {
      pending = null;
      stopRetry();
      return;
    }
    offers += 1;
    pi.sendUserMessage(pending.note, { deliverAs: 'followUp' });
  };

  pi.on('session_start', (_event: unknown, ctx: any) => {
    session = ctx;
    payload = JSON.stringify({ session_id: ctx.sessionManager.getSessionId() });
    reminder = finished(cusr(['session-start'], payload)).then((r) => r.text);
  });

  // Hidden context, because this must not start a turn; the first prompt carries it.
  pi.on('before_agent_start', async () => {
    const content = (await reminder).trim();
    reminder = Promise.resolve('');
    if (content === '') return undefined;
    return { message: { customType: 'cusr', content, display: false } };
  });

  pi.on('message_start', (event: any) => {
    if (pending === null || event.message?.role !== 'user') return;
    if (textOf(event.message) !== pending.note) return;
    confirm = pending.lease;
    pending = null;
    stopRetry();
  });

  pi.on('agent_end', () => {
    if (payload === null || parked !== null || pending !== null || closing) return;
    const args = ['hook', '--harness', 'pi', '--owner-pid', String(process.pid)];
    if (confirm !== null) args.push('--confirm', confirm);
    parked = cusr(args, payload);
    void finished(parked).then(({ code, text }) => {
      parked = null;
      confirm = null;
      if (code !== 2 || closing) return;
      try {
        pending = JSON.parse(text);
      } catch {
        return;
      }
      offers = 0;
      offer();
      retry = setInterval(offer, RETRY_MS);
      retry.unref();
    });
  });

  pi.on('session_shutdown', () => {
    closing = true;
    stopRetry();
    parked?.kill('SIGTERM');
  });
}
`;
}
